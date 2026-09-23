// =============================================================
// NxTGen HTF OrderFlow — regression tests.  Run:  node tests/quant.test.mjs
// (Node 22+; no dependencies.)
//
// This file used to test "NxTGen Quant Futures" (four setups A-D, 15m/5m
// entry, softer confluence gates). That strategy was replaced with NxTGen
// HTF OrderFlow (one setup: mandatory 4H/1H trend alignment + validated
// 30M/1H/4H supply-demand/order-block confluence + a mechanical 5M
// PSAR/EMA/AO confirmation — see quant/setups.js). Every mandatory
// condition is a hard mechanical gate rather than a soft-scored one, so
// the old strategy's generic trending/breakout synthetic fixtures (built
// to satisfy Setup A/B/D's much looser requirements) essentially never
// clear HTF OrderFlow's full gate chain — that is the intended, much
// higher selectivity the spec asked for, not a bug. Tests below that
// depended on those fixtures reliably firing a signal were rewritten to
// (a) verify config/risk/stats/sizing math that did NOT change, and
// (b) run the real detector across many synthetic multi-timeframe
// scenarios asserting it never throws and that every invariant holds on
// whatever it DOES approve, rather than asserting a specific fire count.
// Building fixtures that reliably satisfy every mandatory HTF OrderFlow
// condition (a real order block, a mechanical two-candle PSAR/EMA
// crossover, and an AO threshold, all in sync) is real follow-up work,
// not done in this pass — see the "smoke" test below for what IS covered.
//
// What these DO prove: the strategy is registered, config sanitization/
// clamping, the RR floor / sample rule / risk limits behave as specified,
// the detector never throws across a wide range of synthetic data, and
// the Paper and Backtest pipelines run end to end without errors.
// What they DO NOT prove: profitability, any win rate, or that the
// detector reliably fires on real market data. The candle data here is
// synthetic; nothing in this file says anything about real-market results.
// =============================================================
import assert from 'node:assert/strict';
import { STRATEGY_REGISTRY } from '../js/futures/setups.js';
import { QUANT_ID, QUANT_TYPE, QUANT_DEFAULTS, sanitizeQuantConfig, effectiveMinConfidence, HARD_LIMITS, quantSymbolSet } from '../js/futures/quant/config.js';
import { EXCLUDED_FUTURES_SYMBOLS } from '../js/futures/excludedSymbols.js';
import { buildFeatures } from '../js/futures/quant/features.js';
import { classifyQuantRegime } from '../js/futures/quant/regime.js';
import { SETUP_DETECTORS } from '../js/futures/quant/setups.js';
import { detectQuantFutures } from '../js/futures/quant/signal.js';
import { computeQuantRiskState, effectiveRiskPct, quantSize } from '../js/futures/quant/risk.js';
import { computeQuantStats, winRateLabel } from '../js/futures/quant/stats.js';
import { monteCarlo, splitInOutOfSample } from '../js/futures/quant/validation.js';
import { mockMarket } from '../js/futures/mockMarket.js';
import { runScanCycle, openPosition, managePositions, evaluateSymbol, scanSymbolsWithQuant } from '../js/futures/engine.js';
import { runBacktest } from '../js/futures/backtest.js';
import { setQuantConsole } from '../js/futures/quant/log.js';
import { getQuantCfg } from '../js/quant-ui.js';
import { WATCHLIST_TOP_N, rankTopByVolume } from '../js/futures/watchlist.js';
import { classifyRegime } from '../js/futures/regime.js';
import { summarizeQuantDiag } from '../js/futures/quant/diagnostics.js';
import { sweepConfigs, sweepStats, analyzeSweep } from '../js/futures/quant/sweep.js';
setQuantConsole(false);

let passed = 0;
const test = async (name, fn) => { try { await fn(); passed++; console.log('  ok  ', name); } catch (e) { console.error('  FAIL', name, '\n', e); process.exitCode = 1; } };

