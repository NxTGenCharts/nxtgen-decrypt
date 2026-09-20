// =============================================================
// worker.js — the always-on Live/Demo trading loop, running IN this
// server process instead of a browser tab.
//
// What this is: a faithful port of js/futures-ui.js's runLiveCycleInner
// + placeLiveEntryOrder (Auto mode only — Manual mode's
// click-to-execute step doesn't apply to an unattended worker). It
// imports the exact same detection/scoring modules the browser does
// (js/futures/engine.js and friends) — same signals, same math — and
// calls this server's OWN /api/futures/* routes over loopback HTTP for
// every exchange call, so order placement, SL/TP attachment, and
// position reads run through the identical, already-working code in
// server.js. Nothing exchange-specific is reimplemented here.
//
// What's genuinely new code here (ported by hand from futures-ui.js,
// not reused automatically) is the ORCHESTRATION: closure detection,
// the daily-loss-cap/kill-switch shim, per-symbol re-entry cooldown,
// order-failure cooldown classification, the TP2->breakeven stop move,
// and the adaptive confidence boost after a losing streak. Every one of
// those is copied from its browser counterpart with the same constants
// and the same thresholds — see the comment above each block for which
// function in futures-ui.js it mirrors.
//
// Credentials live in memory only, exactly like the rest of this proxy
// (see server/README.md) — never written to disk. That means a process
// restart clears the armed session; nothing re-arms itself. You arm it
// again from the app (or a plain POST) with the arm phrase.
// =============================================================
import { runScanCycle, managePositions, EXCLUDED_FUTURES_SYMBOLS, scanSymbolsWithQuant } from '../js/futures/engine.js';
import { RISK_DEFAULTS } from '../js/futures/risk.js';
import { DEFAULT_WEIGHTS } from '../js/futures/scoring.js';
import { computeBtcShock } from '../js/futures/indicators.js';
import { rankTopByVolume, WATCHLIST_TOP_N } from '../js/futures/watchlist.js';
import { sanitizeQuantConfig, QUANT_DEFAULTS } from '../js/futures/quant/config.js';

export const ARM_PHRASE = 'PLACE REAL ORDERS'; // same phrase the app's own Arm control uses — see js/futures-ui.js

const LIVE_TRADEABLE_EXCHANGES = ['bybit', 'binance', 'gateio', 'mexc', 'bitget'];
const LIVE_ONLY_EXCHANGES = ['mexc']; // no public Demo Trading API
const PARTIAL_TP_EXCHANGES = ['binance', 'bybit'];
const DURATION_TRACKED_EXCHANGES = ['binance', 'bybit'];
const LIVE_CYCLE_MS = 8000; // matches futures-ui.js's LIVE_CYCLE_MS
const LIVE_SYMBOL_COOLDOWN_MS = 30 * 60_000;
const LIVE_UNIVERSE_TTL_MS = 45_000;
const LIVE_SCAN_TOP_N = WATCHLIST_TOP_N;
const LIVE_ORDER_REJECT_COOLDOWN_MS = 15 * 60_000;
const LIVE_ORDER_RULE_REJECT_COOLDOWN_MS = 60 * 60_000;
const LIVE_ORDER_ERROR_COOLDOWN_MS = 3 * 60_000;
const ORDER_RULE_REJECT_RE = /precision|lot size|minimum|min(imum)?\s*(size|qty|quantity|notional|order)|notional|tick size|step size|quantity|amount .* below|too small|invalid (qty|quantity|price)/i;
const LIVE_ADAPTIVE_CONFIDENCE_STEP = 8;
const LIVE_ADAPTIVE_CONFIDENCE_MAX = 25;
const LIVE_ADAPTIVE_CONFIDENCE_DECAY_MS = 30 * 60_000;
const MAX_LOG_LINES = 300;
const MAX_TRADE_HISTORY = 200;

let session = null;    // null when disarmed; see armSession() for shape
let timer = null;
let cycleInFlight = false;
let selfBaseUrl = 'http://127.0.0.1:8787';
const liveUniverseCache = {}; // { [exchange]: { symbols, atMs } }

