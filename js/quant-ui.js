// =============================================================
// quant-ui.js — the NxTGen Quant Futures panel (configuration, risk
// state, honest statistics, [QUANT] log, and the backtest-validation
// section). The strategy itself appears in the normal Strategies list
// (futures-ui.js renders it from STRATEGY_REGISTRY like the other seven);
// this panel only adds the controls and readouts that are specific to it.
//
// Design notes
//  * Inputs are rendered ONCE (initQuantUI). Only the stats/risk/log
//    regions re-render on each engine cycle — re-rendering inputs every
//    cycle would steal focus mid-typing (the Strategies list does that
//    to its own checkboxes; this panel deliberately doesn't).
//  * Every number shown comes from quant/stats.js. Win rate is displayed
//    ONLY through winRateLabel(), which returns INSUFFICIENT SAMPLE below
//    30 trades. Paper / Live / Backtest are shown in separate columns and
//    never blended.
// =============================================================
import {
  QUANT_ID, QUANT_TYPE, SELECTIVITY, MIN_SAMPLE_TRADES,
  loadQuantConfig, saveQuantConfig, sanitizeQuantConfig, effectiveMinConfidence, excludedSymbolsIn,
} from './futures/quant/config.js';
import { computeQuantStats, fromPaperLog, fromLiveLog, fromBacktest, winRateLabel } from './futures/quant/stats.js';
import { computeQuantRiskState } from './futures/quant/risk.js';
import { getQuantLog, onQuantLog, clearQuantLog } from './futures/quant/log.js';
import { monteCarlo, splitInOutOfSample } from './futures/quant/validation.js';

let qcfg = loadQuantConfig();
let providers = { paperLog: () => [], liveLog: () => [], dayState: () => null, liveStart: () => null, liveTrades: () => [] };
let backtestResult = null; // { trades, startingEquity, ranAt } — in memory only (a backtest is a run, not a ledger)
let curveSource = 'paper';
let panelBuilt = false;
let onConfigChange = () => {};

const $ = (id) => document.getElementById(id);
const usd = (x) => (x == null ? '—' : (x < 0 ? '-$' : '$') + Math.abs(x).toFixed(2));
const num = (x, d = 2) => (x == null || !Number.isFinite(x) ? '—' : x.toFixed(d));
const pf = (x) => (x == null ? '—' : (Number.isFinite(x) ? x.toFixed(2) : '∞'));

// ---- config access ----
export function getQuantCfg(opts){
  return { ...qcfg, log: !!(opts && opts.log) };
}
export function setQuantProviders(p){ providers = { ...providers, ...p }; }
export function setQuantConfigListener(fn){ onConfigChange = fn || (() => {}); }

export function updateQuantConfig(patch){
  qcfg = sanitizeQuantConfig({ ...qcfg, ...patch });
  saveQuantConfig(qcfg);
  if(panelBuilt) syncInputs();
  onConfigChange(qcfg);
}
export function getQuantRewardRisk(){ return qcfg.rewardRisk; }

export function setQuantBacktestResult(trades, startingEquity){
  backtestResult = { trades: fromBacktest(trades), startingEquity, ranAt: Date.now() };
  renderQuantStats();
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
  return `${part('Paper', paper)} · ${part('Live/Demo', live)} · Backtest: ${backtestResult ? `${backtestResult.trades.length} trades (see panel below)` : 'not run'} — target ≥68% win rate is a design goal, not a result. Paper runs on the platform's synthetic feed; only Backtest/Live use real prices.`;
}

// ---- panel construction ----
function fieldHtml(label, inner, hint){
  return `<div style="display:flex;flex-direction:column;gap:4px;min-width:130px;"><label style="font-size:11px;color:var(--dim);">${label}</label>${inner}${hint ? `<span style="font-size:10.5px;color:var(--dim);">${hint}</span>` : ''}</div>`;
}
const selectHtml = (id, opts) => `<select id="${id}">${opts.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select>`;
const inputHtml = (id, type, extra) => `<input id="${id}" type="${type}" ${extra || ''}>`;
const checkHtml = (id, label) => `<label class="toggle-check"><input type="checkbox" id="${id}"><span>${label}</span></label>`;

