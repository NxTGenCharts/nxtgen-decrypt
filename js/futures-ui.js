// =============================================================
// futures-ui.js — presentation layer for the AI Futures Engine tab.
// No strategy math happens here — everything is computed by
// js/futures/engine.js; this module only renders it and wires the
// settings controls / start-stop buttons.
//
// Two independent trading loops live in this file:
// - runCycle() — Paper mode, unchanged from before, always available,
//   trades against the synthetic feed in js/futures/mockMarket.js.
// - runLiveCycle() — Live/Demo mode, Bybit and Binance so far. Runs the
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
import { runScanCycle, openPosition, managePositions, recomputeOpenRisk } from './futures/engine.js';
import { mockMarket } from './futures/mockMarket.js';
import { RISK_DEFAULTS } from './futures/risk.js';
import { DEFAULT_WEIGHTS } from './futures/scoring.js';
import { computeBtcShock } from './futures/indicators.js';

const CYCLE_MS = 4000; // one synthetic "cycle" every 4s; each cycle advances the mock clock by a few minutes
const LIVE_CYCLE_MS = 8000; // real API calls — a slower, deliberately conservative cadence than Paper's
// A smaller, curated watchlist than Paper's full 35 symbols — keeps real
// API call volume reasonable and every symbol here is liquid enough that
// the spread/liquidity gates in noTradeEngine.js should rarely be the
// thing standing between a real signal and a trade. Must include
// BTCUSDT: the shock filter (see runLiveCycle) reads it directly.
const LIVE_WATCHLIST = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'ADAUSDT', 'AVAXUSDT', 'LINKUSDT', 'DOGEUSDT', 'LTCUSDT'];
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
  if(els.fuMinRR) f.minRiskReward = Number(els.fuMinRR.value) || 1.2;
  if(els.fuMinNetProfit) f.minNetProfitPct = Number(els.fuMinNetProfit.value) || 0.30;
  if(els.fuRiskPct) f.riskPctPerTrade = Number(els.fuRiskPct.value) || 1.0;
  if(els.fuLeverage) f.leverage = Number(els.fuLeverage.value) || 2;
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
// Live/Demo trading (Bybit and Binance so far). Separate state, separate stats,
// separate history from Paper above — nothing here touches dayState/
// tradeHistory, and Paper keeps running unaffected regardless of
// whether Live/Demo is armed or not.
// =============================================================

const LIVE_TRADEABLE_EXCHANGES = ['bybit', 'binance', 'gateio']; // extend as more get wired up server-side

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

function liveCred(exchange){
  const mode = fu().liveMode;
  if(mode === 'paper') return null;
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
  };
}

