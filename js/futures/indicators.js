// =============================================================
// indicators.js — pure technical-indicator math shared by the AI
// Futures Engine (regime.js, setups.js, scoring.js). No DOM, no
// state, no network — every function takes an array of candles
// ({t,o,h,l,c,v}, oldest first) and returns plain numbers/arrays,
// so it's the same code path whether candles come from the mock
// generator (today) or a real exchange feed (Phase 2 wiring).
// =============================================================

export function sma(values, period){
  if(values.length < period) return null;
  let sum = 0;
  for(let i = values.length - period; i < values.length; i++) sum += values[i];
  return sum / period;
}

export function emaSeries(values, period){
  if(values.length === 0) return [];
  const k = 2 / (period + 1);
  const out = [values[0]];
  for(let i = 1; i < values.length; i++) out.push(values[i] * k + out[i - 1] * (1 - k));
  return out;
}

export function ema(values, period){
  const series = emaSeries(values, period);
  return series.length ? series[series.length - 1] : null;
}

export function closes(candles){ return candles.map(c => c.c); }
export function highs(candles){ return candles.map(c => c.h); }
export function lows(candles){ return candles.map(c => c.l); }
export function vols(candles){ return candles.map(c => c.v); }

// Average True Range over the last `period` candles (Wilder-style, simple mean).
export function atr(candles, period){
  if(candles.length < period + 1) return null;
  const trs = [];
  for(let i = candles.length - period; i < candles.length; i++){
    const cur = candles[i], prev = candles[i - 1];
    trs.push(Math.max(
      cur.h - cur.l,
      Math.abs(cur.h - prev.c),
      Math.abs(cur.l - prev.c),
    ));
  }
  return trs.reduce((a, b) => a + b, 0) / trs.length;
}

// Session VWAP over the candles provided (typical price weighted by volume).
export function vwap(candles){
  let pv = 0, v = 0;
  for(const c of candles){
    const typical = (c.h + c.l + c.c) / 3;
    pv += typical * c.v;
    v += c.v;
  }
  return v > 0 ? pv / v : null;
}