export function initQuantUI(){
  const host = $('fuQuantPanel');
  if(!host || panelBuilt) return;
  host.innerHTML = `
    <div style="font-size:12px;color:var(--dim);line-height:1.55;margin-bottom:10px;">
      <b style="color:var(--ink);">NxTGen Quant Futures</b> is enabled from the Strategies list above. It is a deterministic, testable multi-factor system — no LLM decides its entries.
      <b>The 68%+ win rate and PF &gt; 1.5 are design targets, never shown as results.</b> A win rate appears only after ${MIN_SAMPLE_TRADES}+ completed trades in that mode, and Backtest / Paper / Live are never mixed.
      Paper mode runs on the platform's synthetic price feed (a random walk with no real edge) — use Backtest (real history) and Live/Demo to judge it.
    </div>

    <div style="display:flex;flex-wrap:wrap;gap:12px 16px;margin-bottom:10px;">
      ${fieldHtml('Entry timeframe', selectHtml('qfEntryTf', [['5m', '5m (ctx 15m/1H/4H)'], ['15m', '15m (ctx 1H/4H)']]))}
      ${fieldHtml('Min confidence (60–95)', inputHtml('qfMinConf', 'number', 'min="60" max="95" step="1"'))}
      ${fieldHtml('Selectivity', selectHtml('qfSelectivity', Object.entries(SELECTIVITY).map(([k, v]) => [k, v.label])), 'raises score + confluence needed')}
      ${fieldHtml('Risk per trade', selectHtml('qfRisk', [['0.25', '0.25%'], ['0.5', '0.50%'], ['0.75', '0.75%'], ['1', '1.00% (max)']]), 'scaled DOWN by drawdown / high vol')}
      ${fieldHtml('Reward:Risk', selectHtml('qfRR', [['2', '1:2'], ['2.5', '1:2.5'], ['3', '1:3'], ['4', '1:4']]), 'never below 1:2')}
      ${fieldHtml('Max positions (1–3)', inputHtml('qfMaxPos', 'number', 'min="1" max="3" step="1"'))}
      ${fieldHtml('Daily loss limit (%)', inputHtml('qfDailyLoss', 'number', 'min="0.25" max="10" step="0.25"'))}
      ${fieldHtml('Weekly loss limit (%)', inputHtml('qfWeeklyLoss', 'number', 'min="0.5" max="25" step="0.5"'))}
      ${fieldHtml('Pause after N losses', inputHtml('qfMaxLosses', 'number', 'min="2" max="10" step="1"'))}
      ${fieldHtml('Cooldown (minutes)', inputHtml('qfCooldown', 'number', 'min="15" step="15"'))}
    </div>
    <div style="display:flex;flex-wrap:wrap;gap:10px;margin-bottom:10px;">
      ${checkHtml('qfAllowLong', 'Allow Long')}
      ${checkHtml('qfAllowShort', 'Allow Short')}
      ${checkHtml('qfAdaptiveRR', 'Adaptive RR (one tier up on top-quality setups with room)')}
      ${checkHtml('qfUseFunding', 'Use funding rate as confirmation (when available)')}
    </div>
    <div style="display:flex;flex-wrap:wrap;gap:10px;margin-bottom:10px;align-items:center;">
      <span style="font-size:11px;color:var(--dim);">Setups:</span>
      ${checkHtml('qfSetupA', 'A Trend Pullback')}${checkHtml('qfSetupB', 'B Breakout+Retest')}${checkHtml('qfSetupC', 'C Liquidity Sweep')}${checkHtml('qfSetupD', 'D Range Extremes')}
    </div>
    <div id="qfSymbolsNote" style="font-size:11.5px;color:var(--amber);margin:0 0 6px;"></div>
    <div style="display:flex;flex-wrap:wrap;gap:12px 16px;margin-bottom:6px;">
      ${fieldHtml('Symbols (comma separated, USDT perps)', inputHtml('qfSymbols', 'text', 'style="min-width:340px;" spellcheck="false"'), 'BTC/ETH/SOL/LTC/DOGE/BNB/CL are excluded platform-wide — Quant never trades them either (typed pairs are removed automatically)')}
      ${fieldHtml('Drawdown → risk ×0.7 at (%)', inputHtml('qfDd1', 'number', 'min="1" step="0.5"'))}
      ${fieldHtml('Drawdown → risk ×0.5 at (%)', inputHtml('qfDd2', 'number', 'min="1" step="0.5"'))}
      ${fieldHtml('Drawdown → PAUSE at (%)', inputHtml('qfDdPause', 'number', 'min="1" step="0.5"'))}
      ${fieldHtml('Auto-resume after (h)', inputHtml('qfResumeH', 'number', 'min="1" step="1"'), 'resumes at ×0.5 risk')}
    </div>
    <div id="qfEffective" style="font-size:11.5px;color:var(--dim);margin:6px 0 12px;"></div>

    <div class="ov-block-title" style="margin-top:6px;">Risk state (Paper session)</div>
    <div id="qfRiskState" style="font-size:12px;background:var(--panel2);border:1px solid var(--line);border-radius:var(--r-md);padding:8px 12px;margin-bottom:12px;line-height:1.6;"></div>

    <div style="display:flex;align-items:center;gap:10px;margin-bottom:6px;">
      <div class="ov-block-title" style="margin:0;">Performance — separate by source</div>
      <select id="qfCurveSource" style="font-size:11px;"><option value="paper">Equity curve: Paper</option><option value="live">Equity curve: Live/Demo</option><option value="bt">Equity curve: Backtest</option></select>
    </div>
    <div id="qfStats" style="overflow-x:auto;margin-bottom:8px;"></div>
    <div id="qfCurve" style="margin-bottom:12px;"></div>

    <div class="ov-block-title">[QUANT] log</div>
    <div style="display:flex;gap:8px;margin-bottom:6px;"><button type="button" id="qfLogClear" class="primary ghost" style="font-size:11px;padding:3px 10px;">Clear</button></div>
    <pre id="qfLog" style="max-height:200px;overflow:auto;font-size:11px;background:var(--panel2);border:1px solid var(--line);border-radius:var(--r-md);padding:8px 10px;white-space:pre-wrap;margin:0;"></pre>
  `;
  panelBuilt = true;
  syncInputs();

  host.addEventListener('change', (e) => {
    if(e.target.id === 'qfCurveSource'){ curveSource = e.target.value; renderQuantStats(); return; }
    readInputs();
  });
  $('qfLogClear').addEventListener('click', () => clearQuantLog());
  onQuantLog(() => renderLog());
  renderLog();
  renderQuantStats();
}

