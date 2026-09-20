// =============================================================
// liveEngine.js — the ORCHESTRATION for Live/Demo Auto-mode trading,
// extracted from js/futures-ui.js's runLiveCycleInner/placeLiveEntryOrder
// so the browser tab and the server-side worker (server/worker.js) run
// the exact same code, not two hand-synced copies of it. Manual mode
// (click-to-execute) stays in futures-ui.js — it's a UI concept with no
// server equivalent.
//
// This module never touches the DOM, localStorage, or fetch directly.
// Every side effect goes through `adapter` (see the shape documented
// above runLiveCycleInner below); every trading value lives on
// `session`, a plain object using the SAME field names
// js/state.js's state.futures object already uses (liveArmed,
// liveExchange, livePositions, liveTradeHistory, ...) — the browser
// passes state.futures itself as `session`, unchanged; server/worker.js
// builds a plain object with matching field names. That's what keeps
// this one module usable by both without a translation layer that could
// itself drift.
//
// Scoring/detection (what counts as a signal) is NOT here — that's
// js/futures/engine.js and friends, imported directly below, same as
// before. This file is only "given an approved signal / an open
// position, what do we do about it".
// =============================================================
import { runScanCycle, scanSymbolsWithQuant } from './engine.js';
import { RISK_DEFAULTS } from './risk.js';
import { DEFAULT_WEIGHTS } from './scoring.js';
import { computeBtcShock } from './indicators.js';
import { rankTopByVolume, WATCHLIST_TOP_N } from './watchlist.js';
import { QUANT_TYPE } from './quant/config.js';
import { qlog } from './quant/log.js';

export const ARM_PHRASE = 'PLACE REAL ORDERS';
export const LIVE_CYCLE_MS = 8000;
export const LIVE_TRADEABLE_EXCHANGES = ['bybit', 'binance', 'gateio', 'mexc', 'bitget'];
export const LIVE_ONLY_EXCHANGES = ['mexc']; // no public Demo Trading API
export const PARTIAL_TP_EXCHANGES = ['binance', 'bybit'];
export const DURATION_TRACKED_EXCHANGES = ['binance', 'bybit'];
export const LIVE_SYMBOL_COOLDOWN_MS = 30 * 60_000;
export const LIVE_SCAN_TOP_N = WATCHLIST_TOP_N;
export const LIVE_UNIVERSE_TTL_MS = 45_000;
export const LIVE_ORDER_REJECT_COOLDOWN_MS = 15 * 60_000;
export const LIVE_ORDER_RULE_REJECT_COOLDOWN_MS = 60 * 60_000;
export const LIVE_ORDER_ERROR_COOLDOWN_MS = 3 * 60_000;
const ORDER_RULE_REJECT_RE = /precision|lot size|minimum|min(imum)?\s*(size|qty|quantity|notional|order)|notional|tick size|step size|quantity|amount .* below|too small|invalid (qty|quantity|price)/i;
export const LIVE_ADAPTIVE_CONFIDENCE_STEP = 8;
export const LIVE_ADAPTIVE_CONFIDENCE_MAX = 25;
export const LIVE_ADAPTIVE_CONFIDENCE_DECAY_MS = 30 * 60_000;

function fmtUsd(x){
  const n = Number(x) || 0;
  return (n >= 0 ? '+$' : '-$') + Math.abs(n).toFixed(2);
}

/*
adapter shape — every method below is called on `adapter`. proxyCall,
fetchSnapshot, and getCred are required; everything else is optional
(guarded with `adapter.x && adapter.x(...)`) since not every environment
has a DOM to update or a cross-session log to write to.

  proxyCall(path, body)                 -> Promise<json>   POST to this server's own /api/... routes
  fetchSnapshot(exchange, symbol, tf)   -> Promise<snapshot> GET .../api/futures/snapshot, throws on !ok
  getCred(exchange, mode)               -> {apiKey,secretKey,passphrase} | null
  notify(msg, kind)                     -> status message ('error' | 'success' | undefined)
  getQuantCfg(opts)                     -> quant config object (shape sanitizeQuantConfig returns)
  onPositionsChanged(session)           -> persist open positions (optional)
  onRender(session)                     -> trigger a UI re-render (optional)
  onPendingSignal(session)              -> Manual-mode UI hook (optional; browser only)
  onDisarmedIdle(session)               -> called when disarmed AND nothing left open — stop polling (optional)
  updateOpenPositionLabel(text)         -> DOM label update (optional)
  updateBalanceLabel(text)              -> DOM label update (optional)
  appendPersistentTrade(record)         -> cross-session trade log (optional)
  syncSettings()                        -> pull form-input values onto session before building cfg (optional; browser only)
  isAiEnabled()                         -> boolean (optional)
  getAiConfirmation(payload)            -> Promise<verdict> (optional; only called if isAiEnabled() is true)
*/

