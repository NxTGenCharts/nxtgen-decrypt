// =============================================================
// rangeFilter.js — "Smart Range Filter" used by Nova Scalp to stay out
// of ranging / choppy markets.
//
// What this is, plainly: a multi-factor, fully M5-based trend-quality
// score (0-100). It is NOT a trained model and not an LLM call — it is
// six standard, inspectable measurements blended with fixed weights, so
// every rejection can say exactly which measurements said "range".
// (The optional LLM second opinion in js/ai-signal.js is a separate
// layer; for Nova Scalp it is now also handed these same numbers and
// told to reject range conditions — see server.js's buildAiPrompt.)
//
// Everything here reads ONLY the 5-minute candles the entry logic itself
// uses — no higher-timeframe data — so the filter respects the "entries
// on the 5m timeframe only" rule.
//
// The six measurements (weights sum to 1.0):
//   ADX(14)                          .25  trend strength. <~15 chop, >~28 trend
//   Efficiency Ratio (20 bars)       .20  net move / total path. ~0 = went nowhere
//   EMA50-vs-EMA100 separation       .15  in ATRs. Tangled EMAs = range
//   EMA100 slope (10 bars)           .10  in ATRs. Flat slow EMA = range
//   Parabolic SAR flips (40 bars)    .15  many flips = whipsaw
//   Close crosses of EMA50 (30 bars) .10  many crosses = whipsaw
//   ATR(14) / ATR(50)                .05  volatility contraction = squeeze
//
// Thresholds below are reasoned starting points, not fitted optima. Tune
// them (and re-run the Backtest tab) rather than trusting them blindly.
// =============================================================
import { adx, atr, closes, emaSeries, efficiencyRatio, parabolicSar, sarFlipCount, closeCrossCount, clamp } from './indicators.js';

export const RANGE_FILTER_DEFAULTS = {
  enabled: true,
  minTrendScore: 55,          // score below this = "ranging" -> veto the entry
  adxLo: 15, adxHi: 28,
  erLo: 0.20, erHi: 0.45,
  sepAtrLo: 0.30, sepAtrHi: 1.20,
  slopeAtrLo: 0.30, slopeAtrHi: 1.50,
  flipsLo: 1.5, flipsHi: 5,   // flips in the last 40 bars (a fresh SAR flip is normal, 4+ is chop)
  crossLo: 2, crossHi: 7,     // EMA50 close-crosses in the last 30 bars
  atrRatioLo: 0.70, atrRatioHi: 1.10,
  minBars: 105,
};

const ramp = (x, lo, hi) => clamp((x - lo) / (hi - lo), 0, 1);

// m5: candles oldest-first. pre (optional): already-computed { psar, ema50, ema100 }
// so the caller's own series aren't recomputed. Returns:
//   { trending, score, metrics, reasons }
// `reasons` is human-readable and is what ends up in the scanner's
// REJECTED explanation when this filter vetoes a trade.
export function assessMarketState(m5, opts, pre){
  const cfg = { ...RANGE_FILTER_DEFAULTS, ...(opts || {}) };
  if(!cfg.enabled) return { trending: true, score: 100, metrics: {}, reasons: ['Range filter disabled'] };
  if(!m5 || m5.length < cfg.minBars) return { trending: false, score: 0, metrics: {}, reasons: ['Not enough M5 history to judge trend vs range'] };

  const i = m5.length - 1;
  const c = closes(m5);
  const ema50 = (pre && pre.ema50) || emaSeries(c, 50);
  const ema100 = (pre && pre.ema100) || emaSeries(c, 100);
  const psar = (pre && pre.psar) || parabolicSar(m5);

  const atr14 = atr(m5, 14), atr50 = atr(m5, 50);
  if(!atr14 || !atr50) return { trending: false, score: 0, metrics: {}, reasons: ['ATR unavailable'] };

  const adxVal = adx(m5.slice(-100), 14);
  const er = efficiencyRatio(c, 20);
  const sepAtr = Math.abs(ema50[i] - ema100[i]) / atr14;
  const slopeAtr = Math.abs(ema100[i] - ema100[i - 10]) / atr14;
  const flips = sarFlipCount(psar, m5, 40);
  const crosses = closeCrossCount(m5, ema50, 30);
  const atrRatio = atr14 / atr50;

  const parts = {
    adx: adxVal == null ? 0.5 : ramp(adxVal, cfg.adxLo, cfg.adxHi),
    er: er == null ? 0.5 : ramp(er, cfg.erLo, cfg.erHi),
    sep: ramp(sepAtr, cfg.sepAtrLo, cfg.sepAtrHi),
    slope: ramp(slopeAtr, cfg.slopeAtrLo, cfg.slopeAtrHi),
    flips: 1 - ramp(flips, cfg.flipsLo, cfg.flipsHi),
    crosses: 1 - ramp(crosses, cfg.crossLo, cfg.crossHi),
    atrRatio: ramp(atrRatio, cfg.atrRatioLo, cfg.atrRatioHi),
  };
  const score = Math.round(100 * (
    parts.adx * 0.25 + parts.er * 0.20 + parts.sep * 0.15 + parts.slope * 0.10 +
    parts.flips * 0.15 + parts.crosses * 0.10 + parts.atrRatio * 0.05
  ));

  const metrics = {
    adx: adxVal, efficiencyRatio: er, emaSeparationAtr: sepAtr, ema100SlopeAtr: slopeAtr,
    sarFlips40: flips, ema50Crosses30: crosses, atrRatio, trendScore: score,
  };

  const trending = score >= cfg.minTrendScore;
  const reasons = [];
  if(!trending){
    reasons.push(`Smart Range Filter: ranging/choppy market (trend score ${score} < ${cfg.minTrendScore})`);
    // Name the measurements that actually voted "range" so the rejection is explainable.
    const weak = [];
    if(parts.adx < 0.35 && adxVal != null) weak.push(`ADX ${adxVal.toFixed(0)}`);
    if(parts.er < 0.35 && er != null) weak.push(`efficiency ${er.toFixed(2)}`);
    if(parts.sep < 0.35) weak.push(`EMA50/100 tangled (${sepAtr.toFixed(2)} ATR apart)`);
    if(parts.slope < 0.35) weak.push(`EMA100 flat (${slopeAtr.toFixed(2)} ATR/10 bars)`);
    if(parts.flips < 0.35) weak.push(`${flips} SAR flips in 40 bars`);
    if(parts.crosses < 0.35) weak.push(`${crosses} EMA50 crosses in 30 bars`);
    if(parts.atrRatio < 0.35) weak.push(`volatility squeeze (ATR14/ATR50 ${atrRatio.toFixed(2)})`);
    if(weak.length) reasons.push(`Range evidence: ${weak.join(', ')}`);
  } else {
    reasons.push(`Smart Range Filter: trending (score ${score}, ADX ${adxVal != null ? adxVal.toFixed(0) : 'n/a'}, efficiency ${er != null ? er.toFixed(2) : 'n/a'})`);
  }
  return { trending, score, metrics, reasons };
}
