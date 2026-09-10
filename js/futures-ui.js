// =============================================================
// futures-ui.js — presentation layer for the AI Futures Engine tab.
// No strategy math happens here — everything is computed by
// js/futures/engine.js; this module only renders it and wires the
// settings controls / start-stop buttons.
//
// Two independent trading loops live in this file:
// - runCycle() — Paper mode, unchanged from before, always available,
//   trades against the synthetic feed in js/futures/mockMarket.js.
// - runLiveCycle() — Live/Demo mode, all five exchanges (MEXC is Live
//   only — see LIVE_ONLY_EXCHANGES). Runs the
//   exact same engine.runScanCycle() detection/scoring logic, but fed
//   real market data (via server.js's /api/futures/snapshot) instead of
//   the synthetic feed, and on an APPROVED signal places a real order
//   (via /api/futures/order) with an exchange-side stop-loss/take-profit
//   attached — the exchange enforces the exit, this file never "watches"
//   a live position's price and decides to close it itself. Reuses
//   whichever exchange's credential is already connected in Autotrade &
//   Balances — nothing new to connect per exchange.
// =============================================================
import { els, state } from './state.js';
import { fmtPct } from './utils.js';
import { runScanCycle, openPosition, managePositions, recomputeOpenRisk, EXCLUDED_FUTURES_SYMBOLS } from './futures/engine.js';
import { mockMarket } from './futures/mockMarket.js';
import { RISK_DEFAULTS } from './futures/risk.js';
import { DEFAULT_WEIGHTS } from './futures/scoring.js';
import { computeBtcShock } from './futures/indicators.js';
import { STRATEGY_REGISTRY } from './futures/setups.js';
import { getAiConfirmation } from './ai-signal.js';

const CYCLE_MS = 4000; // one synthetic "cycle" every 4s; each cycle advances the mock clock by a few minutes
const LIVE_CYCLE_MS = 8000; // real API calls — a slower, deliberately conservative cadence than Paper's
// 30-minute no-re-entry cooldown per symbol after ANY close (TP, SL, or
// a manual close done directly on the exchange) — see runLiveCycle's
// close-detection above and evaluateNoTradeFilters (noTradeEngine.js),
// which is what actually enforces it. Matches costs.js/noTradeEngine.js's
// SYMBOL_COOLDOWN_MINUTES used by Paper mode, kept as its own literal
// here rather than importing it, since this file already treats Live's
// numbers as independently-set (see LIVE_CYCLE_MS itself, just above).
const LIVE_SYMBOL_COOLDOWN_MS = 30 * 60_000;

// Live/Demo no longer scans a small hardcoded watchlist — it pulls each
// exchange's REAL, FULL current list of USDT-M perpetual symbols (see
// /api/futures/universe in server.js) and scans everything on it except
// EXCLUDED_FUTURES_SYMBOLS (engine.js — currently BTC/ETH/SOL/LTC/DOGE/BNB).
// The one thing that can't scale to "every symbol, every 8-second cycle"
// is the DETAILED per-symbol scan that actually finds a signal: an
// exchange can list 300+ USDT perpetuals, and each one needs 4-6 separate
// API calls (klines, book, funding...) to build a real snapshot — doing
// that for every listed symbol every cycle would be 1000+ calls/cycle,
// which blows through every one of these exchanges' rate limits at once
// (see the Binance ban/weight-budget comments in server.js for what that
// actually looks like in practice). So the full real universe (minus your
// exclusions) gets ranked by 24h volume every refresh, and the top
// LIVE_SCAN_TOP_N most liquid/active names are what actually get the
// detailed scan each cycle — which one that N covers shifts on its own as
// real trading activity shifts, rather than being a fixed roster that
// ignores what's actually moving. Raise LIVE_SCAN_TOP_N if you want more
// breadth and are comfortable with the added API weight per cycle; the
// exchange-side weight comments above (and the Binance ban postmortem)
// are the ceiling to reason against before raising it much further.
const LIVE_SCAN_TOP_N = 15;
const LIVE_UNIVERSE_TTL_MS = 45_000; // matches server.js's own cache window — no reason to ask more often than the server would give a fresh answer anyway
const liveUniverseCache = {}; // { [exchange]: { symbols: [{symbol, volume24hUsd}], atMs } }

// Fetches (or reuses a cached) ranked, exclusion-filtered symbol list for
// `exchange`. Returns { top: string[], totalAvailable: number } — `top`
// is what actually gets scanned this cycle, `totalAvailable` is the full
// post-exclusion count, purely for the status message ("15 of 247").
// Returns null only if there's no usable list at all (first-ever fetch on
// this exchange failed) — callers treat that as "can't scan yet".
async function getLiveTradeableSymbols(exchange){
  const cached = liveUniverseCache[exchange];
  const isFresh = cached && (Date.now() - cached.atMs < LIVE_UNIVERSE_TTL_MS);
  let list = isFresh ? cached.symbols : null;
  if(!list){
    try{
      const data = await callProxy('/api/futures/universe', { exchange });
      if(!data.ok) throw new Error(data.message || 'Universe fetch failed.');
      list = data.symbols;
      liveUniverseCache[exchange] = { symbols: list, atMs: Date.now() };
    }catch(err){
      if(cached) list = cached.symbols; // stale is still better than nothing
      else return null;
    }
  }
  const eligible = list.filter(s => !EXCLUDED_FUTURES_SYMBOLS.has(s.symbol));
  eligible.sort((a, b) => (b.volume24hUsd || 0) - (a.volume24hUsd || 0));
  return { top: eligible.slice(0, LIVE_SCAN_TOP_N).map(s => s.symbol), totalAvailable: eligible.length };
}
const ARM_PHRASE = 'PLACE REAL ORDERS';

function fu(){ return state.futures; }

function ensureDayState(){
  if(fu().dayState) return fu().dayState;
  const startingEquity = readStartingBalance();
  fu().dayState = {
    equity: startingEquity, startingEquity, peakEquity: startingEquity,
    trades: 0, wins: 0, losses: 0, consecutiveLosses: 0, lastLossAt: null,
    dailyPnlPct: 0, maxDrawdownPct: 0,
    realizedGrossUsd: 0, realizedNetUsd: 0, feesUsd: 0, fundingUsd: 0, slippageUsd: 0,
    openPositions: 0, openRiskPct: 0, positions: [],
  };
  return fu().dayState;
}

// Reads the "Simulation balance" field, clamped to something sane. This
// is only consulted when a dayState doesn't exist yet (fresh load) or
// when Reset Session explicitly asks for a new one — editing the field
// mid-session doesn't retroactively rewrite trades already taken.
function readStartingBalance(){
  const n = els.fuStartingBalance ? Number(els.fuStartingBalance.value) : NaN;
  if(!Number.isFinite(n) || n <= 0) return 10000;
  return Math.min(10_000_000, Math.max(100, n));
}

function resetSession(){
  const f = fu();
  if(f.running) toggleRunning(); // stop the engine first — never leaves it running against a wiped dayState
  const startingEquity = readStartingBalance();
  f.dayState = {
    equity: startingEquity, startingEquity, peakEquity: startingEquity,
    trades: 0, wins: 0, losses: 0, consecutiveLosses: 0, lastLossAt: null,
    dailyPnlPct: 0, maxDrawdownPct: 0,
    realizedGrossUsd: 0, realizedNetUsd: 0, feesUsd: 0, fundingUsd: 0, slippageUsd: 0,
    openPositions: 0, openRiskPct: 0, positions: [],
  };
  f.tradeHistory = [];
  f.lastRows = [];
  render();
}

function fmtUsd(x){
  const sign = x > 0 ? '+' : (x < 0 ? '' : '');
  return sign + '$' + x.toFixed(2);
}

function readSettingsFromInputs(){
  const f = fu();
  if(els.fuExchange) f.exchange = els.fuExchange.value;
  if(els.fuMinConfidence) f.minConfidence = Number(els.fuMinConfidence.value) || 60;
  // Fixed at 2.0 (1:2) — the field is now readonly (see index.html) but
  // this still guards against a stale localStorage value from before the
  // ratio became non-configurable.
  if(els.fuMinRR) f.minRiskReward = 2.0;
  if(els.fuMinNetProfit) f.minNetProfitPct = Number(els.fuMinNetProfit.value) || 0.30;
  // Clamped server-side-of-the-UI (not just via the input's min/max
  // attributes) so a 0/negative/absurd value typed directly, or the
  // attributes being bypassed, can never size a trade — the user can
  // still choose anywhere from 1% to RISK_DEFAULTS.maxRiskPctPerTrade
  // (50%) of the selected exchange's futures-account equity.
  // Risk per trade (%) has TWO inputs — fuRiskPct (Paper Engine
  // section, above) and fuLiveRiskPct (Live/Demo Trading section,
  // visible right next to the exchange picker so it doesn't require
  // scrolling back up before arming) — both editing the exact same
  // f.riskPctPerTrade value. syncRiskPctInputs (below, wired to each
  // field's own input listener) is what keeps them mirrored; this just
  // reads whichever was most recently edited/is currently in the DOM.
  if(els.fuRiskPct) f.riskPctPerTrade = Math.min(RISK_DEFAULTS.maxRiskPctPerTrade, Math.max(1, Number(els.fuRiskPct.value) || 1.0));
  if(els.fuLeverage) f.leverage = Number(els.fuLeverage.value) || RISK_DEFAULTS.defaultLeverage;
  f.highSelectivity = !!(els.fuSelectivityToggle && els.fuSelectivityToggle.checked);
}