// Mirrors noteLiveOrderFailure (futures-ui.js).
export function noteLiveOrderFailure(session, symbol, message, kind){
  session.liveOrderFailUntilBySymbol = session.liveOrderFailUntilBySymbol || {};
  const ms = kind === 'error' ? LIVE_ORDER_ERROR_COOLDOWN_MS
    : (ORDER_RULE_REJECT_RE.test(String(message || '')) ? LIVE_ORDER_RULE_REJECT_COOLDOWN_MS : LIVE_ORDER_REJECT_COOLDOWN_MS);
  session.liveOrderFailUntilBySymbol[symbol] = { until: Date.now() + ms, message: String(message || '').slice(0, 140) };
  return Math.round(ms / 60_000);
}

// Mirrors applyOrderFailureSkips (futures-ui.js).
export function applyOrderFailureSkips(session, rows){
  const map = session.liveOrderFailUntilBySymbol;
  if(!map) return rows;
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

// Mirrors decayAdaptiveConfidenceBoost (futures-ui.js).
export function decayAdaptiveConfidenceBoost(session){
  if(session.liveAdaptiveConfidenceBoost <= 0) return;
  const elapsed = Date.now() - (session.liveAdaptiveConfidenceBoostAtMs || 0);
  if(elapsed < LIVE_ADAPTIVE_CONFIDENCE_DECAY_MS) return;
  session.liveAdaptiveConfidenceBoost = Math.max(0, session.liveAdaptiveConfidenceBoost - LIVE_ADAPTIVE_CONFIDENCE_STEP);
  session.liveAdaptiveConfidenceBoostAtMs = Date.now();
}

// Mirrors checkAdaptiveCircuitBreaker (futures-ui.js). Deliberately no
// auto-disarm on a losing streak — only gets pickier (the boost above).
export function checkAdaptiveCircuitBreaker(session, netUsd){
  if(netUsd < 0){
    session.liveConsecutiveLosses = (session.liveConsecutiveLosses || 0) + 1;
    session.liveAdaptiveConfidenceBoost = Math.min(LIVE_ADAPTIVE_CONFIDENCE_MAX, (session.liveAdaptiveConfidenceBoost || 0) + LIVE_ADAPTIVE_CONFIDENCE_STEP);
    session.liveAdaptiveConfidenceBoostAtMs = Date.now();
  } else {
    session.liveConsecutiveLosses = 0;
    session.liveAdaptiveConfidenceBoost = 0;
  }
}

// Mirrors buildLiveDayStateShim (futures-ui.js).
export function buildLiveDayStateShim(session, equity){
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
  const quantTrades = session.liveTradeHistory.filter(t => t.setupType === QUANT_TYPE).map(t => ({ closedAtMs: t.closedAtMs, netUsd: t.netUsd || 0 })).reverse();
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
    dailyProfitTargetPct: session.liveDailyProfitTargetPct != null ? session.liveDailyProfitTargetPct : RISK_DEFAULTS.dailyProfitTargetPct,
    maxDailyLossPct: session.liveMaxDailyLossPct != null ? session.liveMaxDailyLossPct : RISK_DEFAULTS.maxDailyLossPct,
  };
}

function quantClosureFields(tracked, netUsd){
  if(!tracked.quant) return {};
  return { quant: { ...tracked.quant, riskUsd: tracked.riskAmountUsd || 0, realizedR: tracked.riskAmountUsd > 0 ? netUsd / tracked.riskAmountUsd : null } };
}