function syncInputs(){
  const set = (id, v) => { const el = $(id); if(el) el.value = String(v); };
  const chk = (id, v) => { const el = $(id); if(el) el.checked = !!v; };
  set('qfEntryTf', qcfg.entryTimeframe); set('qfMinConf', qcfg.minConfidence); set('qfSelectivity', qcfg.selectivity);
  set('qfRisk', String(qcfg.riskPct)); set('qfRR', String(qcfg.rewardRisk)); set('qfMaxPos', qcfg.maxPositions);
  set('qfDailyLoss', qcfg.dailyLossLimitPct); set('qfWeeklyLoss', qcfg.weeklyLossLimitPct);
  set('qfMaxLosses', qcfg.maxConsecutiveLosses); set('qfCooldown', qcfg.cooldownMinutes);
  chk('qfAllowLong', qcfg.allowLong); chk('qfAllowShort', qcfg.allowShort); chk('qfAdaptiveRR', qcfg.adaptiveRR); chk('qfUseFunding', qcfg.useFunding);
  ['A', 'B', 'C', 'D'].forEach(k => chk('qfSetup' + k, qcfg.setups[k]));
  set('qfSymbols', qcfg.symbols.join(', '));
  set('qfDd1', qcfg.ddTier1Pct); set('qfDd2', qcfg.ddTier2Pct); set('qfDdPause', qcfg.ddPausePct); set('qfResumeH', qcfg.pauseResumeHours);
  const eff = $('qfEffective');
  if(eff) eff.textContent = `Effective minimum confidence: ${effectiveMinConfidence(qcfg)}/100 (+5 in high volatility). Requires ${SELECTIVITY[qcfg.selectivity].minCategories}/6 confluence categories and ${SELECTIVITY[qcfg.selectivity].minConfirmations} confirmations. Max positions is capped at 3 (the platform-wide limit). Live/Demo places one real position at a time (existing platform rule).`;
}

