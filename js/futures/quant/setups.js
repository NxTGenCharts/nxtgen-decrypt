// =============================================================
// quant/setups.js — the four Quant Futures setup detectors.
//
//   A  Trend Pullback           with the 1H/4H trend, buy/sell the dip into value
//   B  Breakout + Retest        compression -> volume breakout -> retest holds
//   C  Liquidity Sweep Reversal stop-run beyond a swing, reclaim, structure shift
//   D  Range Extremes           range regime only, statistically significant edge
//
// Every detector is a pure function of the feature object (features.js) and
// the regime (regime.js) and returns either
//   { ok:false, reason }                        — why nothing fired
//   { ok:true, setup, name, dir, anchor, ... }  — a CANDIDATE
// A candidate is not a trade: signal.js still builds the stop, target and
// score and applies every filter. Hard conditions REJECT (return ok:false);
// softer qualities are returned in `q` (0..1) and feed the score instead.
// Each detector takes `dir` ('LONG'|'SHORT') and evaluates only that side;
// the short side is the exact mirror via s = +1/-1.
// =============================================================
import { candleStats, mean, clamp } from './features.js';
import { QREGIMES } from './regime.js';

const rej = (setup, msg) => ({ ok: false, setup, reason: `${setup}: ${msg}` });
const fmt = (x, d = 2) => Number(x).toFixed(d);

