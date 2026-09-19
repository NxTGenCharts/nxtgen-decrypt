// =============================================================
// setups.js — the four independent setup detectors. Each takes the
// M5/M15/H1 candles + the current regime and returns either null
// (no setup found) or a signal: { type, direction, rawConfidence,
// reasons[] }. The ensemble in engine.js combines whichever of
// these fire on a given symbol/cycle.
// =============================================================
import { ema, emaSeries, atr, rsi, macdHistogram, vwap, swingLevels, volumeExpansion, relativeVolumePercentile, closes, clamp, parabolicSar, awesomeOscillator, macdLineSeries, streakBack, swingLowPoints, swingHighPoints } from './indicators.js';
import { assessMarketState, RANGE_FILTER_DEFAULTS } from './rangeFilter.js';
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
  // (Was a confusing no-op chain — closes(m5).map(wrap).map(unwrap) reduces
  // to just m5 itself. Left functionally identical, written plainly.)
  const macd = macdHistogram(m5);
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
//
// Entry timeframe fix: this used to read the entire pattern (consolidation
// range, breakout candle, retest) off snap.m15, while every other setup in
// this file trades snap.m5 — meaning this one silently entered on 15-minute
// bars regardless of what timeframe was selected elsewhere. Rewritten to run
// the identical pattern on snap.m5, with bar counts scaled ~3x (15/5) to
// preserve the same real-world lookback duration: the old 40-bar/6-bar M15
// windows become 120-bar/18-bar M5 windows. H1/M15 remain used elsewhere
// (regime.js) purely for higher-timeframe CONTEXT, never for the trigger
// candle itself — that split (fast timeframe decides entry, slow timeframe
// only informs regime) is standard multi-timeframe practice and is left
// alone. This has NOT been re-backtested since the rewrite — run it through
// the Backtest tab against real historical data before trusting any win-rate
// number for it, same standard as every other setup in this file.
export function detectBreakoutRetest(snap, regime){
  const m5 = snap.m5;
  if(m5.length < 120) return null;
  const lookback = m5.slice(-120, -18);
  const recent = m5.slice(-18);
  const hi = Math.max(...lookback.map(c => c.h));
  const lo = Math.min(...lookback.map(c => c.l));
  const rangePct = ((hi - lo) / lo) * 100;
  if(rangePct > 3.2) return null; // not a tight enough consolidation to call a breakout meaningful

  const breakoutCandle = recent.find(c => c.c > hi || c.c < lo);
  if(!breakoutCandle) return null;
  const dir = breakoutCandle.c > hi ? 'LONG' : 'SHORT';
  const level = dir === 'LONG' ? hi : lo;

  const last = m5[m5.length - 1];
  const retestDistPct = Math.abs((last.c - level) / level) * 100;
  if(retestDistPct > 0.6) return null; // hasn't come back to retest the level yet

  const volExp = volumeExpansion(m5, 10);
  const volPctile = relativeVolumePercentile(m5, 20);
  const reasons = [`Consolidation range ${rangePct.toFixed(2)}% before breakout`, `Retesting breakout level within ${retestDistPct.toFixed(2)}%`];
  if(volExp < 0.7) return null; // retest on dead volume = weak confirmation
  reasons.push(`Retest volume ${volExp.toFixed(2)}x average (${Math.round(volPctile * 100)}th percentile)`);

  let conf = 58;
  conf += rangePct < 1.8 ? 10 : 3;
  conf += retestDistPct < 0.25 ? 10 : 4;
  conf += volPctile > 0.8 ? 10 : volExp > 1.3 ? 6 : 3;
  conf += (dir === 'LONG' && BULL_REGIMES.has(regime.regime)) || (dir === 'SHORT' && BEAR_REGIMES.has(regime.regime)) ? 6 : -8;
  conf = clamp(conf, 0, 95);

  return { type: 'Breakout + Retest', direction: dir, rawConfidence: Math.round(conf), reasons };
}

