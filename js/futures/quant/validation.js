// =============================================================
// quant/validation.js — anti-overfitting tooling.
//
//  * splitInOutOfSample   chronological train/test split of a trade list
//  * monteCarlo           bootstrap-resamples the realized trades to show
//                         how much of the result is sequencing luck
//  * runWalkForward       REAL walk-forward: for each fold, pick parameters
//                         on the training window only, then trade the NEXT
//                         unseen window with them. Only out-of-sample
//                         windows are reported as the headline number.
//  * parameterStability   how often the same parameters won, and what
//                         fraction of the grid is profitable OOS
//
// Nothing here tunes the strategy toward a target win rate. The grid is
// deliberately tiny (few parameters, wide steps) to keep the search space
// — and the room to overfit — small.
// =============================================================
import { computeQuantStats } from './stats.js';
import { QUANT_TYPE, MIN_SAMPLE_TRADES } from './config.js';

export function splitInOutOfSample(trades, trainFraction){
  const f = trainFraction == null ? 0.7 : trainFraction;
  const sorted = trades.slice().sort((a, b) => a.closedAtMs - b.closedAtMs);
  const cut = Math.floor(sorted.length * f);
  return { inSample: sorted.slice(0, cut), outOfSample: sorted.slice(cut) };
}

function mulberry32(seed){
  return function(){
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pct = (arr, p) => { const s = arr.slice().sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.max(0, Math.floor(p * (s.length - 1))))] : null; };

// Bootstrap: draws `trades.length` trades WITH replacement, `runs` times.
export function monteCarlo(trades, startingEquity, opts){
  const runs = (opts && opts.runs) || 1000;
  const ruinDdPct = (opts && opts.ruinDdPct) || 30;
  const n = trades.length;
  if(n < 10) return { ok: false, reason: 'Need at least 10 trades for a Monte Carlo read' };
  const rng = mulberry32((opts && opts.seed) || 12345);
  const finals = [], dds = [];
  let ruined = 0, profitable = 0;
  for(let r = 0; r < runs; r++){
    let eq = startingEquity, peak = startingEquity, maxDd = 0;
    for(let k = 0; k < n; k++){
      eq += trades[Math.floor(rng() * n)].netUsd;
      peak = Math.max(peak, eq);
      if(peak > 0) maxDd = Math.max(maxDd, ((peak - eq) / peak) * 100);
    }
    finals.push(((eq - startingEquity) / startingEquity) * 100);
    dds.push(maxDd);
    if(maxDd >= ruinDdPct) ruined++;
    if(eq > startingEquity) profitable++;
  }
  return {
    ok: true, runs, trades: n,
    returnPct: { p5: pct(finals, 0.05), p50: pct(finals, 0.5), p95: pct(finals, 0.95) },
    maxDrawdownPct: { p5: pct(dds, 0.05), p50: pct(dds, 0.5), p95: pct(dds, 0.95) },
    probProfit: (profitable / runs) * 100, probDrawdownExceeds: (ruined / runs) * 100, ruinDdPct,
    caveat: 'Assumes trades are independent and drawn from the same distribution as the sample; real markets cluster losses.',
  };
}

// Small, wide-step grid — fewer knobs, less overfitting. RR band matches the spec's configurable targets
// (1:2 / 1:2.5 / 1:3); minConfidence brackets the spec's own 80 default (QUANT_DEFAULTS.minConfidence).
export const DEFAULT_WF_GRID = (() => {
  const g = [];
  for(const minConfidence of [75, 80, 85]) for(const rewardRisk of [2, 2.5, 3]) g.push({ minConfidence, rewardRisk });
  return g;
})();

function scoreForSelection(stats){
  // Selection objective: expectancy in R terms when available, requiring a
  // minimum trade count so a 3-trade fluke can't win the selection.
  if(stats.trades < 10) return -Infinity;
  const e = stats.expectancyR != null ? stats.expectancyR : stats.expectancyUsd;
  return e * Math.sqrt(stats.trades); // mild reward for sample size
}

