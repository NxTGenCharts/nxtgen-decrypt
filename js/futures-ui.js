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
import { icon } from './icons.js';
import { runScanCycle, openPosition, managePositions, recomputeOpenRisk, EXCLUDED_FUTURES_SYMBOLS, scanSymbolsWithQuant } from './futures/engine.js';
import { QUANT_ID, QUANT_TYPE } from './futures/quant/config.js';
import { qlog } from './futures/quant/log.js';
import { getQuantCfg, setQuantProviders, setQuantConfigListener, quantCardStatsLine, getQuantRewardRisk, getQuantCardSettings, updateQuantConfig } from './quant-ui.js';
import { mockMarket } from './futures/mockMarket.js';
import { WATCHLIST_TOP_N, rankTopByVolume } from './futures/watchlist.js';
import { RISK_DEFAULTS, estimateLiquidationPrice } from './futures/risk.js';
import { DEFAULT_WEIGHTS } from './futures/scoring.js';
import {
  noteLiveOrderFailure as sharedNoteLiveOrderFailure, applyOrderFailureSkips as sharedApplyOrderFailureSkips,
  decayAdaptiveConfidenceBoost as sharedDecayAdaptiveConfidenceBoost, checkAdaptiveCircuitBreaker as sharedCheckAdaptiveCircuitBreaker,
  buildLiveDayStateShim as sharedBuildLiveDayStateShim, recordLiveClosure as sharedRecordLiveClosure,
  getTradeableSymbols as sharedGetTradeableSymbols, placeLiveEntryOrder as sharedPlaceLiveEntryOrder,
  runLiveCycleInner as sharedRunLiveCycleInner,
} from './futures/liveEngine.js';
import { computeBtcShock } from './futures/indicators.js';
import { STRATEGY_REGISTRY } from './futures/setups.js';
import { GRID_STRATEGY, GRID_DEFAULTS, GRID_SYMBOLS, createGridSession, stepGridSymbol, closeAllGridSessions, buildGridPlan, buildManualGridPlan, suggestGridRange, detectGridBreakout, netCycleProfit, scoreGridSuitability, runTradingBotsGridBacktest, summarizeTradingBotsGridTrades } from './futures/grid.js';
import { DCA_STRATEGY, DCA_DEFAULTS, buildDcaPlan, computeDcaExitPrices } from './futures/dca.js';
import { classifyRegime } from './futures/regime.js';
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

// A pair whose ORDER the exchange rejects (wrong precision, below the minimum size, insufficient margin for
// that contract, a per-symbol trading restriction...) used to be picked again on the very next 8s cycle,
// because it is still the first APPROVED row — the bot sat retrying it forever and never reached the next
// opportunity. Now a failed order puts THAT pair on a short skip list and the scan moves on:
//   * exchange rejected the order (result.ok === false)  -> 15 min; 60 min if the message is a sizing/precision
//     rule (those don't fix themselves in a few minutes)
//   * request itself failed (proxy/network error)        -> 3 min (likely transient, and other pairs would hit
//     the same problem, so this is short)
// Held in memory only; cleared by the same session reset that clears the post-close cooldown.
const LIVE_ORDER_REJECT_COOLDOWN_MS = 15 * 60_000;
const LIVE_ORDER_RULE_REJECT_COOLDOWN_MS = 60 * 60_000;
const LIVE_ORDER_ERROR_COOLDOWN_MS = 3 * 60_000;
const ORDER_RULE_REJECT_RE = /precision|lot size|minimum|min(imum)?\s*(size|qty|quantity|notional|order)|notional|tick size|step size|quantity|amount .* below|too small|invalid (qty|quantity|price)/i;

// Bridges this browser tab's own helpers (DOM, localStorage, the proxy
// fetch wrappers already defined further down in this file — all plain
// `function` declarations, so hoisting makes them callable here despite
// appearing later) into the shape js/futures/liveEngine.js expects. This is the one
// place that difference is bridged.
function buildBrowserLiveAdapter(){
  return {
    proxyCall: callProxy,
    fetchSnapshot: fetchLiveSnapshot,
    getCred: liveCred,
    notify: showLiveMessage,
    getQuantCfg,
    onPositionsChanged: () => saveLivePositions(),
    onRender: () => renderLive(),
    onPendingSignal: () => renderLivePendingSignal(),
    onDisarmedIdle: () => { if(fu().liveRunning) toggleLiveRunning(); },
    updateOpenPositionLabel: text => { if(els.fuLiveOpenPosition) els.fuLiveOpenPosition.textContent = text; },
    updateBalanceLabel: text => { if(els.fuLiveBalance) els.fuLiveBalance.textContent = text; },
    appendPersistentTrade,
    syncSettings: () => readSettingsFromInputs(),
    isAiEnabled: () => !!(state.aiSignal.enabled && state.aiSignal.apiKey),
    getAiConfirmation,
    onScanRows: rows => renderScanner(rows),
  };
}

// noteLiveOrderFailure/applyOrderFailureSkips: the real logic now lives in
// js/futures/liveEngine.js — these are thin
// wrappers so every existing call site in this file keeps working unchanged.
function noteLiveOrderFailure(symbol, message, kind){
  return sharedNoteLiveOrderFailure(fu(), symbol, message, kind);
}

function applyOrderFailureSkips(rows){
  return sharedApplyOrderFailureSkips(fu(), rows);
}

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
// The watchlist size is shared with Paper and Backtest (js/futures/watchlist.js: top 25 by 24h volume, the
// platform's excluded pairs removed). Binance's scan used to cost ~9 weight per symbol per 8s cycle (~1,700/min
// at 25 pairs, against a 2,400/min per-IP cap); server.js now shares the bookTicker/premiumIndex/24h-volume calls
// across symbols and briefly caches the 15m/1h candles, which brings 25 pairs to roughly 650-800/min. If the
// guard still pauses Binance calls, the shared host IP is the cause (other tenants' traffic counts against the
// same cap) — run the proxy on a dedicated IP, see server/README.md.
const LIVE_SCAN_TOP_N = WATCHLIST_TOP_N;
const LIVE_UNIVERSE_TTL_MS = 45_000; // matches server.js's own cache window — no reason to ask more often than the server would give a fresh answer anyway
const liveUniverseCache = {}; // { [exchange]: { symbols: [{symbol, volume24hUsd}], atMs } }

// Fetches (or reuses a cached) ranked, exclusion-filtered symbol list for
// `exchange`. Returns { top: string[], totalAvailable: number } — `top`
// is what actually gets scanned this cycle, `totalAvailable` is the full
// post-exclusion count, purely for the status message ("25 of 247"). `entries` is the same top list with
// each pair's 24h volume and last price (Paper uses those to mirror the pairs with synthetic candles).
// Returns null only if there's no usable list at all (first-ever fetch on
// this exchange failed) — callers treat that as "can't scan yet".
// The actual fetch+cache logic now lives in liveEngine.js (its own
// module-scoped cache). Thin wrapper so every call site here is unchanged.
async function getLiveTradeableSymbols(exchange){
  return sharedGetTradeableSymbols(buildBrowserLiveAdapter(), exchange);
}

// ---- Paper watchlist ----
// Paper mirrors the selected exchange's REAL current top-25 pairs by 24h volume (same ranking Live/Demo
// scans), with SYNTHETIC candles: the real pair only seeds each random walk's starting price and liquidity
// (mockMarket.ensureSymbol). The lookup is a fire-and-forget public call — the Paper cycle never waits on it —
// and if it can't run (no proxy configured, network error, a server that predates lastPrice) Paper keeps
// scanning whatever it already had, ultimately the built-in synthetic list, exactly as before.
const paperWatch = { exchange: null, symbols: null, total: 0, atMs: 0, pending: false };

function refreshPaperWatchlist(){
  const exchange = fu().exchange;
  const fresh = paperWatch.exchange === exchange && Date.now() - paperWatch.atMs < LIVE_UNIVERSE_TTL_MS;
  if(paperWatch.pending || fresh) return;
  paperWatch.pending = true;
  getLiveTradeableSymbols(exchange).then(u => {
    if(!u || !u.entries || !u.entries.length) return;
    const usable = u.entries
      .filter(e => mockMarket.ensureSymbol(e.symbol, { price: e.lastPrice, volume24hUsd: e.volume24hUsd }))
      .map(e => e.symbol);
    paperWatch.exchange = exchange; paperWatch.symbols = usable; paperWatch.total = u.entries.length; paperWatch.atMs = Date.now();
    const note = document.getElementById('fuWatchlistNote');
    if(note) note.textContent = usable.length
      ? `Paper watchlist: ${usable.length} of the top ${u.entries.length} ${exchange} pairs by 24h volume (excluded pairs removed) — real pair names, synthetic prices.${usable.length < u.entries.length ? ' The rest could not be seeded (the proxy may need updating).' : ''}`
      : '';
  }).catch(() => { /* keep the previous list / built-in synthetic list */ }).finally(() => { paperWatch.pending = false; });
}

// The symbols the Paper cycle scans this tick, or undefined to use the engine's built-in list.
function paperScanSymbols(f){
  if(paperWatch.exchange !== f.exchange || !paperWatch.symbols || !paperWatch.symbols.length) return undefined;
  return scanSymbolsWithQuant(paperWatch.symbols, { strategies: f.strategies, quant: getQuantCfg() });
}

function fu(){ return state.futures; }

// This module runs on more than one page. Paper controls live on Utilities &
// Tools; Live/Demo controls live on AI Futures Engine. Panels shared by both
// pages (Strategies / NxTGen Grid) render only the half that belongs to the
// page they're on, so no page shows controls that can't work there.
function hasLiveControls(){ return !!els.fuLiveExchRows; }
function hasPaperControls(){ return !!els.fuModeBtn; }

function ensureDayState(){
  if(fu().dayState) return fu().dayState;
  const startingEquity = readStartingBalance();
  fu().dayState = {
    equity: startingEquity, startingEquity, peakEquity: startingEquity,
    trades: 0, wins: 0, losses: 0, consecutiveLosses: 0, lastLossAt: null,
    dailyPnlPct: 0, maxDrawdownPct: 0,
    realizedGrossUsd: 0, realizedNetUsd: 0, feesUsd: 0, fundingUsd: 0, slippageUsd: 0,
    openPositions: 0, openRiskPct: 0, positions: [], quantTrades: [],
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
    openPositions: 0, openRiskPct: 0, positions: [], quantTrades: [],
  };
  f.tradeHistory = [];
  f.lastRows = [];
  // NxTGen Grid's Paper session is independent capital from the
  // six-strategy dayState above (see state.js's gridSession comment) —
  // reset it alongside so "Reset Session" actually starts everything
  // fresh, not just the ensemble half of it.
  f.gridSession = createGridSession(startingEquity);
  f.gridTradeHistory = [];
  render();
}

export function fmtUsd(x){
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
  if(els.fuMinNetProfit) f.minNetProfitPct = Number(els.fuMinNetProfit.value) || RISK_DEFAULTS.minNetProfitPct;
  // Clamped server-side-of-the-UI (not just via the input's min/max
  // attributes) so a 0/negative/absurd value typed directly, or the
  // attributes being bypassed, can never size a trade — the user can
  // still choose anywhere from 0.25% to RISK_DEFAULTS.maxRiskPctPerTrade
  // (50%) of the selected exchange's futures-account equity.
  // Risk per trade (%) has TWO inputs — fuRiskPct (Paper Engine
  // section, above) and fuLiveRiskPct (Live/Demo Trading section,
  // visible right next to the exchange picker so it doesn't require
  // scrolling back up before arming) — both editing the exact same
  // f.riskPctPerTrade value. syncRiskPctInputs (below, wired to each
  // field's own input listener) is what keeps them mirrored; this just
  // reads whichever was most recently edited/is currently in the DOM.
  if(els.fuRiskPct) f.riskPctPerTrade = Math.min(RISK_DEFAULTS.maxRiskPctPerTrade, Math.max(0.25, Number(els.fuRiskPct.value) || 1.0));
  if(els.fuLeverage) f.leverage = Number(els.fuLeverage.value) || RISK_DEFAULTS.defaultLeverage;
  f.highSelectivity = !!(els.fuSelectivityToggle && els.fuSelectivityToggle.checked);
}

// NxTGen Grid's Paper-mode tick — separate capital pool/session from
// the six-strategy dayState above (see state.js's gridSession comment),
// called once per Paper cycle right alongside the six-strategy logic.
// This calls the EXACT SAME stepGridSymbol used by the Backtest tab's
// NxTGen Grid run (js/futures/grid.js) — same suitability scoring, same
// fee-aware fills, same breakout/liquidation/daily-loss protection — so
// Paper behavior can't silently diverge from what the backtest showed.
// Only Paper is wired here; Live/Demo order placement against real
// Binance/Bybit Futures is NOT implemented (see the file header note in
// grid.js) — this never touches real money.
function runGridPaperTick(nowMs){
  const f = fu();
  const gridCfg = loadGridConfig();
  if(!gridCfg.enabled) return;
  // Deployment size now tracks the SAME "Risk per trade (%)" the six
  // strategies use (f.riskPctPerTrade, synced from fuRiskPct/
  // fuLiveRiskPct — see readFuturesConfig's comment) rather than the old
  // separate "Maximum Grid Allocation (%)" field, so one risk control
  // governs sizing everywhere instead of Grid silently using its own.
  gridCfg.maxGridAllocationPct = f.riskPctPerTrade;
  if(!f.gridSession) f.gridSession = createGridSession(readStartingBalance());
  const symbols = GRID_SYMBOLS.filter(s => mockMarket.symbols.includes(s));
  for(const symbol of symbols){
    const snap = mockMarket.snapshot(symbol);
    if(!snap) continue;
    const regime = classifyRegime(snap.h1, snap.m15);
    const bar = snap.m5[snap.m5.length - 1];
    const trades = stepGridSymbol(f.gridSession, {
      symbol, snap, regime, bar, nowMs, cfg: gridCfg, exchange: f.exchange,
      metaOverrides: { spreadPct: snap.meta.spreadPct, fundingRatePct: snap.meta.fundingRatePct },
    });
    if(trades.length){
      f.gridTradeHistory = trades.concat(f.gridTradeHistory).slice(0, 500);
      appendGridPaperTrades(trades);
    }
  }
}

// =============================================================
// NxTGen Grid — Live/Demo (Bybit/Binance only). Deliberately scoped to
// ONE symbol at a time for this first live-wired version — not a
// limitation I hit by accident, a decision: each cycle here makes
// several sequential signed API calls per symbol (snapshot, open
// orders, positions, and however many level/close orders need placing
// that cycle), and running all of GRID_SYMBOLS live at once would
// multiply that by however many symbols are in the watchlist on every
// 8s tick, which is a lot of exchange rate-limit exposure to take on
// before this exact mechanism has been watched run safely in Demo. Pick
// which symbol to run from the
// dropdown in the Grid panel; add more once this one's been proven out.
//
// State machine per deployment (f.gridLiveState): a plan (from
// buildGridPlan, the SAME function the backtest and Paper tick use) plus
// one entry per grid level, each either PENDING_ENTRY (a resting entry
// limit order out, not yet filled), PENDING_CLOSE (that level filled,
// its closing limit order is now resting at the next level up/down), or
// idle (freed after a close, waiting to be re-armed next cycle). Fill
// detection is inferred by an order's id dropping out of the exchange's
// own open-orders list — there is no push/websocket fill feed here,
// only polling once per LIVE_CYCLE_MS, so a level can sit filled for up
// to that long before its closing order goes out. That lag is a real,
// accepted trade-off of a browser-tab-polling design, same as every
// other Live/Demo strategy in this file — not specific to Grid.
//
// SAFETY: every side (LONG slot / SHORT slot) that holds any size gets
// an exchange-side stop-loss at the grid's own outer boundary
// (setBybitGridSideStop/setBinanceGridSideStop, server.js) the moment it
// goes non-flat — this is NOT part of the backtested strategy (which
// only closes via breakout detection running in this same JS loop) and
// is a deliberate addition for real money: if the tab closes, the
// network drops, or this loop simply stops running, filled legs are
// still protected by the exchange itself, not by nothing. See grid.js's
// header note on why runGridBacktest/stepGridSymbol don't model this —
// it doesn't affect what backtest numbers mean, it's purely a live-
// safety net layered on top of the real order flow only.
// =============================================================
const GRID_LIVE_EXCHANGES = ['bybit', 'binance'];
// Symbols probed per idle cycle when auto-scanning the watchlist for a
// deployment — bounded so scanning doesn't multiply real exchange API
// calls by the whole GRID_SYMBOLS list every LIVE_CYCLE_MS tick. At 4
// candidates per 8s cycle, a ~28-symbol watchlist gets a full pass in
// roughly a minute. Once a grid IS active, only that one symbol gets
// polled (see manageActiveGridLiveDeployment) — this batch size only
// applies while idle and scanning for the next one.
const GRID_SCAN_BATCH_SIZE = 4;

// Live's per-leg cycle-TP path already computes real netCycleProfit per close and adds it to gs.realizedUsd —
// see manageActiveGridLiveDeployment's PENDING_CLOSE branch. A FLATTEN (breakout/emergency/daily-loss/drift),
// though, closes every remaining open leg at once via one exchange call with no per-leg fill price returned, so
// there was previously no way to know what those legs closed at — which meant the ones that were NOT yet a
// completed grid cycle (still resting, no closing order out) never had their P&L counted anywhere, INCLUDING
// gs.realizedUsd — the exact same "losses never register" gap that stepGridSymbol had in grid.js (fixed
// there), except here it's real, not synthetic. Before flattening, mark every currently-open leg (PENDING_CLOSE
// — i.e. filled and resting a closing order at its target) to the current snapshot price, the same
// mark-to-market convention runGridBacktest/closeAllGridSessions in grid.js already use at a backtest's end —
// this is an ESTIMATE (the real fill will differ by whatever slippage the market order takes), not the actual
// realized fill, logged as such below.
async function flattenGridLiveAndRecord(f, gs, exchange, mode, symbol, proxyArgs, snap, nowMs, exitReason){
  const openLegs = gs.levels.filter(l => l.status === 'PENDING_CLOSE');
  for(const level of openLegs){
    const perLevelUsd = gs.plan.allocationUsd / gs.plan.levelCount;
    const qty = (perLevelUsd * gs.plan.leverage) / level.entryPrice;
    const pnl = netCycleProfit({
      entryPrice: level.entryPrice, exitPrice: snap.price, qty, direction: level.direction, exchange,
      holdMinutes: (nowMs - level.openedAt) / 60_000, fundingRatePct: snap.meta.fundingRatePct, slippagePct: snap.meta.spreadPct,
    });
    gs.realizedUsd += pnl.netUsd;
    const gridTradeRecord = {
      closedAtMs: nowMs, openedAtMs: level.openedAt, exchange, mode, symbol, side: level.direction, direction: level.direction,
      entry: level.entryPrice, exit: snap.price, qty, leverage: gs.plan.leverage,
      grossUsd: pnl.grossUsd, feesUsd: pnl.feesUsd, fundingUsd: pnl.fundingUsd, slippageUsd: pnl.slippageUsd, netUsd: pnl.netUsd,
      confidence: gs.plan.gridScore, setupType: 'NxTGen Grid', exitReason: `${exitReason} (est. — market-order flatten, actual fill may differ)`,
      durationMin: Math.round((nowMs - level.openedAt) / 60_000), gridId: gs.id, gridLevel: level.levelIndex, cycleResult: pnl.netUsd > 0 ? 'WIN' : 'LOSS',
    };
    f.gridLiveTradeHistory = [gridTradeRecord, ...f.gridLiveTradeHistory].slice(0, 500);
    appendPersistentTrade(gridTradeRecord);
  }
  const flat = await callProxy('/api/futures/grid/flatten', proxyArgs).catch(err => ({ ok:false, message: err.message }));
  if(!flat.ok) gridLiveLog(`Flatten call failed: ${flat.message} — check ${symbol} on ${exchange} directly.`, 'error');
  return flat;
}

function gridLiveLog(msg, kind){
  const host = els.fuGridPanel && els.fuGridPanel.querySelector('#fuGridLiveStatus');
  if(host){ host.textContent = msg; host.style.color = kind === 'error' ? 'var(--red)' : ''; }
}

function rollGridLiveDay(f, nowMs, equity){
  const key = Math.floor(nowMs / 86_400_000);
  if(f.gridLiveCurrentDayKey === key) return;
  f.gridLiveCurrentDayKey = key;
  f.gridLiveDayAnchorEquity = equity;
  f.gridLiveDailyHalted = false;
}

let gridLiveCycleInFlight = false;
async function runGridLiveCycle(){
  if(gridLiveCycleInFlight) return;
  gridLiveCycleInFlight = true;
  try{ await runGridLiveCycleInner(); }
  catch(err){ gridLiveLog(`Grid Live cycle error: ${err.message}`, 'error'); }
  finally{ gridLiveCycleInFlight = false; }
}

async function runGridLiveCycleInner(){
  const f = fu();
  const exchange = f.gridLiveExchange;
  if(!GRID_LIVE_EXCHANGES.includes(exchange)){
    gridLiveLog(`NxTGen Grid Live/Demo only supports Bybit or Binance — switch the exchange selector in this panel to one of those.`, 'error');
    return;
  }
  const mode = f.liveModeByExchange[exchange] || 'live';
  const cred = liveCred(exchange, mode);
  if(!cred){ gridLiveLog(`No verified ${exchange} ${mode} credential — connect it in Autotrade & Balances first.`, 'error'); return; }
  const gridCfg = loadGridConfig();
  // Same override as Paper's runGridPaperTick — deployment size tracks
  // the shared "Risk per trade (%)" control (fuRiskPct/fuLiveRiskPct)
  // instead of a separate Grid-only allocation setting.
  gridCfg.maxGridAllocationPct = f.riskPctPerTrade;
  const nowMs = Date.now();

  if(f.gridLiveState){
    await manageActiveGridLiveDeployment(f, exchange, mode, cred, gridCfg, nowMs);
  } else {
    await scanForGridLiveDeployment(f, exchange, mode, cred, gridCfg, nowMs);
  }
}

// --- No active deployment: scan for one. Auto-scan (default) probes a
// bounded, round-robin batch of the watchlist (GRID_SYMBOLS, the same
// list Paper/backtest trade) each idle cycle rather than pinning to a
// single manually-picked pair — a single symbol can easily sit in an
// unsuitable regime (High Volatility, strong trend, etc.) indefinitely,
// which is what "it never places a trade" usually means: nothing was
// wrong, that one pair just never cleared the Grid Score gate. Scanning
// more of the watchlist means whichever symbol actually presents a
// profitable grid setup (long or short side, per its own AUTO direction
// call) is the one that gets deployed. Turning "Scan watchlist" off
// falls back to the original single pinned-symbol behavior.
// Account-level drawdown circuit breaker for Grid Live — the live-wiring mirror of createGridSession's
// accountHalted in grid.js (Backtest/Paper). PERMANENT for the arm/run session: once tripped it stays tripped
// until the user re-arms Grid Live (which resets gridLivePeakEquity/gridLiveAccountHalted — see
// startGridLive/stopGridLive... actually reset happens on arm toggle below). Returns true the FIRST cycle it
// trips (so the caller can log/act once), false on every other cycle including ones where it's already halted.
function updateGridLiveDrawdownHalt(f, equity, gridCfg){
  if(f.gridLivePeakEquity == null || equity > f.gridLivePeakEquity) f.gridLivePeakEquity = equity;
  if(f.gridLiveAccountHalted) return false; // already handled
  const ddPct = f.gridLivePeakEquity > 0 ? ((f.gridLivePeakEquity - equity) / f.gridLivePeakEquity) * 100 : 0;
  if(ddPct >= gridCfg.maxAccountDrawdownPct){ f.gridLiveAccountHalted = true; return true; }
  return false;
}

async function scanForGridLiveDeployment(f, exchange, mode, cred, gridCfg, nowMs){
  if(f.gridLiveDailyHalted){ gridLiveLog(`Daily loss/profit limit reached — not opening a new grid until tomorrow.`, null); return; }

  const proxyArgsBase = { exchange, mode, apiKey: cred.apiKey, secretKey: cred.secretKey, passphrase: cred.passphrase };

  let candidates;
  if(f.gridLiveAutoScan){
    const cursor = f.gridLiveScanCursor % GRID_SYMBOLS.length;
    const batchSize = Math.min(GRID_SCAN_BATCH_SIZE, GRID_SYMBOLS.length);
    candidates = Array.from({ length: batchSize }, (_, i) => GRID_SYMBOLS[(cursor + i) % GRID_SYMBOLS.length]);
    f.gridLiveScanCursor = (cursor + batchSize) % GRID_SYMBOLS.length;
  } else {
    candidates = [f.gridLiveSymbol];
  }

  // Real account balance, queried once per cycle (not once per candidate
  // symbol) — same balance endpoint the six-strategy Live/Demo code uses.
  const balResp = await callProxy('/api/futures/balance', proxyArgsBase).catch(err => ({ ok:false, message: err.message }));
  if(!balResp.ok || balResp.balance == null){ gridLiveLog(`Could not read ${exchange} account balance: ${balResp.message || 'no balance returned'}`, 'error'); return; }
  const equityForSizing = balResp.balance;
  rollGridLiveDay(f, nowMs, equityForSizing);
  if(f.gridLiveDailyHalted){ gridLiveLog(`Daily loss/profit limit reached — not opening a new grid until tomorrow.`, null); return; }
  if(updateGridLiveDrawdownHalt(f, equityForSizing, gridCfg)){ gridLiveLog(`Account drawdown reached ${gridCfg.maxAccountDrawdownPct}% from its peak — Grid Live halted. Re-arm to resume once you've reviewed this.`, 'error'); return; }
  if(f.gridLiveAccountHalted) return; // already halted in an earlier cycle

  let bestReject = null; // { symbol, score, regime } — closest candidate this batch, just for the status message
  for(const symbol of candidates){
    const snap = await fetchLiveSnapshot(exchange, symbol, '5m').catch(err => { gridLiveLog(`Snapshot fetch failed for ${symbol}: ${err.message}`, 'error'); return null; });
    if(!snap) continue;
    const regime = classifyRegime(snap.h1, snap.m15);
    const suitability = scoreGridSuitability(snap, regime, gridCfg);
    if(!bestReject || suitability.score > bestReject.score) bestReject = { symbol, score: suitability.score, regime: regime.regime };
    if(!suitability.regimeOk || suitability.score < gridCfg.minGridScore) continue;

    const plan = buildGridPlan(symbol, snap, regime, gridCfg, equityForSizing);
    if(!plan) continue; // buildGridPlan is the real source of truth; the score check above is just to pick a candidate worth trying

    const proxyArgs = { ...proxyArgsBase, symbol };
    const modeCheck = await callProxy('/api/futures/grid/ensure-mode', proxyArgs);
    if(!modeCheck.ok || (modeCheck.hedgeModeReady === false)){
      gridLiveLog(modeCheck.message || `Could not confirm hedge mode for ${symbol} on ${exchange}.`, 'error');
      continue; // try the next candidate rather than giving up the whole cycle
    }

    gridLiveLog(`${symbol}: deploying grid (score ${plan.gridScore}/100, ${plan.levelCount} levels, ${plan.direction})…`, null);
    const levels = [];
    for(let li = 0; li < plan.levels.length; li++){
      const levelPrice = plan.levels[li];
      const isLowerHalf = levelPrice <= plan.mid;
      const wantLong = (plan.direction === 'LONG' || plan.direction === 'NEUTRAL') && isLowerHalf;
      const wantShort = (plan.direction === 'SHORT' || plan.direction === 'NEUTRAL') && !isLowerHalf;
      if(!wantLong && !wantShort) continue;
      const direction = wantLong ? 'LONG' : 'SHORT';
      const perLevelUsd = plan.allocationUsd / plan.levelCount;
      const qty = (perLevelUsd * plan.leverage) / levelPrice;
      const placed = await callProxy('/api/futures/grid/place-level', {
        ...proxyArgs, direction, price: levelPrice, qty, leverage: plan.leverage, orderLinkTag: `${li}`,
      }).catch(err => ({ ok:false, message: err.message }));
      if(!placed.ok){ gridLiveLog(`Level ${li} (${levelPrice.toFixed(6)}) skipped: ${placed.message}`, null); continue; }
      levels.push({ levelIndex: li, price: levelPrice, direction, status: 'PENDING_ENTRY', entryOrderId: placed.orderId, targetIndex: wantLong ? li + 1 : li - 1 });
    }
    if(levels.length === 0){ gridLiveLog(`${symbol}: no grid levels could be placed — see messages above. Trying the next candidate.`, 'error'); continue; }

    f.gridLiveState = { id: `GRID-${symbol.replace('USDT', '')}-${nowMs}`, plan, levels, longStopSet: false, shortStopSet: false, realizedUsd: 0, openedAt: nowMs };
    f.gridLiveSymbol = symbol; // keep the manual/last-picked symbol field in sync with whatever the scan actually deployed
    gridLiveLog(`${symbol}: grid ACTIVE — ${levels.length}/${plan.levelCount} levels resting.`, null);
    renderGridDashboard();
    return; // one deployment per cycle — manage it starting next cycle
  }

  // Nothing in this batch cleared the gate.
  if(f.gridLiveAutoScan){
    gridLiveLog(`Scanned ${candidates.join(', ')} — none suitable this cycle${bestReject ? ` (closest: ${bestReject.symbol} at ${bestReject.score}/${gridCfg.minGridScore}, regime ${bestReject.regime})` : ''}. Continuing scan next cycle.`, null);
  } else {
    gridLiveLog(`${candidates[0]}: market not currently suitable for a grid (regime ${bestReject ? bestReject.regime : '—'}) — waiting.`, null);
  }
}

