// =============================================================
// htfConfluence/signal.js — the "NxTGen HTF Confluence" detector.
// 4H structure (primary bias) and 1H structure (confirmation) must
// agree; price must be interacting with a validated HTF demand/supply
// zone; a 5M EMA50/EMA100 + Parabolic SAR + Awesome Oscillator
// sequence confirms the entry; a deterministic 0-100 confluence score
// gates the trade. See STRATEGY_REGISTRY (setups.js) for how this
// plugs into the platform, and engine.js's evaluateHtfConfluenceRow
// for how the returned signal becomes an actual sized, gated trade
// (reusing the exact same cost/risk/no-trade-gate machinery every
// other strategy in this codebase uses).
//
// ANTI-LOOKAHEAD: only ever reads snap.h1/snap.m5 exactly as handed in
// by the caller (already-closed candles). Nothing here fetches or
// peeks at future data, and nothing here is re-scored retroactively.
//
// This targets a 65%+ win rate as a research goal, per the brief that
// commissioned it — that number is NOT hard-coded or fabricated
// anywhere in this file. Whether it's actually achieved is for the
// platform's own Backtest tab (real historical candles, real fees/
// slippage) to show, the same as every other strategy here.
// =============================================================
import { emaSeries, parabolicSar, awesomeOscillator, atr, closes, clamp } from '../indicators.js';
import { HTF_CONFLUENCE_TYPE, sanitizeHtfConfluenceConfig } from './config.js';
import {
  aggregateH1ToH4, classifyStructure, findZones, findOrderBlocks,
  nearestInteractingZone, overlappingOrderBlock, nearestOpposingLevel,
  BULLISH_BIAS, BEARISH_BIAS,
} from './structure.js';

// How close price needs to be to a zone/order block to count as
// "interacting with" it, as a % of price.
const ZONE_PROXIMITY_PCT = 0.5;

function psarRelation(psar, bandLow, bandHigh){
  if(psar == null || bandLow == null || bandHigh == null) return null;
  if(psar > bandHigh) return 'above';
  if(psar < bandLow) return 'below';
  return 'inside';
}

// Deterministic PSAR-vs-EMA-band confirmation — see config.js's
// PSAR_MODES for what each mode means.
function psarConfirmation(direction, prevRel, curRel, mode){
  if(curRel == null) return false;
  const target = direction === 'LONG' ? 'above' : 'below';
  const wrong = direction === 'LONG' ? 'below' : 'above';
  if(mode === 'STANDARD') return curRel === target;
  if(mode === 'EARLY') return curRel !== wrong;
  return prevRel === wrong && curRel === target; // STRICT (default): a genuine one-bar flip
}