// ---------------- Setup A — Trend Pullback ----------------
export function detectTrendPullback(f, reg, dir){
  const s = dir === 'LONG' ? 1 : -1;
  const { E, i, last, prev, atr } = f;
  if(reg.bias !== s) return rej('A', 'higher-timeframe (4H/1H) trend is not aligned with this direction');
  if(!(s * (f.emaFv - f.emaSv) > 0 && s * f.emaSlopeAtr > 0)) return rej('A', 'entry-timeframe EMA21/EMA55 not aligned with the trend');

  // The pullback: the extreme of the last 10 bars must have reached the value area.
  const W = 10;
  const base = i - W;
  const seg = E.slice(base, i + 1);
  let extIdx = 0;
  for(let k = 1; k < seg.length; k++){
    if(s === 1 ? seg[k].l < seg[extIdx].l : seg[k].h > seg[extIdx].h) extIdx = k;
  }
  const gi = base + extIdx;                       // global index of the pullback extreme
  const extreme = s === 1 ? E[gi].l : E[gi].h;
  const emaFatExt = f.emaF[gi], emaSatExt = f.emaS[gi];
  const reachedValue = s === 1 ? extreme <= emaFatExt + 0.25 * atr : extreme >= emaFatExt - 0.25 * atr;
  if(!reachedValue) return rej('A', 'price has not pulled back into the EMA21/EMA55 value area');
  const heldSlow = s === 1 ? extreme >= emaSatExt - 0.6 * atr : extreme <= emaSatExt + 0.6 * atr;
  if(!heldSlow) return rej('A', 'pullback pushed through the slow EMA — trend structure at risk');
  if(gi >= i) return rej('A', 'pullback extreme is the current candle — no recovery yet');

  // Depth measured from the impulse extreme that preceded the pullback.
  const impFrom = Math.max(0, gi - 25);
  let impulse = s === 1 ? -Infinity : Infinity, impIdx = impFrom;
  for(let k = impFrom; k <= gi; k++){
    if(s === 1 ? E[k].h > impulse : E[k].l < impulse){ impulse = s === 1 ? E[k].h : E[k].l; impIdx = k; }
  }
  const depth = s * (impulse - extreme) / atr;
  if(depth < 0.8) return rej('A', `pullback too shallow (${fmt(depth)} ATR) — no real retracement`);
  if(depth > 3.5) return rej('A', `pullback too deep (${fmt(depth)} ATR) — continuation odds degrade`);

  // Structure intact: the pullback may retrace part of the last impulse leg, never (nearly) all of it.
  // Measured against the leg's own origin rather than the most recent minor fractal, which noise undercuts constantly.
  let legOrigin = s === 1 ? Infinity : -Infinity;
  for(let k = Math.max(0, impIdx - 20); k <= impIdx; k++) legOrigin = s === 1 ? Math.min(legOrigin, E[k].l) : Math.max(legOrigin, E[k].h);
  const legSize = s * (impulse - legOrigin);
  const retr = legSize > 0 ? s * (impulse - extreme) / legSize : 1;
  if(retr > 0.786) return rej('A', `pullback retraced ${fmt(retr * 100, 0)}% of the last impulse leg — market structure at risk`);

  // Volume must be declining/normalising on the pullback vs the impulse leg.
  const pbBars = E.slice(impIdx + 1, gi + 1);
  const impBars = E.slice(Math.max(0, impIdx - 5), impIdx + 1);
  const pbVol = mean(pbBars.map(x => x.v)), impVol = mean(impBars.map(x => x.v));
  const volRatio = impVol > 0 && pbBars.length ? pbVol / impVol : 1;
  if(volRatio > 1.05) return rej('A', `pullback volume not contracting (${fmt(volRatio)}x the impulse leg)`);

  // Momentum recovering in the trend direction.
  if(f.rsi == null || f.rsiPrev == null || f.macdHist == null) return rej('A', 'momentum indicators unavailable');
  const rsiOk = s === 1 ? (f.rsi >= f.rsiPrev && f.rsi >= 40 && f.rsi <= 68) : (f.rsi <= f.rsiPrev && f.rsi <= 60 && f.rsi >= 32);
  if(!rsiOk) return rej('A', 'RSI is not turning back with the trend');
  const macdOk = s === 1 ? f.macdHist > f.macdPrev : f.macdHist < f.macdPrev;
  if(!macdOk) return rej('A', 'MACD histogram not recovering in the trend direction');

  // Entry-timeframe confirmation candle.
  const cs = f.candle;
  const confirm = s === 1 ? (cs.bull && last.c > prev.c && last.c > f.emaFv) : (cs.bear && last.c < prev.c && last.c < f.emaFv);
  if(!confirm) return rej('A', 'no confirming continuation candle on the entry timeframe');

  const ext = s * (last.c - f.emaFv) / atr;
  if(ext > 1.2) return rej('A', `entry extended ${fmt(ext)} ATR from value — chasing`);

  const structureQ = mean([
    retr >= 0.3 && retr <= 0.65 ? 1 : 0.7,
    depth >= 1.2 && depth <= 2.5 ? 1 : 0.7,
    s === 1 ? (extreme >= emaSatExt ? 1 : 0.7) : (extreme <= emaSatExt ? 1 : 0.7),
  ]);
  const momentumQ = clamp(mean([
    clamp(s * (f.rsi - f.rsiPrev) / 4, 0, 1),
    clamp(Math.abs(f.macdHist - f.macdPrev) / (atr * 0.05), 0, 1),
    clamp(cs.bodyRatio / 0.6, 0, 1),
  ]), 0, 1);
  const volumeQ = clamp(0.6 * clamp((1.1 - volRatio) / 0.6, 0, 1) + 0.4 * clamp(f.vol.rel / 1.3, 0, 1), 0, 1);
  const entryQ = clamp(0.6 * (1 - clamp(ext / 1.2, 0, 1)) + 0.4 * (s === 1 ? cs.closePos : 1 - cs.closePos), 0, 1);

  return {
    ok: true, setup: 'A', name: 'Trend Pullback', dir,
    anchor: extreme, anchorBasis: `pullback ${s === 1 ? 'low' : 'high'}`,
    q: { structure: structureQ, momentum: momentumQ, volume: volumeQ, entry: entryQ },
    evidence: [
      `${f.entryTf} pullback of ${fmt(depth)} ATR into the EMA21/55 value area, structure intact`,
      `Pullback volume ${fmt(volRatio)}x the impulse leg (contracting)`,
      `${f.entryTf} momentum recovering (RSI ${fmt(f.rsi, 0)} rising, MACD histogram improving)`,
      `Confirming ${s === 1 ? 'bullish' : 'bearish'} candle, ${fmt(ext)} ATR from EMA21 (not extended)`,
    ],
    flags: { volumeConfirm: volRatio <= 0.9 && f.vol.rel >= 0.9, momentumConfirm: true, structureConfirm: true },
    minClearanceR: 1.25, meta: { depthAtr: depth, volRatio, retracement: retr },
  };
}

