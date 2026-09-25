// =============================================================
// htfConfluence/structure.js — market structure, supply/demand zone
// and order-block detection shared by the "NxTGen HTF Confluence"
// signal (signal.js). Pure functions: candles in, structure out — no
// state, no network, same discipline as indicators.js.
//
// ANTI-LOOKAHEAD / ANTI-REPAINTING: every function here only ever
// reads candles the caller already considers closed (the same
// "candlesClosed" contract every other strategy in this codebase
// relies on — see mockMarket.js/backtest.js). aggregateH1ToH4 refuses
// to build a 4H candle from fewer than 4 closed H1 bars — it drops the
// oldest leftover bars rather than pad or use a partial/forming group.
// The swing-point detector (indicators.js's swingHighPoints/
// swingLowPoints) requires `right` confirmed bars AFTER a candidate
// swing before counting it, so the most recent `right` bars on any
// timeframe can never produce a "confirmed" swing yet — exactly as
// they shouldn't, since a swing isn't structurally real until price
// has moved away from it. Nothing here ever looks at a bar that hasn't
// closed, and nothing here is re-evaluated retroactively once a later
// bar arrives — nowhere is that would change a PAST signal.
// =============================================================
import { swingHighPoints, swingLowPoints, atr, clamp } from '../indicators.js';

