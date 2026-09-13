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
// more scalp-like setups (AI Scalp, Liquidity Sweep Reversal) sit at
// the middle. These are starting points, not measured optima — see the
// honesty note on detectAllSetups below.
export const STRATEGY_REGISTRY = [
  {
    id: 'aiScalp', type: 'AI Scalp', detector: 'detectAiScalp', defaultRR: 2.0, defaultEnabled: true,
    label: 'AI Scalp',
    description: 'Trades WITH short-term momentum — EMA9 sloping in the trade direction, price confirming on the momentum side, a push candle behind it. Fast, frequent, the original strategy in this build.',
  },
  {
    id: 'novaScalp', type: 'Nova Scalp', detector: 'detectNovaScalp', defaultRR: 2.0, defaultEnabled: true,
    label: 'Nova Scalp',
    description: '5m VWAP-reclaim scalp: price sits on one side of its rolling VWAP for 2+ bars, then reclaims it with a push candle and a volume expansion behind it. A genuinely different trigger from AI Scalp (VWAP cross vs. EMA slope), not a re-parameterized copy — see its own comment in setups.js for the honesty note on measuring this before sizing real risk behind it.',
  },
  {
    id: 'trendContinuation', type: 'Trend Continuation', detector: 'detectTrendContinuation', defaultRR: 2.5, defaultEnabled: true,
    label: 'Trend Continuation',
    description: 'Enters on a pullback INTO an established trend (price retracing toward EMA20/VWAP on contracting volume, then momentum resuming) rather than fresh momentum — a genuinely different entry mechanism from AI Scalp.',
  },
  {
    id: 'liquiditySweep', type: 'Liquidity Sweep Reversal', detector: 'detectLiquiditySweep', defaultRR: 2.0, defaultEnabled: true,
    label: 'Liquidity Sweep Reversal',
    description: 'A real reversal pattern, not continuation: price sweeps past a recent swing high/low (a stop-hunt shape) and immediately reclaims it. Requires volume confirmation to fire at all — a hard gate, not a bonus.',
  },
  {
    id: 'rangeReversal', type: 'Range Reversal', detector: 'detectRangeReversal', defaultRR: 1.5, defaultEnabled: false,
    label: 'Range Reversal',
    description: 'Fades validated swing-level support/resistance with a rejection candle, only in a confirmed Range regime. Off by default: this codebase has a measured case (Range Scalp, see README-SCALP.md) of a fade-style approach losing to this feed\'s real short-run momentum — this is more strictly gated than that one was, but unproven under the current engine either way.',
  },
  {
    id: 'breakoutRetest', type: 'Breakout + Retest', detector: 'detectBreakoutRetest', defaultRR: 2.5, defaultEnabled: false,
    label: 'Breakout + Retest',
    description: 'Consolidation, then a breakout, then a retest of that level with volume confirmation. Off by default: conceptually close to AI Scalp\'s own momentum-chasing character, so it adds less diversification than the two enabled by default.',
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
// detector's edge comes from trading WITH mockMarket.js's "mood"
// process (see its header comment) instead of fighting it, confirmed by
// EMA9 slope + price + a push candle. How strong that edge actually is,
// though, was measured wrong for a while: the mock generator used a
// fixed seed, so every "independent backtest run" cited here early on
// was replaying the same one price sequence, not sampling different
// ones — see "deterministic seed bug" in README-SCALP.md. With that
// fixed, genuinely independent runs range from clearly losing to
// clearly profitable, averaging close to breakeven — a real, if much
// less confident, edge instead of the specific win-rate figures
// (69-73%, later 65-76%) this comment used to quote as settled (that
// edge is still real relative to the earlier, opposite-direction fade
// attempt, which measured ~25-29% — see git history). Whatever this
// edge actually is, it is a property of THIS synthetic feed's
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
  //
  // An earlier revision of this file tried widening this to block WEAK
  // opposing trends too, and made RSI/volume hard requirements instead
  // of confidence bonuses — all individually defensible on standard
  // multi-timeframe-confluence theory. Reverted: tested against this
  // synthetic feed (the only data available to test against), it turned
  // profit factor from ~1.5 into ~0.8 — a LOSING strategy — across three
  // separate runs. Shipping a change with no evidence it helps real
  // trading and clear evidence it hurts the one thing that could be
  // measured would be worse than leaving this as-is. See README-SCALP.md.
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

// ---- SETUP G: Nova Scalp (VWAP reclaim continuation) ----
// A second, independently-triggered 5m scalp — same "trade WITH the
// order flow, not against it" discipline as AI Scalp above (see that
// detector's own note on why fading a stretched move measured badly
// against this feed), but a genuinely different trigger mechanism:
// instead of watching EMA9 slope, this watches for price crossing back
// over its own rolling VWAP after sitting on the OTHER side for the
// prior two bars — a "reclaim" — confirmed by a push candle in the
// reclaim direction and a volume expansion behind it. VWAP reclaims are
// a standard, well-documented intraday scalping trigger (institutional
// flow frequently reacts around VWAP), which is why this is offered as
// a second, differently-shaped 5m scalp rather than a re-parameterized
// copy of AI Scalp — enabling both genuinely diversifies the signal
// source, it isn't the same detector twice.
//
// Same honesty standard this whole file holds every other setup to
// (see AI Scalp's own comment, and detectAllSetups' note below): this
// detector's LOGIC is sound and grounded in a real, widely-used scalping
// technique, but that is not the same claim as a measured win rate. It
// has not been backtested against real historical klines from within
// this codebase — do that yourself via the Backtest tab (Strategies
// panel — this shows up there automatically, see STRATEGY_REGISTRY
// below) against the real symbols/timeframe/exchange you actually
// intend to trade before sizing anything real behind it. A strategy's
// name, its presence in this registry, or a plausible-sounding
// mechanism are none of them evidence of a particular win rate — only a
// real backtest run against real historical data is, exactly the
// standard AI Scalp's own history above (69-73%, then 65-76%, then
// "averaging close to breakeven" once a measurement bug was fixed) is a
// cautionary example of.
export function detectNovaScalp(snap, regime){
  const m5 = snap.m5;
  if(m5.length < 30) return null;

  const c = closes(m5);
  const ema9 = ema(c, 9);
  const atr5 = atr(m5, 14);
  if(!ema9 || !atr5) return null;

  // Rolling 40-bar VWAP, not session-anchored — this pipeline is
  // exchange-agnostic and has no reliable session-open boundary to
  // anchor to (see vwap() in indicators.js), so a rolling window is
  // used the same way Trend Continuation's own vwap5 already does.
  const vwapVal = vwap(m5.slice(-40));
  if(!vwapVal) return null;

  const last = m5[m5.length - 1];
  const prev1 = m5[m5.length - 2];
  const prev2 = m5[m5.length - 3];
  if(!prev1 || !prev2) return null;

  // Reclaim = the prior TWO bars closed on one side of VWAP, and the
  // current bar just closed back on the other side of it.
  const wasBelow = prev1.c < vwapVal && prev2.c < vwapVal;
  const wasAbove = prev1.c > vwapVal && prev2.c > vwapVal;
  const reclaimedUp = wasBelow && last.c > vwapVal;
  const reclaimedDown = wasAbove && last.c < vwapVal;
  if(!reclaimedUp && !reclaimedDown) return null;

  const dir = reclaimedUp ? 'LONG' : 'SHORT';
  const pushCandle = dir === 'LONG' ? last.c > last.o : last.c < last.o;
  if(!pushCandle) return null; // want a genuine push through VWAP, not a weak wick close right on it

  // Don't chase a VWAP reclaim straight into a strong OPPOSING HTF trend
  // — identical discipline to AI Scalp, for the identical reason (see
  // that detector's comment on what happened when this kind of gate was
  // tested wider against the synthetic feed: turned a working strategy
  // into a losing one).
  if(dir === 'LONG' && regime.regime === REGIMES.STRONG_BEAR) return null;
  if(dir === 'SHORT' && regime.regime === REGIMES.STRONG_BULL) return null;

  const volExp = volumeExpansion(m5, 10);
  if(volExp < 1.1) return null; // a reclaim with no volume behind it is exactly the low-quality case this filters out

  const distFromVwapPct = Math.abs((last.c - vwapVal) / vwapVal) * 100;
  const emaAligned = dir === 'LONG' ? last.c > ema9 : last.c < ema9;
  const rsiVal = rsi(m5, 14);
  const rsiOk = dir === 'LONG' ? (rsiVal !== null && rsiVal > 45 && rsiVal < 75) : (rsiVal !== null && rsiVal < 55 && rsiVal > 25);

  const reasons = [
    `Price reclaimed VWAP to the ${dir === 'LONG' ? 'upside' : 'downside'} after 2+ bars on the other side`,
    `Volume ${volExp.toFixed(2)}x average behind the reclaim`,
  ];
  if(emaAligned) reasons.push('EMA9 confirms the same side as the reclaim');
  if(rsiOk) reasons.push(`RSI ${rsiVal.toFixed(0)} supports continuation, not yet exhausted`);

  let conf = 54;
  conf += volExp > 1.5 ? 12 : 6;
  conf += emaAligned ? 10 : 0;
  conf += rsiOk ? 10 : 0;
  conf += distFromVwapPct > 0.15 ? 6 : 0; // a clean break away from VWAP, not sitting right back on the line
  conf = clamp(conf, 0, 88);

  return { type: 'Nova Scalp', direction: dir, rawConfidence: Math.round(conf), reasons, meta: { distFromVwapPct } };
}