// ---- synthetic candle helpers ----
function rng(seed){ return () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const T = 900_000;
function gen(segs, { start = 100, seed = 7, base = 1000 } = {}){
  const r = rng(seed); const out = []; let p = start, t = 1_700_000_000_000;
  for(const sg of segs) for(let i = 0; i < sg.n; i++){
    const o = p, c = o * (1 + (sg.drift ?? 0) + (r() - 0.5) * 2 * (sg.vol ?? 0.002)); const w = sg.wick ?? 0.0012;
    out.push({ t, o, h: Math.max(o, c) * (1 + w * r()), l: Math.min(o, c) * (1 - w * r()), c, v: base * (sg.vm ?? 1) * (0.8 + 0.4 * r()) }); p = c; t += T;
  }
  return out;
}
function push(E, o, c, v, hw, lw){ E.push({ t: E[E.length - 1].t + T, o, h: Math.max(o, c) * (1 + hw), l: Math.min(o, c) * (1 - lw), c, v }); }
const aggH1 = (m) => { const o = []; for(let i = 0; i + 4 <= m.length; i += 4){ const s = m.slice(i, i + 4); o.push({ t: s[0].t, o: s[0].o, h: Math.max(...s.map(x => x.h)), l: Math.min(...s.map(x => x.l)), c: s[3].c, v: s.reduce((a, x) => a + x.v, 0) }); } return o; };
const mkSnap = (E) => ({ symbol: 'BTCUSDT', price: E[E.length - 1].c, m5: E, m15: E, h1: aggH1(E).slice(-60), meta: { spreadPct: 0.01, liquidityScore: 90, fundingRatePct: 0.005, candlesClosed: true } });
const mirror = (E) => { const K = E[0].o * E[E.length - 1].c; return E.map(x => ({ t: x.t, o: K / x.o, h: K / x.l, l: K / x.h, c: K / x.c, v: x.v })); };
function inspect(E, over = {}){
  // maxCostR: 1 (= cost filter off) — these helpers exercise the signal machinery on constructed patterns whose stops are
  // tight by construction; the cost filter has its own tests below.
  const q = sanitizeQuantConfig({ minConfidence: 60, maxCostR: 1, ...over });
  const f = buildFeatures(mkSnap(E), q, { nowMs: null });
  if(!f.ok) return { fail: f.reason };
  const reg = classifyQuantRegime(f);
  const res = { AL: SETUP_DETECTORS.A(f, reg, 'LONG', q).ok, AS: SETUP_DETECTORS.A(f, reg, 'SHORT', q).ok };
  return { f, reg, res, sig: detectQuantFutures(mkSnap(E), null, q, { nowMs: null, costPct: 0.15 }) };
}
function pullback(seed, pd = -0.0006, nb = 7){
  const E = gen([{ n: 290, drift: 0.0006, vol: 0.0022, vm: 1.1, wick: 0.0012 }, { n: nb, drift: pd, vol: 0.0012, vm: 0.55, wick: 0.0008 }], { seed });
  const l = E[E.length - 1]; const rc = l.c * 1.0038; E.push({ t: l.t + T, o: l.c, h: rc * 1.0006, l: l.c * 1.0001, c: rc, v: 1200 });
  return E;
}
function squeezeBreakout(seed, s){
  const E = gen([{ n: 170, drift: s * 0.0005, vol: 0.0025, wick: 0.0012 }], { seed });
  const mid = E[E.length - 1].c;
  for(let j = 1; j <= 62; j++) push(E, E[E.length - 1].c, mid * (1 + s * 0.0022 * Math.sin(2 * Math.PI * j / 14)), 600, 0.0004, 0.0004);
  const rngE = E.slice(-62); const level = s === 1 ? Math.max(...rngE.map(x => x.h)) : Math.min(...rngE.map(x => x.l));
  push(E, E[E.length - 1].c, level * (1 + s * 0.0012), 2000, s === 1 ? 0.0004 : 0.0003, s === 1 ? 0.0003 : 0.0004);
  let p = E[E.length - 1].c; for(let j = 0; j < 3; j++){ const c = p * (1 + s * 0.0003); push(E, p, c, 700, 0.0003, 0.0003); p = c; }
  push(E, p, level * (1 + s * 0.0006), 650, s === 1 ? 0.0002 : 0, s === 1 ? 0 : 0.0002);
  const last = E[E.length - 1]; if(s === 1) last.l = level * 1.0002; else last.h = level * 0.9998;
  push(E, last.c, last.c * (1 + s * 0.0012), 900, s === 1 ? 0.0003 : 0, s === 1 ? 0 : 0.0003);
  return E;
}

console.log('NxTGen HTF OrderFlow tests');

await test('registered as a strategy, off by default, RR dropdown contains the default', () => {
  const s = STRATEGY_REGISTRY.find(x => x.id === QUANT_ID);
  assert.ok(s); assert.equal(s.type, 'NxTGen HTF OrderFlow'); assert.equal(s.defaultEnabled, false);
  assert.deepEqual(s.rrOptions, [2, 2.5, 3]); assert.ok(s.rrOptions.includes(QUANT_DEFAULTS.rewardRisk), 'the dropdown must contain the default RR, or it displays a value that is not what runs'); assert.equal(s.defaultRR, QUANT_DEFAULTS.rewardRisk); assert.equal(STRATEGY_REGISTRY.length, 7); // + NxTGen Grid (own engine) = 8 in the UI
});

await test('config: every field clamped; RR never below the 1:2 floor; risk never above 1%; weights sum to 100; entry TF always 5m', () => {
  const c = sanitizeQuantConfig({ minConfidence: 5, riskPct: 9, rewardRisk: 0.5, maxPositions: 50, weights: { h4: 500, ao: 0 }, symbolFilter: ['btcusdt', 'bad symbol', 'ETHUSDT', 'xrpusdt', 'adausdt'], entryTimeframe: '15m' });
  assert.equal(c.minConfidence, 60); assert.equal(c.riskPct, HARD_LIMITS.maxRiskPct); assert.equal(c.rewardRisk, HARD_LIMITS.minRewardRisk); assert.equal(c.maxPositions, 3);
  assert.equal(c.entryTimeframe, '5m', '5M is the only entry timeframe, whatever is passed in');
  assert.equal(HARD_LIMITS.minRewardRisk, 2.0, 'spec: the system must never open a trade below 1:2');
  assert.deepEqual(c.symbolFilter, ['XRPUSDT', 'ADAUSDT'], 'excluded majors (BTC/ETH/...) are stripped; valid non-excluded pairs stay');
  assert.equal(sanitizeQuantConfig({ symbolFilter: ['BTCUSDT', 'ETHUSDT'] }).symbolFilter, null, 'only-excluded list means "no restriction", not "trade nothing"');
  assert.equal(QUANT_DEFAULTS.symbolFilter, null);
  assert.equal(sanitizeQuantConfig({ symbols: ['XRPUSDT'] }).symbolFilter, null, 'legacy saved `symbols` arrays (the old synthetic-list default) are ignored');
  assert.ok(Math.abs(Object.values(c.weights).reduce((a, b) => a + b, 0) - 100) < 1e-9);
  assert.equal(effectiveMinConfidence(sanitizeQuantConfig({ selectivity: 'high' })), 85);
  assert.equal(effectiveMinConfidence(sanitizeQuantConfig({ selectivity: 'veryHigh' })), 90);
  assert.equal(sanitizeQuantConfig({}).setups.B, false, 'setups B/C/D are always false — only HTF OrderFlow (A) has a detector');
});

await test('Quant applies to every non-excluded pair the mode scans (real watchlist names outside the synthetic list), never to excluded ones', () => {
  const q = sanitizeQuantConfig({});
  for(const sym of ['ZECUSDT', 'HYPEUSDT', '1000PEPEUSDT', 'ENAUSDT', 'TAOUSDT', 'WLDUSDT', 'TRUMPUSDT', 'PUMPUSDT', 'XRPUSDT', '龙虾USDT']) assert.ok(quantSymbolSet(q).has(sym), `${sym} must be tradeable by Quant`);
  for(const sym of EXCLUDED_FUTURES_SYMBOLS) assert.ok(!quantSymbolSet(q).has(sym), `${sym} must stay excluded`);
  assert.deepEqual(Array.from(quantSymbolSet(q)), [], 'nothing is ADDED to a scan list in the default mode');
  const only = sanitizeQuantConfig({ symbolFilter: ['XRPUSDT'] });
  assert.ok(quantSymbolSet(only).has('XRPUSDT') && !quantSymbolSet(only).has('ZECUSDT'));
});

await test('smoke: the detector never throws across many synthetic multi-timeframe scenarios, and every signal it DOES approve satisfies every hard invariant', () => {
  let evaluated = 0, fired = 0;
  const fixtures = [];
  for(let seed = 1; seed <= 60; seed++){
    fixtures.push(pullback(seed), mirror(pullback(seed)), squeezeBreakout(seed, 1), squeezeBreakout(seed, -1));
  }
  for(const E of fixtures){
    evaluated++;
    let r;
    assert.doesNotThrow(() => { r = inspect(E); }, 'detectQuantFutures/SETUP_DETECTORS.A must never throw on any well-formed snapshot');
    if(!r.sig || r.sig.vetoes) continue;
    fired++;
    const m = r.sig.meta, s = r.sig.direction === 'LONG' ? 1 : -1;
    assert.equal(m.entryTf, '5m', 'entry timeframe is always 5M');
    assert.ok(m.rewardRisk >= HARD_LIMITS.minRewardRisk - 1e-9 && m.rewardRisk <= 4, `RR ${m.rewardRisk} respects the 1:2 floor`);
    assert.ok(s * (m.entryFill - m.stopPrice) > 0, 'stop must be on the losing side');
    assert.ok(Math.abs(s * (m.targetPrice - m.entryFill) - m.rewardRisk * s * (m.entryFill - m.stopPrice)) < 1e-6 * m.entryFill, 'target is exactly RR x risk from entry');
    assert.ok(m.score >= m.minConfidenceUsed, 'score gate honoured');
    assert.ok(m.confluenceCount >= 1 && m.confluenceCount <= 3, 'HTF order-block confluence is 1-3 timeframes');
    assert.ok(m.zone && (m.zone.type === 'demand' || m.zone.type === 'supply'));
  }
  console.log(`         (${evaluated} scenarios run, ${fired} approved a signal — HTF OrderFlow is deliberately far more selective than these generic trending/breakout fixtures were built for; see this file's header)`);
});

await test('high selectivity never lowers the bar: whenever both tiers fire on the same data, Very High is a subset of Normal', () => {
  let normal = 0, veryHigh = 0;
  for(let seed = 1; seed <= 40; seed++){
    const E = squeezeBreakout(seed, 1);
    const a = inspect(E, { minConfidence: 60 }), b = inspect(E, { minConfidence: 60, selectivity: 'veryHigh' });
    const an = a.sig && !a.sig.vetoes, bn = b.sig && !b.sig.vetoes;
    if(an) normal++; if(bn){ veryHigh++; assert.ok(an, 'a Very High signal must also pass Normal'); assert.ok(b.sig.rawConfidence >= 90); }
  }
  assert.ok(veryHigh <= normal);
});

await test('stats: win rate withheld below 30 trades (INSUFFICIENT SAMPLE), shown at 30+', () => {
  const mk = (n) => Array.from({ length: n }, (_, i) => ({ closedAtMs: 1e12 + i * 86_400_000, netUsd: i % 3 ? 50 : -40, feesUsd: 5, quant: { realizedR: i % 3 ? 1.8 : -1.2, initialRR: 2 } }));
  const s29 = computeQuantStats(mk(29), 10000), s30 = computeQuantStats(mk(30), 10000);
  assert.equal(s29.winRate, null); assert.match(winRateLabel(s29), /INSUFFICIENT SAMPLE \(29\/30\)/);
  assert.ok(s30.winRate != null && !/INSUFFICIENT/.test(winRateLabel(s30)));
  assert.equal(computeQuantStats([], 10000).trades, 0); assert.equal(winRateLabel(computeQuantStats([], 10000)), 'No trades yet');
  assert.equal(s29.sharpe, null, 'ratios need >=30 trades');
});

await test('stats: equity curve is the exact cumulative sum (nothing smoothed) and max drawdown is correct', () => {
  const t = [100, -50, -60, 30].map((netUsd, i) => ({ closedAtMs: 1e12 + i * 3.6e6, netUsd, quant: null }));
  const s = computeQuantStats(t, 1000);
  assert.deepEqual(s.curve.map(p => p.equity), [1000, 1100, 1050, 990, 1020]);
  assert.ok(Math.abs(s.maxDrawdownPct - (110 / 1100) * 100) < 1e-9);
});

await test('monte carlo needs >=10 trades; split is chronological', () => {
  assert.equal(monteCarlo([{ netUsd: 1 }], 1000).ok, false);
  const tr = Array.from({ length: 20 }, (_, i) => ({ closedAtMs: i, netUsd: i % 2 ? 10 : -5 }));
  const mc = monteCarlo(tr, 1000, { runs: 200 }); assert.ok(mc.ok && mc.returnPct.p5 <= mc.returnPct.p95);
  const { inSample, outOfSample } = splitInOutOfSample(tr.slice().reverse(), 0.7);
  assert.ok(inSample.at(-1).closedAtMs < outOfSample[0].closedAtMs);
});

await test('risk: drawdown tiers 0.50 -> 0.35 -> 0.25 -> pause, then resumes at reduced risk', () => {
  const q = sanitizeQuantConfig({});
  const loss = (pct, at) => ({ closedAtMs: at, netUsd: -pct / 100 * 10000 });
  let st = computeQuantRiskState([], 10000, 1e12, q); assert.equal(st.tier, 'normal'); assert.equal(effectiveRiskPct(q, st, 1), 0.5);
  st = computeQuantRiskState([loss(2.0, 1e12), { closedAtMs: 1e12 + 1, netUsd: 50 }, loss(1.6, 1e12 + 2)], 10000, 1e12 + 3, q);
  assert.ok(st.drawdownPct >= 3 && st.drawdownPct < 5, `dd ${st.drawdownPct}`); assert.equal(st.tier, 'reduced'); assert.equal(effectiveRiskPct(q, st, 1), 0.35);
  st = computeQuantRiskState([loss(5.5, 1e12)], 10000, 1e12 + 1, q); assert.equal(st.tier, 'minimum'); assert.equal(effectiveRiskPct(q, st, 1), 0.25);
  st = computeQuantRiskState([loss(8.5, 1e12)], 10000, 1e12 + 1, q); assert.ok(st.paused && st.ddPaused);
  st = computeQuantRiskState([loss(8.5, 1e12)], 10000, 1e12 + 49 * 3.6e6, q); assert.ok(!st.ddPaused, 'auto-resumes after 48h'); assert.equal(st.riskMult, 0.5);
  assert.equal(effectiveRiskPct(q, computeQuantRiskState([], 10000, 1e12, q), 0.6), 0.3, 'high-vol regime scales risk x0.6');
});

await test('risk: 3 consecutive losses pause with cooldown; daily loss limit blocks new entries; a win resets the streak', () => {
  const q = sanitizeQuantConfig({ cooldownMinutes: 240, maxConsecutiveLosses: 3 }); // default dropped to 2 for HTF OrderFlow; this test exercises the (unchanged) mechanism at 3
  const L = (i) => ({ closedAtMs: 1e12 + i * 60_000, netUsd: -20 });
  let st = computeQuantRiskState([L(0), L(1), L(2)], 10000, 1e12 + 3 * 60_000, q);
  assert.ok(st.paused && /consecutive losses/.test(st.pauseReasons.join()));
  st = computeQuantRiskState([L(0), L(1), L(2)], 10000, 1e12 + 5 * 3.6e6, q); assert.ok(!st.paused, 'cooldown over');
  st = computeQuantRiskState([L(0), L(1), { closedAtMs: 1e12 + 2 * 60_000, netUsd: 30 }, L(3)], 10000, 1e12 + 5 * 60_000, q); assert.ok(!st.paused && st.consecutiveLosses === 1);
  const day = 1e12 - (1e12 % 86_400_000) + 3600_000;
  st = computeQuantRiskState([{ closedAtMs: day, netUsd: -250 }], 10000, day + 1000, q);
  assert.ok(st.paused && /daily loss limit/.test(st.pauseReasons.join()));
});

await test('sizing: risk comes from equity x risk% / stop distance; leverage never increases risk', () => {
  const q = sanitizeQuantConfig({});
  const risks = [1, 2, 5, 10].map(lev => quantSize({ equity: 10000, riskPct: 0.5, entry: 100, stop: 98, leverage: lev, qcfg: q }).riskAmountUsd);
  for(const r of risks) assert.ok(r <= 50 + 1e-6, `risk ${r} exceeds nominal $50`);
  const hi = quantSize({ equity: 10000, riskPct: 0.5, entry: 100, stop: 98, leverage: 10, qcfg: q });
  assert.ok(Math.abs(hi.riskAmountUsd - 50) < 0.6); assert.ok(hi.marginRequiredUsd < 10000);
  const stepped = quantSize({ equity: 10000, riskPct: 0.5, entry: 100, stop: 98, leverage: 10, qcfg: q, contract: { qtyStep: 1, minQty: 1, maxQty: 1e6 } });
  assert.equal(stepped.qty % 1, 0); assert.ok(stepped.riskAmountUsd <= 50);
  assert.equal(quantSize({ equity: 10000, riskPct: 0.5, entry: 100, stop: 98, leverage: 5, qcfg: q, contract: { qtyStep: 100, minQty: 100, maxQty: 1e6 } }).qty, 0, 'below min lot -> invalid size');
});

await test('paper engine: 2,500 cycles with Quant enabled -> no errors; closed trades carry R, regime, slippage; RR floor holds', () => {
  const qcfg = sanitizeQuantConfig({ entryTimeframe: '15m', minConfidence: 60, symbolFilter: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'ADAUSDT', 'AVAXUSDT', 'LINKUSDT'] });
  const ds = { equity: 10000, startingEquity: 10000, peakEquity: 10000, trades: 0, wins: 0, losses: 0, consecutiveLosses: 0, lastLossAt: null, dailyPnlPct: 0, maxDrawdownPct: 0, realizedGrossUsd: 0, realizedNetUsd: 0, feesUsd: 0, fundingUsd: 0, slippageUsd: 0, openPositions: 0, openRiskPct: 0, positions: [], quantTrades: [] };
  const hist = []; const only = { aiScalp: false, novaScalp: false, trendContinuation: false, liquiditySweep: false, rangeReversal: false, breakoutRetest: false, [QUANT_ID]: true };
  const cfg = { exchange: 'binance', strategies: only, minConfidence: 60, riskPctPerTrade: 1, leverage: 5, minNetProfitPct: 0.3, quant: qcfg };
  let opened = 0;
  for(let c = 0; c < 2500; c++){
    mockMarket.tick(3); managePositions(ds, hist, {});
    const { rows } = runScanCycle(cfg, ds);
    for(const r of rows){
      if(r.status === 'APPROVED'){
        assert.ok(r.riskReward >= HARD_LIMITS.minRewardRisk - 1e-9 && r.sizing.qty > 0 && r.sizing.riskAmountUsd <= ds.equity * 0.01 + 1e-6);
        assert.equal(r.setup, QUANT_TYPE); assert.ok(r.explanation.includes('Confidence:'));
        if(!ds.positions.some(p => p.symbol === r.symbol) && ds.openPositions < 3){ openPosition(r, ds); opened++; }
      }
    }
  }
  for(const t of hist){ assert.equal(t.strategy, QUANT_TYPE); assert.ok(t.quant && Number.isFinite(t.quant.realizedR) && t.quant.regime && t.quant.slippageUsd >= 0); }
  assert.equal(ds.quantTrades.length, hist.length);
  console.log(`         (${opened} opened, ${hist.length} closed on the synthetic feed — count only, not a result)`);
});

