// =============================================================
// rangeFilter.js — the "Smart Range Filter" used by Nova Scalp.
//
// PURPOSE: Nova Scalp is a trend-following trigger (Parabolic SAR
// breaking through the EMA50/EMA100 band, MACD + Awesome Oscillator
// agreeing). In a sideways market those exact signals still fire — SAR
// dots wander across flat, tangled EMAs all day — and each one is a
// coin-flip with a fee attached. This module scores how much a real,
// directional, tradeable trend is actually present on the 5m chart and
// vetoes the entry when it isn't.
//
// WHAT IT IS (and isn't): a transparent, rule-based adaptive scorer —
// seven independent trend/chop measurements, each normalised against the
// symbol's OWN volatility (ATR) so it self-adjusts per coin instead of
// using one fixed % threshold, combined into a 0-100 "trend quality"
// score with every component reported back so a rejection always says
// which measurement failed. It is NOT a trained machine-learning model
// and has no learned weights; nothing here has been fitted to data. The
// thresholds are reasoned starting points — check them in the Backtest
// tab on your own symbols before trusting them. (If you want a genuine
// LLM second opinion on top, that exists separately: the "AI second
// opinion" layer in the API Keys tab, which reviews an already-approved
// signal using your own provider key.)
//
// Pure function of 5m candles (+ the existing higher-timeframe regime
// label as a hard veto only) — no side effects, no network.
// =============================================================
import { emaSeries, closes, atr, adx, parabolicSar, efficiencyRatio, clamp } from './indicators.js';
import { REGIMES } from './regime.js';

// Score a value linearly: <= lo -> 0, >= hi -> 1.
const ramp = (v, lo, hi) => clamp((v - lo) / (hi - lo), 0, 1);

// Component weights sum to 100.
const WEIGHTS = { adx: 15, adxRise: 10, efficiency: 20, displacement: 20, emaSlope: 10, sarWhipsaw: 15, chop: 10 };

export const RANGE_FILTER_DEFAULTS = {
  minScore: 65,          // trend-quality score needed to allow an entry
  hardMinAdx: 14,        // below this the market is a range regardless of the other readings
  vetoRegimes: [REGIMES.RANGE, REGIMES.LOW_VOL, REGIMES.CHAOTIC], // higher-timeframe states that veto outright
};

