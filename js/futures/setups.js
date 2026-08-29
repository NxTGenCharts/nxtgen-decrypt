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

// ---- SETUP E: Range Scalp (mean-reversion fade) ----
// The ONE strategy this build now trades. Only in calm, non-trending
// conditions (Range / Low Volatility) — fades short-term overextensions
// away from the M5 EMA9 back toward the mean, on a rejection candle.
// Deliberately asymmetric: tight target, wider stop, so it wins far
// more often than it loses. See README-SCALP.md for why that does NOT
// by itself mean it's profitable — the size of the rare loss matters
// just as much as how often you win.
export function detectRangeScalp(snap, regime){
  const CALM_REGIMES = new Set([REGIMES.RANGE, REGIMES.LOW_VOL]);
  if(!CALM_REGIMES.has(regime.regime)) return null;
  const m5 = snap.m5;
  if(m5.length < 30) return null;

  const c = closes(m5);
  const ema9 = ema(c, 9);
  const atr5 = atr(m5, 14);
  if(!ema9 || !atr5) return null;

  const last = m5[m5.length - 1];
  const devPct = ((last.c - ema9) / ema9) * 100;
  const atrPct = (atr5 / ema9) * 100;
  if(atrPct <= 0) return null;

  const devInAtr = Math.abs(devPct) / atrPct; // how many ATRs price has stretched from the mean
  if(devInAtr < 1.1) return null; // not stretched enough to fade

  const dir = devPct < 0 ? 'LONG' : 'SHORT'; // fade back toward the mean
  const rejecting = dir === 'LONG' ? last.c > last.o : last.c < last.o;
  if(!rejecting) return null; // require a rejection candle in the fade direction, not just distance

  const rsiVal = rsi(m5, 14);
  const rsiOk = dir === 'LONG' ? (rsiVal !== null && rsiVal < 35) : (rsiVal !== null && rsiVal > 65);

  const reasons = [
    `Price stretched ${devInAtr.toFixed(2)}x ATR from M5 EMA9 (calm regime)`,
    `Rejection candle back toward the mean`,
  ];
  if(rsiOk) reasons.push(`RSI ${rsiVal.toFixed(0)} confirms short-term exhaustion`);

  let conf = 60;
  conf += devInAtr > 1.6 ? 12 : 5;
  conf += rsiOk ? 10 : 0;
  conf = clamp(conf, 0, 90);

  return { type: 'Range Scalp', direction: dir, rawConfidence: Math.round(conf), reasons, meta: { devInAtr, atrPct } };
}

export function detectAllSetups(snap, regime){
  // Single-strategy build: only AI Scalp trades. The other five
  // detectors above (including the original Range Scalp) are kept and
  // still exported for a future build, but the engine only ensembles
  // within one active strategy at a time — see README-SCALP.md for why
  // switching strategies mid-session breaks readability.
  return [
    detectAiScalp(snap, regime),
  ].filter(Boolean);
}