function log(msg, kind){
  if(!session) return;
  session.logs.push({ ts: Date.now(), msg: String(msg), kind: kind || 'info' });
  if(session.logs.length > MAX_LOG_LINES) session.logs.splice(0, session.logs.length - MAX_LOG_LINES);
  session.lastMessage = String(msg);
  session.lastMessageKind = kind || 'info';
  console.log(`[worker] ${msg}`);
}

async function callSelf(path, body){
  const res = await fetch(selfBaseUrl + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}),
  });
  const data = await res.json().catch(() => null);
  if(!data) throw new Error('Internal call to ' + path + ' returned an unreadable response.');
  return data;
}

async function fetchSnapshot(exchange, symbol, timeframe){
  const tf = timeframe || '5m';
  const res = await fetch(`${selfBaseUrl}/api/futures/snapshot?exchange=${exchange}&symbol=${symbol}&interval=${tf}`);
  const data = await res.json().catch(() => null);
  if(!data || !data.ok) throw new Error((data && data.message) || 'Snapshot fetch failed.');
  return data.snapshot;
}

// Mirrors getLiveTradeableSymbols in futures-ui.js.
async function getTradeableSymbols(exchange){
  const cached = liveUniverseCache[exchange];
  const isFresh = cached && (Date.now() - cached.atMs < LIVE_UNIVERSE_TTL_MS);
  let list = isFresh ? cached.symbols : null;
  if(!list){
    try{
      const data = await callSelf('/api/futures/universe', { exchange });
      if(!data.ok) throw new Error(data.message || 'Universe fetch failed.');
      list = data.symbols;
      liveUniverseCache[exchange] = { symbols: list, atMs: Date.now() };
    }catch(err){
      if(cached) list = cached.symbols;
      else return null;
    }
  }
  const ranked = rankTopByVolume(list, LIVE_SCAN_TOP_N);
  return { top: ranked.top.map(s => s.symbol), totalAvailable: ranked.totalAvailable };
}

// Mirrors applyOrderFailureSkips in futures-ui.js.
function applyOrderFailureSkips(rows){
  const map = session.liveOrderFailUntilBySymbol;
  const now = Date.now();
  for(const r of rows){
    const e = map[r.symbol];
    if(!e) continue;
    if(now >= e.until){ delete map[r.symbol]; continue; }
    if(r.status !== 'APPROVED') continue;
    r.status = 'REJECTED';
    r.rejectReasons = [...(r.rejectReasons || []), `Skipped: the exchange rejected the last order for ${r.symbol} ("${e.message}") — trying other pairs for ${Math.max(1, Math.ceil((e.until - now) / 60_000))} more min`];
  }
  return rows;
}

// Mirrors noteLiveOrderFailure in futures-ui.js.
function noteOrderFailure(symbol, message, kind){
  session.liveOrderFailUntilBySymbol = session.liveOrderFailUntilBySymbol || {};
  const ms = kind === 'error' ? LIVE_ORDER_ERROR_COOLDOWN_MS
    : (ORDER_RULE_REJECT_RE.test(String(message || '')) ? LIVE_ORDER_RULE_REJECT_COOLDOWN_MS : LIVE_ORDER_REJECT_COOLDOWN_MS);
  session.liveOrderFailUntilBySymbol[symbol] = { until: Date.now() + ms, message: String(message || '').slice(0, 140) };
  return Math.round(ms / 60_000);
}

