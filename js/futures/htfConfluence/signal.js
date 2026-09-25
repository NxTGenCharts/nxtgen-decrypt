// =============================================================
// htfConfluence/signal.js — the "NxTGen HTF Confluence" detector.
//
// REWRITTEN LOGIC (no order block, no PSAR):
//   Entry trigger  — EMA50 crosses EMA100 on the 5M entry timeframe.
//                     A genuine cross THIS bar, not just alignment.
//   Buy signal     — EMA50 crosses above EMA100 (from below) AND the
//                     Awesome Oscillator is already above the zero
//                     line.
//   Sell signal    — EMA50 crosses below EMA100 (from above) AND the
//                     Awesome Oscillator is already below the zero
//                     line.
//   Trend filter   — to stop the strategy blindly trading every 5M
//                     crossover, the 15M, 30M (aggregated from 15M)
//                     and 1H timeframes must ALL show the same
//                     EMA50-vs-EMA100 relationship as the crossover
//                     direction. Any one of them disagreeing vetoes
//                     the signal outright.
//   Level required — price must be interacting with a valid HTF
//                     demand (Buy) or supply (Sell) level — see
//                     structure.js's findZones. No order block is
//                     required or scored any more.
//
// See STRATEGY_REGISTRY (setups.js) for how this plugs into the
// platform, and engine.js's evaluateHtfConfluenceRow for how the
// returned signal becomes an actual sized, gated trade (reusing the
// exact same cost/risk/no-trade-gate machinery every other strategy in
// this codebase uses).
//
// ANTI-LOOKAHEAD: only ever reads snap.h1/snap.m15/snap.m5 exactly as
// handed in by the caller (already-closed candles). Nothing here
// fetches or peeks at future data, and nothing here is re-scored
// retroactively.
// =============================================================
import { emaSeries, awesomeOscillator, atr, closes, clamp } from '../indicators.js';
import { HTF_CONFLUENCE_TYPE, sanitizeHtfConfluenceConfig } from './config.js';
import {
  aggregateCandles, aggregateH1ToH4, findZones,
  nearestInteractingZone, nearestOpposingLevel,
} from './structure.js';

// How close price needs to be to a zone to count as "interacting with"
// it, as a % of price.
const ZONE_PROXIMITY_PCT = 0.5;

// EMA50-vs-EMA100 trend read for a higher timeframe. Only used to
// check alignment with the 5M crossover direction (the trend filter)
// — it never invents a direction of its own on these timeframes, and
// a NEUTRAL/unavailable read simply fails alignment rather than being
// treated as agreement.
function emaTrend(candles, fastPeriod, slowPeriod){
  if(!candles || candles.length < 5) return null;
  const c = closes(candles);
  const fastNow = emaSeries(c, fastPeriod).pop();
  const slowNow = emaSeries(c, slowPeriod).pop();
  if(fastNow == null || slowNow == null) return null;
  if(fastNow > slowNow) return 'BULLISH';
  if(fastNow < slowNow) return 'BEARISH';
  return 'NEUTRAL';
}

