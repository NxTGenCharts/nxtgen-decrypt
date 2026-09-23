// =============================================================
// quant/features.js — the feature engine for NxTGen HTF OrderFlow. Turns a
// market snapshot ({price, m5, m15, h1, meta}) into one deterministic
// feature object the setup detector and scorer both read from. Pure
// functions: no DOM, no network, no clock (time comes in via ctx.nowMs), so
// Paper, Backtest and Live/Demo feed the detector identical inputs.
//
// Timeframe plan (fixed — see quant/config.js, entryTimeframe is always 5m):
//   entry 5m -> HTF context: 30m, 1H, 4H
// The snapshot carries no 30m/4H series, so both are DERIVED by rolling
// groups (deriveM30 from 15m x2, deriveH4 from 1H x4) — the same
// "aggregate from the end backwards" technique backtest.js and mockMarket
// use, so Live, Paper and Backtest see identically-shaped bars. All HTF
// structure is built ONLY from candles that have already closed at the
// evaluation instant — see buildFeatures' closedFlag/staleness handling —
// so nothing here ever looks into an unfinished HTF bar (no repainting).
// =============================================================
import { emaSeries, atr, adx, rsi, macdHistogram, vwap, swingHighPoints, swingLowPoints, efficiencyRatio, bollingerBandWidthSeries, parabolicSar, awesomeOscillator, closes } from '../indicators.js';

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

// Rolling groups of `groupSize` candles taken from the END backwards, so the
// last group always ends on the newest candle. Used to derive 30M from 15M
// (groupSize 2) and 4H from 1H (groupSize 4) without a dedicated feed.
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
export function deriveM30(m15){ return aggregateGroups(m15, 2, 60); }
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

// =============================================================
// HTF supply/demand + institutional order-block detection.
//
// Heuristic, deterministic, look-back-only (never uses a bar that hasn't
// closed at `toIdx`): scans for a DISPLACEMENT leg (a candle or short run
// whose body is large relative to ATR, closing strongly in its direction),
// then anchors the zone on the LAST OPPOSING candle immediately before that
// displacement — the classic "order block" definition — and grades the
// zone by how many of the spec's own quality markers are present:
//   * displacement magnitude (>= minDisplacementAtr x ATR)
//   * an imbalance / fair-value-gap accompanying the move (candle[i-1].h
//     vs candle[i+1].l for a bullish leg, mirrored for bearish)
//   * a break of a recent swing structure (price closing beyond a prior
//     swing high/low) shortly after the leg — i.e. the level actually
//     mattered, not an arbitrary horizontal line
//   * whether the zone has since been "mitigated" (price already closed
//     all the way through it) — mitigated zones are dropped
// Returns freshest-first, capped to `maxZones`.
// =============================================================
export function findZones(candles, opts){
  const o = Object.assign({ atrPeriod: 14, lookback: 60, minDisplacementAtr: 1.1, maxZones: 8 }, opts || {});
  const n = candles.length;
  if(n < o.atrPeriod + 10) return [];
  const atrS = atrSeries(candles, o.atrPeriod);
  const highsAll = swingHighPoints(candles, 0, n - 1, 2, 2);
  const lowsAll = swingLowPoints(candles, 0, n - 1, 2, 2);
  const from = Math.max(o.atrPeriod + 2, n - o.lookback);
  const zones = [];
  for(let i = from; i < n - 1; i++){ // leave >=1 bar after i so a BOS/imbalance check can look forward without reading an unclosed bar
    const a = atrS[i];
    if(!(a > 0)) continue;
    const cnd = candles[i];
    const body = Math.abs(cnd.c - cnd.o);
    if(body < o.minDisplacementAtr * a) continue;
    const bull = cnd.c > cnd.o;
    // Anchor: walk back to the most recent candle of the OPPOSITE color immediately preceding the leg
    // (skip same-colored bars — the leg may span more than one candle).
    let anchorIdx = i - 1;
    while(anchorIdx > from - 5 && anchorIdx >= 0 && (bull ? candles[anchorIdx].c > candles[anchorIdx].o : candles[anchorIdx].c < candles[anchorIdx].o)) anchorIdx--;
    if(anchorIdx < 0) continue;
    const anchor = candles[anchorIdx];
    const top = Math.max(anchor.o, anchor.h, anchor.c);
    const bottom = Math.min(anchor.o, anchor.l, anchor.c);
    if(!(top > bottom)) continue;

    const hasImbalance = i - 1 >= 0 && i + 1 < n && (bull ? candles[i + 1].l > candles[i - 1].h : candles[i + 1].h < candles[i - 1].l);
    // Break of structure: within 6 bars after the leg, price closes beyond the nearest prior swing point.
    const priorSwing = bull
      ? highsAll.filter(p => p.index < anchorIdx).slice(-1)[0]
      : lowsAll.filter(p => p.index < anchorIdx).slice(-1)[0];
    let hasBOS = false;
    if(priorSwing){
      for(let k = i; k < Math.min(n, i + 6); k++){
        if(bull ? candles[k].c > priorSwing.price : candles[k].c < priorSwing.price){ hasBOS = true; break; }
      }
    }
    // Mitigation: has price, at any point AFTER the leg, closed all the way through the far edge of the zone?
    let mitigated = false;
    for(let k = i + 1; k < n; k++){
      if(bull ? candles[k].c < bottom : candles[k].c > top){ mitigated = true; break; }
    }
    if(mitigated) continue;

    const quality = mean([body >= 1.6 * o.minDisplacementAtr * a ? 1 : 0.55, hasImbalance ? 1 : 0.3, hasBOS ? 1 : 0.35]);
    zones.push({
      type: bull ? 'demand' : 'supply', top, bottom, index: anchorIdx, legIndex: i,
      strength: clamp(quality, 0, 1), hasImbalance, hasBOS, displacementAtr: body / a,
    });
  }
  return zones.sort((a, b) => b.legIndex - a.legIndex).slice(0, o.maxZones);
}