function readInputs(){
  const v = (id) => { const el = $(id); return el ? el.value : undefined; };
  const c = (id) => { const el = $(id); return el ? el.checked : undefined; };
  const patch = {
    entryTimeframe: v('qfEntryTf'), minConfidence: v('qfMinConf'), selectivity: v('qfSelectivity'),
    riskPct: v('qfRisk'), rewardRisk: v('qfRR'), maxPositions: v('qfMaxPos'),
    dailyLossLimitPct: v('qfDailyLoss'), weeklyLossLimitPct: v('qfWeeklyLoss'),
    maxConsecutiveLosses: v('qfMaxLosses'), cooldownMinutes: v('qfCooldown'),
    allowLong: c('qfAllowLong'), allowShort: c('qfAllowShort'), adaptiveRR: c('qfAdaptiveRR'), useFunding: c('qfUseFunding'),
    setups: { A: c('qfSetupA'), B: c('qfSetupB'), C: c('qfSetupC'), D: c('qfSetupD') },
    symbols: (v('qfSymbols') || '').split(/[\s,;]+/).filter(Boolean),
    ddTier1Pct: v('qfDd1'), ddTier2Pct: v('qfDd2'), ddPausePct: v('qfDdPause'), pauseResumeHours: v('qfResumeH'),
  };
  updateQuantConfig(patch); // sanitize (clamp) + persist + write the clamped values back into the inputs
  // Tell the user when pairs they typed were dropped for being on the platform's excluded list.
  const note = $('qfSymbolsNote');
  if(note){
    const removed = excludedSymbolsIn(patch.symbols);
    note.textContent = removed.length ? `Removed (excluded platform-wide, never traded by any strategy): ${removed.join(', ')}` : '';
  }
}

// ---- readouts ----
function renderLog(){
  const el = $('qfLog');
  if(!el) return;
  const lines = getQuantLog().slice(-80);
  el.textContent = lines.length ? lines.map(l => `${new Date(l.t).toLocaleTimeString()}  ${l.line}`).join('\n') : 'No [QUANT] events yet — enable Quant Futures and start Paper or Live/Demo.';
  el.scrollTop = el.scrollHeight;
}