async function runLiveCycle(){
  const f = fu();
  if(f.liveMode === 'paper' || !f.liveArmed) return;

  // 1) Check whatever we're already tracking as open, for closure — using
  // EACH position's own tracked exchange/credential, not necessarily
  // whatever the Exchange dropdown currently shows. If that were keyed
  // off the current dropdown instead, switching exchanges while a
  // position from a different one is still open would query the wrong
  // exchange for it and silently stop monitoring the real position.
  for(const symbol of Object.keys(f.livePositions)){
    const tracked = f.livePositions[symbol];
    const posCred = liveCred(tracked.exchange);
    if(!posCred) continue; // can't check right now (key disconnected?) — leave it tracked, try again next cycle
    try{
      const data = await callProxy('/api/futures/position', { exchange: tracked.exchange, mode: f.liveMode, apiKey: posCred.apiKey, secretKey: posCred.secretKey, passphrase: posCred.passphrase, symbol, openedAtMs: tracked.openedAtMs });
      if(!data.ok) continue; // transient error — leave it tracked, try again next cycle
      if(!data.open){
        const closed = data.closed;
        const netUsd = closed ? closed.closedPnl : 0;
        f.liveTradeHistory.unshift({
          closedAtMs: Date.now(), time: new Date().toLocaleTimeString(), exchange: tracked.exchange, symbol, side: tracked.side,
          entry: closed && closed.avgEntryPrice != null ? closed.avgEntryPrice : tracked.entry,
          exit: closed && closed.avgExitPrice != null ? closed.avgExitPrice : null,
          leverage: tracked.leverage, qty: tracked.qty, netUsd, orderId: tracked.orderId,
        });
        f.liveTrades++;
        f.liveNetPnlUsd += netUsd;
        delete f.livePositions[symbol];
      } else if(els.fuLiveOpenPosition){
        els.fuLiveOpenPosition.textContent = `[${tracked.exchange}] ${symbol} ${data.position.side} ${data.position.size} @ ${data.position.avgPrice} (uPnL ${fmtUsd(data.position.unrealisedPnl)})`;
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

  const exchange = els.fuExchange ? els.fuExchange.value : f.exchange;
  if(!LIVE_TRADEABLE_EXCHANGES.includes(exchange)){
    showLiveMessage(`Exchange above is set to "${exchange}", but Live/Demo trading only supports ${LIVE_TRADEABLE_EXCHANGES.join(' and ')} so far. Paper mode can still simulate the others.`, 'error');
    return;
  }
  const cred = liveCred(exchange);
  if(!cred){
    showLiveMessage(`No verified ${exchange} ${f.liveMode} key found — connect and verify one in Autotrade & Balances first.`, 'error');
    return;
  }

  let equity;
  try{
    const balData = await callProxy('/api/futures/balance', { exchange, mode: f.liveMode, apiKey: cred.apiKey, secretKey: cred.secretKey, passphrase: cred.passphrase });
    if(!balData.ok) throw new Error(balData.message || 'Balance check failed.');
    equity = balData.balance;
  }catch(err){
    showLiveMessage(`Could not read the real ${exchange} futures balance: ${err.message}`, 'error');
    return;
  }
  if(els.fuLiveBalance) els.fuLiveBalance.textContent = '$' + equity.toLocaleString('en-US', { minimumFractionDigits:2, maximumFractionDigits:2 });

  // Fetch real snapshots for the whole watchlist in parallel; a symbol
  // whose fetch fails just gets skipped this cycle (runScanCycle already
  // tolerates a null snapshot — see engine.js), not treated as fatal.
  const snapshots = {};
  await Promise.all(LIVE_WATCHLIST.map(async symbol => {
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
    minConfidence: f2.minConfidence, minRiskReward: f2.minRiskReward, minNetProfitPct: f2.minNetProfitPct,
    riskPctPerTrade: f2.riskPctPerTrade, leverage: f2.leverage,
  };
  const dayStateShim = buildLiveDayStateShim(equity);
  const { rows } = runScanCycle(cfg, dayStateShim, {
    symbols: LIVE_WATCHLIST,
    getSnapshot: symbol => snapshots[symbol] || null,
    now: () => Date.now(),
    getBtcShock: () => computeBtcShock(snapshots.BTCUSDT.m5),
  });
  renderScanner(rows); // reuse the same scanner table Paper mode renders into — it's one shared "what did the scan just find" view

  const approved = rows.find(r => r.status === 'APPROVED');
  if(!approved){
    showLiveMessage(`Armed on ${exchange}, watching ${LIVE_WATCHLIST.length} symbols — no qualifying signal this cycle.`);
    return;
  }

  const side = approved.direction === 'LONG' ? 'Buy' : 'Sell'; // server normalizes casing per exchange — see FUTURES_SIDE_CASING in server.js
  const openedAtMs = Date.now();
  try{
    showLiveMessage(`Placing a real ${f.liveMode} order on ${exchange}: ${approved.symbol} ${side} @ ~${approved.entry}…`);
    const result = await callProxy('/api/futures/order', {
      exchange, mode: f.liveMode, apiKey: cred.apiKey, secretKey: cred.secretKey, passphrase: cred.passphrase,
      symbol: approved.symbol, side, qty: approved.sizing.qty, leverage: cfg.leverage,
      stopLossPrice: approved.stop, takeProfitPrice: approved.tp1,
    });
    if(!result.ok){
      showLiveMessage(`Order rejected: ${result.message}`, 'error');
      return;
    }
    f.livePositions[approved.symbol] = {
      exchange, orderId: result.orderId, side, qty: result.filledQty, entry: result.avgPrice,
      leverage: result.leverage, stopLossPrice: result.stopLossPrice, takeProfitPrice: result.takeProfitPrice,
      riskAmountUsd: approved.sizing.riskAmountUsd, openedAtMs,
    };
    showLiveMessage(`Real ${f.liveMode} position opened: ${approved.symbol} ${side} ${result.filledQty} @ ${result.avgPrice}, SL ${result.stopLossPrice} / TP ${result.takeProfitPrice} (order ${result.orderId}).`);
  }catch(err){
    showLiveMessage(`Order failed: ${err.message}`, 'error');
  }
  renderLive();
}

function renderLiveHistory(){
  if(!els.fuLiveHistoryRows) return;
  const history = fu().liveTradeHistory;
  if(!history.length){ els.fuLiveHistoryRows.innerHTML = '<div class="fu-empty">No live/demo trades yet this session.</div>'; return; }
  els.fuLiveHistoryRows.innerHTML = history.slice(0, 50).map(t => `
    <div class="fu-hrow ${t.netUsd >= 0 ? 'fu-win' : 'fu-loss'}" style="grid-template-columns:.7fr 1fr 1fr .6fr .8fr .8fr .5fr .7fr .8fr 1.4fr;">
      <div>${t.time}</div>
      <div>${t.exchange || '—'}</div>
      <div>${t.symbol}</div>
      <div>${t.side}</div>
      <div>${t.entry != null ? Number(t.entry).toFixed(4) : '—'}</div>
      <div>${t.exit != null ? Number(t.exit).toFixed(4) : '—'}</div>
      <div>${t.leverage}x</div>
      <div>${t.qty}</div>
      <div>${fmtUsd(t.netUsd)}</div>
      <div style="font-size:11px;color:var(--dim);">${t.orderId}</div>
    </div>
  `).join('');
}

function renderLive(){
  const f = fu();
  if(els.fuLiveTrades) els.fuLiveTrades.textContent = String(f.liveTrades);
  if(els.fuLiveNetPnl) els.fuLiveNetPnl.textContent = fmtUsd(f.liveNetPnlUsd);
  if(Object.keys(f.livePositions).length === 0 && els.fuLiveOpenPosition) els.fuLiveOpenPosition.textContent = 'None';
  renderLiveHistory();
}

function updateLiveModeUI(){
  const f = fu();
  if(els.fuLiveArmWrap) els.fuLiveArmWrap.style.display = f.liveMode === 'paper' ? 'none' : '';
  if(f.liveMode === 'paper'){
    showLiveMessage('Paper only — nothing real will be traded');
  } else if(!f.liveArmed){
    showLiveMessage(`${f.liveMode === 'live' ? 'Live' : 'Demo'} mode selected but not armed — check the box and type the phrase below to arm.`);
  } else {
    const currentExchange = els.fuExchange ? els.fuExchange.value : f.exchange;
    showLiveMessage(`Armed for ${f.liveMode === 'live' ? 'LIVE (real funds)' : 'Demo'} trading on ${currentExchange}.`);
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

function initLiveTradingControls(){
  if(els.fuLiveMode){
    els.fuLiveMode.addEventListener('change', () => {
      const f = fu();
      // Arming never survives a mode change — re-arming for a different
      // mode (e.g. Demo -> Live) is a decision that has to be made again,
      // deliberately, every time. Session stats reset too: Demo and Live
      // are different accounts with different balances — carrying one's
      // numbers into the other's display would be actively misleading.
      if(f.liveRunning) toggleLiveRunning();
      f.liveMode = els.fuLiveMode.value;
      f.liveArmed = false;
      f.liveStartingEquity = null;
      f.liveTrades = 0;
      f.liveNetPnlUsd = 0;
      f.liveTradeHistory = [];
      f.livePositions = {};
      if(els.fuLiveConfirmCheck) els.fuLiveConfirmCheck.checked = false;
      if(els.fuLiveArmRow) els.fuLiveArmRow.style.display = 'none';
      if(els.fuLiveArmPhrase) els.fuLiveArmPhrase.value = '';
      updateLiveModeUI();
      renderLive();
    });
  }
  if(els.fuLiveConfirmCheck){
    els.fuLiveConfirmCheck.addEventListener('change', () => {
      if(els.fuLiveArmRow) els.fuLiveArmRow.style.display = els.fuLiveConfirmCheck.checked ? '' : 'none';
    });
  }
  if(els.fuLiveArmBtn){
    els.fuLiveArmBtn.addEventListener('click', () => {
      const f = fu();
      const currentExchange = els.fuExchange ? els.fuExchange.value : f.exchange;
      if(!LIVE_TRADEABLE_EXCHANGES.includes(currentExchange)){
        showLiveMessage(`Exchange above is set to "${currentExchange}" — switch it to one of: ${LIVE_TRADEABLE_EXCHANGES.join(', ')} before arming Live/Demo trading.`, 'error');
        return;
      }
      if(!liveCred(currentExchange)){
        showLiveMessage(`No verified ${currentExchange} ${f.liveMode} key found — connect and verify one in Autotrade & Balances first, then come back and arm.`, 'error');
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
  updateLiveModeUI();
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

export function initFuturesEngine(){
  ensureDayState();
  if(els.fuStartingBalance) els.fuStartingBalance.value = String(fu().dayState.startingEquity);
  if(els.fuModeBtn) els.fuModeBtn.addEventListener('click', toggleRunning);
  if(els.fuResetSessionBtn) els.fuResetSessionBtn.addEventListener('click', resetSession);
  initLiveTradingControls();
  renderLive();
  render();
}