// runFn({ candlesBySymbol, cfgOverrides }) -> Promise<{ trades }>   (a runBacktest wrapper)
// candlesBySymbol: full history; folds are carved out by timestamp.
export async function runWalkForward({ candlesBySymbol, runFn, startingEquity, folds, trainFraction, grid, warmupMs, onProgress }){
  const F = folds || 4;
  const tf = trainFraction == null ? 0.7 : trainFraction;
  const G = grid || DEFAULT_WF_GRID;
  const warm = warmupMs == null ? 3 * 86_400_000 : warmupMs;
  const all = Object.values(candlesBySymbol).filter(a => a.length);
  if(!all.length) return { ok: false, reason: 'No candle history supplied' };
  const t0 = Math.min(...all.map(a => a[0].t)), t1 = Math.max(...all.map(a => a[a.length - 1].t));
  const span = t1 - t0;
  const foldLen = span / (F + 0);          // rolling folds; each = train then test slice
  if(span < 10 * 86_400_000) return { ok: false, reason: 'History too short for walk-forward (need >= ~10 days)' };

  const slice = (from, to) => {
    const out = {};
    for(const [sym, arr] of Object.entries(candlesBySymbol)) out[sym] = arr.filter(c => c.t >= from - warm && c.t < to);
    return out;
  };
  const results = [];
  let step = 0;
  const totalSteps = F * (G.length + 1);
  for(let k = 0; k < F; k++){
    const fStart = t0 + k * foldLen, fEnd = fStart + foldLen;
    const trainEnd = fStart + (fEnd - fStart) * tf;
    // 1) choose parameters on the TRAIN window only
    let best = null;
    for(const params of G){
      const r = await runFn({ candlesBySymbol: slice(fStart, trainEnd), cfgOverrides: params });
      const trades = r.trades.filter(t => t.setupType === QUANT_TYPE && (t.openedAtMs || t.closedAtMs) >= fStart);
      const stats = computeQuantStats(trades, startingEquity);
      const sc = scoreForSelection(stats);
      if(!best || sc > best.score) best = { params, score: sc, trainStats: stats };
      if(onProgress) onProgress(++step / totalSteps);
    }
    // 2) trade the NEXT, unseen window with those parameters
    const r = await runFn({ candlesBySymbol: slice(trainEnd, fEnd), cfgOverrides: best.params });
    const testTrades = r.trades.filter(t => t.setupType === QUANT_TYPE && (t.openedAtMs || t.closedAtMs) >= trainEnd);
    results.push({ fold: k + 1, trainRange: [fStart, trainEnd], testRange: [trainEnd, fEnd], params: best.params, trainStats: best.trainStats, testStats: computeQuantStats(testTrades, startingEquity), testTrades });
    if(onProgress) onProgress(++step / totalSteps);
  }
  const oosTrades = results.flatMap(r => r.testTrades).sort((a, b) => a.closedAtMs - b.closedAtMs);
  return { ok: true, folds: results, oosTrades, oosStats: computeQuantStats(oosTrades, startingEquity), stability: parameterStability(results) };
}

export function parameterStability(foldResults){
  if(!foldResults.length) return null;
  const counts = new Map();
  for(const r of foldResults){ const k = `conf>=${r.params.minConfidence}, RR 1:${r.params.rewardRisk}`; counts.set(k, (counts.get(k) || 0) + 1); }
  const top = Array.from(counts.entries()).sort((a, b) => b[1] - a[1])[0];
  const oosPositive = foldResults.filter(r => r.testStats.trades > 0 && r.testStats.netUsd > 0).length;
  const oosTraded = foldResults.filter(r => r.testStats.trades > 0).length;
  const trainPositive = foldResults.filter(r => r.trainStats.trades > 0 && r.trainStats.netUsd > 0).length;
  return {
    mostChosen: top[0], mostChosenFolds: top[1], folds: foldResults.length,
    distinctChoices: counts.size,
    oosProfitableFolds: oosPositive, oosFoldsWithTrades: oosTraded,
    trainProfitableFolds: trainPositive,
    // A parameter set that wins in-sample but loses out-of-sample is the classic overfit signature.
    overfitWarning: trainPositive > oosPositive && trainPositive - oosPositive >= Math.ceil(foldResults.length / 2),
    minSample: MIN_SAMPLE_TRADES,
  };
}
