// =============================================================
// setups.js — the four independent setup detectors. Each takes the
// M5/M15/H1 candles + the current regime and returns either null
// (no setup found) or a signal: { type, direction, rawConfidence,
// reasons[] }. The ensemble in engine.js combines whichever of
// these fire on a given symbol/cycle.
// =============================================================
import { ema, emaSeries, atr, rsi, macdHistogram, vwap, swingLevels, volumeExpansion, relativeVolumePercentile, closes, clamp, parabolicSar, awesomeOscillator, macdSeries } from './indicators.js';
import { REGIMES } from './regime.js';
import { smartRangeFilter } from './rangeFilter.js';
import { QUANT_ID, QUANT_TYPE, quantSymbolSet } from './quant/config.js';
import { detectQuantFutures } from './quant/signal.js';

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
    description: '5m only. Parabolic SAR dots break through the EMA50/EMA100 band (up through it for a Buy, down through it for a Sell) with MACD and the Awesome Oscillator both on the trade side of zero (2+ bars preferred). Stop at the recent swing low/high near the SAR dots, single 2R target, and a Smart Range Filter (ADX, efficiency ratio, EMA slope/spread, SAR whipsaw, chop) that blocks entries in ranging markets. Overlaps NxTGen Scalp — see the detector comment.',
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
  {
    id: QUANT_ID, type: QUANT_TYPE, detector: 'detectQuantFutures', defaultRR: 2.0, defaultEnabled: false,
    rrOptions: [2, 2.5, 3, 4], // Quant Futures never opens below 1:2 (see quant/config.js HARD_LIMITS)
    label: 'NxTGen Quant Futures',
    description: 'Quantitative multi-factor crypto futures strategy combining market regime detection, trend, momentum, volatility, liquidity, volume and multi-timeframe structure to identify selective 5m/15m futures setups with a minimum 1:2 risk/reward target. Deterministic 0-100 confluence score, adaptive structure+ATR stops, drawdown-scaled risk. Off by default — configure it in the Quant Futures panel below, then enable.',
  },
];