// Mirrors decayAdaptiveConfidenceBoost / checkAdaptiveCircuitBreaker.
function decayAdaptiveConfidenceBoost(){
  if(session.liveAdaptiveConfidenceBoost <= 0) return;
  const elapsed = Date.now() - (session.liveAdaptiveConfidenceBoostAtMs || 0);
  if(elapsed < LIVE_ADAPTIVE_CONFIDENCE_DECAY_MS) return;
  session.liveAdaptiveConfidenceBoost = Math.max(0, session.liveAdaptiveConfidenceBoost - LIVE_ADAPTIVE_CONFIDENCE_STEP);
  session.liveAdaptiveConfidenceBoostAtMs = Date.now();
}
function checkAdaptiveCircuitBreaker(netUsd){
  if(netUsd < 0){
    session.liveConsecutiveLosses = (session.liveConsecutiveLosses || 0) + 1;
    session.liveAdaptiveConfidenceBoost = Math.min(LIVE_ADAPTIVE_CONFIDENCE_MAX, (session.liveAdaptiveConfidenceBoost || 0) + LIVE_ADAPTIVE_CONFIDENCE_STEP);
    session.liveAdaptiveConfidenceBoostAtMs = Date.now();
  } else {
    session.liveConsecutiveLosses = 0;
    session.liveAdaptiveConfidenceBoost = 0;
  }
  // No auto-disarm on a losing streak, same as the browser bot: it only
  // gets pickier (the confidence boost above). Stopping is your call,
  // or the daily-loss-cap gate below via evaluateNoTradeFilters.
}

// Mirrors buildLiveDayStateShim in futures-ui.js.
function buildDayStateShim(equity){
  if(session.liveStartingEquity == null) session.liveStartingEquity = equity;
  const startingEquity = session.liveStartingEquity;
  const dailyPnlPct = startingEquity > 0 ? ((equity - startingEquity) / startingEquity) * 100 : 0;
  const openSymbols = Object.keys(session.livePositions);
  const positions = openSymbols.map(symbol => {
    const p = session.livePositions[symbol];
    return {
      symbol, riskAmountUsd: p.riskAmountUsd || 0,
      direction: p.side === 'Buy' ? 'LONG' : 'SHORT', setup: p.setupType,
      notionalUsd: (p.qty || 0) * (p.entry || 0), leverage: p.leverage || 1,
    };
  });
  const quantTrades = session.liveTradeHistory.filter(t => t.setupType === 'NxTGen Quant Futures').map(t => ({ closedAtMs: t.closedAtMs, netUsd: t.netUsd || 0 })).reverse();
  let consecutiveLosses = 0, lastLossAt = null;
  for(const t of session.liveTradeHistory){
    if(t.netUsd < 0){ consecutiveLosses++; if(!lastLossAt) lastLossAt = t.closedAtMs; }
    else break;
  }
  const openRiskPct = positions.reduce((a, p) => a + p.riskAmountUsd, 0) / Math.max(1, equity) * 100;
  return {
    equity, startingEquity, peakEquity: Math.max(equity, startingEquity),
    trades: session.liveTrades, wins: 0, losses: 0, consecutiveLosses, lastLossAt,
    dailyPnlPct, maxDrawdownPct: 0,
    realizedGrossUsd: 0, realizedNetUsd: session.liveNetPnlUsd, feesUsd: 0, fundingUsd: 0, slippageUsd: 0,
    openPositions: openSymbols.length, openRiskPct, positions, quantTrades,
    cooldownUntilBySymbol: session.liveCooldownUntilBySymbol || {},
    dailyProfitTargetPct: session.dailyProfitTargetPct != null ? session.dailyProfitTargetPct : RISK_DEFAULTS.dailyProfitTargetPct,
    maxDailyLossPct: session.maxDailyLossPct != null ? session.maxDailyLossPct : RISK_DEFAULTS.maxDailyLossPct,
  };
}

