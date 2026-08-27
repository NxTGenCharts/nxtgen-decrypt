// =============================================================
// setups.js — the four independent setup detectors. Each takes the
// M5/M15/H1 candles + the current regime and returns either null
// (no setup found) or a signal: { type, direction, rawConfidence,
// reasons[] }. The ensemble in engine.js combines whichever of
// these fire on a given symbol/cycle.
// =============================================================
import { ema, atr, rsi, macdHistogram, vwap, swingLevels, volumeExpansion, closes, clamp } from './indicators.js';
import { REGIMES } from './regime.js';

const TREND_REGIMES = new Set([REGIMES.STRONG_BULL, REGIMES.WEAK_BULL, REGIMES.STRONG_BEAR, REGIMES.WEAK_BEAR]);
const BULL_REGIMES = new Set([REGIMES.STRONG_BULL, REGIMES.WEAK_BULL]);
const BEAR_REGIMES = new Set([REGIMES.STRONG_BEAR, REGIMES.WEAK_BEAR]);

// ---- SETUP A: Trend Continuation ----
// Strong HTF trend + pullback toward EMA/VWAP on shrinking volume,
// then momentum resumes in the trend direction.
export function detectTrendContinuation(snap, regime){
  if(!TREND_REGIMES.has(regime.regime)) return null;
  const dir = BULL_REGIMES.has(regime.regime) ? 'LONG' : 'SHORT';
  const m5 = snap.m5, m15 = snap.m15;
  if(m5.length < 30 || m15.length < 30) return null;

  const ema20_5 = ema(closes(m5), 20);
  const vwap5 = vwap(m5.slice(-60));
  const last = m5[m5.length - 1];
  const pullbackZone = (ema20_5 + vwap5) / 2;
  const distToZonePct = Math.abs((last.c - pullbackZone) / pullbackZone) * 100;

  const volExp = volumeExpansion(m5, 10);
  const priorVolExp = volumeExpansion(m5.slice(0, -1), 10);
  const macd = macdHistogram(closes(m5).map((c,i)=>({c})).map((x,i)=>m5[i]));
  const momentumResuming = dir === 'LONG' ? (macd && macd.hist > macd.prevHist) : (macd && macd.hist < macd.prevHist);

  const reasons = [];
  if(distToZonePct > 0.9) return null; // not actually near the pullback zone
  reasons.push(`Pullback within ${distToZonePct.toFixed(2)}% of EMA20/VWAP zone`);

  if(priorVolExp > 1.0 && volExp < priorVolExp) reasons.push('Volume contracted during pullback');
  else reasons.push('Pullback volume did not clearly contract');

  if(!momentumResuming) return null;
  reasons.push(`${dir === 'LONG' ? 'Bullish' : 'Bearish'} momentum resuming (MACD histogram turning)`);

  let conf = 60;
  conf += regime.regime.startsWith('Strong') ? 12 : 4;
  conf += distToZonePct < 0.4 ? 10 : 4;
  conf += (priorVolExp > 1.0 && volExp < priorVolExp) ? 8 : 0;
  conf = clamp(conf, 0, 95);

  return { type: 'Trend Continuation', direction: dir, rawConfidence: Math.round(conf), reasons };
}

// ---- SETUP B: Breakout + Retest ----
// Consolidation -> breakout -> wait -> retest with volume/structure/momentum confirmation.
export function detectBreakoutRetest(snap, regime){
  const m15 = snap.m15;
  if(m15.length < 40) return null;
  const lookback = m15.slice(-40, -6);
  const recent = m15.slice(-6);
  const hi = Math.max(...lookback.map(c => c.h));
  const lo = Math.min(...lookback.map(c => c.l));
  const rangePct = ((hi - lo) / lo) * 100;
  if(rangePct > 3.2) return null; // not a tight enough consolidation to call a breakout meaningful

  const breakoutCandle = recent.find(c => c.c > hi || c.c < lo);
  if(!breakoutCandle) return null;
  const dir = breakoutCandle.c > hi ? 'LONG' : 'SHORT';
  const level = dir === 'LONG' ? hi : lo;

  const last = m15[m15.length - 1];
  const retestDistPct = Math.abs((last.c - level) / level) * 100;
  if(retestDistPct > 0.6) return null; // hasn't come back to retest the level yet

  const volExp = volumeExpansion(m15, 10);
  const reasons = [`Consolidation range ${rangePct.toFixed(2)}% before breakout`, `Retesting breakout level within ${retestDistPct.toFixed(2)}%`];
  if(volExp < 0.7) return null; // retest on dead volume = weak confirmation
  reasons.push(`Retest volume ${volExp.toFixed(2)}x average`);

  let conf = 58;
  conf += rangePct < 1.8 ? 10 : 3;
  conf += retestDistPct < 0.25 ? 10 : 4;
  conf += volExp > 1.3 ? 10 : 3;
  conf += (dir === 'LONG' && BULL_REGIMES.has(regime.regime)) || (dir === 'SHORT' && BEAR_REGIMES.has(regime.regime)) ? 6 : -8;
  conf = clamp(conf, 0, 95);

  return { type: 'Breakout + Retest', direction: dir, rawConfidence: Math.round(conf), reasons };
}