export function detectHtfConfluence(snap, regime, ctxIn){
  const ctx = sanitizeHtfConfluenceConfig(ctxIn);
  const h1 = snap.h1, m5 = snap.m5;
  if(!h1 || !m5 || h1.length < 20 || m5.length < Math.max(ctx.emaSlow + 5, 60)) return null; // not enough history yet — quiet, same as every other detector's own warmup check

  const h4 = aggregateH1ToH4(h1);
  if(h4.length < 10) return null; // not enough 4H context yet — quiet

  const struct4h = classifyStructure(h4, { left: ctx.swingLeft, right: ctx.swingRight });
  const struct1h = classifyStructure(h1, { left: ctx.swingLeft, right: ctx.swingRight });

  const bull4h = BULLISH_BIAS.has(struct4h.bias), bear4h = BEARISH_BIAS.has(struct4h.bias);
  const bull1h = BULLISH_BIAS.has(struct1h.bias), bear1h = BEARISH_BIAS.has(struct1h.bias);

  let direction = null;
  if(bull4h && bull1h) direction = 'LONG';
  else if(bear4h && bear1h) direction = 'SHORT';

  if(!direction){
    // Only surfaced as a rejection when at least one HTF showed genuine
    // directional intent the other didn't confirm — plain NEUTRAL/
    // NEUTRAL is just "nothing going on right now" and isn't worth
    // logging as a near-miss every cycle.
    const hadIntent = struct4h.bias !== 'NEUTRAL' || struct1h.bias !== 'NEUTRAL';
    if(hadIntent) return { type: HTF_CONFLUENCE_TYPE, vetoes: [`4H (${struct4h.bias}) / 1H (${struct1h.bias}) trend mismatch or unclear structure`] };
    return null;
  }

  const price = snap.price;
  const atr5 = atr(m5, 14);
  const atrPct5 = atr5 ? (atr5 / price) * 100 : 0.3;

  const zones4h = findZones(h4, direction, { maxAgeBars: ctx.maxZoneAgeBars4h });
  const zones1h = findZones(h1, direction, { maxAgeBars: ctx.maxZoneAgeBars1h });
  const zone = nearestInteractingZone(zones4h, price, ZONE_PROXIMITY_PCT) || nearestInteractingZone(zones1h, price, ZONE_PROXIMITY_PCT);
  if(!zone){
    return { type: HTF_CONFLUENCE_TYPE, vetoes: [direction === 'LONG' ? 'No valid HTF demand zone at current price' : 'No valid HTF supply zone at current price'] };
  }

  const blocks4h = findOrderBlocks(h4, direction, { maxAgeBars: ctx.maxZoneAgeBars4h });
  const blocks1h = findOrderBlocks(h1, direction, { maxAgeBars: ctx.maxZoneAgeBars1h });
  const orderBlock = overlappingOrderBlock(blocks4h, zone, ZONE_PROXIMITY_PCT) || overlappingOrderBlock(blocks1h, zone, ZONE_PROXIMITY_PCT);

  // ---- 5M entry confirmation ----
  const closes5 = closes(m5);
  const emaFastSeries = emaSeries(closes5, ctx.emaFast);
  const emaSlowSeries = emaSeries(closes5, ctx.emaSlow);
  const emaFastNow = emaFastSeries[emaFastSeries.length - 1], emaFastPrev = emaFastSeries[emaFastSeries.length - 2];
  const emaSlowNow = emaSlowSeries[emaSlowSeries.length - 1], emaSlowPrev = emaSlowSeries[emaSlowSeries.length - 2];
  const emaAlignedNow = direction === 'LONG' ? emaFastNow >= emaSlowNow : emaFastNow <= emaSlowNow;
  const emaJustCrossed = direction === 'LONG'
    ? (emaFastPrev < emaSlowPrev && emaFastNow >= emaSlowNow)
    : (emaFastPrev > emaSlowPrev && emaFastNow <= emaSlowNow);
  if(!(emaAlignedNow || emaJustCrossed)){
    return { type: HTF_CONFLUENCE_TYPE, vetoes: ['EMA 50/100 not aligned'] };
  }

  const psarSeries = parabolicSar(m5, ctx.psarStep, ctx.psarMaxStep);
  const psarNow = psarSeries[psarSeries.length - 1], psarPrev = psarSeries[psarSeries.length - 2];
  const relNow = psarRelation(psarNow, Math.min(emaFastNow, emaSlowNow), Math.max(emaFastNow, emaSlowNow));
  const relPrev = psarRelation(psarPrev, Math.min(emaFastPrev, emaSlowPrev), Math.max(emaFastPrev, emaSlowPrev));
  if(!psarConfirmation(direction, relPrev, relNow, ctx.psarConfirmationMode)){
    return { type: HTF_CONFLUENCE_TYPE, vetoes: ['PSAR confirmation missing'] };
  }

  const ao = awesomeOscillator(m5);
  const aoNow = ao.values[ao.values.length - 1];
  if(aoNow == null || (direction === 'LONG' ? aoNow <= 0 : aoNow >= 0)){
    return { type: HTF_CONFLUENCE_TYPE, vetoes: [direction === 'LONG' ? 'AO below zero' : 'AO above zero'] };
  }

  // ---- Confluence score (0-100) ----
  // The two HTF-alignment lines, the zone-validity line, the EMA line,
  // the PSAR line and the AO line are all hard gates above — they are
  // always PASS by the time scoring runs. Order-block confluence, 5M
  // price action and zone freshness are NOT hard gates (the brief says
  // a zone "should preferably" have an order block behind it) — they
  // can each fail individually and the trade can still fire, as long
  // as the total clears the threshold. This mirrors the brief's own
  // worked example: every hard gate passes, freshness alone fails, and
  // the signal still fires at 95/100.
  const last = m5[m5.length - 1];
  const priceActionOk = direction === 'LONG' ? last.c > last.o : last.c < last.o;
  const freshnessOk = zone.freshness >= 0.5;
  const breakdown = [
    { label: `HTF 4H ${direction === 'LONG' ? 'Bullish' : 'Bearish'}`, pass: true, points: 15 },
    { label: `HTF 1H ${direction === 'LONG' ? 'Bullish' : 'Bearish'}`, pass: true, points: 15 },
    { label: direction === 'LONG' ? 'Demand Zone' : 'Supply Zone', pass: true, points: 15 },
    { label: direction === 'LONG' ? 'Bullish Order Block' : 'Bearish Order Block', pass: !!orderBlock, points: orderBlock ? 15 : 0 },
    { label: `EMA ${ctx.emaFast}/${ctx.emaSlow}`, pass: true, points: 10 },
    { label: 'PSAR Confirmation', pass: true, points: 10 },
    { label: direction === 'LONG' ? 'AO > 0' : 'AO < 0', pass: true, points: 10 },
    { label: 'Price Action', pass: priceActionOk, points: priceActionOk ? 5 : 0 },
    { label: 'Zone Freshness', pass: freshnessOk, points: freshnessOk ? 5 : 0 },
  ];
  const score = breakdown.reduce((a, b) => a + b.points, 0);
  const minScore = ctx.highSelectivity ? ctx.minConfluenceScoreHighSelectivity : ctx.minConfluenceScore;
  if(score < minScore){
    return { type: HTF_CONFLUENCE_TYPE, vetoes: [`Confluence score ${score}/100 below required ${minScore}`] };
  }

  // ---- Structure-based stop, ATR-buffered ----
  const structureEdge = orderBlock
    ? (direction === 'LONG' ? Math.min(zone.low, orderBlock.low) : Math.max(zone.high, orderBlock.high))
    : (direction === 'LONG' ? zone.low : zone.high);
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
  const opposingSwings = direction === 'LONG' ? struct1h.highs : struct1h.lows;
  const targetPrice = nearestOpposingLevel(direction, price, opposingSwings, opposingZones);
  const impliedR = targetPrice != null ? (Math.abs((targetPrice - price) / price) * 100) / stopDistancePct : null;
  if(targetPrice == null || impliedR == null || impliedR < ctx.minRewardRisk * 0.6){
    // No realistic opposing structure at all, or the nearest one is so
    // close the trade can't plausibly reach even 60% of the minimum R —
    // reject rather than fabricate a target the structure doesn't
    // support.
    return { type: HTF_CONFLUENCE_TYPE, vetoes: ['No realistic HTF target with sufficient risk/reward'] };
  }
  const targetR = Math.max(ctx.minRewardRisk, impliedR);

  const reasons = [
    `4H structure: ${struct4h.bias}`, `1H structure: ${struct1h.bias}`,
    `${direction === 'LONG' ? 'Demand' : 'Supply'} zone (freshness ${(zone.freshness * 100).toFixed(0)}%, ${zone.touches} prior touch${zone.touches === 1 ? '' : 'es'})`,
    orderBlock ? `${direction === 'LONG' ? 'Bullish' : 'Bearish'} order block confluence` : 'No order block confluence (scored, not required)',
    `EMA ${ctx.emaFast}/${ctx.emaSlow} ${emaJustCrossed ? 'crossed' : 'aligned'} ${direction === 'LONG' ? 'bullish' : 'bearish'}`,
    `PSAR ${ctx.psarConfirmationMode.toLowerCase()} confirmation`,
    `AO ${aoNow.toFixed(4)} (${direction === 'LONG' ? 'above' : 'below'} zero)`,
    `Confluence score ${score}/100 (min ${minScore})`,
  ];

  return {
    type: HTF_CONFLUENCE_TYPE, direction, rawConfidence: clamp(score, 0, 99), reasons,
    meta: {
      score, breakdown, minScoreUsed: minScore,
      bias4h: struct4h.bias, bias1h: struct1h.bias,
      zone: { high: zone.high, low: zone.low, freshness: zone.freshness, touches: zone.touches, ageBars: zone.ageBars },
      orderBlock: orderBlock ? { high: orderBlock.high, low: orderBlock.low, ageBars: orderBlock.ageBars } : null,
      ema50: emaFastNow, ema100: emaSlowNow, emaFastPeriod: ctx.emaFast, emaSlowPeriod: ctx.emaSlow,
      psar: psarNow, psarRelation: relNow, psarMode: ctx.psarConfirmationMode, aoValue: aoNow,
      stopPrice, stopDistancePct, targetPrice, targetR, atrPct: atrPct5,
      timeStopMinutes: ctx.timeStopMinutes, candleTime: last.t,
    },
  };
}