// Mirrors recordLiveClosure in futures-ui.js.
function recordClosure(symbol, tracked, closed){
  const netUsd = closed ? closed.closedPnl : 0;
  const grossUsd = closed && closed.grossPnl != null ? closed.grossPnl : null;
  const feesUsd = closed && closed.feesUsd != null ? closed.feesUsd : null;
  const closedAtMs = Date.now();
  const durationMin = DURATION_TRACKED_EXCHANGES.includes(tracked.exchange)
    ? Math.max(0, Math.round((closedAtMs - tracked.openedAtMs) / 60_000)) : null;
  const record = {
    closedAtMs, exchange: tracked.exchange, mode: tracked.mode, symbol, side: tracked.side,
    entry: closed && closed.avgEntryPrice != null ? closed.avgEntryPrice : tracked.entry,
    exit: closed && closed.avgExitPrice != null ? closed.avgExitPrice : null,
    leverage: tracked.leverage, qty: tracked.qty, grossUsd, feesUsd, netUsd, orderId: tracked.orderId,
    setupType: tracked.setupType, durationMin, source: tracked.source || 'unknown',
  };
  session.liveTradeHistory.unshift(record);
  if(session.liveTradeHistory.length > MAX_TRADE_HISTORY) session.liveTradeHistory.length = MAX_TRADE_HISTORY;
  session.liveTrades = (session.liveTrades || 0) + 1;
  if(netUsd > 0) session.liveWins = (session.liveWins || 0) + 1; else session.liveLosses = (session.liveLosses || 0) + 1;
  session.liveNetPnlUsd = (session.liveNetPnlUsd || 0) + netUsd;
  if(grossUsd != null) session.liveGrossPnlUsd = (session.liveGrossPnlUsd || 0) + grossUsd;
  if(feesUsd != null) session.liveFeesUsd = (session.liveFeesUsd || 0) + feesUsd;
  checkAdaptiveCircuitBreaker(netUsd);
  session.liveCooldownUntilBySymbol = session.liveCooldownUntilBySymbol || {};
  session.liveCooldownUntilBySymbol[symbol] = closedAtMs + LIVE_SYMBOL_COOLDOWN_MS;
  delete session.livePositions[symbol];
  log(`${symbol} closed — net ${netUsd >= 0 ? '+' : ''}$${Number(netUsd).toFixed(2)}`, netUsd >= 0 ? 'success' : 'error');
}

// Mirrors placeLiveEntryOrder in futures-ui.js.
async function placeEntryOrder(approved, side, exchange, mode, cred, cfg, equity){
  const openedAtMs = Date.now();
  const usePartialTp = PARTIAL_TP_EXCHANGES.includes(exchange) && approved.tpFractions && !approved.singleTarget && !approved.singleTp;
  try{
    log(`Placing a real ${mode} order on ${exchange}: ${approved.symbol} ${side} @ ~${approved.entry}…`);
    const orderBody = {
      exchange, mode, apiKey: cred.apiKey, secretKey: cred.secretKey, passphrase: cred.passphrase,
      symbol: approved.symbol, side, qty: approved.sizing.qty, leverage: cfg.leverage, entryPrice: approved.entry,
      stopLossPrice: approved.stop,
    };
    if(usePartialTp){
      orderBody.tpLevels = [
        { price: approved.tp1, fraction: approved.tpFractions.tp1 },
        { price: approved.tp2, fraction: approved.tpFractions.tp2 },
        { price: approved.tp3, fraction: approved.tpFractions.tp3 },
      ];
    } else {
      orderBody.takeProfitPrice = approved.tp1;
    }
    const result = await callSelf('/api/futures/order', orderBody);
    if(!result.ok){
      if(result.rejected && result.existingPosition){
        const ep = result.existingPosition;
        session.livePositions[approved.symbol] = {
          exchange, mode, orderId: null, side: ep.side, qty: ep.size, entry: ep.avgPrice,
          leverage: ep.leverage, stopLossPrice: null, takeProfitPrice: null,
          tp1Price: null, tp2Price: null, tp3Price: null,
          riskAmountUsd: 0, openedAtMs: Date.now(), balanceBeforeUsd: equity,
          setupType: 'adopted-existing', usePartialTp: false, tp2Fraction: null, tp1Fraction: null,
          breakevenStopPrice: null, slAlgoId: null, breakevenMoved: true,
          source: 'unknown', lastSize: ep.size, lastRealizedPnl: ep.curRealisedPnl || 0,
        };
        log(`Order rejected: ${result.message} — adopted the existing ${ep.side} ${approved.symbol} position (size ${ep.size} @ ${ep.avgPrice}) into tracking.`, 'error');
      } else {
        const skipMin = noteOrderFailure(approved.symbol, result.message, 'rejected');
        log(`Order rejected on ${approved.symbol}: ${result.message} — skipping ${approved.symbol} for ${skipMin} min.`, 'error');
      }
      return;
    }
    session.livePositions[approved.symbol] = {
      exchange, mode, orderId: result.orderId, side, qty: result.filledQty, entry: result.avgPrice,
      leverage: result.leverage, stopLossPrice: result.stopLossPrice, takeProfitPrice: result.takeProfitPrice,
      tp1Price: usePartialTp ? approved.tp1 : result.takeProfitPrice,
      tp2Price: usePartialTp ? approved.tp2 : null,
      tp3Price: usePartialTp ? approved.tp3 : null,
      riskAmountUsd: approved.sizing.riskAmountUsd, openedAtMs, balanceBeforeUsd: equity,
      setupType: approved.setup,
      usePartialTp, tp2Fraction: approved.tpFractions ? approved.tpFractions.tp2 : null,
      tp1Fraction: approved.tpFractions ? approved.tpFractions.tp1 : null,
      breakevenStopPrice: approved.breakevenStopPrice, slAlgoId: result.slAlgoId || null,
      breakevenMoved: false, source: 'bot', lastSize: result.filledQty, lastRealizedPnl: 0,
    };
    const tpNote = usePartialTp
      ? `TP1 ${approved.tp1} (30%) / TP2 ${approved.tp2} (30%) / TP3 ${approved.tp3} (40%)`
      : `TP ${result.takeProfitPrice}`;
    log(`Real ${mode} position opened: ${approved.symbol} ${side} ${result.filledQty} @ ${result.avgPrice}, SL ${result.stopLossPrice} / ${tpNote} (order ${result.orderId}).`, 'success');
  }catch(err){
    const skipMin = noteOrderFailure(approved.symbol, err.message, 'error');
    log(`Order failed on ${approved.symbol}: ${err.message} — skipping ${approved.symbol} for ${skipMin} min.`, 'error');
  }
}

