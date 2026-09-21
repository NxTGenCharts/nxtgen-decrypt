// =============================================================
// quant-ui.js — NxTGen Quant Futures' UI-side glue.
//
// There is no separate Quant configuration panel any more. The strategy is
// switched on and given its Reward:Risk in the normal Strategies list, and it
// takes the basic settings from the same controls every other strategy uses:
//   * Min confidence          -> the top "Min confidence" field
//   * Risk per trade          -> the top "Risk per trade (%)" field (Quant never
//                                exceeds its own 1% hard ceiling)
//   * Selectivity             -> the top "High Selectivity Mode" toggle
//   * Leverage / net-profit / exchange -> already shared with the top controls
// getQuantCfg() merges those shared values over the saved Quant-only settings
// (timeframe, symbols, loss limits, drawdown tiers, setups...) that no longer
// have inputs; those keep their defaults (or whatever was saved earlier).
//
// This file still owns: the Strategies-list stats line and the Backtest tab's
// validation section (separate stats, in/out-of-sample, Monte Carlo, walk-forward).
//   * Win rate is displayed ONLY through winRateLabel(), which returns
//     INSUFFICIENT SAMPLE below 30 trades. Paper / Live / Backtest are shown
//     separately and never blended.
// =============================================================
import { icon } from './icons.js';
import {
  MIN_SAMPLE_TRADES,
  loadQuantConfig, saveQuantConfig, sanitizeQuantConfig,
} from './futures/quant/config.js';
import { computeQuantStats, computeQuantStatsBySymbol, fromPaperLog, fromLiveLog, fromBacktest, winRateLabel } from './futures/quant/stats.js';
import { monteCarlo, splitInOutOfSample } from './futures/quant/validation.js';

let qcfg = loadQuantConfig();
let providers = { paperLog: () => [], liveLog: () => [], dayState: () => null, liveStart: () => null, liveTrades: () => [] };
let backtestResult = null; // { trades, startingEquity, ranAt } — in memory only (a backtest is a run, not a ledger)
let onConfigChange = () => {};

const usd = (x) => (x == null ? '—' : (x < 0 ? '-$' : '$') + Math.abs(x).toFixed(2));
const num = (x, d = 2) => (x == null || !Number.isFinite(x) ? '—' : x.toFixed(d));
const pf = (x) => (x == null ? '—' : (Number.isFinite(x) ? x.toFixed(2) : '∞'));

// ---- config access ----
// opts:
//   log              — enable the [QUANT] console log channel
//   minConfidence    — the page's shared Min confidence (overrides the saved Quant value)
//   riskPct          — the page's shared Risk per trade (%) (clamped to Quant's 1% ceiling by sanitize)
//   highSelectivity  — the page's shared High Selectivity toggle: true -> 'high' tier, false -> 'off'
// Anything not passed falls back to the saved Quant config. The result is always run through
// sanitizeQuantConfig, so a shared value can never widen a Quant hard limit.
export function getQuantCfg(opts){
  const o = opts || {};
  const shared = {};
  if(o.minConfidence != null) shared.minConfidence = o.minConfidence;
  if(o.riskPct != null) shared.riskPct = o.riskPct;
  if(o.highSelectivity != null) shared.selectivity = o.highSelectivity ? 'high' : 'off';
  return { ...sanitizeQuantConfig({ ...qcfg, ...shared }), log: !!o.log };
}
export function setQuantProviders(p){ providers = { ...providers, ...p }; }
export function setQuantConfigListener(fn){ onConfigChange = fn || (() => {}); }

export function updateQuantConfig(patch){
  qcfg = sanitizeQuantConfig({ ...qcfg, ...patch });
  saveQuantConfig(qcfg);
  onConfigChange(qcfg);
}
export function getQuantRewardRisk(){ return qcfg.rewardRisk; }

export function setQuantBacktestResult(trades, startingEquity){
  backtestResult = { trades: fromBacktest(trades), startingEquity, ranAt: Date.now() };
}

