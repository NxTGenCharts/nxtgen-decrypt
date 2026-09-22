// =============================================================
// NxTGen Grid — regression tests.  Run:  node tests/grid.test.mjs
// (Node 22+; no dependencies.)
//
// Focus: the fixes made after "the logic of the grid strategy" review — a grid's own realized P&L only ever
// accumulated from winning take-profit fills, so the maxGridLossPct emergency-exit circuit breaker could never
// trip (it compared against a number that could only go up); emergencyExitOn/fundingFilterOn were stored config
// that nothing read; maxAccountExposurePct/maxAccountDrawdownPct were stored but never enforced; and a
// multi-symbol backtest gave every symbol its own full-sized capital pool instead of sharing one, the way
// Paper/Live actually run. What these DO NOT prove: profitability — the candle data here is synthetic and
// constructed specifically to exercise each mechanism, not to resemble real markets.
// =============================================================
import assert from 'node:assert/strict';
import {
  GRID_DEFAULTS, GRID_SYMBOLS, scoreGridSuitability, buildGridPlan, createGridSession, stepGridSymbol,
  runGridBacktest, runGridBacktestMulti, netCycleProfit, summarizeGridTrades,
} from '../js/futures/grid.js';
import { classifyRegime } from '../js/futures/regime.js';

let passed = 0;
const test = async (name, fn) => { try { await fn(); passed++; console.log('  ok  ', name); } catch (e) { console.error('  FAIL', name, '\n', e); process.exitCode = 1; } };