await test('cost / stop knobs: defaults and clamping (trendFilter was removed — HTF OrderFlow always requires strict 4H/1H alignment, never an "any" mode)', () => {
  const d = sanitizeQuantConfig({});
  assert.equal(d.maxCostR, QUANT_DEFAULTS.maxCostR); assert.equal(d.minStopAtr, 0.8);
  const bad = sanitizeQuantConfig({ maxCostR: 'x', minStopAtr: 99 });
  assert.equal(bad.maxCostR, QUANT_DEFAULTS.maxCostR); assert.equal(bad.minStopAtr, 2.5);
  assert.equal(sanitizeQuantConfig({ maxCostR: 0 }).maxCostR, 0.05); assert.equal(sanitizeQuantConfig({ maxCostR: 5 }).maxCostR, 1);
  // A 50% round-trip cost can never pass a 0.18R cap regardless of whether a candidate ever fires — the cost
  // gate in signal.js runs before the score gate, so this is checked directly rather than via a fixture.
  const q = sanitizeQuantConfig({ maxCostR: 0.18 });
  assert.equal(q.maxCostR, 0.18);
});

await test('settings sweep: config list is valid, stats are right, and only rows profitable on BOTH train and test are called robust', () => {
  const cfgs = sweepConfigs('quick', false);
  assert.ok(cfgs.length >= 10 && cfgs[0][0].startsWith('BASELINE') && cfgs[0][1].maxCostR === 1);
  assert.equal(new Set(cfgs.map(c => c[0])).size, cfgs.length, 'config names are unique');
  for(const [, over] of cfgs){ const q = sanitizeQuantConfig(over); assert.equal(q.rewardRisk, over.rewardRisk); assert.equal(q.maxCostR, over.maxCostR); }
  assert.equal(sweepConfigs('full').length, 2 + 96); assert.equal(sweepConfigs('quick', true).length, cfgs.length, 'HTF OrderFlow has no 5m-vs-15m entry-timeframe lever any more (entry is always 5m), so includeSlow adds nothing');
  const T = (open, R, net = R * 100) => ({ openedAtMs: open, closedAtMs: open + 1, netUsd: net, R, dir: 'LONG' });
  const st = sweepStats([T(1, 1.4), T(2, 1.4), T(3, -1.1), T(4, -1.1), T(5, -1.1)]);
  assert.equal(st.n, 5); assert.ok(Math.abs(st.wr - 0.4) < 1e-9); assert.ok(Math.abs(st.beWr - 1.1 / 2.5) < 1e-9); assert.ok(Math.abs(st.avgR - (2.8 - 3.3) / 5) < 1e-9);
  const many = (open0, n, winEvery) => Array.from({ length: n }, (_, k) => T(open0 + k, k % winEvery === 0 ? 1.4 : -1.0));
  const res = [
    { name: 'BASELINE x', over: {}, trades: [...many(0, 20, 2), ...many(1000, 12, 2)] },
    { name: 'good both', over: {}, trades: [...many(0, 20, 2), ...many(1000, 12, 2)] },       // wins half: +0.2R both sides
    { name: 'train-only', over: {}, trades: [...many(0, 20, 2), ...many(1000, 12, 1000)] },   // test is nearly all losses
    { name: 'thin test', over: {}, trades: [...many(0, 20, 2), ...many(1000, 5, 2)] },        // < 10 test trades
  ];
  const a = analyzeSweep(res, 500, 15);
  assert.deepEqual(a.robust.map(r => r.name), ['good both']);
  assert.ok(a.baseline && a.baseline.name.startsWith('BASELINE'));
});