// ---- data assembly ----
function sourceStats(){
  const ds = providers.dayState();
  const paperStart = ds ? ds.startingEquity : 10000;
  const paper = computeQuantStats(fromPaperLog(providers.paperLog()), paperStart);
  const liveStart = providers.liveStart() || 10000;
  const live = computeQuantStats(fromLiveLog(providers.liveLog()), liveStart);
  const bt = backtestResult ? computeQuantStats(backtestResult.trades, backtestResult.startingEquity) : null;
  return { paper, live, bt };
}

// The one-liner shown inside the Strategies list card.
export function quantCardStatsLine(){
  const { paper, live } = sourceStats();
  const part = (name, s) => s.trades === 0
    ? `${name}: no trades yet`
    : (s.sufficient
      ? `${name}: ${s.trades} trades · ${s.winRate.toFixed(1)}% win rate · PF ${pf(s.profitFactor)} · ${usd(s.netUsd)} net`
      : `${name}: <span style="color:var(--amber);">INSUFFICIENT SAMPLE (${s.trades}/${MIN_SAMPLE_TRADES})</span> · ${usd(s.netUsd)} net`);
  return `${part('Paper', paper)} · ${part('Live/Demo', live)} · Backtest: ${backtestResult ? `${backtestResult.trades.length} trades (details in the Backtest tab)` : 'not run'} — target 58-65% win rate at 1:1.5 reward:risk (Trend Pullback only) is a design goal, not a result. Paper runs on the platform's synthetic feed; only Backtest/Live use real prices.`;
}

function statsTable(cols){
  const rows = [
    ['Total trades', s => s.trades],
    ['Win rate', s => (s.trades === 0 ? '—' : (s.sufficient ? `<b>${s.winRate.toFixed(1)}%</b>` : `<span style="color:var(--amber);">${winRateLabel(s)}</span>`))],
    ['Wins / Losses', s => `${s.wins} / ${s.losses}`],
    ['Avg win / Avg loss', s => `${usd(s.avgWinUsd)} / ${usd(s.avgLossUsd)}`],
    ['Profit factor', s => pf(s.profitFactor)],
    ['Expectancy ($ / R)', s => `${usd(s.expectancyUsd)} / ${s.expectancyR == null ? '—' : s.expectancyR.toFixed(2) + 'R'}`],
    ['RR: initial 1:x / realized payoff 1:x', s => `${num(s.avgInitialRR)} / ${num(s.realizedRR)}`],
    ['Avg win R / avg loss R', s => `${num(s.avgWinR)}R / ${num(s.avgLossR)}R`],
    ['Net profit / ROI', s => `${usd(s.netUsd)} / ${num(s.roiPct)}%`],
    ['Max / Avg drawdown', s => `${num(s.maxDrawdownPct)}% / ${num(s.avgDrawdownPct)}%`],
    ['Largest win / loss', s => `${usd(s.largestWinUsd)} / ${usd(s.largestLossUsd)}`],
    ['Max streak W / L', s => `${s.maxConsecWins} / ${s.maxConsecLosses}`],
    ['Sharpe / Sortino / Calmar', s => (s.sharpe == null ? '<span style="color:var(--dim);">needs ≥30 trades &amp; ≥10 days</span>' : `${num(s.sharpe)} / ${num(s.sortino)} / ${num(s.calmar)}`)],
    ['Recovery factor', s => num(s.recoveryFactor)],
    ['Fees / Funding / Slippage', s => `${usd(-s.feesUsd)} / ${usd(-s.fundingUsd)} / ${usd(-s.slippageUsd)}`],
  ];
  const head = `<tr><th style="text-align:left;padding:3px 8px;color:var(--dim);font-weight:600;"></th>${cols.map(c => `<th style="text-align:right;padding:3px 8px;color:var(--ink);">${c.name}</th>`).join('')}</tr>`;
  const body = rows.map(([label, fn]) => `<tr style="border-top:1px solid var(--line);"><td style="padding:3px 8px;color:var(--dim);">${label}</td>${cols.map(c => `<td style="text-align:right;padding:3px 8px;">${c.stats ? fn(c.stats) : '—'}</td>`).join('')}</tr>`).join('');
  return `<table style="width:100%;font-size:11.5px;border-collapse:collapse;">${head}${body}</table>`;
}