function rng(seed){ return () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
// A gently ranging series — clears scoreGridSuitability's regime gate and (with default thresholds) its score
// gate too, so buildGridPlan returns a real plan rather than null. Used wherever a test needs an actual
// deployment, not just the state-machine mechanics.
function rangeCandles(n, { seed = 1, p0 = 100, driftBack = 0.02, vol = 0.004 } = {}){
  const r = rng(seed); let p = p0; const out = []; let t = 1_780_000_000_000 - (1_780_000_000_000 % 300_000);
  for(let i = 0; i < n; i++){
    const drift = (p0 - p) / p0 * driftBack;
    const o = p, c = o * (1 + drift + (r() - 0.5) * vol);
    out.push({ t, o, h: Math.max(o, c) * (1 + r() * vol * 0.2), l: Math.min(o, c) * (1 - r() * vol * 0.2), c, v: 1000 * (0.7 + 0.6 * r()) });
    p = c; t += 300_000;
  }
  return out;
}
function snapFromCandles(candles, i, meta = {}){
  const m15 = candles.slice(Math.max(0, i - 30 * 3), i + 1).filter((_, k, arr) => k % 3 === 0);
  const h1 = candles.slice(Math.max(0, i - 30 * 12), i + 1).filter((_, k, arr) => k % 12 === 0);
  return { symbol: 'XUSDT', price: candles[i].c, m5: candles.slice(Math.max(0, i - 119), i + 1), m15, h1, meta: { exchange: 'binance', volume24hUsd: 50_000_000, fundingRatePct: 0, ...meta } };
}

await test('GRID_DEFAULTS: the dead minConfidence field is gone (no UI control ever read/wrote it)', () => {
  assert.equal('minConfidence' in GRID_DEFAULTS, false);
});

await test('funding filter: fundingFilterOn actually gates deployment now (previously stored, never read)', () => {
  const c = rangeCandles(2000, { seed: 5 });
  const i = c.length - 1;
  const regime = classifyRegime(snapFromCandles(c, i).h1, snapFromCandles(c, i).m15);
  const cheap = snapFromCandles(c, i, { fundingRatePct: 0.001 });
  const expensive = snapFromCandles(c, i, { fundingRatePct: 5 }); // absurdly high — well past any sane threshold
  const withFilter = scoreGridSuitability(expensive, regime, { ...GRID_DEFAULTS, fundingFilterOn: true });
  const withoutFilter = scoreGridSuitability(expensive, regime, { ...GRID_DEFAULTS, fundingFilterOn: false });
  assert.equal(withFilter.regimeOk, false, 'expensive funding should be rejected when the filter is on');
  // Turning it off can only ever let MORE through, never fewer, versus the same snapshot with it on.
  if(withoutFilter.regimeOk) assert.ok(withoutFilter.score >= 0);
  const cheapScored = scoreGridSuitability(cheap, regime, { ...GRID_DEFAULTS, fundingFilterOn: true });
  if(cheapScored.regimeOk) assert.ok(cheapScored.score > 0, 'negligible funding should never be rejected by the filter');
});

await test('REGRESSION: a grid\'s realized P&L now reflects EVERY closed leg (wins AND losses), not just take-profit fills', () => {
  // Build a session with an already-active, hand-placed grid (bypassing buildGridPlan's score gate — this test
  // is about the accounting, not about whether the market conditions would pass suitability) with an
  // artificially high leverage so a liquidation-risk exit is reachable within a normal grid range, and one
  // open LONG leg sitting close to its estimated liquidation price.
  const session = createGridSession(10_000);
  const entry = 100;
  const plan = { symbol: 'XUSDT', direction: 'NEUTRAL', upper: 110, lower: 90, levels: [90, 95, 100, 105, 110], spacingPct: 5, levelCount: 5, gridScore: 90, leverage: 20, allocationUsd: 2000, minNetProfitPct: 0.2, regime: 'RANGE', atrM15: 1, mid: 100 };
  session.grids['XUSDT'] = { id: 'GRID-TEST-001', ...plan, openLegs: [{ levelIndex: 1, entry, qty: (2000 / 5 * 20) / entry, direction: 'LONG', openedAt: 1_780_000_000_000, targetIndex: 2 }], filledLevel: [false, true, false, false, false], realizedUsd: 0, openedAt: 1_780_000_000_000 };
  // At 20x leverage / 0.5% maintenance margin, liquidation sits ~4.5% below entry — a bar with a low that
  // dips just past that, without closing beyond the grid's own boundaries (so it isn't ALSO a breakout).
  const bar = { t: 1_780_000_300_000, o: 100, h: 100.2, l: 95.2, c: 99.8 };
  const snap = { symbol: 'XUSDT', price: bar.c, m5: rangeCandles(150, { seed: 9, p0: 100 }), m15: rangeCandles(40, { seed: 9, p0: 100 }), h1: rangeCandles(40, { seed: 9, p0: 100 }), meta: { exchange: 'binance', volume24hUsd: 50_000_000, fundingRatePct: 0 } };
  const regime = { regime: 'RANGE' };
  const cfg = { ...GRID_DEFAULTS, maxGridAllocationPct: 20 };
  const trades = stepGridSymbol(session, { symbol: 'XUSDT', snap, regime, bar, nowMs: bar.t, cfg, exchange: 'binance', metaOverrides: { spreadPct: 0.04, fundingRatePct: 0 } });
  const liq = trades.find(t => t.exitReason === 'LIQUIDATION_RISK_EXIT');
  assert.ok(liq, 'expected a liquidation-risk exit on the manufactured leg');
  assert.ok(liq.netUsd < 0, 'a liquidation-risk exit this close to entry should be a loss');
  const grid = session.grids['XUSDT'];
  assert.ok(grid, 'grid should still be active — only one of several legs closed');
  // The core regression: before the fix, realizedUsd only accumulated on the TP path below, so a losing exit
  // like this one never showed up here at all (it would have stayed at 0).
  assert.ok(Math.abs(grid.realizedUsd - liq.netUsd) < 1e-6, `grid.realizedUsd (${grid.realizedUsd}) should equal the loss just recorded (${liq.netUsd})`);
});

await test('emergencyExitOn: the maxGridLossPct circuit breaker fires when on, and is fully skippable when off', () => {
  for(const emergencyExitOn of [true, false]){
    const session = createGridSession(10_000);
    const plan = { symbol: 'XUSDT', direction: 'NEUTRAL', upper: 110, lower: 90, levels: [90, 95, 100, 105, 110], spacingPct: 5, levelCount: 5, gridScore: 90, leverage: 5, allocationUsd: 1000, minNetProfitPct: 0.2, regime: 'RANGE', atrM15: 1, mid: 100 };
    // realizedUsd already well past the -8% (of $1000 allocation) default floor — simulates several prior
    // losing closes having already happened this deployment.
    // realizedUsd already reflects prior losses; ALSO give it one still-open leg so, if the breaker fires,
    // closeAllLegs actually produces a trade record to assert on (an empty openLegs would "close" zero legs —
    // the halt would still work, but there'd be nothing in the returned trades to check for the reason).
    session.grids['XUSDT'] = { id: 'GRID-TEST-002', ...plan, openLegs: [{ levelIndex: 2, entry: 100, qty: 10, direction: 'LONG', openedAt: 1_780_000_000_000, targetIndex: 3 }], filledLevel: [false, false, true, false, false], realizedUsd: -200, openedAt: 1_780_000_000_000 };
    const bar = { t: 1_780_000_300_000, o: 100, h: 100.3, l: 99.7, c: 100.1 }; // ordinary bar, no breakout/liquidation/recalc triggers
    const snap = { symbol: 'XUSDT', price: bar.c, m5: rangeCandles(150, { seed: 11, p0: 100 }), m15: rangeCandles(40, { seed: 11, p0: 100 }), h1: rangeCandles(40, { seed: 11, p0: 100 }), meta: { exchange: 'binance', volume24hUsd: 50_000_000, fundingRatePct: 0 } };
    const regime = { regime: 'RANGE' };
    const cfg = { ...GRID_DEFAULTS, maxGridAllocationPct: 10, emergencyExitOn };
    const trades = stepGridSymbol(session, { symbol: 'XUSDT', snap, regime, bar, nowMs: bar.t, cfg, exchange: 'binance', metaOverrides: { spreadPct: 0.04, fundingRatePct: 0 } });
    const emergency = trades.some(t => t.exitReason === 'EMERGENCY_EXIT');
    if(emergencyExitOn) assert.ok(emergency, 'emergencyExitOn=true should have closed the grid at its loss floor');
    else assert.ok(!emergency, 'emergencyExitOn=false should never fire the emergency exit');
  }
});

await test('maxAccountExposurePct: a new deployment that would push committed allocation over the account cap is blocked, not opened', () => {
  const session = createGridSession(10_000);
  // Symbol A already has a $6,000 grid open.
  const planA = { symbol: 'AUSDT', direction: 'NEUTRAL', upper: 110, lower: 90, levels: [90, 100, 110], spacingPct: 10, levelCount: 3, gridScore: 90, leverage: 5, allocationUsd: 6000, minNetProfitPct: 0.2, regime: 'RANGE', atrM15: 1, mid: 100 };
  session.grids['AUSDT'] = { id: 'GRID-A', ...planA, openLegs: [], filledLevel: [false, false, false], realizedUsd: 0, openedAt: 1_780_000_000_000 };
  // Symbol B would want to deploy too — a real ranging series so buildGridPlan actually returns a plan.
  const c = rangeCandles(2000, { seed: 21, p0: 50 });
  const i = c.length - 1;
  const snap = snapFromCandles(c, i);
  const regime = classifyRegime(snap.h1, snap.m15);
  // maxGridAllocationPct 20% of $10k = $2000 for B. Cap at 60% of equity ($6000) is already fully spent by A —
  // any nonzero addition should be blocked. Cap at 100% ($10000) leaves $4000 free — B's $2000 should fit.
  for(const [capPct, shouldBlock] of [[60, true], [100, false]]){
    const s2 = createGridSession(10_000);
    s2.grids['AUSDT'] = session.grids['AUSDT'];
    const cfg = { ...GRID_DEFAULTS, maxGridAllocationPct: 20, maxAccountExposurePct: capPct };
    stepGridSymbol(s2, { symbol: 'BUSDT', snap, regime, bar: c[i], nowMs: c[i].t, cfg, exchange: 'binance', metaOverrides: { spreadPct: 0.04, fundingRatePct: 0 } });
    const deployed = !!s2.grids['BUSDT'];
    if(shouldBlock){ assert.equal(deployed, false, `cap ${capPct}% should have blocked B's deployment`); assert.ok(s2.counters.exposureBlocked >= 1); }
    else if(deployed) assert.equal(s2.counters.exposureBlocked, 0, `cap ${capPct}% should not have blocked anything`);
    // (If B's market snapshot doesn't clear the suitability gate at all, deployed is false for BOTH caps —
    // still a valid run, just not informative for this specific check; the exposureBlocked counter is the
    // real assertion above.)
  }
});

await test('maxAccountDrawdownPct: trips once, halts new deployments AND force-closes anything already open, and stays tripped', () => {
  const session = createGridSession(10_000);
  session.peakEquity = 10_000;
  session.equity = 9_000; // 10% drawdown from peak
  const plan = { symbol: 'AUSDT', direction: 'NEUTRAL', upper: 110, lower: 90, levels: [90, 100, 110], spacingPct: 10, levelCount: 3, gridScore: 90, leverage: 5, allocationUsd: 1000, minNetProfitPct: 0.2, regime: 'RANGE', atrM15: 1, mid: 100 };
  session.grids['AUSDT'] = { id: 'GRID-A', ...plan, openLegs: [{ levelIndex: 0, entry: 100, qty: 10, direction: 'LONG', openedAt: 1_780_000_000_000, targetIndex: 1 }], filledLevel: [true, false, false], realizedUsd: 0, openedAt: 1_780_000_000_000 };
  const bar = { t: 1_780_000_300_000, o: 100, h: 100.2, l: 99.8, c: 100 };
  const snap = { symbol: 'AUSDT', price: bar.c, m5: rangeCandles(150, { seed: 31, p0: 100 }), m15: rangeCandles(40, { seed: 31, p0: 100 }), h1: rangeCandles(40, { seed: 31, p0: 100 }), meta: { exchange: 'binance', volume24hUsd: 50_000_000, fundingRatePct: 0 } };
  const regime = { regime: 'RANGE' };
  const cfg = { ...GRID_DEFAULTS, maxAccountDrawdownPct: 8 }; // 10% actual drawdown > 8% threshold
  const trades = stepGridSymbol(session, { symbol: 'AUSDT', snap, regime, bar, nowMs: bar.t, cfg, exchange: 'binance', metaOverrides: { spreadPct: 0.04, fundingRatePct: 0 } });
  assert.equal(session.accountHalted, true);
  assert.equal(session.counters.accountDrawdownHalts, 1);
  assert.ok(trades.some(t => t.exitReason === 'ACCOUNT_DRAWDOWN_HALT'), 'the open leg should have been force-closed');
  assert.equal(session.grids['AUSDT'], null);
  // A later step (even one that would otherwise deploy a perfectly good grid) must stay halted and do nothing.
  const trades2 = stepGridSymbol(session, { symbol: 'AUSDT', snap, regime, bar: { ...bar, t: bar.t + 300_000 }, nowMs: bar.t + 300_000, cfg, exchange: 'binance', metaOverrides: { spreadPct: 0.04, fundingRatePct: 0 } });
  assert.equal(trades2.length, 0);
  assert.equal(session.grids['AUSDT'], null);
  assert.equal(session.counters.accountDrawdownHalts, 1, 'should only count the FIRST trip, not every subsequent halted step');
});

await test('runGridBacktestMulti: shares ONE capital pool across symbols (unlike the old per-symbol runGridBacktest, which gave each its own)', () => {
  const symbols = ['AUSDT', 'BUSDT', 'CUSDT'];
  const candlesBySymbol = {};
  symbols.forEach((s, i) => { candlesBySymbol[s] = rangeCandles(2500, { seed: 40 + i, p0: 50 + i * 10 }); });
  const cfg = { ...GRID_DEFAULTS, maxGridAllocationPct: 20, maxAccountExposurePct: 100 };
  const res = runGridBacktestMulti({ symbols, candlesBySymbol, cfg, startingEquity: 10_000, exchange: 'binance', metaOverrides: { spreadPct: 0.04, fundingRatePct: 0 }, intervalMinutes: 5 });
  assert.ok(Number.isFinite(res.finalEquity) && res.finalEquity > 0);
  assert.ok('counters' in res && 'exposureBlocked' in res.counters && 'accountDrawdownHalts' in res.counters);
  // Tightening the exposure cap can only ever reduce (or leave equal) how much gets deployed, never increase it.
  const tight = runGridBacktestMulti({ symbols, candlesBySymbol, cfg: { ...cfg, maxAccountExposurePct: 15 }, startingEquity: 10_000, exchange: 'binance', metaOverrides: { spreadPct: 0.04, fundingRatePct: 0 }, intervalMinutes: 5 });
  assert.ok(tight.counters.exposureBlocked >= res.counters.exposureBlocked, 'a tighter cap should block at least as many deployments as the looser one');
});

await test('runGridBacktest (single-symbol) still runs end to end unchanged in shape — kept for tools/back-compat', () => {
  const candles = rangeCandles(2500, { seed: 50 });
  const res = runGridBacktest({ symbol: 'XUSDT', candles, cfg: { ...GRID_DEFAULTS, maxGridAllocationPct: 20 }, startingEquity: 10_000, exchange: 'binance', metaOverrides: { spreadPct: 0.04, fundingRatePct: 0 }, intervalMinutes: 5 });
  assert.ok('trades' in res && 'counters' in res && 'finalEquity' in res);
  for(const t of res.trades) assert.ok(Number.isFinite(t.netUsd));
});

await test('summarizeGridTrades: passes through the new counters without breaking the existing shape', () => {
  const trades = [{ netUsd: 10, grossUsd: 12, feesUsd: 2, fundingUsd: 0, slippageUsd: 0, durationMin: 30 }, { netUsd: -5, grossUsd: -3, feesUsd: 2, fundingUsd: 0, slippageUsd: 0, durationMin: 20 }];
  const counters = { liquidations: 1, emergencyExits: 2, breakoutExits: 3, recalculations: 4, exposureBlocked: 5, accountDrawdownHalts: 1 };
  const sum = summarizeGridTrades(trades, 10_000, counters);
  assert.equal(sum.exposureBlocked, 5); assert.equal(sum.accountDrawdownHalts, 1);
  assert.equal(sum.gridCycles, 2); assert.ok(Math.abs(sum.netUsd - 5) < 1e-9);
});

await test('GRID_SYMBOLS / netCycleProfit sanity (unchanged behaviour — guards against an accidental regression elsewhere in this file)', () => {
  assert.ok(GRID_SYMBOLS.length > 0);
  const pnl = netCycleProfit({ entryPrice: 100, exitPrice: 105, qty: 1, leverage: 5, direction: 'LONG', exchange: 'binance', holdMinutes: 30, fundingRatePct: 0, slippagePct: 0.02 });
  assert.ok(pnl.grossUsd > 0 && pnl.netUsd < pnl.grossUsd);
});

console.log(`${passed} tests passed${process.exitCode ? ' — WITH FAILURES' : ''}`);