// Mirrors recordLiveClosure (futures-ui.js). Shared by the auto-scan
// closure-detection poll below AND a manual "Close Position" button, if
// the environment has one — both book the trade identically. Writes two
// records with slightly different shapes, exactly as the original does:
// one into the session-scoped liveTradeHistory (carries `time`, no
// `mode`), one via adapter.appendPersistentTrade (carries `mode`, no
// `time`) for the cross-session log.
export function recordLiveClosure(session, adapter, symbol, tracked, closed){
  const netUsd = closed ? closed.closedPnl : 0;
  const grossUsd = closed && closed.grossPnl != null ? closed.grossPnl : null;
  const feesUsd = closed && closed.feesUsd != null ? closed.feesUsd : null;
  const closedAtMs = Date.now();
  const durationMin = DURATION_TRACKED_EXCHANGES.includes(tracked.exchange)
    ? Math.max(0, Math.round((closedAtMs - tracked.openedAtMs) / 60_000)) : null;
  const entry = closed && closed.avgEntryPrice != null ? closed.avgEntryPrice : tracked.entry;
  const exit = closed && closed.avgExitPrice != null ? closed.avgExitPrice : null;
  const quantFields = quantClosureFields(tracked, netUsd);
  session.liveTradeHistory.unshift({
    closedAtMs, time: new Date().toLocaleTimeString(), exchange: tracked.exchange, symbol, side: tracked.side,
    entry, exit, leverage: tracked.leverage, qty: tracked.qty, grossUsd, feesUsd, netUsd, orderId: tracked.orderId,
    setupType: tracked.setupType, durationMin, ...quantFields,
  });
  adapter.appendPersistentTrade && adapter.appendPersistentTrade({
    closedAtMs, exchange: tracked.exchange, mode: tracked.mode, symbol, side: tracked.side,
    entry, exit, leverage: tracked.leverage, qty: tracked.qty, grossUsd, feesUsd, netUsd, orderId: tracked.orderId,
    setupType: tracked.setupType, durationMin, ...quantFields,
  });
  if(tracked.quant){
    qlog(`${symbol} position closed`);
    qlog(`${symbol} realized PnL = ${netUsd >= 0 ? '+' : ''}$${Number(netUsd).toFixed(2)}${tracked.riskAmountUsd > 0 ? ` (${(netUsd / tracked.riskAmountUsd).toFixed(2)}R)` : ''}`);
    qlog(`${symbol} trade result: ${netUsd > 0 ? 'WIN' : 'LOSS'}`);
    qlog('Strategy statistics updated (Live/Demo)');
  }
  session.liveTrades = (session.liveTrades || 0) + 1;
  if(netUsd > 0) session.liveWins = (session.liveWins || 0) + 1; else session.liveLosses = (session.liveLosses || 0) + 1;
  session.liveNetPnlUsd = (session.liveNetPnlUsd || 0) + netUsd;
  if(grossUsd != null) session.liveGrossPnlUsd = (session.liveGrossPnlUsd || 0) + grossUsd;
  if(feesUsd != null) session.liveFeesUsd = (session.liveFeesUsd || 0) + feesUsd;
  checkAdaptiveCircuitBreaker(session, netUsd);
  session.liveCooldownUntilBySymbol = session.liveCooldownUntilBySymbol || {};
  session.liveCooldownUntilBySymbol[symbol] = closedAtMs + LIVE_SYMBOL_COOLDOWN_MS;
  delete session.livePositions[symbol];
}

const liveUniverseCache = {}; // module-scoped: one instance per running process (browser tab or worker), never shared between them

// Mirrors getLiveTradeableSymbols (futures-ui.js).
export async function getTradeableSymbols(adapter, exchange){
  const cached = liveUniverseCache[exchange];
  const isFresh = cached && (Date.now() - cached.atMs < LIVE_UNIVERSE_TTL_MS);
  let list = isFresh ? cached.symbols : null;
  if(!list){
    try{
      const data = await adapter.proxyCall('/api/futures/universe', { exchange });
      if(!data.ok) throw new Error(data.message || 'Universe fetch failed.');
      list = data.symbols;
      liveUniverseCache[exchange] = { symbols: list, atMs: Date.now() };
    }catch(err){
      if(cached) list = cached.symbols;
      else return null;
    }
  }
  const ranked = rankTopByVolume(list, LIVE_SCAN_TOP_N);
  return { top: ranked.top.map(s => s.symbol), entries: ranked.top, totalAvailable: ranked.totalAvailable };
}