// Mirrors runLiveCycleInner in futures-ui.js. Auto mode only.
async function runCycleInner(){
  const { exchange, mode, cred } = session;
  decayAdaptiveConfidenceBoost();

  // 1) Closure detection + partial-fill/breakeven handling for whatever's already tracked open.
  for(const symbol of Object.keys(session.livePositions)){
    const tracked = session.livePositions[symbol];
    try{
      const data = await callSelf('/api/futures/position', { exchange: tracked.exchange, mode: tracked.mode, apiKey: cred.apiKey, secretKey: cred.secretKey, passphrase: cred.passphrase, symbol, openedAtMs: tracked.openedAtMs, balanceBeforeUsd: tracked.balanceBeforeUsd });
      if(!data.ok) continue;
      if(!data.open){
        recordClosure(symbol, tracked, data.closed);
        continue;
      }
      if(tracked.lastSize != null && data.position.size < tracked.lastSize - 1e-9){
        const filledQty = tracked.lastSize - data.position.size;
        const realizedDelta = (data.position.curRealisedPnl != null && tracked.lastRealizedPnl != null)
          ? data.position.curRealisedPnl - tracked.lastRealizedPnl : null;
        if(realizedDelta != null) log(`${symbol}: partial TP filled — ${filledQty} closed, ${realizedDelta >= 0 ? '+' : ''}$${realizedDelta.toFixed(2)} realized on that leg.`);
        tracked.lastSize = data.position.size;
        if(data.position.curRealisedPnl != null) tracked.lastRealizedPnl = data.position.curRealisedPnl;
      }
      if(tracked.usePartialTp && !tracked.breakevenMoved && tracked.qty > 0 && tracked.breakevenStopPrice != null){
        const remainingFraction = data.position.size / tracked.qty;
        const tp2CrossedThreshold = 1 - (tracked.tp1Fraction || 0.3) - (tracked.tp2Fraction || 0.3) + 0.05;
        if(remainingFraction <= tp2CrossedThreshold){
          tracked.breakevenMoved = true;
          try{
            const moveResult = await callSelf('/api/futures/move-stop', { exchange: tracked.exchange, mode: tracked.mode, apiKey: cred.apiKey, secretKey: cred.secretKey, passphrase: cred.passphrase, symbol, side: tracked.side, newStopPrice: tracked.breakevenStopPrice, slOrderId: tracked.slAlgoId });
            if(moveResult.ok){
              tracked.slAlgoId = moveResult.slOrderId || tracked.slAlgoId;
              tracked.stopLossPrice = moveResult.newStopPrice;
              log(`${symbol}: TP2 filled — stop moved to fee-adjusted breakeven (${moveResult.newStopPrice}).`);
            } else {
              tracked.breakevenMoved = false;
              log(`${symbol}: TP2 filled but the breakeven stop move failed: ${moveResult.message}`, 'error');
            }
          }catch(err){
            tracked.breakevenMoved = false;
            log(`${symbol}: TP2 filled but the breakeven stop move failed: ${err.message}`, 'error');
          }
        }
      }
    }catch(err){ /* network hiccup — leave it tracked, retry next cycle */ }
  }

  // 2) Real balance, every cycle.
  let equity = null;
  try{
    const balData = await callSelf('/api/futures/balance', { exchange, mode, apiKey: cred.apiKey, secretKey: cred.secretKey, passphrase: cred.passphrase });
    if(balData.ok) equity = balData.balance;
    else log(`Could not read the real ${exchange} futures balance: ${balData.message || 'unknown error'}`, 'error');
  }catch(err){ log(`Could not read the real ${exchange} futures balance: ${err.message}`, 'error'); }

  // 3) Reconciliation — adopt any untracked open position on the account (Bybit-only support server-side, same as browser).
  try{
    const allData = await callSelf('/api/futures/positions', { exchange, mode, apiKey: cred.apiKey, secretKey: cred.secretKey, passphrase: cred.passphrase });
    if(allData.ok && allData.supported && Array.isArray(allData.positions)){
      for(const ep of allData.positions){
        if(session.livePositions[ep.symbol]) continue;
        session.livePositions[ep.symbol] = {
          exchange, mode, orderId: null, side: ep.side, qty: ep.size, entry: ep.avgPrice,
          leverage: ep.leverage, stopLossPrice: null, takeProfitPrice: null,
          tp1Price: null, tp2Price: null, tp3Price: null,
          riskAmountUsd: 0, openedAtMs: Date.now(), balanceBeforeUsd: equity,
          setupType: 'adopted-existing', usePartialTp: false, tp2Fraction: null, tp1Fraction: null,
          breakevenStopPrice: null, slAlgoId: null, breakevenMoved: true,
          source: 'unknown', lastSize: ep.size, lastRealizedPnl: ep.curRealisedPnl || 0,
        };
        log(`Found an untracked open ${exchange} position — ${ep.symbol} ${ep.side} ${ep.size} @ ${ep.avgPrice} — adopted into monitoring.`, 'error');
      }
    }
  }catch(err){ /* network hiccup */ }

  // 4) One real position at a time (see README-SCALP.md).
  if(Object.keys(session.livePositions).length > 0) return;
  if(equity == null) return; // no confirmed balance this cycle — don't scan/place blind

  if(!LIVE_TRADEABLE_EXCHANGES.includes(exchange)){ log(`"${exchange}" isn't a supported Live/Demo exchange.`, 'error'); return; }
  if(mode === 'demo' && LIVE_ONLY_EXCHANGES.includes(exchange)){ log(`${exchange} has no Demo Trading available — Live only.`, 'error'); return; }

  const universe = await getTradeableSymbols(exchange);
  if(!universe){ log(`Could not fetch the ${exchange} futures symbol list this cycle — skipping.`, 'error'); return; }

  const quantProbe = { strategies: session.cfgBase.strategies, quant: session.quantCfg };
  const scanList = scanSymbolsWithQuant(universe.top, quantProbe);
  const fetchSymbols = ['BTCUSDT', ...scanList.filter(s => s !== 'BTCUSDT')];
  const snapshots = {};
  await Promise.all(fetchSymbols.map(async symbol => {
    try{ snapshots[symbol] = await fetchSnapshot(exchange, symbol, '5m'); }catch(err){ /* skip this symbol this cycle */ }
  }));
  if(!snapshots.BTCUSDT){ log(`Could not fetch real BTC market data from ${exchange} this cycle — skipping.`, 'error'); return; }

  const cfg = {
    exchange, weights: DEFAULT_WEIGHTS, highSelectivity: session.cfgBase.highSelectivity,
    minConfidence: Math.min(95, session.cfgBase.minConfidence + (session.liveAdaptiveConfidenceBoost || 0)),
    minRiskReward: session.cfgBase.minRiskReward, minNetProfitPct: session.cfgBase.minNetProfitPct,
    riskPctPerTrade: session.cfgBase.riskPctPerTrade, leverage: session.cfgBase.leverage,
    strategies: session.cfgBase.strategies, strategyRR: session.cfgBase.strategyRR,
    quant: session.quantCfg,
  };
  const dayStateShim = buildDayStateShim(equity);
  const { rows } = runScanCycle(cfg, dayStateShim, {
    symbols: scanList,
    getSnapshot: symbol => snapshots[symbol] || null,
    now: () => Date.now(),
    getBtcShock: () => computeBtcShock(snapshots.BTCUSDT.m5),
  });
  applyOrderFailureSkips(rows);

  const approved = rows.find(r => r.status === 'APPROVED');
  if(!approved){
    const boostNote = session.liveAdaptiveConfidenceBoost > 0 ? ` (min confidence raised +${session.liveAdaptiveConfidenceBoost} after recent losses)` : '';
    log(`Armed on ${exchange} (${mode}), watching top ${universe.top.length} of ${universe.totalAvailable} pairs — no qualifying signal this cycle${boostNote}.`);
    return;
  }
  const side = approved.direction === 'LONG' ? 'Buy' : 'Sell';
  await placeEntryOrder(approved, side, exchange, mode, cred, cfg, equity);
}