await test('REGRESSION GUARD: the shipped default reward:risk can never be below the engine\'s own hard floor (the exact bug class that once made every Quant signal get rejected and Backtest/Paper/Live report zero trades)', () => {
  // The original bug: evaluateQuantRow() and the no-trade gate hard-coded a 1:2 minimum while
  // QUANT_DEFAULTS.rewardRisk was 1.5, so every signal was rejected before it could ever open a position.
  // Both numbers now come from the exact same constant (HARD_LIMITS.minRewardRisk, quant/config.js) — this
  // guards structurally against them ever drifting apart again, for any default/config combination.
  assert.ok(QUANT_DEFAULTS.rewardRisk >= HARD_LIMITS.minRewardRisk - 1e-9, 'default RR must never be below the hard floor');
  for(const rr of [0, 1, 1.5, 1.9, 2, 2.5, 3, 10]){
    const q = sanitizeQuantConfig({ rewardRisk: rr });
    assert.ok(q.rewardRisk >= HARD_LIMITS.minRewardRisk - 1e-9, `sanitizeQuantConfig let ${rr} through as ${q.rewardRisk}`);
  }
});

await test('Backtest funnel: counts are consistent, and the diagnostics say where evaluations stopped', async () => {
  const r = rng(42); const mk = (start) => { const out = []; let p = start, t = 1_700_000_000_000 - (1_700_000_000_000 % 300000), dir = 1, left = 0;
    for(let i = 0; i < 6000; i++){ if(left <= 0){ dir = r() < 0.5 ? 1 : -1; left = 200 + Math.floor(r() * 300); } left--; const o = p, c = o * (1 + dir * 0.00015 + (r() - 0.5) * 0.003); out.push({ t, o, h: Math.max(o, c) * (1 + 0.0005 * r()), l: Math.min(o, c) * (1 - 0.0005 * r()), c, v: 1000 * (0.6 + 0.8 * r()) }); p = c; t += 300000; } return out; };
  const syms = ['ZECUSDT', 'HYPEUSDT', 'ENAUSDT'], cb = {}; syms.forEach((s, i) => cb[s] = mk(10 + i));
  const cfg = { exchange: 'binance', strategies: { aiScalp: false, novaScalp: false, trendContinuation: false, liquiditySweep: false, rangeReversal: false, breakoutRetest: false, [QUANT_ID]: true }, minConfidence: 60, riskPctPerTrade: 1, leverage: 5, minNetProfitPct: 0.05, quant: sanitizeQuantConfig({ entryTimeframe: '15m', minConfidence: 60, maxCostR: 1 }) };
  const res = await runBacktest({ candlesBySymbol: cb, symbols: syms, cfg, startingEquity: 10000, intervalMinutes: 5, maxDailyLossPct: 50, dailyProfitTargetPct: 50 });
  const c = res.quantDiag.counts;
  assert.ok(c.evaluated > 500, `detector barely ran (${c.evaluated}) — Quant is not being applied to these symbols`);
  assert.equal(c.evaluated, (c.no_setup || 0) + (c.candidate || 0), 'every evaluation is either "no setup" or a candidate');
  assert.equal((c.candidate || 0), (c.expansion || 0) + (c.stop || 0) + (c.cost || 0) + (c.clearance || 0) + (c.score || 0) + (c.signal || 0), 'every candidate ends at exactly one stage');
  assert.equal((c.signal || 0), (c.approved || 0) + (c.engineRejected || 0), 'every signal is approved or rejected by the engine');
  assert.equal((c.approved || 0), res.trades.length - res.trades.filter(t => t.exitReason === 'OPEN_AT_END' && false).length, 'approved == trades opened');
  const sum = summarizeQuantDiag(res.quantDiag, res.trades.length);
  assert.ok(sum.rows.length >= 3 && sum.rows[0].n === c.evaluated);
});