export function detectHtfConfluence(snap, regime, ctxIn){
  const ctx = sanitizeHtfConfluenceConfig(ctxIn);
  const h1 = snap.h1, m15 = snap.m15, m5 = snap.m5;
  if(!h1 || !m15 || !m5) return null;
  if(h1.length < 20 || m15.length < Math.max(ctx.emaSlow + 5, 30) || m5.length < Math.max(ctx.emaSlow + 5, 60)) return null; // not enough history yet — quiet, same as every other detector's own warmup check

  // ---- 5M EMA 50/100 crossover (the only entry trigger) ----
  const closes5 = closes(m5);
  const emaFastSeries = emaSeries(closes5, ctx.emaFast);
  const emaSlowSeries = emaSeries(closes5, ctx.emaSlow);
  const emaFastNow = emaFastSeries[emaFastSeries.length - 1], emaFastPrev = emaFastSeries[emaFastSeries.length - 2];
  const emaSlowNow = emaSlowSeries[emaSlowSeries.length - 1], emaSlowPrev = emaSlowSeries[emaSlowSeries.length - 2];
  const crossedUp = emaFastPrev < emaSlowPrev && emaFastNow >= emaSlowNow;
  const crossedDown = emaFastPrev > emaSlowPrev && emaFastNow <= emaSlowNow;
  if(!crossedUp && !crossedDown) return null; // no fresh crossover this bar — quiet, nothing to see
  const direction = crossedUp ? 'LONG' : 'SHORT';

  // ---- Awesome Oscillator must already agree with the crossover ----
  const ao = awesomeOscillator(m5);
  const aoNow = ao.values[ao.values.length - 1];
  if(aoNow == null || (direction === 'LONG' ? aoNow <= 0 : aoNow >= 0)){
    return { type: HTF_CONFLUENCE_TYPE, vetoes: [direction === 'LONG' ? 'EMA crossed up but AO is not above the zero line' : 'EMA crossed down but AO is not below the zero line'] };
  }

  // ---- Trend filter: 15M + 30M + 1H must all agree with the crossover ----
  const m30 = aggregateCandles(m15, 2);
  const trend15 = emaTrend(m15, ctx.emaFast, ctx.emaSlow);
  const trend30 = m30.length ? emaTrend(m30, ctx.emaFast, ctx.emaSlow) : null;
  const trend1h = emaTrend(h1, ctx.emaFast, ctx.emaSlow);
  const wantTrend = direction === 'LONG' ? 'BULLISH' : 'BEARISH';
  const trend15Ok = trend15 === wantTrend, trend30Ok = trend30 === wantTrend, trend1hOk = trend1h === wantTrend;
  if(!(trend15Ok && trend30Ok && trend1hOk)){
    return {
      type: HTF_CONFLUENCE_TYPE,
      vetoes: [`5M ${direction === 'LONG' ? 'bullish' : 'bearish'} crossover not confirmed by higher timeframes (15M ${trend15 || 'N/A'}, 30M ${trend30 || 'N/A'}, 1H ${trend1h || 'N/A'})`],
    };
  }

  // ---- Valid HTF supply/demand level ----
  const price = snap.price;
  const h4 = aggregateH1ToH4(h1);
  const zones4h = h4.length >= 10 ? findZones(h4, direction, { maxAgeBars: ctx.maxZoneAgeBars4h }) : [];
  const zones1h = findZones(h1, direction, { maxAgeBars: ctx.maxZoneAgeBars1h });
  const zone = nearestInteractingZone(zones4h, price, ZONE_PROXIMITY_PCT) || nearestInteractingZone(zones1h, price, ZONE_PROXIMITY_PCT);
  if(!zone){
    return { type: HTF_CONFLUENCE_TYPE, vetoes: [direction === 'LONG' ? 'No valid HTF demand level at current price' : 'No valid HTF supply level at current price'] };
  }

  // ---- Confluence score (0-100) ----
  // The crossover, AO and trend-filter lines are all hard gates above
  // — always PASS by the time scoring runs, same for the zone itself.
  // Price action and zone freshness are the only genuinely scored
  // (not hard-gated) factors, same "can fail individually without
  // killing the trade, as long as the total clears the threshold"
  // idea as before.
  const atr5 = atr(m5, 14);
  const atrPct5 = atr5 ? (atr5 / price) * 100 : 0.3;
  const last = m5[m5.length - 1];
  const priceActionOk = direction === 'LONG' ? last.c > last.o : last.c < last.o;
  const freshnessOk = zone.freshness >= 0.5;
  const breakdown = [
    { label: `EMA ${ctx.emaFast}/${ctx.emaSlow} Crossover`, pass: true, points: 25 },
    { label: direction === 'LONG' ? 'AO > 0' : 'AO < 0', pass: true, points: 20 },
    { label: direction === 'LONG' ? 'Demand Level' : 'Supply Level', pass: true, points: 20 },
    { label: '15M Trend Aligned', pass: true, points: 10 },
    { label: '30M Trend Aligned', pass: true, points: 10 },
    { label: '1H Trend Aligned', pass: true, points: 10 },
    { label: 'Price Action', pass: priceActionOk, points: priceActionOk ? 3 : 0 },
    { label: 'Zone Freshness', pass: freshnessOk, points: freshnessOk ? 2 : 0 },
  ];
  const score = breakdown.reduce((a, b) => a + b.points, 0);
  const minScore = ctx.highSelectivity ? ctx.minConfluenceScoreHighSelectivity : ctx.minConfluenceScore;
  if(score < minScore){
    return { type: HTF_CONFLUENCE_TYPE, vetoes: [`Confluence score ${score}/100 below required ${minScore}`] };
  }

  // ---- Structure-based stop, ATR-buffered ----
  const structureEdge = direction === 'LONG' ? zone.low : zone.high;
  const bufferPct = Math.max(ctx.structureBufferPct, atrPct5 * ctx.atrBufferMultiplier);
  const stopPrice = direction === 'LONG'
    ? structureEdge * (1 - bufferPct / 100)
    : structureEdge * (1 + bufferPct / 100);
  const stopDistancePct = Math.abs((price - stopPrice) / price) * 100;
  if(!(stopDistancePct > 0)){
    return { type: HTF_CONFLUENCE_TYPE, vetoes: ['Stop distance could not be calculated from the available structure'] };
  }

  // ---- Structure-aware target -> implied R, never below minRewardRisk ----
  const opposingZones = findZones(h1, direction === 'LONG' ? 'SHORT' : 'LONG', { maxAgeBars: ctx.maxZoneAgeBars1h });
  const targetPrice = nearestOpposingLevel(direction, price, opposingZones);
  const impliedR = targetPrice != null ? (Math.abs((targetPrice - price) / price) * 100) / stopDistancePct : null;
  if(targetPrice == null || impliedR == null || impliedR < ctx.minRewardRisk * 0.6){
    // No realistic opposing level at all, or the nearest one is so
    // close the trade can't plausibly reach even 60% of the minimum R —
    // reject rather than fabricate a target the structure doesn't
    // support.
    return { type: HTF_CONFLUENCE_TYPE, vetoes: ['No realistic HTF target with sufficient risk/reward'] };
  }
  const targetR = Math.max(ctx.minRewardRisk, impliedR);

  const reasons = [
    `EMA ${ctx.emaFast}/${ctx.emaSlow} crossed ${direction === 'LONG' ? 'up' : 'down'} on the 5M`,
    `AO ${aoNow.toFixed(4)} (${direction === 'LONG' ? 'above' : 'below'} zero)`,
    `15M/30M/1H trend all ${wantTrend.toLowerCase()} (${trend15}/${trend30}/${trend1h})`,
    `${direction === 'LONG' ? 'Demand' : 'Supply'} level (freshness ${(zone.freshness * 100).toFixed(0)}%, ${zone.touches} prior touch${zone.touches === 1 ? '' : 'es'})`,
    `Confluence score ${score}/100 (min ${minScore})`,
  ];

  return {
    type: HTF_CONFLUENCE_TYPE, direction, rawConfidence: clamp(score, 0, 99), reasons,
    meta: {
      score, breakdown, minScoreUsed: minScore,
      trend15, trend30, trend1h,
      zone: { high: zone.high, low: zone.low, freshness: zone.freshness, touches: zone.touches, ageBars: zone.ageBars },
      ema50: emaFastNow, ema100: emaSlowNow, emaFastPeriod: ctx.emaFast, emaSlowPeriod: ctx.emaSlow,
      aoValue: aoNow,
      stopPrice, stopDistancePct, targetPrice, targetR, atrPct: atrPct5,
      timeStopMinutes: ctx.timeStopMinutes, candleTime: last.t,
    },
  };
}