function runCycle(){
  const f = fu();
  const dayState = ensureDayState();
  readSettingsFromInputs();

  mockMarket.tick(3); // advance synthetic market clock ~3 minutes per cycle

  managePositions(dayState, f.tradeHistory, { timeStopMinutes: 240 });

  const cfg = {
    exchange: f.exchange, weights: DEFAULT_WEIGHTS, highSelectivity: f.highSelectivity,
    minConfidence: f.minConfidence, minRiskReward: f.minRiskReward, minNetProfitPct: f.minNetProfitPct,
    riskPctPerTrade: f.riskPctPerTrade, leverage: f.leverage,
    strategies: f.strategies, strategyRR: f.strategyRR,
  };
  const { rows } = runScanCycle(cfg, dayState);
  f.lastRows = rows;

  // Open at most one new position per APPROVED symbol not already held,
  // respecting the max-simultaneous-positions gate already enforced
  // inside evaluateNoTradeFilters via dayState.
  for(const row of rows){
    if(row.status !== 'APPROVED') continue;
    if(dayState.positions.some(p => p.symbol === row.symbol)) continue;
    if(dayState.openPositions >= RISK_DEFAULTS.maxSimultaneousPositions) break;
    openPosition(row, dayState);
    recomputeOpenRisk(dayState);
  }

  render();
}

function render(){
  const f = fu();
  const d = ensureDayState();

  if(els.fuStatus) els.fuStatus.textContent = f.running ? 'ACTIVE · PAPER' : 'PAUSED · PAPER';
  if(els.fuBalance) els.fuBalance.textContent = '$' + d.equity.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const approved = f.lastRows.filter(r => r.status === 'APPROVED');
  const avgConf = approved.length ? Math.round(approved.reduce((a, r) => a + r.confidence, 0) / approved.length) : 0;
  const topRegime = f.lastRows.length ? f.lastRows[0].regime : '—';
  if(els.fuRegime) els.fuRegime.textContent = topRegime;
  if(els.fuConfidenceAvg) els.fuConfidenceAvg.textContent = approved.length ? avgConf + '/100' : '—';

  if(els.fuOpenPositions) els.fuOpenPositions.textContent = d.openPositions + ' / ' + RISK_DEFAULTS.maxSimultaneousPositions;
  if(els.fuTradesToday) els.fuTradesToday.textContent = d.trades;
  if(els.fuWins) els.fuWins.textContent = d.wins;
  if(els.fuLosses) els.fuLosses.textContent = d.losses;
  if(els.fuWinRate) els.fuWinRate.textContent = d.trades ? ((d.wins / d.trades) * 100).toFixed(1) + '%' : '—';

  if(els.fuGrossPnl) els.fuGrossPnl.textContent = fmtUsd(d.realizedGrossUsd);
  if(els.fuFees) els.fuFees.textContent = '-$' + d.feesUsd.toFixed(2);
  if(els.fuFunding) els.fuFunding.textContent = (d.fundingUsd >= 0 ? '-$' : '+$') + Math.abs(d.fundingUsd).toFixed(2);
  if(els.fuSlippage) els.fuSlippage.textContent = '-$' + d.slippageUsd.toFixed(2);
  if(els.fuNetPnl) els.fuNetPnl.textContent = fmtUsd(d.realizedNetUsd);

  const pf = computeProfitFactor(f.tradeHistory);
  if(els.fuProfitFactor) els.fuProfitFactor.textContent = pf === null ? '—' : pf.toFixed(2);

  if(els.fuDailyDrawdown) els.fuDailyDrawdown.textContent = d.dailyPnlPct.toFixed(2) + '%';
  if(els.fuMaxDrawdown) els.fuMaxDrawdown.textContent = d.maxDrawdownPct.toFixed(2) + '%';

  renderScanner(f.lastRows);
  renderHistory(f.tradeHistory);
}

function computeProfitFactor(history){
  if(!history.length) return null;
  const grossProfit = history.filter(t => t.netPnlUsd > 0).reduce((a, t) => a + t.netPnlUsd, 0);
  const grossLoss = Math.abs(history.filter(t => t.netPnlUsd < 0).reduce((a, t) => a + t.netPnlUsd, 0));
  if(grossLoss === 0) return grossProfit > 0 ? grossProfit : 0;
  return grossProfit / grossLoss;
}

function renderScanner(rows){
  if(!els.fuScannerRows) return;
  if(!rows.length){ els.fuScannerRows.innerHTML = '<div class="fu-empty">No scan run yet.</div>'; return; }
  els.fuScannerRows.innerHTML = rows.map((r, i) => `
    <div class="fu-row ${r.status === 'APPROVED' ? 'fu-approved' : 'fu-rejected'}" data-idx="${i}">
      <div>${r.symbol}</div>
      <div>${r.exchange}</div>
      <div>${r.direction}</div>
      <div>${r.setup}</div>
      <div>${r.confidence || 0}</div>
      <div>${r.entry ? r.entry.toFixed(4) : '—'}</div>
      <div>${r.stop ? r.stop.toFixed(4) : '—'}</div>
      <div>${r.tp1 ? r.tp1.toFixed(4) : '—'}</div>
      <div>${r.expectedGrossPct ? fmtPct(r.expectedGrossPct) : '—'}</div>
      <div>${r.expectedNetPct ? fmtPct(r.expectedNetPct) : '—'}</div>
      <div>${r.riskReward ? r.riskReward.toFixed(2) : '—'}</div>
      <div>${r.liquidityScore}</div>
      <div>${r.regime}</div>
      <div class="fu-status-cell">${r.status}</div>
    </div>
  `).join('');

  els.fuScannerRows.querySelectorAll('.fu-row').forEach(el => {
    el.addEventListener('click', () => {
      const row = rows[Number(el.dataset.idx)];
      if(els.fuExplain) els.fuExplain.textContent = row.explanation || 'No qualifying setup — nothing to explain.';
    });
  });
}

function renderHistory(history){
  if(!els.fuHistoryRows) return;
  if(!history.length){ els.fuHistoryRows.innerHTML = '<div class="fu-empty">No closed trades yet this session.</div>'; return; }
  els.fuHistoryRows.innerHTML = history.slice(0, 50).map(t => `
    <div class="fu-hrow ${t.netPnlUsd >= 0 ? 'fu-win' : 'fu-loss'}">
      <div>${new Date(t.timestamp).toLocaleTimeString()}</div>
      <div>${t.exchange}</div>
      <div>${t.symbol}</div>
      <div>${t.direction}</div>
      <div>${t.entry.toFixed(4)}</div>
      <div>${t.exit.toFixed(4)}</div>
      <div>${t.leverage}x</div>
      <div>${fmtUsd(t.grossPnlUsd)}</div>
      <div>-$${t.feesUsd.toFixed(2)}</div>
      <div>${fmtUsd(t.netPnlUsd)}</div>
      <div>${t.confidence}</div>
      <div>${t.strategy}</div>
      <div>${t.reasonExit}</div>
      <div>${t.durationMin}m</div>
    </div>
  `).join('');
}

// =============================================================
// Live/Demo trading (all five exchanges; MEXC is Live only). Separate state, separate stats,
// separate history from Paper above — nothing here touches dayState/
// tradeHistory, and Paper keeps running unaffected regardless of
// whether Live/Demo is armed or not.
// =============================================================

const LIVE_TRADEABLE_EXCHANGES = ['bybit', 'binance', 'gateio', 'mexc', 'bitget'];
// MEXC's Futures Demo Trading is a website/app-only feature — nothing in
// its API exposes a demo/testnet base URL (same situation MEXC spot has
// always had in this app). Live is still available; Demo just isn't.
const LIVE_ONLY_EXCHANGES = ['mexc'];

function callProxy(path, body){
  const proxyUrl = (state.verifyProxyUrl || '').trim().replace(/\/$/, '');
  if(!proxyUrl) return Promise.reject(new Error('No verification proxy configured — set one in Autotrade & Balances.'));
  return fetch(proxyUrl + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }).then(res => res.json().catch(() => null)).then(data => {
    if(!data) throw new Error('Proxy returned an unreadable response.');
    return data;
  });
}

function fetchLiveSnapshot(exchange, symbol){
  const proxyUrl = (state.verifyProxyUrl || '').trim().replace(/\/$/, '');
  if(!proxyUrl) return Promise.reject(new Error('No verification proxy configured.'));
  return fetch(`${proxyUrl}/api/futures/snapshot?exchange=${exchange}&symbol=${symbol}`)
    .then(res => res.json().catch(() => null))
    .then(data => {
      if(!data || !data.ok) throw new Error((data && data.message) || 'Snapshot fetch failed.');
      return data.snapshot;
    });
}