// Groups H1 candles into 4H candles. Only whole groups of 4 closed H1
// bars are used — if the H1 array isn't a multiple of 4, the OLDEST
// leftover bars are dropped (never the newest, which would mean
// building the most recent 4H candle out of an incomplete/forming
// group of H1 bars).
export function aggregateH1ToH4(h1){
  const n = h1.length;
  const usable = n - (n % 4);
  if(usable < 4) return [];
  const out = [];
  for(let i = n - usable; i < n; i += 4){
    const grp = h1.slice(i, i + 4);
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

export const HTF_BIAS = {
  STRONG_BULLISH: 'STRONG_BULLISH', BULLISH: 'BULLISH', NEUTRAL: 'NEUTRAL',
  BEARISH: 'BEARISH', STRONG_BEARISH: 'STRONG_BEARISH',
};
export const BULLISH_BIAS = new Set([HTF_BIAS.STRONG_BULLISH, HTF_BIAS.BULLISH]);
export const BEARISH_BIAS = new Set([HTF_BIAS.STRONG_BEARISH, HTF_BIAS.BEARISH]);

// Confirmed-fractal market structure: compares the last two confirmed
// swing highs and the last two confirmed swing lows. Both making a
// higher high AND a higher low = STRONG_BULLISH; only one of the two =
// BULLISH; the mirror for bearish; anything else (including too little
// confirmed swing history to tell) = NEUTRAL. Callers must never trade
// a NEUTRAL bias — see signal.js.
//
// KNOWN DATA CONSTRAINT: the platform's snapshot only ever carries 60
// H1 candles (see mockMarket.js/backtest.js/liveEngine.js — every
// strategy's H1 read is capped there, not just this one), which
// aggregates to just ~15 4H candles (aggregateH1ToH4 above). A 2-3 bar
// fractal (left=right=2) genuinely needs more room than that to
// confirm a swing reliably, especially on the 4H series — so a pure
// fractal read on 4H data will often come back NEUTRAL purely from a
// short window, not because the trend is actually unclear. Rather than
// silently starve the 4H read (the strategy's PRIMARY bias) whenever
// that happens, this falls back to a coarser but still fully
// deterministic and still anti-lookahead method — comparing the range
// of the second half of the window against the first half — only when
// the fractal method itself found too few confirmed swings to render a
// verdict. A genuine fractal disagreement (mixed HH/LL) is NEVER
// overridden by the fallback; only "not enough data to tell" is.
export function classifyStructure(candles, opts){
  const left = (opts && opts.left) || 2, right = (opts && opts.right) || 2;
  if(candles.length < left + right + 6) return { bias: HTF_BIAS.NEUTRAL, highs: [], lows: [], method: 'insufficient' };
  const toIdx = candles.length - 1 - right;
  const highs = swingHighPoints(candles, 0, toIdx, left, right);
  const lows = swingLowPoints(candles, 0, toIdx, left, right);
  if(highs.length >= 2 && lows.length >= 2){
    const [prevHigh, lastHigh] = highs.slice(-2), [prevLow, lastLow] = lows.slice(-2);
    const higherHigh = lastHigh.price > prevHigh.price, higherLow = lastLow.price > prevLow.price;
    const lowerHigh = lastHigh.price < prevHigh.price, lowerLow = lastLow.price < prevLow.price;
    const bias = combineHighLow(higherHigh, higherLow, lowerHigh, lowerLow);
    if(bias !== HTF_BIAS.NEUTRAL) return { bias, highs, lows, lastHigh, lastLow, method: 'fractal' };
  }
  // Fallback: not enough confirmed fractal swings (or they genuinely
  // disagree) to call it from structure alone — compare the trading
  // range of the second half of the window to the first half. Still
  // reads only already-closed candles; just a coarser trend proxy than
  // true HH/HL, used only because the fractal method above couldn't
  // render a verdict from this short a window.
  const mid = Math.floor(candles.length / 2);
  const first = candles.slice(0, mid), second = candles.slice(mid);
  if(first.length < 3 || second.length < 3) return { bias: HTF_BIAS.NEUTRAL, highs, lows, method: 'insufficient' };
  const firstHigh = Math.max(...first.map(c => c.h)), secondHigh = Math.max(...second.map(c => c.h));
  const firstLow = Math.min(...first.map(c => c.l)), secondLow = Math.min(...second.map(c => c.l));
  const higherHigh = secondHigh > firstHigh, higherLow = secondLow > firstLow;
  const lowerHigh = secondHigh < firstHigh, lowerLow = secondLow < firstLow;
  const bias = combineHighLow(higherHigh, higherLow, lowerHigh, lowerLow);
  return { bias, highs, lows, method: 'range' };
}

function combineHighLow(higherHigh, higherLow, lowerHigh, lowerLow){
  if(higherHigh && higherLow) return HTF_BIAS.STRONG_BULLISH;
  if(higherHigh || higherLow) return HTF_BIAS.BULLISH;
  if(lowerHigh && lowerLow) return HTF_BIAS.STRONG_BEARISH;
  if(lowerHigh || lowerLow) return HTF_BIAS.BEARISH;
  return HTF_BIAS.NEUTRAL;
}

function atrPctAt(candles, i){
  // ATR computed only from bars up to and including bar i, as a % of
  // that bar's close — a local, anti-lookahead read that never touches
  // bars after i. Period is adaptive (up to 14, but never more than
  // what's actually available up to i) because the 4H series here is
  // only ~15 candles long (see aggregateH1ToH4's header comment) — a
  // fixed ATR(14) would never have enough bars until i=14, which is
  // past the end of most 4H arrays, silently disabling zone/order-block
  // detection on 4H entirely. A period below 3 is too noisy to trust,
  // so those bars simply aren't evaluated as zone candidates.
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
// factor in signal.js, matching the brief's "prefer fresh zones" over
// "require fresh zones").
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

// Order blocks: the LAST candle of the opposite color to a strong
// displacement, immediately before that displacement — the standard
// "last down candle before the up-move" (bullish OB) / "last up candle
// before the down-move" (bearish OB). Requires the same kind of
// minimum displacement as findZones, so an order block is never just
// an arbitrary candle.
export function findOrderBlocks(candles, direction, opts){
  const minDisplacementAtr = (opts && opts.minDisplacementAtr) || 1.3;
  const maxAgeBars = (opts && opts.maxAgeBars) || 40;
  const blocks = [];
  for(let i = 1; i < candles.length - 3; i++){
    const base = candles[i];
    const baseBullish = base.c >= base.o;
    if(direction === 'LONG' && baseBullish) continue; // bullish OB needs a bearish base candle
    if(direction === 'SHORT' && !baseBullish) continue; // bearish OB needs a bullish base candle
    const atrPct = atrPctAt(candles, i);
    if(!atrPct) continue;
    const impulse = candles.slice(i + 1, i + 4);
    const movePct = ((impulse[impulse.length - 1].c - base.c) / base.c) * 100;
    if(direction === 'LONG' && movePct < atrPct * minDisplacementAtr) continue;
    if(direction === 'SHORT' && -movePct < atrPct * minDisplacementAtr) continue;
    const ageBars = candles.length - 1 - i;
    if(ageBars > maxAgeBars) continue;
    blocks.push({ index: i, high: base.h, low: base.l, ageBars, displacementPct: Math.abs(movePct) });
  }
  return blocks.sort((a, b) => b.index - a.index); // most recent first
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

// Order block overlapping (or immediately adjacent to) a given zone —
// the "demand/supply zone supported by an order block" check. Scored,
// not required — see signal.js.
export function overlappingOrderBlock(blocks, zone, proximityPct){
  if(!zone) return null;
  for(const ob of blocks){
    const overlaps = ob.low <= zone.high && ob.high >= zone.low;
    if(overlaps) return ob;
    const dist = Math.min(Math.abs(ob.high - zone.low), Math.abs(zone.high - ob.low)) / zone.low * 100;
    if(dist <= proximityPct) return ob;
  }
  return null;
}

// Nearest opposing structure level beyond `price` in the trade
// direction — the realistic take-profit target. LONG looks for the
// nearest confirmed swing high / opposing (supply) zone ABOVE price;
// SHORT the nearest confirmed swing low / opposing (demand) zone BELOW
// price. Uses the opposing zone's NEAR edge (the first realistic
// reaction point), never its far edge, so the implied R:R is
// conservative rather than best-case.
export function nearestOpposingLevel(direction, price, swings, opposingZones){
  const candidates = [];
  for(const s of swings){
    if(direction === 'LONG' && s.price > price) candidates.push(s.price);
    if(direction === 'SHORT' && s.price < price) candidates.push(s.price);
  }
  for(const z of opposingZones){
    const level = direction === 'LONG' ? z.low : z.high;
    if(direction === 'LONG' && level > price) candidates.push(level);
    if(direction === 'SHORT' && level < price) candidates.push(level);
  }
  if(!candidates.length) return null;
  return direction === 'LONG' ? Math.min(...candidates) : Math.max(...candidates);
}