// --- Active deployment: manage it. Fixed to whichever symbol it's
// actually running on (gs.plan.symbol) regardless of what the scan
// cursor or manual dropdown is currently pointed at — unchanged
// mechanics from the original single-symbol version; see this section's
// header comment for the polling design and why it's one symbol at a
// time once deployed.
async function manageActiveGridLiveDeployment(f, exchange, mode, cred, gridCfg, nowMs){
  const gs = f.gridLiveState;
  const symbol = gs.plan.symbol;
  const proxyArgs = { exchange, mode, apiKey: cred.apiKey, secretKey: cred.secretKey, passphrase: cred.passphrase, symbol };

  const snap = await fetchLiveSnapshot(exchange, symbol, '5m').catch(err => { gridLiveLog(`Snapshot fetch failed for ${symbol}: ${err.message}`, 'error'); return null; });
  if(!snap) return;

  // Sizing an already-active deployment derives from its own fixed
  // plan.allocationUsd (set at deployment time) rather than re-querying
  // balance mid-deployment, which would let a leg's size drift from what
  // the rest of the grid was planned against.
  const equityForSizing = gs.plan.allocationUsd / (gridCfg.maxGridAllocationPct / 100);
  rollGridLiveDay(f, nowMs, equityForSizing);
  if(updateGridLiveDrawdownHalt(f, equityForSizing, gridCfg)){
    gridLiveLog(`${symbol}: account drawdown reached ${gridCfg.maxAccountDrawdownPct}% from its peak — flattening and halting Grid Live.`, 'error');
    await flattenGridLiveAndRecord(f, gs, exchange, mode, symbol, proxyArgs, snap, nowMs, 'ACCOUNT_DRAWDOWN_HALT');
    f.gridLiveState = null;
    renderGridDashboard();
    return;
  }

  const bo = detectGridBreakout(snap, gs.plan, gridCfg);
  if(bo.breakout){
    gridLiveLog(`${symbol}: BREAKOUT detected (${bo.reasons[0] || ''}) — flattening grid.`, 'error');
    await flattenGridLiveAndRecord(f, gs, exchange, mode, symbol, proxyArgs, snap, nowMs, 'BREAKOUT_EXIT');
    f.gridLiveState = null;
    renderGridDashboard();
    return;
  }

  const openOrdersResp = await callProxy('/api/futures/grid/orders', proxyArgs).catch(err => ({ ok:false, message: err.message }));
  if(!openOrdersResp.ok){ gridLiveLog(`Could not read open orders for ${symbol}: ${openOrdersResp.message}`, 'error'); return; }
  const openIds = new Set(openOrdersResp.list.map(o => String(o.orderId)));

  for(const level of gs.levels){
    if(level.status === 'PENDING_ENTRY' && level.entryOrderId != null && !openIds.has(String(level.entryOrderId))){
      // Entry filled — rest the closing order at the target level.
      const targetPrice = gs.plan.levels[level.targetIndex];
      if(targetPrice == null){ level.status = 'FILLED_NO_TARGET'; continue; } // edge of grid — nothing to close into; left as-is until breakout/flatten
      const perLevelUsd = gs.plan.allocationUsd / gs.plan.levelCount;
      const qty = (perLevelUsd * gs.plan.leverage) / level.price;
      const closed = await callProxy('/api/futures/grid/place-close', {
        ...proxyArgs, direction: level.direction, price: targetPrice, qty, orderLinkTag: `${level.levelIndex}`,
      }).catch(err => ({ ok:false, message: err.message }));
      if(!closed.ok){ gridLiveLog(`Level ${level.levelIndex} filled but its close order failed: ${closed.message} — check ${symbol} directly.`, 'error'); continue; }
      level.status = 'PENDING_CLOSE'; level.closeOrderId = closed.orderId; level.entryPrice = level.price; level.targetPrice = targetPrice; level.openedAt = nowMs;

      // First time this side goes non-flat, attach its protective stop
      // at the grid's own outer boundary (see the header safety note).
      const stopField = level.direction === 'LONG' ? 'longStopSet' : 'shortStopSet';
      if(!gs[stopField]){
        const stopPrice = level.direction === 'LONG' ? gs.plan.lower : gs.plan.upper;
        const stopResult = await callProxy('/api/futures/grid/set-side-stop', { ...proxyArgs, direction: level.direction, stopPrice }).catch(err => ({ ok:false, message: err.message }));
        if(stopResult.ok) gs[stopField] = true;
        else gridLiveLog(`Could not attach protective stop on the ${level.direction} side of ${symbol}: ${stopResult.message} — that side has NO exchange-side protection yet.`, 'error');
      }
    } else if(level.status === 'PENDING_CLOSE' && level.closeOrderId != null && !openIds.has(String(level.closeOrderId))){
      // Close filled — this grid cycle is complete. Log it with grid.js's
      // OWN fee-aware accounting (netCycleProfit) so live and backtest
      // numbers mean the same thing, then re-arm this level.
      const perLevelUsd = gs.plan.allocationUsd / gs.plan.levelCount;
      const qty = (perLevelUsd * gs.plan.leverage) / level.entryPrice;
      const pnl = netCycleProfit({
        entryPrice: level.entryPrice, exitPrice: level.targetPrice, qty, direction: level.direction, exchange,
        holdMinutes: (nowMs - level.openedAt) / 60_000, fundingRatePct: snap.meta.fundingRatePct, slippagePct: snap.meta.spreadPct,
      });
      gs.realizedUsd += pnl.netUsd;
      const gridTradeRecord = {
        closedAtMs: nowMs, openedAtMs: level.openedAt, exchange, mode, symbol, side: level.direction, direction: level.direction,
        entry: level.entryPrice, exit: level.targetPrice, qty, leverage: gs.plan.leverage,
        grossUsd: pnl.grossUsd, feesUsd: pnl.feesUsd, fundingUsd: pnl.fundingUsd, slippageUsd: pnl.slippageUsd, netUsd: pnl.netUsd,
        confidence: gs.plan.gridScore, setupType: 'NxTGen Grid', exitReason: 'GRID_CYCLE_TP', durationMin: Math.round((nowMs - level.openedAt) / 60_000),
        gridId: gs.id, gridLevel: level.levelIndex, cycleResult: pnl.netUsd > 0 ? 'WIN' : 'LOSS',
      };
      f.gridLiveTradeHistory = [gridTradeRecord, ...f.gridLiveTradeHistory].slice(0, 500);
      // This is a REAL closed trade — belongs in the same cross-session
      // Trade Log (top of page) the six strategies' real Live/Demo
      // closes write to (appendPersistentTrade), not just Grid's own
      // dashboard. setupType:'NxTGen Grid' is what lets that Trade Log
      // (and its own per-strategy breakdowns) tell these apart from the
      // other six's rows.
      appendPersistentTrade(gridTradeRecord);

      const rePlaced = await callProxy('/api/futures/grid/place-level', {
        ...proxyArgs, direction: level.direction, price: level.price, qty, leverage: gs.plan.leverage, orderLinkTag: `${level.levelIndex}-r`,
      }).catch(err => ({ ok:false, message: err.message }));
      if(rePlaced.ok){
        level.status = 'PENDING_ENTRY'; level.entryOrderId = rePlaced.orderId; level.closeOrderId = null;
      } else {
        level.status = 'IDLE'; level.entryOrderId = null; level.closeOrderId = null;
        gridLiveLog(`Cycle closed on level ${level.levelIndex} but couldn't re-arm it: ${rePlaced.message}`, 'error');
      }
    }
  }

  // Grid's own max-loss circuit breaker and account daily-loss gate —
  // same thresholds stepGridSymbol enforces for Paper/backtest.
  const gridFloorUsd = -gs.plan.allocationUsd * (gridCfg.maxGridLossPct / 100);
  const dailyPnlPct = f.gridLiveDayAnchorEquity ? ((equityForSizing + gs.realizedUsd - f.gridLiveDayAnchorEquity) / f.gridLiveDayAnchorEquity) * 100 : 0;
  const halfWidth = (gs.plan.upper - gs.plan.lower) / 2;
  const driftedOut = snap.price > gs.plan.upper + halfWidth * (gridCfg.recalcDriftPct / 100) || snap.price < gs.plan.lower - halfWidth * (gridCfg.recalcDriftPct / 100);
  // maxGridLossPct emergency exit — gated on emergencyExitOn (was previously always active with no way to
  // turn it off from the panel toggle, the mirror of the same bug fixed in grid.js's stepGridSymbol).
  const emergencyTripped = gridCfg.emergencyExitOn && gs.realizedUsd < gridFloorUsd;
  const shouldFlatten = emergencyTripped || dailyPnlPct <= -gridCfg.maxDailyLossPct || driftedOut;
  if(shouldFlatten){
    const reason = emergencyTripped ? 'grid max-loss reached' : dailyPnlPct <= -gridCfg.maxDailyLossPct ? 'daily loss limit reached' : 'price drifted out of range';
    gridLiveLog(`${symbol}: flattening grid (${reason}).`, 'error');
    await flattenGridLiveAndRecord(f, gs, exchange, mode, symbol, proxyArgs, snap, nowMs, emergencyTripped ? 'EMERGENCY_EXIT' : dailyPnlPct <= -gridCfg.maxDailyLossPct ? 'DAILY_LOSS_LIMIT' : 'GRID_RECALCULATION');
    if(dailyPnlPct <= -gridCfg.maxDailyLossPct) f.gridLiveDailyHalted = true;
    f.gridLiveState = null;
  } else if(!f.gridLiveDailyHalted && gridCfg.dailyProfitTargetPct && dailyPnlPct >= gridCfg.dailyProfitTargetPct){
    // Daily Profit Target hit — same semantics as stepGridSymbol's Paper/
    // backtest path (grid.js): stop opening NEW grids for the rest of the
    // day, but don't force-close a grid that's still working. The active
    // deployment above keeps running/managing itself as normal.
    f.gridLiveDailyHalted = true;
    gridLiveLog(`${symbol}: daily profit target (${gridCfg.dailyProfitTargetPct}%) reached — no new grid deployments until tomorrow. Active grid left running.`, null);
  }
  renderGridDashboard();
}

function runCycle(){
  const f = fu();
  const dayState = ensureDayState();
  readSettingsFromInputs();

  mockMarket.tick(3); // advance synthetic market clock ~3 minutes per cycle
  runGridPaperTick(mockMarket.now());

  const beforeCount = f.tradeHistory.length;
  managePositions(dayState, f.tradeHistory, { timeStopMinutes: 240 });
  // managePositions unshifts newly-closed trades onto the front of
  // f.tradeHistory (which itself resets on every Reset Session/reload —
  // see resetSession above) — mirror anything new onto the cross-session
  // Paper Trade Log too (see appendPaperTrades below), same relationship
  // appendPersistentTrade already has with Live's own session history.
  // This is what lets the per-strategy stats in the Strategies panel
  // build up a real sample fast (Paper can run thousands of cycles in
  // minutes) instead of waiting on however few real Live/Demo trades
  // happen to exist.
  const newlyClosed = f.tradeHistory.length - beforeCount;
  if(newlyClosed > 0) appendPaperTrades(f.tradeHistory.slice(0, newlyClosed));

  const cfg = {
    exchange: f.exchange, weights: DEFAULT_WEIGHTS, highSelectivity: f.highSelectivity,
    minConfidence: f.minConfidence, minRiskReward: f.minRiskReward, minNetProfitPct: f.minNetProfitPct,
    riskPctPerTrade: f.riskPctPerTrade, leverage: f.leverage,
    strategies: f.strategies, strategyRR: f.strategyRR,
    // NxTGen Quant Futures (ignored unless enabled) takes Min confidence / Risk per trade / High Selectivity
    // from the same top controls as every other strategy — there is no separate Quant panel.
    quant: getQuantCfg({ log: true, minConfidence: f.minConfidence, riskPct: f.riskPctPerTrade, highSelectivity: f.highSelectivity }),
  };
  refreshPaperWatchlist();
  const { rows } = runScanCycle(cfg, dayState, { symbols: paperScanSymbols(f) });
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
  // Paper trades feed the Strategies panel's per-strategy stats (see
  // computeStrategyStats/appendPaperTrades) — refresh it every cycle so
  // the sample-size counter and "best so far" line update live while
  // Paper mode runs, not just when a checkbox/dropdown is touched.
  renderStrategyRows();
  renderGridDashboard();
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
      if(els.fuExplain) els.fuExplain.innerHTML = explanationHtml(row.explanation || 'No qualifying setup — nothing to explain.');
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
// Live/Demo's own leverage ceiling — deliberately separate from
// RISK_DEFAULTS.maxLeverage (10, Paper/Backtest's own ceiling, unaffected by
// this). Most exchanges' own futures leverage tops out well past this (50x,
// 75x, even 100x on some pairs); 50x is the cap this app enforces regardless
// of what an exchange itself would allow. Passed as cfg.maxLeverage into
// runScanCycle from both places Live/Demo actually builds that cfg — the
// manual-mode re-check below, and the Auto-mode scan in liveEngine.js.
const LIVE_LEVERAGE_MAX_LEVERAGE = 50;
// MEXC's Futures Demo Trading is a website/app-only feature — nothing in
// its API exposes a demo/testnet base URL (same situation MEXC spot has
// always had in this app). Live is still available; Demo just isn't.
const LIVE_ONLY_EXCHANGES = ['mexc'];

export function callProxy(path, body){
  const proxyUrl = (state.verifyProxyUrl || '').trim().replace(/\/$/, '');
  if(!proxyUrl) return Promise.reject(new Error('No verification proxy configured — set one in Autotrade & Balances.'));
  return fetch(proxyUrl + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }).then(res => res.json().catch(() => null)).then(data => {
    if(!data) throw new Error('Proxy returned an unreadable response.');
    return data;
  });
}

function fetchLiveSnapshot(exchange, symbol, timeframe){
  const proxyUrl = (state.verifyProxyUrl || '').trim().replace(/\/$/, '');
  if(!proxyUrl) return Promise.reject(new Error('No verification proxy configured.'));
  const tf = timeframe || '5m';
  return fetch(`${proxyUrl}/api/futures/snapshot?exchange=${exchange}&symbol=${symbol}&interval=${tf}`)
    .then(res => res.json().catch(() => null))
    .then(data => {
      if(!data || !data.ok) throw new Error((data && data.message) || 'Snapshot fetch failed.');
      // timeframeFallback: the requested timeframe isn't natively supported
      // by this exchange (Gate.io/MEXC have no 3m kline; see server.js's
      // SNAPSHOT_TIMEFRAME_MAP) — server already substituted 5m so the
      // scan still runs, this just surfaces it once instead of silently
      // trading on a different timeframe than what's selected.
      if(data.timeframeFallback && !warnedTimeframeFallback.has(exchange)){
        warnedTimeframeFallback.add(exchange);
        showLiveMessage(`${exchange} doesn't support the ${tf} timeframe for live klines — using 5m for ${exchange} instead.`, 'error');
      }
      return data.snapshot;
    });
}
const warnedTimeframeFallback = new Set(); // one warning per exchange per page load, not one per cycle

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
  return sharedBuildLiveDayStateShim(fu(), equity);
}

// recordLiveClosure: shared by runLiveCycleInner's closure-detection poll
// AND closeLivePosition (the in-app "Close Position" button) — both still
// call it with the exact same (f, symbol, tracked, closed) signature as
// before; the actual bookkeeping now lives in liveEngine.js.
function recordLiveClosure(f, symbol, tracked, closed){
  return sharedRecordLiveClosure(f, buildBrowserLiveAdapter(), symbol, tracked, closed);
}

// Manually closes an open real position from this app — the "Close
// Position" button next to the Open Position card (see renderLiveCloseButtons).
// Sends a reduce-only market close via /api/futures/close-position, then
// polls /api/futures/position (same route the automatic monitoring loop
// uses) briefly to pick up the realized P&L breakdown once the exchange's
// own history reflects it, and books the trade through the exact same
// recordLiveClosure path a TP/SL close would use. A short delay/retry is
// needed here because closing and the exchange's fill/PnL history
// updating are not always the same instant.
async function closeLivePosition(symbol){
  const f = fu();
  const tracked = f.livePositions[symbol];
  if(!tracked) return;
  const row = els.fuLiveCloseRow;
  const btn = row && row.querySelector(`.fu-close-pos-btn[data-symbol="${CSS.escape(symbol)}"]`);
  const cred = liveCred(tracked.exchange, tracked.mode);
  if(!cred){
    showLiveMessage(`Can't close ${symbol} — no connected/verified key for ${tracked.exchange} (${tracked.mode}).`, 'error');
    return;
  }
  if(btn){ btn.disabled = true; btn.textContent = `Closing ${symbol}…`; }
  try{
    const closeResult = await callProxy('/api/futures/close-position', {
      exchange: tracked.exchange, mode: tracked.mode, apiKey: cred.apiKey, secretKey: cred.secretKey, passphrase: cred.passphrase, symbol,
    });
    if(!closeResult.ok){
      showLiveMessage(closeResult.message || `Failed to close ${symbol}.`, 'error');
      if(btn){ btn.disabled = false; btn.textContent = `Close ${symbol}`; }
      return;
    }
    // Confirm it's actually gone and pick up the realized P&L, same route
    // the monitoring loop polls — try a few times since the exchange's own
    // position/history read can lag the close by a second or so.
    let closedData = null, confirmedClosed = false;
    const deadline = Date.now() + 8000;
    while(Date.now() < deadline){
      const posCheck = await callProxy('/api/futures/position', {
        exchange: tracked.exchange, mode: tracked.mode, apiKey: cred.apiKey, secretKey: cred.secretKey, passphrase: cred.passphrase,
        symbol, openedAtMs: tracked.openedAtMs, balanceBeforeUsd: tracked.balanceBeforeUsd,
      });
      if(posCheck.ok && !posCheck.open){ confirmedClosed = true; closedData = posCheck.closed; break; }
      await new Promise(r => setTimeout(r, 700));
    }
    if(!confirmedClosed){
      // The close order itself was accepted (closeResult.ok) — this just
      // means we couldn't confirm the P&L breakdown yet. Leave it tracked;
      // the regular monitoring loop will pick up the closure and book it
      // on its own next cycle rather than this silently losing the trade.
      showLiveMessage(`Close order sent for ${symbol} — confirming on ${tracked.exchange}, it'll finish logging on the next cycle.`, 'success');
      if(btn){ btn.disabled = false; btn.textContent = `Close ${symbol}`; }
      return;
    }
    recordLiveClosure(f, symbol, tracked, closedData);
    showLiveMessage(`${symbol} position closed.`, 'success');
    renderLive();
  }catch(err){
    showLiveMessage(`Failed to close ${symbol}: ${err.message}`, 'error');
    if(btn){ btn.disabled = false; btn.textContent = `Close ${symbol}`; }
  }
}

// Renders one detail row per currently-open real position into
// fuLiveCloseRow — entry, SL, and TP1/TP2/TP3 (whichever the position
// actually has; the legacy single-TP path only ever fills TP1, TP2/TP3
// show as "—") alongside its own "Close" button. Plain rows rather than
// the fixed single fuLiveOpenPosition line above, since (in principle)
// more than one symbol's real position can be open at once (see
// buildLiveDayStateShim's openPositions/positions), and each needs its
// own detail + own close target. Click handling is delegated once from
// the row itself in initLiveTradingControls, not rebound here.
function renderLiveCloseButtons(){
  const f = fu();
  const row = els.fuLiveCloseRow;
  if(!row) return;
  const positions = f.livePositions;
  const symbols = Object.keys(positions);
  if(symbols.length === 0){
    row.style.display = 'none';
    row.innerHTML = '';
    return;
  }
  const dash = v => (v != null ? v : '—');
  row.style.display = 'flex';
  row.innerHTML = symbols.map(s => {
    const p = positions[s];
    const ex = p.exchange || '';
    return `<div class="fu-pos-detail">
      <span class="fu-pos-detail-text">
        Entry ${dash(p.entry)} &middot; SL ${dash(p.stopLossPrice)} &middot; TP1 ${dash(p.tp1Price)} &middot; TP2 ${dash(p.tp2Price)} &middot; TP3 ${dash(p.tp3Price)}
      </span>
      <button type="button" class="primary ghost fu-close-pos-btn" data-symbol="${s}" title="Close the open ${s} ${p.side || ''} position on ${ex}">Close ${s}</button>
    </div>`;
  }).join('');
}

// Guards against overlapping runs: each cycle makes several awaited network
// calls (position checks, balance, universe, per-symbol snapshots) and can
// legitimately take longer than LIVE_CYCLE_MS under load or a slow
// connection. Without this, setInterval would fire a second call on top of
// a still-running one — two concurrent balance fetches racing to set the
// same UI field, or worse, two concurrent scans both seeing "no open
// position" and both trying to place an entry. A skipped tick here just
// means the very next one (8s later) picks up wherever things actually are.
let liveCycleInFlight = false;
async function runLiveCycle(){
  if(liveCycleInFlight) return;
  liveCycleInFlight = true;
  try{
    await runLiveCycleInner();
  } finally {
    liveCycleInFlight = false;
  }
}