function liveCred(exchange, mode){
  const cred = state.exchangeCreds[exchange] && state.exchangeCreds[exchange][mode];
  return (cred && cred.apiKey && cred.verified) ? cred : null;
}

function showLiveMessage(msg, kind){
  if(els.fuLiveStatusLabel) els.fuLiveStatusLabel.textContent = msg;
  if(els.fuLiveStatusLabel) els.fuLiveStatusLabel.style.color = kind === 'error' ? 'var(--red)' : '';
}

// Builds a dayState-shaped object (same fields runScanCycle/noTradeEngine
// read) populated with REAL current values, so the no-trade filters
// (max simultaneous positions, portfolio risk, daily loss, cooldown after
// consecutive losses) apply against what's actually true of the live
// account — not a stale or fabricated picture of it. This is read-only
// input to runScanCycle; the actual open/close bookkeeping for real
// trades lives in fu().livePositions/liveTradeHistory below, updated
// directly by runLiveCycle, not by anything inside engine.js.
function buildLiveDayStateShim(equity){
  const f = fu();
  // Set once, the first time a real balance is read after Start — NOT
  // re-derived from the current balance every cycle, or the daily-loss
  // check below would always see 0% drawdown regardless of what actually
  // happened (equity and startingEquity would always be equal).
  if(f.liveStartingEquity == null) f.liveStartingEquity = equity;
  const startingEquity = f.liveStartingEquity;
  const dailyPnlPct = startingEquity > 0 ? ((equity - startingEquity) / startingEquity) * 100 : 0;

  const openSymbols = Object.keys(f.livePositions);
  const positions = openSymbols.map(symbol => {
    const p = f.livePositions[symbol];
    return { symbol, riskAmountUsd: p.riskAmountUsd || 0 };
  });
  // Recomputed from the real trade log's tail each cycle, rather than
  // tracked as separately-mutable state that could drift out of sync with it.
  let consecutiveLosses = 0, lastLossAt = null;
  for(const t of f.liveTradeHistory){
    if(t.netUsd < 0){ consecutiveLosses++; if(!lastLossAt) lastLossAt = t.closedAtMs; }
    else break;
  }
  const openRiskPct = positions.reduce((a, p) => a + p.riskAmountUsd, 0) / Math.max(1, equity) * 100;
  return {
    equity, startingEquity, peakEquity: Math.max(equity, startingEquity),
    trades: f.liveTrades, wins: 0, losses: 0, consecutiveLosses, lastLossAt,
    dailyPnlPct, maxDrawdownPct: 0,
    realizedGrossUsd: 0, realizedNetUsd: f.liveNetPnlUsd, feesUsd: 0, fundingUsd: 0, slippageUsd: 0,
    openPositions: openSymbols.length, openRiskPct, positions,
    // Per-symbol re-entry cooldown (set in runLiveCycle's close-detection
    // above) — read by evaluateNoTradeFilters (noTradeEngine.js) exactly
    // like Paper mode's own dayState.cooldownUntilBySymbol.
    cooldownUntilBySymbol: f.liveCooldownUntilBySymbol || {},
  };
}

