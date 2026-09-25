// =============================================================
// htfConfluence/structure.js — candle aggregation and supply/demand
// zone detection shared by the "NxTGen HTF Confluence" signal
// (signal.js). Pure functions: candles in, structure out — no state,
// no network, same discipline as indicators.js.
//
// Per the strategy's current brief, this file deliberately does NOT
// do order-block detection or swing-fractal HH/HL bias classification
// any more — direction now comes from the 5M EMA50/EMA100 crossover
// (signal.js), confirmed by a higher-timeframe EMA trend filter, not
// from structure here. What's left is just: aggregate candles into a
// coarser timeframe, and find valid supply/demand levels.
//
// ANTI-LOOKAHEAD / ANTI-REPAINTING: every function here only ever
// reads candles the caller already considers closed (the same
// "candlesClosed" contract every other strategy in this codebase
// relies on — see mockMarket.js/backtest.js). aggregateCandles refuses
// to build a candle from fewer than `groupSize` closed source bars —
// it drops the oldest leftover bars rather than pad or use a
// partial/forming group. Nothing here ever looks at a bar that hasn't
// closed, and nothing here is re-evaluated retroactively once a later
// bar arrives.
// =============================================================
import { clamp, atr } from '../indicators.js';

// Groups `groupSize` consecutive candles into one coarser candle. Only
// whole groups of closed source bars are used — if the source array
// isn't an exact multiple of groupSize, the OLDEST leftover bars are
// dropped (never the newest, which would mean building the most
// recent aggregated candle out of an incomplete/forming group).
export function aggregateCandles(candles, groupSize){
  const n = candles.length;
  const usable = n - (n % groupSize);
  if(usable < groupSize) return [];
  const out = [];
  for(let i = n - usable; i < n; i += groupSize){
    const grp = candles.slice(i, i + groupSize);
    out.push({
      t: grp[grp.length - 1].t,
      o: grp[0].o,
      h: Math.max(...grp.map(c => c.h)),
      l: Math.min(...grp.map(c => c.l)),
      c: grp[grp.length - 1].c,
      v: grp.reduce((a, c) => a + c.v, 0),
    });
  }
  return out;
}

// 4H from H1 — the platform doesn't fetch a native 4H feed, so the
// zone detector below runs on this aggregate instead. Kept as its own
// named export (rather than inlining aggregateCandles(h1, 4)
// everywhere) since it's the one aggregation signal.js actually needs
// beyond the 30M-from-15M one it does itself.
export function aggregateH1ToH4(h1){
  return aggregateCandles(h1, 4);
}

function atrPctAt(candles, i){
  // ATR computed only from bars up to and including bar i, as a % of
  // that bar's close — a local, anti-lookahead read that never touches
  // bars after i. Period is adaptive (up to 14, but never more than
  // what's actually available up to i) because the 4H series here is
  // only ~15 candles long (60 H1 bars / 4 — see aggregateH1ToH4 above)
  // — a fixed ATR(14) would never have enough bars until i=14, which is
  // past the end of most 4H arrays, silently disabling zone detection
  // on 4H entirely. A period below 3 is too noisy to trust, so those
  // bars simply aren't evaluated as zone candidates.
  const period = Math.min(14, i);
  if(period < 3) return null;
  const a = atr(candles.slice(0, i + 1), period);
  return a && candles[i].c ? (a / candles[i].c) * 100 : null;
}

// Validated demand ('LONG') or supply ('SHORT') zones: the base candle
// immediately before a displacement move at least `minDisplacementAtr`
// x ATR(14) away from it, in the required direction — so a zone is
// never just an arbitrary swing point, only one the market actually
// left with force. Freshness (0-1) penalizes prior touches and age;
// this never hard-excludes a zone on its own (freshness is a SCORED
// factor in signal.js).
export function findZones(candles, direction, opts){
  const minDisplacementAtr = (opts && opts.minDisplacementAtr) || 1.1;
  const maxAgeBars = (opts && opts.maxAgeBars) || 40;
  const zones = [];
  for(let i = 1; i < candles.length - 3; i++){
    const base = candles[i];
    const atrPct = atrPctAt(candles, i);
    if(!atrPct) continue;
    const impulse = candles.slice(i + 1, i + 4); // up to 3 bars of displacement away from the base
    const movePct = ((impulse[impulse.length - 1].c - base.c) / base.c) * 100;
    const bullish = movePct > 0;
    if(direction === 'LONG' && !bullish) continue;
    if(direction === 'SHORT' && bullish) continue;
    if(Math.abs(movePct) < atrPct * minDisplacementAtr) continue; // not real displacement — just noise

    const bodyHigh = Math.max(base.o, base.c), bodyLow = Math.min(base.o, base.c);
    // Zone edges follow the standard demand/supply convention: the
    // wick-side edge is the invalidation line (full range — real
    // liquidity sits there), the body-side edge is where price is
    // considered to have "entered" the zone.
    const zoneLow = direction === 'LONG' ? base.l : bodyLow;
    const zoneHigh = direction === 'LONG' ? bodyHigh : base.h;

    let touches = 0;
    for(let j = i + 4; j < candles.length; j++){
      if(candles[j].l <= zoneHigh && candles[j].h >= zoneLow) touches++;
    }
    const ageBars = candles.length - 1 - i;
    if(ageBars > maxAgeBars) continue;
    const freshness = clamp(1 - touches * 0.25 - (ageBars / maxAgeBars) * 0.5, 0, 1);
    zones.push({ index: i, high: zoneHigh, low: zoneLow, ageBars, touches, freshness, displacementPct: Math.abs(movePct) });
  }
  return zones.sort((a, b) => b.index - a.index); // most recent first
}

// Nearest zone of the given type that price is currently inside, or
// within `proximityPct` (% of price) of — this is the "price is
// interacting with a valid HTF zone" check.
export function nearestInteractingZone(zones, price, proximityPct){
  let best = null, bestDist = Infinity;
  for(const z of zones){
    const inside = price <= z.high && price >= z.low;
    const dist = inside ? 0 : Math.min(Math.abs(price - z.high), Math.abs(price - z.low)) / price * 100;
    if(dist <= proximityPct && dist < bestDist){ best = z; bestDist = dist; }
  }
  return best;
}

// Nearest opposing supply/demand zone beyond `price` in the trade
// direction — the realistic take-profit target. LONG looks for the
// nearest opposing (supply) zone ABOVE price; SHORT the nearest
// opposing (demand) zone BELOW price. Uses the opposing zone's NEAR
// edge (the first realistic reaction point), never its far edge, so
// the implied R:R is conservative rather than best-case.
export function nearestOpposingLevel(direction, price, opposingZones){
  const candidates = [];
  for(const z of opposingZones){
    const level = direction === 'LONG' ? z.low : z.high;
    if(direction === 'LONG' && level > price) candidates.push(level);
    if(direction === 'SHORT' && level < price) candidates.push(level);
  }
  if(!candidates.length) return null;
  return direction === 'LONG' ? Math.min(...candidates) : Math.max(...candidates);
}