async function runLiveCycleInner(){
  return sharedRunLiveCycleInner(fu(), buildBrowserLiveAdapter());
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
  return sharedPlaceLiveEntryOrder(fu(), buildBrowserLiveAdapter(), approved, side, exchange, mode, cred, cfg, equity);
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
    riskPctPerTrade: f2.riskPctPerTrade, leverage: f2.leverage, maxLeverage: LIVE_LEVERAGE_MAX_LEVERAGE,
    strategies: f2.strategies, strategyRR: f2.strategyRR,
    // Quant follows the same shared top controls — including the live adaptive confidence boost above.
    quant: getQuantCfg({ log: true, minConfidence: Math.min(95, f2.minConfidence + f2.liveAdaptiveConfidenceBoost), riskPct: f2.riskPctPerTrade, highSelectivity: f2.highSelectivity }),
  };
  let snap, btcSnap;
  const tf = '5m'; // locked everywhere — see initLiveTimeframeInput's comment
  try{
    snap = await fetchLiveSnapshot(p.exchange, p.symbol, tf);
    btcSnap = p.symbol === 'BTCUSDT' ? snap : await fetchLiveSnapshot(p.exchange, 'BTCUSDT', tf);
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

function newTradeLogId(record){
  return `${record.closedAtMs || Date.now()}_${record.symbol || ''}_${Math.random().toString(36).slice(2, 9)}`;
}

function loadPersistentTradeLog(){
  try{
    const raw = localStorage.getItem(PERSISTENT_TRADE_LOG_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    if(!Array.isArray(parsed)) return [];
    // Migration: rows written before per-row select/delete/export existed
    // (or any that slipped through without one) won't have a stable `id`
    // — the checkboxes below need one that survives across re-renders and
    // range-filter changes, unlike an array index. Assigned once here and
    // written straight back so it doesn't reshuffle on every read.
    let migrated = false;
    parsed.forEach(t => { if(!t.id){ t.id = newTradeLogId(t); migrated = true; } });
    if(migrated){
      try{ localStorage.setItem(PERSISTENT_TRADE_LOG_KEY, JSON.stringify(parsed)); }catch(e){ /* non-fatal, just re-migrates next read */ }
    }
    return parsed;
  }catch(e){ return []; } // corrupt/blocked storage — treat as empty rather than throw
}

function appendPersistentTrade(record){
  try{
    const log = loadPersistentTradeLog();
    log.unshift({ id: newTradeLogId(record), ...record });
    if(log.length > PERSISTENT_TRADE_LOG_MAX) log.length = PERSISTENT_TRADE_LOG_MAX;
    localStorage.setItem(PERSISTENT_TRADE_LOG_KEY, JSON.stringify(log));
  }catch(e){ /* storage full/unavailable — the session-scoped history above still has it */ }
}

// =============================================================
// Paper Trade Log — the Live/Demo Trade Log's counterpart for Paper
// mode: persists every closed PAPER trade (see engine.js's closeTrade,
// which is what actually shapes each record) across page reloads and
// Reset Session, independently of f.tradeHistory above (session-scoped,
// wiped by resetSession). This is deliberately a SEPARATE key/shape
// from PERSISTENT_TRADE_LOG_KEY (Live's real trades) — they must never
// be mixed into the same stats, since one is real money and the other
// is a synthetic random-walk simulation (see mockMarket.js's own header
// comment) — the per-strategy Strategies panel below reads ONLY this
// log, specifically because Paper can rack up hundreds of trades per
// strategy in minutes, which is what makes a real win-rate comparison
// between strategies possible at all — a handful of real Live/Demo
// trades never will be enough data for that on their own.
// =============================================================
const PAPER_TRADE_LOG_KEY = 'nxtgen_futures_paper_trade_log_v1';
const PAPER_TRADE_LOG_MAX = 20000; // no real-broker rate limit capping how fast Paper can generate trades, so a much higher ceiling than Live's PERSISTENT_TRADE_LOG_MAX

function loadPaperTradeLog(){
  try{
    const raw = localStorage.getItem(PAPER_TRADE_LOG_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  }catch(e){ return []; }
}

function appendPaperTrades(records){
  if(!records.length) return;
  try{
    const log = loadPaperTradeLog();
    log.unshift(...records);
    if(log.length > PAPER_TRADE_LOG_MAX) log.length = PAPER_TRADE_LOG_MAX;
    localStorage.setItem(PAPER_TRADE_LOG_KEY, JSON.stringify(log));
  }catch(e){ /* storage full/unavailable — f.tradeHistory (this session only) still has it */ }
}

// NxTGen Grid's own persisted Paper log — kept separate from the six-
// strategy PAPER_TRADE_LOG_KEY above rather than merged into it, since
// grid trade records carry different fields (gridId, gridLevel,
// cycleResult) and the strategy-stats code that reads
// PAPER_TRADE_LOG_KEY isn't written to expect those. Same shape as the
// records grid.js's runGridBacktest produces, so if this ever needs
// combining with backtest output for a report, no reshaping is needed.
const GRID_PAPER_TRADE_LOG_KEY = 'nxtgen_grid_paper_trade_log_v1';
const GRID_PAPER_TRADE_LOG_MAX = 20000;

function loadGridPaperTradeLog(){
  try{
    const raw = localStorage.getItem(GRID_PAPER_TRADE_LOG_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  }catch(e){ return []; }
}
function appendGridPaperTrades(records){
  if(!records.length) return;
  try{
    const log = loadGridPaperTradeLog();
    log.unshift(...records);
    if(log.length > GRID_PAPER_TRADE_LOG_MAX) log.length = GRID_PAPER_TRADE_LOG_MAX;
    localStorage.setItem(GRID_PAPER_TRADE_LOG_KEY, JSON.stringify(log));
  }catch(e){ /* storage full/unavailable — f.gridTradeHistory (this session only) still has it */ }
}

// { preset: 'today'|'week'|'month'|'all'|'custom', fromMs, toMs } — UI-only,
// recomputed on demand, not persisted itself (only the underlying trades are).
let tradeLogRange = { preset: 'today' };

// Trade Log row selection (for Delete/Export) — a Set of trade `id`s,
// UI-only and intentionally not persisted. Cleared on every range change
// so a checked row from "Today" can't silently still be checked after
// switching to "All Time".
let selectedTradeLogIds = new Set();

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

// Kept as one definition so the CSV/XLS/PDF exporters and any future
// column changes all stay in sync with each other automatically.
function tradeLogColumns(){
  return [
    { label: 'Date/Time', get: t => new Date(t.closedAtMs).toLocaleString() },
    { label: 'Exchange', get: t => `${t.exchange || ''}${t.mode ? ` (${t.mode})` : ''}` },
    { label: 'Symbol', get: t => t.symbol || '' },
    { label: 'Dir', get: t => t.side || '' },
    { label: 'Entry', get: t => t.entry != null ? Number(t.entry) : '' },
    { label: 'Exit', get: t => t.exit != null ? Number(t.exit) : '' },
    { label: 'Leverage', get: t => t.leverage != null ? `${t.leverage}x` : '' },
    { label: 'Qty', get: t => t.qty != null ? t.qty : '' },
    { label: 'Gross', get: t => t.grossUsd != null ? Number(t.grossUsd) : '' },
    { label: 'Fees', get: t => t.feesUsd != null ? Number(t.feesUsd) : '' },
    { label: 'Net', get: t => t.netUsd != null ? Number(t.netUsd) : '' },
    { label: 'Duration (min)', get: t => t.durationMin != null ? t.durationMin : '' },
    { label: 'Strategy', get: t => t.setupType || '' },
    { label: 'Order ID', get: t => t.orderId || '' },
  ];
}

function currentTradeLogRows(){
  const { fromMs, toMs } = tradeLogRange;
  const all = loadPersistentTradeLog();
  return all.filter(t => t.closedAtMs >= fromMs && t.closedAtMs <= toMs);
}

function renderTradeLog(){
  if(!els.fuLogRows) return;
  const { preset } = tradeLogRange;
  const rows = currentTradeLogRows();
  const rowIds = new Set(rows.map(t => t.id));
  // Drop any selected id that's fallen out of the current range/filter so
  // "Delete Selected"/"Export" never silently act on a row the user can no
  // longer see.
  for(const id of Array.from(selectedTradeLogIds)) if(!rowIds.has(id)) selectedTradeLogIds.delete(id);

  ['fuLogRangeToday', 'fuLogRangeWeek', 'fuLogRangeMonth', 'fuLogRangeAll', 'fuLogRangeCustom'].forEach(id => {
    if(els[id]) els[id].classList.toggle('active', els[id].dataset.range === preset);
  });
  if(els.fuLogCustomRow) els.fuLogCustomRow.style.display = preset === 'custom' ? 'flex' : 'none';

  const count = rows.length;
  // Partial-fill rows (TP1/TP2 legs — see the partial-fill detector in
  // runLiveCycleInner) are informational line items, not separate trades:
  // the eventual full-close row's netUsd is a balance-diff over the
  // WHOLE position's lifetime and already includes whatever these
  // partials realized, so they're excluded here to avoid double-counting
  // the same realized dollars twice in the summary. They still appear in
  // the row list below (and in exports) — just not in these totals.
  const summableRows = rows.filter(t => !t.partial);
  const grossKnown = summableRows.filter(t => t.grossUsd != null);
  const feesKnown = summableRows.filter(t => t.feesUsd != null);
  const grossSum = grossKnown.reduce((a, t) => a + t.grossUsd, 0);
  const feesSum = feesKnown.reduce((a, t) => a + t.feesUsd, 0);
  const netSum = summableRows.reduce((a, t) => a + (t.netUsd || 0), 0);
  if(els.fuLogCount) els.fuLogCount.textContent = String(count);
  if(els.fuLogGross) els.fuLogGross.textContent = (grossKnown.length < summableRows.length ? '~' : '') + fmtUsd(grossSum);
  if(els.fuLogFees) els.fuLogFees.textContent = (feesKnown.length < summableRows.length ? '~' : '') + fmtUsd(feesSum);
  if(els.fuLogNet) els.fuLogNet.textContent = fmtUsd(netSum);

  if(els.fuLogSelectedCount){
    els.fuLogSelectedCount.textContent = selectedTradeLogIds.size > 0
      ? `${selectedTradeLogIds.size} selected`
      : (count ? `Nothing checked — Delete/Export will act on all ${count} row(s) in this range.` : '');
  }
  if(els.fuLogSelectAll){
    els.fuLogSelectAll.checked = count > 0 && selectedTradeLogIds.size === count;
    els.fuLogSelectAll.indeterminate = selectedTradeLogIds.size > 0 && selectedTradeLogIds.size < count;
    els.fuLogSelectAll.disabled = count === 0;
  }

  if(!rows.length){
    els.fuLogRows.innerHTML = '<div class="fu-empty">No trades recorded in this browser for this range.</div>';
    return;
  }
  els.fuLogRows.innerHTML = rows.slice(0, 500).map(t => `
    <div class="fu-hrow ${t.netUsd >= 0 ? 'fu-win' : 'fu-loss'}" style="grid-template-columns:28px 1.1fr .7fr 1fr .6fr .8fr .8fr .5fr .7fr .8fr .8fr .8fr .6fr;">
      <div><input type="checkbox" class="fu-log-select" data-id="${t.id}" ${selectedTradeLogIds.has(t.id) ? 'checked' : ''}></div>
      <div>${new Date(t.closedAtMs).toLocaleString()}</div>
      <div>${t.exchange || '—'}${t.mode ? ` (${t.mode})` : ''}</div>
      <div>${t.symbol}${tradeSourceBadge(t)}</div>
      <div>${t.side}${t.partial ? ` (${t.tag})` : ''}</div>
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

// Exports/deletes act on whatever's checked; if nothing is checked, they
// act on every row currently visible under the active range filter — never
// on the full unfiltered log behind the user's back.
function tradeLogTargetRows(){
  const rows = currentTradeLogRows();
  if(selectedTradeLogIds.size > 0) return rows.filter(t => selectedTradeLogIds.has(t.id));
  return rows;
}

function csvEscape(val){
  const s = String(val ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function downloadBlob(filename, content, mime){
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportTradeLogCsv(){
  const rows = tradeLogTargetRows();
  if(!rows.length){ showLiveMessage('No trades to export — nothing checked and nothing in the current range.', 'error'); return; }
  const cols = tradeLogColumns();
  const lines = [cols.map(c => csvEscape(c.label)).join(',')];
  rows.forEach(t => lines.push(cols.map(c => csvEscape(c.get(t))).join(',')));
  downloadBlob(`nxtgen-trade-log-${Date.now()}.csv`, lines.join('\r\n'), 'text/csv;charset=utf-8;');
  showLiveMessage(`Exported ${rows.length} trade(s) to CSV.`);
}

function exportTradeLogXls(){
  // Real .xlsx generation needs a spreadsheet library this static app
  // doesn't otherwise carry — this instead uses the well-established
  // HTML-table-as-.xls trick: Excel (and Google Sheets/LibreOffice) opens
  // an HTML table saved with an .xls extension as a genuine spreadsheet,
  // no dependency or network fetch required.
  const rows = tradeLogTargetRows();
  if(!rows.length){ showLiveMessage('No trades to export — nothing checked and nothing in the current range.', 'error'); return; }
  const cols = tradeLogColumns();
  const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const head = `<tr>${cols.map(c => `<th>${esc(c.label)}</th>`).join('')}</tr>`;
  const body = rows.map(t => `<tr>${cols.map(c => `<td>${esc(c.get(t))}</td>`).join('')}</tr>`).join('');
  const html = `<html><head><meta charset="UTF-8"></head><body><table border="1">${head}${body}</table></body></html>`;
  downloadBlob(`nxtgen-trade-log-${Date.now()}.xls`, html, 'application/vnd.ms-excel');
  showLiveMessage(`Exported ${rows.length} trade(s) to XLS.`);
}

// jsPDF + autoTable are lazy-loaded from cdnjs only when a PDF export is
// actually requested — keeps the base app dependency-free and working
// fully offline for everything else, at the cost of needing a real
// internet connection the first time this specific button is used.
async function ensureJsPdf(){
  if(window.jspdf && window.jspdf.jsPDF) return window.jspdf;
  const loadScript = src => new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`could not load ${src}`));
    document.head.appendChild(s);
  });
  await loadScript('https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.2/jspdf.umd.min.js');
  await loadScript('https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.8.4/jspdf.plugin.autotable.min.js');
  if(!window.jspdf || !window.jspdf.jsPDF) throw new Error('PDF library failed to initialize');
  return window.jspdf;
}

async function exportTradeLogPdf(){
  const rows = tradeLogTargetRows();
  if(!rows.length){ showLiveMessage('No trades to export — nothing checked and nothing in the current range.', 'error'); return; }
  showLiveMessage('Building PDF…');
  try{
    const { jsPDF } = await ensureJsPdf();
    const cols = tradeLogColumns();
    const doc = new jsPDF({ orientation: 'landscape' });
    doc.setFontSize(12);
    doc.text('NxTGen Trade Log', 14, 14);
    doc.setFontSize(8);
    doc.text(new Date().toLocaleString(), 14, 20);
    doc.autoTable({
      startY: 24,
      head: [cols.map(c => c.label)],
      body: rows.map(t => cols.map(c => String(c.get(t)))),
      styles: { fontSize: 7 },
      headStyles: { fillColor: [20, 20, 30] },
    });
    doc.save(`nxtgen-trade-log-${Date.now()}.pdf`);
    showLiveMessage(`Exported ${rows.length} trade(s) to PDF.`);
  }catch(err){
    showLiveMessage(`PDF export failed: ${err.message} — this needs an internet connection the first time it's used, to load the PDF library.`, 'error');
  }
}

function deleteSelectedTradeLogRows(){
  const targets = tradeLogTargetRows();
  if(!targets.length){ showLiveMessage('No trades to delete — nothing checked and nothing in the current range.', 'error'); return; }
  const label = selectedTradeLogIds.size > 0 ? `${targets.length} checked trade(s)` : `all ${targets.length} trade(s) in this range`;
  if(!confirm(`Delete ${label} from the Trade Log? This can't be undone.`)) return;
  const targetIds = new Set(targets.map(t => t.id));
  const remaining = loadPersistentTradeLog().filter(t => !targetIds.has(t.id));
  try{
    localStorage.setItem(PERSISTENT_TRADE_LOG_KEY, JSON.stringify(remaining));
  }catch(e){
    showLiveMessage(`Delete failed: ${e.message}`, 'error');
    return;
  }
  selectedTradeLogIds.clear();
  renderTradeLog();
  showLiveMessage(`Deleted ${label} from the Trade Log.`);
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

// Heuristic minimum sample size before a strategy's win rate is treated
// as meaningful rather than noise — NOT a formal statistical
// significance test (that would need the actual win/loss variance, not
// just a trade count), just a practical guard against reading a verdict
// into 2-3 trades the way a raw win rate % invites. 30 is a common
// rule-of-thumb minimum sample size; below it, stats are still shown
// (never hidden) but visibly flagged as provisional — see
// renderStrategyRows.
const MIN_SIGNIFICANT_TRADES = 30;

function computeStrategyStats(setupType){
  // Reads the PAPER Trade Log (see appendPaperTrades above), not Live's
  // — Paper can generate a real sample size fast; a handful of actual
  // Live/Demo trades never will. This is a simulation result against
  // mockMarket.js's synthetic random walk, not a historical backtest
  // against real past prices — it tells you how a strategy's OWN
  // detection logic performs against unbiased synthetic price action,
  // which is still meaningful (the random walk has no idea which setup
  // is "supposed" to win), but it is not the same claim as "this is what
  // would have happened on the real market."
  const log = loadPaperTradeLog();
  const rows = log.filter(t => t.strategy === setupType);
  const wins = rows.filter(t => t.netPnlUsd > 0).length;
  const netSum = rows.reduce((a, t) => a + (t.netPnlUsd || 0), 0);
  const grossProfit = rows.filter(t => t.netPnlUsd > 0).reduce((a, t) => a + t.netPnlUsd, 0);
  const grossLoss = Math.abs(rows.filter(t => t.netPnlUsd < 0).reduce((a, t) => a + t.netPnlUsd, 0));
  const profitFactor = rows.length && grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? Infinity : null);
  return {
    trades: rows.length, wins,
    winRatePct: rows.length ? (wins / rows.length) * 100 : null,
    netUsd: netSum, profitFactor,
    isSignificant: rows.length >= MIN_SIGNIFICANT_TRADES,
  };
}

// Among strategies that have cleared MIN_SIGNIFICANT_TRADES paper
// trades, picks the one with the highest win rate (profit factor as the
// tie-break) — returns null if none have enough of a sample yet, rather
// than crowning a "best" strategy off 2 trades. This is what actually
// answers "which strategy is best" honestly instead of leaving it to
// eyeballing the panel.
function bestSignificantStrategy(){
  let best = null;
  for(const s of STRATEGY_REGISTRY){
    const stats = computeStrategyStats(s.type);
    if(!stats.isSignificant) continue;
    if(!best || stats.winRatePct > best.stats.winRatePct
      || (stats.winRatePct === best.stats.winRatePct && (stats.profitFactor||0) > (best.stats.profitFactor||0))){
      best = { strategy: s, stats };
    }
  }
  return best;
}

function renderStrategyRows(){
  if(!els.fuStrategyRows) return;
  const f = fu();
  let enabledCount = 0;
  const best = bestSignificantStrategy();
  if(els.fuStrategiesBest){
    els.fuStrategiesBest.innerHTML = best
      ? `${icon('trophy')} Best so far (Paper, ${best.stats.trades} trades): <b>${best.strategy.label}</b> — ${best.stats.winRatePct.toFixed(0)}% win rate, ${fmtUsd(best.stats.netUsd)} net${best.stats.profitFactor != null && isFinite(best.stats.profitFactor) ? `, ${best.stats.profitFactor.toFixed(2)} profit factor` : ''}`
      : `No strategy has reached ${MIN_SIGNIFICANT_TRADES} paper trades yet — run Paper mode to build a real sample before trusting any win-rate comparison.`;
  }
  const renderStratRow = (s) => {
    const stats = computeStrategyStats(s.type);
    let statsLine;
    if(stats.trades === 0){
      statsLine = `<span style="color:var(--dim);">No paper trades yet — enable this strategy in Paper mode to start building a sample</span>`;
    } else if(!stats.isSignificant){
      statsLine = `<span style="color:var(--amber);">${icon('hourglass')} ${stats.trades}/${MIN_SIGNIFICANT_TRADES} paper trades — not yet enough for a reliable win rate</span> · so far: ${stats.winRatePct.toFixed(0)}% win rate · ${fmtUsd(stats.netUsd)} net (Paper simulation)`;
    } else {
      statsLine = `<span style="color:var(--green);">${icon('check')} ${stats.trades} paper trades</span> · ${stats.winRatePct.toFixed(0)}% win rate · ${fmtUsd(stats.netUsd)} net${stats.profitFactor != null && isFinite(stats.profitFactor) ? ` · ${stats.profitFactor.toFixed(2)} profit factor` : ''} — Paper simulation, this browser`;
    }
    const enabled = f.strategies[s.id] ?? s.defaultEnabled;
    if(enabled) enabledCount++;
    const isQuant = s.id === QUANT_ID;
    // Quant Futures owns its RR (1:1.2 floor, quant/config.js HARD_LIMITS) and its stats wording (INSUFFICIENT SAMPLE) — see quant-ui.js.
    const rr = isQuant ? getQuantRewardRisk() : (f.strategyRR[s.id] ?? s.defaultRR);
    const rrOptions = s.rrOptions || [1, 1.5, 2, 2.5, 3];
    if(isQuant) statsLine = quantCardStatsLine();
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
              ${rrOptions.map(v => `<option value="${v}" ${Math.abs(v-rr)<0.01 ? 'selected' : ''}>1:${v}</option>`).join('')}
            </select>
          </div>
        </div>
        ${isQuant ? quantControlsHtml() : ''}
        <div style="font-size:11px;margin-top:8px;">${statsLine}</div>
      </div>
    `;
  };
  // Quant-only controls: which setups may fire, and the entry timeframe. These are the two levers for trade
  // frequency (Trend Pullback alone is deliberately selective; the Backtest tab's Quant diagnostics say which
  // one to pull). Rendered from getQuantCardSettings() so what is shown is exactly what runs.
  const quantControlsHtml = () => {
    const q = getQuantCardSettings();
    const setupDefs = [['A', 'Trend Pullback'], ['B', 'Breakout + Retest'], ['C', 'Liquidity Sweep'], ['D', 'Range Extremes']];
    return `
      <div style="display:flex;gap:14px;flex-wrap:wrap;align-items:center;margin-top:10px;font-size:12px;">
        <span style="color:var(--dim);">Setups:</span>
        ${setupDefs.map(([k, n]) => `<label style="display:flex;align-items:center;gap:5px;"><input type="checkbox" class="fu-quant-setup" data-setup="${k}" ${q.setups[k] ? 'checked' : ''}>${k} · ${n}</label>`).join('')}
        <span style="color:var(--dim);margin-left:6px;">Entry timeframe</span>
        <select class="fu-quant-tf">
          <option value="15m" ${q.entryTimeframe === '15m' ? 'selected' : ''}>15m (selective)</option>
          <option value="5m" ${q.entryTimeframe === '5m' ? 'selected' : ''}>5m (more signals)</option>
        </select>
      </div>`;
  };
  // Original six first, then NxTGen Grid, then NxTGen Quant Futures — so Quant is the 8th strategy in the list.
  const strategyRowsHtml = STRATEGY_REGISTRY.filter(s => s.id !== QUANT_ID).map(renderStratRow).join('');
  const quantRowHtml = STRATEGY_REGISTRY.filter(s => s.id === QUANT_ID).map(renderStratRow).join('');

  // NxTGen Grid — a 7th strategy, structurally different enough (many
  // simultaneous levels vs. one signal/entry) that its detailed config
  // lives in its own panel just below (grid.js's header comment explains
  // why), but the on/off switch itself belongs right here with the other
  // six so it's not the one strategy the user can't select from this
  // list. This checkbox and the panel below both read/write the same
  // GRID_CONFIG_KEY-backed 'enabled' flag, so they can never disagree.
  const gridCfg = loadGridConfig();
  const gridEnabled = gridCfg.enabled;
  if(gridEnabled) enabledCount++;
  const gridStats = computeStrategyStats(GRID_STRATEGY.type);
  let gridStatsLine;
  if(gridStats.trades === 0){
    gridStatsLine = `<span style="color:var(--dim);">No paper trades yet — enable it here to start building a sample</span>`;
  } else if(!gridStats.isSignificant){
    gridStatsLine = `<span style="color:var(--amber);">${icon('hourglass')} ${gridStats.trades}/${MIN_SIGNIFICANT_TRADES} paper trades — not yet enough for a reliable win rate</span> · so far: ${gridStats.winRatePct.toFixed(0)}% win rate · ${fmtUsd(gridStats.netUsd)} net (Paper simulation)`;
  } else {
    gridStatsLine = `<span style="color:var(--green);">${icon('check')} ${gridStats.trades} paper trades</span> · ${gridStats.winRatePct.toFixed(0)}% win rate · ${fmtUsd(gridStats.netUsd)} net${gridStats.profitFactor != null && isFinite(gridStats.profitFactor) ? ` · ${gridStats.profitFactor.toFixed(2)} profit factor` : ''} — Paper simulation, this browser`;
  }
  const gridRowHtml = `
    <div class="ov-block" style="margin-bottom:10px;padding:12px;border-color:${gridEnabled ? 'var(--line)' : 'var(--line-dim, var(--line))'};opacity:${gridEnabled ? '1' : '.6'};">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap;">
        <div style="flex:1;min-width:220px;">
          <label class="toggle-check" style="font-weight:600;">
            <input type="checkbox" class="fu-strategy-enable" data-id="${GRID_STRATEGY.id}" ${gridEnabled ? 'checked' : ''}>
            <span>${GRID_STRATEGY.label}</span>
          </label>
          <div style="font-size:12px;color:var(--dim);margin-top:6px;line-height:1.5;">${GRID_STRATEGY.description}</div>
        </div>
        <div style="min-width:150px;font-size:11px;color:var(--dim);text-align:right;">Levels, leverage, exchange, and Live/Demo controls are configured below ${icon('arrow-down')}</div>
      </div>
      <div style="font-size:11px;margin-top:8px;">${gridStatsLine}</div>
    </div>
  `;

  els.fuStrategyRows.innerHTML = strategyRowsHtml + gridRowHtml + quantRowHtml;
  // Shown next to "Strategies" in the collapsed <summary> row (see
  // index.html/css/components.css) so collapsing the section to save
  // space doesn't hide which/how many strategies are actually live.
  const totalStrategyCount = STRATEGY_REGISTRY.length + 1;
  if(els.fuStrategiesBadge) els.fuStrategiesBadge.textContent = `${enabledCount}/${totalStrategyCount} enabled`;
}

const STRATEGIES_OPEN_KEY = 'nxtgen_futures_strategies_open_v1';

function initStrategiesCollapse(){
  const details = els.fuStrategiesDetails;
  if(!details) return;
  // Collapsed by default (the whole point of this section — see its own
  // request) unless the user has explicitly left it open before.
  try{ details.open = localStorage.getItem(STRATEGIES_OPEN_KEY) === '1'; }catch(e){ /* ignore — stays collapsed */ }
  details.addEventListener('toggle', () => {
    try{ localStorage.setItem(STRATEGIES_OPEN_KEY, details.open ? '1' : '0'); }catch(e){ /* non-fatal */ }
  });
}

function initStrategySelector(){
  restoreStrategyConfig();
  renderStrategyRows();
  initStrategiesCollapse();
  if(els.fuStrategyRows){
    els.fuStrategyRows.addEventListener('change', (e) => {
      const f = fu();
      if(e.target.classList.contains('fu-strategy-enable')){
        const id = e.target.dataset.id;
        if(id === GRID_STRATEGY.id){
          // Grid's enable flag lives in its own GRID_CONFIG_KEY-backed
          // config (loadGridConfig/saveGridConfig), not f.strategies —
          // different engine, different persisted shape (see grid.js's
          // header comment) — but this checkbox is the same on/off
          // control as the panel's own, just surfaced here too.
          const gridCfg = loadGridConfig();
          gridCfg.enabled = e.target.checked;
          saveGridConfig(gridCfg);
          renderGridPanel();
        } else {
          f.strategies[id] = e.target.checked;
          persistStrategyConfig();
        }
        renderStrategyRows();
      } else if(e.target.classList.contains('fu-quant-setup')){
        const cur = getQuantCardSettings().setups;
        const next = { ...cur, [e.target.dataset.setup]: e.target.checked };
        // At least one setup must stay on, otherwise Quant could never trade and the UI would look "on" while idle.
        if(Object.values(next).some(Boolean)) updateQuantConfig({ setups: next });
        renderStrategyRows();
      } else if(e.target.classList.contains('fu-quant-tf')){
        updateQuantConfig({ entryTimeframe: e.target.value });
        renderStrategyRows();
      } else if(e.target.classList.contains('fu-strategy-rr')){
        if(e.target.dataset.id === QUANT_ID){ updateQuantConfig({ rewardRisk: parseFloat(e.target.value) }); }
        else { f.strategyRR[e.target.dataset.id] = parseFloat(e.target.value); persistStrategyConfig(); }
        renderStrategyRows();
      }
    });
  }
}

// =============================================================
// NxTGen Grid — config panel (7th strategy, kept separate from the
// STRATEGY_REGISTRY rows above — see grid.js's header comment for why
// it's a different engine). This panel persists the settings the spec
// calls for (Grid Mode, Levels, Spacing, Min Grid Profit, Max
// Allocation, Max Leverage, Min Grid Score, Max Daily Loss, Daily
// Profit Target, ATR Multiplier, Breakout Sensitivity, Max Open
// Positions, Emergency Exit / Funding Filter / Liquidity Filter
// toggles) and is what js/backtest-ui.js's NxTGen Grid backtest run
// reads. It intentionally does NOT drive a live/Paper order-execution
// loop yet — this app's Paper mode ticks mockMarket.js and Live/Demo
// places real orders through server.js's exchange integration, and
// wiring the grid engine into either of those (continuous multi-level
// order placement/cancellation, not a single entry/TP/SL) is real
// execution code that needs building and testing against each
// exchange directly, not something to fake here. The badge below says
// so plainly rather than implying it's live when it isn't.
// =============================================================
const GRID_CONFIG_KEY = 'nxtgen_grid_config_v1';

function loadGridConfig(){
  try{
    const raw = localStorage.getItem(GRID_CONFIG_KEY);
    // 'enabled' isn't part of GRID_DEFAULTS (that object is the pure
    // strategy config shared with the backtest path, which has no
    // concept of "on/off" — a backtest run either includes the
    // strategy or doesn't via its own checkbox) — it's a Paper-mode-
    // only switch, so it's defaulted here rather than in grid.js.
    if(!raw) return { ...GRID_DEFAULTS, enabled: false };
    return { ...GRID_DEFAULTS, enabled: false, ...JSON.parse(raw) };
  }catch(e){ return { ...GRID_DEFAULTS, enabled: false }; }
}
function saveGridConfig(cfg){
  try{ localStorage.setItem(GRID_CONFIG_KEY, JSON.stringify(cfg)); }catch(e){ /* non-fatal */ }
}

const GRID_FIELDS = [
  { key: 'mode', label: 'Grid Mode', type: 'select', options: ['AUTO', 'LONG', 'SHORT', 'NEUTRAL'] },
  { key: 'defaultGridLevels', label: 'Grid Levels', type: 'number', min: 5, max: 50 },
  { key: 'minNetProfitPct', label: 'Minimum Grid Profit (%)', type: 'number', step: 0.01, min: 0.05 },
  { key: 'maxLeverage', label: 'Maximum Leverage', type: 'number', min: 1, max: 5 },
  { key: 'minGridScore', label: 'Minimum Grid Score', type: 'number', min: 0, max: 100 },
  { key: 'maxDailyLossPct', label: 'Maximum Daily Loss (%)', type: 'number', min: 0.5, max: 50 },
  { key: 'dailyProfitTargetPct', label: 'Daily Profit Target (%)', type: 'number', min: 1, max: 50 },
  { key: 'breakoutSensitivityAtr', label: 'ATR Multiplier (breakout)', type: 'number', step: 0.1, min: 0.5, max: 4 },
  { key: 'breakoutVolumeMult', label: 'Breakout Sensitivity (vol x)', type: 'number', step: 0.1, min: 1, max: 4 },
  { key: 'maxGridLevels', label: 'Max Open Grid Positions', type: 'number', min: 5, max: 50 },
  { key: 'maxAccountExposurePct', label: 'Max Account Exposure (%)', type: 'number', min: 5, max: 100 },
  { key: 'maxAccountDrawdownPct', label: 'Max Account Drawdown (%)', type: 'number', min: 2, max: 50 },
];
const GRID_TOGGLES = [
  { key: 'emergencyExitOn', label: 'Emergency Exit' },
  { key: 'fundingFilterOn', label: 'Funding Filter' },
  { key: 'liquidityFilterOn', label: 'Liquidity Filter' },
];

function renderGridPanel(){
  if(!els.fuGridPanel) return;
  const cfg = loadGridConfig();
  const f = fu();
  const gridExchange = f.gridLiveExchange;
  const liveExchangeOk = GRID_LIVE_EXCHANGES.includes(gridExchange);
  const gridMode = f.liveModeByExchange[gridExchange] || 'live';
  const gridCred = state.exchangeCreds[gridExchange] && state.exchangeCreds[gridExchange][gridMode];
  const gridCredOk = !!(gridCred && gridCred.apiKey && gridCred.verified);
  els.fuGridPanel.innerHTML = `
    <div class="ov-block" style="margin-top:10px;padding:12px;">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;">
        <div>
          <strong>${GRID_STRATEGY.label}</strong>
          <span style="font-size:11px;color:var(--dim);border:1px solid var(--line);border-radius:6px;padding:1px 6px;margin-left:6px;">Paper + Live/Demo (Bybit/Binance) supported</span>
          <div style="font-size:12px;color:var(--dim);margin-top:6px;line-height:1.5;max-width:640px;">${GRID_STRATEGY.description} Turn it on above in the Strategies list to run it against the synthetic feed, check it as the 7th strategy in Backtesting (Utilities &amp; Tools) for real-historical-data testing, or arm Live/Demo below to scan the watchlist on Bybit or Binance and deploy on whichever symbol presents a valid grid. <strong>Live/Demo is untested against real exchanges — start in Demo and watch it closely before ever arming Live.</strong></div>
          <div style="font-size:12px;color:var(--dim);margin-top:6px;line-height:1.5;max-width:640px;">Deployment size per symbol uses the same <strong>Risk per trade (${f.riskPctPerTrade}%)</strong> control as the six single-entry strategies (the Risk per trade field on this page) — e.g. ${f.riskPctPerTrade}% of a $10,000 balance commits $${(10000 * f.riskPctPerTrade / 100).toLocaleString('en-US')} to a grid deployment, not a separate Grid-only allocation setting. Leverage is capped at ${Math.min(cfg.maxLeverage, 5)}x (your Maximum Leverage setting below, hard-ceilinged at 5x) and a deployment stops opening new grids for the day once your Daily Profit Target below is hit.</div>
        </div>
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:10px;margin-top:12px;">
        ${GRID_FIELDS.map(f => `
          <label style="font-size:11px;color:var(--dim);display:block;">
            ${f.label}
            ${f.type === 'select'
              ? `<select class="grid-cfg-field" data-key="${f.key}" style="width:100%;margin-top:3px;">
                  ${f.options.map(o => `<option value="${o}" ${cfg[f.key] === o ? 'selected' : ''}>${o}</option>`).join('')}
                </select>`
              : `<input class="grid-cfg-field" data-key="${f.key}" type="number" ${f.step ? `step="${f.step}"` : ''} ${f.min != null ? `min="${f.min}"` : ''} ${f.max != null ? `max="${f.max}"` : ''} value="${cfg[f.key]}" style="width:100%;margin-top:3px;">`}
          </label>
        `).join('')}
      </div>
      <div style="display:flex;gap:16px;margin-top:12px;flex-wrap:wrap;">
        ${GRID_TOGGLES.map(t => `
          <label class="toggle-check" style="font-size:12px;">
            <input type="checkbox" class="grid-cfg-toggle" data-key="${t.key}" ${cfg[t.key] ? 'checked' : ''}>
            <span>${t.label}</span>
          </label>
        `).join('')}
      </div>
      <div id="fuGridDashboard" style="margin-top:14px;"></div>

      ${hasLiveControls() ? `
      <div style="margin-top:16px;padding-top:12px;border-top:1px solid var(--line);">
        <strong style="font-size:12.5px;">Live / Demo (Bybit or Binance)</strong>
        <div style="font-size:11.5px;color:var(--dim);margin:4px 0 8px;">
          Grid picks its own exchange here — independent of the Live/Demo exchange selected above for the six single-entry strategies, so running Grid on one doesn't disturb the other. With "Scan watchlist" on (default), it probes a few symbols from the same watchlist as Paper/Backtest each idle cycle and deploys on the first that presents a valid grid setup (long or short side) — no single pinned pair to sit idle in an unsuitable regime. Manages ONE deployment at a time (see the runGridLiveCycle comment in futures-ui.js for why).
          ${liveExchangeOk ? (gridCredOk ? `<span style="color:var(--green);"> Verified ${gridMode} key connected for ${EXCHANGE_DISPLAY_NAMES[gridExchange] || gridExchange}.</span>` : `<span style="color:var(--dim);"> No verified ${gridMode} key for ${EXCHANGE_DISPLAY_NAMES[gridExchange] || gridExchange} yet — connect one in Autotrade &amp; Balances.</span>`) : ''}
        </div>
        <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;">
          <select id="fuGridLiveExchange" style="min-width:110px;" ${f.gridLiveArmed ? 'disabled' : ''}>
            ${GRID_LIVE_EXCHANGES.map(x => `<option value="${x}" ${gridExchange === x ? 'selected' : ''}>${EXCHANGE_DISPLAY_NAMES[x] || x}</option>`).join('')}
          </select>
          <span style="font-size:11px;color:var(--dim);">${gridMode === 'demo' ? 'Demo' : 'Live'} network (set per-exchange in the Live/Demo controls above)</span>
        </div>
        <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:8px;">
          <label class="toggle-check" style="font-size:12px;">
            <input type="checkbox" id="fuGridLiveAutoScan" ${f.gridLiveAutoScan ? 'checked' : ''} ${f.gridLiveArmed ? 'disabled' : ''}>
            <span>Scan watchlist (${GRID_SYMBOLS.length} symbols)</span>
          </label>
          <select id="fuGridLiveSymbol" style="min-width:120px;" ${(!liveExchangeOk || f.gridLiveAutoScan) ? 'disabled' : ''} title="${f.gridLiveAutoScan ? 'Uncheck \'Scan watchlist\' to pin a single symbol' : ''}">
            ${GRID_SYMBOLS.map(s => `<option value="${s}" ${f.gridLiveSymbol === s ? 'selected' : ''}>${s}</option>`).join('')}
          </select>
        </div>
        <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:8px;">
          <button type="button" id="fuGridLiveArmBtn" class="primary ghost" style="font-size:12px;padding:5px 12px;" ${!liveExchangeOk ? 'disabled' : ''}>${f.gridLiveArmed ? 'Armed' : 'Arm'}</button>
          <button type="button" id="fuGridLiveStartBtn" class="primary" style="font-size:12px;padding:5px 12px;" ${!f.gridLiveArmed ? 'disabled' : ''}>${f.gridLiveRunning ? 'Running…' : 'Start'}</button>
          <button type="button" id="fuGridLiveStopBtn" class="primary ghost" style="font-size:12px;padding:5px 12px;" ${!f.gridLiveRunning ? 'disabled' : ''}>Stop</button>
          <button type="button" id="fuGridLiveFlattenBtn" class="primary ghost" style="font-size:12px;padding:5px 12px;">Flatten Now</button>
        </div>
        <div id="fuGridLiveStatus" style="font-size:11.5px;color:var(--dim);margin-top:8px;"></div>
      </div>
      ` : `
      <div style="margin-top:16px;padding-top:12px;border-top:1px solid var(--line);font-size:11.5px;color:var(--dim);">Grid Live/Demo is armed from <a href="/autotrade-futures/#ai-futures-engine">Futures Engine</a>.</div>`}
    </div>
  `;
  renderGridDashboard();
}

// Live-updating dashboard — only touches its own #fuGridDashboard
// sub-container (never the config fields above it), so it can refresh
// every Paper cycle without stealing focus from an input the user is
// mid-edit on. Reads f.gridSession (per-symbol grid state, mutated in
// place by stepGridSymbol every tick) and f.gridTradeHistory (this
// session's closed cycles) — nothing here is fabricated, it's exactly
// the state the running Paper engine is in.
function renderGridDashboard(){
  const host = els.fuGridPanel && els.fuGridPanel.querySelector('#fuGridDashboard');
  if(!host) return;
  const cfg = loadGridConfig();
  const f = fu();

  // --- Live/Demo block (separate capital/session from Paper below —
  // renders whenever there's ANYTHING to show for it, regardless of
  // whether Paper's "Enabled" toggle is on, since Live is armed/started
  // independently via its own controls further down the panel). ---
  const liveHistory = f.gridLiveTradeHistory || [];
  let liveBlock = '';
  if(f.gridLiveRunning || f.gridLiveState || liveHistory.length){
    const gs = f.gridLiveState;
    const liveWins = liveHistory.filter(t => t.netUsd > 0).length;
    const liveNet = liveHistory.reduce((a, t) => a + t.netUsd, 0);
    const liveFees = liveHistory.reduce((a, t) => a + t.feesUsd, 0);
    const liveFunding = liveHistory.reduce((a, t) => a + (t.fundingUsd || 0), 0);
    const liveWinRate = liveHistory.length ? (liveWins / liveHistory.length) * 100 : 0;
    const filled = gs ? gs.levels.filter(l => l.status === 'PENDING_CLOSE').length : 0;
    const resting = gs ? gs.levels.filter(l => l.status === 'PENDING_ENTRY').length : 0;
    liveBlock = `
      <div style="border:1px solid var(--line);border-radius:8px;padding:10px;margin-bottom:12px;">
        <div style="font-size:11.5px;color:var(--dim);margin-bottom:6px;">LIVE/DEMO — ${gs ? gs.plan.symbol : (f.gridLiveAutoScan ? 'scanning watchlist…' : f.gridLiveSymbol)} on ${f.gridLiveExchange} (${f.liveModeByExchange[f.gridLiveExchange] || 'live'}) ${f.gridLiveRunning ? '· running' : '· stopped'}</div>
        <div style="display:flex;gap:18px;flex-wrap:wrap;font-size:12px;margin-bottom:6px;">
          <div><span style="color:var(--dim);">Status</span> <strong>${gs ? 'ACTIVE' : 'No grid'}</strong></div>
          ${gs ? `<div><span style="color:var(--dim);">Grid Score</span> <strong>${gs.plan.gridScore}/100</strong></div>` : ''}
          ${gs ? `<div><span style="color:var(--dim);">Direction</span> <strong>${gs.plan.direction}</strong></div>` : ''}
          ${gs ? `<div><span style="color:var(--dim);">Upper/Lower</span> <strong>${gs.plan.upper.toFixed(4)} / ${gs.plan.lower.toFixed(4)}</strong></div>` : ''}
          ${gs ? `<div><span style="color:var(--dim);">Resting/Filled</span> <strong>${resting}/${filled}</strong></div>` : ''}
          ${gs ? `<div><span style="color:var(--dim);">Grid P&L</span> <strong>${fmtUsd(gs.realizedUsd)}</strong></div>` : ''}
        </div>
        <div style="display:flex;gap:18px;flex-wrap:wrap;font-size:12px;">
          <div><span style="color:var(--dim);">Net P&L</span> <strong>${fmtUsd(liveNet)}</strong></div>
          <div><span style="color:var(--dim);">Win Rate</span> <strong>${liveHistory.length ? liveWinRate.toFixed(1) + '%' : '—'}</strong></div>
          <div><span style="color:var(--dim);">Cycles</span> <strong>${liveHistory.length}</strong></div>
          <div><span style="color:var(--dim);">Fees</span> <strong>-$${liveFees.toFixed(2)}</strong></div>
          <div><span style="color:var(--dim);">Funding</span> <strong>-$${liveFunding.toFixed(2)}</strong></div>
        </div>
      </div>
    `;
  }

  if(!hasPaperControls()){ host.innerHTML = liveBlock; return; } // Paper dashboard belongs to the Utilities & Tools page
  if(!cfg.enabled){
    host.innerHTML = liveBlock + `<div style="font-size:12px;color:var(--dim);padding:8px 0;">Grid Paper trading is OFF. Turn on "${GRID_STRATEGY.label}" above in the Strategies list to start it — it runs alongside the six-strategy Paper engine, not instead of it.</div>`;
    return;
  }
  const session = f.gridSession;
  const history = f.gridTradeHistory || [];
  const wins = history.filter(t => t.netUsd > 0).length;
  const netUsd = history.reduce((a, t) => a + t.netUsd, 0);
  const feesUsd = history.reduce((a, t) => a + t.feesUsd, 0);
  const fundingUsd = history.reduce((a, t) => a + (t.fundingUsd || 0), 0);
  const winRate = history.length ? (wins / history.length) * 100 : 0;
  const equity = session ? session.equity : null;

  const rows = GRID_SYMBOLS.map(symbol => {
    const g = session && session.grids[symbol];
    if(!g){
      // No active grid — show the CURRENT live score/regime for this
      // symbol instead of a generic message, so it's visible that
      // scanning is actually happening and exactly why nothing's
      // opened yet (most often: regime doesn't qualify, or the score is
      // simply short of Minimum Grid Score) rather than it looking like
      // nothing is happening at all.
      const snap = mockMarket.snapshot(symbol);
      if(!snap) return `<tr><td>${symbol}</td><td colspan="7" style="color:var(--dim);">No data yet</td></tr>`;
      const regime = classifyRegime(snap.h1, snap.m15);
      const suitability = scoreGridSuitability(snap, regime, cfg);
      const halted = session && session.dailyHalted;
      const note = halted ? 'Daily halt in effect' : !suitability.regimeOk ? `Regime not grid-suitable` : `Below Minimum Grid Score (${cfg.minGridScore})`;
      return `<tr><td>${symbol}</td><td>${regime.regime}</td><td style="color:var(--dim);">${suitability.score}/100</td><td colspan="5" style="color:var(--dim);">${note}</td></tr>`;
    }
    const gridPnl = g.realizedUsd; // realized only — open legs aren't marked-to-market here, matching the backtest's own realized-only accounting
    return `<tr>
      <td>${symbol}</td><td>${g.regime}</td><td>${g.gridScore}/100</td><td>${g.direction}</td>
      <td>${g.upper.toFixed(4)} / ${g.lower.toFixed(4)}</td><td>${g.levelCount}</td>
      <td>${g.openLegs.length}</td><td>${fmtUsd(gridPnl)}</td>
    </tr>`;
  }).join('');

  host.innerHTML = liveBlock + `
    <div style="font-size:11.5px;color:var(--dim);margin-bottom:6px;">PAPER — synthetic feed, all ${GRID_SYMBOLS.length} symbols</div>
    <div style="display:flex;gap:18px;flex-wrap:wrap;font-size:12px;margin-bottom:8px;">
      <div><span style="color:var(--dim);">Status</span> <strong>ACTIVE</strong></div>
      <div><span style="color:var(--dim);">Grid Equity</span> <strong>${equity != null ? '$' + equity.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—'}</strong></div>
      <div><span style="color:var(--dim);">Net P&L</span> <strong>${fmtUsd(netUsd)}</strong></div>
      <div><span style="color:var(--dim);">Win Rate</span> <strong>${history.length ? winRate.toFixed(1) + '%' : '—'}</strong></div>
      <div><span style="color:var(--dim);">Cycles</span> <strong>${history.length}</strong></div>
      <div><span style="color:var(--dim);">Fees</span> <strong>-$${feesUsd.toFixed(2)}</strong></div>
      <div><span style="color:var(--dim);">Funding</span> <strong>-$${fundingUsd.toFixed(2)}</strong></div>
      <div><span style="color:var(--dim);">Max Drawdown</span> <strong>${session ? session.maxDrawdownPct.toFixed(2) : '0.00'}%</strong></div>
    </div>
    <table style="width:100%;font-size:11.5px;border-collapse:collapse;">
      <thead><tr style="color:var(--dim);text-align:left;">
        <th>Symbol</th><th>Regime</th><th>Grid Score</th><th>Direction</th><th>Upper/Lower</th><th>Levels</th><th>Open</th><th>Grid P&L</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function initGridPanel(){
  if(!els.fuGridPanel) return;
  renderGridPanel();
  els.fuGridPanel.addEventListener('change', (e) => {
    const cfg = loadGridConfig();
    if(e.target.classList.contains('grid-cfg-field')){
      const key = e.target.dataset.key;
      const field = GRID_FIELDS.find(f => f.key === key);
      cfg[key] = field.type === 'number' ? parseFloat(e.target.value) : e.target.value;
      saveGridConfig(cfg);
    } else if(e.target.classList.contains('grid-cfg-toggle')){
      cfg[e.target.dataset.key] = e.target.checked;
      saveGridConfig(cfg);
      // Reflect Paper "Enabled" immediately (dashboard + Strategies
      // badge count) instead of waiting for the next Paper cycle tick,
      // which is what previously made the checkbox feel unresponsive.
      renderGridDashboard();
      renderStrategyRows();
    } else if(e.target.id === 'fuGridLiveSymbol'){
      fu().gridLiveSymbol = e.target.value;
    } else if(e.target.id === 'fuGridLiveAutoScan'){
      fu().gridLiveAutoScan = e.target.checked;
      renderGridPanel();
    } else if(e.target.id === 'fuGridLiveExchange'){
      const f = fu();
      const next = e.target.value;
      if(next !== f.gridLiveExchange){
        f.gridLiveExchange = next;
        // Switching exchanges mid-arm would leave Start/Flatten pointed at
        // credentials for a different account than the one just armed
        // against — disarm (and stop, if running) the same way the
        // six-strategy exchange rows force a fresh arm decision on change.
        if(f.gridLiveArmed){
          if(f.gridLiveRunning) stopGridLive();
          f.gridLiveArmed = false;
        }
        renderGridPanel();
      }
    }
  });
  els.fuGridPanel.addEventListener('click', (e) => {
    const f = fu();
    if(e.target.id === 'fuGridLiveArmBtn'){
      f.gridLiveArmed = !f.gridLiveArmed;
      if(f.gridLiveArmed){ f.gridLivePeakEquity = null; f.gridLiveAccountHalted = false; } // re-arming is the explicit "I've reviewed this" reset
      if(!f.gridLiveArmed && f.gridLiveRunning) stopGridLive();
      renderGridPanel();
    } else if(e.target.id === 'fuGridLiveStartBtn'){
      startGridLive();
    } else if(e.target.id === 'fuGridLiveStopBtn'){
      stopGridLive();
    } else if(e.target.id === 'fuGridLiveFlattenBtn'){
      flattenGridLiveNow();
    }
  });
}

function startGridLive(){
  const f = fu();
  if(!f.gridLiveArmed || f.gridLiveRunning) return;
  if(!GRID_LIVE_EXCHANGES.includes(f.gridLiveExchange)){
    gridLiveLog('Switch this panel\'s exchange selector to Bybit or Binance first.', 'error');
    return;
  }
  f.gridLiveRunning = true;
  gridLiveLog(f.gridLiveAutoScan ? `Starting NxTGen Grid Live/Demo — scanning the watchlist for a deployment…` : `Starting NxTGen Grid Live/Demo on ${f.gridLiveSymbol}…`, null);
  runGridLiveCycle();
  f.gridLiveTimer = setInterval(runGridLiveCycle, LIVE_CYCLE_MS);
  renderGridPanel();
}

function stopGridLive(){
  const f = fu();
  if(f.gridLiveTimer){ clearInterval(f.gridLiveTimer); f.gridLiveTimer = null; }
  f.gridLiveRunning = false;
  gridLiveLog('Stopped. Any resting grid orders/open positions on the exchange are UNCHANGED — use "Flatten Now" to close them, or manage on the exchange directly.', null);
  renderGridPanel();
}

async function flattenGridLiveNow(){
  const f = fu();
  const exchange = f.gridLiveExchange;
  if(!GRID_LIVE_EXCHANGES.includes(exchange)){ gridLiveLog('Switch to Bybit or Binance to flatten.', 'error'); return; }
  const mode = f.liveModeByExchange[exchange] || 'live';
  const cred = liveCred(exchange, mode);
  if(!cred){ gridLiveLog(`No verified ${exchange} ${mode} credential.`, 'error'); return; }
  // Flatten whatever's actually deployed (gridLiveState.plan.symbol) —
  // with auto-scan on, that can differ from the manual dropdown's value.
  // Fall back to the dropdown only if there's no tracked active symbol,
  // so the button still does something sensible if state was lost.
  const symbol = f.gridLiveState ? f.gridLiveState.plan.symbol : f.gridLiveSymbol;
  if(!symbol){ gridLiveLog('No symbol to flatten — nothing tracked as active.', 'error'); return; }
  gridLiveLog(`Flattening ${symbol} on ${exchange}…`, null);
  const proxyArgs = { exchange, mode, apiKey: cred.apiKey, secretKey: cred.secretKey, passphrase: cred.passphrase, symbol };
  let result;
  if(f.gridLiveState && f.gridLiveState.plan.symbol === symbol){
    // Record any still-open legs' estimated P&L the same way an automatic flatten does (see
    // flattenGridLiveAndRecord's header note) — a manual flatten shouldn't be the one path whose losses/gains
    // vanish from the Trade Log. Falls back to the plain flatten call below if a snapshot can't be fetched.
    const snap = await fetchLiveSnapshot(exchange, symbol, '5m').catch(() => null);
    if(snap) result = await flattenGridLiveAndRecord(f, f.gridLiveState, exchange, mode, symbol, proxyArgs, snap, Date.now(), 'MANUAL_FLATTEN');
  }
  if(!result) result = await callProxy('/api/futures/grid/flatten', proxyArgs).catch(err => ({ ok:false, message: err.message }));
  if(result.ok){
    f.gridLiveState = null;
    gridLiveLog(`${symbol} flattened.`, null);
    renderGridDashboard();
  } else {
    gridLiveLog(`Flatten failed: ${result.message}`, 'error');
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
      selectedTradeLogIds.clear(); // a checked row from one range shouldn't silently carry into another
      renderTradeLog();
    });
  });
  if(els.fuLogCustomApply) els.fuLogCustomApply.addEventListener('click', () => {
    tradeLogRange = computeTradeLogRange('custom', els.fuLogCustomFrom?.value, els.fuLogCustomTo?.value);
    selectedTradeLogIds.clear();
    renderTradeLog();
  });

  // Row checkboxes are re-created on every render, so this is delegated
  // on the (static) container rather than bound per-checkbox.
  if(els.fuLogRows) els.fuLogRows.addEventListener('change', (e) => {
    const cb = e.target.closest('.fu-log-select');
    if(!cb) return;
    const id = cb.dataset.id;
    if(cb.checked) selectedTradeLogIds.add(id); else selectedTradeLogIds.delete(id);
    renderTradeLog();
  });
  if(els.fuLogSelectAll) els.fuLogSelectAll.addEventListener('change', () => {
    const rows = currentTradeLogRows();
    if(els.fuLogSelectAll.checked) rows.forEach(t => selectedTradeLogIds.add(t.id));
    else selectedTradeLogIds.clear();
    renderTradeLog();
  });
  if(els.fuLogDeleteBtn) els.fuLogDeleteBtn.addEventListener('click', deleteSelectedTradeLogRows);
  if(els.fuLogExportCsvBtn) els.fuLogExportCsvBtn.addEventListener('click', exportTradeLogCsv);
  if(els.fuLogExportXlsBtn) els.fuLogExportXlsBtn.addEventListener('click', exportTradeLogXls);
  if(els.fuLogExportPdfBtn) els.fuLogExportPdfBtn.addEventListener('click', exportTradeLogPdf);

  tradeLogRange = computeTradeLogRange('today');
  renderTradeLog();
}

// Which strategy produced a trade is already carried on every record (and on
// every tracked open position) as `setupType` — it was only ever surfaced in
// the cross-session Trade Log and its exports, so the session table and the
// Open Position card both showed a trade with no way to tell what opened it.
// Both now name it.
function strategyLabel(setupType){
  return setupType ? String(setupType) : '—';
}

function renderLiveHistory(){
  if(!els.fuLiveHistoryRows) return;
  const history = fu().liveTradeHistory;
  if(!history.length){ els.fuLiveHistoryRows.innerHTML = '<div class="fu-empty">No live/demo trades yet this session.</div>'; return; }
  els.fuLiveHistoryRows.innerHTML = history.slice(0, 50).map(t => `
    <div class="fu-hrow fu-hrow--live ${t.netUsd >= 0 ? 'fu-win' : 'fu-loss'}">
      <div>${t.time}</div>
      <div>${t.exchange || '—'}</div>
      <div>${t.symbol}${tradeSourceBadge(t)}</div>
      <div class="fu-strategy-cell" title="${strategyLabel(t.setupType)}">${strategyLabel(t.setupType)}</div>
      <div>${t.side}${t.partial ? ` (${t.tag})` : ''}</div>
      <div>${t.entry != null ? Number(t.entry).toFixed(4) : '—'}</div>
      <div>${t.exit != null ? Number(t.exit).toFixed(4) : '—'}</div>
      <div>${t.leverage}x</div>
      <div>${t.qty}</div>
      <div>${t.grossUsd != null ? fmtUsd(t.grossUsd) : '—'}</div>
      <div>${t.feesUsd != null ? fmtUsd(t.feesUsd) : '—'}</div>
      <div>${fmtUsd(t.netUsd)}</div>
      <div>${t.durationMin != null ? t.durationMin + 'm' : '—'}</div>
      <div style="font-size:11px;color:var(--dim);">${t.orderId || '—'}</div>
    </div>
  `).join('');
}

// The "why was this approved/rejected" text is plain text from the engine; lines
// it prefixes with '[+] ' / '[-] ' (checklist items) are shown with check / cross
// icons. Everything else is HTML-escaped as-is (the block keeps white-space:pre-wrap).
function explanationHtml(text){
  const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return String(text).split('\n').map(line => {
    if(line.startsWith('[+] ')) return icon('check', 'ex-ok') + ' ' + esc(line.slice(4));
    if(line.startsWith('[-] ')) return icon('x', 'ex-no') + ' ' + esc(line.slice(4));
    return esc(line);
  }).join('\n');
}

// Small inline badge shown next to the symbol in every live trade row —
// a bot icon for a position this app itself placed the entry order for
// (source:'bot'), a warning icon for one it only found and adopted (source:'unknown' —
// see placeLiveEntryOrder's rejection-adoption branch and the broad
// reconciliation block in runLiveCycleInner) so it's visually obvious
// which rows this app is fully responsible for managing (its own TP/SL)
// versus ones it's only watching.
function tradeSourceBadge(t){
  if(t.source === 'bot') return ' <span title="Placed by this bot" style="opacity:.7;">' + icon('bot') + '</span>';
  if(t.source === 'unknown') return ' <span title="Adopted — not placed by this bot" style="opacity:.7;">' + icon('triangle-alert') + '</span>';
  return '';
}

// Persisted so an open real position survives a page reload — see
// LIVE_POSITIONS_KEY's own comment on renderLive() for why.
const LIVE_POSITIONS_KEY = 'nxtgen_futures_live_positions_v1';

function saveLivePositions(){
  try{ localStorage.setItem(LIVE_POSITIONS_KEY, JSON.stringify(fu().livePositions || {})); }
  catch(e){ /* storage full/unavailable — worst case a reload loses tracking, same as before this fix */ }
}

function loadSavedLivePositions(){
  try{
    const raw = localStorage.getItem(LIVE_POSITIONS_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  }catch(e){ return {}; }
}

function clearSavedLivePositions(){
  try{ localStorage.removeItem(LIVE_POSITIONS_KEY); }catch(e){ /* non-fatal */ }
}

function renderLive(){
  const f = fu();
  // f.livePositions itself was previously in-memory only, so a page
  // reload — including one done deliberately to pick up a site fix —
  // silently forgot about a real position still running on the exchange:
  // the Open Position/Real Balance cards would show "None"/stale, and
  // (worse) the close-detection loop above would have nothing telling it
  // that position exists, so it would never get logged when it eventually
  // closes. renderLive() runs after every open/close/cycle, so persisting
  // here keeps this in sync everywhere without scattering save calls
  // through runLiveCycleInner and placeLiveEntryOrder individually.
  saveLivePositions();
  const startEq = f.liveStartingEquity;
  const trades = f.liveTrades;
  const wins = f.liveWins;
  const gross = f.liveGrossPnlUsd;
  const fees = f.liveFeesUsd;
  const net = f.liveNetPnlUsd;
  const usd = n => '$' + n.toLocaleString('en-US', { minimumFractionDigits:2, maximumFractionDigits:2 });
  if(els.fuLiveStartingBalance) els.fuLiveStartingBalance.textContent = startEq != null ? usd(startEq) : '—';
  if(els.fuLiveTrades) els.fuLiveTrades.textContent = String(trades);
  if(els.fuLiveWinRate) els.fuLiveWinRate.textContent = trades ? ((wins / trades) * 100).toFixed(1) + '%' : '—';
  if(els.fuLiveGrossPnl) els.fuLiveGrossPnl.textContent = fmtUsd(gross);
  if(els.fuLiveFees) els.fuLiveFees.textContent = fmtUsd(fees);
  if(els.fuLiveNetPnl) els.fuLiveNetPnl.textContent = fmtUsd(net);
  if(els.fuLiveOpenPosition){
    if(Object.keys(f.livePositions).length === 0) els.fuLiveOpenPosition.textContent = 'None';
  }
  renderLiveCloseButtons();
  renderLiveHistory();
  renderTradeLog();
  renderStrategyRows();
  syncLiveSwitch();
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
  sharedDecayAdaptiveConfidenceBoost(fu());
}

function checkAdaptiveCircuitBreaker(netUsd){
  sharedCheckAdaptiveCircuitBreaker(fu(), netUsd);
}

const EXCHANGE_DISPLAY_NAMES = { bybit: 'Bybit', binance: 'Binance', gateio: 'Gate.io', mexc: 'MEXC', bitget: 'Bitget' };

// The five exchanges used to render as five always-visible rows, which on a
// phone is most of a screen of chrome for a choice that is made once. They now
// render as a collapsed picker: the SELECTED exchange is the visible row (with
// its own Live/Demo toggle still on it, so switching network never costs an
// extra tap), and the other four live behind it until the row is tapped.
// Open/closed is UI-only state, deliberately kept out of `state` — it should
// never persist across a reload or end up in a saved session.
let liveExchListOpen = false;

const CHEVRON_SVG = '<svg class="fu-exch-chevron" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="m6 9 6 6 6-6"/></svg>';

function liveExchangeRowHtml(key, { selected, isCurrent }){
  const f = fu();
  const name = EXCHANGE_DISPLAY_NAMES[key] || key;
  const mode = f.liveModeByExchange[key] || 'live';
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
  const cls = 'fu-live-exch-row' + (selected ? ' selected' : '') + (isCurrent ? ' fu-exch-current' : '');
  const currentAttrs = isCurrent
    ? ` role="button" tabindex="0" aria-expanded="${liveExchListOpen}" aria-controls="fuExchList" aria-label="Selected exchange: ${name}. Activate to choose a different exchange."`
    : ' role="option" aria-selected="false"';
  return `<div class="${cls}" data-exchange="${key}"${currentAttrs}>
    <div class="fu-live-exch-radio"></div>
    <div class="fu-live-exch-label">${name}</div>
    ${modeToggle}
    <div class="fu-live-exch-note" data-verified="${verified ? '1' : '0'}">${statusNote}</div>
    ${isCurrent ? CHEVRON_SVG : ''}
  </div>`;
}

function renderLiveExchangeRows(){
  if(!els.fuLiveExchRows) return;
  const f = fu();
  const current = LIVE_TRADEABLE_EXCHANGES.includes(f.liveExchange)
    ? f.liveExchange
    : LIVE_TRADEABLE_EXCHANGES[0];
  const rest = LIVE_TRADEABLE_EXCHANGES.filter(k => k !== current);
  els.fuLiveExchRows.innerHTML =
    `<div class="fu-exch-select${liveExchListOpen ? ' is-open' : ''}">
      ${liveExchangeRowHtml(current, { selected: f.liveExchange === current, isCurrent: true })}
      <div class="fu-exch-list" id="fuExchList" role="listbox" aria-label="Other exchanges">
        <div class="fu-exch-list-inner">
          ${rest.map(k => liveExchangeRowHtml(k, { selected: false, isCurrent: false })).join('')}
        </div>
      </div>
    </div>`;
}

function setLiveExchListOpen(open){
  liveExchListOpen = open;
  const wrap = els.fuLiveExchRows && els.fuLiveExchRows.querySelector('.fu-exch-select');
  if(!wrap) return;
  wrap.classList.toggle('is-open', open);
  const cur = wrap.querySelector('.fu-exch-current');
  if(cur) cur.setAttribute('aria-expanded', String(open));
}

function initLiveExchangeRows(){
  if(!els.fuLiveExchRows) return;

  els.fuLiveExchRows.addEventListener('click', e => {
    const row = e.target.closest('.fu-live-exch-row');
    if(!row) return;
    const exchange = row.dataset.exchange;
    const f = fu();
    const modeBtn = e.target.closest('.mode-btn[data-mode]');
    const isCurrent = row.classList.contains('fu-exch-current');

    // Tapping the visible (selected) row anywhere except its Live/Demo buttons
    // is what opens and closes the picker.
    if(isCurrent && !modeBtn){ setLiveExchListOpen(!liveExchListOpen); return; }

    const exchangeChanged = f.liveExchange !== exchange;
    const modeChanged = modeBtn && f.liveModeByExchange[exchange] !== modeBtn.dataset.mode;
    if(!exchangeChanged && !modeChanged) return; // clicked the already-selected exchange/mode — nothing to do

    if(modeBtn) f.liveModeByExchange[exchange] = modeBtn.dataset.mode;
    f.liveExchange = exchange;
    liveExchListOpen = false; // a choice was made — collapse back down to the one row
    resetLiveSession(); // re-arming for a different exchange/network is a decision made again, deliberately, every time — see its own comment below
  });

  // Keyboard: the collapsed row is role="button", so Enter/Space must work on it.
  els.fuLiveExchRows.addEventListener('keydown', e => {
    if(e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
    const cur = e.target.closest('.fu-exch-current');
    if(!cur || e.target.closest('.mode-btn')) return;
    e.preventDefault();
    setLiveExchListOpen(!liveExchListOpen);
  });

  els.fuLiveExchRows.addEventListener('keydown', e => {
    if(e.key === 'Escape' && liveExchListOpen) setLiveExchListOpen(false);
  });

  // Tapping anywhere else on the page closes it, the way a select would.
  document.addEventListener('click', e => {
    if(!liveExchListOpen) return;
    if(els.fuLiveExchRows.contains(e.target)) return;
    setLiveExchListOpen(false);
  });
}

function updateLiveModeUI(){
  const f = fu();
  const exchange = f.liveExchange;
  const mode = f.liveModeByExchange[exchange] || 'live';
  const name = EXCHANGE_DISPLAY_NAMES[exchange] || exchange;
  if(els.fuLiveArmWrap) els.fuLiveArmWrap.style.display = '';
  if(!f.liveArmed){
    showLiveMessage(`${name} (${mode === 'live' ? 'Live' : 'Demo'}) selected but not running — turn the switch on to start.`);
  } else {
    showLiveMessage(`Running ${mode === 'live' ? 'LIVE (real funds)' : 'Demo'} trading on ${name}.`);
  }
  syncLiveSwitch();
}

// The ONE Live/Demo control: a switch. ON = armed and scanning in this tab (Auto places orders itself, Manual waits for your
// Execute click); OFF = no new entries. It only runs while this tab is open. An open position always keeps its exchange-side
// SL/TP, and the tab keeps monitoring it until it closes even after the switch goes OFF.
function syncLiveSwitch(){
  const sw = els.fuLiveSwitch;
  if(!sw) return;
  const f = fu();
  const name = EXCHANGE_DISPLAY_NAMES[f.liveExchange] || f.liveExchange;
  const mode = f.liveModeByExchange[f.liveExchange] || 'live';
  sw.checked = !!f.liveArmed;
  if(!els.fuLiveSwitchSub) return;
  const holding = Object.keys(f.livePositions).length > 0;
  let text;
  if(f.liveArmed){
    text = f.liveTradeMode === 'manual'
      ? 'ON — scanning in this tab; signals wait for your Execute click. Keep this tab open.'
      : 'ON — trading automatically while this tab stays open.';
  } else if(holding){
    text = 'OFF — no new entries. Still monitoring the open position (its exchange-side SL/TP stays active); keep this tab open until it closes.';
  } else {
    text = `OFF — turn on to trade ${name} (${mode === 'live' ? 'Live' : 'Demo'}) from this tab.`;
  }
  els.fuLiveSwitchSub.textContent = text;
}

function onLiveSwitchChange(){
  const sw = els.fuLiveSwitch;
  if(!sw) return;
  const f = fu();
  if(!sw.checked){ stopLiveTrading(); return; }
  const exchange = f.liveExchange;
  const mode = LIVE_ONLY_EXCHANGES.includes(exchange) ? 'live' : (f.liveModeByExchange[exchange] || 'live');
  const name = EXCHANGE_DISPLAY_NAMES[exchange] || exchange;
  if(!liveCred(exchange, mode)){
    sw.checked = false;
    showLiveMessage(`No verified ${mode} key for ${name} in this browser — connect and verify one in API Keys first.`, 'error');
    return;
  }
  if(mode === 'live' && !window.confirm(`Start LIVE trading on ${name} with REAL funds?\n\nReal orders will be placed from this tab while it stays open.`)){
    sw.checked = false;
    return;
  }
  f.liveArmed = true;
  if(!f.liveRunning) toggleLiveRunning();
  updateLiveModeUI();
  renderLive();
}

function stopLiveTrading(){
  const f = fu();
  f.liveArmed = false;
  f.livePendingSignal = null;
  renderLivePendingSignal();
  // Nothing open -> stop scanning now. With an open position the loop keeps monitoring it (closure detection, breakeven
  // move, logging) and stops itself once it has closed (see onDisarmedIdle in buildBrowserLiveAdapter).
  if(f.liveRunning && Object.keys(f.livePositions).length === 0) toggleLiveRunning();
  updateLiveModeUI();
  renderLive();
}

// =============================================================
// Fast price tick — a lightweight, unauthenticated interpolation between
// the heavier 8s runLiveCycle polls (which hit the exchange's SIGNED
// position endpoint and are the authoritative source for open/closed and
// the real uPnL number). This tick only reads the PUBLIC market snapshot
// (already server-cached for 15s — see getFuturesSnapshotCached in
// server.js — so ticking every 2s here does NOT mean hitting the
// exchange itself every 2s) for whichever symbol(s) are currently
// tracked as open, and recomputes an approximate uPnL client-side from
// entry/qty. It never touches signed credentials, never decides a
// position has closed, and never overrides stopLossPrice/tp*Price — the
// next runLiveCycle poll always overwrites this tick's numbers with the
// exchange's own real figures, so a missed or slightly-stale tick here
// is cosmetic, not a correctness risk.
const FAST_TICK_MS = 2000;
let fastTickTimer = null;

// Latest mark price / unrealised P&L per symbol, from the public snapshot. Kept so renderLive() (which repaints on every
// server status refresh) can show them instead of blanking the live P&L between ticks.
let liveMarks = {};

// Positions to keep a live mark on: the ones this tab tracks.
function positionsForTick(){
  return Object.entries(fu().livePositions);
}

function openPositionText(exchange, symbol, p){
  const m = liveMarks[symbol];
  return `[${exchange}] ${symbol} ${p.side} ${p.qty || 0} @ ${p.entry}` +
         (m ? ` — mark ${m.price} (uPnL ${fmtUsd(m.uPnl)})` : '') +
         (p.setupType ? ` · ${p.setupType}` : '');
}

async function runFastTick(){
  const entries = positionsForTick();
  if(entries.length === 0) return;
  for(const [symbol, tracked] of entries){
    try{
      const snap = await fetchLiveSnapshot(tracked.exchange, symbol);
      const price = snap && snap.price;
      if(price == null || !tracked.entry) continue;
      const qty = tracked.qty || 0;
      const uPnl = tracked.side === 'Buy' ? (price - tracked.entry) * qty : (tracked.entry - price) * qty;
      liveMarks[symbol] = { price, uPnl };
      if(els.fuLiveOpenPosition){
        els.fuLiveOpenPosition.textContent = entries.map(([sym, p]) => openPositionText(p.exchange, sym, p)).join(' · ');
      }
    }catch(err){ /* a missed tick just leaves the last-known number showing until the next tick or the next real 8s poll — harmless */ }
  }
}

function startFastTick(){
  if(fastTickTimer) return; // already running — toggleLiveRunning can't double-start this
  fastTickTimer = setInterval(runFastTick, FAST_TICK_MS);
}

function stopFastTick(){
  if(fastTickTimer){ clearInterval(fastTickTimer); fastTickTimer = null; }
}

function toggleLiveRunning(){
  const f = fu();
  f.liveRunning = !f.liveRunning;
  if(f.liveRunning){
    runLiveCycle();
    f.liveTimer = setInterval(runLiveCycle, LIVE_CYCLE_MS);
    startFastTick();
  } else {
    clearInterval(f.liveTimer);
    f.liveTimer = null;
    stopFastTick();
    liveMarks = {};
  }
  syncLiveSwitch();
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
  f.liveOrderFailUntilBySymbol = {};
  f.liveConsecutiveLosses = 0;
  f.livePausedByCircuitBreaker = false;
  f.liveAdaptiveConfidenceBoost = 0;
  f.livePendingSignal = null;
  renderLiveExchangeRows();
  renderLivePendingSignal();
  updateLiveModeUI();
  renderLive();
}

function initLiveTradingControls(){
  initLiveExchangeRows();
  if(els.fuLiveSwitch) els.fuLiveSwitch.addEventListener('change', onLiveSwitchChange);
  // Delegated once from the row itself, since renderLiveCloseButtons()
  // rebuilds the buttons' innerHTML on every render (open/close/cycle) —
  // binding individual listeners there would mean rebinding (or leaking)
  // one per render instead of a single listener that survives it.
  if(els.fuLiveCloseRow){
    els.fuLiveCloseRow.addEventListener('click', (e) => {
      const btn = e.target.closest('.fu-close-pos-btn');
      if(!btn || btn.disabled) return;
      closeLivePosition(btn.dataset.symbol);
    });
  }
  // Browsers throttle setInterval heavily in a backgrounded tab (often to
  // ~once/minute) — so a position closing (or a TP2 breakeven move) while
  // this tab is out of focus can sit un-reflected in the Real Balance card
  // and Trade Log for a while, looking exactly like "doesn't update until
  // I refresh" even though the underlying polling loop is still running.
  // Firing one cycle immediately the moment the tab becomes visible again
  // closes that gap without waiting for the throttled timer to catch up.
  document.addEventListener('visibilitychange', () => {
    if(document.visibilityState === 'visible' && fu().liveRunning) runLiveCycle();
  });
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
  syncLiveSwitch(); // the switch's caption differs between Auto and Manual
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
  const clamped = Math.min(RISK_DEFAULTS.maxRiskPctPerTrade, Math.max(0.25, Number(rawValue) || 1.0));
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

// User-configurable "stop placing new entries for the rest of the session
// once this much real profit is banked" — same mechanism as
// RISK_DEFAULTS.dailyProfitTargetPct (noTradeEngine.js), just exposed as
// a field instead of a fixed 10% everyone was stuck with. Hard-capped at
// 50% of the selected exchange's account size for the session, per an
// explicit request — never lets the field itself push the bot past that,
// regardless of what's typed in. Open positions already running still
// exit via their own TP/SL as normal; this only blocks NEW entries, and
// is unrelated to (and does not cause) any stop tied to losses — see
// checkAdaptiveCircuitBreaker's own comment for why that no longer
// exists at all.
const LIVE_DAILY_PROFIT_TARGET_MAX_PCT = 50;
function initLiveDailyProfitTargetInput(){
  const f = fu();
  if(f.liveDailyProfitTargetPct == null) f.liveDailyProfitTargetPct = RISK_DEFAULTS.dailyProfitTargetPct;
  if(els.fuLiveDailyProfitTargetPct){
    els.fuLiveDailyProfitTargetPct.value = f.liveDailyProfitTargetPct;
    els.fuLiveDailyProfitTargetPct.addEventListener('input', () => {
      const clamped = Math.min(LIVE_DAILY_PROFIT_TARGET_MAX_PCT, Math.max(1, Number(els.fuLiveDailyProfitTargetPct.value) || RISK_DEFAULTS.dailyProfitTargetPct));
      f.liveDailyProfitTargetPct = clamped;
      els.fuLiveDailyProfitTargetPct.value = clamped;
    });
  }
}

// Same idea as the profit target above, for the other side: how much real
// loss (as a % of the session's starting balance) is allowed before new
// entries stop for the rest of the session — was a fixed, non-configurable
// RISK_DEFAULTS.maxDailyLossPct (2%) until now. This is what actually
// produces the "still scanning, never placing anything" state once
// tripped (see evaluateNoTradeFilters, noTradeEngine.js) — the bot stays
// armed and keeps polling every cycle, it just gets "Daily drawdown limit
// reached" on every signal until Reset Session or the next day. Clamped
// 0.5-50% — raised from the original 15% ceiling on explicit request. This
// field's own ceiling was deliberately kept separate from Risk per Trade's
// (RISK_DEFAULTS.maxRiskPctPerTrade, now 80% — see risk.js) rather than
// re-linked to it, since the two control different things and there's no
// requirement they move together. Worth being clear-eyed about what that
// means: with Risk per Trade set high (up to its own 80% ceiling, see
// initLiveRiskPerTradeInput/RISK_DEFAULTS.maxRiskPctPerTrade), a single
// losing trade — or just a couple — could reach a 50%-set daily loss limit
// before this gate ever stops anything, since the two settings aren't
// linked to each other. This field controls how much loss is ALLOWED
// before this specific stop-for-the-day gate fires — it doesn't limit
// position sizing itself, and setting it to 50% only removes this
// particular backstop, not any other risk control (per-trade sizing,
// liquidation-safety check, max simultaneous positions) still in place
// elsewhere in this pipeline.
const LIVE_MAX_DAILY_LOSS_MAX_PCT = 50;
// Live/Demo's own default (10%) — deliberately its own constant rather than
// RISK_DEFAULTS.maxDailyLossPct (2%): Paper has no field of its own for this
// and falls back straight to that constant (see noTradeEngine.js), so
// changing Live/Demo's default here can never move Paper's.
const LIVE_MAX_DAILY_LOSS_DEFAULT_PCT = 10;
function initLiveMaxDailyLossInput(){
  const f = fu();
  if(f.liveMaxDailyLossPct == null) f.liveMaxDailyLossPct = LIVE_MAX_DAILY_LOSS_DEFAULT_PCT;
  if(els.fuLiveMaxDailyLossPct){
    els.fuLiveMaxDailyLossPct.value = f.liveMaxDailyLossPct;
    els.fuLiveMaxDailyLossPct.addEventListener('input', () => {
      const clamped = Math.min(LIVE_MAX_DAILY_LOSS_MAX_PCT, Math.max(0.5, Number(els.fuLiveMaxDailyLossPct.value) || LIVE_MAX_DAILY_LOSS_DEFAULT_PCT));
      f.liveMaxDailyLossPct = clamped;
      els.fuLiveMaxDailyLossPct.value = clamped;
    });
  }
}

// Which candle size real Live/Demo trades are evaluated against — LOCKED
// to 5m everywhere (Paper, Backtest, Live/Demo all trade the same 5m
// candle now — see setups.js's Breakout+Retest/Range Reversal comments
// and server.js's resolveSnapshotTimeframe). This used to be a real
// dropdown (fuLiveTimeframe, 3m/5m/15m/30m/1h); it's now fixed so the
// UI can't drift out of sync with the rest of the app. f.liveTimeframe is
// still set (kept for any code elsewhere that reads it) but is no longer
// user-adjustable, and the field itself is disabled in the markup.
function initLiveTimeframeInput(){
  const f = fu();
  f.liveTimeframe = '5m';
  if(els.fuLiveTimeframe){
    els.fuLiveTimeframe.value = '5m';
    els.fuLiveTimeframe.disabled = true;
  }
}

// =============================================================
// Trading Bots — user-CREATED Futures Grid + DCA bots. Bybit/Binance,
// Live/Demo only, real orders. Deliberately separate from NxTGen Grid
// above: that's one auto-scanning strategy with its own Grid Score gate;
// these are bots the person configures directly (price range, safety
// orders, investment, etc — like a manual grid/DCA bot creator) and
// several can run side by side, each on its own symbol/exchange. No
// Paper/backtest path for these yet — see dca.js's header comment for
// why that's a deliberate, statable scope choice rather than an
// oversight.
// =============================================================
const TRADING_BOT_TYPES = { grid: 'Futures Grid', dca: 'DCA' };
const TRADING_BOTS_CYCLE_MS = 8000; // same conservative real-API cadence as NxTGen Grid Live/Demo

function newTradingBotId(type){ return `BOT-${type.toUpperCase()}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`; }

function tradingBotLog(bot, msg, isError){
  bot.statusMessage = msg;
  bot.statusIsError = !!isError;
  renderTradingBotsList();
}

function renderTradingBotsCreate(){
  if(!els.fuTradingBotsCreate) return;
  const f = fu();
  rollTradingBotsDay(Date.now());
  const type = f.tbCreateType || 'grid';
  const exchange = f.tbCreateExchange || 'bybit';
  const mode = f.liveModeByExchange[exchange] || 'live';
  const isAutoScan = type === 'grid' && f.tbGridForm?.autoScan;
  els.fuTradingBotsCreate.innerHTML = `
    <div id="tbDailyLimitsBar"></div>
    <div class="ov-block" id="tbCreateFormBlock" style="padding:12px;margin-bottom:12px;">
      <div style="display:flex;gap:16px;flex-wrap:wrap;margin-bottom:10px;">
        <label style="font-size:11px;color:var(--dim);">Bot Type
          <select id="tbType" style="display:block;margin-top:3px;min-width:140px;">
            ${Object.entries(TRADING_BOT_TYPES).map(([k, v]) => `<option value="${k}" ${type === k ? 'selected' : ''}>${v}</option>`).join('')}
          </select>
        </label>
        <label style="font-size:11px;color:var(--dim);">Exchange
          <select id="tbExchange" style="display:block;margin-top:3px;min-width:110px;">
            ${GRID_LIVE_EXCHANGES.map(x => `<option value="${x}" ${exchange === x ? 'selected' : ''}>${EXCHANGE_DISPLAY_NAMES[x] || x}</option>`).join('')}
          </select>
        </label>
        <div style="align-self:flex-end;" title="${f.tbAutoScanEnabled ? 'Stop Auto-Scan to change the network' : 'Network used for new bots on this exchange. Live places real orders.'}">
          <div style="font-size:11px;color:var(--dim);margin-bottom:3px;">Network</div>
          <div class="mode-toggle" role="group" aria-label="${exchange} network">
            <button type="button" class="mode-btn tb-mode-btn ${mode === 'live' ? 'active' : ''}" data-mode="live" ${f.tbAutoScanEnabled ? 'disabled' : ''}>Live</button>
            <button type="button" class="mode-btn tb-mode-btn ${mode === 'demo' ? 'active' : ''}" data-mode="demo" ${f.tbAutoScanEnabled ? 'disabled' : ''}>Demo</button>
          </div>
        </div>
        ${isAutoScan ? '' : `
        <label style="font-size:11px;color:var(--dim);">Symbol
          <input id="tbSymbol" type="text" placeholder="e.g. AVAXUSDT" value="${f.tbCreateSymbol || ''}" style="display:block;margin-top:3px;min-width:130px;text-transform:uppercase;">
        </label>`}
      </div>
      <div id="tbTypeFields"></div>
      <div id="tbCreateStatus" style="font-size:11.5px;color:var(--dim);margin-top:8px;"></div>
      <button type="button" id="tbCreateBtn" class="primary" style="font-size:12px;padding:6px 16px;margin-top:10px;">${isAutoScan ? (f.tbAutoScanEnabled ? 'Stop Auto-Scan' : 'Start Auto-Scan') : 'Create Now'}</button>
    </div>
  `;
  renderTradingBotTypeFields();
  renderTradingBotsDailyLimits();
}

// Refreshes ONLY the daily-limits banner (target %, today's progress,
// paused state) — deliberately separate from renderTradingBotsCreate so
// updating it (which happens mid-deploy, every cycle, and on every
// realized close) never wipes out whatever the person is mid-typing in
// the create form below it.
function renderTradingBotsDailyLimits(){
  const host = document.getElementById('tbDailyLimitsBar');
  if(!host) return;
  const f = fu();
  const dayPct = f.tbDayAnchorInvestmentUsd > 0 ? (f.tbDayRealizedUsd / f.tbDayAnchorInvestmentUsd) * 100 : 0;
  host.innerHTML = `
    <div class="ov-block" style="padding:12px;margin-bottom:12px;">
      <strong style="font-size:12.5px;">Daily Risk Limits — ALL Trading Bots combined</strong>
      <div style="font-size:11px;color:var(--dim);margin:4px 0 8px;line-height:1.5;">
        Tracked against the total invested across every bot created today (currently ${fmtUsd(f.tbDayAnchorInvestmentUsd)}). The moment either limit is hit, EVERY active bot is force-stopped — no matter what any single bot's own state looks like — and no new bot can be created until the next calendar day.
      </div>
      <div style="display:flex;gap:16px;flex-wrap:wrap;align-items:flex-end;">
        <label style="font-size:11px;color:var(--dim);">Daily Profit Target (%)
          <input id="tbDailyProfitTarget" type="number" min="0.5" step="any" value="${f.tbDailyProfitTargetPct}" style="display:block;margin-top:3px;min-width:100px;">
        </label>
        <label style="font-size:11px;color:var(--dim);">Daily Max Loss (%)
          <input id="tbDailyMaxLoss" type="number" min="0.5" step="any" value="${f.tbDailyMaxLossPct}" style="display:block;margin-top:3px;min-width:100px;">
        </label>
        <div style="font-size:12px;">Today: <strong style="color:${dayPct >= 0 ? 'var(--green)' : 'var(--red)'};">${dayPct >= 0 ? '+' : ''}${dayPct.toFixed(2)}%</strong> (${fmtUsd(f.tbDayRealizedUsd)} realized)</div>
      </div>
      ${f.tbDailyHalted ? `<div style="margin-top:8px;font-size:12px;color:var(--red);border:1px solid var(--red);border-radius:6px;padding:6px 10px;">${icon('pause')} PAUSED for today: ${f.tbDailyHaltMessage || 'daily limit reached'} — resumes automatically at the next UTC day rollover.</div>` : ''}
    </div>
  `;
  const formBlock = document.getElementById('tbCreateFormBlock');
  if(formBlock){
    formBlock.style.opacity = f.tbDailyHalted ? '.5' : '';
    ['tbType', 'tbExchange', 'tbSymbol', 'tbCreateBtn'].forEach(id => {
      const el = document.getElementById(id);
      if(el) el.disabled = !!f.tbDailyHalted;
    });
  }
}

function renderTradingBotTypeFields(){
  const host = document.getElementById('tbTypeFields');
  if(!host) return;
  const f = fu();
  const type = f.tbCreateType || 'grid';
  if(type === 'grid'){
    const cfg = f.tbGridForm || (f.tbGridForm = { autoScan: false, direction: 'NEUTRAL', upper: '', lower: '', levelCount: 10, leverage: 5, investmentUsd: 100, investmentMode: 'usdt', investmentPct: 50, maxLossPct: 20, profitTargetPct: '', maxConcurrent: 4, minGridScore: 65 });
    // Investment can be a flat USDT figure (as before) OR a % of your
    // real, current free margin on the exchange — resolved fresh against
    // live available balance at the moment each bot actually deploys, not
    // frozen at whatever balance existed when you typed the %. That's what
    // makes it self-adjusting: it naturally shrinks while other bots have
    // margin locked up, and grows again the moment one closes or you add
    // funds, instead of you having to keep retyping a USDT number.
    const investmentField = cfg.investmentMode === 'pct' ? `
          <label style="font-size:11px;color:var(--dim);">${cfg.autoScan ? 'Total Budget' : 'Investment'} (% of free balance)
            <div style="display:flex;align-items:center;gap:8px;margin-top:3px;min-width:170px;">
              <input id="tbGridInvestmentPctRange" type="range" min="1" max="95" step="1" value="${cfg.investmentPct}" style="flex:1;">
              <input id="tbGridInvestmentPct" type="number" min="1" max="95" step="1" value="${cfg.investmentPct}" style="width:54px;">
            </div>
          </label>` : `
          <label style="font-size:11px;color:var(--dim);">${cfg.autoScan ? 'Total Budget (USDT)' : 'Total Investment (USDT)'}
            <input id="tbGridInvestment" type="number" min="1" step="any" value="${cfg.investmentUsd}" style="display:block;margin-top:3px;min-width:120px;">
          </label>`;
    const investmentModeToggle = `
          <label style="font-size:11px;color:var(--dim);">Sizing
            <div style="display:flex;gap:6px;margin-top:3px;">
              ${[['usdt', 'Fixed USDT'], ['pct', '% of balance']].map(([m, label]) => `<button type="button" class="primary ${cfg.investmentMode === m ? '' : 'ghost'} tb-grid-invmode" data-invmode="${m}" style="font-size:11px;padding:4px 10px;">${label}</button>`).join('')}
            </div>
          </label>`;
    host.innerHTML = `
      <div style="display:flex;gap:10px;margin-bottom:10px;">
        ${[['manual', 'Manual'], ['auto', 'Auto-Scan Watchlist']].map(([m, label]) => `<button type="button" class="primary ${(cfg.autoScan ? 'auto' : 'manual') === m ? '' : 'ghost'} tb-grid-mode" data-mode="${m}" style="font-size:12px;padding:5px 14px;">${label}</button>`).join('')}
      </div>
      ${cfg.autoScan ? `
        <div style="font-size:11px;color:var(--dim);margin-bottom:8px;line-height:1.5;">
          Scans the same ${GRID_SYMBOLS.length}-symbol watchlist NxTGen Grid uses, a few at a time each cycle, and deploys a NEW bot — always Neutral (holds both sides) — the moment a symbol clears Minimum Grid Score. Keeps doing this, up to Max Concurrent Auto Bots, until you hit Stop Auto-Scan. Total Budget is split evenly across Max Concurrent Auto Bots (e.g. 150 USDT budget ÷ 4 max bots = ~37.50 USDT margin per bot, whether 1 or all 4 slots end up filled) — and each deployment is checked against your real, current exchange free margin right before it places any orders, so a bot is skipped for that cycle (not force-deployed, and never left half-created in an Error state) if there genuinely isn't enough free margin for it yet — it'll pick back up on its own once margin frees up, from a bot closing or a deposit.
        </div>
        <div style="display:flex;gap:16px;flex-wrap:wrap;align-items:flex-end;">
          ${investmentModeToggle}
          ${investmentField}
          <label style="font-size:11px;color:var(--dim);">Leverage
            <input id="tbGridLeverage" type="number" min="1" max="50" step="1" value="${cfg.leverage}" style="display:block;margin-top:3px;min-width:80px;">
          </label>
          <label style="font-size:11px;color:var(--dim);">Grids
            <input id="tbGridLevels" type="number" min="2" max="150" step="1" value="${cfg.levelCount}" style="display:block;margin-top:3px;min-width:80px;">
          </label>
          <label style="font-size:11px;color:var(--dim);">Max Loss (%, per bot)
            <input id="tbGridMaxLoss" type="number" min="1" step="any" value="${cfg.maxLossPct}" style="display:block;margin-top:3px;min-width:100px;">
          </label>
          <label style="font-size:11px;color:var(--dim);">Profit Target (%, per bot, optional)
            <input id="tbGridProfitTarget" type="number" min="0.5" step="any" value="${cfg.profitTargetPct}" placeholder="none" style="display:block;margin-top:3px;min-width:130px;">
          </label>
          <label style="font-size:11px;color:var(--dim);">Minimum Grid Score
            <input id="tbGridMinScore" type="number" min="1" max="100" step="1" value="${cfg.minGridScore}" style="display:block;margin-top:3px;min-width:100px;">
          </label>
          <label style="font-size:11px;color:var(--dim);">Max Concurrent Auto Bots
            <input id="tbGridMaxConcurrent" type="number" min="1" max="20" step="1" value="${cfg.maxConcurrent}" style="display:block;margin-top:3px;min-width:100px;">
          </label>
        </div>
        <div id="tbAutoScanStatus" style="font-size:11.5px;color:var(--dim);margin-top:10px;"></div>
      ` : `
      <div style="display:flex;gap:10px;margin-bottom:10px;">
        ${['NEUTRAL', 'LONG', 'SHORT'].map(d => `<button type="button" class="primary ${cfg.direction === d ? '' : 'ghost'} tb-grid-direction" data-dir="${d}" style="font-size:12px;padding:5px 14px;">${d === 'NEUTRAL' ? 'Neutral' : d === 'LONG' ? 'Long' : 'Short'}</button>`).join('')}
      </div>
      <div style="display:flex;gap:16px;flex-wrap:wrap;align-items:flex-end;">
        <label style="font-size:11px;color:var(--dim);">Price Range (lower)
          <input id="tbGridLower" type="number" step="any" value="${cfg.lower}" style="display:block;margin-top:3px;min-width:110px;">
        </label>
        <label style="font-size:11px;color:var(--dim);">Price Range (upper)
          <input id="tbGridUpper" type="number" step="any" value="${cfg.upper}" style="display:block;margin-top:3px;min-width:110px;">
        </label>
        <button type="button" id="tbGridSmartFill" class="primary ghost" style="font-size:11px;padding:5px 10px;">Smart Fill</button>
        <label style="font-size:11px;color:var(--dim);">Grids
          <input id="tbGridLevels" type="number" min="2" max="150" step="1" value="${cfg.levelCount}" style="display:block;margin-top:3px;min-width:80px;">
        </label>
        <label style="font-size:11px;color:var(--dim);">Leverage
          <input id="tbGridLeverage" type="number" min="1" max="50" step="1" value="${cfg.leverage}" style="display:block;margin-top:3px;min-width:80px;">
        </label>
        ${investmentModeToggle}
        ${investmentField}
        <label style="font-size:11px;color:var(--dim);">Max Loss (%, this bot)
          <input id="tbGridMaxLoss" type="number" min="1" step="any" value="${cfg.maxLossPct}" style="display:block;margin-top:3px;min-width:100px;">
        </label>
        <label style="font-size:11px;color:var(--dim);">Profit Target (%, this bot, optional)
          <input id="tbGridProfitTarget" type="number" min="0.5" step="any" value="${cfg.profitTargetPct}" placeholder="none" style="display:block;margin-top:3px;min-width:130px;">
        </label>
      </div>
      <div style="font-size:11px;color:var(--dim);margin-top:6px;">Max Loss auto-flattens THIS bot once its own realized losses reach that % of its investment. Profit Target (optional) auto-flattens it once its own realized profit reaches that % — leave blank to let it keep cycling until you stop it or the cross-bot daily target above is hit.</div>
      `}
      <div style="font-size:11px;color:var(--dim);margin-top:8px;">Neutral holds a long AND short leg at once (needs Bybit/Binance hedge mode — this bot switches it on for you on Bybit; on Binance it's account-wide, so you'll be asked to switch it yourself once). Long/Short only takes one side.</div>
      <div style="margin-top:14px;padding-top:12px;border-top:1px solid var(--line-soft);">
        <div style="font-size:11px;color:var(--dim);margin-bottom:8px;line-height:1.5;">
          Backtests THIS Trading Bots grid code specifically (breakout / drift-recalculation / liquidation-buffer / your own Max Loss &amp; Profit Target above) against real historical candles — not NxTGen Grid's separate, more-gated engine. ${cfg.autoScan ? `Uses ${cfg.minGridScore}/100 as the redeploy gate, matching Auto-Scan.` : `Manual mode has no score gate, so this deploys as soon as a valid range exists — set a Minimum Grid Score below to approximate how Auto-Scan would have behaved instead.`}
          Backtest-only for now: live Trading Bots Grid still runs on 5m (its breakout/regime context is fetched at fixed 15m/1h alongside it — picking anything but 5m live would mismatch that context, not just change granularity, so it isn't offered as a live option yet).
        </div>
        <div style="display:flex;gap:12px;flex-wrap:wrap;align-items:flex-end;">
          <label style="font-size:11px;color:var(--dim);">Symbol
            <select id="tbBtSymbol" style="display:block;margin-top:3px;min-width:120px;">${GRID_SYMBOLS.map(s => `<option value="${s}" ${(f.tbBacktestSymbol || GRID_SYMBOLS[0]) === s ? 'selected' : ''}>${s}</option>`).join('')}</select>
          </label>
          <label style="font-size:11px;color:var(--dim);">Timeframe
            <select id="tbBtTimeframe" style="display:block;margin-top:3px;min-width:80px;">${['3m', '5m', '15m', '30m', '1h'].map(tfOpt => `<option value="${tfOpt}" ${(f.tbBacktestTimeframe || '5m') === tfOpt ? 'selected' : ''}>${tfOpt}</option>`).join('')}</select>
          </label>
          <label style="font-size:11px;color:var(--dim);">Days
            <input id="tbBtDays" type="number" min="3" max="180" step="1" value="${f.tbBacktestDays || 30}" style="display:block;margin-top:3px;min-width:70px;">
          </label>
          ${!cfg.autoScan ? `
          <label style="font-size:11px;color:var(--dim);">Minimum Grid Score (redeploy gate)
            <input id="tbBtMinScore" type="number" min="0" max="100" step="1" value="${f.tbBacktestMinScore ?? 0}" style="display:block;margin-top:3px;min-width:90px;">
          </label>` : ''}
          <button type="button" id="tbBtRunBtn" class="primary ghost" style="font-size:12px;padding:6px 14px;">Run Backtest</button>
        </div>
        <div id="tbBacktestResult" style="font-size:12px;margin-top:10px;"></div>
      </div>
    `;
  } else {
    const cfg = f.tbDcaForm || (f.tbDcaForm = { direction: 'LONG', baseOrderUsd: DCA_DEFAULTS.baseOrderUsd, safetyOrderUsd: DCA_DEFAULTS.safetyOrderUsd, maxSafetyOrders: DCA_DEFAULTS.maxSafetyOrders, priceDeviationPct: DCA_DEFAULTS.priceDeviationPct, stepScale: DCA_DEFAULTS.stepScale, volumeScale: DCA_DEFAULTS.volumeScale, takeProfitPct: DCA_DEFAULTS.takeProfitPct, stopLossPct: '', leverage: DCA_DEFAULTS.leverage });
    host.innerHTML = `
      <div style="display:flex;gap:10px;margin-bottom:10px;">
        ${['LONG', 'SHORT'].map(d => `<button type="button" class="primary ${cfg.direction === d ? '' : 'ghost'} tb-dca-direction" data-dir="${d}" style="font-size:12px;padding:5px 14px;">${d === 'LONG' ? 'Long' : 'Short'}</button>`).join('')}
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px;">
        <label style="font-size:11px;color:var(--dim);">Base Order (USDT)<input id="tbDcaBase" type="number" min="1" step="any" value="${cfg.baseOrderUsd}" style="display:block;margin-top:3px;width:100%;"></label>
        <label style="font-size:11px;color:var(--dim);">Safety Order (USDT)<input id="tbDcaSafety" type="number" min="1" step="any" value="${cfg.safetyOrderUsd}" style="display:block;margin-top:3px;width:100%;"></label>
        <label style="font-size:11px;color:var(--dim);">Max Safety Orders<input id="tbDcaMaxSafety" type="number" min="0" max="10" step="1" value="${cfg.maxSafetyOrders}" style="display:block;margin-top:3px;width:100%;"></label>
        <label style="font-size:11px;color:var(--dim);">Price Deviation (%)<input id="tbDcaDeviation" type="number" min="0.1" step="any" value="${cfg.priceDeviationPct}" style="display:block;margin-top:3px;width:100%;"></label>
        <label style="font-size:11px;color:var(--dim);">Step Scale<input id="tbDcaStepScale" type="number" min="1" step="any" value="${cfg.stepScale}" style="display:block;margin-top:3px;width:100%;"></label>
        <label style="font-size:11px;color:var(--dim);">Volume Scale<input id="tbDcaVolScale" type="number" min="1" step="any" value="${cfg.volumeScale}" style="display:block;margin-top:3px;width:100%;"></label>
        <label style="font-size:11px;color:var(--dim);">Take Profit (%)<input id="tbDcaTp" type="number" min="0.1" step="any" value="${cfg.takeProfitPct}" style="display:block;margin-top:3px;width:100%;"></label>
        <label style="font-size:11px;color:var(--dim);">Stop Loss (%, optional)<input id="tbDcaSl" type="number" min="0" step="any" value="${cfg.stopLossPct}" placeholder="none" style="display:block;margin-top:3px;width:100%;"></label>
        <label style="font-size:11px;color:var(--dim);">Leverage<input id="tbDcaLeverage" type="number" min="1" max="50" step="1" value="${cfg.leverage}" style="display:block;margin-top:3px;width:100%;"></label>
      </div>
      <div style="font-size:11px;color:var(--dim);margin-top:8px;">One-way position — needs Bybit/Binance in ONE-WAY (not hedge) mode for this symbol. If NxTGen Grid ran Live on it before, switch that symbol back to one-way first (Bybit) or your whole account back to one-way (Binance, account-wide).</div>
    `;
  }
}

function readTradingBotFormNumbers(){
  const f = fu();
  const type = f.tbCreateType || 'grid';
  if(type === 'grid'){
    const cfg = f.tbGridForm;
    cfg.leverage = parseFloat(document.getElementById('tbGridLeverage').value);
    // Only one of these two inputs actually exists in the DOM at a time
    // (investmentField renders one or the other based on cfg.investmentMode)
    // — guard each so reading the form never clobbers the field that isn't
    // currently shown with a parse of a missing element.
    const investInput = document.getElementById('tbGridInvestment');
    const investPctInput = document.getElementById('tbGridInvestmentPct');
    if(investInput) cfg.investmentUsd = parseFloat(investInput.value);
    if(investPctInput) cfg.investmentPct = Math.max(1, Math.min(95, parseFloat(investPctInput.value) || cfg.investmentPct));
    cfg.levelCount = parseInt(document.getElementById('tbGridLevels').value, 10);
    cfg.maxLossPct = parseFloat(document.getElementById('tbGridMaxLoss').value);
    const ptRaw = document.getElementById('tbGridProfitTarget').value;
    cfg.profitTargetPct = ptRaw === '' ? null : parseFloat(ptRaw);
    if(cfg.autoScan){
      cfg.minGridScore = parseFloat(document.getElementById('tbGridMinScore').value);
      cfg.maxConcurrent = parseInt(document.getElementById('tbGridMaxConcurrent').value, 10);
    } else {
      cfg.upper = parseFloat(document.getElementById('tbGridUpper').value);
      cfg.lower = parseFloat(document.getElementById('tbGridLower').value);
    }
  } else {
    const cfg = f.tbDcaForm;
    cfg.baseOrderUsd = parseFloat(document.getElementById('tbDcaBase').value);
    cfg.safetyOrderUsd = parseFloat(document.getElementById('tbDcaSafety').value);
    cfg.maxSafetyOrders = parseInt(document.getElementById('tbDcaMaxSafety').value, 10);
    cfg.priceDeviationPct = parseFloat(document.getElementById('tbDcaDeviation').value);
    cfg.stepScale = parseFloat(document.getElementById('tbDcaStepScale').value);
    cfg.volumeScale = parseFloat(document.getElementById('tbDcaVolScale').value);
    cfg.takeProfitPct = parseFloat(document.getElementById('tbDcaTp').value);
    const slRaw = document.getElementById('tbDcaSl').value;
    cfg.stopLossPct = slRaw === '' ? null : parseFloat(slRaw);
    cfg.leverage = parseFloat(document.getElementById('tbDcaLeverage').value);
  }
}

function tbCreateStatus(msg, isError){
  const host = document.getElementById('tbCreateStatus');
  if(host){ host.textContent = msg; host.style.color = isError ? 'var(--red)' : ''; }
}

function initTradingBots(){
  renderTradingBotsCreate();
  renderTradingBotsList();
  if(els.fuTradingBotsCreate){
    els.fuTradingBotsCreate.addEventListener('change', (e) => {
      const f = fu();
      if(e.target.id === 'tbType'){ f.tbCreateType = e.target.value; renderTradingBotTypeFields(); }
      else if(e.target.id === 'tbExchange'){ readTradingBotFormNumbers(); f.tbCreateExchange = e.target.value; renderTradingBotsCreate(); }
      else if(e.target.id === 'tbSymbol'){ f.tbCreateSymbol = e.target.value.trim().toUpperCase(); }
      else if(e.target.id === 'tbDailyProfitTarget'){ f.tbDailyProfitTargetPct = Math.max(0.5, parseFloat(e.target.value) || 20); }
      else if(e.target.id === 'tbDailyMaxLoss'){ f.tbDailyMaxLossPct = Math.max(0.5, parseFloat(e.target.value) || 10); }
      else if(e.target.id === 'tbBtSymbol'){ f.tbBacktestSymbol = e.target.value; }
      else if(e.target.id === 'tbBtTimeframe'){ f.tbBacktestTimeframe = e.target.value; }
      else if(e.target.id === 'tbBtDays'){ f.tbBacktestDays = Math.max(3, Math.min(180, parseInt(e.target.value, 10) || 30)); }
      else if(e.target.id === 'tbBtMinScore'){ f.tbBacktestMinScore = Math.max(0, Math.min(100, parseInt(e.target.value, 10) || 0)); }
      else if(e.target.id === 'tbGridInvestmentPctRange' || e.target.id === 'tbGridInvestmentPct'){
        // Drag the slider or type the number — either updates the other
        // live, no re-render needed until the mode itself changes.
        const v = Math.max(1, Math.min(95, parseInt(e.target.value, 10) || 1));
        const range = document.getElementById('tbGridInvestmentPctRange');
        const num = document.getElementById('tbGridInvestmentPct');
        if(range) range.value = v;
        if(num) num.value = v;
        f.tbGridForm.investmentPct = v;
      }
    });
    els.fuTradingBotsCreate.addEventListener('click', async (e) => {
      if(e.target.classList.contains('tb-mode-btn')){
        // Trading Bots have their own Live/Demo switch — the Live/Demo exchange rows are on a different page.
        const f = fu();
        if(f.tbAutoScanEnabled) return; // the running scan keeps the network it started on
        readTradingBotFormNumbers();
        f.liveModeByExchange[f.tbCreateExchange || 'bybit'] = e.target.dataset.mode === 'demo' ? 'demo' : 'live';
        renderTradingBotsCreate();
        return;
      }
      if(e.target.classList.contains('tb-grid-mode')){
        readTradingBotFormNumbers(); fu().tbGridForm.autoScan = e.target.dataset.mode === 'auto'; renderTradingBotTypeFields(); renderTradingBotsCreate(); return;
      }
      if(e.target.classList.contains('tb-grid-invmode')){
        readTradingBotFormNumbers(); fu().tbGridForm.investmentMode = e.target.dataset.invmode; renderTradingBotTypeFields(); return;
      }
      if(e.target.classList.contains('tb-grid-direction')){
        readTradingBotFormNumbers(); fu().tbGridForm.direction = e.target.dataset.dir; renderTradingBotTypeFields(); return;
      }
      if(e.target.classList.contains('tb-dca-direction')){
        readTradingBotFormNumbers(); fu().tbDcaForm.direction = e.target.dataset.dir; renderTradingBotTypeFields(); return;
      }
      if(e.target.id === 'tbGridSmartFill'){
        const f = fu();
        readTradingBotFormNumbers();
        const symbol = (document.getElementById('tbSymbol').value || '').trim().toUpperCase();
        if(!symbol){ tbCreateStatus('Enter a symbol first.', true); return; }
        tbCreateStatus('Fetching current range…');
        const exchange = f.tbCreateExchange || 'bybit';
        const snap = await fetchLiveSnapshot(exchange, symbol, '5m').catch(err => { tbCreateStatus(`Could not fetch ${symbol}: ${err.message}`, true); return null; });
        if(!snap) return;
        const regime = classifyRegime(snap.h1, snap.m15);
        const suggestion = suggestGridRange(snap, regime);
        f.tbGridForm.upper = suggestion.upper; f.tbGridForm.lower = suggestion.lower;
        renderTradingBotTypeFields();
        tbCreateStatus(`Suggested range around current price ${snap.price} (regime: ${regime.regime}) — edit before creating if you'd like.`);
        return;
      }
      if(e.target.id === 'tbCreateBtn'){
        await createTradingBotFromForm();
        return;
      }
      if(e.target.id === 'tbBtRunBtn'){
        await runTradingBotsGridBacktestFromForm();
        return;
      }
      if(e.target.classList.contains('tb-stop-btn')){
        await stopTradingBot(e.target.dataset.id);
        return;
      }
      if(e.target.classList.contains('tb-delete-btn')){
        deleteTradingBot(e.target.dataset.id);
        return;
      }
    });
  }
  if(els.fuTradingBotsList){
    // Delegate the same click handling to the list container too, since
    // Stop/Delete buttons live there, not in the create form's container.
    els.fuTradingBotsList.addEventListener('click', async (e) => {
      if(e.target.classList.contains('tb-details-btn')) openTradingBotDetails(e.target.dataset.id);
      else if(e.target.classList.contains('tb-stop-btn')) await stopTradingBot(e.target.dataset.id);
      else if(e.target.classList.contains('tb-delete-btn')) deleteTradingBot(e.target.dataset.id);
    });
  }
  const flattenAllBtn = document.getElementById('tbFlattenAllBtn');
  if(flattenAllBtn) flattenAllBtn.addEventListener('click', flattenAllGridBots);
}

function tbBacktestResultEl(){ return document.getElementById('tbBacktestResult'); }
function tbBacktestStatus(msg, isError){
  const host = tbBacktestResultEl();
  if(host) host.innerHTML = `<span style="color:${isError ? 'var(--red)' : 'var(--dim)'};">${msg}</span>`;
}

// Backtests the ACTUAL Trading Bots grid code (via
// runTradingBotsGridBacktest in grid.js, which mirrors
// deployGridBotInstance/manageGridBotInstance step for step — including
// the breakout/drift-recalc/liquidation-buffer exits just added above)
// against real historical candles for whatever the create form is
// currently set to. Deliberately separate from the NxTGen Grid
// backtest on the Backtest tab, which tests a different engine.
async function runTradingBotsGridBacktestFromForm(){
  const f = fu();
  readTradingBotFormNumbers();
  const cfg = f.tbGridForm;
  const exchange = f.tbCreateExchange || 'bybit';
  const symbol = f.tbBacktestSymbol || GRID_SYMBOLS[0];
  const timeframe = f.tbBacktestTimeframe || '5m';
  const TIMEFRAME_TO_MINUTES = { '3m': 3, '5m': 5, '15m': 15, '30m': 30, '1h': 60 };
  const intervalMinutes = TIMEFRAME_TO_MINUTES[timeframe] || 5;
  const days = f.tbBacktestDays || 30;
  let investmentBase = cfg.investmentUsd;
  if(cfg.investmentMode === 'pct'){
    // No live per-cycle margin concept in an offline backtest — resolve %
    // against your CURRENT free balance once, up front, as a stand-in for
    // "what would this be sized at if deployed right now."
    const mode = f.liveModeByExchange[exchange] || 'live';
    const cred = liveCred(exchange, mode);
    if(!cred){ tbBacktestStatus(`No verified ${exchange} ${mode} credential — connect it to backtest a % sizing.`, true); return; }
    const marginProbe = await checkAvailableMarginFor({ exchange, mode, apiKey: cred.apiKey, secretKey: cred.secretKey, passphrase: cred.passphrase }, 0);
    if(marginProbe.available == null){ tbBacktestStatus(`Could not read free margin on ${exchange} to resolve the % sizing.`, true); return; }
    investmentBase = marginProbe.available * (cfg.investmentPct / 100);
  }
  const perBotUsd = cfg.autoScan ? investmentBase / Math.max(1, cfg.maxConcurrent) : investmentBase;
  const minGridScore = cfg.autoScan ? cfg.minGridScore : (f.tbBacktestMinScore ?? 0);
  if(!(perBotUsd > 0)){ tbBacktestStatus('Set an investment amount first.', true); return; }
  tbBacktestStatus(`Fetching ${days}d of ${symbol} ${timeframe} history…`);
  const endMs = Date.now();
  const startMs = endMs - days * 86_400_000;
  const data = await callProxy('/api/backtest/klines', { exchange, symbol, interval: timeframe, startMs, endMs }).catch(err => ({ ok:false, message: err.message }));
  if(!data.ok || !data.candles || !data.candles.length){ tbBacktestStatus(`Could not fetch ${symbol} ${timeframe} history: ${data.message || 'no candles returned'}.`, true); return; }
  tbBacktestStatus(`Simulating ${data.candles.length.toLocaleString()} candles…`);
  await new Promise(resolve => setTimeout(resolve, 0)); // let the status above paint before the sync simulation loop below runs
  const backtestCfg = {
    levelCount: Number.isFinite(cfg.levelCount) ? cfg.levelCount : 10,
    leverage: Number.isFinite(cfg.leverage) ? cfg.leverage : 10,
    investmentUsd: perBotUsd,
    maxLossPct: Number.isFinite(cfg.maxLossPct) ? cfg.maxLossPct : 20,
    profitTargetPct: Number.isFinite(cfg.profitTargetPct) ? cfg.profitTargetPct : null,
    minGridScore,
  };
  const result = runTradingBotsGridBacktest({
    symbol, candles: data.candles, exchange, cfg: backtestCfg,
    metaOverrides: { spreadPct: 0.02, fundingRatePct: 0.01 }, intervalMinutes,
  });
  const summary = summarizeTradingBotsGridTrades(result.trades, result.counters);
  const host = tbBacktestResultEl();
  if(!host) return;
  if(!summary.deployments){
    host.innerHTML = `<span style="color:var(--dim);">Never cleared a ${minGridScore}/100 Grid Score in this window — 0 deployments. Try a lower Minimum Grid Score, a different symbol, or a longer window.</span>`;
    return;
  }
  const pnlColor = summary.netUsd >= 0 ? 'var(--green)' : 'var(--red)';
  host.innerHTML = `
    <div style="display:flex;gap:20px;flex-wrap:wrap;margin-bottom:8px;">
      <div><span style="color:var(--dim);">Deployments</span> <strong>${summary.deployments}</strong></div>
      <div><span style="color:var(--dim);">Closed cycles</span> <strong>${summary.cycles}</strong></div>
      <div><span style="color:var(--dim);">Win rate</span> <strong>${summary.winRate.toFixed(1)}%</strong></div>
      <div><span style="color:var(--dim);">Net P&amp;L</span> <strong style="color:${pnlColor};">${fmtUsd(summary.netUsd)}</strong></div>
      <div><span style="color:var(--dim);">Profit factor</span> <strong>${summary.profitFactor === Infinity ? '∞' : summary.profitFactor.toFixed(2)}</strong></div>
    </div>
    <div style="color:var(--dim);font-size:11px;">Exits — breakout: ${summary.breakoutExits} · drift-recalc: ${summary.recalculations} · liquidation-risk: ${summary.liquidations} · max loss: ${summary.maxLossExits} · profit target: ${summary.profitTargetExits} · still open at window end: ${summary.openAtEnd}</div>
    <div style="color:var(--dim);font-size:11px;margin-top:6px;">Simulated over ${data.candles.length.toLocaleString()} real ${symbol} ${timeframe} candles (~${days}d), ${fmtUsd(perBotUsd)} per deployment — same code path as the live bot (which still runs on 5m — see note above), not a separate model. Past performance on this window is not a guarantee of future results.</div>
  `;
}

async function createTradingBotFromForm(){
  const f = fu();
  rollTradingBotsDay(Date.now());
  if(f.tbDailyHalted){ tbCreateStatus(`Paused for today: ${f.tbDailyHaltMessage || 'daily limit reached'} — try again after the next UTC day rollover.`, true); return; }
  const type = f.tbCreateType || 'grid';
  const exchange = f.tbCreateExchange || 'bybit';
  if(!GRID_LIVE_EXCHANGES.includes(exchange)){ tbCreateStatus('Trading Bots only support Bybit or Binance.', true); return; }
  const mode = f.liveModeByExchange[exchange] || 'live';
  const cred = liveCred(exchange, mode);
  if(!cred){ tbCreateStatus(`No verified ${exchange} ${mode} credential — connect it in Autotrade & Balances first.`, true); return; }
  readTradingBotFormNumbers();

  if(type === 'grid' && f.tbGridForm.autoScan){
    toggleGridAutoScan(exchange);
    return;
  }

  const symbol = (document.getElementById('tbSymbol').value || '').trim().toUpperCase();
  if(!symbol){ tbCreateStatus('Enter a symbol.', true); return; }

  const bot = {
    id: newTradingBotId(type), type, exchange, mode, symbol,
    createdAtMs: Date.now(), status: 'deploying', statusMessage: 'Deploying…', statusIsError: false,
    realizedUsd: 0, runtime: {},
  };

  if(type === 'grid'){
    const cfg = f.tbGridForm;
    if(!(cfg.upper > cfg.lower)){ tbCreateStatus('Upper price must be greater than lower price.', true); return; }
    if(cfg.investmentMode !== 'pct' && !(cfg.investmentUsd > 0)){ tbCreateStatus('Enter a total investment amount.', true); return; }
    if(!(cfg.maxLossPct > 0)){ tbCreateStatus('Enter a Max Loss % for this bot.', true); return; }
    const proxyArgsBal = { exchange, mode, apiKey: cred.apiKey, secretKey: cred.secretKey, passphrase: cred.passphrase };
    const marginProbe = await checkAvailableMarginFor(proxyArgsBal, 0); // fetch real free margin either way — pct mode sizes off it directly, USDT mode still verifies against it below
    if(marginProbe.available == null){ tbCreateStatus(`Could not read free margin on ${exchange} right now — try again in a moment.`, true); return; }
    // % mode resolves against real, current free margin at deploy time —
    // not whatever balance existed when the % was typed — so it's already
    // self-limiting (can never ask for more than what's actually free) and
    // naturally adapts as other bots open/close margin.
    const investmentUsd = cfg.investmentMode === 'pct' ? marginProbe.available * (cfg.investmentPct / 100) : cfg.investmentUsd;
    if(!(investmentUsd > 0)){ tbCreateStatus(`Free margin on ${exchange} is effectively 0 — nothing to allocate.`, true); return; }
    if(investmentUsd > marginProbe.available){ tbCreateStatus(`Not enough free margin on ${exchange} — this bot needs ~${fmtUsd(investmentUsd)} but only ${fmtUsd(marginProbe.available)} is free right now.`, true); return; }
    const plan = buildManualGridPlan({ symbol, direction: cfg.direction, upper: cfg.upper, lower: cfg.lower, levelCount: cfg.levelCount, leverage: cfg.leverage, investmentUsd });
    if(!plan){ tbCreateStatus('Check your grid settings — could not build a valid plan from them.', true); return; }
    bot.direction = cfg.direction; bot.investmentUsd = investmentUsd; bot.leverage = cfg.leverage;
    bot.config = { ...cfg }; bot.plan = plan; bot.runtime = { levels: [], longStopSet: false, shortStopSet: false };
    f.tbDayAnchorInvestmentUsd += bot.investmentUsd; // known immediately for Grid — DCA adds its own once the plan is built against a real price, see deployDcaBotInstance
  } else {
    const cfg = f.tbDcaForm;
    if(!(cfg.baseOrderUsd > 0)){ tbCreateStatus('Enter a base order size.', true); return; }
    bot.direction = cfg.direction; bot.leverage = cfg.leverage; bot.config = { ...cfg };
    bot.investmentUsd = null; // filled in once the plan is built against a real anchor price below
  }

  f.tradingBots.push(bot);
  renderTradingBotsList();
  renderTradingBotsCreate();
  tbCreateStatus('');

  if(type === 'grid') await deployGridBotInstance(bot, cred);
  else await deployDcaBotInstance(bot, cred);

  if(!f.tradingBotsRunning) toggleTradingBotsRunning(); // start the management loop the moment there's a bot to manage
}

// Flips the Futures Grid Auto-Scan switch on/off. Turning it ON snapshots
// the current form (investment/leverage/grids/max-loss/profit-target/
// minGridScore/maxConcurrent) as the config every auto-deployed bot from
// here on uses — editing the form afterward does NOT retroactively change
// bots already created, only new ones the scan makes from here. Turning
// it OFF just stops making NEW bots; bots it already created keep running
// (and its own Max Loss/Profit Target/the daily cap still manage them) —
// Stop those individually or via the Daily Risk Limits cap if you want
// them gone too.
function toggleGridAutoScan(exchange){
  const f = fu();
  f.tbAutoScanEnabled = !f.tbAutoScanEnabled;
  if(f.tbAutoScanEnabled){
    f.tbAutoScanExchange = exchange;
    f.tbAutoScanConfig = { ...f.tbGridForm };
    tbAutoScanStatus(`Auto-scan started on ${EXCHANGE_DISPLAY_NAMES[exchange] || exchange} — watching the watchlist.`);
    if(!f.tradingBotsRunning) toggleTradingBotsRunning();
  } else {
    tbAutoScanStatus('Auto-scan stopped — bots it already created keep running until you stop them individually.');
  }
  renderTradingBotsCreate();
}

function tbAutoScanStatus(msg){
  const host = document.getElementById('tbAutoScanStatus');
  if(host) host.textContent = msg;
}



// -------------------------------------------------------------
// Futures Grid bot — deployment + ongoing management. Reuses the EXACT
// same order-placement calls NxTGen Grid Live/Demo already uses
// (place-level/place-close/set-side-stop/flatten/orders/ensure-mode),
// just against this bot's OWN manually-built plan/levels instead of the
// single global gridLiveState — several of these can run at once, one
// per bot instance, each fully independent.
// -------------------------------------------------------------
async function deployGridBotInstance(bot, cred){
  const proxyArgs = { exchange: bot.exchange, mode: bot.mode, apiKey: cred.apiKey, secretKey: cred.secretKey, passphrase: cred.passphrase, symbol: bot.symbol };
  const modeCheck = await callProxy('/api/futures/grid/ensure-mode', proxyArgs).catch(err => ({ ok:false, message: err.message }));
  if(!modeCheck.ok || modeCheck.hedgeModeReady === false){
    bot.status = 'error';
    tradingBotLog(bot, modeCheck.message || `Could not confirm hedge mode for ${bot.symbol} on ${bot.exchange}.`, true);
    return;
  }
  const plan = bot.plan;
  const levels = [];
  for(let li = 0; li < plan.levels.length; li++){
    const levelPrice = plan.levels[li];
    const isLowerHalf = levelPrice <= plan.mid;
    const wantLong = (plan.direction === 'LONG' || plan.direction === 'NEUTRAL') && isLowerHalf;
    const wantShort = (plan.direction === 'SHORT' || plan.direction === 'NEUTRAL') && !isLowerHalf;
    if(!wantLong && !wantShort) continue;
    const direction = wantLong ? 'LONG' : 'SHORT';
    const perLevelUsd = plan.allocationUsd / plan.levelCount;
    const qty = (perLevelUsd * plan.leverage) / levelPrice;
    const placed = await callProxy('/api/futures/grid/place-level', { ...proxyArgs, direction, price: levelPrice, qty, leverage: plan.leverage, orderLinkTag: `${bot.id}-${li}` }).catch(err => ({ ok:false, message: err.message }));
    if(!placed.ok){ tradingBotLog(bot, `Level ${li} (${levelPrice.toFixed(6)}) skipped: ${placed.message}`, false); continue; }
    levels.push({ levelIndex: li, price: levelPrice, direction, status: 'PENDING_ENTRY', entryOrderId: placed.orderId, targetIndex: wantLong ? li + 1 : li - 1 });
  }
  if(levels.length === 0){
    bot.status = 'error';
    tradingBotLog(bot, 'No grid levels could be placed — see messages above.', true);
    return;
  }
  bot.runtime.levels = levels;
  bot.runtime.openedAtMs = Date.now();
  bot.runtime.unrealizedUsd = null; // set for real on the first management tick
  bot.status = 'active';
  tradingBotLog(bot, `Grid ACTIVE — ${levels.length}/${plan.levelCount} levels resting.`, false);
}

async function manageGridBotInstance(bot, cred, nowMs){
  const plan = bot.plan;
  const proxyArgs = { exchange: bot.exchange, mode: bot.mode, apiKey: cred.apiKey, secretKey: cred.secretKey, passphrase: cred.passphrase, symbol: bot.symbol };
  const snap = await fetchLiveSnapshot(bot.exchange, bot.symbol, '5m').catch(err => { tradingBotLog(bot, `Snapshot fetch failed: ${err.message}`, true); return null; });
  if(!snap) return;
  bot.runtime.markPrice = snap.price; // last known mark, for the Details view's Parameters block

  const bo = detectGridBreakout(snap, plan, GRID_DEFAULTS);
  if(bo.breakout){
    tradingBotLog(bot, `BREAKOUT detected (${bo.reasons[0] || ''}) — flattening.`, true);
    const flat = await callProxy('/api/futures/grid/flatten', proxyArgs).catch(err => ({ ok:false, message: err.message }));
    if(!flat.ok) tradingBotLog(bot, `Flatten call failed: ${flat.message} — check ${bot.symbol} on ${bot.exchange} directly.`, true);
    bot.status = 'closed';
    renderTradingBotsList();
    return;
  }

  // Drift recalculation — price has wandered well beyond this grid's own
  // range WITHOUT a confirmed breakout (detectGridBreakout above requires
  // ATR-expansion + volume confirmation, so a slow, unconfirmed grind
  // can sit outside the range for a while without ever tripping it).
  // Ported from NxTGen Grid's stepGridSymbol — same recalcDriftPct
  // threshold — because without this, a Trading Bots grid left running
  // through a slow drift just keeps quoting a range the market has
  // already left, one-sided and unmanaged, with no auto-correction.
  const halfWidth = (plan.upper - plan.lower) / 2;
  const driftedUp = snap.price > plan.upper + halfWidth * (GRID_DEFAULTS.recalcDriftPct / 100);
  const driftedDown = snap.price < plan.lower - halfWidth * (GRID_DEFAULTS.recalcDriftPct / 100);
  if(driftedUp || driftedDown){
    tradingBotLog(bot, `Price drifted ${GRID_DEFAULTS.recalcDriftPct}%+ beyond the grid range without a confirmed breakout — flattening (stale range).`, true);
    const flat = await callProxy('/api/futures/grid/flatten', proxyArgs).catch(err => ({ ok:false, message: err.message }));
    if(!flat.ok) tradingBotLog(bot, `Flatten call failed: ${flat.message} — check ${bot.symbol} on ${bot.exchange} directly.`, true);
    bot.status = 'closed';
    renderTradingBotsList();
    return;
  }

  // Liquidation-buffer protection — ported from stepGridSymbol's
  // liquidationBufferRatio check. If ANY currently-open leg's estimated
  // liquidation price has drifted uncomfortably close to the current
  // mark, flatten NOW rather than wait for that leg to either hit its
  // target or for a confirmed breakout. One real difference from NxTGen
  // Grid's version: this app's exchange proxy only exposes a
  // whole-symbol flatten (both hedge-mode sides at once, via
  // /api/futures/grid/flatten) — there's no reduce-only single-side
  // close endpoint yet — so this closes the WHOLE bot, not just the
  // at-risk leg. More conservative than the simulated version, on
  // purpose, given what's actually available to call right now.
  const openLegs = bot.runtime.levels.filter(l => l.status === 'PENDING_CLOSE');
  for(const leg of openLegs){
    const liqPrice = estimateLiquidationPrice({ entryPrice: leg.entryPrice, leverage: plan.leverage, side: leg.direction, maintenanceMarginRate: RISK_DEFAULTS.maintenanceMarginRate });
    const dist = Math.abs(snap.price - liqPrice);
    const worstCase = Math.abs(leg.entryPrice - (leg.direction === 'LONG' ? plan.lower : plan.upper));
    if(worstCase > 0 && dist < worstCase * GRID_DEFAULTS.liquidationBufferRatio * 0.35){
      tradingBotLog(bot, `Liquidation risk — a ${leg.direction} leg's est. liquidation (${liqPrice.toFixed(6)}) is too close to mark (${snap.price.toFixed(6)}) — flattening the whole bot.`, true);
      const flat = await callProxy('/api/futures/grid/flatten', proxyArgs).catch(err => ({ ok:false, message: err.message }));
      if(!flat.ok) tradingBotLog(bot, `Flatten call failed: ${flat.message} — check ${bot.symbol} on ${bot.exchange} directly.`, true);
      bot.status = 'closed';
      renderTradingBotsList();
      return;
    }
  }

  const openOrdersResp = await callProxy('/api/futures/grid/orders', proxyArgs).catch(err => ({ ok:false, message: err.message }));
  if(!openOrdersResp.ok){ tradingBotLog(bot, `Could not read open orders: ${openOrdersResp.message}`, true); return; }
  const openIds = new Set(openOrdersResp.list.map(o => String(o.orderId)));

  // Real floating P&L on whatever's currently open — separate from
  // bot.realizedUsd (closed cycles only). Read fresh every cycle so the
  // card always reflects the exchange's own mark, not a stale snapshot.
  const posResp = await callProxy('/api/futures/grid/positions', proxyArgs).catch(err => ({ ok:false, message: err.message }));
  bot.runtime.unrealizedUsd = posResp.ok ? (posResp.long?.unrealisedPnl || 0) + (posResp.short?.unrealisedPnl || 0) : null;

  for(const level of bot.runtime.levels){
    if(level.status === 'PENDING_ENTRY' && level.entryOrderId != null && !openIds.has(String(level.entryOrderId))){
      const targetPrice = plan.levels[level.targetIndex];
      if(targetPrice == null){ level.status = 'FILLED_NO_TARGET'; continue; }
      const perLevelUsd = plan.allocationUsd / plan.levelCount;
      const qty = (perLevelUsd * plan.leverage) / level.price;
      const closed = await callProxy('/api/futures/grid/place-close', { ...proxyArgs, direction: level.direction, price: targetPrice, qty, orderLinkTag: `${bot.id}-${level.levelIndex}` }).catch(err => ({ ok:false, message: err.message }));
      if(!closed.ok){ tradingBotLog(bot, `Level ${level.levelIndex} filled but its close order failed: ${closed.message}`, true); continue; }
      level.status = 'PENDING_CLOSE'; level.closeOrderId = closed.orderId; level.entryPrice = level.price; level.targetPrice = targetPrice; level.openedAt = nowMs;
      const stopField = level.direction === 'LONG' ? 'longStopSet' : 'shortStopSet';
      if(!bot.runtime[stopField]){
        const stopPrice = level.direction === 'LONG' ? plan.lower : plan.upper;
        const stopResult = await callProxy('/api/futures/grid/set-side-stop', { ...proxyArgs, direction: level.direction, stopPrice }).catch(err => ({ ok:false, message: err.message }));
        if(stopResult.ok) bot.runtime[stopField] = true;
        else tradingBotLog(bot, `Could not attach protective stop on the ${level.direction} side: ${stopResult.message} — that side has NO exchange-side protection yet.`, true);
      }
    } else if(level.status === 'PENDING_CLOSE' && level.closeOrderId != null && !openIds.has(String(level.closeOrderId))){
      const perLevelUsd = plan.allocationUsd / plan.levelCount;
      const qty = (perLevelUsd * plan.leverage) / level.entryPrice;
      const pnl = netCycleProfit({ entryPrice: level.entryPrice, exitPrice: level.targetPrice, qty, direction: level.direction, exchange: bot.exchange, holdMinutes: (nowMs - level.openedAt) / 60_000, fundingRatePct: snap.meta.fundingRatePct, slippagePct: snap.meta.spreadPct });
      bot.realizedUsd += pnl.netUsd;
      addTradingBotsRealized(pnl.netUsd);
      const record = {
        closedAtMs: nowMs, openedAtMs: level.openedAt, exchange: bot.exchange, mode: bot.mode, symbol: bot.symbol, side: level.direction, direction: level.direction,
        entry: level.entryPrice, exit: level.targetPrice, qty, leverage: plan.leverage,
        grossUsd: pnl.grossUsd, feesUsd: pnl.feesUsd, fundingUsd: pnl.fundingUsd, slippageUsd: pnl.slippageUsd, netUsd: pnl.netUsd,
        confidence: null, setupType: 'Trading Bot: Grid', exitReason: 'GRID_CYCLE_TP', durationMin: Math.round((nowMs - level.openedAt) / 60_000),
        gridId: bot.id, gridLevel: level.levelIndex, cycleResult: pnl.netUsd > 0 ? 'WIN' : 'LOSS',
      };
      appendPersistentTrade(record);
      const rePlaced = await callProxy('/api/futures/grid/place-level', { ...proxyArgs, direction: level.direction, price: level.price, qty, leverage: plan.leverage, orderLinkTag: `${bot.id}-${level.levelIndex}-r` }).catch(err => ({ ok:false, message: err.message }));
      if(rePlaced.ok){ level.status = 'PENDING_ENTRY'; level.entryOrderId = rePlaced.orderId; level.closeOrderId = null; }
      else { level.status = 'IDLE'; level.entryOrderId = null; level.closeOrderId = null; tradingBotLog(bot, `Cycle closed on level ${level.levelIndex} but couldn't re-arm it: ${rePlaced.message}`, true); }
    }
  }
  // This bot's OWN Max Loss / Profit Target — separate from, and checked
  // before, the cross-bot daily cap: this can flatten just THIS bot while
  // others keep running, unlike the daily cap which stops everything.
  if(bot.status === 'active'){
    const maxLossPct = bot.config?.maxLossPct;
    const profitTargetPct = bot.config?.profitTargetPct;
    const lossFloorUsd = maxLossPct ? -bot.investmentUsd * (maxLossPct / 100) : null;
    const profitCeilUsd = profitTargetPct ? bot.investmentUsd * (profitTargetPct / 100) : null;
    if(lossFloorUsd != null && bot.realizedUsd <= lossFloorUsd){
      tradingBotLog(bot, `This bot's Max Loss (${maxLossPct}%) reached — flattening.`, true);
      const flat = await callProxy('/api/futures/grid/flatten', proxyArgs).catch(err => ({ ok:false, message: err.message }));
      if(!flat.ok) tradingBotLog(bot, `Flatten call failed: ${flat.message} — check ${bot.symbol} on ${bot.exchange} directly.`, true);
      bot.status = 'closed';
    } else if(profitCeilUsd != null && bot.realizedUsd >= profitCeilUsd){
      tradingBotLog(bot, `This bot's Profit Target (${profitTargetPct}%) reached — flattening.`, false);
      const flat = await callProxy('/api/futures/grid/flatten', proxyArgs).catch(err => ({ ok:false, message: err.message }));
      if(!flat.ok) tradingBotLog(bot, `Flatten call failed: ${flat.message} — check ${bot.symbol} on ${bot.exchange} directly.`, true);
      bot.status = 'closed';
    }
  }
  if(bot.status === 'active'){
    tradingBotLog(bot, `Running — ${bot.runtime.levels.filter(l => l.status === 'PENDING_CLOSE').length} leg(s) open, ${fmtUsd(bot.realizedUsd)} realized, ${bot.runtime.unrealizedUsd != null ? fmtUsd(bot.runtime.unrealizedUsd) + ' unrealized' : 'unrealized unknown'}.`, false);
  }
}

// -------------------------------------------------------------
// DCA bot — deployment + ongoing management. One-way mode; safety
// orders just accumulate into the same position, average price shifts,
// TP is re-set to the new average after every fill. Closure (TP or the
// optional hard stop firing) is detected by the position going flat —
// see the header note in dca.js for why that's the reliable signal
// rather than watching for a specific order to disappear.
// -------------------------------------------------------------
async function deployDcaBotInstance(bot, cred){
  const proxyArgs = { exchange: bot.exchange, mode: bot.mode, apiKey: cred.apiKey, secretKey: cred.secretKey, passphrase: cred.passphrase, symbol: bot.symbol };
  const snap = await fetchLiveSnapshot(bot.exchange, bot.symbol, '5m').catch(err => { bot.status = 'error'; tradingBotLog(bot, `Snapshot fetch failed: ${err.message}`, true); return null; });
  if(!snap) return;
  const plan = buildDcaPlan({ symbol: bot.symbol, direction: bot.direction, anchorPrice: snap.price, cfg: bot.config });
  if(!plan){ bot.status = 'error'; tradingBotLog(bot, 'Could not build a valid DCA plan from these settings.', true); return; }
  bot.plan = plan; bot.investmentUsd = plan.totalInvestmentUsd;
  fu().tbDayAnchorInvestmentUsd += bot.investmentUsd;
  renderTradingBotsDailyLimits(); // refresh the daily-limits header now that the anchor total changed

  const balResp = await callProxy('/api/futures/balance', proxyArgs).catch(err => ({ ok:false, message: err.message }));
  bot.runtime.balanceBeforeUsd = balResp.ok ? balResp.balance : null;
  bot.runtime.openedAtMs = Date.now();

  const baseQty = (plan.baseOrderUsd * plan.leverage) / snap.price;
  const baseResult = await callProxy('/api/futures/dca/place', { ...proxyArgs, direction: bot.direction, orderType: 'MARKET', qty: baseQty, leverage: plan.leverage }).catch(err => ({ ok:false, message: err.message }));
  if(!baseResult.ok){ bot.status = 'error'; tradingBotLog(bot, `Base order failed: ${baseResult.message}`, true); return; }

  bot.runtime.safetyOrders = [];
  for(const level of plan.safetyLevels){
    const qty = (level.sizeUsd * plan.leverage) / level.price;
    const placed = await callProxy('/api/futures/dca/place', { ...proxyArgs, direction: bot.direction, orderType: 'LIMIT', price: level.price, qty, leverage: plan.leverage }).catch(err => ({ ok:false, message: err.message }));
    if(!placed.ok){ tradingBotLog(bot, `Safety order ${level.index} skipped: ${placed.message}`, false); continue; }
    bot.runtime.safetyOrders.push({ index: level.index, orderId: placed.orderId, price: level.price, status: 'PENDING' });
  }

  // Confirm the base order's real fill and set the initial TP off it —
  // a market order should be filled by the time we get here, but poll
  // briefly rather than assume.
  const posResp = await callProxy('/api/futures/position', { ...proxyArgs, openedAtMs: bot.runtime.openedAtMs, balanceBeforeUsd: bot.runtime.balanceBeforeUsd }).catch(err => ({ ok:false, message: err.message }));
  if(posResp.ok && posResp.open){
    bot.runtime.avgEntryPrice = posResp.position.avgPrice; bot.runtime.totalQty = posResp.position.size;
    const exits = computeDcaExitPrices({ direction: bot.direction, avgEntryPrice: bot.runtime.avgEntryPrice, takeProfitPct: plan.takeProfitPct, stopLossPct: plan.stopLossPct });
    const tpResult = await callProxy('/api/futures/dca/set-tp', { ...proxyArgs, direction: bot.direction, takeProfitPrice: exits.takeProfitPrice, stopLossPrice: exits.stopLossPrice, existingTpAlgoId: bot.runtime.tpAlgoId, existingSlAlgoId: bot.runtime.slAlgoId }).catch(err => ({ ok:false, message: err.message }));
    if(tpResult.ok){ bot.runtime.tpAlgoId = tpResult.tpAlgoId || null; bot.runtime.slAlgoId = tpResult.slAlgoId || null; }
    else tradingBotLog(bot, `Base order filled but setting take-profit failed: ${tpResult.message} — the position is OPEN WITHOUT a take-profit yet, will retry next cycle.`, true);
  } else {
    tradingBotLog(bot, `Base order sent but position isn't confirmed open yet — will confirm and set take-profit next cycle.`, false);
  }
  bot.status = 'active';
  tradingBotLog(bot, `DCA ACTIVE — base order sent, ${bot.runtime.safetyOrders.length}/${plan.safetyLevels.length} safety orders resting.`, false);
}

async function manageDcaBotInstance(bot, cred, nowMs){
  const proxyArgs = { exchange: bot.exchange, mode: bot.mode, apiKey: cred.apiKey, secretKey: cred.secretKey, passphrase: cred.passphrase, symbol: bot.symbol };
  const posResp = await callProxy('/api/futures/position', { ...proxyArgs, openedAtMs: bot.runtime.openedAtMs, balanceBeforeUsd: bot.runtime.balanceBeforeUsd }).catch(err => ({ ok:false, message: err.message }));
  if(!posResp.ok){ tradingBotLog(bot, `Could not read position: ${posResp.message}`, true); return; }

  bot.runtime.unrealizedUsd = posResp.open ? posResp.position.unrealisedPnl : null;

  if(!posResp.open){
    // Flat — TP or the hard stop fired (or it was closed manually on the
    // exchange). Cancel anything still resting, log what we can from the
    // exchange's own realized-PnL read (real, not estimated — same
    // balance-diff/closed-pnl mechanism the six strategies' Live/Demo
    // trades already use), and mark this bot done.
    await callProxy('/api/futures/dca/flatten', proxyArgs).catch(() => {});
    const closed = posResp.closed;
    const record = {
      closedAtMs: nowMs, exchange: bot.exchange, mode: bot.mode, symbol: bot.symbol, side: bot.direction,
      entry: closed && closed.avgEntryPrice != null ? closed.avgEntryPrice : bot.runtime.avgEntryPrice,
      exit: closed && closed.avgExitPrice != null ? closed.avgExitPrice : null,
      leverage: bot.plan.leverage, qty: bot.runtime.totalQty,
      grossUsd: closed && closed.grossPnl != null ? closed.grossPnl : null,
      feesUsd: closed && closed.feesUsd != null ? closed.feesUsd : null,
      netUsd: closed ? closed.closedPnl : 0,
      setupType: 'Trading Bot: DCA', durationMin: Math.round((nowMs - bot.runtime.openedAtMs) / 60_000), gridId: bot.id,
    };
    bot.realizedUsd = record.netUsd || 0;
    addTradingBotsRealized(bot.realizedUsd);
    appendPersistentTrade(record);
    bot.status = 'closed';
    tradingBotLog(bot, `Position closed — ${fmtUsd(bot.realizedUsd)} realized.`, false);
    return;
  }

  if(posResp.position.size > (bot.runtime.totalQty || 0) + 1e-9){
    // A safety order filled — average moved, re-set TP.
    bot.runtime.avgEntryPrice = posResp.position.avgPrice; bot.runtime.totalQty = posResp.position.size;
    const filledOrder = bot.runtime.safetyOrders.find(s => s.status === 'PENDING'); // best-effort marker; exact matching would need an open-orders diff like Grid's, kept simple since TP re-set is what actually matters here
    const orders = await callProxy('/api/futures/dca/orders', proxyArgs).catch(() => ({ ok:false }));
    if(orders.ok){
      const openIds = new Set(orders.list.map(o => String(o.orderId)));
      for(const s of bot.runtime.safetyOrders){ if(s.status === 'PENDING' && !openIds.has(String(s.orderId))) s.status = 'FILLED'; }
    } else if(filledOrder){
      filledOrder.status = 'FILLED';
    }
    const exits = computeDcaExitPrices({ direction: bot.direction, avgEntryPrice: bot.runtime.avgEntryPrice, takeProfitPct: bot.plan.takeProfitPct, stopLossPct: bot.plan.stopLossPct });
    const tpResult = await callProxy('/api/futures/dca/set-tp', { ...proxyArgs, direction: bot.direction, takeProfitPrice: exits.takeProfitPrice, stopLossPrice: exits.stopLossPrice, existingTpAlgoId: bot.runtime.tpAlgoId, existingSlAlgoId: bot.runtime.slAlgoId }).catch(err => ({ ok:false, message: err.message }));
    if(tpResult.ok){ bot.runtime.tpAlgoId = tpResult.tpAlgoId || null; bot.runtime.slAlgoId = tpResult.slAlgoId || null; }
    else tradingBotLog(bot, `Safety order filled but re-setting take-profit failed: ${tpResult.message} — retrying next cycle.`, true);
    tradingBotLog(bot, `Safety order filled — average now ${bot.runtime.avgEntryPrice.toFixed(6)}, TP re-set to ${exits.takeProfitPrice.toFixed(6)}.`, false);
  } else {
    tradingBotLog(bot, `Running — avg ${bot.runtime.avgEntryPrice.toFixed(6)}, size ${bot.runtime.totalQty}, uPnL ${fmtUsd(posResp.position.unrealisedPnl)}.`, false);
  }
}

// -------------------------------------------------------------
// Cross-bot daily profit/loss cap — see the tbDay* fields' comment in
// state.js. Rolls over at UTC midnight, same day-key convention as
// NxTGen Grid's own rollGridLiveDay.
// -------------------------------------------------------------
function rollTradingBotsDay(nowMs){
  const f = fu();
  const key = Math.floor(nowMs / 86_400_000);
  if(f.tbDayKey === key) return;
  f.tbDayKey = key;
  f.tbDayAnchorInvestmentUsd = 0;
  f.tbDayRealizedUsd = 0;
  f.tbDailyHalted = false;
  f.tbDailyHaltMessage = null;
}

function addTradingBotsRealized(deltaUsd){
  const f = fu();
  f.tbDayRealizedUsd += deltaUsd;
  checkTradingBotsDailyLimits();
}

function checkTradingBotsDailyLimits(){
  const f = fu();
  if(f.tbDailyHalted || !(f.tbDayAnchorInvestmentUsd > 0)) return;
  const pct = (f.tbDayRealizedUsd / f.tbDayAnchorInvestmentUsd) * 100;
  if(pct >= f.tbDailyProfitTargetPct){
    // Profit target: stop opening NEW bots/grids for the rest of the day,
    // but don't force-close bots that are already running — they keep
    // going and exit on their own TP/SL/grid logic, same as NxTGen
    // Grid's own single-deployment daily-target behavior (line ~503-509).
    haltTradingBotsForToday(`Daily profit target (${f.tbDailyProfitTargetPct}%) reached — ${pct.toFixed(1)}% realized today across all bots. No new bots/grids until tomorrow — bots already running are left alone.`, { flattenActive: false });
  } else if(f.tbDailyMaxLossPct && pct <= -f.tbDailyMaxLossPct){
    // Max loss: this IS a safety cutoff, so it still force-flattens
    // everything immediately, unchanged from before.
    haltTradingBotsForToday(`Daily max loss (${f.tbDailyMaxLossPct}%) reached — ${pct.toFixed(1)}% realized today across all bots.`, { flattenActive: true });
  }
}

// Blocks new bot/auto-scan creation for the rest of the day via
// tbDailyHalted (checked by runGridAutoScan and createTradingBotFromForm)
// until the next rollTradingBotsDay resets it. flattenActive controls
// whether bots already running get force-stopped right now:
//  - profit target reached -> flattenActive:false — already-open bots
//    (including auto-scan grids) are left running and close naturally;
//    runGridAutoScan's maxConcurrent slot frees up when they do, but new
//    scanning stays paused since tbDailyHalted is still true today.
//  - max loss reached -> flattenActive:true — force-stops EVERY active
//    bot immediately (the exact same flatten/stop path the Stop button
//    uses), since this is a hard risk cutoff, not just a "stop looking
//    for more" signal.
async function haltTradingBotsForToday(reason, { flattenActive = true } = {}){
  const f = fu();
  if(f.tbDailyHalted) return; // already in progress/done — avoid double-flattening if this fires twice in the same tick
  f.tbDailyHalted = true;
  f.tbDailyHaltMessage = reason;
  if(flattenActive){
    const activeBots = f.tradingBots.filter(b => b.status === 'active');
    for(const bot of activeBots){
      await stopTradingBot(bot.id).catch(() => {});
    }
  }
  renderTradingBotsList();
  renderTradingBotsDailyLimits();
}

// Bulk "Flatten All Grids" — cancels every resting grid limit order
// (pending entries AND pending exits) and closes any already-open grid
// position, across every grid bot at once, rather than one Terminate click
// per card. Reuses stopTradingBot's own flatten call per bot (same
// /api/futures/grid/flatten endpoint, same "cancel resting orders, close
// any open position" behavior) so there's exactly one flatten code path
// for the whole app, not a second bulk-specific one to keep in sync.
// Scoped to type === 'grid' only — DCA bots have their own Stop button per
// card and aren't what "grid positions" refers to. Includes 'deploying'
// bots too: a bot mid-deployment may already have SOME levels resting on
// the exchange even though the app hasn't marked it 'active' yet — 'error'
// bots are included as well for safety, though in practice they have
// nothing resting (deployGridBotInstance only sets 'error' when literally
// zero levels placed).
async function flattenAllGridBots(){
  const f = fu();
  const targets = f.tradingBots.filter(b => b.type === 'grid' && (b.status === 'active' || b.status === 'deploying' || b.status === 'error'));
  if(targets.length === 0){ tbCreateStatus('No grid bots with pending or open positions right now.'); return; }
  if(!confirm(`Flatten ${targets.length} grid bot${targets.length === 1 ? '' : 's'}? This cancels every resting grid order and closes any open position on ${targets.length === 1 ? 'it' : 'each of them'} — can't be undone.`)) return;
  const host = document.getElementById('tbFlattenAllStatus');
  for(let i = 0; i < targets.length; i++){
    if(host) host.textContent = `Flattening ${i + 1}/${targets.length} (${targets[i].symbol})…`;
    await stopTradingBot(targets[i].id).catch(() => {});
  }
  if(host) host.textContent = `Flattened ${targets.length} grid bot${targets.length === 1 ? '' : 's'}.`;
}

// Reads the real, current exchange available balance and checks whether
// there's room for a bot that wants to commit ~neededUsd of margin.
// Used before every grid deployment (auto-scan and manual) so a bot's
// configured size is never just blindly trusted against the account —
// resting grid limit orders reserve exchange margin the moment they're
// placed, even before anything fills, so "the config says $X" isn't
// enough on its own to know $X is actually free right now.
async function checkAvailableMarginFor(proxyArgs, neededUsd){
  // /api/futures/available-margin, not /api/futures/balance: the latter is
  // Bybit's total wallet balance, which stays the same even once other
  // running bots have locked most of it up as margin — checking against it
  // kept saying "enough margin" right up until real order placement failed
  // on the exchange. This checks actual free/available margin instead, so
  // it accurately blocks a new deployment before it's created (rather than
  // creating it and having it fail with grid levels rejected one by one).
  const balResp = await callProxy('/api/futures/available-margin', proxyArgs).catch(err => ({ ok:false, message: err.message }));
  if(!balResp.ok || balResp.available == null) return { ok:false, available:null };
  return { ok: balResp.available >= neededUsd, available: balResp.available };
}

// -------------------------------------------------------------
// Futures Grid Auto-Scan — probes a bounded, round-robin batch of
// GRID_SYMBOLS each cycle (same idea, and same GRID_SCAN_BATCH_SIZE
// constant, as NxTGen Grid's own scanForGridLiveDeployment above; see
// that function's header comment for why a batch rather than the whole
// watchlist every tick). The first candidate that clears Minimum Grid
// Score becomes a brand-new Trading Bots grid deployment — always
// Neutral, range from suggestGridRange. One new bot per cycle, same
// "one deployment per tick" discipline as everything else that places
// real orders in this app.
//
// Sizing: cfg.investmentUsd in Auto-Scan mode is the TOTAL budget the
// user wants committed across every concurrent auto bot combined, not
// a per-bot amount — e.g. "150 USDT total, up to 4 bots" — so each new
// bot gets perBotUsd = totalBudget / maxConcurrent, which by
// construction never lets the sum of all slots exceed the budget
// regardless of whether 1, 2, 3 or 4 of them end up running at once.
// On top of that, the real exchange available balance is checked right
// before placing this bot's orders (see checkAvailableMarginFor below)
// — resting grid limit orders reserve exchange margin even before they
// fill, so a purely config-based budget isn't enough on its own to
// avoid over-committing real funds.
// -------------------------------------------------------------
async function runGridAutoScan(){
  const f = fu();
  if(!f.tbAutoScanEnabled || f.tbDailyHalted) return;
  // Re-entrancy guard: a grid deployment places its levels one sequential,
  // awaited API call at a time (can take well over one TRADING_BOTS_CYCLE_MS
  // tick for a large grid), but setInterval doesn't wait for that to finish
  // before firing the next cycle. Without this guard, a second cycle could
  // start scanning/deploying while the first bot is still mid-deployment,
  // which is how Max Concurrent Auto Bots got bypassed.
  if(f.tbDeployInProgress) return;
  const cfg = f.tbAutoScanConfig;
  const exchange = f.tbAutoScanExchange;
  // Count 'deploying' bots (orders still being placed) alongside 'active'
  // ones — a bot must reserve its slot the moment it's created, not only
  // once every level has posted, or two overlapping cycles can each think
  // a slot is free and deploy their own bot for the same slot.
  const activeAutoCount = f.tradingBots.filter(b => (b.status === 'active' || b.status === 'deploying') && b.type === 'grid' && b.config?.autoScan).length;
  if(activeAutoCount >= cfg.maxConcurrent){
    tbAutoScanStatus(`${activeAutoCount}/${cfg.maxConcurrent} auto bot slots in use — waiting for one to close before scanning for the next.`);
    return;
  }
  const mode = f.liveModeByExchange[exchange] || 'live';
  const cred = liveCred(exchange, mode);
  if(!cred){ tbAutoScanStatus(`No verified ${exchange} ${mode} credential anymore — pausing auto-scan.`); return; }

  const proxyArgsBal = { exchange, mode, apiKey: cred.apiKey, secretKey: cred.secretKey, passphrase: cred.passphrase };
  const marginProbe = await checkAvailableMarginFor(proxyArgsBal, 0); // always fetch real free margin first — pct mode needs it to size perBotUsd at all, USDT mode still needs it to verify
  if(marginProbe.available == null){
    tbAutoScanStatus(`Could not read free margin on ${exchange} right now — will retry next cycle.`);
    return;
  }
  // Same self-resolving logic as the manual-deploy path: % mode sizes the
  // total budget off real, current free margin, so it automatically shrinks
  // while other auto bots have margin locked up and grows again the moment
  // one closes or you add funds — no manual re-entry needed either way.
  const totalBudget = cfg.investmentMode === 'pct' ? marginProbe.available * (cfg.investmentPct / 100) : cfg.investmentUsd;
  const perBotUsd = totalBudget / Math.max(1, cfg.maxConcurrent);
  if(!(perBotUsd > 0) || perBotUsd > marginProbe.available){
    tbAutoScanStatus(`Waiting on free margin — this bot needs ~${fmtUsd(perBotUsd)} but only ${fmtUsd(marginProbe.available)} is free on ${exchange} right now.`);
    return;
  }

  const cursor = f.tbAutoScanCursor % GRID_SYMBOLS.length;
  const batchSize = Math.min(GRID_SCAN_BATCH_SIZE, GRID_SYMBOLS.length);
  const candidates = Array.from({ length: batchSize }, (_, i) => GRID_SYMBOLS[(cursor + i) % GRID_SYMBOLS.length]);
  f.tbAutoScanCursor = (cursor + batchSize) % GRID_SYMBOLS.length;

  // Skip symbols already running as ANY active bot on this exchange —
  // auto-scan shouldn't pile a second deployment onto a symbol you (or
  // it) already has open.
  const busySymbols = new Set(f.tradingBots.filter(b => (b.status === 'active' || b.status === 'deploying') && b.exchange === exchange).map(b => b.symbol));

  let bestReject = null;
  for(const symbol of candidates){
    if(busySymbols.has(symbol)) continue;
    const snap = await fetchLiveSnapshot(exchange, symbol, '5m').catch(() => null);
    if(!snap) continue;
    const regime = classifyRegime(snap.h1, snap.m15);
    const suitability = scoreGridSuitability(snap, regime, { ...GRID_DEFAULTS, minGridScore: cfg.minGridScore });
    if(!bestReject || suitability.score > bestReject.score) bestReject = { symbol, score: suitability.score, regime: regime.regime };
    if(!suitability.regimeOk || suitability.score < cfg.minGridScore) continue;

    const range = suggestGridRange(snap, regime);
    const plan = buildManualGridPlan({ symbol, direction: 'NEUTRAL', upper: range.upper, lower: range.lower, levelCount: cfg.levelCount, leverage: cfg.leverage, investmentUsd: perBotUsd });
    if(!plan) continue;

    const bot = {
      id: newTradingBotId('grid'), type: 'grid', exchange, mode, symbol,
      createdAtMs: Date.now(), status: 'deploying', statusMessage: 'Deploying (auto-scan)…', statusIsError: false,
      realizedUsd: 0, direction: 'NEUTRAL', investmentUsd: perBotUsd, leverage: cfg.leverage,
      config: { ...cfg, autoScan: true }, plan, runtime: { levels: [], longStopSet: false, shortStopSet: false },
    };
    f.tradingBots.push(bot);
    f.tbDayAnchorInvestmentUsd += bot.investmentUsd;
    renderTradingBotsList();
    renderTradingBotsDailyLimits();
    tbAutoScanStatus(`Found ${symbol} — score ${suitability.score}/100, regime ${regime.regime}. Deploying…`);
    f.tbDeployInProgress = true;
    try{
      await deployGridBotInstance(bot, cred);
    } finally {
      f.tbDeployInProgress = false;
    }
    if(!f.tradingBotsRunning) toggleTradingBotsRunning();
    return;
  }
  tbAutoScanStatus(`Scanned ${candidates.join(', ')} — none suitable this cycle${bestReject ? ` (closest: ${bestReject.symbol} at ${bestReject.score}/${cfg.minGridScore}, regime ${bestReject.regime})` : ''}. ${activeAutoCount}/${cfg.maxConcurrent} slots in use.`);
}

async function runTradingBotsCycle(){
  const f = fu();
  rollTradingBotsDay(Date.now());
  const activeBots = f.tradingBots.filter(b => b.status === 'active');
  for(const bot of activeBots){
    const cred = liveCred(bot.exchange, bot.mode);
    if(!cred){ tradingBotLog(bot, `No verified ${bot.exchange} ${bot.mode} credential anymore — check your connection.`, true); continue; }
    try{
      if(bot.type === 'grid') await manageGridBotInstance(bot, cred, Date.now());
      else await manageDcaBotInstance(bot, cred, Date.now());
    }catch(err){
      tradingBotLog(bot, `Unexpected error managing this bot: ${err.message}`, true);
    }
  }
  if(f.tbAutoScanEnabled){
    try{ await runGridAutoScan(); }
    catch(err){ tbAutoScanStatus(`Auto-scan error: ${err.message}`); }
  }
  renderTradingBotsList();
  renderTradingBotsDailyLimits();
  if(!f.tbAutoScanEnabled && f.tradingBots.every(b => b.status !== 'active') && f.tradingBotsRunning){
    toggleTradingBotsRunning(); // nothing left to manage and not scanning — stop polling until the next bot/scan starts it again
  }
}

function toggleTradingBotsRunning(){
  const f = fu();
  f.tradingBotsRunning = !f.tradingBotsRunning;
  if(f.tradingBotsRunning){
    f.tradingBotsTimer = setInterval(runTradingBotsCycle, TRADING_BOTS_CYCLE_MS);
  } else if(f.tradingBotsTimer){
    clearInterval(f.tradingBotsTimer); f.tradingBotsTimer = null;
  }
}

async function stopTradingBot(id){
  const f = fu();
  const bot = f.tradingBots.find(b => b.id === id);
  if(!bot) return;
  const cred = liveCred(bot.exchange, bot.mode);
  if(cred){
    const proxyArgs = { exchange: bot.exchange, mode: bot.mode, apiKey: cred.apiKey, secretKey: cred.secretKey, passphrase: cred.passphrase, symbol: bot.symbol };
    const path = bot.type === 'grid' ? '/api/futures/grid/flatten' : '/api/futures/dca/flatten';
    const result = await callProxy(path, proxyArgs).catch(err => ({ ok:false, message: err.message }));
    if(!result.ok) tradingBotLog(bot, `Stop/flatten failed: ${result.message} — check ${bot.symbol} on ${bot.exchange} directly.`, true);
    else tradingBotLog(bot, 'Stopped — all resting orders cancelled, any open position closed.', false);
  }
  bot.status = 'stopped';
  if(f.tradingBots.every(b => b.status !== 'active') && f.tradingBotsRunning) toggleTradingBotsRunning();
  renderTradingBotsList();
}

function deleteTradingBot(id){
  const f = fu();
  const bot = f.tradingBots.find(b => b.id === id);
  if(bot && bot.status === 'active'){ tradingBotLog(bot, 'Stop this bot before deleting it.', true); return; }
  f.tradingBots = f.tradingBots.filter(b => b.id !== id);
  renderTradingBotsList();
}

// -------------------------------------------------------------
// Trading Bots list + Details view — styled after the native
// Bybit "My Bots" card / bot-details layout the person asked to match:
// a card per bot (icon, symbol, type/direction badges, status dot,
// Details/Stop/Delete), and a Details overlay with Status/Orders/
// History tabs, a metrics grid and a Parameters block.
//
// Every value shown here comes from data this app actually tracks
// (bot.realizedUsd, bot.runtime.unrealizedUsd/markPrice, the plan
// object, and the per-cycle records in the persistent trade log
// filtered by gridId === bot.id). Fields the app has no real source
// for yet (exchange margin rates, taker/maker fees paid, withdrawals —
// there's no Withdraw feature) are shown as "—" rather than invented,
// same convention Bybit's own UI uses for an unset TP/SL ("--").
// -------------------------------------------------------------

function fmtBotUptime(startMs){
  if(!startMs) return '0D 0h 0m';
  const ms = Math.max(0, Date.now() - startMs);
  const totalMin = Math.floor(ms / 60000);
  const d = Math.floor(totalMin / 1440), h = Math.floor((totalMin % 1440) / 60), m = totalMin % 60;
  return `${d}D ${h}h ${m}m`;
}

function fmtBotDateTime(ms){
  if(!ms) return '—';
  const d = new Date(ms);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// This bot's own closed cycles — appendPersistentTrade tags every record
// with gridId: bot.id, so filtering the shared log by that is the real
// per-bot order/history feed, not a separate store to keep in sync.
function getBotTradeRecords(bot){
  return loadPersistentTradeLog().filter(t => t.gridId === bot.id);
}

function computeBotMetrics(bot){
  const records = getBotTradeRecords(bot);
  const wins = records.filter(r => (r.netUsd || 0) > 0).length;
  const uPnl = bot.runtime?.unrealizedUsd;
  const totalPnl = bot.realizedUsd + (uPnl || 0);
  const equity = (bot.investmentUsd || 0) + totalPnl;
  const elapsedMs = bot.runtime?.openedAtMs ? Math.max(1, Date.now() - bot.runtime.openedAtMs) : null;
  const aprPct = elapsedMs && bot.investmentUsd ? (totalPnl / bot.investmentUsd) * (31536000000 / elapsedMs) * 100 : null;
  return {
    records, wins, uPnl, totalPnl, equity, aprPct,
    pctOfInvestment: bot.investmentUsd ? (totalPnl / bot.investmentUsd) * 100 : null,
  };
}

function pnlSpan(usd, pct){
  if(usd == null) return `<span style="color:var(--dim);">—</span>`;
  const color = usd > 0 ? 'var(--green)' : usd < 0 ? 'var(--red)' : 'var(--dim)';
  const pctBadge = pct != null ? `<span style="font-size:10.5px;padding:1px 6px;border-radius:5px;background:${usd >= 0 ? 'var(--green-soft)' : 'var(--red-soft)'};color:${color};margin-left:6px;">${usd >= 0 ? '+' : ''}${pct.toFixed(2)}%</span>` : '';
  return `<strong style="color:${color};">${fmtUsd(usd)}</strong>${pctBadge}`;
}

function tbTypeBadgeLabel(bot){ return bot.type === 'grid' ? 'Futures Grid Bot' : 'DCA Bot'; }
function tbDirBadgeLabel(bot){ return `${bot.direction === 'NEUTRAL' ? 'Neutral' : bot.direction === 'LONG' ? 'Long' : 'Short'} ${bot.leverage}x`; }

function renderTradingBotsList(){
  if(!els.fuTradingBotsList) return;
  const f = fu();
  if(els.fuTradingBotsBadge) els.fuTradingBotsBadge.textContent = `${f.tradingBots.filter(b => b.status === 'active').length} active`;
  if(f.tradingBots.length === 0){
    els.fuTradingBotsList.innerHTML = `<div style="font-size:12px;color:var(--dim);padding:8px 0;">No bots created yet.</div>`;
  } else {
    els.fuTradingBotsList.innerHTML = [...f.tradingBots].reverse().map(bot => {
      const m = computeBotMetrics(bot);
      const statusColor = bot.status === 'active' ? 'var(--green)' : bot.status === 'error' ? 'var(--red)' : 'var(--dim)';
      const priceRange = bot.plan && bot.plan.lower != null ? `${bot.plan.lower.toLocaleString()} - ${bot.plan.upper.toLocaleString()}` : '—';
      return `
      <div class="tb-card">
        <div class="tb-card-head">
          <div class="tb-card-id">
            <div class="tb-icon">${icon(bot.type === 'grid' ? 'rows' : 'refresh-cw')}</div>
            <div>
              <div class="tb-card-title">
                <strong>${bot.symbol}</strong>
                <span class="tb-badge">${tbTypeBadgeLabel(bot)}</span>
                <span class="tb-badge tb-badge-dir">${tbDirBadgeLabel(bot)}</span>
              </div>
              <div class="tb-card-sub">
                <span class="dot ${bot.status === 'active' ? 'live' : bot.status === 'error' ? 'err' : ''}" style="${bot.status !== 'active' && bot.status !== 'error' ? 'background:var(--dim2);' : ''}"></span>
                <span style="color:${statusColor};text-transform:capitalize;">${bot.status}</span>
                <span style="color:var(--dim2);">· ${fmtBotUptime(bot.createdAtMs)} · ${EXCHANGE_DISPLAY_NAMES[bot.exchange] || bot.exchange} (${bot.mode})</span>
              </div>
            </div>
          </div>
          <div class="tb-card-actions">
            <button type="button" class="primary ghost tb-details-btn" data-id="${bot.id}">Details</button>
            ${bot.status === 'active' ? `<button type="button" class="primary ghost tb-stop-btn" data-id="${bot.id}">Terminate</button>` : `<button type="button" class="primary ghost tb-delete-btn" data-id="${bot.id}">Delete</button>`}
          </div>
        </div>
        <div class="tb-stats-row">
          <div class="tb-stat"><span class="l">Investment (USDT)</span><span class="n">${bot.investmentUsd != null ? bot.investmentUsd.toFixed(2) : '—'}</span></div>
          <div class="tb-stat"><span class="l">Total P&amp;L (USDT)</span><span class="n">${pnlSpan(m.totalPnl, m.pctOfInvestment)}</span></div>
          <div class="tb-stat"><span class="l">Price Range (USDT)</span><span class="n" style="font-size:13px;">${priceRange}</span></div>
          <div class="tb-stat"><span class="l">Grids</span><span class="n">${bot.plan?.levelCount ?? '—'}</span></div>
          <div class="tb-stat"><span class="l">Profitable Trades</span><span class="n">${m.wins}</span></div>
        </div>
        <div class="tb-card-log">${bot.statusMessage || ''}</div>
      </div>
    `;
    }).join('');
  }
  renderTradingBotDetailsModal();
}

// -------------------------------------------------------------
// Details overlay — one root div, appended to <body> once, re-rendered
// on every renderTradingBotsList() so it stays live while open (same
// data source as the cards, just laid out like Bybit's bot-details page).
// -------------------------------------------------------------
function ensureTradingBotDetailsRoot(){
  let root = document.getElementById('tbDetailsRoot');
  if(root) return root;
  root = document.createElement('div');
  root.id = 'tbDetailsRoot';
  document.body.appendChild(root);
  root.addEventListener('click', async (e) => {
    if(e.target.classList.contains('tb-modal-overlay') || e.target.classList.contains('tb-modal-close')){
      closeTradingBotDetails(); return;
    }
    if(e.target.classList.contains('tb-modal-tab')){
      fu().tbDetailsTab = e.target.dataset.tab; renderTradingBotDetailsModal(); return;
    }
    if(e.target.classList.contains('tb-stop-btn')){ await stopTradingBot(e.target.dataset.id); return; }
    if(e.target.classList.contains('tb-delete-btn')){ deleteTradingBot(e.target.dataset.id); closeTradingBotDetails(); return; }
  });
  return root;
}

function openTradingBotDetails(id){
  const f = fu();
  f.tbDetailsOpenId = id;
  f.tbDetailsTab = 'status';
  renderTradingBotDetailsModal();
}

function closeTradingBotDetails(){
  const f = fu();
  f.tbDetailsOpenId = null;
  renderTradingBotDetailsModal();
}

function renderTradingBotDetailsModal(){
  const root = ensureTradingBotDetailsRoot();
  const f = fu();
  const bot = f.tradingBots.find(b => b.id === f.tbDetailsOpenId);
  if(!bot){ root.innerHTML = ''; return; }
  const tab = f.tbDetailsTab || 'status';
  const m = computeBotMetrics(bot);
  const statusColor = bot.status === 'active' ? 'var(--green)' : bot.status === 'error' ? 'var(--red)' : 'var(--dim)';
  const isGrid = bot.type === 'grid';
  const openLegs = isGrid ? (bot.runtime?.levels || []).filter(l => l.status === 'PENDING_CLOSE' || l.status === 'PENDING_ENTRY') : [];

  const metric = (label, value) => `<div class="tb-metric"><span class="l">${label}</span><span class="v">${value}</span></div>`;
  const statusTabHtml = `
    <div class="tb-metrics-grid">
      ${metric('Investment (USDT)', bot.investmentUsd != null ? bot.investmentUsd.toFixed(2) : '—')}
      ${metric('Equity (USDT)', m.equity != null ? m.equity.toFixed(2) : '—')}
      ${metric('Total P&L (USDT)', pnlSpan(m.totalPnl, m.pctOfInvestment))}
      ${metric('Current P&L (USDT)', m.uPnl == null ? '<span style="color:var(--dim);">—</span>' : pnlSpan(m.uPnl, bot.investmentUsd ? (m.uPnl / bot.investmentUsd) * 100 : null))}
      ${metric('Grid Profit (USDT)', bot.realizedUsd != null ? bot.realizedUsd.toFixed(2) : '—')}
      ${metric('Grid APR', m.aprPct != null ? `${m.aprPct.toFixed(2)}%` : '—')}
      ${metric('Profitable Trades', m.wins)}
      ${metric('Previously Withdrawn Amount (USDT)', '0')}
      ${metric('Taker/Maker Fees', '—')}
      ${metric('Bot ID', bot.id)}
      ${metric('Start-up time', fmtBotDateTime(bot.createdAtMs))}
    </div>
    <div class="tb-params-head">Parameters</div>
    <div class="tb-metrics-grid">
      ${isGrid ? `
        ${metric('Original price range (USDT)', bot.plan?.lower != null ? `${bot.plan.lower.toLocaleString()} - ${bot.plan.upper.toLocaleString()}` : '—')}
        ${metric('Price Range (USDT)', bot.plan?.lower != null ? `${bot.plan.lower.toLocaleString()} - ${bot.plan.upper.toLocaleString()}` : '—')}
        ${metric('Grids', bot.plan?.levelCount != null ? `${bot.plan.levelCount} (Arithmetic)` : '—')}
        ${metric('Mark Price (USDT)', bot.runtime?.markPrice != null ? bot.runtime.markPrice.toLocaleString() : '—')}
        ${metric('Entry price', '—')}
        ${metric('TP/SL', '--/--')}
        ${metric('Current position', '—')}
        ${metric('Initial Margin Rate', '—')}
        ${metric('Maintenance Margin Rate', '—')}
      ` : `
        ${metric('Base / Safety Order (USDT)', `${bot.plan?.baseOrderUsd ?? '—'} / ${bot.plan?.safetyOrderUsd ?? '—'}`)}
        ${metric('Safety Orders Filled', `${(bot.runtime?.safetyOrders || []).filter(s => s.status === 'FILLED').length}/${bot.plan?.safetyLevels?.length ?? '—'}`)}
        ${metric('Mark Price (USDT)', '—')}
        ${metric('Entry price (avg)', bot.runtime?.avgEntryPrice != null ? bot.runtime.avgEntryPrice.toLocaleString() : '—')}
        ${metric('TP/SL', `${bot.plan?.takeProfitPct ?? '--'}% / ${bot.plan?.stopLossPct || '--'}%`)}
        ${metric('Current position', bot.runtime?.totalQty != null ? bot.runtime.totalQty : '—')}
        ${metric('Initial Margin Rate', '—')}
        ${metric('Maintenance Margin Rate', '—')}
      `}
    </div>
  `;

  const ordersTabHtml = isGrid && openLegs.length ? `
    <table class="tb-orders-table"><thead><tr><th>Level</th><th>Direction</th><th>Status</th><th>Entry</th><th>Target</th></tr></thead>
    <tbody>${openLegs.map(l => `<tr><td>${l.levelIndex}</td><td>${l.direction}</td><td>${l.status}</td><td>${l.price != null ? l.price.toLocaleString() : '—'}</td><td>${l.targetPrice != null ? l.targetPrice.toLocaleString() : '—'}</td></tr>`).join('')}</tbody></table>
  ` : `<div style="font-size:12px;color:var(--dim);padding:20px 0;text-align:center;">No open legs right now.</div>`;

  const historyTabHtml = m.records.length ? `
    <table class="tb-orders-table"><thead><tr><th>Closed</th><th>Side</th><th>Entry</th><th>Exit</th><th>Net (USDT)</th></tr></thead>
    <tbody>${m.records.slice(0, 50).map(r => `<tr><td>${fmtBotDateTime(r.closedAtMs)}</td><td>${r.side || r.direction || '—'}</td><td>${r.entry != null ? r.entry.toLocaleString() : '—'}</td><td>${r.exit != null ? r.exit.toLocaleString() : '—'}</td><td style="color:${(r.netUsd || 0) >= 0 ? 'var(--green)' : 'var(--red)'};">${fmtUsd(r.netUsd || 0)}</td></tr>`).join('')}</tbody></table>
  ` : `<div style="font-size:12px;color:var(--dim);padding:20px 0;text-align:center;">No closed cycles yet.</div>`;

  root.innerHTML = `
    <div class="tb-modal-overlay">
      <div class="tb-modal">
        <div class="tb-modal-head">
          <div class="tb-card-id">
            <div class="tb-icon">${icon(isGrid ? 'rows' : 'refresh-cw')}</div>
            <div>
              <div class="tb-card-title">
                <strong>${bot.symbol}</strong>
                <span class="tb-badge">${tbTypeBadgeLabel(bot)}</span>
                <span class="tb-badge tb-badge-dir">${tbDirBadgeLabel(bot)}</span>
              </div>
              <div class="tb-card-sub">
                <span class="dot ${bot.status === 'active' ? 'live' : bot.status === 'error' ? 'err' : ''}" style="${bot.status !== 'active' && bot.status !== 'error' ? 'background:var(--dim2);' : ''}"></span>
                <span style="color:${statusColor};text-transform:capitalize;">${bot.status}</span>
                <span style="color:var(--dim2);">· ${fmtBotUptime(bot.createdAtMs)}</span>
              </div>
            </div>
          </div>
          <div class="tb-card-actions">
            ${bot.status === 'active' ? `<button type="button" class="primary ghost tb-stop-btn" data-id="${bot.id}">Terminate</button>` : `<button type="button" class="primary ghost tb-delete-btn" data-id="${bot.id}">Delete</button>`}
            <button type="button" class="tb-modal-close" title="Close" aria-label="Close">${icon('x')}</button>
          </div>
        </div>
        <div class="tb-tabs">
          <div class="tb-tab tb-modal-tab ${tab === 'status' ? 'on' : ''}" data-tab="status">Status</div>
          <div class="tb-tab tb-modal-tab ${tab === 'orders' ? 'on' : ''}" data-tab="orders">Orders</div>
          <div class="tb-tab tb-modal-tab ${tab === 'history' ? 'on' : ''}" data-tab="history">History</div>
        </div>
        <div class="tb-modal-body">
          ${tab === 'status' ? statusTabHtml : tab === 'orders' ? ordersTabHtml : historyTabHtml}
        </div>
      </div>
    </div>
  `;
}

// Resumes MONITORING (never new-order placement — f.liveArmed still
// resets to false on every load, unchanged) for any real position that
// was still open when the page last reloaded. See renderLive()'s
// saveLivePositions comment for why this exists: without it, reloading
// the page to pick up a site fix (or just an accidental refresh) silently
// stranded a real, live position — the app forgot it existed, so it never
// got monitored for TP2/breakeven or logged when it eventually closed.
function restoreLivePositions(){
  const saved = loadSavedLivePositions();
  const symbols = Object.keys(saved);
  if(!symbols.length) return;
  const f = fu();
  f.livePositions = saved;
  showLiveMessage(`Restored tracking for ${symbols.length} real position(s) still open from before this reload (${symbols.join(', ')}) — monitoring resumed. No new orders will be placed until you turn trading on.`, 'info');
  if(!f.liveRunning) toggleLiveRunning(); // starts the same polling loop the Live/Demo switch uses — runLiveCycleInner already treats "has an open position" as enough reason to poll, even while liveArmed is false
}

export function initFuturesEngine(){
  ensureDayState();
  if(els.fuStartingBalance) els.fuStartingBalance.value = String(fu().dayState.startingEquity);
  if(els.fuModeBtn) els.fuModeBtn.addEventListener('click', toggleRunning);
  if(els.fuResetSessionBtn) els.fuResetSessionBtn.addEventListener('click', resetSession);
  initRiskPctInputs();
  initLiveDailyProfitTargetInput();
  initLiveMaxDailyLossInput();
  initLiveTimeframeInput();
  setQuantProviders({
    paperLog: () => loadPaperTradeLog(), liveLog: () => loadPersistentTradeLog(),
    dayState: () => fu().dayState, liveStart: () => fu().liveStartingEquity,
  });
  setQuantConfigListener(() => renderStrategyRows()); // keeps the strategy card's RR dropdown in sync with the saved Quant RR
  initStrategySelector();
  initGridPanel();
  initTradingBots();
  initLiveTradingControls();
  initTradeLog();
  restoreLivePositions();
  renderLive();
  render();
}