// ---------------- Setup B — Breakout + Retest ----------------
export function detectBreakoutRetest(f, reg, dir){
  const s = dir === 'LONG' ? 1 : -1;
  const { E, i, last, prev, atr } = f;
  if(reg.bias === -s) return rej('B', 'higher-timeframe trend contradicts the breakout direction');
  if(f.rsi == null || f.macdHist == null) return rej('B', 'momentum indicators unavailable');

  let found = null;
  for(let k = i - 3; k >= Math.max(30, i - 14); k--){
    const preFrom = Math.max(0, k - 60);
    const pre = E.slice(preFrom, k);
    if(pre.length < 25) continue;
    const level = s === 1 ? Math.max(...pre.map(x => x.h)) : Math.min(...pre.map(x => x.l));
    // The level must be a genuinely tested one (>= 2 separate touches).
    let touches = 0, lastTouch = -10;
    pre.forEach((x, idx) => {
      const near = s === 1 ? x.h >= level - 0.25 * atr : x.l <= level + 0.25 * atr;
      if(near && idx - lastTouch >= 3){ touches++; lastTouch = idx; }
    });
    if(touches < 2) continue;
    const b = E[k];
    const bs = candleStats(b);
    const closedBeyond = s === 1 ? b.c > level + 0.3 * atr : b.c < level - 0.3 * atr;
    if(!closedBeyond || bs.bodyRatio < 0.5 || (s === 1 ? !bs.bull : !bs.bear)) continue;
    const volMean = mean(E.slice(Math.max(0, k - 20), k).map(x => x.v));
    const brkVol = volMean > 0 ? b.v / volMean : 1;
    if(brkVol < 1.5) continue;
    // First close beyond the level (not a level that was already broken long ago).
    const already = E.slice(Math.max(0, k - 8), k).some(x => s === 1 ? x.c > level + 0.1 * atr : x.c < level - 0.1 * atr);
    if(already) continue;
    // Volatility compression BEFORE the breakout: the 14-bar ATR at the bar before it sat <= 70% of the
    // normal-to-active level (75th-percentile ATR). Measured against p75, not a percentile inside a window
    // that the squeeze itself may fill half of.
    const preAtr = f.atrS[k - 1];
    const prePct = preAtr != null && f.atrP75 > 0 ? preAtr / f.atrP75 : null;
    if(prePct == null || prePct > 0.7) continue;
    found = { k, level, touches, brkVol, bs, prePct };
    break; // the most recent qualifying breakout
  }
  if(!found) return rej('B', 'no compression -> volume breakout of a tested level in the last 14 bars');
  const { k, level, touches, brkVol, bs } = found;

  // Not over-extended: most of the move must not already be done.
  const after = E.slice(k, i + 1);
  const farthest = s === 1 ? Math.max(...after.map(x => x.h)) : Math.min(...after.map(x => x.l));
  const extAtr = s * (farthest - level) / atr;
  if(extAtr > 3.0) return rej('B', `breakout already extended ${fmt(extAtr)} ATR — the move is mostly done`);
  const nowExt = s * (last.c - level) / atr;
  if(nowExt > 1.5) return rej('B', `price is ${fmt(nowExt)} ATR beyond the level — wait for the retest`);
  const failedBack = after.some(x => s === 1 ? x.c < level - 0.3 * atr : x.c > level + 0.3 * atr);
  if(failedBack) return rej('B', 'price closed back inside the range after the breakout — breakout failed');

  // The retest: a recent bar tagged the old level and held it.
  let r = -1, retestExtreme = null;
  for(let j = i; j > k; j--){
    const tagged = s === 1 ? (E[j].l <= level + 0.35 * atr && E[j].l >= level - 0.5 * atr && E[j].c >= level - 0.1 * atr)
      : (E[j].h >= level - 0.35 * atr && E[j].h <= level + 0.5 * atr && E[j].c <= level + 0.1 * atr);
    if(tagged){ r = j; retestExtreme = s === 1 ? E[j].l : E[j].h; break; }
  }
  if(r < 0 || r < i - 3) return rej('B', 'no fresh retest of the broken level yet');

  const cs = f.candle;
  const confirm = s === 1 ? (cs.bull && last.c > level && (last.c > prev.h || cs.closePos >= 0.6)) : (cs.bear && last.c < level && (last.c < prev.l || cs.closePos <= 0.4));
  if(!confirm) return rej('B', 'retest not yet confirmed by a rejection candle');

  const momOk = s === 1 ? (f.rsi > 50 && (f.macdHist > 0 || f.macdHist > f.macdPrev)) : (f.rsi < 50 && (f.macdHist < 0 || f.macdHist < f.macdPrev));
  if(!momOk) return rej('B', 'momentum does not support the breakout direction');

  const retestVolRatio = E[k].v > 0 ? E[r].v / E[k].v : 1;
  const structureQ = mean([
    clamp((touches - 1) / 3, 0, 1),
    clamp(bs.bodyRatio / 0.8, 0, 1),
    1 - clamp(Math.abs(retestExtreme - level) / (0.5 * atr), 0, 1) * 0.6,
  ]);
  const momentumQ = clamp(mean([
    clamp(s * (f.rsi - 50) / 15, 0, 1),
    s * (f.macdHist - f.macdPrev) > 0 ? 1 : 0.4,
    clamp(cs.bodyRatio / 0.6, 0, 1),
  ]), 0, 1);
  const volumeQ = clamp(0.7 * clamp((brkVol - 1) / 1.5, 0, 1) + 0.3 * (retestVolRatio <= 0.9 ? 1 : 0.4), 0, 1);
  const entryQ = clamp(0.6 * (1 - clamp(nowExt / 1.5, 0, 1)) + 0.4 * (s === 1 ? cs.closePos : 1 - cs.closePos), 0, 1);
  const buffered = s === 1 ? Math.min(retestExtreme, level - 0.2 * atr) : Math.max(retestExtreme, level + 0.2 * atr);

  return {
    ok: true, setup: 'B', name: 'Breakout + Retest', dir,
    anchor: buffered, anchorBasis: 'breakout level / retest invalidation',
    q: { structure: structureQ, momentum: momentumQ, volume: volumeQ, entry: entryQ },
    evidence: [
      `Squeeze then ${fmt(brkVol)}x-volume breakout of a level tested ${touches}x`,
      `Retest of the broken level held (${fmt(nowExt)} ATR beyond it now, breakout ${fmt(extAtr)} ATR extended)`,
      `Rejection candle confirms; momentum ${s === 1 ? 'positive' : 'negative'} (RSI ${fmt(f.rsi, 0)})`,
    ],
    flags: { volumeConfirm: brkVol >= 1.5, momentumConfirm: true, structureConfirm: true },
    minClearanceR: 1.25, meta: { level, brkVol, touches, breakoutAge: i - k },
  };
}