function renderRiskState(){
  const el = $('qfRiskState');
  if(!el) return;
  const ds = providers.dayState();
  if(!ds){ el.textContent = '—'; return; }
  const nowMs = Date.now();
  // Paper's clock is synthetic (mockMarket) — evaluate at the latest Quant trade time when there is one.
  const trades = ds.quantTrades || [];
  const at = trades.length ? Math.max(nowMs, trades[trades.length - 1].closedAtMs) : nowMs;
  const s = computeQuantRiskState(trades, ds.startingEquity, at, qcfg);
  const risk = Math.max(0.1, qcfg.riskPct * s.riskMult);
  el.innerHTML = `Tier: <b>${s.tier.toUpperCase()}</b> · next-trade risk ≈ <b>${risk.toFixed(2)}%</b> (base ${qcfg.riskPct}%) · Quant drawdown ${s.drawdownPct.toFixed(2)}% · daily ${s.dailyPnlPct.toFixed(2)}% · weekly ${s.weeklyPnlPct.toFixed(2)}% · consecutive losses ${s.consecutiveLosses}
    · rolling 20/50/100: ${['r20', 'r50', 'r100'].map(k => s.rolling[k].n ? `${s.rolling[k].n}t` : '—').join(' / ')}
    ${s.paused ? `<div style="color:var(--red);margin-top:4px;">⏸ ${s.pauseReasons.join(' · ')}</div>` : '<div style="color:var(--green);margin-top:2px;">Entries permitted</div>'}`;
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

function curveSvg(stats, label){
  if(!stats || stats.curve.length < 2) return `<div class="fu-empty">No ${label} equity curve yet — it is built from completed trades only (nothing smoothed or filtered).</div>`;
  const pts = stats.curve;
  const w = 640, h = 130, pad = 6;
  const eqs = pts.map(p => p.equity);
  const min = Math.min(...eqs), max = Math.max(...eqs);
  const span = Math.max(1e-9, max - min);
  const x = (i) => pad + (i / (pts.length - 1)) * (w - 2 * pad);
  const y = (v) => h - pad - ((v - min) / span) * (h - 2 * pad);
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.equity).toFixed(1)}`).join(' ');
  const up = eqs[eqs.length - 1] >= eqs[0];
  return `<svg viewBox="0 0 ${w} ${h}" style="width:100%;max-width:${w}px;height:auto;background:var(--panel2);border:1px solid var(--line);border-radius:var(--r-md);">
      <path d="${line}" fill="none" stroke="${up ? 'var(--green)' : 'var(--red)'}" stroke-width="1.6"/></svg>
    <div style="font-size:10.5px;color:var(--dim);margin-top:3px;">${label} equity: $${eqs[0].toFixed(0)} → $${eqs[eqs.length - 1].toFixed(2)} over ${pts.length - 1} trades · peak $${stats.peakEquity.toFixed(2)} · max drawdown ${stats.maxDrawdownPct.toFixed(2)}%</div>`;
}

export function renderQuantStats(){
  if(!panelBuilt) return;
  const { paper, live, bt } = sourceStats();
  const st = $('qfStats');
  if(st) st.innerHTML = statsTable([
    { name: 'Paper (synthetic feed)', stats: paper },
    { name: 'Live / Demo (real prices)', stats: live },
    { name: 'Backtest (last run)', stats: bt },
  ]);
  const cv = $('qfCurve');
  if(cv){
    const map = { paper: [paper, 'Paper'], live: [live, 'Live/Demo'], bt: [bt, 'Backtest'] };
    const [s, label] = map[curveSource] || map.paper;
    cv.innerHTML = curveSvg(s, label);
  }
  renderRiskState();
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
  container.innerHTML = `
    <div class="ov-block-title" style="margin-top:0;">NxTGen Quant Futures — validation</div>
    <div style="font-size:11.5px;color:var(--dim);margin-bottom:8px;line-height:1.5;">
      The in-sample / out-of-sample split below is a chronological 70/30 split of THIS run's trades. Because the strategy's parameters are fixed (not fitted to this data) it is a stability check;
      the walk-forward button does true parameter selection on a training window and trades only the following unseen window.
    </div>
    ${statsTable([{ name: 'All trades', stats: all }, { name: 'In-sample (first 70%)', stats: isS }, { name: 'Out-of-sample (last 30%)', stats: oosS }])}
    <div style="margin-top:10px;font-size:12px;line-height:1.6;">
      ${mc.ok ? `<b>Monte Carlo</b> (${mc.runs} bootstrap runs of ${mc.trades} trades): median return ${num(mc.returnPct.p50)}% (5th–95th pct ${num(mc.returnPct.p5)}% … ${num(mc.returnPct.p95)}%) · median max drawdown ${num(mc.maxDrawdownPct.p50)}% (95th pct ${num(mc.maxDrawdownPct.p95)}%) · profitable in ${num(mc.probProfit, 0)}% of runs · drawdown ≥ ${mc.ruinDdPct}% in ${num(mc.probDrawdownExceeds, 0)}% of runs
        <div style="color:var(--dim);font-size:10.5px;">${mc.caveat}</div>` : `<span style="color:var(--dim);">Monte Carlo: ${mc.reason}</span>`}
    </div>
    <div style="margin-top:10px;display:flex;gap:10px;align-items:center;flex-wrap:wrap;">
      <button type="button" id="qfWfBtn" class="primary ghost" style="font-size:12px;padding:6px 14px;">Run walk-forward validation</button>
      <span id="qfWfStatus" style="font-size:11.5px;color:var(--dim);">4 folds × 9-cell grid (min confidence 70/75/80 × RR 2/2.5/3). Re-runs the backtest many times — can take a while.</span>
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
      ${st.overfitWarning ? '<div style="color:var(--red);">⚠ Overfit signature: parameters looked good in training but did not hold out-of-sample.</div>' : ''}</div>` : ''}`;
}
