// =============================================================
// quant/sweep.js — the settings sweep, shared by the Backtest tab's "Run settings sweep" button
// (browser, Web Workers — sweep-runner.js / sweep-worker.js) and tools/quant-sweep.mjs (Node).
// DOM-free. One place defines the config list, how a single config is run, and how the results are scored, so
// the two front-ends can never disagree.
//
// The idea: run the app's REAL backtest engine once per candidate settings-set on the SAME candles, split every
// set's trades chronologically into TRAIN (first ~2/3) and TEST (last ~1/3), rank by TRAIN, and show TEST beside
// it. A set that only wins on the data it was ranked on is overfit; one that also holds on TEST is a candidate.
// =============================================================
import { runBacktest } from '../backtest.js';
import { DEFAULT_FEE_CONFIG } from '../costs.js';
import { STRATEGY_REGISTRY } from '../setups.js';
import { sanitizeQuantConfig, QUANT_ID, QUANT_TYPE } from './config.js';

// Behaviour BEFORE the cost filter existed (maxCostR 1 = off), as the Backtest tab ran it.
export const BASE_OLD = { entryTimeframe: '15m', selectivity: 'off', minConfidence: 70, rewardRisk: 1.5, maxCostR: 1, minStopAtr: 1.2, trendFilter: 'any', setups: { A: true, B: false, C: false, D: false } };

// grid: 'quick' (~22 configs), 'full' (96-config factorial). includeSlow adds 5m entries (~3x slower per run).
export function sweepConfigs(grid, includeSlow){
  const B = (over) => ({ ...BASE_OLD, maxCostR: 0.18, ...over }); // "B" = current shipped default + overrides
  const list = [
    ['BASELINE (before the cost filter)', { ...BASE_OLD }],
    ['current default (cost filter 0.18R)', B({})],
  ];
  if(grid === 'full'){
    for(const selectivity of ['off', 'high']) for(const trendFilter of ['any', 'strong']) for(const maxCostR of [0.12, 0.18, 0.25, 1])
      for(const rewardRisk of [1.3, 1.5, 2]) for(const minStopAtr of [1.2, 1.6])
        list.push([`sel=${selectivity} trend=${trendFilter} cost<=${maxCostR} RR=${rewardRisk} stop>=${minStopAtr}ATR`, { ...BASE_OLD, selectivity, trendFilter, maxCostR, rewardRisk, minStopAtr }]);
    return list;
  }
  list.push(
    ['cost<=0.12R', B({ maxCostR: 0.12 })], ['cost<=0.25R', B({ maxCostR: 0.25 })],
    ['strong trend only', B({ trendFilter: 'strong' })], ['High selectivity', B({ selectivity: 'high' })],
    ['minConf 75', B({ minConfidence: 75 })], ['minConf 80', B({ minConfidence: 80 })],
    ['RR 1.3', B({ rewardRisk: 1.3 })], ['RR 1.75', B({ rewardRisk: 1.75 })], ['RR 2.0', B({ rewardRisk: 2 })],
    ['stop floor 1.5 ATR', B({ minStopAtr: 1.5 })], ['stop floor 1.8 ATR', B({ minStopAtr: 1.8 })],
    ['setups A+B', B({ setups: { A: true, B: true, C: false, D: false } })], ['setups A+C', B({ setups: { A: true, B: false, C: true, D: false } })],
    ['setups A+B+C', B({ setups: { A: true, B: true, C: true, D: false } })], ['setups A+B+C+D', B({ setups: { A: true, B: true, C: true, D: true } })],
    ['strong + High selectivity', B({ trendFilter: 'strong', selectivity: 'high' })],
    ['strong + stop 1.5', B({ trendFilter: 'strong', minStopAtr: 1.5 })],
    ['strong + cost<=0.12', B({ trendFilter: 'strong', maxCostR: 0.12 })],
    ['strong + stop 1.5 + RR 1.3', B({ trendFilter: 'strong', minStopAtr: 1.5, rewardRisk: 1.3 })],
    ['High + stop 1.5 + cost<=0.12', B({ selectivity: 'high', minStopAtr: 1.5, maxCostR: 0.12 })],
  );
  if(includeSlow) list.push(['5m entries (3x slower)', B({ entryTimeframe: '5m' })]);
  return list;
}