async function runCycle(){
  if(cycleInFlight || !session || !session.armed) return;
  cycleInFlight = true;
  try{
    session.lastCycleAtMs = Date.now();
    await runCycleInner();
  }catch(err){
    log(`Cycle error: ${err.message}`, 'error');
  } finally {
    cycleInFlight = false;
  }
}

export function armSession(params){
  const {
    armPhrase, exchange, mode, apiKey, secretKey, passphrase,
    leverage, riskPctPerTrade, minConfidence, minRiskReward, minNetProfitPct,
    highSelectivity, strategies, strategyRR, dailyProfitTargetPct, maxDailyLossPct,
    quantEnabled,
  } = params || {};

  if(armPhrase !== ARM_PHRASE){
    return { ok: false, message: `Arm phrase must be exactly "${ARM_PHRASE}".` };
  }
  if(!LIVE_TRADEABLE_EXCHANGES.includes(exchange)){
    return { ok: false, message: `Unknown/unsupported exchange "${exchange}".` };
  }
  if(!apiKey || !secretKey){
    return { ok: false, message: 'apiKey and secretKey are required (passphrase too, for Bitget).' };
  }
  if(session && session.armed){
    return { ok: false, message: 'Already armed — disarm first if you want to change settings.' };
  }

  session = {
    armed: true, armedAtMs: Date.now(), lastCycleAtMs: null, lastMessage: '', lastMessageKind: 'info',
    exchange, mode: mode === 'demo' ? 'demo' : 'live',
    cred: { apiKey, secretKey, passphrase: passphrase || '' },
    cfgBase: {
      leverage: Number(leverage) || RISK_DEFAULTS.defaultLeverage || 5,
      riskPctPerTrade: Number(riskPctPerTrade) || 0.5,
      minConfidence: Number(minConfidence) || 70,
      minRiskReward: Number(minRiskReward) || 2,
      minNetProfitPct: minNetProfitPct != null ? Number(minNetProfitPct) : undefined,
      highSelectivity: !!highSelectivity,
      strategies: strategies || undefined,
      strategyRR: strategyRR || undefined,
    },
    quantCfg: sanitizeQuantConfig({ ...QUANT_DEFAULTS, riskPct: Number(riskPctPerTrade) || QUANT_DEFAULTS.riskPct }),
    dailyProfitTargetPct: dailyProfitTargetPct != null ? Number(dailyProfitTargetPct) : undefined,
    maxDailyLossPct: maxDailyLossPct != null ? Number(maxDailyLossPct) : undefined,
    quantEnabled: !!quantEnabled,
    livePositions: {}, liveTradeHistory: [],
    liveCooldownUntilBySymbol: {}, liveOrderFailUntilBySymbol: {},
    liveStartingEquity: null, liveTrades: 0, liveWins: 0, liveLosses: 0,
    liveNetPnlUsd: 0, liveGrossPnlUsd: 0, liveFeesUsd: 0,
    liveConsecutiveLosses: 0, liveAdaptiveConfidenceBoost: 0, liveAdaptiveConfidenceBoostAtMs: 0,
    logs: [],
  };
  log(`Armed on ${exchange} (${session.mode}). Watching for entries every ${LIVE_CYCLE_MS / 1000}s. TP/SL on any position opened are native exchange orders and stay protected even if this process stops.`, 'success');
  clearInterval(timer);
  timer = setInterval(runCycle, LIVE_CYCLE_MS);
  runCycle(); // don't wait a full cycle for the first tick
  return { ok: true, status: getStatus() };
}

