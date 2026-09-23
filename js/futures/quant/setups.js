// =============================================================
// quant/setups.js — the NxTGen HTF OrderFlow setup detector.
//
// Replaces the old four-setup (A-D) Quant Futures detector with the single
// setup the spec describes: LOCATION FIRST (validated HTF supply/demand +
// order-block confluence across 30M/1H/4H) -> HTF TREND ALIGNMENT (4H and
// 1H must agree) -> 5M CONFIRMATION (mechanical Parabolic SAR / EMA50-100
// crossover + Awesome Oscillator threshold, both on CLOSED candles only) ->
// EXECUTION. A bare indicator cross with no valid HTF zone underneath it is
// never a signal on its own — see the "entry location filter" gate below.
//
// Every hard condition REJECTS outright (returns { ok:false, reason }); the
// only exports kept are `SETUP_DETECTORS` (used by signal.js exactly like
// the old A-D map, but now with a single 'A' key) and the detector itself.
// =============================================================
import { clamp, mean, nearestZone, zonesOverlap } from './features.js';

const rej = (msg) => ({ ok: false, setup: 'A', reason: `HTF OrderFlow: ${msg}` });
const fmt = (x, d = 2) => Number(x).toFixed(d);

// PSAR-vs-EMA(fast/slow) band side at bar k. 'above' = PSAR sitting above the whole band, 'below' = PSAR
// sitting under the whole band, null = PSAR inside the band (ambiguous — not a clean read either way).
function bandSide(f, k){
  if(f.psar[k] == null || f.ema50[k] == null || f.ema100[k] == null) return null;
  const hi = Math.max(f.ema50[k], f.ema100[k]), lo = Math.min(f.ema50[k], f.ema100[k]);
  if(f.psar[k] > hi) return 'above';
  if(f.psar[k] < lo) return 'below';
  return null;
}

