// =============================================================
// futures-ui.js — presentation layer for the AI Futures Engine tab.
// No strategy math happens here — everything is computed by
// js/futures/engine.js; this module only renders it and wires the
// settings controls / start-stop button.
//
// PAPER MODE ONLY. There is no LIVE MODE wiring in this build —
// see the architecture assessment: live execution needs a real
// backend (order routing, encrypted key storage, reconciliation)
// that this static-frontend + verify-only-proxy app does not have
// yet. The mode selector below is deliberately not switchable.
// =============================================================
import { els, state } from './state.js';
import { fmtPct } from './utils.js';
import { runScanCycle, openPosition, managePositions, recomputeOpenRisk } from './futures/engine.js';
import { mockMarket } from './futures/mockMarket.js';
import { RISK_DEFAULTS } from './futures/risk.js';
import { DEFAULT_WEIGHTS } from './futures/scoring.js';

const CYCLE_MS = 4000; // one synthetic "cycle" every 4s; each cycle advances the mock clock by a few minutes

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
  render();
}