export function disarmSession(){
  if(!session){ return { ok: true, status: getStatus() }; }
  const hadOpenPositions = Object.keys(session.livePositions).length > 0;
  session.armed = false;
  clearInterval(timer);
  timer = null;
  log(hadOpenPositions
    ? 'Disarmed — no NEW entries will be placed. Any open position keeps its native exchange-side SL/TP and stays protected, but this worker will no longer poll it for closure bookkeeping until re-armed.'
    : 'Disarmed.', 'success');
  return { ok: true, status: getStatus() };
}

export function getStatus(){
  if(!session){
    return { armed: false };
  }
  return {
    armed: session.armed, exchange: session.exchange, mode: session.mode,
    armedAtMs: session.armedAtMs, lastCycleAtMs: session.lastCycleAtMs,
    lastMessage: session.lastMessage, lastMessageKind: session.lastMessageKind,
    openPositions: session.livePositions,
    trades: session.liveTrades, wins: session.liveWins, losses: session.liveLosses,
    netPnlUsd: session.liveNetPnlUsd, grossPnlUsd: session.liveGrossPnlUsd, feesUsd: session.liveFeesUsd,
    recentTrades: session.liveTradeHistory.slice(0, 20),
    consecutiveLosses: session.liveConsecutiveLosses, adaptiveConfidenceBoost: session.liveAdaptiveConfidenceBoost,
  };
}

export function getLogs(sinceMs){
  if(!session) return [];
  const since = Number(sinceMs) || 0;
  return session.logs.filter(l => l.ts > since);
}

// Mounts /api/worker/* routes on the given Express app. Call once, after
// app.use(express.json()) is set up (server.js already does that).
// `baseUrl` is where the worker calls back into THIS SAME server's own
// /api/futures/* and /api/order routes — normally http://127.0.0.1:<port>.
export function attachWorker(app, baseUrl){
  selfBaseUrl = baseUrl;

  app.post('/api/worker/arm', (req, res) => {
    const result = armSession(req.body || {});
    res.json(result);
  });

  app.post('/api/worker/disarm', (req, res) => {
    res.json(disarmSession());
  });

  app.get('/api/worker/status', (req, res) => {
    res.json({ ok: true, status: getStatus() });
  });

  app.get('/api/worker/logs', (req, res) => {
    res.json({ ok: true, logs: getLogs(req.query.since) });
  });
}