// Mirrors placeLiveEntryOrder (futures-ui.js). Shared by the Auto-mode
// path in runLiveCycleInner below AND Manual mode's Execute button, if
// the environment has one.
export async function placeLiveEntryOrder(session, adapter, approved, side, exchange, mode, cred, cfg, equity){
  const openedAtMs = Date.now();
  const usePartialTp = PARTIAL_TP_EXCHANGES.includes(exchange) && approved.tpFractions && !approved.singleTarget && !approved.singleTp;
  try{
    adapter.notify && adapter.notify(`Placing a real ${mode} order on ${exchange}: ${approved.symbol} ${side} @ ~${approved.entry}…`);
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
    const result = await adapter.proxyCall('/api/futures/order', orderBody);
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
        adapter.onPositionsChanged && adapter.onPositionsChanged(session);
        adapter.notify && adapter.notify(`Order rejected: ${result.message} — adopted the existing ${ep.side} ${approved.symbol} position (size ${ep.size} @ ${ep.avgPrice}) into tracking so it stops showing as "None"; its own TP/SL (if any) weren't set by this app and aren't managed here.`, 'error');
        adapter.updateOpenPositionLabel && adapter.updateOpenPositionLabel(`[${exchange}] ${approved.symbol} ${ep.side} ${ep.size} @ ${ep.avgPrice}`);
      } else {
        const skipMin = noteLiveOrderFailure(session, approved.symbol, result.message, 'rejected');
        adapter.notify && adapter.notify(`Order rejected on ${approved.symbol}: ${result.message} — skipping ${approved.symbol} for ${skipMin} min and moving on to the next pair.`, 'error');
      }
      adapter.onRender && adapter.onRender(session);
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
      ...(approved.quantMeta ? { quant: {
        setup: approved.quantMeta.setup, setupName: approved.quantMeta.setupName, score: approved.quantMeta.score,
        regime: approved.quantMeta.regime.label, entryTf: approved.quantMeta.entryTf, initialRR: approved.quantMeta.rewardRisk,
        riskPctUsed: approved.riskPctUsed, stopDistPct: approved.quantMeta.stopDistPct, factors: approved.quantMeta.factors,
      } } : {}),
      usePartialTp, tp2Fraction: approved.tpFractions ? approved.tpFractions.tp2 : null,
      tp1Fraction: approved.tpFractions ? approved.tpFractions.tp1 : null,
      breakevenStopPrice: approved.breakevenStopPrice, slAlgoId: result.slAlgoId || null,
      breakevenMoved: false, source: 'bot', lastSize: result.filledQty, lastRealizedPnl: 0,
    };
    adapter.onPositionsChanged && adapter.onPositionsChanged(session);
    const tpNote = usePartialTp
      ? `TP1 ${approved.tp1} (30%) / TP2 ${approved.tp2} (30%) / TP3 ${approved.tp3} (40%)`
      : `TP ${result.takeProfitPrice}`;
    if(approved.quantMeta){
      qlog(`${approved.symbol} order submitted: ${approved.direction} qty ${result.filledQty} (${mode}, ${exchange})`);
      qlog(`${approved.symbol} position opened @ ${result.avgPrice} (${approved.quantMeta.setupName}, score ${approved.quantMeta.score}, risk ${approved.riskPctUsed.toFixed(2)}%)`);
      qlog(`${approved.symbol} stop loss set @ ${result.stopLossPrice}`);
      qlog(`${approved.symbol} take profit set @ ${result.takeProfitPrice} (1:${approved.quantMeta.rewardRisk})`);
    }
    adapter.notify && adapter.notify(`Real ${mode} position opened: ${approved.symbol} ${side} ${result.filledQty} @ ${result.avgPrice}, SL ${result.stopLossPrice} / ${tpNote} (order ${result.orderId}).`);
  }catch(err){
    const skipMin = noteLiveOrderFailure(session, approved.symbol, err.message, 'error');
    adapter.notify && adapter.notify(`Order failed on ${approved.symbol}: ${err.message} — skipping ${approved.symbol} for ${skipMin} min.`, 'error');
  }
  adapter.onRender && adapter.onRender(session);
}