// direction: 'LONG' | 'SHORT' (the EMA slope check is direction-aware)
export function smartRangeFilter(m5, direction, regime, opts){
  const o = { ...RANGE_FILTER_DEFAULTS, ...(opts || {}) };
  const notes = [];
  const fail = (why) => ({ trending: false, score: 0, components: {}, reasons: [why], notes });

  if(m5.length < 110) return fail('Not enough 5m history to judge trend vs range');

  const i = m5.length - 1;
  const cl = closes(m5);
  const atr5 = atr(m5, 14);
  if(!atr5) return fail('ATR unavailable');

  // ---- hard vetoes (any one is enough) ----
  if(regime && o.vetoRegimes.includes(regime.regime)){
    return fail(`Higher-timeframe regime is "${regime.regime}" — not a trending market`);
  }
  const adxNow = adx(m5, 14);
  if(adxNow == null) return fail('ADX unavailable');
  if(adxNow < o.hardMinAdx) return fail(`ADX ${adxNow.toFixed(1)} is below ${o.hardMinAdx} — no directional strength (ranging)`);

  // ---- 1+2. ADX: how strong the directional movement is, AND whether it is
  //      building. A breakout out of compression starts with a LOW but sharply
  //      RISING ADX, so a rising ADX earns real credit — the filter is meant to
  //      block chop, not the first bars of a genuine breakout. ----
  const adxPrev = adx(m5.slice(0, -4), 14);
  const adxDelta = adxPrev != null ? adxNow - adxPrev : 0;
  const adxScore = ramp(adxNow, 18, 30);
  const adxRiseScore = ramp(adxDelta, 0, 4);

  // ---- 3. Efficiency ratio: does price actually travel, or just churn? ----
  const er = efficiencyRatio(cl, 20) ?? 0;
  const erScore = ramp(er, 0.20, 0.50);

  // ---- 4. Net displacement over the last 20 bars, in ATRs, in the trade's
  //      direction: a live move has gone somewhere; a range has round-tripped ----
  const disp = (cl[i] - cl[i - 20]) / atr5;
  const dirDisp = direction === 'LONG' ? disp : -disp;
  const dispScore = ramp(dirDisp, 2, 6);

  // ---- 5. EMA50 slope in the trade's direction (ATRs per 10 bars) ----
  const ema50 = emaSeries(cl, 50);
  const slopeAtr = (ema50[i] - ema50[i - 10]) / atr5;
  const dirSlope = direction === 'LONG' ? slopeAtr : -slopeAtr;
  const slopeScore = ramp(dirSlope, 0, 0.6);

  // ---- 6. Parabolic SAR whipsaw: flipping side constantly = chop ----
  const psar = parabolicSar(m5);
  let flips = 0;
  for(let k = i - 39; k <= i; k++){
    if(k < 1 || psar[k] == null || psar[k - 1] == null) continue;
    const upNow = psar[k] < m5[k].c, upPrev = psar[k - 1] < m5[k - 1].c;
    if(upNow !== upPrev) flips++;
  }
  const whipsawScore = 1 - ramp(flips, 2, 6);

  // ---- 7. Chop: how often price crossed EMA50 recently ----
  let crosses = 0;
  for(let k = i - 29; k <= i; k++){
    if(k < 1) continue;
    if((cl[k] > ema50[k]) !== (cl[k - 1] > ema50[k - 1])) crosses++;
  }
  const chopScore = 1 - ramp(crosses, 1, 6);

  const components = {
    adx:          { value: +adxNow.toFixed(1), points: +(adxScore * WEIGHTS.adx).toFixed(1), of: WEIGHTS.adx },
    adxRise:      { value: +adxDelta.toFixed(1), points: +(adxRiseScore * WEIGHTS.adxRise).toFixed(1), of: WEIGHTS.adxRise },
    efficiency:   { value: +er.toFixed(2), points: +(erScore * WEIGHTS.efficiency).toFixed(1), of: WEIGHTS.efficiency },
    displacement: { value: +dirDisp.toFixed(1), points: +(dispScore * WEIGHTS.displacement).toFixed(1), of: WEIGHTS.displacement },
    emaSlope:     { value: +dirSlope.toFixed(2), points: +(slopeScore * WEIGHTS.emaSlope).toFixed(1), of: WEIGHTS.emaSlope },
    sarWhipsaw:   { value: flips, points: +(whipsawScore * WEIGHTS.sarWhipsaw).toFixed(1), of: WEIGHTS.sarWhipsaw },
    chop:         { value: crosses, points: +(chopScore * WEIGHTS.chop).toFixed(1), of: WEIGHTS.chop },
  };
  const score = Math.round(Object.values(components).reduce((a, c) => a + c.points, 0));
  const trending = score >= o.minScore;

  const reasons = [];
  if(!trending){
    reasons.push(`Smart range filter: trend quality ${score}/100 is below the ${o.minScore} needed — market looks range-bound`);
    const weakest = Object.entries(components).sort((a, b) => (a[1].points / a[1].of) - (b[1].points / b[1].of)).slice(0, 2).map(([k]) => k);
    reasons.push(`Weakest readings: ${weakest.join(', ')}`);
  }
  notes.push(`ADX ${adxNow.toFixed(1)} (${adxDelta >= 0 ? '+' : ''}${adxDelta.toFixed(1)}), efficiency ${er.toFixed(2)}, ${dirDisp.toFixed(1)} ATR net move/20 bars, ${flips} SAR flips/40 bars, ${crosses} EMA50 crosses/30 bars`);
  return { trending, score, components, reasons, notes };
}
