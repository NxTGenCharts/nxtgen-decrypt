// =============================================================
// quant/diagnostics.js — "why did (or didn't) Quant trade?" funnel.
//
// A backtest that says "0 trades" is indistinguishable from a broken strategy. This collects, per run,
// how far each evaluation got through the pipeline and where it stopped, so the Backtest tab can say
// e.g. "62% of evaluations were in a Range regime where Trend Pullback is not allowed" instead of nothing.
// Pure counters — no effect on any decision. Attached to the run's quant config as `qcfg.diag`.
//
// Stages, in pipeline order:
//   evaluated      detector actually ran (15m entries only count on a real 15m candle close)
//   regime:<label> evaluations by Quant market regime (info)
//   no_setup       no enabled setup detector produced a candidate
//   candidate      a setup detector produced a candidate (everything below is a subset of these)
//     expansion / stop / cost / clearance / score   candidate died in signal.js gates
//   signal         candidate passed every signal gate
//   engine:<why>   signal rejected by the shared no-trade gate or Quant's own risk gate
//   approved       became a position
// =============================================================
export function createQuantDiag(){
  return { counts: {}, regimes: {}, noSetupByRegime: {}, engineReasons: {}, candidateSetups: {} };
}
const bump = (o, k, n = 1) => { o[k] = (o[k] || 0) + n; };

export function diagCount(diag, stage){ if(diag) bump(diag.counts, stage); }

// veto.meta carries { regime, stage, setup } from signal.js.
export function diagVeto(diag, meta){
  if(!diag) return;
  bump(diag.counts, 'evaluated');
  if(meta && meta.regime) bump(diag.regimes, meta.regime);
  const stage = (meta && meta.stage) || 'no_setup';
  if(stage === 'no_setup'){ bump(diag.counts, 'no_setup'); if(meta && meta.regime) bump(diag.noSetupByRegime, meta.regime); return; }
  bump(diag.counts, 'candidate'); bump(diag.counts, stage);
  if(meta && meta.setup) bump(diag.candidateSetups, meta.setup);
}
export function diagSignal(diag, meta){
  if(!diag) return;
  bump(diag.counts, 'evaluated'); bump(diag.counts, 'candidate'); bump(diag.counts, 'signal');
  if(meta && meta.regime && meta.regime.label) bump(diag.regimes, meta.regime.label);
  if(meta && meta.setup) bump(diag.candidateSetups, meta.setup);
}
export function diagEngineReject(diag, reasons){
  if(!diag) return;
  bump(diag.counts, 'engineRejected');
  // Group by the reason's leading words so "Expected net return 0.21% below minimum 0.3%" style text collapses.
  for(const r of (reasons || []).slice(0, 3)) bump(diag.engineReasons, String(r).replace(/[0-9.]+/g, '#').slice(0, 90));
}

const STAGE_TEXT = {
  no_setup: 'No setup pattern present (regime not allowed, trend not aligned, no pullback into value, momentum not turning...)',
  expansion: 'Setup found, but the signal candle was too large (already moved — not chasing)',
  stop: 'Setup found, but the structural stop was too far away (poor entry)',
  clearance: 'Setup found, but a 1H/4H swing level sat too close in front of the target',
  cost: 'Setup found, but the stop was too tight for the fees/spread (costs above the max share of 1R)',
  score: 'Setup found, but its score / confluence / confirmations were below the required level',
  engineRejected: 'Passed every strategy gate, then rejected by the shared no-trade gate or Quant risk limits',
};

// Plain-language summary for the UI. Returns { rows: [{label, n, pct}], headline, hints }.
export function summarizeQuantDiag(diag, tradeCount){
  if(!diag) return null;
  const c = diag.counts, ev = c.evaluated || 0;
  const pct = (n) => (ev ? (100 * n / ev) : 0);
  const rows = [];
  rows.push({ label: 'Evaluations (one per closed entry candle per symbol)', n: ev, pct: 100 });
  for(const k of ['no_setup', 'expansion', 'stop', 'cost', 'clearance', 'score']) if(c[k]) rows.push({ label: STAGE_TEXT[k], n: c[k], pct: pct(c[k]) });
  rows.push({ label: 'Signals passing every strategy gate', n: c.signal || 0, pct: pct(c.signal || 0) });
  if(c.engineRejected) rows.push({ label: STAGE_TEXT.engineRejected, n: c.engineRejected, pct: pct(c.engineRejected) });
  rows.push({ label: 'Trades opened', n: c.approved || 0, pct: pct(c.approved || 0) });

  const regimes = Object.entries(diag.regimes).sort((a, b) => b[1] - a[1]);
  const hints = [];
  const top = regimes[0];
  const notAllowed = ['Range', 'Low Volatility', 'Compression', 'High Volatility'];
  const idleShare = regimes.filter(([k]) => notAllowed.includes(k)).reduce((a, [, n]) => a + n, 0) / Math.max(1, ev);
  if(ev === 0) hints.push('The detector never ran: not enough history (needs ~3 days of candles before the first evaluation) or every symbol is on the excluded list.');
  if(ev > 0 && idleShare > 0.55) hints.push(`${Math.round(idleShare * 100)}% of evaluations were in Range / Low-vol / Compression / High-vol regimes, where Trend Pullback (A) is not allowed. Enable Range Extremes (D) and Liquidity Sweep (C) on the Quant card, or test a more trending period.`);
  if(c.clearance && c.clearance > 2 * Math.max(1, c.signal || 0)) hints.push('Most candidates die on target clearance (a 1H/4H swing level is right in front of the trade). That is a quality filter, not a bug — enabling the other setups or using the 5m entry timeframe (tighter stops leave more room in R) lets more through.');
  if(c.score && c.score > Math.max(1, c.signal || 0)) hints.push('Many candidates fall just short on score/confluence. Lower Min confidence toward 65-70.');
  if(c.engineRejected && c.engineRejected >= (c.signal || 0) * 0.5) hints.push('Over half of the signals were stopped by the no-trade gate / risk limits (see the reasons list).');
  if(!hints.length && !tradeCount) hints.push('No single gate dominates. Widen the date range, tick more symbols, or enable more setups.');
  return { rows, regimes, hints, engineReasons: Object.entries(diag.engineReasons).sort((a, b) => b[1] - a[1]).slice(0, 6) };
}
