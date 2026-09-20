// =============================================================
// quant/features.js — the feature engine. Turns a market snapshot
// ({price, m5, m15, h1, meta}) into one deterministic feature object the
// regime engine, setup detectors and scorer all read from. Pure functions:
// no DOM, no network, no clock (time comes in via ctx.nowMs), so Paper,
// Backtest and Live/Demo feed the detector identical inputs.
//
// Timeframe plan
//   entry 5m  -> context: 15m, 1H, 4H
//   entry 15m -> context: 1H, 4H
// The snapshot carries no 4H series, so 4H is DERIVED from 1H by rolling
// groups of four (deriveH4). Window sizes are capped identically in every
// mode (entry 120, 15m 120, 1H 60 -> 15 x 4H) — Live receives longer
// arrays than Backtest, and without the cap the same code would see
// different history depending on where it runs. A Daily series is NOT
// available from any feed here, so daily context is not used.
// =============================================================
import { emaSeries, atr, adx, rsi, macdHistogram, vwap, swingHighPoints, swingLowPoints, efficiencyRatio, bollingerBandWidthSeries } from '../indicators.js';

export const mean = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
export const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

export function trueRanges(candles){
  const tr = new Array(candles.length).fill(null);
  for(let i = 1; i < candles.length; i++){
    const c = candles[i], p = candles[i - 1];
    tr[i] = Math.max(c.h - c.l, Math.abs(c.h - p.c), Math.abs(c.l - p.c));
  }
  return tr;
}

// Simple-mean ATR at every bar (same definition as indicators.atr, but a series).
export function atrSeries(candles, period){
  period = period || 14;
  const tr = trueRanges(candles);
  const out = new Array(candles.length).fill(null);
  for(let i = period; i < candles.length; i++){
    let s = 0;
    for(let k = i - period + 1; k <= i; k++) s += tr[k];
    out[i] = s / period;
  }
  return out;
}

// Fraction of `values` that are <= v (0..1).
export function percentileRank(values, v){
  if(!values.length) return 0.5;
  let n = 0;
  for(const x of values) if(x <= v) n++;
  return n / values.length;
}

// Rolling groups of `groupSize` candles taken from the END backwards (the
// same partition backtest.js's aggregateBase and mockMarket use), so the
// last group always ends on the newest candle.
export function aggregateGroups(candles, groupSize, count){
  const out = [];
  for(let end = candles.length; end > 0 && out.length < count; end -= groupSize){
    const start = Math.max(0, end - groupSize);
    const slice = candles.slice(start, end);
    if(slice.length < groupSize) break; // never emit a partial leading group
    out.unshift({
      t: slice[0].t, o: slice[0].o,
      h: Math.max(...slice.map(c => c.h)), l: Math.min(...slice.map(c => c.l)),
      c: slice[slice.length - 1].c, v: slice.reduce((a, c) => a + c.v, 0),
    });
  }
  return out;
}
export function deriveH4(h1){ return aggregateGroups(h1, 4, 15); }

export function candleStats(c){
  const range = Math.max(1e-12, c.h - c.l);
  const body = Math.abs(c.c - c.o);
  return {
    range, body, bodyRatio: body / range,
    upperWick: (c.h - Math.max(c.o, c.c)) / range,
    lowerWick: (Math.min(c.o, c.c) - c.l) / range,
    bull: c.c > c.o, bear: c.c < c.o,
    closePos: (c.c - c.l) / range, // 0 = closed on the low, 1 = closed on the high
  };
}