// ---- SETUP C: Range Reversal ----
// Only in confirmed Range regime — fade validated support/resistance, never the middle.
export function detectRangeReversal(snap, regime){
  if(regime.regime !== REGIMES.RANGE) return null;
  const m15 = snap.m15;
  if(m15.length < 40) return null;
  const { support, resistance } = swingLevels(m15, 40);
  const mid = (support + resistance) / 2;
  const last = m15[m15.length - 1];
  const rangeWidthPct = ((resistance - support) / support) * 100;
  if(rangeWidthPct < 0.4) return null; // too tight to trade the edges profitably after costs

  const distToSupportPct = Math.abs((last.c - support) / support) * 100;
  const distToResistancePct = Math.abs((last.c - resistance) / resistance) * 100;
  const nearSupport = distToSupportPct < rangeWidthPct * 0.18;
  const nearResistance = distToResistancePct < rangeWidthPct * 0.18;
  if(!nearSupport && !nearResistance) return null; // in the middle — never trade this

  const dir = nearSupport ? 'LONG' : 'SHORT';
  const rsiVal = rsi(m15, 14);
  const rejecting = dir === 'LONG' ? last.c > last.o : last.c < last.o;
  if(!rejecting) return null;

  const volExp = volumeExpansion(m15, 10);
  const reasons = [`Price at range ${dir === 'LONG' ? 'support' : 'resistance'} (range width ${rangeWidthPct.toFixed(2)}%)`, `Rejection candle confirmed`];
  const rsiOk = dir === 'LONG' ? (rsiVal !== null && rsiVal < 45) : (rsiVal !== null && rsiVal > 55);
  if(rsiOk) reasons.push(`RSI ${rsiVal.toFixed(0)} supports mean-reversion`);
  if(volExp > 1.1) reasons.push(`Volume confirming rejection (${volExp.toFixed(2)}x)`);

  let conf = 55;
  conf += rsiOk ? 12 : 0;
  conf += volExp > 1.1 ? 10 : 0;
  conf += (nearSupport ? distToSupportPct : distToResistancePct) < rangeWidthPct * 0.08 ? 10 : 3;
  conf = clamp(conf, 0, 92);

  return { type: 'Range Reversal', direction: dir, rawConfidence: Math.round(conf), reasons, meta: { support, resistance, mid } };
}

// ---- SETUP D: Liquidity Sweep Reversal ----
// Price breaks a recent swing low/high, immediately rejects on rising
// volume, and structure shifts back — classic stop-hunt reversal.
export function detectLiquiditySweep(snap, regime){
  const m5 = snap.m5;
  if(m5.length < 30) return null;
  const { support, resistance } = swingLevels(m5.slice(0, -3), 30);
  const recent = m5.slice(-3);
  const sweepLow = recent.find(c => c.l < support && c.c > support);
  const sweepHigh = recent.find(c => c.h > resistance && c.c < resistance);
  if(!sweepLow && !sweepHigh) return null;

  const dir = sweepLow ? 'LONG' : 'SHORT';
  const sweepCandle = sweepLow || sweepHigh;
  const volExp = volumeExpansion(m5, 10);
  if(volExp < 1.15) return null; // no volume confirmation on the sweep = low-quality signal

  const reasons = [
    dir === 'LONG'
      ? `Swept below prior low (${support.toFixed(4)}) then reclaimed it`
      : `Swept above prior high (${resistance.toFixed(4)}) then rejected it`,
    `Sweep volume ${volExp.toFixed(2)}x average`,
  ];

  const closeBackInsidePct = Math.abs((sweepCandle.c - (dir === 'LONG' ? support : resistance)) / (dir === 'LONG' ? support : resistance)) * 100;
  reasons.push(`Closed back inside range by ${closeBackInsidePct.toFixed(2)}%`);

  let conf = 58;
  conf += volExp > 1.6 ? 12 : 5;
  conf += closeBackInsidePct > 0.15 ? 10 : 3;
  conf += (dir === 'LONG' && !BEAR_REGIMES.has(regime.regime)) || (dir === 'SHORT' && !BULL_REGIMES.has(regime.regime)) ? 6 : -6;
  conf = clamp(conf, 0, 93);

  return { type: 'Liquidity Sweep Reversal', direction: dir, rawConfidence: Math.round(conf), reasons, meta: { support, resistance } };
}

export function detectAllSetups(snap, regime){
  return [
    detectTrendContinuation(snap, regime),
    detectBreakoutRetest(snap, regime),
    detectRangeReversal(snap, regime),
    detectLiquiditySweep(snap, regime),
  ].filter(Boolean);
}