async function runLiveCycle(){
  const f = fu();
  const exchange = f.liveExchange;
  if(!f.liveArmed) return;
  decayAdaptiveConfidenceBoost(); // see its own comment — lets a stricter bar from a losing stretch ease back on its own, not only on a win

  // 1) Check whatever we're already tracking as open, for closure — using
  // EACH position's own tracked exchange/mode/credential, not necessarily
  // whatever's currently selected. If that were keyed off the current
  // selection instead, switching exchanges while a position from a
  // different one is still open would query the wrong exchange for it
  // and silently stop monitoring the real position. (In practice
  // resetLiveSession clears livePositions on any switch, so this is a
  // belt-and-suspenders correctness point more than a routinely-hit path.)
  for(const symbol of Object.keys(f.livePositions)){
    const tracked = f.livePositions[symbol];
    const posCred = liveCred(tracked.exchange, tracked.mode);
    if(!posCred) continue; // can't check right now (key disconnected?) — leave it tracked, try again next cycle
    try{
      const data = await callProxy('/api/futures/position', { exchange: tracked.exchange, mode: tracked.mode, apiKey: posCred.apiKey, secretKey: posCred.secretKey, passphrase: posCred.passphrase, symbol, openedAtMs: tracked.openedAtMs, balanceBeforeUsd: tracked.balanceBeforeUsd });
      if(!data.ok) continue; // transient error — leave it tracked, try again next cycle
      if(!data.open){
        const closed = data.closed;
        const netUsd = closed ? closed.closedPnl : 0;
        // grossPnl/feesUsd can still come back null for any exchange on
        // a given trade if that specific lookup failed (rate limit,
        // transient error) — every exchange, Bybit included, now
        // reports a real breakdown when its history read succeeds (see
        // getBybitExecutionFees in server.js), so this is a per-trade
        // fallback, not a standing per-exchange gap.
        const grossUsd = closed && closed.grossPnl != null ? closed.grossPnl : null;
        const feesUsd = closed && closed.feesUsd != null ? closed.feesUsd : null;
        const closedAtMs = Date.now();
        // Only for Binance/Bybit for now, per an explicit "these two
        // first" request — other exchanges' history rows keep durationMin
        // as null until that's extended.
        const durationMin = DURATION_TRACKED_EXCHANGES.includes(tracked.exchange)
          ? Math.max(0, Math.round((closedAtMs - tracked.openedAtMs) / 60_000))
          : null;
        f.liveTradeHistory.unshift({
          closedAtMs, time: new Date().toLocaleTimeString(), exchange: tracked.exchange, symbol, side: tracked.side,
          entry: closed && closed.avgEntryPrice != null ? closed.avgEntryPrice : tracked.entry,
          exit: closed && closed.avgExitPrice != null ? closed.avgExitPrice : null,
          leverage: tracked.leverage, qty: tracked.qty, grossUsd, feesUsd, netUsd, orderId: tracked.orderId,
          setupType: tracked.setupType, durationMin,
        });
        // Same trade, also written to the cross-session Trade Log (see
        // appendPersistentTrade above) — independent of the session-scoped
        // array just above, which resetLiveSession clears on every re-arm.
        appendPersistentTrade({
          closedAtMs, exchange: tracked.exchange, mode: tracked.mode, symbol, side: tracked.side,
          entry: closed && closed.avgEntryPrice != null ? closed.avgEntryPrice : tracked.entry,
          exit: closed && closed.avgExitPrice != null ? closed.avgExitPrice : null,
          leverage: tracked.leverage, qty: tracked.qty, grossUsd, feesUsd, netUsd, orderId: tracked.orderId,
          setupType: tracked.setupType, durationMin,
        });
        f.liveTrades++;
        if(netUsd > 0) f.liveWins++; else f.liveLosses++;
        f.liveNetPnlUsd += netUsd;
        if(grossUsd != null) f.liveGrossPnlUsd += grossUsd;
        if(feesUsd != null) f.liveFeesUsd += feesUsd;
        checkAdaptiveCircuitBreaker(netUsd);
        // 30-minute no-re-entry cooldown on THIS symbol only (requirement:
        // closing a pair — TP, SL, or manually on the exchange itself,
        // all of which show up here identically as "no longer open" —
        // shouldn't let the bot immediately re-open the same pair; every
        // other pair stays tradeable right away). Read by
        // evaluateNoTradeFilters (noTradeEngine.js) via
        // buildLiveDayStateShim's cooldownUntilBySymbol below.
        f.liveCooldownUntilBySymbol = f.liveCooldownUntilBySymbol || {};
        f.liveCooldownUntilBySymbol[symbol] = closedAtMs + LIVE_SYMBOL_COOLDOWN_MS;
        delete f.livePositions[symbol];
      } else {
        if(els.fuLiveOpenPosition){
          els.fuLiveOpenPosition.textContent = `[${tracked.exchange}] ${symbol} ${data.position.side} ${data.position.size} @ ${data.position.avgPrice} (uPnL ${fmtUsd(data.position.unrealisedPnl)})`;
        }
        // Requirement #6/#7: once TP2 has fully filled, move the stop on
        // what's left (the 40% final leg) to its fee-adjusted breakeven
        // — detected here by the position's remaining size crossing
        // below the tp1+tp2 threshold, since Binance/Bybit report
        // position size directly rather than individual TP-leg fill
        // events. Never fires for TP1 alone (still ~70% remaining), and
        // only ever fires once per position (tracked.breakevenMoved).
        if(tracked.usePartialTp && !tracked.breakevenMoved && tracked.qty > 0 && tracked.breakevenStopPrice != null){
          const remainingFraction = data.position.size / tracked.qty;
          const tp2CrossedThreshold = 1 - (tracked.tp1Fraction || 0.3) - (tracked.tp2Fraction || 0.3) + 0.05; // ~0.45 — comfortably between "TP1 only" (~0.70) and "TP1+TP2" (~0.40) so a single poll can tell them apart
          if(remainingFraction <= tp2CrossedThreshold){
            tracked.breakevenMoved = true; // set before awaiting, so a slow response can't let a second poll double-fire this
            try{
              const moveResult = await callProxy('/api/futures/move-stop', {
                exchange: tracked.exchange, mode: tracked.mode, apiKey: posCred.apiKey, secretKey: posCred.secretKey, passphrase: posCred.passphrase,
                symbol, side: tracked.side, newStopPrice: tracked.breakevenStopPrice, slOrderId: tracked.slAlgoId,
              });
              if(moveResult.ok){
                tracked.slAlgoId = moveResult.slOrderId || tracked.slAlgoId;
                showLiveMessage(`${symbol}: TP2 filled — stop on the remaining position moved to fee-adjusted breakeven (${moveResult.newStopPrice}).`);
              } else {
                tracked.breakevenMoved = false; // didn't actually take effect — allow a retry on a later poll
                showLiveMessage(`${symbol}: TP2 filled but the breakeven stop move failed: ${moveResult.message}`, 'error');
              }
            }catch(err){
              tracked.breakevenMoved = false;
              showLiveMessage(`${symbol}: TP2 filled but the breakeven stop move failed: ${err.message}`, 'error');
            }
          }
        }
      }
    }catch(err){
      // network hiccup — leave it tracked, try again next cycle
    }
  }
  renderLive();

  // 2) One real position at a time, deliberately — see README-SCALP.md.
  // If something's already open, don't scan for a new one this cycle.
  if(Object.keys(f.livePositions).length > 0) return;
  if(els.fuLiveOpenPosition) els.fuLiveOpenPosition.textContent = 'None';

  if(!LIVE_TRADEABLE_EXCHANGES.includes(exchange)){
    showLiveMessage(`"${exchange}" isn't a supported Live/Demo exchange.`, 'error');
    return;
  }
  const mode = f.liveModeByExchange[exchange] || 'live';
  if(mode === 'demo' && LIVE_ONLY_EXCHANGES.includes(exchange)){
    showLiveMessage(`${exchange} has no Demo Trading available through its API — only Live.`, 'error');
    return;
  }
  const cred = liveCred(exchange, mode);
  if(!cred){
    showLiveMessage(`No verified ${exchange} ${mode} key found — connect and verify one in Autotrade & Balances first.`, 'error');
    return;
  }

  let equity;
  try{
    const balData = await callProxy('/api/futures/balance', { exchange, mode, apiKey: cred.apiKey, secretKey: cred.secretKey, passphrase: cred.passphrase });
    if(!balData.ok) throw new Error(balData.message || 'Balance check failed.');
    equity = balData.balance;
  }catch(err){
    showLiveMessage(`Could not read the real ${exchange} futures balance: ${err.message}`, 'error');
    return;
  }
  if(els.fuLiveBalance) els.fuLiveBalance.textContent = '$' + equity.toLocaleString('en-US', { minimumFractionDigits:2, maximumFractionDigits:2 });

  // Fetch the real, full symbol universe for this exchange (ranked,
  // exclusion-filtered, cached — see getLiveTradeableSymbols above),
  // then fetch real snapshots for BTCUSDT (always, for the shock filter
  // below, even though it's excluded from being traded) plus the top-N
  // tradeable symbols from that universe. A symbol whose fetch fails just
  // gets skipped this cycle (runScanCycle already tolerates a null
  // snapshot — see engine.js), not treated as fatal.
  const universe = await getLiveTradeableSymbols(exchange);
  if(!universe){
    showLiveMessage(`Could not fetch the ${exchange} futures symbol list this cycle — skipping.`, 'error');
    return;
  }
  const fetchSymbols = ['BTCUSDT', ...universe.top.filter(s => s !== 'BTCUSDT')];
  const snapshots = {};
  await Promise.all(fetchSymbols.map(async symbol => {
    try{ snapshots[symbol] = await fetchLiveSnapshot(exchange, symbol); }catch(err){ /* skip this symbol this cycle */ }
  }));
  if(!snapshots.BTCUSDT){
    showLiveMessage(`Could not fetch real BTC market data from ${exchange} this cycle (needed for the shock filter) — skipping.`, 'error');
    return;
  }

  readSettingsFromInputs();
  const f2 = fu();
  const cfg = {
    exchange, weights: DEFAULT_WEIGHTS, highSelectivity: f2.highSelectivity,
    // The adaptive boost (see checkAdaptiveCircuitBreaker) stacks on top
    // of whatever Min Confidence is set to, not in place of it — a
    // losing streak makes live trading pickier than your own setting,
    // never more lenient than it.
    minConfidence: Math.min(95, f2.minConfidence + f2.liveAdaptiveConfidenceBoost),
    minRiskReward: f2.minRiskReward, minNetProfitPct: f2.minNetProfitPct,
    riskPctPerTrade: f2.riskPctPerTrade, leverage: f2.leverage,
    strategies: f2.strategies, strategyRR: f2.strategyRR,
  };
  const dayStateShim = buildLiveDayStateShim(equity);
  const { rows } = runScanCycle(cfg, dayStateShim, {
    symbols: universe.top,
    getSnapshot: symbol => snapshots[symbol] || null,
    now: () => Date.now(),
    getBtcShock: () => computeBtcShock(snapshots.BTCUSDT.m5),
  });
  renderScanner(rows); // reuse the same scanner table Paper mode renders into — it's one shared "what did the scan just find" view

  const approved = rows.find(r => r.status === 'APPROVED');
  if(!approved){
    const boostNote = f2.liveAdaptiveConfidenceBoost > 0 ? ` (min confidence raised +${f2.liveAdaptiveConfidenceBoost} after recent losses)` : '';
    showLiveMessage(`Armed on ${exchange} (${mode}), watching top ${universe.top.length} of ${universe.totalAvailable} available pairs by volume (BTC/ETH/SOL/LTC/DOGE/BNB excluded) — no qualifying signal this cycle${boostNote}.`);
    return;
  }

  // Optional AI second opinion (see js/ai-signal.js) — consulted ONLY here,
  // on a row the engine above has ALREADY approved through every existing
  // scoring/risk/no-trade check. It can only cancel this one order; it
  // never sees a rejected row and never touches sizing/leverage/risk.
  if(state.aiSignal.enabled && state.aiSignal.apiKey){
    showLiveMessage(`Engine approved ${approved.symbol} ${approved.direction} — checking with ${approved.symbol ? state.aiSignal.provider : ''}…`);
    const verdict = await getAiConfirmation({
      symbol: approved.symbol, exchange, direction: approved.direction, setup: approved.setup,
      regime: approved.regime, confidence: approved.confidence, entry: approved.entry, stop: approved.stop,
      tp1: approved.tp1, riskRewardRatio: approved.riskReward, expectedNetPct: approved.expectedNetPct,
      liquidityScore: approved.liquidityScore, reasons: approved.reasons,
    });
    if(verdict && verdict.ok && verdict.approve === false){
      showLiveMessage(`AI signal check rejected ${approved.symbol} ${approved.direction} despite the engine's approval: "${verdict.reason||'no reason given'}" — no order placed this cycle.`, 'error');
      return;
    }
    if(verdict && !verdict.ok){
      showLiveMessage(`AI signal check couldn't complete (${verdict.message||'unknown error'}) — proceeding on the engine's own approval alone.`);
    }
  }

  const side = approved.direction === 'LONG' ? 'Buy' : 'Sell'; // server normalizes casing per exchange — see FUTURES_SIDE_CASING in server.js

  if(f2.liveTradeMode === 'manual'){
    // Manual mode: scanning and every check above still run exactly as
    // in Auto — this just stops one step short of actually placing the
    // order. Show it and wait for a deliberate click instead.
    f2.livePendingSignal = { ...approved, side, exchange, mode, equityAtDetection: equity, detectedAtMs: Date.now() };
    renderLivePendingSignal();
    showLiveMessage(`Manual mode: ${approved.symbol} ${side} qualifies (confidence ${approved.confidence}, ${approved.setup}) — waiting for you to click Execute Trade.`);
    return;
  }

  await placeLiveEntryOrder(approved, side, exchange, mode, cred, cfg, equity);
}

// Exchanges the partial 30/30/40 TP structure + fee-adjusted breakeven
// move (requirements #1-#8) is actually wired up for end-to-end — see
// FUTURES_MOVE_STOP in server.js. Every other connected exchange still
// places a single TP at tp1 (its original behavior, unchanged) until
// they're migrated too.
const PARTIAL_TP_EXCHANGES = ['binance', 'bybit'];
// Same scope for trade-duration reporting, per an explicit "only these
// two for now" request — durationMin stays null for other exchanges'
// history rows until asked to extend it.
const DURATION_TRACKED_EXCHANGES = ['binance', 'bybit'];