// ---- SETUP C: Range Reversal ----
// Only in confirmed Range regime — fade validated support/resistance, never the middle.
//
// Entry timeframe fix: same issue and same fix as Breakout + Retest above —
// this read its whole pattern (swing support/resistance, rejection candle,
// RSI) off snap.m15 instead of snap.m5. Rewritten onto m5 with the lookback
// scaled ~3x (40 -> 120 bars) to keep the same real-world window. The Range
// regime classification itself still comes from regime.js's H1/M15 read,
// which is context, not the trigger — unchanged, and correctly so. Not yet
// re-backtested post-rewrite; this strategy is also OFF by default in
// STRATEGY_REGISTRY below for the reasons already documented there (a
// fade/mean-reversion style has a measured losing case elsewhere in this
// codebase, Range Scalp's ~25-29% win rate) — re-enable only after running
// it through the Backtest tab against real data, not on the strength of
// this timeframe fix alone.
export function detectRangeReversal(snap, regime){
  if(regime.regime !== REGIMES.RANGE) return null;
  const m5 = snap.m5;
  if(m5.length < 120) return null;
  const { support, resistance } = swingLevels(m5, 120);
  const mid = (support + resistance) / 2;
  const last = m5[m5.length - 1];
  const rangeWidthPct = ((resistance - support) / support) * 100;
  if(rangeWidthPct < 0.4) return null; // too tight to trade the edges profitably after costs

  const distToSupportPct = Math.abs((last.c - support) / support) * 100;
  const distToResistancePct = Math.abs((last.c - resistance) / resistance) * 100;
  const nearSupport = distToSupportPct < rangeWidthPct * 0.18;
  const nearResistance = distToResistancePct < rangeWidthPct * 0.18;
  if(!nearSupport && !nearResistance) return null; // in the middle — never trade this

  const dir = nearSupport ? 'LONG' : 'SHORT';
  const rsiVal = rsi(m5, 14);
  const rejecting = dir === 'LONG' ? last.c > last.o : last.c < last.o;
  if(!rejecting) return null;

  const volExp = volumeExpansion(m5, 10);
  const volPctile = relativeVolumePercentile(m5, 20);
  const reasons = [`Price at range ${dir === 'LONG' ? 'support' : 'resistance'} (range width ${rangeWidthPct.toFixed(2)}%)`, `Rejection candle confirmed`];
  const rsiOk = dir === 'LONG' ? (rsiVal !== null && rsiVal < 45) : (rsiVal !== null && rsiVal > 55);
  if(rsiOk) reasons.push(`RSI ${rsiVal.toFixed(0)} supports mean-reversion`);
  if(volExp > 1.1) reasons.push(`Volume confirming rejection (${volExp.toFixed(2)}x, ${Math.round(volPctile * 100)}th percentile)`);

  let conf = 55;
  conf += rsiOk ? 12 : 0;
  conf += volPctile > 0.75 ? 10 : volExp > 1.1 ? 6 : 0;
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

// =============================================================
// STRATEGY REGISTRY — one entry per detector above, the single source
// of truth for the UI's strategy selector (js/futures-ui.js) and for
// which reward:risk ratio each strategy actually gets built at
// (engine.js reads defaultRR from here per-strategy, replacing the old
// single global fixed 2.0). Enable/disable state and any user-adjusted
// RR live in state.js/localStorage per strategy id, keyed to match
// `id` below — this registry only holds what's fixed about each one.
//
// defaultRR reasoning, each within the requested 1:1-1:3 band: fade/
// reversion-style setups (Range Reversal) get a tighter ratio since the
// move back to a mean is naturally limited; trend-following setups
// (Trend Continuation, Breakout + Retest) get a wider one since a real
// trend can run further than a single ATR-scaled stop; the two faster,
// more scalp-like setups (NxTGen Scalp, Liquidity Sweep Reversal) sit at
// the middle. These are starting points, not measured optima — see the
// honesty note on detectAllSetups below.
export const STRATEGY_REGISTRY = [
  {
    id: 'aiScalp', type: 'NxTGen Scalp', detector: 'detectAiScalp', defaultRR: 2.0, defaultEnabled: true,
    label: 'NxTGen Scalp',
    description: 'Parabolic SAR crossing the EMA50/EMA100 band — SAR flipping from above the band to below it is a Buy, the mirror flip is a Sell — confirmed by the Awesome Oscillator bar color (green for Buy, red for Sell) matching the cross.',
  },
  {
    id: 'novaScalp', type: 'Nova Scalp', detector: 'detectNovaScalp', defaultRR: 2.0, defaultEnabled: true,
    label: 'Nova Scalp',
    description: '5m Parabolic SAR / EMA50+EMA100 cross with AO + MACD zero-line confirmation. Buy: SAR dots cross up through the EMA50 & EMA100 band (dots under price), with AO and MACD both above zero (2+ bars preferred); Sell is the exact mirror. Stop at the most recent swing low/high near the SAR dots, target fixed at 2R (1:2), no partials. A Smart Range Filter (ADX, efficiency ratio, EMA separation/slope, SAR whipsaw, EMA crosses, ATR squeeze) vetoes entries in ranging markets.',
  },
  {
    id: 'trendContinuation', type: 'Trend Continuation', detector: 'detectTrendContinuation', defaultRR: 2.5, defaultEnabled: true,
    label: 'Trend Continuation',
    description: 'Enters on a pullback INTO an established trend (price retracing toward EMA20/VWAP on contracting volume, then momentum resuming) rather than fresh momentum — a genuinely different entry mechanism from NxTGen Scalp.',
  },
  {
    id: 'liquiditySweep', type: 'Liquidity Sweep Reversal', detector: 'detectLiquiditySweep', defaultRR: 2.0, defaultEnabled: true,
    label: 'Liquidity Sweep Reversal',
    description: 'A real reversal pattern, not continuation: price sweeps past a recent swing high/low (a stop-hunt shape) and immediately reclaims it. Requires volume confirmation to fire at all — a hard gate, not a bonus.',
  },
  {
    id: 'rangeReversal', type: 'Range Reversal', detector: 'detectRangeReversal', defaultRR: 1.5, defaultEnabled: false,
    label: 'Range Reversal',
    description: 'Fades validated swing-level support/resistance with a rejection candle, only in a confirmed Range regime. Entry trigger now runs on M5 (was M15 — see detectRangeReversal\'s comment). Off by default: this codebase has a measured case (Range Scalp, see README-SCALP.md) of a fade-style approach losing to this feed\'s real short-run momentum — this is more strictly gated than that one was, but unproven under the current engine either way.',
  },
  {
    id: 'breakoutRetest', type: 'Breakout + Retest', detector: 'detectBreakoutRetest', defaultRR: 2.5, defaultEnabled: false,
    label: 'Breakout + Retest',
    description: 'Consolidation, then a breakout, then a retest of that level with volume confirmation. Entry trigger now runs on M5 (was M15 — see detectBreakoutRetest\'s comment). Off by default: conceptually close to NxTGen Scalp\'s own momentum-chasing character, so it adds less diversification than the two enabled by default.',
  },
];

export function detectAllSetups(snap, regime, strategyConfig){
  // strategyConfig: { [id]: boolean } — which strategies from
  // STRATEGY_REGISTRY above are enabled. Defaults to each strategy's own
  // defaultEnabled when no config is passed (e.g. Paper mode calling this
  // without having read any UI state) or when a specific id is missing
  // from the config object.
  const enabled = id => {
    const entry = STRATEGY_REGISTRY.find(s => s.id === id);
    if(!strategyConfig || !(id in strategyConfig)) return entry ? entry.defaultEnabled : false;
    return !!strategyConfig[id];
  };
  const DETECTORS = {
    aiScalp: detectAiScalp,
    novaScalp: detectNovaScalp,
    trendContinuation: detectTrendContinuation,
    liquiditySweep: detectLiquiditySweep,
    rangeReversal: detectRangeReversal,
    breakoutRetest: detectBreakoutRetest,
  };
  // combineEnsemble (engine.js) already handles multiple setups firing on
  // the same symbol/cycle — agreement blends confidence, disagreement is
  // a hard no-trade, so enabling more detectors can only add another way
  // to get rejected on conflict, never silently stack risk.
  //
  // Honesty note, same standard as the rest of this file: none of these
  // five have been measured against this engine's current fixed-per-
  // strategy RR, current fee model, or current stop-distance floors as a
  // GROUP — enabling several at once is a reasoned, differently-shaped
  // setup of strategies, not a proven improvement. Each strategy's own
  // real Live/Demo results (Trade Log, tagged by setup type) are the
  // only honest measure of how it's actually doing — not a backtest
  // number quoted here or anywhere in this UI.
  return STRATEGY_REGISTRY
    .filter(s => enabled(s.id))
    .map(s => DETECTORS[s.id](snap, regime))
    .filter(Boolean);
}

// ---- SETUP F: NxTGen Scalp (Parabolic SAR / EMA50+EMA100 cross, AO-confirmed) ----
// Rebuilt on direct request to trade a specific, chart-verified pattern,
// replacing the earlier EMA9-slope momentum read. That earlier version's
// own history (deterministic-seed bug, "averaging close to breakeven"
// once fixed — see README-SCALP.md) is a real record of what was tried
// before this, not deleted, just no longer what this detector does.
//
// The setup, read directly off the two reference chart screenshots this
// was built from: watch where the Parabolic SAR dots sit relative to the
// EMA50/EMA100 band.
//   - BUY: SAR flips from sitting ABOVE the band to BELOW it (the dots
//     were riding above price through a downtrend, then cross under both
//     EMAs as the trend turns up) — AND the latest Awesome Oscillator bar
//     is GREEN (higher than the prior bar).
//   - SELL: the mirror image — SAR flips from BELOW the band to ABOVE it,
//     AND the latest AO bar is RED (lower than the prior bar).
// Both conditions are hard gates, not confidence bonuses — a SAR/EMA
// cross with the wrong-colored AO bar, or a right-colored AO bar with no
// cross, is not a signal, exactly as shown in both reference charts
// (the boxed cross lines up with the AO color flip in each one).
//
// EMA50-vs-EMA100 alignment (is the faster EMA already on the trade's
// side of the slower one — i.e. does the band itself agree the trend has
// turned, not just the SAR dot) and the AO color streak feed confidence,
// not the gate itself, since a SAR flip is often the leading edge of a
// trend change and won't always have the EMAs fully aligned yet.
//
// Same honesty standard as every other setup in this file: this is a
// specific, well-defined technical pattern with a clear mechanism, not a
// claim about a measured win rate — it hasn't been backtested under this
// engine's current fee model/stop floors yet. Run it through the
// Backtest tab (Strategies panel — shows up there via STRATEGY_REGISTRY
// below, unchanged by this rewrite) against real historical data before
// sizing anything real behind it.
export function detectAiScalp(snap, regime){
  const m5 = snap.m5;
  if(m5.length < 110) return null; // EMA100 and PSAR both need real warmup, not just enough bars to not crash

  const psar = parabolicSar(m5);
  const ema50 = emaSeries(closes(m5), 50);
  const ema100 = emaSeries(closes(m5), 100);
  const ao = awesomeOscillator(m5);

  const i = m5.length - 1;
  if(psar[i] == null || ao.colors[i] == null) return null;

  const bandHi = (idx) => Math.max(ema50[idx], ema100[idx]);
  const bandLo = (idx) => Math.min(ema50[idx], ema100[idx]);
  const sideAt = (idx) => {
    if(psar[idx] == null) return null;
    if(psar[idx] > bandHi(idx)) return 'above';
    if(psar[idx] < bandLo(idx)) return 'below';
    return null; // sitting inside the band — ambiguous, not a clean read either way
  };

  const nowSide = sideAt(i);
  if(nowSide == null) return null; // SAR sitting inside the band right now

  // The dots don't jump the whole band in a single bar (see the
  // reference charts, where the transition runs across several bars,
  // and the AO doesn't necessarily flip color on the exact same bar the
  // band-cross completes either — it's a lagging SMA5-vs-SMA34 read, so
  // it typically catches up a handful of bars later). So "was this a
  // recent cross" is read by scanning back for the most recent bar that
  // was CLEARLY on the OTHER side (skipping ambiguous in-between bars),
  // and treating the cross as live as long as that's within
  // RECENCY_BARS — not just the single immediate-prior bar.
  const RECENCY_BARS = 30;
  let priorSide = null, crossAge = null;
  for(let k = i - 1; k >= Math.max(0, i - 40); k--){
    const s = sideAt(k);
    if(s == null || s === nowSide) continue; // still on nowSide (or ambiguous) — keep looking further back
    priorSide = s;
    crossAge = i - k;
    break;
  }
  if(priorSide == null || crossAge > RECENCY_BARS) return null; // no recent cross to confirm

  const crossedBelow = priorSide === 'above' && nowSide === 'below'; // SAR flipped under the band -> Buy
  const crossedAbove = priorSide === 'below' && nowSide === 'above'; // SAR flipped over the band -> Sell
  if(!crossedBelow && !crossedAbove) return null;

  const dir = crossedBelow ? 'LONG' : 'SHORT';
  const aoColor = ao.colors[i];
  if(dir === 'LONG' && aoColor !== 'green') return null; // AO must confirm the cross's direction
  if(dir === 'SHORT' && aoColor !== 'red') return null;

  // Same discipline every other fast setup in this file holds to — don't
  // take a fresh cross straight into a strong OPPOSING HTF trend. See
  // detectAiScalp's git history / other setups' comments for what
  // happened when this kind of gate was tested wider against this feed.
  if(dir === 'LONG' && regime.regime === REGIMES.STRONG_BEAR) return null;
  if(dir === 'SHORT' && regime.regime === REGIMES.STRONG_BULL) return null;

  const last = m5[i];
  const emaTrendAligned = dir === 'LONG' ? ema50[i] > ema100[i] : ema50[i] < ema100[i];
  const psarDistPct = Math.abs(psar[i] - (dir === 'LONG' ? bandLo(i) : bandHi(i))) / last.c * 100;

  let aoStreak = 0;
  for(let k = i; k >= 0 && ao.colors[k] === aoColor; k--) aoStreak++;

  const reasons = [
    `Parabolic SAR crossed ${dir === 'LONG' ? 'below' : 'above'} the EMA50/EMA100 band`,
    `Awesome Oscillator bar is ${aoColor} (${dir === 'LONG' ? 'rising' : 'falling'}), confirming the cross`,
  ];
  if(emaTrendAligned) reasons.push(`EMA50 ${dir === 'LONG' ? 'above' : 'below'} EMA100 confirms the ${dir === 'LONG' ? 'up' : 'down'}trend`);
  if(aoStreak >= 2) reasons.push(`${aoStreak} consecutive ${aoColor} AO bars behind the signal`);

  let conf = 55;
  conf += emaTrendAligned ? 15 : 0;
  conf += aoStreak >= 3 ? 10 : aoStreak >= 2 ? 5 : 0;
  conf += psarDistPct > 0.15 ? 10 : 3;
  conf = clamp(conf, 0, 92);

  return { type: 'NxTGen Scalp', direction: dir, rawConfidence: Math.round(conf), reasons, meta: { psarDistPct, aoStreak, emaTrendAligned } };
}

// ---- SETUP G: Nova Scalp (PSAR x EMA50/100 cross + AO/MACD zero-line, range-filtered) ----
// Strategy logic rewritten on direct request. Replaces the earlier VWAP-
// reclaim detector entirely (that history is in README-SCALP.md).
//
// Indicators: Awesome Oscillator, EMA 50 / EMA 100, MACD (12,26,9),
// Parabolic SAR (0.02 / 0.2). Entry timeframe: 5m only — nothing here
// reads M15/H1.
//
// BUY
//   1. Parabolic SAR dots cross the EMA50 AND EMA100 from BELOW: the SAR
//      value was clearly under the whole EMA50/EMA100 band and is now
//      clearly above it, with the dot sitting UNDER price (a bullish SAR).
//      "Fresh" = the cross completed within NOVA_SCALP.crossMaxAgeBars.
//   2. AO > 0 and MACD main line > 0 (MetaTrader convention — see
//      macdLineSeries). NOVA_SCALP.minZeroBars is the hard minimum number of
//      consecutive bars both must have been above zero (default 1 = just
//      "above zero now"); NOVA_SCALP.preferredZeroBars (default 2) is the
//      "2+ preferred" part — hitting it raises confidence instead of being
//      required, matching "preferably 2+". Set minZeroBars to 2 to make it a
//      hard rule.
//   3. Smart Range Filter (rangeFilter.js) says the M5 market is trending.
// SELL is the exact mirror: SAR dots (above price) cross DOWN through the
// band from above, AO < 0 and MACD < 0.
//
// STOP: the most recent confirmed swing low (2-left/2-right fractal) inside
// the current SAR run — i.e. the swing low sitting next to the lowest SAR
// dots — falling back to the run's lowest dot itself if no swing low formed
// in the run, less a small ATR buffer so a wick to the pivot doesn't tag it.
// Sells use the swing high / highest dot, plus the buffer. The stop is
// structural, so it is NOT clamped to the fee-driven floors the other
// scalps use: too-wide stops are vetoed here (maxStopPct) and too-tight ones
// are rejected by the existing fee-to-stop gate in noTradeEngine.js.
// TARGET: fixed 2R from that stop, single exit, no partials (engine.js).
//
// Honesty note, same standard as every detector in this file: this is a
// precisely-specified pattern, not a measured win rate. It has not been
// backtested from within this codebase. Run it in the Backtest tab against
// real 5m history before sizing anything real behind it. Like the other
// detectors it evaluates the latest M5 candle, which on live feeds can be
// the still-forming one, so a cross can appear and disappear intra-bar.
export const NOVA_SCALP = {
  minBars: 110,
  crossMaxAgeBars: 3,
  minZeroBars: 1,
  preferredZeroBars: 2,
  swingLeft: 2, swingRight: 2,
  stopBufferAtr: 0.10,
  maxStopPct: 1.5,        // structural stop further than this from entry = skip (also re-checked against live price in engine.js)
  minStopPct: 0.03,       // sanity floor only; real fee-driven rejection is noTradeEngine's fee-to-stop gate
  rewardRisk: 2.0,        // fixed 1:2
  rangeFilter: { ...RANGE_FILTER_DEFAULTS },
};

// Was there a fresh cross of the SAR through the whole EMA50/EMA100 band?
// want = 'up' (below -> above) or 'down' (above -> below). Bars where SAR
// sits inside the band are transitional and skipped, not treated as either
// side. Returns { crossBar, originBar, age } or null.
function findSarBandCross(psar, ema50, ema100, i, want){
  const sideAt = (idx) => {
    const v = psar[idx];
    if(v == null) return null;
    const hi = Math.max(ema50[idx], ema100[idx]), lo = Math.min(ema50[idx], ema100[idx]);
    return v > hi ? 'above' : v < lo ? 'below' : 'inside';
  };
  const target = want === 'up' ? 'above' : 'below';
  const origin = want === 'up' ? 'below' : 'above';
  if(sideAt(i) !== target) return null;
  let crossBar = i;
  for(let k = i - 1; k >= Math.max(1, i - 40); k--){
    const s2 = sideAt(k);
    if(s2 === origin) return { crossBar, originBar: k, age: i - crossBar };
    if(s2 === target) crossBar = k;
  }
  return null; // never found the origin side within the window — not a cross
}

export function detectNovaScalp(snap, regime){
  const P = NOVA_SCALP;
  const m5 = snap.m5;
  if(!m5 || m5.length < P.minBars) return null;

  const i = m5.length - 1;
  const last = m5[i];
  const c = closes(m5);
  const psar = parabolicSar(m5);
  const ema50 = emaSeries(c, 50);
  const ema100 = emaSeries(c, 100);
  if(psar[i] == null) return null;

  // 1. Trigger: SAR crossing the EMA band, dots on the correct side of price.
  const up = findSarBandCross(psar, ema50, ema100, i, 'up');
  const down = findSarBandCross(psar, ema50, ema100, i, 'down');
  const buy = up && psar[i] < last.c;
  const sell = down && psar[i] > last.c;
  if(!buy && !sell) return null;
  const cross = buy ? up : down;
  if(cross.age > P.crossMaxAgeBars) return null;
  const dir = buy ? 'LONG' : 'SHORT';

  // 2. AO + MACD on the right side of zero.
  const ao = awesomeOscillator(m5).values;
  const macd = macdLineSeries(m5, 12, 26);
  const onSide = dir === 'LONG' ? (v => v > 0) : (v => v < 0);
  const aoBars = streakBack(ao, i, onSide);
  const macdBars = streakBack(macd, i, onSide);
  const word = dir === 'LONG' ? 'above' : 'below';
  if(aoBars < P.minZeroBars || macdBars < P.minZeroBars) return null; // momentum not confirming yet — may still fire on a later bar inside the cross window

  // 3. Smart Range Filter (M5 only). Vetoes are returned, not swallowed, so
  // the scanner can show WHY a genuine trigger was skipped (engine.js
  // routes any signal carrying vetoes[] to a REJECTED row with those reasons).
  const vetoes = [];
  const state = assessMarketState(m5, P.rangeFilter, { psar, ema50, ema100 });
  if(!state.trending) vetoes.push(...state.reasons);

  // Structural stop.
  const atr5 = atr(m5, 14) || last.c * 0.0015;
  let runStart = i;
  for(let k = i; k >= Math.max(0, i - 80); k--){
    const inRun = psar[k] != null && (dir === 'LONG' ? psar[k] < m5[k].c : psar[k] > m5[k].c);
    if(!inRun) break;
    runStart = k;
  }
  let sarExtreme = dir === 'LONG' ? Infinity : -Infinity; // lowest dot (buy) / highest dot (sell) of the run
  for(let k = runStart; k <= i; k++){
    if(psar[k] == null) continue;
    sarExtreme = dir === 'LONG' ? Math.min(sarExtreme, psar[k]) : Math.max(sarExtreme, psar[k]);
  }
  const from = Math.max(0, runStart - P.swingLeft), to = i - P.swingRight;
  const swings = dir === 'LONG' ? swingLowPoints(m5, from, to, P.swingLeft, P.swingRight) : swingHighPoints(m5, from, to, P.swingLeft, P.swingRight);
  const validSwings = swings.filter(sw => dir === 'LONG' ? sw.price < last.c : sw.price > last.c);
  const swing = validSwings.length ? validSwings[validSwings.length - 1] : null; // most recent
  const anchor = swing ? swing.price : sarExtreme;
  const stopBasis = swing ? 'swing' : 'sar';
  const buffer = atr5 * P.stopBufferAtr;
  const stopPrice = dir === 'LONG' ? anchor - buffer : anchor + buffer;
  const stopDistPct = Math.abs(last.c - stopPrice) / last.c * 100;

  if(!(stopDistPct > 0) || (dir === 'LONG' ? stopPrice >= last.c : stopPrice <= last.c)) return null;
  if(stopDistPct < P.minStopPct) vetoes.push(`Structural stop only ${stopDistPct.toFixed(3)}% from entry — too tight to be meaningful`);
  if(stopDistPct > P.maxStopPct) vetoes.push(`Structural stop ${stopDistPct.toFixed(2)}% from entry exceeds the ${P.maxStopPct}% cap — entry too far from the swing`);

  const emaAligned = dir === 'LONG' ? ema50[i] > ema100[i] : ema50[i] < ema100[i];
  const twoPlus = aoBars >= P.preferredZeroBars && macdBars >= P.preferredZeroBars;

  const reasons = [
    `Parabolic SAR crossed ${dir === 'LONG' ? 'up' : 'down'} through the EMA50/EMA100 band ${cross.age === 0 ? 'on this bar' : cross.age + ' bar(s) ago'}, dots ${dir === 'LONG' ? 'under' : 'over'} price`,
    `AO ${word} zero for ${aoBars} bar(s), MACD ${word} zero for ${macdBars} bar(s)${twoPlus ? ' (2+ preferred: met)' : ' (2+ preferred: not yet)'}`,
    `Stop at ${stopBasis === 'swing' ? 'most recent swing ' + (dir === 'LONG' ? 'low' : 'high') : 'SAR ' + (dir === 'LONG' ? 'low' : 'high')} ${stopPrice.toPrecision(6)} (${stopDistPct.toFixed(2)}% risk), target fixed at ${P.rewardRisk}R`,
    ...state.reasons,
  ];
  if(emaAligned) reasons.push(`EMA50 ${dir === 'LONG' ? 'above' : 'below'} EMA100 confirms the ${dir === 'LONG' ? 'up' : 'down'}trend`);

  let conf = 60;
  conf += aoBars >= P.preferredZeroBars ? 6 : 0;
  conf += macdBars >= P.preferredZeroBars ? 6 : 0;
  conf += state.score >= 75 ? 10 : state.score >= 65 ? 6 : 2;
  conf += emaAligned ? 6 : 0;
  conf += cross.age <= 1 ? 4 : 0;
  conf = clamp(conf, 0, 92);

  return {
    type: 'Nova Scalp', direction: dir, rawConfidence: Math.round(conf), reasons,
    vetoes: vetoes.length ? vetoes : undefined,
    meta: {
      stopPrice, stopBasis, stopDistPct, crossAge: cross.age, aoBars, macdBars,
      rangeFilter: { score: state.score, ...state.metrics },
    },
  };
}