// Trend read for one timeframe's candles. p: { fast, slow, swing }
export function tfTrend(candles, p){
  const n = candles.length;
  if(n < p.slow + 4) return null;
  const c = candles.map(x => x.c);
  const f = emaSeries(c, p.fast), s = emaSeries(c, p.slow);
  const i = n - 1;
  const a = atr(candles, 14) || c[i] * 0.002;
  const spreadAtr = (f[i] - s[i]) / a;
  const slopeN = Math.min(5, i - 1);
  const slopeAtr = (s[i] - s[i - slopeN]) / a;
  const priceVsSlowAtr = (c[i] - s[i]) / a;
  const dir = (spreadAtr > 0.2 && slopeAtr > 0 && c[i] > s[i]) ? 1
    : (spreadAtr < -0.2 && slopeAtr < 0 && c[i] < s[i]) ? -1 : 0;
  const adxV = n >= 29 ? adx(candles, 14) : null;
  const er = efficiencyRatio(c, Math.min(10, n - 2)) || 0;
  const spreadTerm = clamp(Math.abs(spreadAtr) / 1.5, 0, 1);
  const strength = adxV != null
    ? clamp(0.5 * spreadTerm + 0.3 * clamp((adxV - 15) / 20, 0, 1) + 0.2 * er, 0, 1)
    : clamp(0.65 * spreadTerm + 0.35 * er, 0, 1);

  const L = p.swing || 2;
  const highs = swingHighPoints(candles, 0, n - 1, L, L);
  const lows = swingLowPoints(candles, 0, n - 1, L, L);
  const hi = highs.slice(-2), lo = lows.slice(-2);
  let structure = 'mixed';
  if(hi.length === 2 && lo.length === 2){
    const hh = hi[1].price > hi[0].price, hl = lo[1].price > lo[0].price;
    const lh = hi[1].price < hi[0].price, ll = lo[1].price < lo[0].price;
    if(hh && hl && c[i] > lo[1].price) structure = 'bull';
    else if(lh && ll && c[i] < hi[1].price) structure = 'bear';
  }
  return {
    n, dir, strength, spreadAtr, slopeAtr, priceVsSlowAtr, adx: adxV, er, atr: a, atrPct: (a / c[i]) * 100,
    structure, fastV: f[i], slowV: s[i],
    lastSwingHigh: highs.length ? highs[highs.length - 1].price : null,
    lastSwingLow: lows.length ? lows[lows.length - 1].price : null,
  };
}

function fail(reason, quiet){ return { ok: false, reason, quiet: !!quiet }; }