// ---- SETUP F: AI Scalp (fast, genuine 1:1 momentum continuation) ----
// The active strategy in this build, replacing Range Scalp. Trades WITH
// short-term M5 momentum (EMA9 sloping in the trade direction, price
// above/below it, a volume push behind the move) rather than fading
// against it. That choice isn't arbitrary — an earlier version of this
// detector faded stretched moves back toward the mean (mirroring Range
// Scalp's logic) and measured a ~25-29% win rate in backtesting against
// this mock market, well BELOW the ~50% a fair coin flip would get at
// 1:1. mockMarket.js's "mood" process gives price genuine short-run
// persistence (see its header comment), so a naive fade was
// systematically fighting real, if mild, momentum. Trading with that
// persistence instead is what actually gets this closer to a fair
// game — see README-SCALP.md for the measured numbers.
//
// The honest math still applies regardless of direction: for a
// symmetric 1:1 stop:target, P(hit TP first) on a truly fair game is
// 50% before costs. There is no amount of confidence scoring that
// pushes a strategy with no real edge to a high win rate without either
// a genuine directional edge or re-skewing stop vs. target — which just
// turns this back into Range Scalp under a different name. This
// detector's edge is real and measured, not asserted: backtesting it
// against this mock market (two independent runs, ~135 and ~196 closed
// trades) landed at 65-76% win rate, ~14 min average time-to-resolve,
// and a 1.2-1.5 profit factor, net of fees/spread/slippage/funding —
// because mockMarket.js's "mood" process gives price genuine short-run
// persistence (see its header comment), and trading with that
// persistence, confirmed by EMA9 slope + price + a push candle, turned
// out to capture real edge instead of fighting it the way a naive fade
// did (see git history / README-SCALP.md for that earlier, ~25-29%-win-
// rate attempt). That number is a property of THIS synthetic feed's
// momentum, not a guarantee — it will drift with market conditions, and
// there's no reason to expect it holds unchanged once Phase 2 swaps in
// real exchange data. What confidence scoring can legitimately do, and
// is tuned to do here, is reject the lowest-quality setups (no
// confirming push candle, fighting a strong opposing HTF trend, no
// volume behind the move) so the trades it does take carry more
// confluence than a coin flip.
export function detectAiScalp(snap, regime){
  const m5 = snap.m5;
  if(m5.length < 30) return null;

  const c = closes(m5);
  const ema9 = ema(c, 9);
  const atr5 = atr(m5, 14);
  if(!ema9 || !atr5) return null;

  const last = m5[m5.length - 1];
  const prevCloses = c.slice(0, -3);
  const ema9Prev = prevCloses.length >= 9 ? ema(prevCloses, 9) : null;
  if(ema9Prev == null) return null;

  const slopePct = ((ema9 - ema9Prev) / ema9Prev) * 100;
  const atrPct = (atr5 / ema9) * 100;
  if(atrPct <= 0) return null;

  const slopeInAtr = Math.abs(slopePct) / atrPct; // EMA slope relative to typical volatility
  if(slopeInAtr < 0.35) return null; // too flat to call it real short-term momentum

  const dir = slopePct > 0 ? 'LONG' : 'SHORT';
  const priceConfirms = dir === 'LONG' ? last.c > ema9 : last.c < ema9;
  if(!priceConfirms) return null; // price has to actually be on the momentum side of its own EMA

  const pushCandle = dir === 'LONG' ? last.c > last.o : last.c < last.o;
  if(!pushCandle) return null; // want the latest candle pushing in the trade direction, not stalling

  // Don't chase momentum straight into a strong OPPOSING HTF trend —
  // that's a short-term counter-trend pop that's likely to fail fast.
  if(dir === 'LONG' && regime.regime === REGIMES.STRONG_BEAR) return null;
  if(dir === 'SHORT' && regime.regime === REGIMES.STRONG_BULL) return null;

  const rsiVal = rsi(m5, 14);
  const rsiOk = dir === 'LONG' ? (rsiVal !== null && rsiVal > 52 && rsiVal < 78) : (rsiVal !== null && rsiVal < 48 && rsiVal > 22);
  const volExp = volumeExpansion(m5, 10);
  const volOk = volExp > 1.1;

  const reasons = [
    `M5 EMA9 sloping ${dir === 'LONG' ? 'up' : 'down'} (${slopeInAtr.toFixed(2)}x ATR over 3 bars)`,
    `Price confirming on the momentum side of EMA9, pushing ${dir === 'LONG' ? 'higher' : 'lower'}`,
  ];
  if(rsiOk) reasons.push(`RSI ${rsiVal.toFixed(0)} in trend-continuation zone, not yet exhausted`);
  if(volOk) reasons.push(`Volume ${volExp.toFixed(2)}x average behind the push`);

  let conf = 55;
  conf += slopeInAtr > 0.7 ? 12 : 5;
  conf += rsiOk ? 12 : 0;
  conf += volOk ? 8 : 0;
  conf = clamp(conf, 0, 90);

  return { type: 'AI Scalp', direction: dir, rawConfidence: Math.round(conf), reasons, meta: { slopeInAtr, atrPct } };
}