// Shared by both the Auto-mode path above and the Manual-mode Execute
// button (executeLivePendingSignal below) — the actual order placement
// and position tracking, identical either way once a signal is being
// acted on. Manual mode's only difference is WHEN this gets called and
// that it re-validates immediately beforehand — see executeLivePendingSignal.
async function placeLiveEntryOrder(approved, side, exchange, mode, cred, cfg, equity){
  const f = fu();
  const openedAtMs = Date.now();
  const usePartialTp = PARTIAL_TP_EXCHANGES.includes(exchange) && approved.tpFractions;
  try{
    showLiveMessage(`Placing a real ${mode} order on ${exchange}: ${approved.symbol} ${side} @ ~${approved.entry}…`);
    const orderBody = {
      exchange, mode, apiKey: cred.apiKey, secretKey: cred.secretKey, passphrase: cred.passphrase,
      symbol: approved.symbol, side, qty: approved.sizing.qty, leverage: cfg.leverage, entryPrice: approved.entry,
      stopLossPrice: approved.stop,
    };
    if(usePartialTp){
      // TP1 @ 1.0R closes 30%, TP2 @ 1.5R closes 30%, TP3 @ 2.25R closes
      // the remaining 40% — prices/fractions come straight from the
      // engine's own fee-aware construction (attachTpLevels, engine.js),
      // not recomputed here.
      orderBody.tpLevels = [
        { price: approved.tp1, fraction: approved.tpFractions.tp1 },
        { price: approved.tp2, fraction: approved.tpFractions.tp2 },
        { price: approved.tp3, fraction: approved.tpFractions.tp3 },
      ];
    } else {
      orderBody.takeProfitPrice = approved.tp1; // legacy single-TP path for exchanges not yet migrated
    }
    const result = await callProxy('/api/futures/order', orderBody);
    if(!result.ok){
      showLiveMessage(`Order rejected: ${result.message}`, 'error');
      return;
    }
    f.livePositions[approved.symbol] = {
      exchange, mode, orderId: result.orderId, side, qty: result.filledQty, entry: result.avgPrice,
      leverage: result.leverage, stopLossPrice: result.stopLossPrice, takeProfitPrice: result.takeProfitPrice,
      riskAmountUsd: approved.sizing.riskAmountUsd, openedAtMs, balanceBeforeUsd: equity,
      setupType: approved.setup,
      // Fields only meaningful when usePartialTp is true — used by
      // runLiveCycle's position-size polling to detect when TP2 has
      // fully filled and trigger the breakeven move exactly once.
      usePartialTp, tp2Fraction: approved.tpFractions ? approved.tpFractions.tp2 : null,
      tp1Fraction: approved.tpFractions ? approved.tpFractions.tp1 : null,
      breakevenStopPrice: approved.breakevenStopPrice, slAlgoId: result.slAlgoId || null,
      breakevenMoved: false,
    };
    const tpNote = usePartialTp
      ? `TP1 ${approved.tp1} (30%) / TP2 ${approved.tp2} (30%) / TP3 ${approved.tp3} (40%)`
      : `TP ${result.takeProfitPrice}`;
    showLiveMessage(`Real ${mode} position opened: ${approved.symbol} ${side} ${result.filledQty} @ ${result.avgPrice}, SL ${result.stopLossPrice} / ${tpNote} (order ${result.orderId}).`);
  }catch(err){
    showLiveMessage(`Order failed: ${err.message}`, 'error');
  }
  renderLive();
}

function renderLivePendingSignal(){
  const f = fu();
  const p = f.livePendingSignal;
  if(!els.fuLivePendingCard) return;
  if(!p || f.liveTradeMode !== 'manual'){
    els.fuLivePendingCard.style.display = 'none';
    return;
  }
  els.fuLivePendingCard.style.display = 'block';
  const ageSec = Math.max(0, Math.round((Date.now() - p.detectedAtMs) / 1000));
  if(els.fuLivePendingDetail){
    els.fuLivePendingDetail.innerHTML = `
      <div><b>${p.symbol}</b> ${p.side} on ${p.exchange} (${p.mode}) — <span style="color:var(--dim);">${p.setup}, confidence ${p.confidence}</span></div>
      <div style="margin-top:4px;">Entry ~${p.entry} · Stop ${p.stop} · Target ${p.tp1} · Expected net ${p.expectedNetPct != null ? p.expectedNetPct.toFixed(2)+'%' : '—'}</div>
      <div style="margin-top:4px;color:var(--dim);">Detected ${ageSec}s ago at balance $${p.equityAtDetection.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})} — re-checked fresh the moment you click Execute.</div>
    `;
  }
}

async function executeLivePendingSignal(){
  const f = fu();
  const p = f.livePendingSignal;
  if(!p) return;
  const cred = liveCred(p.exchange, p.mode);
  if(!cred){
    showLiveMessage(`No verified ${p.exchange} ${p.mode} key found anymore — can't execute.`, 'error');
    f.livePendingSignal = null;
    renderLivePendingSignal();
    return;
  }
  showLiveMessage(`Re-checking ${p.symbol} against fresh market data before executing…`);
  let equity;
  try{
    const balData = await callProxy('/api/futures/balance', { exchange: p.exchange, mode: p.mode, apiKey: cred.apiKey, secretKey: cred.secretKey, passphrase: cred.passphrase });
    if(!balData.ok) throw new Error(balData.message || 'Balance check failed.');
    equity = balData.balance;
  }catch(err){
    showLiveMessage(`Could not re-check balance before executing: ${err.message} — not executing.`, 'error');
    return;
  }
  readSettingsFromInputs();
  const f2 = fu();
  const cfg = {
    exchange: p.exchange, weights: DEFAULT_WEIGHTS, highSelectivity: f2.highSelectivity,
    minConfidence: Math.min(95, f2.minConfidence + f2.liveAdaptiveConfidenceBoost),
    minRiskReward: f2.minRiskReward, minNetProfitPct: f2.minNetProfitPct,
    riskPctPerTrade: f2.riskPctPerTrade, leverage: f2.leverage,
    strategies: f2.strategies, strategyRR: f2.strategyRR,
  };
  let snap, btcSnap;
  try{
    snap = await fetchLiveSnapshot(p.exchange, p.symbol);
    btcSnap = p.symbol === 'BTCUSDT' ? snap : await fetchLiveSnapshot(p.exchange, 'BTCUSDT');
  }catch(err){ snap = null; }
  if(!snap || !btcSnap){
    showLiveMessage(`Could not fetch fresh market data for ${p.symbol} — not executing. It'll refresh again next scan cycle.`, 'error');
    return;
  }
  const dayStateShim = buildLiveDayStateShim(equity);
  const { rows } = runScanCycle(cfg, dayStateShim, {
    symbols: [p.symbol],
    getSnapshot: s => s === p.symbol ? snap : (s === 'BTCUSDT' ? btcSnap : null),
    now: () => Date.now(),
    getBtcShock: () => computeBtcShock(btcSnap.m5),
  });
  const reApproved = rows.find(r => r.symbol === p.symbol && r.status === 'APPROVED');
  if(!reApproved){
    const rejected = rows.find(r => r.symbol === p.symbol);
    showLiveMessage(`${p.symbol} no longer qualifies as of this moment (market moved since it was detected${rejected ? ': ' + (rejected.reasons||[]).join('; ') : ''}) — not executing. Clearing this pending signal; it'll reappear if it qualifies again on a future scan.`, 'error');
    f.livePendingSignal = null;
    renderLivePendingSignal();
    return;
  }
  const side = reApproved.direction === 'LONG' ? 'Buy' : 'Sell';
  f.livePendingSignal = null;
  renderLivePendingSignal();
  await placeLiveEntryOrder(reApproved, side, p.exchange, p.mode, cred, cfg, equity);
}

function dismissLivePendingSignal(){
  const f = fu();
  f.livePendingSignal = null;
  renderLivePendingSignal();
  showLiveMessage('Pending signal dismissed — it\'ll reappear if it (or another) qualifies again on a future scan.');
}

// =============================================================
// Trade Log — persists every closed real trade across sessions, arms,
// exchange switches, and page reloads, independently of the Live/Demo
// Trade History table above (which is deliberately session-scoped: see
// resetLiveSession). Stored client-side only (this browser, this
// device) — there's no server-side account system in this app to sync
// it to. Capped at PERSISTENT_TRADE_LOG_MAX entries so it can't grow
// unbounded over months of use; oldest entries drop off first.
// =============================================================
const PERSISTENT_TRADE_LOG_KEY = 'nxtgen_futures_trade_log_v1';
const PERSISTENT_TRADE_LOG_MAX = 5000;