// Nearest not-yet-passed-through zone of the requested type ahead of / at `price`, for direction s (1 long, -1 short).
// For a LONG we want DEMAND at/below price (or price currently inside it); mirrored for SHORT/SUPPLY.
export function nearestZone(zones, type, price, s){
  const cand = zones.filter(z => z.type === type);
  const relevant = cand.filter(z => s === 1 ? price >= z.bottom - 1e-9 : price <= z.top + 1e-9);
  if(!relevant.length) return null;
  return relevant.reduce((best, z) => {
    const distB = s === 1 ? Math.abs(price - best.top) : Math.abs(price - best.bottom);
    const distZ = s === 1 ? Math.abs(price - z.top) : Math.abs(price - z.bottom);
    return distZ < distB ? z : best;
  });
}

// Do two zones "overlap" within an ATR-based proximity tolerance (used for HTF order-block confluence —
// spec: "Do NOT require the exact zone boundaries to be identical. Use an adjustable zone-overlap/proximity
// tolerance based on ATR.")
export function zonesOverlap(a, b, toleranceAbs){
  return a.top + toleranceAbs >= b.bottom && b.top + toleranceAbs >= a.bottom;
}

function fail(reason, quiet){ return { ok: false, reason, quiet: !!quiet }; }

// Main entry. qcfg: sanitized HTF OrderFlow config. ctx: { nowMs }.
export function buildFeatures(snap, qcfg, ctx){
  const tfMin = 5; // spec: 5M is the ONLY entry timeframe
  const tfMs = tfMin * 60_000;
  const nowMs = ctx && ctx.nowMs != null ? ctx.nowMs : null;
  const raw = snap.m5;
  if(!raw || raw.length < 130) return fail(`Insufficient ${tfMin}m history`); // EMA100 + PSAR warmup

  const meta = snap.meta || {};

  // Simulated feeds (Backtest, Paper's synthetic market) flag their candles
  // as already closed. Real exchange feeds include the still-forming
  // candle, whose partial volume/range must not be read as a signal.
  const closedFlag = !!meta.candlesClosed;
  let E = raw.slice(-151);
  if(!closedFlag && nowMs != null && Number.isFinite(E[E.length - 1].t) && E[E.length - 1].t + tfMs > nowMs + 1000) E = E.slice(0, -1);
  E = E.slice(-150);
  if(E.length < 130) return fail(`Insufficient ${tfMin}m history`);

  if(!closedFlag && nowMs != null){
    const ageMs = nowMs - (E[E.length - 1].t + tfMs);
    if(ageMs > 2 * tfMs + 60_000) return fail(`Market data is stale (last closed ${tfMin}m candle ended ${Math.round(ageMs / 60000)}m ago)`);
  }

  const h1 = (snap.h1 || []).slice(-60);
  if(h1.length < 56) return fail('Insufficient 1H history for 30M/4H context');
  const m15 = (snap.m15 || []).slice(-120);
  if(m15.length < 100) return fail('Insufficient 15m history for 30M context');
  const h4 = deriveH4(h1);
  const m30 = deriveM30(m15);
  if(m30.length < 20 || h4.length < 8) return fail('Insufficient HTF history (30M/4H)');

  const i = E.length - 1;
  const c = E.map(x => x.c);
  const last = E[i], prev = E[i - 1];
  const atrS = atrSeries(E, 14);
  const atrV = atrS[i];
  if(!(atrV > 0)) return fail('ATR unavailable');
  const atrHist = atrS.slice(-100).filter(x => x != null);
  const atrPctile = percentileRank(atrHist, atrV);
  const atrRatio = atrV / (mean(atrS.slice(-50).filter(x => x != null)) || atrV);
  const atrSorted = atrHist.slice().sort((a, b) => a - b);
  const atrP75 = atrSorted.length ? atrSorted[Math.floor(0.75 * (atrSorted.length - 1))] : atrV;

  const macd = macdHistogram(E);
  const prior20 = E.slice(-21, -1);
  const volMean = mean(prior20.map(x => x.v));
  const volSd = Math.sqrt(mean(prior20.map(x => (x.v - volMean) ** 2)));
  const bbwArr = bollingerBandWidthSeries(E, 20, 2, 100);
  const bbwNow = bbwArr[bbwArr.length - 1];

  // 5M entry-timeframe indicators: EMA(fast/slow) [default 50/100], PSAR, Awesome Oscillator — all on CLOSED
  // candles only. `i` is the last closed 5M bar.
  const emaFast = qcfg.emaFast, emaSlow = qcfg.emaSlow;
  const ema50 = emaSeries(c, emaFast), ema100 = emaSeries(c, emaSlow);
  const psar = parabolicSar(E, qcfg.psarStep, qcfg.psarMaxStep);
  const ao = awesomeOscillator(E);
  // ATR-normalized AO reading (spec: "optional normalized AO mode using ATR ... so the strategy can behave
  // consistently across BTC, ETH and other futures contracts") — AO in price units / ATR, scaled so a
  // "typical" reading sits near the same +-3 the raw mode uses on a mid-cap alt.
  const aoNorm = ao.values.map(v => (v == null ? null : (v / atrV) * 3));

  const tfE = tfTrend(E, { fast: 21, slow: 55, swing: 2 });
  const tfM30 = tfTrend(m30, { fast: 10, slow: 20, swing: 2 });
  const tfH1 = tfTrend(h1, { fast: 20, slow: 50, swing: 2 });
  const tfH4 = tfTrend(h4, { fast: 4, slow: 8, swing: 1 });
  if(!tfE || !tfM30 || !tfH1 || !tfH4) return fail('Insufficient multi-timeframe history');

  // HTF supply/demand + order-block zones, one scan per timeframe. All built only from CLOSED bars of that
  // timeframe up to its own last index — never re-derived with information from a bar that hasn't closed yet.
  const zones30 = findZones(m30, { lookback: 40, minDisplacementAtr: 1.0, maxZones: 8 });
  const zonesH1 = findZones(h1, { lookback: 40, minDisplacementAtr: 1.0, maxZones: 6 });
  const zonesH4 = findZones(h4, { lookback: h4.length, minDisplacementAtr: 0.9, maxZones: 4 });

  const don = E.slice(-21, -1);
  return {
    ok: true, entryTf: '5m', tfMin, tfMs, nowMs,
    price: snap.price, E, i, last, prev, c,
    atr: atrV, atrPct: (atrV / last.c) * 100, atrS, atrPctile, atrRatio, atrP75,
    ema50, ema100, ema50v: ema50[i], ema100v: ema100[i],
    psar, psarV: psar[i], ao: ao.values[i], aoColors: ao.colors, aoV: ao.values, aoNorm,
    vwapv: vwap(E.slice(-60)),
    rsi: rsi(E, 14), rsiPrev: rsi(E.slice(0, -1), 14),
    macdHist: macd ? macd.hist : null, macdPrev: macd ? macd.prevHist : null,
    vol: { mean: volMean, rel: volMean > 0 ? last.v / volMean : 1, z: volSd > 0 ? (last.v - volMean) / volSd : 0 },
    bbw: { arr: bbwArr, now: bbwNow, pctile: percentileRank(bbwArr, bbwNow) },
    swingHighs: swingHighPoints(E, 0, i - 2, 2, 2),
    swingLows: swingLowPoints(E, 0, i - 2, 2, 2),
    donHigh: Math.max(...don.map(x => x.h)), donLow: Math.min(...don.map(x => x.l)),
    tfE, tfM30, tfH1, tfH4, h1, h4, m15, m30,
    zones30, zonesH1, zonesH4,
    spreadPct: Number.isFinite(meta.spreadPct) ? meta.spreadPct : 0.03,
    liquidityScore: Number.isFinite(meta.liquidityScore) ? meta.liquidityScore : 50,
    fundingRatePct: Number.isFinite(meta.fundingRatePct) ? meta.fundingRatePct : null,
    oiChangePct: Number.isFinite(meta.openInterestChangePct) ? meta.openInterestChangePct : null,
    candle: candleStats(last),
  };
}