// quantCtx (optional): { qcfg, ctx } — the sanitized Quant Futures config and
// its per-call context ({ nowMs, log, costPct }). Without it the Quant detector
// simply returns nothing, so every existing caller is unaffected.
// onlyIds (optional): restrict to these strategy ids — used for symbols that
// the platform excludes from the six original strategies but that Quant Futures
// is explicitly configured to trade (BTC/ETH/SOL/BNB).
export function detectAllSetups(snap, regime, strategyConfig, quantCtx, onlyIds){
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
    [QUANT_ID]: (sn, rg) => (quantCtx && quantCtx.qcfg && quantSymbolSet(quantCtx.qcfg).has(sn.symbol))
      ? detectQuantFutures(sn, rg, quantCtx.qcfg, quantCtx.ctx)
      : null,
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
    .filter(s => enabled(s.id) && (!onlyIds || onlyIds.includes(s.id)))
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

// ---- SETUP G: Nova Scalp (PSAR / EMA50+100 break, MACD + AO confirmed, range-filtered) ----
// Rebuilt on direct request — replaces the earlier 5m VWAP-reclaim trigger
// (its history is in git; this is no longer what the detector does).
// Indicators: Parabolic SAR, EMA50 + EMA100, MACD(12,26,9), Awesome
// Oscillator. Entry logic runs ONLY on the 5-minute candles.
//
// BUY:
//   1. The Parabolic SAR dots break up through the EMA50/EMA100 band —
//      they were BELOW the band and have now cleared the TOP of it, with
//      SAR still trailing under price (a live bullish SAR the whole way,
//      no flip back in between). The cross must be fresh (completed within
//      the last few bars) so this is an entry trigger, not a late chase.
//   2. MACD (the 12-26 line, i.e. the grey bars MetaTrader draws) AND the
//      Awesome Oscillator are both ABOVE ZERO. Held for 2+ consecutive
//      bars is preferred — it scores higher — and one bar is the minimum
//      (NOVA_MIN_CONFIRM_BARS; set it to 2 to make two bars mandatory).
//   3. The Smart Range Filter (rangeFilter.js) says the market is actually
//      trending. Ranging markets are vetoed.
// SELL is the exact mirror: dots break DOWN through the band from above,
// with SAR still above price, MACD and AO both BELOW zero.
//
// RISK: stop-loss sits at the most recent confirmed swing low (swing HIGH
// for a sell) that is close to the extreme of the SAR dots in the current
// run — the SAR's first dot after a flip is the prior swing extreme, so
// this is the level whose break means the SAR trend itself has failed —
// plus a small ATR buffer so a wick that just tags the level doesn't stop
// it out. Target is a single 2R exit (engine.js applies it: full position
// closes at 2R, no partials).
//
// Same honesty standard as the rest of this file: a well-defined pattern
// with a clear mechanism, NOT a measured win rate. Run it in the Backtest
// tab on your real symbols/exchange before sizing real risk behind it.
// Note it overlaps NxTGen Scalp (also PSAR-vs-EMA-band) — different
// direction convention and different confirmation, but both will often
// fire on the same move, so results will be correlated if both are on.
export const NOVA_MIN_CONFIRM_BARS = 1;       // MACD+AO must agree for at least this many bars (gate)
export const NOVA_PREFERRED_CONFIRM_BARS = 2; // ...and 2+ earns the confidence bonus
const NOVA_CROSS_MAX_AGE = 2;                 // dots cleared the band within the last 3 bars (0 = this bar)
// Widest stop still treated as a scalp, scaled to the symbol's own 5m volatility (7 ATRs, kept
// between 1% and 3%): a swing low far behind price means the move already ran — skip the chase.
const NOVA_MAX_STOP_ATRS = 7, NOVA_MAX_STOP_FLOOR_PCT = 1.0, NOVA_MAX_STOP_CEIL_PCT = 3.0;
const NOVA_MIN_STOP_PCT = 0.10;               // degenerate stop guard (the fee-to-stop gate does the real work)
const NOVA_TARGET_R = 2;
const NOVA_STOP_ATR_BUFFER = 0.15;

// Confirmed 5-bar fractal swing points (2 bars each side) — a swing is only
// "confirmed" once two later bars exist, so the newest candidate is i-2.
function fractalSwings(m5, from, to, kind){
  const out = [];
  for(let k = Math.max(2, from); k <= Math.min(to, m5.length - 3); k++){
    const v = kind === 'low' ? m5[k].l : m5[k].h;
    const cmp = (j) => kind === 'low' ? v < m5[j].l : v > m5[j].h;
    if(cmp(k - 1) && cmp(k - 2) && cmp(k + 1) && cmp(k + 2)) out.push({ idx: k, price: v });
  }
  return out;
}

// `trace` is an optional out-parameter (used by tests/diagnostics): when passed,
// it records which stage stopped the signal. Production callers omit it.
export function detectNovaScalp(snap, regime, trace){
  const stop = (why) => { if(trace) trace.blockedAt = why; return null; };
  const m5 = snap.m5;
  if(m5.length < 110) return stop('warmup'); // EMA100 / MACD(26+9) / AO(34) warmup — 110 (not more) so it still works on the 120-bar windows Paper and Backtest hand detectors (live gets 150)

  const cl = closes(m5);
  const psar = parabolicSar(m5);
  const ema50 = emaSeries(cl, 50);
  const ema100 = emaSeries(cl, 100);
  const ao = awesomeOscillator(m5);
  const macd = macdSeries(m5, 12, 26, 9);
  const i = m5.length - 1;
  if(psar[i] == null || ao.values[i] == null || macd.macd[i] == null) return stop('warmup');

  const bandHi = (k) => Math.max(ema50[k], ema100[k]);
  const bandLo = (k) => Math.min(ema50[k], ema100[k]);
  const sideAt = (k) => {
    if(psar[k] == null) return null;
    if(psar[k] > bandHi(k)) return 'above';
    if(psar[k] < bandLo(k)) return 'below';
    return 'inside';
  };

  // ---- 1. SAR breaks through the band ----
  const nowSide = sideAt(i);
  if(nowSide !== 'above' && nowSide !== 'below') return stop('no-cross'); // still inside the band — not through it yet
  const dir = nowSide === 'above' ? 'LONG' : 'SHORT';

  // when did the dots first clear the band on this side (consecutive run ending now)?
  let c0 = i;
  while(c0 - 1 >= 0 && sideAt(c0 - 1) === nowSide) c0--;
  if(i - c0 > NOVA_CROSS_MAX_AGE) return stop('no-cross'); // not a fresh cross

  // ...and before that they were on the OTHER side (allow a few bars of "inside" while crossing)
  const wantPrior = nowSide === 'above' ? 'below' : 'above';
  let priorIdx = null;
  for(let k = c0 - 1; k >= Math.max(0, c0 - 12); k--){
    const sd = sideAt(k);
    if(sd === wantPrior){ priorIdx = k; break; }
    if(sd === nowSide) break; // can't happen given c0, defensive
  }
  if(priorIdx == null) return stop('no-cross');

  // SAR must have stayed on the trade's side of PRICE the whole way (no flip mid-cross):
  // bullish = dots under price for a buy, bearish = dots over price for a sell.
  const sarWithTrade = (k) => dir === 'LONG' ? psar[k] < m5[k].c : psar[k] > m5[k].c;
  for(let k = priorIdx; k <= i; k++) if(psar[k] == null || !sarWithTrade(k)) return stop('sar-flip');

  // ---- 2. MACD + AO both on the trade's side of zero ----
  const agrees = (k) => {
    const m = macd.macd[k], a = ao.values[k];
    if(m == null || a == null) return false;
    return dir === 'LONG' ? (m > 0 && a > 0) : (m < 0 && a < 0);
  };
  let confirmBars = 0;
  for(let k = i; k >= 0 && agrees(k); k--) confirmBars++;
  if(confirmBars < NOVA_MIN_CONFIRM_BARS) return stop('macd-ao');

  // ---- 3. Smart range filter ----
  const filt = smartRangeFilter(m5, dir, regime);
  if(trace) trace.filter = filt;
  if(!filt.trending) return stop('range-filter');

  // ---- stop: recent swing extreme near the SAR run's extreme ----
  const atr5 = atr(m5, 14);
  if(!atr5) return stop('warmup');
  const entry = m5[i].c;

  let runStart = i;
  while(runStart - 1 >= 0 && psar[runStart - 1] != null && sarWithTrade(runStart - 1)) runStart--;
  let sarExtreme = psar[runStart];
  for(let k = runStart; k <= i; k++) sarExtreme = dir === 'LONG' ? Math.min(sarExtreme, psar[k]) : Math.max(sarExtreme, psar[k]);

  const swings = fractalSwings(m5, Math.max(2, runStart - 8), i - 2, dir === 'LONG' ? 'low' : 'high');
  const tol = atr5 * 1.5;
  const nearSar = swings.filter(sw => Math.abs(sw.price - sarExtreme) <= tol
    && (dir === 'LONG' ? sw.price < entry : sw.price > entry));
  let structure, stopBase;
  if(nearSar.length){
    const sw = nearSar[nearSar.length - 1]; // most recent
    stopBase = sw.price;
    structure = `swing ${dir === 'LONG' ? 'low' : 'high'} ${sw.price} (${i - sw.idx} bars ago) near the SAR extreme ${sarExtreme.toPrecision(6)}`;
  } else {
    stopBase = sarExtreme; // no fractal near the dots — the SAR extreme itself is the structure
    structure = `SAR dot extreme ${sarExtreme.toPrecision(6)} (no confirmed swing ${dir === 'LONG' ? 'low' : 'high'} near it)`;
  }
  const stopPrice = dir === 'LONG' ? stopBase - atr5 * NOVA_STOP_ATR_BUFFER : stopBase + atr5 * NOVA_STOP_ATR_BUFFER;
  const stopDistancePct = Math.abs(entry - stopPrice) / entry * 100;
  if(dir === 'LONG' ? stopPrice >= entry : stopPrice <= entry) return stop('stop-invalid');
  const maxStopPct = clamp((atr5 / entry) * 100 * NOVA_MAX_STOP_ATRS, NOVA_MAX_STOP_FLOOR_PCT, NOVA_MAX_STOP_CEIL_PCT);
  if(stopDistancePct > maxStopPct || stopDistancePct < NOVA_MIN_STOP_PCT){ if(trace) trace.stopPct = stopDistancePct; return stop('stop-distance'); }

  // ---- confidence + explanation ----
  const emaAligned = dir === 'LONG' ? ema50[i] > ema100[i] : ema50[i] < ema100[i];
  const reasons = [
    `Parabolic SAR broke ${dir === 'LONG' ? 'up through the top of' : 'down through the bottom of'} the EMA50/EMA100 band ${i - c0 === 0 ? 'on this bar' : `${i - c0} bar(s) ago`}, SAR still ${dir === 'LONG' ? 'below' : 'above'} price`,
    `MACD and Awesome Oscillator both ${dir === 'LONG' ? 'above' : 'below'} zero for ${confirmBars} bar${confirmBars === 1 ? '' : 's'}`,
    `Smart range filter: trend quality ${filt.score}/100 — ${filt.notes[0]}`,
    `Stop at ${structure}; single ${NOVA_TARGET_R}R target`,
  ];
  if(emaAligned) reasons.push(`EMA50 ${dir === 'LONG' ? 'above' : 'below'} EMA100 — band already stacked with the trade`);

  let conf = 55;
  conf += clamp((filt.score - 60) / 40, 0, 1) * 20;              // trend quality: up to +20
  conf += confirmBars >= NOVA_PREFERRED_CONFIRM_BARS ? 12 : 0;   // the "2+ bars" preference
  conf += confirmBars >= 4 ? 4 : 0;
  conf += emaAligned ? 8 : 0;
  conf += (i - c0) === 0 ? 4 : 0;                                // fresh on this very bar
  conf = clamp(conf, 0, 90);

  return {
    type: 'Nova Scalp', direction: dir, rawConfidence: Math.round(conf), reasons,
    meta: { stopPrice, stopDistancePct, targetR: NOVA_TARGET_R, structure, confirmBars, crossAgeBars: i - c0, smartFilter: { score: filt.score, components: filt.components } },
  };
}