// ---------------- Setup C — Liquidity Sweep Reversal ----------------
export function detectLiquiditySweep(f, reg, dir){
  const s = dir === 'LONG' ? 1 : -1;
  const { E, i, last, atr } = f;
  if(reg.bias !== 0 && reg.bias !== s) return rej('C', 'sweep would trade against the higher-timeframe trend');
  if(f.rsi == null || f.macdHist == null) return rej('C', 'momentum indicators unavailable');

  const swings = s === 1 ? f.swingLows : f.swingHighs;
  let hit = null;
  for(const sj of [i, i - 1, i - 2]){
    const bar = E[sj];
    for(let q = swings.length - 1; q >= 0; q--){
      const sw = swings[q];
      if(sw.index > sj - 4 || sw.index < i - 45) continue;
      const pierced = s === 1 ? bar.l < sw.price - 0.05 * atr : bar.h > sw.price + 0.05 * atr;
      const reclaimed = s === 1 ? bar.c > sw.price : bar.c < sw.price;
      if(!pierced || !reclaimed) continue;
      // The level must still have been intact (unswept) before this bar.
      const swept = E.slice(sw.index + 1, sj).some(x => s === 1 ? x.l < sw.price - 0.05 * atr : x.h > sw.price + 0.05 * atr);
      if(swept) continue;
      const bs = candleStats(bar);
      const wick = s === 1 ? bs.lowerWick : bs.upperWick;
      if(wick < 0.35 && !(sj < i && (s === 1 ? E[i].c > bar.h : E[i].c < bar.l))) continue;
      hit = { sj, sw, bar, wick };
      break;
    }
    if(hit) break;
  }
  if(!hit) return rej('C', `no liquidity sweep of a recent swing ${s === 1 ? 'low' : 'high'} with a reclaim`);
  const { sj, sw, bar, wick } = hit;

  // Rejection + market-structure shift: the latest close takes out the short-term pre-sweep structure.
  const pre = E.slice(Math.max(0, sj - 2), sj); // the last two lower-highs (lower-lows for shorts) before the sweep bar
  if(pre.length < 2) return rej('C', 'insufficient structure before the sweep');
  const mss = s === 1 ? Math.max(...pre.map(x => x.h)) : Math.min(...pre.map(x => x.l));
  const shifted = s === 1 ? last.c > mss : last.c < mss;
  if(!shifted) return rej('C', 'no market-structure shift after the sweep yet');
  const cs = f.candle;
  if(!(s === 1 ? cs.bull : cs.bear)) return rej('C', 'latest candle does not reject in the reversal direction');

  const momOk = s === 1 ? (f.rsi > f.rsiPrev || f.macdHist > f.macdPrev) : (f.rsi < f.rsiPrev || f.macdHist < f.macdPrev);
  if(!momOk) return rej('C', 'reversal momentum not confirmed');
  const volMean = mean(E.slice(Math.max(0, sj - 20), sj).map(x => x.v));
  const sweepVol = volMean > 0 ? bar.v / volMean : 1;
  const reclaimVol = f.vol.rel;
  if(sweepVol < 1.3 && reclaimVol < 1.2) return rej('C', 'no volume evidence of a stop-run (sweep/reclaim volume too light)');

  const structureQ = mean([
    clamp(wick / 0.6, 0, 1),
    clamp(Math.abs(s * (bar.c - sw.price)) / (0.5 * atr), 0, 1),
    clamp(Math.abs(s * (last.c - mss)) / (0.6 * atr), 0, 1),
  ]);
  const rsiExtreme = s === 1 ? clamp((45 - Math.min(f.rsiPrev, f.rsi)) / 15, 0, 1) : clamp((Math.max(f.rsiPrev, f.rsi) - 55) / 15, 0, 1);
  const momentumQ = clamp(mean([rsiExtreme, s * (f.macdHist - f.macdPrev) > 0 ? 1 : 0.4, clamp(cs.bodyRatio / 0.6, 0, 1)]), 0, 1);
  const volumeQ = clamp(Math.max(clamp((sweepVol - 1) / 1.5, 0, 1), clamp((reclaimVol - 1) / 1.0, 0, 1)), 0, 1);
  const ext = s * (last.c - E[sj].c) / atr;
  const entryQ = clamp(0.6 * (1 - clamp(ext / 2, 0, 1)) + 0.4 * (s === 1 ? cs.closePos : 1 - cs.closePos), 0, 1);
  const anchor = s === 1 ? bar.l : bar.h;

  return {
    ok: true, setup: 'C', name: 'Liquidity Sweep Reversal', dir,
    anchor, anchorBasis: `sweep ${s === 1 ? 'low' : 'high'}`,
    q: { structure: structureQ, momentum: momentumQ, volume: volumeQ, entry: entryQ },
    evidence: [
      `Swing ${s === 1 ? 'low' : 'high'} ${fmt(sw.price, 4)} swept then reclaimed (wick ${fmt(wick * 100, 0)}% of range)`,
      `Market-structure shift: close beyond ${fmt(mss, 4)}; latest candle rejects`,
      `Stop-run volume ${fmt(Math.max(sweepVol, reclaimVol))}x average; momentum turning`,
    ],
    flags: { volumeConfirm: sweepVol >= 1.3 || reclaimVol >= 1.2, momentumConfirm: true, structureConfirm: true },
    // Reversal: the target must be reachable BEFORE the next opposing level (clearance >= target R + 0.25),
    // i.e. "only enter if the expected reward substantially exceeds the risk" without a wall in the way.
    clearanceMode: 'beyondTarget', minClearanceR: 2,
    meta: { sweptLevel: sw.price, sweepVol },
  };
}