// settings: { exchange, riskPct, leverage, makerPct, takerPct, spreadPct, fundingRatePct, startingEquity,
//             maxDailyLossPct, dailyProfitTargetPct, minConfidence? }
// Returns lightweight trade rows (safe to postMessage).
export async function runSweepConfig({ candles, symbols, settings: S, over }){
  const strategies = {};
  for(const st of STRATEGY_REGISTRY) strategies[st.id] = false; // Quant only — every other strategy explicitly OFF
  strategies[QUANT_ID] = true;
  const quant = { ...sanitizeQuantConfig({ ...over, riskPct: S.riskPct, minConfidence: over.minConfidence ?? S.minConfidence ?? 70 }), log: false };
  const cfg = {
    exchange: S.exchange, strategies, minConfidence: quant.minConfidence, riskPctPerTrade: S.riskPct, leverage: S.leverage,
    feeConfig: { ...DEFAULT_FEE_CONFIG, [S.exchange]: { makerPct: S.makerPct, takerPct: S.takerPct } },
    quant,
  };
  const res = await runBacktest({
    candlesBySymbol: candles, symbols, cfg, startingEquity: S.startingEquity, intervalMinutes: 5,
    maxDailyLossPct: S.maxDailyLossPct, dailyProfitTargetPct: S.dailyProfitTargetPct,
    metaOverrides: { spreadPct: S.spreadPct, fundingRatePct: S.fundingRatePct || 0 },
  });
  return res.trades.filter(t => t.setupType === QUANT_TYPE).map(t => ({
    openedAtMs: t.openedAtMs, closedAtMs: t.closedAtMs, symbol: t.symbol, dir: t.direction, netUsd: t.netUsd,
    R: t.quant ? t.quant.realizedR : null, exit: t.exitReason, stopPct: t.quant ? t.quant.stopDistPct : null,
    score: t.quant ? t.quant.score : null, setup: t.quant ? t.quant.setup : null, feesUsd: t.feesUsd,
  }));
}

// ---- scoring ----
export function sweepStats(trades){
  const n = trades.length;
  if(!n) return { n: 0 };
  const wins = trades.filter(t => t.netUsd > 0), losses = trades.filter(t => t.netUsd <= 0);
  const gw = wins.reduce((a, t) => a + t.netUsd, 0), gl = -losses.reduce((a, t) => a + t.netUsd, 0);
  const Rs = trades.map(t => t.R).filter(x => Number.isFinite(x));
  const avgR = Rs.length ? Rs.reduce((a, b) => a + b, 0) / Rs.length : null;
  const wr = wins.length / n;
  const aw = wins.length ? wins.reduce((a, t) => a + (t.R || 0), 0) / wins.length : 0;
  const al = losses.length ? -losses.reduce((a, t) => a + (t.R || 0), 0) / losses.length : 0;
  return {
    n, wr, ci: 1.96 * Math.sqrt(wr * (1 - wr) / n), pf: gl > 0 ? gw / gl : (gw > 0 ? Infinity : 0), net: gw - gl, avgR,
    beWr: wins.length && losses.length && aw + al > 0 ? al / (aw + al) : null,
  };
}

// results: [{ name, over, trades }] ; cutMs: trades opened before it are TRAIN, the rest TEST.
export function analyzeSweep(results, cutMs, minTrain){
  const mt = minTrain == null ? 15 : minTrain;
  const rows = results.map(r => ({
    name: r.name, over: r.over, all: sweepStats(r.trades),
    train: sweepStats(r.trades.filter(t => t.openedAtMs < cutMs)), test: sweepStats(r.trades.filter(t => t.openedAtMs >= cutMs)),
  }));
  const ranked = rows.slice().sort((a, b) => (b.train.n >= mt ? b.train.avgR : -9) - (a.train.n >= mt ? a.train.avgR : -9));
  const robust = ranked.filter(r => r.train.n >= mt && r.test.n >= 10 && r.train.avgR > 0 && r.test.avgR > 0 && !r.name.startsWith('BASELINE'));
  return { ranked, robust, baseline: rows.find(r => r.name.startsWith('BASELINE')) || null };
}