export function rsi(candles, period){
  if(candles.length < period + 1) return null;
  let gains = 0, losses = 0;
  for(let i = candles.length - period; i < candles.length; i++){
    const chg = candles[i].c - candles[i - 1].c;
    if(chg >= 0) gains += chg; else losses -= chg;
  }
  const avgGain = gains / period, avgLoss = losses / period;
  if(avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

// MACD histogram (12/26/9 by default) — positive & rising = bullish momentum building.
export function macdHistogram(candles, fast, slow, signal){
  fast = fast || 12; slow = slow || 26; signal = signal || 9;
  const c = closes(candles);
  if(c.length < slow + signal) return null;
  const fastSeries = emaSeries(c, fast);
  const slowSeries = emaSeries(c, slow);
  const macdSeries = fastSeries.map((v, i) => v - slowSeries[i]);
  const signalSeries = emaSeries(macdSeries, signal);
  const last = macdSeries.length - 1;
  return {
    macd: macdSeries[last],
    signal: signalSeries[last],
    hist: macdSeries[last] - signalSeries[last],
    prevHist: macdSeries[last - 1] - signalSeries[last - 1],
  };
}

// Bollinger Bands: SMA(period) +/- stdDevMult standard deviations of
// closing price. Returns null until `period` closes are available.
// Added for NxTGen Grid's range-suitability/volatility read (grid.js) —
// existing callers of this file are unaffected, this is purely additive.
export function bollingerBands(candles, period, stdDevMult){
  period = period || 20; stdDevMult = stdDevMult || 2;
  const c = closes(candles);
  if(c.length < period) return null;
  const win = c.slice(-period);
  const mean = win.reduce((a, b) => a + b, 0) / period;
  const variance = win.reduce((a, b) => a + (b - mean) * (b - mean), 0) / period;
  const sd = Math.sqrt(variance);
  const upper = mean + stdDevMult * sd;
  const lower = mean - stdDevMult * sd;
  return { mean, upper, lower, sd, widthPct: mean ? ((upper - lower) / mean) * 100 : 0 };
}

// Bollinger Band Width series (widthPct at each bar from `period` onward)
// — used to read whether current BB width is compressed/expanded versus
// its own recent history, the same "ratio vs its own recent average"
// pattern regime.js already uses for ATR (volRatio).
export function bollingerBandWidthSeries(candles, period, stdDevMult, lookback){
  const out = [];
  const start = Math.max(period, candles.length - lookback);
  for(let i = start; i <= candles.length; i++){
    const bb = bollingerBands(candles.slice(0, i), period, stdDevMult);
    if(bb) out.push(bb.widthPct);
  }
  return out;
}

// Wilder's ADX (Average Directional Index) over `period` bars — standard
// trend-strength read (0-100; >25 is conventionally "trending", <20 is
// conventionally "range/weak trend"). Used by grid.js's market-regime
// filter alongside regime.js's own EMA-based classification, since ADX
// is the specific indicator the grid spec calls for and existing
// regime.js does not compute it.
export function adx(candles, period){
  period = period || 14;
  if(candles.length < period * 2 + 1) return null;
  const trs = [], plusDMs = [], minusDMs = [];
  for(let i = 1; i < candles.length; i++){
    const cur = candles[i], prev = candles[i - 1];
    trs.push(Math.max(cur.h - cur.l, Math.abs(cur.h - prev.c), Math.abs(cur.l - prev.c)));
    const upMove = cur.h - prev.h, downMove = prev.l - cur.l;
    plusDMs.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDMs.push(downMove > upMove && downMove > 0 ? downMove : 0);
  }
  const wilderSmooth = (arr) => {
    const out = [];
    let sum = arr.slice(0, period).reduce((a, b) => a + b, 0);
    out.push(sum);
    for(let i = period; i < arr.length; i++){
      sum = out[out.length - 1] - (out[out.length - 1] / period) + arr[i];
      out.push(sum);
    }
    return out;
  };
  const trSm = wilderSmooth(trs), plusSm = wilderSmooth(plusDMs), minusSm = wilderSmooth(minusDMs);
  const dxs = [];
  for(let i = 0; i < trSm.length; i++){
    const plusDI = trSm[i] ? (plusSm[i] / trSm[i]) * 100 : 0;
    const minusDI = trSm[i] ? (minusSm[i] / trSm[i]) * 100 : 0;
    const dx = (plusDI + minusDI) ? (Math.abs(plusDI - minusDI) / (plusDI + minusDI)) * 100 : 0;
    dxs.push(dx);
  }
  if(dxs.length < period) return null;
  const adxVal = dxs.slice(-period).reduce((a, b) => a + b, 0) / period;
  return adxVal;
}

// Simple swing high/low structure over a lookback window — used for
// support/resistance and market-structure (higher-highs/lows) reads.
export function swingLevels(candles, lookback){
  const win = candles.slice(-lookback);
  const swingHighs = [], swingLows = [];
  for(let i = 2; i < win.length - 2; i++){
    const h = win[i].h, l = win[i].l;
    if(h > win[i-1].h && h > win[i-2].h && h > win[i+1].h && h > win[i+2].h) swingHighs.push(h);
    if(l < win[i-1].l && l < win[i-2].l && l < win[i+1].l && l < win[i+2].l) swingLows.push(l);
  }
  return {
    resistance: swingHighs.length ? Math.max(...swingHighs) : Math.max(...highs(win)),
    support: swingLows.length ? Math.min(...swingLows) : Math.min(...lows(win)),
    swingHighs, swingLows,
  };
}

// Volume expansion: last candle's volume vs the average of the prior N.
export function volumeExpansion(candles, lookback){
  if(candles.length < lookback + 1) return 1;
  const prior = candles.slice(-lookback - 1, -1);
  const avg = prior.reduce((a, c) => a + c.v, 0) / prior.length;
  const last = candles[candles.length - 1].v;
  return avg > 0 ? last / avg : 1;
}

// Relative volume percentile: where the LAST candle's volume ranks against
// the prior `lookback` candles' volumes, as a 0-1 fraction (1 = highest
// volume bar in the window). A fixed multiplier like volumeExpansion()
// above (e.g. "1.15x the N-bar average") is sensitive to a couple of
// outlier bars dragging the average around and doesn't adapt to how
// skewed a symbol's own volume distribution normally is. Percentile rank
// is a steadier read of "is this genuinely unusual volume for THIS
// symbol right now" — used as an added, more robust confirmation
// alongside (not instead of) the existing hard volume gates, since
// swapping a working gate's threshold outright without a real backtest
// is exactly the mistake this codebase's own history (see
// README-SCALP.md) warns against repeating.
export function relativeVolumePercentile(candles, lookback){
  if(candles.length < lookback + 1) return 0.5; // not enough history — neutral, don't gate on it
  const win = candles.slice(-lookback - 1);
  const lastVol = win[win.length - 1].v;
  const priorVols = win.slice(0, -1).map(c => c.v);
  const below = priorVols.filter(v => v <= lastVol).length;
  return below / priorVols.length;
}

// Parabolic SAR (Wilder) — returns an array aligned to `candles`, one SAR
// value per bar (null for the first bar, which only seeds the trend).
// Standard flip rule: SAR trails the trend, accelerating (`step` per new
// extreme point, capped at `maxStep`) toward price; when price crosses
// the SAR it flips trend and resets SAR to the prior extreme point. Used
// by the "NxTGen Scalp" setup (setups.js) to read where the SAR dots sit
// relative to the EMA50/EMA100 band, exactly like the reference charts
// that setup was built from show the dots crossing the moving averages.
export function parabolicSar(candles, step, maxStep){
  step = step || 0.02; maxStep = maxStep || 0.2;
  const n = candles.length;
  const out = new Array(n).fill(null);
  if(n < 2) return out;

  let uptrend = candles[1].c >= candles[0].c;
  let af = step;
  let ep = uptrend ? candles[0].h : candles[0].l;
  let sarVal = uptrend ? candles[0].l : candles[0].h;

  for(let i = 1; i < n; i++){
    const prevLow = candles[i - 1].l, prevHigh = candles[i - 1].h;
    const prev2Low = i >= 2 ? candles[i - 2].l : prevLow;
    const prev2High = i >= 2 ? candles[i - 2].h : prevHigh;
    let next = sarVal + af * (ep - sarVal);

    if(uptrend){
      next = Math.min(next, prevLow, prev2Low);
      if(candles[i].l < next){
        uptrend = false;
        next = ep;
        ep = candles[i].l;
        af = step;
      } else if(candles[i].h > ep){
        ep = candles[i].h;
        af = Math.min(af + step, maxStep);
      }
    } else {
      next = Math.max(next, prevHigh, prev2High);
      if(candles[i].h > next){
        uptrend = true;
        next = ep;
        ep = candles[i].h;
        af = step;
      } else if(candles[i].l < ep){
        ep = candles[i].l;
        af = Math.min(af + step, maxStep);
      }
    }
    sarVal = next;
    out[i] = sarVal;
  }
  return out;
}

// Awesome Oscillator (Bill Williams): SMA5 - SMA34 of the median price
// (H+L)/2. Returns `{ values, colors }`, both arrays aligned to
// `candles` (null while either SMA is still warming up). Coloring
// follows the standard convention — 'green' when a bar is HIGHER than
// the previous bar (rising, regardless of sign), 'red' when LOWER
// (falling) — which is what the reference charts' AO histogram color is
// keying off, not simply positive-vs-negative.
export function awesomeOscillator(candles){
  const median = candles.map(c => (c.h + c.l) / 2);
  const smaSeries = (vals, period) => {
    const out = new Array(vals.length).fill(null);
    let sum = 0;
    for(let i = 0; i < vals.length; i++){
      sum += vals[i];
      if(i >= period) sum -= vals[i - period];
      if(i >= period - 1) out[i] = sum / period;
    }
    return out;
  };
  const s5 = smaSeries(median, 5);
  const s34 = smaSeries(median, 34);
  const values = median.map((_, i) => (s5[i] != null && s34[i] != null) ? s5[i] - s34[i] : null);
  const colors = new Array(values.length).fill(null);
  for(let i = 1; i < values.length; i++){
    if(values[i] == null || values[i - 1] == null) continue;
    if(values[i] > values[i - 1]) colors[i] = 'green';
    else if(values[i] < values[i - 1]) colors[i] = 'red';
    else colors[i] = colors[i - 1]; // flat bar — carry the previous color, same as most charting platforms
  }
  return { values, colors };
}

// Full MACD(fast, slow, signal) series aligned to `candles` — the same maths
// as macdHistogram() above, but for EVERY bar instead of only the last one
// (Nova Scalp needs to know how many bars in a row MACD has been above/below
// zero, not just where it is now). `macd` is the MACD line itself (fast EMA
// minus slow EMA) — which is what MetaTrader draws as the grey histogram
// bars in its "MACD" indicator — `signal` is the red signal line, `hist` is
// macd - signal. Entries are null until `slow` bars exist.
export function macdSeries(candles, fast, slow, signal){
  fast = fast || 12; slow = slow || 26; signal = signal || 9;
  const c = closes(candles);
  const n = c.length;
  const out = { macd: new Array(n).fill(null), signal: new Array(n).fill(null), hist: new Array(n).fill(null) };
  if(n < slow + signal) return out;
  const f = emaSeries(c, fast), sl = emaSeries(c, slow);
  const m = f.map((v, i) => v - sl[i]);
  const sg = emaSeries(m, signal);
  for(let i = slow - 1; i < n; i++){
    out.macd[i] = m[i];
    out.signal[i] = sg[i];
    out.hist[i] = m[i] - sg[i];
  }
  return out;
}

// Kaufman Efficiency Ratio: net close-to-close move over `period` bars
// divided by the sum of every bar-to-bar move in that window. ~1 = a clean
// one-directional trend, ~0 = price went nowhere despite lots of movement
// (i.e. chop / range). Returns null without enough history.
export function efficiencyRatio(values, period){
  if(values.length < period + 1) return null;
  const end = values.length - 1;
  const net = Math.abs(values[end] - values[end - period]);
  let path = 0;
  for(let k = end - period + 1; k <= end; k++) path += Math.abs(values[k] - values[k - 1]);
  return path > 0 ? net / path : 0;
}

export function pctChange(from, to){
  return from ? ((to - from) / from) * 100 : 0;
}

export function clamp(x, lo, hi){ return Math.max(lo, Math.min(hi, x)); }

// Shared "BTC shock" read, used by the altcoin market filter (see
// noTradeEngine.js) — a large recent BTC range relative to its own
// average means temporarily reduce/disable new altcoin entries. Pulled
// out here (rather than living inside mockMarket.js) so the exact same
// formula applies whether the m5 candles come from the synthetic
// generator (Paper mode) or a real exchange feed (Live/Demo mode) — see
// js/futures-ui.js for the real-data version's caller.
export function computeBtcShock(btcM5Candles){
  const recent = btcM5Candles.slice(-12); // last hour of 5m candles
  if(recent.length < 6) return { shocked: false, movePct: 0 };
  const ranges = recent.map(c => (c.h - c.l) / c.c);
  const avgRange = ranges.slice(0, -3).reduce((a, b) => a + b, 0) / Math.max(1, ranges.length - 3);
  const lastRange = ranges.slice(-3).reduce((a, b) => a + b, 0) / 3;
  const movePct = ((recent[recent.length - 1].c - recent[0].c) / recent[0].c) * 100;
  return { shocked: avgRange > 0 && lastRange > avgRange * 2.2, movePct };
}

// Confirmed fractal swing points (default: 2 bars each side, strict) inside
// [fromIdx, toIdx]. Returns [{ index, price }], oldest first. A swing at
// bar j needs `right` bars after it to confirm, so callers should pass a
// toIdx of at most (lastIdx - right).
export function swingLowPoints(candles, fromIdx, toIdx, left, right){
  left = left || 2; right = right || 2;
  const out = [];
  for(let j = Math.max(left, fromIdx); j <= Math.min(candles.length - 1 - right, toIdx); j++){
    let ok = true;
    for(let k = 1; k <= left && ok; k++) if(!(candles[j].l < candles[j - k].l)) ok = false;
    for(let k = 1; k <= right && ok; k++) if(!(candles[j].l < candles[j + k].l)) ok = false;
    if(ok) out.push({ index: j, price: candles[j].l });
  }
  return out;
}


export function swingHighPoints(candles, fromIdx, toIdx, left, right){
  left = left || 2; right = right || 2;
  const out = [];
  for(let j = Math.max(left, fromIdx); j <= Math.min(candles.length - 1 - right, toIdx); j++){
    let ok = true;
    for(let k = 1; k <= left && ok; k++) if(!(candles[j].h > candles[j - k].h)) ok = false;
    for(let k = 1; k <= right && ok; k++) if(!(candles[j].h > candles[j + k].h)) ok = false;
    if(ok) out.push({ index: j, price: candles[j].h });
  }
  return out;
}