export function detectHtfOrderFlow(f, reg, dir, qcfg){
  const s = dir === 'LONG' ? 1 : -1;
  const evidence = [];
  const chk = (ok, text) => { evidence.push(`${ok ? '[+]' : '[-]'} ${text}`); return ok; };

  // ---- STEP 1 — 4H TREND FILTER ----
  if(f.tfH4.dir !== s) return rej(`4H trend is ${f.tfH4.dir === 0 ? 'unclear' : 'opposite'} — no trade`);
  chk(true, `4H trend: ${s === 1 ? 'Bullish' : 'Bearish'} (${f.tfH4.structure} structure)`);

  // ---- STEP 2 — 1H TREND ALIGNMENT ----
  if(f.tfH1.dir !== s) return rej('1H trend does not agree with 4H — no trade');
  chk(true, `1H trend: ${s === 1 ? 'Bullish' : 'Bearish'} (${f.tfH1.structure} structure), agrees with 4H`);

  // ---- STEP 3 — 30M SUPPLY/DEMAND, must not be strongly opposed ----
  if(f.tfM30.dir === -s) return rej('30M structure is strongly against the trade direction');
  chk(true, `30M structure: ${f.tfM30.dir === s ? 'aligned' : 'neutral'} (not opposing)`);

  // ---- Validated 30M zone (LOCATION FIRST) ----
  const zoneType = s === 1 ? 'demand' : 'supply';
  const zone30 = nearestZone(f.zones30, zoneType, f.price, s);
  if(!zone30) return rej(`no validated 30M ${zoneType} zone near price — not chasing indicator signals in open air`);
  chk(true, `30M ${zoneType} zone validated (${zone30.hasImbalance ? 'with imbalance/FVG' : 'displacement-based'}${zone30.hasBOS ? ', break of structure confirmed' : ''}, quality ${(zone30.strength * 100).toFixed(0)}%)`);

  // ---- HTF order-block confluence across 30M/1H/4H (ATR-scaled proximity tolerance) ----
  const tolH1 = qcfg.zoneToleranceAtr * f.tfH1.atr;
  const tolH4 = qcfg.zoneToleranceAtr * f.tfH4.atr;
  const h1Match = f.zonesH1.filter(z => z.type === zoneType).find(z => zonesOverlap(z, zone30, tolH1)) || null;
  const h4Match = f.zonesH4.filter(z => z.type === zoneType).find(z => zonesOverlap(z, zone30, tolH4)) || null;
  const confluenceCount = 1 + (h1Match ? 1 : 0) + (h4Match ? 1 : 0);
  if(h1Match) evidence.push(`[+] 1H ${zoneType} order block overlaps the 30M zone — multi-timeframe confluence`);
  if(h4Match) evidence.push(`[+] 4H ${zoneType} order block overlaps the 30M zone — HIGH-CONFLUENCE location`);
  if(!h1Match && !h4Match) evidence.push(`[.] No 1H/4H order block overlap at this zone (30M-only location — lower confluence)`);

  // ---- Entry-location filter / anti-chasing (ATR-based distance from the zone) ----
  const distFromZoneAtr = s === 1 ? Math.max(0, f.price - zone30.top) / f.atr : Math.max(0, zone30.bottom - f.price) / f.atr;
  if(distFromZoneAtr > qcfg.maxEntryAtr) return rej(`price is ${fmt(distFromZoneAtr)} ATR away from the ${zoneType} zone (max ${qcfg.maxEntryAtr}) — already extended, not chasing`);
  chk(true, `Entry near HTF ${zoneType} zone (${fmt(distFromZoneAtr)} ATR from the edge, max ${qcfg.maxEntryAtr})`);

  // ---- No major opposing entry-timeframe structure invalidation ----
  if(f.tfE.dir === -s && f.tfE.strength > 0.6) return rej('5M structure strongly opposes the trade — invalidation');

  // ---- STEP 7/8 — 5M PSAR/EMA mechanical crossover (CLOSED candles only, no unfinished-bar entries) ----
  // NOTE on direction: standard Parabolic SAR convention (and this same codebase's own existing "NxTGen
  // Scalp"/"Nova Scalp" PSAR-vs-EMA50/100 setups — js/futures/setups.js) has PSAR sit BELOW price/the band
  // during an uptrend and ABOVE it during a downtrend, matching the reference chart's own dotted PSAR line
  // (below candles while price climbs, above while it falls). A LONG confirmation is therefore PSAR flipping
  // from ABOVE the band to BELOW it (the mirror for SHORT) — not the literal "below-then-above" wording.
  const nowSide = bandSide(f, f.i), prevSide = bandSide(f, f.i - 1);
  const wantPrev = s === 1 ? 'above' : 'below', wantNow = s === 1 ? 'below' : 'above';
  if(nowSide == null || prevSide == null || prevSide !== wantPrev || nowSide !== wantNow){
    return rej(`no confirmed PSAR/EMA${qcfg.emaFast}-${qcfg.emaSlow} crossover on the last closed 5M candle (need PSAR to move from ${wantPrev} to ${wantNow} the EMA structure)`);
  }
  const emaOrderOk = s === 1 ? f.ema50v >= f.ema100v : f.ema50v <= f.ema100v;
  if(!emaOrderOk) return rej(`EMA${qcfg.emaFast}/EMA${qcfg.emaSlow} not aligned with the ${dir} crossover`);
  const emaStrict = s === 1 ? f.ema50v > f.ema100v : f.ema50v < f.ema100v;
  chk(true, `Parabolic SAR crossed ${wantPrev} -> ${wantNow} the EMA${qcfg.emaFast}/EMA${qcfg.emaSlow} structure on the last closed 5M candle`);
  chk(true, `EMA${qcfg.emaFast} ${emaStrict ? (s === 1 ? '>' : '<') : (s === 1 ? '>=' : '<=')} EMA${qcfg.emaSlow}`);

  // ---- STEP 9 — Awesome Oscillator confirmation ----
  const aoVal = qcfg.aoNormalized ? f.aoNorm[f.i] : f.ao;
  const aoPrev = qcfg.aoNormalized ? f.aoNorm[f.i - 1] : f.aoV[f.i - 1];
  if(aoVal == null) return rej('Awesome Oscillator unavailable');
  const aoOk = s === 1 ? aoVal > qcfg.aoLongThreshold : aoVal < qcfg.aoShortThreshold;
  if(!aoOk) return rej(`AO ${fmt(aoVal)} does not clear the ${s === 1 ? `+${qcfg.aoLongThreshold}` : qcfg.aoShortThreshold} threshold`);
  const aoMomentumOk = aoPrev != null && (s === 1 ? aoVal >= aoPrev : aoVal <= aoPrev);
  chk(true, `AO ${fmt(aoVal)} ${s === 1 ? '>' : '<'} ${s === 1 ? `+${qcfg.aoLongThreshold}` : qcfg.aoShortThreshold}${aoMomentumOk ? ` and ${s === 1 ? 'rising' : 'falling'}` : ''}`);

  // ---- Optional breakout/retest preference (bonus, never mandatory) ----
  const breakoutRetest = !!(zone30.hasBOS && zone30.hasImbalance);
  if(breakoutRetest) evidence.push('[+] Displacement -> structure break -> retest sequence present (preferred entry pattern)');

  // ---- Quality sub-scores (0..1), feed signal.js's weighted confluence score ----
  const psarDistAtr = Math.abs(f.psarV - (s === 1 ? Math.max(f.ema50v, f.ema100v) : Math.min(f.ema50v, f.ema100v))) / f.atr;
  const q = {
    h4: f.tfH4.strength,
    h1: f.tfH1.strength,
    m30: clamp(0.55 + 0.45 * (f.tfM30.dir === s ? f.tfM30.strength : 0.3), 0, 1),
    supplyDemand: zone30.strength,
    orderBlock: clamp(0.35 + 0.325 * (confluenceCount - 1), 0, 1), // 1 tf=0.35, 2 tf=0.675, 3 tf=1.0
    emaAlign: emaStrict ? 1 : 0.6,
    psar: clamp(0.4 + psarDistAtr / 0.6, 0, 1),
    ao: clamp(0.5 + (Math.abs(aoVal) - Math.abs(s === 1 ? qcfg.aoLongThreshold : qcfg.aoShortThreshold)) / (2 * Math.abs(s === 1 ? qcfg.aoLongThreshold : qcfg.aoShortThreshold)), 0, 1) * (aoMomentumOk ? 1 : 0.85),
    proximity: clamp(1 - distFromZoneAtr / Math.max(0.1, qcfg.maxEntryAtr), 0, 1),
  };

  return {
    ok: true, setup: 'A', name: 'HTF OrderFlow', dir, s,
    zone: zone30, h1Match, h4Match, confluenceCount, breakoutRetest,
    distFromZoneAtr, q, evidence,
    flags: { psarCross: true, emaAligned: true, aoConfirm: true, breakoutRetest, htfConfluence: confluenceCount > 1 },
  };
}

export const SETUP_DETECTORS = { A: detectHtfOrderFlow };