// Main entry. qcfg: sanitized quant config. ctx: { nowMs }.
export function buildFeatures(snap, qcfg, ctx){
  const tfMin = qcfg.entryTimeframe === '5m' ? 5 : 15;
  const tfMs = tfMin * 60_000;
  const nowMs = ctx && ctx.nowMs != null ? ctx.nowMs : null;
  const raw = tfMin === 5 ? snap.m5 : snap.m15;
  if(!raw || raw.length < 90) return fail(`Insufficient ${tfMin}m history`);
  const meta = snap.meta || {};

  // Simulated feeds (Backtest, Paper's synthetic market) flag their candles
  // as already closed. Real exchange feeds include the still-forming
  // candle, whose partial volume/range must not be read as a signal.
  const closedFlag = !!meta.candlesClosed;
  let E = raw.slice(-121);
  if(!closedFlag && nowMs != null && Number.isFinite(E[E.length - 1].t) && E[E.length - 1].t + tfMs > nowMs + 1000) E = E.slice(0, -1);
  E = E.slice(-120);
  if(E.length < 90) return fail(`Insufficient ${tfMin}m history`);

  if(!closedFlag && nowMs != null){
    const ageMs = nowMs - (E[E.length - 1].t + tfMs);
    if(ageMs > 2 * tfMs + 60_000) return fail(`Market data is stale (last closed ${tfMin}m candle ended ${Math.round(ageMs / 60000)}m ago)`);
  }
  // Backtests walk a finer base timeframe (5m) than a 15m entry: only act
  // when a wall-clock 15m candle has just closed, so signals are evaluated
  // once per real candle instead of on every overlapping rolling window.
  if(closedFlag && meta.baseIntervalMinutes && tfMin > meta.baseIntervalMinutes && snap.m5 && snap.m5.length){
    const barEndMin = Math.floor(snap.m5[snap.m5.length - 1].t / 60_000) + meta.baseIntervalMinutes;
    if(barEndMin % tfMin !== 0) return fail(`Waiting for the next ${tfMin}m candle close`, true);
  }

  const h1 = (snap.h1 || []).slice(-60);
  if(h1.length < 56) return fail('Insufficient 1H history for 4H context');
  const h4 = deriveH4(h1);
  const m15 = (snap.m15 || []).slice(-120);

  const i = E.length - 1;
  const c = E.map(x => x.c);
  const last = E[i], prev = E[i - 1];
  const atrS = atrSeries(E, 14);
  const atrV = atrS[i];
  if(!(atrV > 0)) return fail('ATR unavailable');
  const atrHist = atrS.slice(-100).filter(x => x != null);
  const atrPctile = percentileRank(atrHist, atrV);
  const atrRatio = atrV / (mean(atrS.slice(-50).filter(x => x != null)) || atrV);
  // 75th percentile of recent ATR = "normal-to-active" volatility. Squeezes are measured against THIS,
  // not against a percentile rank inside a window the squeeze itself may occupy half of.
  const atrSorted = atrHist.slice().sort((a, b) => a - b);
  const atrP75 = atrSorted.length ? atrSorted[Math.floor(0.75 * (atrSorted.length - 1))] : atrV;

  const emaF = emaSeries(c, 21), emaS = emaSeries(c, 55);
  const macd = macdHistogram(E);
  const prior20 = E.slice(-21, -1);
  const volMean = mean(prior20.map(x => x.v));
  const volSd = Math.sqrt(mean(prior20.map(x => (x.v - volMean) ** 2)));
  const bbwArr = bollingerBandWidthSeries(E, 20, 2, 100);
  const bbwNow = bbwArr[bbwArr.length - 1];

  const tfE = tfTrend(E, { fast: 21, slow: 55, swing: 2 });
  const tfMid = tfMin === 5 ? tfTrend(m15, { fast: 20, slow: 50, swing: 2 }) : null;
  const tfH1 = tfTrend(h1, { fast: 20, slow: 50, swing: 2 });
  const tfH4 = tfTrend(h4, { fast: 4, slow: 10, swing: 1 });
  if(!tfE || !tfH1 || !tfH4 || (tfMin === 5 && !tfMid)) return fail('Insufficient multi-timeframe history');

  const don = E.slice(-21, -1);
  return {
    ok: true, entryTf: tfMin === 5 ? '5m' : '15m', tfMin, tfMs, nowMs,
    price: snap.price, E, i, last, prev, c,
    atr: atrV, atrPct: (atrV / last.c) * 100, atrS, atrPctile, atrRatio, atrP75,
    emaF, emaS, emaFv: emaF[i], emaSv: emaS[i],
    emaSlopeAtr: (emaS[i] - emaS[i - 5]) / atrV,
    vwapv: vwap(E.slice(-60)),
    rsi: rsi(E, 14), rsiPrev: rsi(E.slice(0, -1), 14),
    macdHist: macd ? macd.hist : null, macdPrev: macd ? macd.prevHist : null,
    vol: { mean: volMean, rel: volMean > 0 ? last.v / volMean : 1, z: volSd > 0 ? (last.v - volMean) / volSd : 0 },
    bbw: { arr: bbwArr, now: bbwNow, pctile: percentileRank(bbwArr, bbwNow) },
    swingHighs: swingHighPoints(E, 0, i - 2, 2, 2),
    swingLows: swingLowPoints(E, 0, i - 2, 2, 2),
    donHigh: Math.max(...don.map(x => x.h)), donLow: Math.min(...don.map(x => x.l)),
    tfE, tfMid, tfH1, tfH4, h1, h4, m15,
    spreadPct: Number.isFinite(meta.spreadPct) ? meta.spreadPct : 0.03,
    liquidityScore: Number.isFinite(meta.liquidityScore) ? meta.liquidityScore : 50,
    fundingRatePct: Number.isFinite(meta.fundingRatePct) ? meta.fundingRatePct : null,
    oiChangePct: Number.isFinite(meta.openInterestChangePct) ? meta.openInterestChangePct : null, // optional, no feed provides it yet
    candle: candleStats(last),
  };
}