// ---------------- Setup D — Range Extremes ----------------
export function detectRangeExtreme(f, reg, dir){
  const s = dir === 'LONG' ? 1 : -1;
  const { E, i, last, prev, atr } = f;
  if(reg.trendLabel !== QREGIMES.RANGE || reg.volState !== 'normal') return rej('D', 'market is not in a normal-volatility Range regime (no mean reversion in trends)');
  if(f.tfH4.dir === -s && f.tfH4.strength >= 0.4) return rej('D', 'strong higher-timeframe trend against the fade');
  if(f.rsi == null || f.macdHist == null) return rej('D', 'momentum indicators unavailable');

  const win = E.slice(i - 60, i); // prior 60 bars (excludes the current candle)
  if(win.length < 60) return rej('D', 'insufficient range history');
  const rHigh = Math.max(...win.map(x => x.h)), rLow = Math.min(...win.map(x => x.l));
  const width = rHigh - rLow;
  if(width < 3.5 * atr) return rej('D', `range only ${fmt(width / atr)} ATR wide — too narrow to fade`);
  if(width > 12 * atr) return rej('D', `range ${fmt(width / atr)} ATR wide — not a contained range`);
  const posNow = (last.c - rLow) / width;
  if(s === 1 ? posNow > 0.2 : posNow < 0.8) return rej('D', 'price is not at a range extreme');

  // Boundary significance: >= 2 separate prior touches of that edge.
  let touches = 0, lastT = -10;
  win.forEach((x, idx) => {
    const near = s === 1 ? x.l <= rLow + 0.35 * atr : x.h >= rHigh - 0.35 * atr;
    if(near && idx - lastT >= 3){ touches++; lastT = idx; }
  });
  if(touches < 2) return rej('D', 'range boundary has fewer than 2 prior touches — not statistically meaningful');

  const weakening = s === 1 ? (f.rsi <= 42 && f.rsi > f.rsiPrev && f.macdHist > f.macdPrev) : (f.rsi >= 58 && f.rsi < f.rsiPrev && f.macdHist < f.macdPrev);
  if(!weakening) return rej('D', 'momentum has not started to fade at the extreme');
  const cs = f.candle;
  const reversal = s === 1 ? (cs.bull && cs.closePos >= 0.55 && (cs.lowerWick >= 0.35 || last.c > prev.o))
    : (cs.bear && cs.closePos <= 0.45 && (cs.upperWick >= 0.35 || last.c < prev.o));
  if(!reversal) return rej('D', 'no reversal confirmation candle at the extreme');
  const volConfirm = f.vol.rel >= 0.9 || (E[i - 1].v / (f.vol.mean || 1)) >= 1.5;
  if(!volConfirm) return rej('D', 'no participation/capitulation volume at the extreme');

  const touchExtreme = s === 1 ? Math.min(last.l, ...win.filter(x => x.l <= rLow + 0.35 * atr).map(x => x.l)) : Math.max(last.h, ...win.filter(x => x.h >= rHigh - 0.35 * atr).map(x => x.h));
  const structureQ = mean([clamp((touches - 1) / 3, 0, 1), clamp((width / atr - 3.5) / 5, 0, 1) * 0.5 + 0.5, s === 1 ? clamp((0.2 - posNow) / 0.2 + 0.5, 0, 1) : clamp((posNow - 0.8) / 0.2 + 0.5, 0, 1)]);
  const momentumQ = clamp(mean([
    s === 1 ? clamp((42 - f.rsi) / 14 + 0.3, 0, 1) : clamp((f.rsi - 58) / 14 + 0.3, 0, 1),
    clamp(Math.abs(f.macdHist - f.macdPrev) / (atr * 0.05), 0, 1),
    clamp(cs.bodyRatio / 0.6, 0, 1),
  ]), 0, 1);
  const volumeQ = clamp(0.5 + 0.5 * clamp((f.vol.rel - 0.9) / 1.0, 0, 1), 0, 1);
  const entryQ = clamp(0.5 + 0.5 * (s === 1 ? cs.closePos : 1 - cs.closePos) - 0.2 * clamp(Math.abs(s * (last.c - touchExtreme)) / (2 * atr), 0, 1), 0, 1);

  return {
    ok: true, setup: 'D', name: 'Range Extremes', dir,
    anchor: touchExtreme, anchorBasis: `range ${s === 1 ? 'low' : 'high'}`,
    q: { structure: structureQ, momentum: momentumQ, volume: volumeQ, entry: entryQ },
    evidence: [
      `Range regime: ${fmt(width / atr, 1)} ATR wide, edge tested ${touches}x, price at ${fmt(posNow * 100, 0)}% of range`,
      `Momentum fading at the extreme (RSI ${fmt(f.rsi, 0)}), reversal candle confirms`,
      `No strong higher-timeframe trend against the fade`,
    ],
    flags: { volumeConfirm: true, momentumConfirm: true, structureConfirm: true },
    clearanceMode: 'beyondTarget', minClearanceR: 2,
    capPrice: s === 1 ? rHigh - 0.1 * atr : rLow + 0.1 * atr, // don't target beyond the opposite edge
    meta: { rangeHigh: rHigh, rangeLow: rLow, touches },
  };
}

export const SETUP_DETECTORS = {
  A: detectTrendPullback,
  B: detectBreakoutRetest,
  C: detectLiquiditySweep,
  D: detectRangeExtreme,
};