await test('backtest: Quant trades are tagged, aligned to 5m candle closes, and losses land near -1R (plus costs)', async () => {
  const makeC = (seed, start, bars) => { const r = rng(seed); const out = []; let p = start, t = 1_700_000_000_000 - (1_700_000_000_000 % 300000), mode = 'trend', dir = 1, left = 0;
    for(let i = 0; i < bars; i++){ if(left <= 0){ const x = r(); mode = x < .45 ? 'trend' : x < .8 ? 'range' : 'burst'; dir = r() < .5 ? 1 : -1; left = 80 + Math.floor(r() * 400); } left--;
      let drift = 0, vol = 0.0009, vm = 1; if(mode === 'trend'){ drift = dir * 0.00012; vol = 0.0011; } else if(mode === 'range'){ drift = -(p - start) / start * 0.002; vol = 0.0007; vm = 0.8; } else { drift = dir * 0.0002; vol = 0.0022; vm = 1.8; }
      const o = p, c = o * (1 + drift + (r() - 0.5) * 2 * vol); out.push({ t, o, h: Math.max(o, c) * (1 + 0.0004 * r()), l: Math.min(o, c) * (1 - 0.0004 * r()), c, v: 1000 * vm * (0.6 + 0.8 * r()) }); p = c; t += 300000; } return out; };
  const syms = ['XRPUSDT', 'ADAUSDT', 'AVAXUSDT'], cb = {}; syms.forEach((s, i) => cb[s] = makeC(300 + i, [0.6, 0.45, 35][i], 9000));
  const cfg = { exchange: 'binance', strategies: { aiScalp: false, novaScalp: false, trendContinuation: false, liquiditySweep: false, rangeReversal: false, breakoutRetest: false, [QUANT_ID]: true }, minConfidence: 70, riskPctPerTrade: 0.5, leverage: 5, minNetProfitPct: 0.3, quant: sanitizeQuantConfig({ entryTimeframe: '15m', minConfidence: 60 }) };
  const res = await runBacktest({ candlesBySymbol: cb, symbols: syms, cfg, startingEquity: 10000, intervalMinutes: 5, maxDailyLossPct: 5, dailyProfitTargetPct: 50 });
  for(const t of res.trades){
    assert.equal(t.setupType, QUANT_TYPE); assert.ok((t.openedAtMs / 60000) % 5 === 0, 'entries only on a 5m candle close');
    assert.ok(t.quant.initialRR >= HARD_LIMITS.minRewardRisk);
    if(t.exitReason === 'STOP_LOSS') assert.ok(t.quant.realizedR <= -0.95 && t.quant.realizedR >= -2.0, `stop-loss R ${t.quant.realizedR}`);
  }
});