// Mirrors runLiveCycleInner (futures-ui.js). Auto mode only — Manual
// mode's pending-signal/click-to-execute step lives in futures-ui.js,
// which still calls placeLiveEntryOrder above directly when the user clicks.
export async function runLiveCycleInner(session, adapter){
  const exchange = session.liveExchange;
  const hadOpenPositions = Object.keys(session.livePositions).length > 0;
  // Monitoring an already-open real position never requires being armed
  // — arming only gates placing a NEW entry. A position stays watched
  // (closure detection, breakeven move, partial-fill logging) whether or
  // not "arm" has been (re)confirmed, so a real open position is never
  // silently unmonitored just because the session isn't armed right now.
  if(!session.liveArmed && !hadOpenPositions) return;
  decayAdaptiveConfidenceBoost(session);

  for(const symbol of Object.keys(session.livePositions)){
    const tracked = session.livePositions[symbol];
    const posCred = adapter.getCred(tracked.exchange, tracked.mode);
    if(!posCred) continue;
    try{
      const data = await adapter.proxyCall('/api/futures/position', { exchange: tracked.exchange, mode: tracked.mode, apiKey: posCred.apiKey, secretKey: posCred.secretKey, passphrase: posCred.passphrase, symbol, openedAtMs: tracked.openedAtMs, balanceBeforeUsd: tracked.balanceBeforeUsd });
      if(!data.ok) continue;
      if(!data.open){
        recordLiveClosure(session, adapter, symbol, tracked, data.closed);
      } else {
        adapter.updateOpenPositionLabel && adapter.updateOpenPositionLabel(`[${tracked.exchange}] ${symbol} ${data.position.side} ${data.position.size} @ ${data.position.avgPrice} (uPnL ${fmtUsd(data.position.unrealisedPnl)})`);
        if(tracked.lastSize != null && data.position.size < tracked.lastSize - 1e-9){
          const filledQty = tracked.lastSize - data.position.size;
          const realizedDelta = (data.position.curRealisedPnl != null && tracked.lastRealizedPnl != null)
            ? data.position.curRealisedPnl - tracked.lastRealizedPnl : null;
          const remainingFraction = tracked.qty > 0 ? data.position.size / tracked.qty : 0;
          const tp1Threshold = 1 - (tracked.tp1Fraction || 0.3) + 0.05;
          const tp2Threshold = 1 - (tracked.tp1Fraction || 0.3) - (tracked.tp2Fraction || 0.3) + 0.05;
          const legLabel = remainingFraction > tp1Threshold ? 'partial' : remainingFraction > tp2Threshold ? 'TP1 partial' : 'TP2 partial';
          const partialRecord = {
            closedAtMs: Date.now(), time: new Date().toLocaleTimeString(), exchange: tracked.exchange, mode: tracked.mode,
            symbol, side: tracked.side, entry: tracked.entry, exit: data.position.markPrice || null,
            leverage: tracked.leverage, qty: filledQty, grossUsd: null, feesUsd: null, netUsd: realizedDelta || 0,
            orderId: tracked.orderId, setupType: tracked.setupType, durationMin: null,
            source: tracked.source || 'unknown', partial: true, tag: legLabel,
          };
          session.liveTradeHistory.unshift(partialRecord);
          adapter.appendPersistentTrade && adapter.appendPersistentTrade(partialRecord);
          if(realizedDelta != null) adapter.notify && adapter.notify(`${symbol}: ${legLabel} filled — ${filledQty} closed, ${fmtUsd(realizedDelta)} realized on that leg.`);
          tracked.lastSize = data.position.size;
          if(data.position.curRealisedPnl != null) tracked.lastRealizedPnl = data.position.curRealisedPnl;
        }
        if(tracked.usePartialTp && !tracked.breakevenMoved && tracked.qty > 0 && tracked.breakevenStopPrice != null){
          const remainingFraction = data.position.size / tracked.qty;
          const tp2CrossedThreshold = 1 - (tracked.tp1Fraction || 0.3) - (tracked.tp2Fraction || 0.3) + 0.05;
          if(remainingFraction <= tp2CrossedThreshold){
            tracked.breakevenMoved = true;
            try{
              const moveResult = await adapter.proxyCall('/api/futures/move-stop', { exchange: tracked.exchange, mode: tracked.mode, apiKey: posCred.apiKey, secretKey: posCred.secretKey, passphrase: posCred.passphrase, symbol, side: tracked.side, newStopPrice: tracked.breakevenStopPrice, slOrderId: tracked.slAlgoId });
              if(moveResult.ok){
                tracked.slAlgoId = moveResult.slOrderId || tracked.slAlgoId;
                tracked.stopLossPrice = moveResult.newStopPrice;
                adapter.notify && adapter.notify(`${symbol}: TP2 filled — stop on the remaining position moved to fee-adjusted breakeven (${moveResult.newStopPrice}).`);
              } else {
                tracked.breakevenMoved = false;
                adapter.notify && adapter.notify(`${symbol}: TP2 filled but the breakeven stop move failed: ${moveResult.message}`, 'error');
              }
            }catch(err){
              tracked.breakevenMoved = false;
              adapter.notify && adapter.notify(`${symbol}: TP2 filled but the breakeven stop move failed: ${err.message}`, 'error');
            }
          }
        }
      }
    }catch(err){ /* network hiccup — leave it tracked, retry next cycle */ }
  }
  adapter.onRender && adapter.onRender(session);

  const mode = session.liveModeByExchange[exchange] || 'live';
  const exchangeUsable = LIVE_TRADEABLE_EXCHANGES.includes(exchange) && !(mode === 'demo' && LIVE_ONLY_EXCHANGES.includes(exchange));

  let equity = null;
  if(exchangeUsable){
    const cred = adapter.getCred(exchange, mode);
    if(cred){
      try{
        const balData = await adapter.proxyCall('/api/futures/balance', { exchange, mode, apiKey: cred.apiKey, secretKey: cred.secretKey, passphrase: cred.passphrase });
        if(balData.ok) equity = balData.balance;
        else adapter.notify && adapter.notify(`Could not read the real ${exchange} futures balance: ${balData.message || 'unknown error'}`, 'error');
      }catch(err){
        adapter.notify && adapter.notify(`Could not read the real ${exchange} futures balance: ${err.message}`, 'error');
      }
    }
  }
  if(equity != null) adapter.updateBalanceLabel && adapter.updateBalanceLabel('$' + equity.toLocaleString('en-US', { minimumFractionDigits:2, maximumFractionDigits:2 }));

  {
    const reconcileCred = adapter.getCred(exchange, mode);
    if(reconcileCred){
      try{
        const allData = await adapter.proxyCall('/api/futures/positions', { exchange, mode, apiKey: reconcileCred.apiKey, secretKey: reconcileCred.secretKey, passphrase: reconcileCred.passphrase });
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
            adapter.notify && adapter.notify(`Found an untracked open ${exchange} position — ${ep.symbol} ${ep.side} ${ep.size} @ ${ep.avgPrice} — not placed or previously tracked by this app; adopted into monitoring so it's no longer only visible on ${exchange} itself.`, 'error');
            adapter.updateOpenPositionLabel && adapter.updateOpenPositionLabel(`[${exchange}] ${ep.symbol} ${ep.side} ${ep.size} @ ${ep.avgPrice} (uPnL ${fmtUsd(ep.unrealisedPnl || 0)})`);
          }
          adapter.onPositionsChanged && adapter.onPositionsChanged(session);
        }
      }catch(err){ /* network hiccup */ }
    }
  }

  // One real position at a time, deliberately — see README-SCALP.md.
  if(Object.keys(session.livePositions).length > 0){ adapter.onRender && adapter.onRender(session); return; }
  adapter.updateOpenPositionLabel && adapter.updateOpenPositionLabel('None');

  if(!session.liveArmed){
    adapter.onDisarmedIdle && adapter.onDisarmedIdle(session);
    return;
  }
  if(!LIVE_TRADEABLE_EXCHANGES.includes(exchange)){ adapter.notify && adapter.notify(`"${exchange}" isn't a supported Live/Demo exchange.`, 'error'); return; }
  if(mode === 'demo' && LIVE_ONLY_EXCHANGES.includes(exchange)){ adapter.notify && adapter.notify(`${exchange} has no Demo Trading available through its API — only Live.`, 'error'); return; }
  const cred = adapter.getCred(exchange, mode);
  if(!cred){ adapter.notify && adapter.notify(`No verified ${exchange} ${mode} key found — connect and verify one first.`, 'error'); return; }
  if(equity == null) return; // no confirmed real balance this cycle — don't scan/place blind

  const universe = await getTradeableSymbols(adapter, exchange);
  if(!universe){ adapter.notify && adapter.notify(`Could not fetch the ${exchange} futures symbol list this cycle — skipping.`, 'error'); return; }

  const quantProbe = { strategies: session.strategies, quant: adapter.getQuantCfg() };
  const scanList = scanSymbolsWithQuant(universe.top, quantProbe);
  const fetchSymbols = ['BTCUSDT', ...scanList.filter(s => s !== 'BTCUSDT')];
  const snapshots = {};
  const timeframe = '5m';
  await Promise.all(fetchSymbols.map(async symbol => {
    try{ snapshots[symbol] = await adapter.fetchSnapshot(exchange, symbol, timeframe); }catch(err){ /* skip this symbol this cycle */ }
  }));
  if(!snapshots.BTCUSDT){ adapter.notify && adapter.notify(`Could not fetch real BTC market data from ${exchange} this cycle (needed for the shock filter) — skipping.`, 'error'); return; }

  adapter.syncSettings && adapter.syncSettings();
  const cfg = {
    exchange, weights: DEFAULT_WEIGHTS, highSelectivity: session.highSelectivity,
    minConfidence: Math.min(95, session.minConfidence + session.liveAdaptiveConfidenceBoost),
    minRiskReward: session.minRiskReward, minNetProfitPct: session.minNetProfitPct,
    riskPctPerTrade: session.riskPctPerTrade, leverage: session.leverage,
    strategies: session.strategies, strategyRR: session.strategyRR,
    quant: adapter.getQuantCfg({ log: true, minConfidence: Math.min(95, session.minConfidence + session.liveAdaptiveConfidenceBoost), riskPct: session.riskPctPerTrade, highSelectivity: session.highSelectivity }),
  };
  const dayStateShim = buildLiveDayStateShim(session, equity);
  const { rows } = runScanCycle(cfg, dayStateShim, {
    symbols: scanList,
    getSnapshot: symbol => snapshots[symbol] || null,
    now: () => Date.now(),
    getBtcShock: () => computeBtcShock(snapshots.BTCUSDT.m5),
  });
  applyOrderFailureSkips(session, rows);
  adapter.onScanRows && adapter.onScanRows(rows);

  const approved = rows.find(r => r.status === 'APPROVED');
  if(!approved){
    const boostNote = session.liveAdaptiveConfidenceBoost > 0 ? ` (min confidence raised +${session.liveAdaptiveConfidenceBoost} after recent losses)` : '';
    adapter.notify && adapter.notify(`Armed on ${exchange} (${mode}), watching top ${universe.top.length} of ${universe.totalAvailable} available pairs by volume (BTC/ETH/SOL/LTC/DOGE/BNB/CLUSDT excluded) — no qualifying signal this cycle${boostNote}.`);
    return;
  }

  if(adapter.isAiEnabled && adapter.isAiEnabled()){
    adapter.notify && adapter.notify(`Engine approved ${approved.symbol} ${approved.direction} — checking with the AI signal provider…`);
    const verdict = await adapter.getAiConfirmation({
      symbol: approved.symbol, exchange, direction: approved.direction, setup: approved.setup,
      regime: approved.regime, confidence: approved.confidence, entry: approved.entry, stop: approved.stop,
      tp1: approved.tp1, riskRewardRatio: approved.riskReward, expectedNetPct: approved.expectedNetPct,
      liquidityScore: approved.liquidityScore, reasons: approved.reasons,
    });
    if(verdict && verdict.ok && verdict.approve === false){
      adapter.notify && adapter.notify(`AI signal check rejected ${approved.symbol} ${approved.direction} despite the engine's approval: "${verdict.reason||'no reason given'}" — no order placed this cycle.`, 'error');
      return;
    }
    if(verdict && !verdict.ok){
      adapter.notify && adapter.notify(`AI signal check couldn't complete (${verdict.message||'unknown error'}) — proceeding on the engine's own approval alone.`);
    }
  }

  const side = approved.direction === 'LONG' ? 'Buy' : 'Sell';

  if(session.liveTradeMode === 'manual'){
    session.livePendingSignal = { ...approved, side, exchange, mode, equityAtDetection: equity, detectedAtMs: Date.now() };
    adapter.onPendingSignal && adapter.onPendingSignal(session);
    adapter.notify && adapter.notify(`Manual mode: ${approved.symbol} ${side} qualifies (confidence ${approved.confidence}, ${approved.setup}) — waiting for you to click Execute Trade.`);
    return;
  }

  await placeLiveEntryOrder(session, adapter, approved, side, exchange, mode, cred, cfg, equity);
}