function loadPersistentTradeLog(){
  try{
    const raw = localStorage.getItem(PERSISTENT_TRADE_LOG_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  }catch(e){ return []; } // corrupt/blocked storage — treat as empty rather than throw
}

function appendPersistentTrade(record){
  try{
    const log = loadPersistentTradeLog();
    log.unshift(record);
    if(log.length > PERSISTENT_TRADE_LOG_MAX) log.length = PERSISTENT_TRADE_LOG_MAX;
    localStorage.setItem(PERSISTENT_TRADE_LOG_KEY, JSON.stringify(log));
  }catch(e){ /* storage full/unavailable — the session-scoped history above still has it */ }
}

// { preset: 'today'|'week'|'month'|'all'|'custom', fromMs, toMs } — UI-only,
// recomputed on demand, not persisted itself (only the underlying trades are).
let tradeLogRange = { preset: 'today' };

function computeTradeLogRange(preset, customFromStr, customToStr){
  const now = Date.now();
  if(preset === 'today'){
    const start = new Date(); start.setHours(0, 0, 0, 0);
    return { preset, fromMs: start.getTime(), toMs: now };
  }
  if(preset === 'week') return { preset, fromMs: now - 7 * 86_400_000, toMs: now };
  if(preset === 'month') return { preset, fromMs: now - 30 * 86_400_000, toMs: now };
  if(preset === 'all') return { preset, fromMs: 0, toMs: now };
  if(preset === 'custom'){
    const fromMs = customFromStr ? new Date(customFromStr + 'T00:00:00').getTime() : 0;
    const toMs = customToStr ? new Date(customToStr + 'T23:59:59.999').getTime() : now;
    return { preset, fromMs, toMs };
  }
  return { preset: 'today', fromMs: 0, toMs: now };
}

function renderTradeLog(){
  if(!els.fuLogRows) return;
  const { fromMs, toMs, preset } = tradeLogRange;
  const all = loadPersistentTradeLog();
  const rows = all.filter(t => t.closedAtMs >= fromMs && t.closedAtMs <= toMs);

  ['fuLogRangeToday', 'fuLogRangeWeek', 'fuLogRangeMonth', 'fuLogRangeAll', 'fuLogRangeCustom'].forEach(id => {
    if(els[id]) els[id].classList.toggle('active', els[id].dataset.range === preset);
  });
  if(els.fuLogCustomRow) els.fuLogCustomRow.style.display = preset === 'custom' ? 'flex' : 'none';

  const count = rows.length;
  const grossKnown = rows.filter(t => t.grossUsd != null);
  const feesKnown = rows.filter(t => t.feesUsd != null);
  const grossSum = grossKnown.reduce((a, t) => a + t.grossUsd, 0);
  const feesSum = feesKnown.reduce((a, t) => a + t.feesUsd, 0);
  const netSum = rows.reduce((a, t) => a + (t.netUsd || 0), 0);
  if(els.fuLogCount) els.fuLogCount.textContent = String(count);
  if(els.fuLogGross) els.fuLogGross.textContent = (grossKnown.length < count ? '~' : '') + fmtUsd(grossSum);
  if(els.fuLogFees) els.fuLogFees.textContent = (feesKnown.length < count ? '~' : '') + fmtUsd(feesSum);
  if(els.fuLogNet) els.fuLogNet.textContent = fmtUsd(netSum);

  if(!rows.length){
    els.fuLogRows.innerHTML = '<div class="fu-empty">No trades recorded in this browser for this range.</div>';
    return;
  }
  els.fuLogRows.innerHTML = rows.slice(0, 500).map(t => `
    <div class="fu-hrow ${t.netUsd >= 0 ? 'fu-win' : 'fu-loss'}" style="grid-template-columns:1.1fr .7fr 1fr .6fr .8fr .8fr .5fr .7fr .8fr .8fr .8fr .6fr;">
      <div>${new Date(t.closedAtMs).toLocaleString()}</div>
      <div>${t.exchange || '—'}${t.mode ? ` (${t.mode})` : ''}</div>
      <div>${t.symbol}</div>
      <div>${t.side}</div>
      <div>${t.entry != null ? Number(t.entry).toFixed(4) : '—'}</div>
      <div>${t.exit != null ? Number(t.exit).toFixed(4) : '—'}</div>
      <div>${t.leverage}x</div>
      <div>${t.qty}</div>
      <div>${t.grossUsd != null ? fmtUsd(t.grossUsd) : '—'}</div>
      <div>${t.feesUsd != null ? fmtUsd(t.feesUsd) : '—'}</div>
      <div>${fmtUsd(t.netUsd)}</div>
      <div>${t.durationMin != null ? t.durationMin + 'm' : '—'}</div>
    </div>
  `).join('');
}

// =============================================================
// Strategy selector — per-strategy enable/disable + reward:risk, backed
// by STRATEGY_REGISTRY (setups.js) for what's fixed about each one and
// by its own localStorage key for what the user's changed. Per-strategy
// stats shown alongside each row are computed live from the persistent
// Trade Log above (loadPersistentTradeLog, filtered by setupType) — real
// numbers from real trades in this browser, never a backtest figure.
// =============================================================
const STRATEGY_CONFIG_KEY = 'nxtgen_futures_strategy_config_v1';

function persistStrategyConfig(){
  const f = fu();
  try{ localStorage.setItem(STRATEGY_CONFIG_KEY, JSON.stringify({ strategies: f.strategies, strategyRR: f.strategyRR })); }
  catch(e){ /* non-fatal — just won't survive a reload */ }
}

function restoreStrategyConfig(){
  const f = fu();
  // Seed every strategy from its own registry default first, so a
  // strategy added to STRATEGY_REGISTRY after a user already has a saved
  // config still gets a sane default instead of silently defaulting to
  // "off"/undefined.
  STRATEGY_REGISTRY.forEach(s => {
    f.strategies[s.id] = s.defaultEnabled;
    f.strategyRR[s.id] = s.defaultRR;
  });
  try{
    const raw = localStorage.getItem(STRATEGY_CONFIG_KEY);
    if(!raw) return;
    const saved = JSON.parse(raw);
    if(saved && typeof saved === 'object'){
      if(saved.strategies) Object.assign(f.strategies, saved.strategies);
      if(saved.strategyRR) Object.assign(f.strategyRR, saved.strategyRR);
    }
  }catch(e){ /* ignore corrupt/blocked storage — registry defaults already seeded above */ }
}

function computeStrategyStats(setupType){
  const log = loadPersistentTradeLog();
  const rows = log.filter(t => t.setupType === setupType);
  const wins = rows.filter(t => t.netUsd > 0).length;
  const netSum = rows.reduce((a, t) => a + (t.netUsd || 0), 0);
  return { trades: rows.length, wins, winRatePct: rows.length ? (wins / rows.length) * 100 : null, netUsd: netSum };
}

function renderStrategyRows(){
  if(!els.fuStrategyRows) return;
  const f = fu();
  els.fuStrategyRows.innerHTML = STRATEGY_REGISTRY.map(s => {
    const stats = computeStrategyStats(s.type);
    const statsLine = stats.trades === 0
      ? 'No trades yet (this browser)'
      : `${stats.trades} trade${stats.trades===1?'':'s'} · ${stats.winRatePct.toFixed(0)}% win rate · ${fmtUsd(stats.netUsd)} net — real Live/Demo results, this browser`;
    const enabled = f.strategies[s.id] ?? s.defaultEnabled;
    const rr = f.strategyRR[s.id] ?? s.defaultRR;
    return `
      <div class="ov-block" style="margin-bottom:10px;padding:12px;border-color:${enabled ? 'var(--line)' : 'var(--line-dim, var(--line))'};opacity:${enabled ? '1' : '.6'};">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap;">
          <div style="flex:1;min-width:220px;">
            <label class="toggle-check" style="font-weight:600;">
              <input type="checkbox" class="fu-strategy-enable" data-id="${s.id}" ${enabled ? 'checked' : ''}>
              <span>${s.label}</span>
            </label>
            <div style="font-size:12px;color:var(--dim);margin-top:6px;line-height:1.5;">${s.description}</div>
          </div>
          <div style="min-width:150px;">
            <label style="font-size:11px;color:var(--dim);display:block;margin-bottom:4px;">Reward:Risk</label>
            <select class="fu-strategy-rr" data-id="${s.id}">
              ${[1, 1.5, 2, 2.5, 3].map(v => `<option value="${v}" ${Math.abs(v-rr)<0.01 ? 'selected' : ''}>1:${v}</option>`).join('')}
            </select>
          </div>
        </div>
        <div style="font-size:11px;color:var(--dim);margin-top:8px;">${statsLine}</div>
      </div>
    `;
  }).join('');
}

function initStrategySelector(){
  restoreStrategyConfig();
  renderStrategyRows();
  if(els.fuStrategyRows){
    els.fuStrategyRows.addEventListener('change', (e) => {
      const f = fu();
      if(e.target.classList.contains('fu-strategy-enable')){
        f.strategies[e.target.dataset.id] = e.target.checked;
        persistStrategyConfig();
        renderStrategyRows();
      } else if(e.target.classList.contains('fu-strategy-rr')){
        f.strategyRR[e.target.dataset.id] = parseFloat(e.target.value);
        persistStrategyConfig();
        renderStrategyRows();
      }
    });
  }
}

function initTradeLog(){
  const rangeBtns = ['fuLogRangeToday', 'fuLogRangeWeek', 'fuLogRangeMonth', 'fuLogRangeAll', 'fuLogRangeCustom'];
  rangeBtns.forEach(id => {
    if(!els[id]) return;
    els[id].addEventListener('click', () => {
      const preset = els[id].dataset.range;
      tradeLogRange = preset === 'custom'
        ? computeTradeLogRange('custom', els.fuLogCustomFrom?.value, els.fuLogCustomTo?.value)
        : computeTradeLogRange(preset);
      renderTradeLog();
    });
  });
  if(els.fuLogCustomApply) els.fuLogCustomApply.addEventListener('click', () => {
    tradeLogRange = computeTradeLogRange('custom', els.fuLogCustomFrom?.value, els.fuLogCustomTo?.value);
    renderTradeLog();
  });
  tradeLogRange = computeTradeLogRange('today');
  renderTradeLog();
}

function renderLiveHistory(){
  if(!els.fuLiveHistoryRows) return;
  const history = fu().liveTradeHistory;
  if(!history.length){ els.fuLiveHistoryRows.innerHTML = '<div class="fu-empty">No live/demo trades yet this session.</div>'; return; }
  els.fuLiveHistoryRows.innerHTML = history.slice(0, 50).map(t => `
    <div class="fu-hrow ${t.netUsd >= 0 ? 'fu-win' : 'fu-loss'}" style="grid-template-columns:.7fr 1fr 1fr .6fr .8fr .8fr .5fr .7fr .8fr .8fr .8fr .6fr 1.4fr;">
      <div>${t.time}</div>
      <div>${t.exchange || '—'}</div>
      <div>${t.symbol}</div>
      <div>${t.side}</div>
      <div>${t.entry != null ? Number(t.entry).toFixed(4) : '—'}</div>
      <div>${t.exit != null ? Number(t.exit).toFixed(4) : '—'}</div>
      <div>${t.leverage}x</div>
      <div>${t.qty}</div>
      <div>${t.grossUsd != null ? fmtUsd(t.grossUsd) : '—'}</div>
      <div>${t.feesUsd != null ? fmtUsd(t.feesUsd) : '—'}</div>
      <div>${fmtUsd(t.netUsd)}</div>
      <div>${t.durationMin != null ? t.durationMin + 'm' : '—'}</div>
      <div style="font-size:11px;color:var(--dim);">${t.orderId}</div>
    </div>
  `).join('');
}

function renderLive(){
  const f = fu();
  if(els.fuLiveStartingBalance) els.fuLiveStartingBalance.textContent = f.liveStartingEquity != null
    ? '$' + f.liveStartingEquity.toLocaleString('en-US', { minimumFractionDigits:2, maximumFractionDigits:2 })
    : '—';
  if(els.fuLiveTrades) els.fuLiveTrades.textContent = String(f.liveTrades);
  if(els.fuLiveWinRate) els.fuLiveWinRate.textContent = f.liveTrades ? ((f.liveWins / f.liveTrades) * 100).toFixed(1) + '%' : '—';
  if(els.fuLiveGrossPnl) els.fuLiveGrossPnl.textContent = fmtUsd(f.liveGrossPnlUsd);
  if(els.fuLiveFees) els.fuLiveFees.textContent = fmtUsd(f.liveFeesUsd);
  if(els.fuLiveNetPnl) els.fuLiveNetPnl.textContent = fmtUsd(f.liveNetPnlUsd);
  if(Object.keys(f.livePositions).length === 0 && els.fuLiveOpenPosition) els.fuLiveOpenPosition.textContent = 'None';
  renderLiveHistory();
  renderTradeLog();
  renderStrategyRows();
}

// =============================================================
// Adaptive response to REAL trade outcomes — deliberately simple and
// fully inspectable rather than a black-box "AI learns" claim: a rolling
// counter and two plain thresholds, both visible right here.
//
// 1) Circuit breaker: after too many real losses in a row, stop trading
//    and force a deliberate re-arm rather than continuing to run a
//    strategy that is empirically not working right now, on this
//    account, in current market conditions — Paper mode's synthetic
//    backtest performance is not evidence that it will, and a losing
//    streak on real money is not something to wait out silently.
// 2) Adaptive confidence: every consecutive real loss raises the
//    confidence bar the NEXT signal has to clear, on top of whatever
//    Min Confidence is set to — a real loss is treated as information
//    that current conditions are working against the strategy, so it
//    gets pickier, not just unluckier. A win resets the boost back to
//    zero. This is the actual "learn from the losers" mechanism — it
//    adjusts a real number based on real results, it just isn't a
//    trained model, and doesn't pretend to be one.
// =============================================================
const LIVE_CIRCUIT_BREAKER_MAX_CONSECUTIVE_LOSSES = 6; // was 4 — see comment below on why
const LIVE_ADAPTIVE_CONFIDENCE_STEP = 8;   // added to the confidence bar per consecutive loss
const LIVE_ADAPTIVE_CONFIDENCE_MAX = 25;   // cap on how much stricter it can get
// The boost above previously only ever came back down on a WIN — during
// a stretch where the strategy just isn't winning yet (which, at the
// win rates this kind of setup realistically runs at, is not unusual
// even when nothing is wrong), that meant it could sit at its stricter
// level indefinitely, filtering out more and more signals while waiting
// for a win that might not come for a while. That's not a stop, and it
// always was still scanning every cycle — but it could look and feel
// exactly like getting stuck. It now also decays on its own over time,
// regardless of whether a win has happened yet.
const LIVE_ADAPTIVE_CONFIDENCE_DECAY_MS = 30 * 60_000; // one step back down per 30min with no NEW loss

function decayAdaptiveConfidenceBoost(){
  const f = fu();
  if(f.liveAdaptiveConfidenceBoost <= 0) return;
  const elapsed = Date.now() - (f.liveAdaptiveConfidenceBoostAtMs || 0);
  if(elapsed < LIVE_ADAPTIVE_CONFIDENCE_DECAY_MS) return;
  f.liveAdaptiveConfidenceBoost = Math.max(0, f.liveAdaptiveConfidenceBoost - LIVE_ADAPTIVE_CONFIDENCE_STEP);
  f.liveAdaptiveConfidenceBoostAtMs = Date.now(); // restart the clock for the next step down, not just the first
}

function checkAdaptiveCircuitBreaker(netUsd){
  const f = fu();
  if(netUsd < 0){
    f.liveConsecutiveLosses++;
    f.liveAdaptiveConfidenceBoost = Math.min(LIVE_ADAPTIVE_CONFIDENCE_MAX, f.liveAdaptiveConfidenceBoost + LIVE_ADAPTIVE_CONFIDENCE_STEP);
    f.liveAdaptiveConfidenceBoostAtMs = Date.now();
  } else {
    f.liveConsecutiveLosses = 0;
    f.liveAdaptiveConfidenceBoost = 0;
  }
  if(f.liveConsecutiveLosses >= LIVE_CIRCUIT_BREAKER_MAX_CONSECUTIVE_LOSSES && !f.livePausedByCircuitBreaker){
    f.livePausedByCircuitBreaker = true;
    if(f.liveRunning) toggleLiveRunning();
    f.liveArmed = false; // force a deliberate re-arm, not just a re-click of Start
    if(els.fuLiveConfirmCheck) els.fuLiveConfirmCheck.checked = false;
    if(els.fuLiveArmRow) els.fuLiveArmRow.style.display = 'none';
    if(els.fuLiveArmPhrase) els.fuLiveArmPhrase.value = '';
    showLiveMessage(`Paused automatically after ${f.liveConsecutiveLosses} consecutive real losses on ${f.liveExchange} (${f.liveModeByExchange[f.liveExchange]}). This is what's actually happening on your account right now, not Paper mode's synthetic backtest — review the trade history below before re-arming. Raising Min Confidence, or turning on High Selectivity Mode, before restarting is a reasonable place to start.`, 'error');
  }
}

const EXCHANGE_DISPLAY_NAMES = { bybit: 'Bybit', binance: 'Binance', gateio: 'Gate.io', mexc: 'MEXC', bitget: 'Bitget' };

function renderLiveExchangeRows(){
  if(!els.fuLiveExchRows) return;
  const f = fu();
  els.fuLiveExchRows.innerHTML = LIVE_TRADEABLE_EXCHANGES.map(key => {
    const name = EXCHANGE_DISPLAY_NAMES[key] || key;
    const mode = f.liveModeByExchange[key] || 'live';
    const selected = f.liveExchange === key;
    const supportsDemo = !LIVE_ONLY_EXCHANGES.includes(key);
    const cred = state.exchangeCreds[key] && state.exchangeCreds[key][mode];
    const verified = !!(cred && cred.verified);
    const statusNote = verified
      ? `verified ${mode} key connected`
      : `no verified ${mode} key — connect in Autotrade &amp; Balances`;
    const modeToggle = supportsDemo ? `
      <div class="mode-toggle" role="group" aria-label="${name} network">
        <button type="button" class="mode-btn ${mode==='live'?'active':''}" data-mode="live">Live</button>
        <button type="button" class="mode-btn ${mode==='demo'?'active':''}" data-mode="demo">Demo</button>
      </div>` : `<div class="mode-toggle mode-toggle--disabled" title="${name} has no public Demo Trading environment"><span class="mode-btn active">Live only</span></div>`;
    return `<div class="fu-live-exch-row${selected ? ' selected' : ''}" data-exchange="${key}">
      <div class="fu-live-exch-radio"></div>
      <div class="fu-live-exch-label">${name}</div>
      ${modeToggle}
      <div class="fu-live-exch-note" style="text-align:right;color:${verified ? 'var(--green)' : 'var(--dim)'};">${statusNote}</div>
    </div>`;
  }).join('');
}

function initLiveExchangeRows(){
  if(!els.fuLiveExchRows) return;
  els.fuLiveExchRows.addEventListener('click', e => {
    const row = e.target.closest('.fu-live-exch-row');
    if(!row) return;
    const exchange = row.dataset.exchange;
    const f = fu();
    const modeBtn = e.target.closest('.mode-btn[data-mode]');

    const exchangeChanged = f.liveExchange !== exchange;
    const modeChanged = modeBtn && f.liveModeByExchange[exchange] !== modeBtn.dataset.mode;
    if(!exchangeChanged && !modeChanged) return; // clicked the already-selected exchange/mode — nothing to do

    if(modeBtn) f.liveModeByExchange[exchange] = modeBtn.dataset.mode;
    f.liveExchange = exchange;
    resetLiveSession(); // re-arming for a different exchange/network is a decision made again, deliberately, every time — see its own comment below
  });
}

function updateLiveModeUI(){
  const f = fu();
  const exchange = f.liveExchange;
  const mode = f.liveModeByExchange[exchange] || 'live';
  const name = EXCHANGE_DISPLAY_NAMES[exchange] || exchange;
  if(els.fuLiveArmWrap) els.fuLiveArmWrap.style.display = '';
  if(els.fuLiveConfirmLabel) els.fuLiveConfirmLabel.textContent = `Sign and send real orders instead of simulating (requires a connected, verified ${name} ${mode} key)`;
  if(!f.liveArmed){
    showLiveMessage(`${name} (${mode === 'live' ? 'Live' : 'Demo'}) selected but not armed — check the box and type the phrase below to arm.`);
  } else {
    showLiveMessage(`Armed for ${mode === 'live' ? 'LIVE (real funds)' : 'Demo'} trading on ${name}.`);
  }
}

function toggleLiveRunning(){
  const f = fu();
  f.liveRunning = !f.liveRunning;
  if(f.liveRunning){
    runLiveCycle();
    f.liveTimer = setInterval(runLiveCycle, LIVE_CYCLE_MS);
    if(els.fuLiveToggleBtn) els.fuLiveToggleBtn.querySelector('.btn-label').textContent = 'Stop Live/Demo Trading';
    if(els.fuLiveToggleBtn) els.fuLiveToggleBtn.classList.add('on');
  } else {
    clearInterval(f.liveTimer);
    f.liveTimer = null;
    if(els.fuLiveToggleBtn) els.fuLiveToggleBtn.querySelector('.btn-label').textContent = 'Start Live/Demo Trading';
    if(els.fuLiveToggleBtn) els.fuLiveToggleBtn.classList.remove('on');
  }
}

// Arming never survives an exchange OR network change — re-arming for a
// different context (Demo -> Live, or Bybit -> Binance) is a decision
// that has to be made again, deliberately, every time. Session stats
// reset too: different exchange/mode combinations are different
// accounts with different balances — carrying one's numbers into
// another's display would be actively misleading, not just untidy.
function resetLiveSession(){
  const f = fu();
  if(f.liveRunning) toggleLiveRunning();
  f.liveArmed = false;
  f.liveStartingEquity = null;
  f.liveTrades = 0;
  f.liveWins = 0;
  f.liveLosses = 0;
  f.liveNetPnlUsd = 0;
  f.liveGrossPnlUsd = 0;
  f.liveFeesUsd = 0;
  f.liveTradeHistory = [];
  f.livePositions = {};
  f.liveCooldownUntilBySymbol = {};
  f.liveConsecutiveLosses = 0;
  f.livePausedByCircuitBreaker = false;
  f.liveAdaptiveConfidenceBoost = 0;
  f.livePendingSignal = null;
  if(els.fuLiveConfirmCheck) els.fuLiveConfirmCheck.checked = false;
  if(els.fuLiveArmRow) els.fuLiveArmRow.style.display = 'none';
  if(els.fuLiveArmPhrase) els.fuLiveArmPhrase.value = '';
  renderLiveExchangeRows();
  renderLivePendingSignal();
  updateLiveModeUI();
  renderLive();
}

function initLiveTradingControls(){
  initLiveExchangeRows();
  if(els.fuLiveConfirmCheck){
    els.fuLiveConfirmCheck.addEventListener('change', () => {
      if(els.fuLiveArmRow) els.fuLiveArmRow.style.display = els.fuLiveConfirmCheck.checked ? '' : 'none';
    });
  }
  if(els.fuLiveArmBtn){
    els.fuLiveArmBtn.addEventListener('click', () => {
      const f = fu();
      const exchange = f.liveExchange;
      const mode = f.liveModeByExchange[exchange] || 'live';
      if(!liveCred(exchange, mode)){
        showLiveMessage(`No verified ${exchange} ${mode} key found — connect and verify one in Autotrade & Balances first, then come back and arm.`, 'error');
        return;
      }
      if(!els.fuLiveConfirmCheck || !els.fuLiveConfirmCheck.checked){
        showLiveMessage('Check the confirmation box first.', 'error');
        return;
      }
      if((els.fuLiveArmPhrase.value || '').trim() !== ARM_PHRASE){
        showLiveMessage(`Type exactly "${ARM_PHRASE}" to arm.`, 'error');
        return;
      }
      f.liveArmed = true;
      updateLiveModeUI();
    });
  }
  if(els.fuLiveToggleBtn) els.fuLiveToggleBtn.addEventListener('click', toggleLiveRunning);
  if(els.fuLiveModeAutoBtn) els.fuLiveModeAutoBtn.addEventListener('click', () => setLiveTradeMode('auto'));
  if(els.fuLiveModeManualBtn) els.fuLiveModeManualBtn.addEventListener('click', () => setLiveTradeMode('manual'));
  if(els.fuLivePendingExecuteBtn) els.fuLivePendingExecuteBtn.addEventListener('click', executeLivePendingSignal);
  if(els.fuLivePendingDismissBtn) els.fuLivePendingDismissBtn.addEventListener('click', dismissLivePendingSignal);
  renderLiveExchangeRows();
  renderLivePendingSignal();
  updateLiveModeUI();
}

function setLiveTradeMode(newMode){
  const f = fu();
  f.liveTradeMode = newMode;
  if(newMode === 'auto'){
    // Switching back to Auto with a pending Manual signal sitting there
    // would mean the very next cycle silently fires an order the user
    // hasn't actually clicked Execute on — drop it instead, consistent
    // with everything else in this app never acting on your behalf
    // without a fresh, explicit decision.
    f.livePendingSignal = null;
  }
  if(els.fuLiveModeAutoBtn) els.fuLiveModeAutoBtn.classList.toggle('active', newMode === 'auto');
  if(els.fuLiveModeManualBtn) els.fuLiveModeManualBtn.classList.toggle('active', newMode === 'manual');
  renderLivePendingSignal();
}

function toggleRunning(){
  const f = fu();
  f.running = !f.running;
  if(f.running){
    runCycle();
    f.timer = setInterval(runCycle, CYCLE_MS);
    if(els.fuModeBtn) els.fuModeBtn.textContent = 'Pause Paper Engine';
  } else {
    clearInterval(f.timer);
    f.timer = null;
    if(els.fuModeBtn) els.fuModeBtn.textContent = 'Start Paper Engine';
  }
  render();
}

// Keeps fuRiskPct (Paper Engine section) and fuLiveRiskPct (Live/Demo
// Trading section) mirrored to the same value — they control the exact
// same f.riskPctPerTrade, just exposed in two places so the Live/Demo
// panel doesn't require scrolling back up to Paper's settings before
// arming. Called from each field's own 'input' listener with whichever
// one the user just edited.
function syncRiskPctInputs(rawValue){
  const f = fu();
  const clamped = Math.min(RISK_DEFAULTS.maxRiskPctPerTrade, Math.max(1, Number(rawValue) || 1.0));
  f.riskPctPerTrade = clamped;
  if(els.fuRiskPct) els.fuRiskPct.value = clamped;
  if(els.fuLiveRiskPct) els.fuLiveRiskPct.value = clamped;
}

function initRiskPctInputs(){
  const f = fu();
  const initial = f.riskPctPerTrade || RISK_DEFAULTS.riskPctPerTrade;
  if(els.fuRiskPct) els.fuRiskPct.value = initial;
  if(els.fuLiveRiskPct) els.fuLiveRiskPct.value = initial;
  if(els.fuRiskPct) els.fuRiskPct.addEventListener('input', () => syncRiskPctInputs(els.fuRiskPct.value));
  if(els.fuLiveRiskPct) els.fuLiveRiskPct.addEventListener('input', () => syncRiskPctInputs(els.fuLiveRiskPct.value));
}

export function initFuturesEngine(){
  ensureDayState();
  if(els.fuStartingBalance) els.fuStartingBalance.value = String(fu().dayState.startingEquity);
  if(els.fuModeBtn) els.fuModeBtn.addEventListener('click', toggleRunning);
  if(els.fuResetSessionBtn) els.fuResetSessionBtn.addEventListener('click', resetSession);
  initRiskPctInputs();
  initStrategySelector();
  initLiveTradingControls();
  initTradeLog();
  renderLive();
  render();
}