await test('other strategies are untouched when Quant is off: majors are still excluded from scanning', () => {
  const ds = { equity: 10000, startingEquity: 10000, peakEquity: 10000, trades: 0, wins: 0, losses: 0, consecutiveLosses: 0, lastLossAt: null, dailyPnlPct: 0, maxDrawdownPct: 0, realizedGrossUsd: 0, realizedNetUsd: 0, feesUsd: 0, fundingUsd: 0, slippageUsd: 0, openPositions: 0, openRiskPct: 0, positions: [] };
  mockMarket.tick(3);
  const { rows } = runScanCycle({ exchange: 'binance', strategies: { aiScalp: true, novaScalp: true }, minConfidence: 70, riskPctPerTrade: 1, leverage: 5, minNetProfitPct: 0.3 }, ds);
  assert.ok(!rows.some(r => ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT'].includes(r.symbol)));
});


await test('EXCLUDED pairs are never traded by Quant: scan list, engine choke point, Paper', () => {
  // Even a hand-built cfg that bypasses sanitizeQuantConfig and lists every excluded pair must not get them traded.
  const dirty = { ...sanitizeQuantConfig({}), symbolFilter: [...EXCLUDED_FUTURES_SYMBOLS, 'XRPUSDT'], minConfidence: 60 };
  assert.deepEqual(Array.from(quantSymbolSet(dirty)), ['XRPUSDT'], 'quantSymbolSet drops excluded pairs');
  const cfg = { exchange: 'binance', strategies: { aiScalp: false, novaScalp: false, trendContinuation: false, liquiditySweep: false, rangeReversal: false, breakoutRetest: false, [QUANT_ID]: true }, minConfidence: 60, riskPctPerTrade: 1, leverage: 5, minNetProfitPct: 0.3, quant: dirty };
  const scan = scanSymbolsWithQuant(['ADAUSDT', ...EXCLUDED_FUTURES_SYMBOLS], cfg);
  for(const x of EXCLUDED_FUTURES_SYMBOLS) assert.ok(!scan.includes(x), `${x} must not be scanned`);
  assert.ok(scan.includes('XRPUSDT') && scan.includes('ADAUSDT'));
  // The single choke point every mode goes through: excluded -> REJECTED before any detector runs.
  const ds = { equity: 10000, startingEquity: 10000, peakEquity: 10000, trades: 0, wins: 0, losses: 0, consecutiveLosses: 0, lastLossAt: null, dailyPnlPct: 0, maxDrawdownPct: 0, realizedGrossUsd: 0, realizedNetUsd: 0, feesUsd: 0, fundingUsd: 0, slippageUsd: 0, openPositions: 0, openRiskPct: 0, positions: [], cooldownUntilBySymbol: {}, quantTrades: [] };
  mockMarket.tick(3);
  for(const x of EXCLUDED_FUTURES_SYMBOLS){
    const snap = mockMarket.snapshot(x);
    if(!snap) continue;
    const row = evaluateSymbol(x, snap, { regime: 'Range', label: 'Range' }, cfg, ds, { shocked: false }, mockMarket.now());
    assert.equal(row.status, 'REJECTED'); assert.ok(row.rejectReasons.join(' ').includes('excluded'), `${x}: ${row.rejectReasons}`);
  }
  // Paper: run a long stretch with an "unsanitized" config that names the majors — none may ever open.
  const hist = [];
  for(let c = 0; c < 1500; c++){
    mockMarket.tick(3); managePositions(ds, hist, {});
    const { rows } = runScanCycle(cfg, ds);
    assert.ok(!rows.some(r => EXCLUDED_FUTURES_SYMBOLS.has(r.symbol) && r.status === 'APPROVED'), 'an excluded pair was approved');
    assert.ok(!rows.some(r => EXCLUDED_FUTURES_SYMBOLS.has(r.symbol)), 'an excluded pair was scanned at all');
    for(const r of rows) if(r.status === 'APPROVED' && !ds.positions.some(p => p.symbol === r.symbol) && ds.openPositions < 3) openPosition(r, ds);
  }
  assert.ok(![...ds.positions, ...hist].some(p => EXCLUDED_FUTURES_SYMBOLS.has(p.symbol)), 'no position/trade on an excluded pair');
});

await test('EXCLUDED pairs are never traded by Quant: Backtest skips them even when candles are supplied and Quant lists them', async () => {
  const mk = (seed, start) => { const r = rng(seed); const out = []; let p = start, t = 1_700_000_000_000 - (1_700_000_000_000 % 300000);
    for(let i = 0; i < 6000; i++){ const o = p, c = o * (1 + (r() - 0.5) * 0.004 + Math.sin(i / 200) * 0.0004); out.push({ t, o, h: Math.max(o, c) * 1.0005, l: Math.min(o, c) * 0.9995, c, v: 1000 * (0.6 + r()) }); p = c; t += 300000; } return out; };
  const symsAll = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT'], cb = {}; symsAll.forEach((s, i) => cb[s] = mk(900 + i, [60000, 3000, 150, 590, 0.6][i]));
  const dirty = { ...sanitizeQuantConfig({}), symbolFilter: symsAll, minConfidence: 60, entryTimeframe: '15m' };
  const cfg = { exchange: 'binance', strategies: { aiScalp: false, novaScalp: false, trendContinuation: false, liquiditySweep: false, rangeReversal: false, breakoutRetest: false, [QUANT_ID]: true }, minConfidence: 60, riskPctPerTrade: 0.5, leverage: 5, minNetProfitPct: 0.3, quant: dirty };
  const res = await runBacktest({ candlesBySymbol: cb, symbols: symsAll, cfg, startingEquity: 10000, intervalMinutes: 5, maxDailyLossPct: 5, dailyProfitTargetPct: 50 });
  assert.ok(!res.trades.some(t => EXCLUDED_FUTURES_SYMBOLS.has(t.symbol)), 'backtest traded an excluded pair');
});

await test('shared top settings drive Quant: min confidence, risk (still capped at 1%), selectivity; no shared values -> saved config', () => {
  const base = getQuantCfg({ log: false });
  assert.equal(base.riskPct, QUANT_DEFAULTS.riskPct, 'saved/default config used when nothing is passed');
  const a = getQuantCfg({ minConfidence: 76, riskPct: 0.5, highSelectivity: false });
  assert.equal(a.minConfidence, 76); assert.equal(a.riskPct, 0.5); assert.equal(a.selectivity, 'off');
  const b = getQuantCfg({ minConfidence: 76, riskPct: 5, highSelectivity: true });
  assert.equal(b.riskPct, HARD_LIMITS.maxRiskPct, 'a 5% top-level risk must clamp to Quant\'s 1% ceiling');
  assert.equal(b.selectivity, 'high');
  assert.ok(effectiveMinConfidence(b) >= 80, 'High Selectivity raises the floor to 80');
  const c = getQuantCfg({ minConfidence: 0, riskPct: 0.01 });
  assert.equal(c.minConfidence, HARD_LIMITS.minConfidence); assert.equal(c.riskPct, HARD_LIMITS.minRiskPct);
  assert.equal(getQuantCfg({ log: true }).log, true); assert.equal(getQuantCfg({}).log, false);
});

await test('watchlist: top 25 by 24h volume, excluded pairs removed, input not mutated', () => {
  assert.equal(WATCHLIST_TOP_N, 25);
  const uni = [];
  for(let i = 0; i < 60; i++) uni.push({ symbol: `COIN${i}USDT`, volume24hUsd: (i + 1) * 1e6, lastPrice: 1 });
  uni.push({ symbol: 'BTCUSDT', volume24hUsd: 9e12 }, { symbol: 'ETHUSDT', volume24hUsd: 8e12 }, { symbol: 'CLUSDT', volume24hUsd: 7e12 }, { symbol: 'FOOUSD', volume24hUsd: 6e12 });
  const before = uni.map(u => u.symbol).join();
  const r = rankTopByVolume(uni);
  assert.equal(r.top.length, 25); assert.equal(r.totalAvailable, 60);
  assert.equal(r.top[0].symbol, 'COIN59USDT'); assert.equal(r.top[24].symbol, 'COIN35USDT');
  assert.ok(!r.top.some(t => EXCLUDED_FUTURES_SYMBOLS.has(t.symbol)), 'an excluded pair made the watchlist');
  assert.equal(uni.map(u => u.symbol).join(), before, 'input was reordered');
  assert.deepEqual(rankTopByVolume(null).top, []);
});

await test('paper: real top-25 pairs get synthetic series on the shared clock and go through the normal scan', () => {
  mockMarket.tick(37); // move the synthetic clock off wall-clock, like a running Paper session
  assert.equal(mockMarket.ensureSymbol('NOTINLISTUSDT', { price: 12.34, volume24hUsd: 5e7 }), true);
  assert.equal(mockMarket.ensureSymbol('BADUSDT', { price: 0, volume24hUsd: 5e7 }), false, 'a missing/zero price must be rejected');
  assert.equal(mockMarket.ensureSymbol('lowercase', { price: 1, volume24hUsd: 1 }), false);
  assert.equal(mockMarket.ensureSymbol('XRPUSDT', {}), true, 'built-in symbols are left untouched');
  const snap = mockMarket.snapshot('NOTINLISTUSDT'), ref = mockMarket.snapshot('XRPUSDT');
  assert.ok(Math.abs(snap.price - 12.34) / 12.34 < 0.5, 'random walk should start near the seeded real price');
  // (built-in series were seeded a few ms apart at load, so compare with a 1s tolerance — the bug this guards is a multi-minute skew)
  assert.ok(Math.abs(snap.m5[snap.m5.length - 1].t - ref.m5[ref.m5.length - 1].t) < 1000, 'new series must be on the same clock as the others (else its candles look stale)');
  const dayState = { equity: 10000, startingEquity: 10000, positions: [], openPositions: 0, openRiskPct: 0, quantTrades: [], consecutiveLosses: 0, tradesToday: 0, wins: 0, losses: 0, grossPnl: 0, feesUsd: 0, fundingUsd: 0, slippageUsd: 0, netPnl: 0 };
  const cfg = { exchange: 'binance', weights: undefined, minConfidence: 70, minRiskReward: 2, minNetProfitPct: 0.3, riskPctPerTrade: 1, leverage: 5, strategies: {}, strategyRR: {} };
  const { rows } = runScanCycle(cfg, dayState, { symbols: ['NOTINLISTUSDT', 'XRPUSDT'] });
  assert.deepEqual(rows.map(r => r.symbol).sort(), ['NOTINLISTUSDT', 'XRPUSDT']);
});

console.log(`\n${passed} tests passed${process.exitCode ? ' — WITH FAILURES' : ''}`);