// ---- backtest validation section (rendered into the Backtest tab's results) ----
export function renderQuantBacktestSection(container, { trades, startingEquity, onWalkForward }){
  if(!container) return;
  const qt = fromBacktest(trades);
  if(!qt.length){
    container.innerHTML = '<div style="font-size:12px;color:var(--dim);">NxTGen Quant Futures took no trades in this backtest.</div>';
    return;
  }
  const all = computeQuantStats(qt, startingEquity);
  const { inSample, outOfSample } = splitInOutOfSample(qt, 0.7);
  const isS = computeQuantStats(inSample, startingEquity), oosS = computeQuantStats(outOfSample, startingEquity);
  const mc = monteCarlo(qt, startingEquity, { runs: 1000 });
  const bySymbol = computeQuantStatsBySymbol(qt, startingEquity);
  const bySymbolRows = bySymbol.map(({ symbol, stats: s }) => `<tr style="border-top:1px solid var(--line);">
      <td style="padding:3px 8px;">${symbol}</td>
      <td style="padding:3px 8px;text-align:right;">${s.trades}</td>
      <td style="padding:3px 8px;text-align:right;">${s.trades === 0 ? '—' : (s.sufficient ? `<b>${s.winRate.toFixed(1)}%</b>` : `<span style="color:var(--amber);">${s.observedWinRate.toFixed(1)}% (n=${s.trades})</span>`)}</td>
      <td style="padding:3px 8px;text-align:right;">${pf(s.profitFactor)}</td>
      <td style="padding:3px 8px;text-align:right;">${usd(s.netUsd)}</td></tr>`).join('');
  container.innerHTML = `
    <div class="ov-block-title" style="margin-top:0;">NxTGen Quant Futures — validation</div>
    <div style="font-size:11.5px;color:var(--dim);margin-bottom:8px;line-height:1.5;">
      The in-sample / out-of-sample split below is a chronological 70/30 split of THIS run's trades. Because the strategy's parameters are fixed (not fitted to this data) it is a stability check;
      the walk-forward button does true parameter selection on a training window and trades only the following unseen window.
    </div>
    ${statsTable([{ name: 'All trades', stats: all }, { name: 'In-sample (first 70%)', stats: isS }, { name: 'Out-of-sample (last 30%)', stats: oosS }])}
    <div class="ov-block-title" style="margin-top:14px;">By symbol — which pairs this is favorable on, in THIS run</div>
    <div style="font-size:11.5px;color:var(--dim);margin-bottom:6px;line-height:1.5;">
      Quant Futures only ever trades its own fixed symbol list (XRP/ADA/AVAX/LINK/DOT — BTC/ETH/SOL/LTC/DOGE/BNB are permanently excluded platform-wide). A win rate below 30 trades for a single
      symbol is shown as observed, not certified — the same MIN_SAMPLE_TRADES rule as everywhere else, just applied per symbol instead of to the total.
    </div>
    <table style="width:100%;font-size:11.5px;border-collapse:collapse;"><tr><th style="text-align:left;padding:3px 8px;color:var(--dim);font-weight:600;">Symbol</th><th style="text-align:right;padding:3px 8px;color:var(--ink);">Trades</th><th style="text-align:right;padding:3px 8px;color:var(--ink);">Win rate</th><th style="text-align:right;padding:3px 8px;color:var(--ink);">PF</th><th style="text-align:right;padding:3px 8px;color:var(--ink);">Net</th></tr>${bySymbolRows}</table>
    <div style="margin-top:10px;font-size:12px;line-height:1.6;">
      ${mc.ok ? `<b>Monte Carlo</b> (${mc.runs} bootstrap runs of ${mc.trades} trades): median return ${num(mc.returnPct.p50)}% (5th–95th pct ${num(mc.returnPct.p5)}% … ${num(mc.returnPct.p95)}%) · median max drawdown ${num(mc.maxDrawdownPct.p50)}% (95th pct ${num(mc.maxDrawdownPct.p95)}%) · profitable in ${num(mc.probProfit, 0)}% of runs · drawdown ≥ ${mc.ruinDdPct}% in ${num(mc.probDrawdownExceeds, 0)}% of runs
        <div style="color:var(--dim);font-size:10.5px;">${mc.caveat}</div>` : `<span style="color:var(--dim);">Monte Carlo: ${mc.reason}</span>`}
    </div>
    <div style="margin-top:10px;display:flex;gap:10px;align-items:center;flex-wrap:wrap;">
      <button type="button" id="qfWfBtn" class="primary ghost" style="font-size:12px;padding:6px 14px;">Run walk-forward validation</button>
      <span id="qfWfStatus" style="font-size:11.5px;color:var(--dim);">4 folds × 9-cell grid (min confidence 70/75/80 × RR 1.3/1.5/1.7). Re-runs the backtest many times — can take a while.</span>
    </div>
    <div id="qfWfResult" style="margin-top:10px;"></div>
  `;
  const btn = container.querySelector('#qfWfBtn');
  if(btn && onWalkForward){
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      const status = container.querySelector('#qfWfStatus');
      try{
        const wf = await onWalkForward((p) => { if(status) status.textContent = `Walk-forward… ${(p * 100).toFixed(0)}%`; });
        if(status) status.textContent = 'Done.';
        renderWalkForward(container.querySelector('#qfWfResult'), wf, startingEquity);
      }catch(err){
        if(status) status.textContent = `Walk-forward failed: ${err.message}`;
      }
      btn.disabled = false;
    });
  }
}

function renderWalkForward(el, wf, startingEquity){
  if(!el) return;
  if(!wf || !wf.ok){ el.innerHTML = `<span style="color:var(--amber);">${(wf && wf.reason) || 'Walk-forward could not run.'}</span>`; return; }
  const rows = wf.folds.map(f => `<tr style="border-top:1px solid var(--line);">
      <td style="padding:3px 8px;">${f.fold}</td>
      <td style="padding:3px 8px;">conf ≥ ${f.params.minConfidence}, RR 1:${f.params.rewardRisk}</td>
      <td style="padding:3px 8px;text-align:right;">${f.trainStats.trades} · ${usd(f.trainStats.netUsd)}</td>
      <td style="padding:3px 8px;text-align:right;">${f.testStats.trades} · ${usd(f.testStats.netUsd)}</td></tr>`).join('');
  const st = wf.stability;
  el.innerHTML = `
    <table style="width:100%;font-size:11.5px;border-collapse:collapse;"><tr><th style="text-align:left;padding:3px 8px;">Fold</th><th style="text-align:left;padding:3px 8px;">Params chosen on TRAIN only</th><th style="text-align:right;padding:3px 8px;">Train: trades · net</th><th style="text-align:right;padding:3px 8px;">Out-of-sample: trades · net</th></tr>${rows}</table>
    <div style="margin-top:8px;font-size:12px;line-height:1.6;"><b>Out-of-sample only (walk-forward headline):</b> ${wf.oosStats.trades} trades · win rate ${winRateLabel(wf.oosStats)} · PF ${pf(wf.oosStats.profitFactor)} · ${usd(wf.oosStats.netUsd)} net · max DD ${num(wf.oosStats.maxDrawdownPct)}%</div>
    ${st ? `<div style="font-size:12px;line-height:1.6;">Parameter stability: most-chosen set "${st.mostChosen}" in ${st.mostChosenFolds}/${st.folds} folds (${st.distinctChoices} distinct choices) · profitable OOS folds ${st.oosProfitableFolds}/${st.oosFoldsWithTrades} (train-profitable ${st.trainProfitableFolds}/${st.folds})
      ${st.overfitWarning ? `<div style="color:var(--red);">${icon('triangle-alert')} Overfit signature: parameters looked good in training but did not hold out-of-sample.</div>` : ''}</div>` : ''}`;
}
