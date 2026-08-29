// =============================================================
// mockMarket.js — PLACEHOLDER DATA SOURCE.
//
// This engine's scoring/regime/setup/risk logic is written against a
// plain candle shape ({t,o,h,l,c,v}) and a plain "snapshot" shape
// (spread/funding/open interest/liquidity), not against any particular
// exchange. Today this file fabricates that shape with a seeded random
// walk so the dashboard, scanner and paper-trading loop can be fully
// exercised end to end. Wiring Phase 2 (real Binance/Bybit USDT-M
// futures market data) means replacing ONLY this file — every other
// module in js/futures/ already consumes the same {m5,m15,h1,meta}
// shape this returns, and doesn't need to change.
//
// The random walk is NOT tuned to make the strategy look good — it has
// no knowledge of the scoring/setup logic at all, so whatever win rate
// or expectancy the engine shows against it is whatever the (synthetic)
// price action actually produced, not a fabricated number.
// =============================================================

// A broad USDT-M perpetual watchlist instead of six large-caps — large
// caps, majors, and higher-beta alt/meme names so the scanner isn't
// structurally confined to the same handful of symbols every cycle.
// Base prices/volumes are illustrative synthetic seeds (this whole file
// is a placeholder data source, see header above), not live quotes.
const SYMBOLS = [
  'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'DOGEUSDT',
  'ADAUSDT', 'AVAXUSDT', 'LINKUSDT', 'DOTUSDT', 'LTCUSDT', 'TRXUSDT',
  'NEARUSDT', 'APTUSDT', 'ARBUSDT', 'OPUSDT', 'SUIUSDT', 'INJUSDT',
  'TIAUSDT', 'SEIUSDT', 'ATOMUSDT', 'FILUSDT', 'ETCUSDT', 'UNIUSDT',
  'AAVEUSDT', 'PEPEUSDT', 'WIFUSDT', 'SHIBUSDT', 'BONKUSDT', 'ORDIUSDT',
  'TONUSDT', 'ICPUSDT', 'HBARUSDT', 'RENDERUSDT', 'RUNEUSDT',
];
const SEED_MINUTES = 4000;    // ~2.8 days of 1m backstory generated on load
const MAX_CANDLES_KEPT = 6500; // rolling window kept after seeding, comfortably above what H1x60 aggregation needs

const BASE_PRICE = {
  BTCUSDT: 64000, ETHUSDT: 3400, SOLUSDT: 148, BNBUSDT: 590, XRPUSDT: 0.62, DOGEUSDT: 0.14,
  ADAUSDT: 0.58, AVAXUSDT: 34, LINKUSDT: 14.5, DOTUSDT: 6.4, LTCUSDT: 84, TRXUSDT: 0.16,
  NEARUSDT: 5.8, APTUSDT: 9.2, ARBUSDT: 0.78, OPUSDT: 1.9, SUIUSDT: 3.6, INJUSDT: 22,
  TIAUSDT: 5.1, SEIUSDT: 0.41, ATOMUSDT: 7.3, FILUSDT: 4.9, ETCUSDT: 26, UNIUSDT: 8.1,
  AAVEUSDT: 165, PEPEUSDT: 0.0000165, WIFUSDT: 2.1, SHIBUSDT: 0.0000185, BONKUSDT: 0.0000225,
  ORDIUSDT: 38, TONUSDT: 5.4, ICPUSDT: 9.8, HBARUSDT: 0.075, RENDERUSDT: 6.2, RUNEUSDT: 4.4,
};
const BASE_VOL_24H_USD = {
  BTCUSDT: 2.1e9, ETHUSDT: 9.4e8, SOLUSDT: 3.1e8, BNBUSDT: 1.6e8, XRPUSDT: 2.4e8, DOGEUSDT: 1.7e8,
  ADAUSDT: 1.4e8, AVAXUSDT: 1.3e8, LINKUSDT: 1.1e8, DOTUSDT: 8.5e7, LTCUSDT: 9.2e7, TRXUSDT: 7.8e7,
  NEARUSDT: 7.1e7, APTUSDT: 6.4e7, ARBUSDT: 6.9e7, OPUSDT: 5.8e7, SUIUSDT: 8.8e7, INJUSDT: 5.2e7,
  TIAUSDT: 4.6e7, SEIUSDT: 3.9e7, ATOMUSDT: 4.8e7, FILUSDT: 4.1e7, ETCUSDT: 5.5e7, UNIUSDT: 5.9e7,
  AAVEUSDT: 3.6e7, PEPEUSDT: 2.9e8, WIFUSDT: 1.2e8, SHIBUSDT: 1.5e8, BONKUSDT: 9.4e7,
  ORDIUSDT: 3.3e7, TONUSDT: 9.6e7, ICPUSDT: 4.4e7, HBARUSDT: 5.1e7, RENDERUSDT: 6.6e7, RUNEUSDT: 3.7e7,
};

function mulberry32(seed){
  return function(){
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class SymbolSeries {
  constructor(symbol, seed){
    this.symbol = symbol;
    this.rng = mulberry32(seed);
    this.price = BASE_PRICE[symbol];
    // Regime "mood" drifts slowly on its own random walk so the market
    // spends real stretches trending, ranging, or chopping — instead of
    // pure noise every candle, which would never produce a clean setup.
    this.mood = 0; // -1 strong bear .. +1 strong bull
    this.volRegime = 1; // volatility multiplier, mean-reverts around 1
    this.m1Candles = [];
    this.fundingRate = 0.0001 * (this.rng() - 0.5) * 2; // ~ -0.01%..+0.01% / 8h
    this.openInterestUsd = BASE_VOL_24H_USD[symbol] * (0.15 + this.rng() * 0.1);
    this._seedHistory();
  }

  _seedHistory(){
    // Build ~4000 1-minute candles (~2.8 days) of backstory. The H1
    // regime classifier wants 30-60 H1 candles for its EMA20/EMA50 read,
    // which means 1800-3600 minutes of underlying 1m history — this
    // seeds comfortably past that so every symbol has a real regime
    // read (not "insufficient history") from the very first render.
    const now = Date.now() - SEED_MINUTES * 60_000;
    for(let i = 0; i < SEED_MINUTES; i++) this._stepOneMinute(now + i * 60_000);
  }

  _stepOneMinute(ts){
    // Mood random-walks with mild mean reversion — this is what creates
    // the "spends hours doing nothing, then trends for a while" texture.
    this.mood = clamp(this.mood + (this.rng() - 0.5) * 0.08 - this.mood * 0.01, -1, 1);
    this.volRegime = clamp(this.volRegime + (this.rng() - 0.5) * 0.05 - (this.volRegime - 1) * 0.02, 0.35, 2.2);

    const baseVolPct = 0.0009 * this.volRegime; // ~0.09% typical 1m stdev, scaled by regime
    const drift = this.mood * baseVolPct * 0.6;
    const shock = (this.rng() - 0.5) * 2 * baseVolPct;
    const open = this.price;
    const close = Math.max(0.00001, open * (1 + drift + shock));
    const wick = Math.abs(close - open) * (0.4 + this.rng() * 1.2);
    const high = Math.max(open, close) + wick * this.rng();
    const low = Math.min(open, close) - wick * this.rng();
    const volBase = (BASE_VOL_24H_USD[this.symbol] / open) / (24 * 60); // avg 1m base-asset volume
    const volSpike = this.rng() < 0.06 ? (1.8 + this.rng() * 2.5) : 1; // occasional expansion candle
    const volume = volBase * (0.5 + this.rng()) * volSpike;

    this.price = close;
    this.m1Candles.push({ t: ts, o: open, h: high, l: low, c: close, v: volume });
    if(this.m1Candles.length > MAX_CANDLES_KEPT) this.m1Candles.shift();

    // Funding drifts slowly, nudged by mood (persistent one-sided positioning).
    this.fundingRate = clamp(this.fundingRate + (this.rng() - 0.5) * 0.00003 + this.mood * 0.000015, -0.0075, 0.0075);
    this.openInterestUsd = Math.max(1e6, this.openInterestUsd * (1 + (this.rng() - 0.5) * 0.01 + this.mood * 0.002));
  }

  advance(minutes){
    const last = this.m1Candles[this.m1Candles.length - 1];
    let ts = last ? last.t + 60_000 : Date.now();
    for(let i = 0; i < minutes; i++, ts += 60_000) this._stepOneMinute(ts);
  }

  aggregate(minutesPerCandle, count){
    const src = this.m1Candles;
    const out = [];
    for(let end = src.length; end > 0 && out.length < count; end -= minutesPerCandle){
      const start = Math.max(0, end - minutesPerCandle);
      const slice = src.slice(start, end);
      if(!slice.length) continue;
      out.unshift({
        t: slice[0].t,
        o: slice[0].o,
        h: Math.max(...slice.map(c => c.h)),
        l: Math.min(...slice.map(c => c.l)),
        c: slice[slice.length - 1].c,
        v: slice.reduce((a, c) => a + c.v, 0),
      });
    }
    return out;
  }
}

function clamp(x, lo, hi){ return Math.max(lo, Math.min(hi, x)); }

class MockMarket {
  constructor(){
    this.series = new Map();
    SYMBOLS.forEach((sym, i) => this.series.set(sym, new SymbolSeries(sym, 1337 + i * 97)));
  }

  get symbols(){ return SYMBOLS.slice(); }

  // The synthetic market clock — all symbols tick in lockstep (tick() below
  // advances every series by the same number of minutes), so any one
  // series's latest candle timestamp is the shared "now" for position
  // aging, time-stops, and trade-history timestamps. Using this instead of
  // wall-clock Date.now() matters because the UI's real-time cycle
  // interval (a few seconds) and the synthetic minutes-per-cycle it
  // advances are two different clocks.
  now(){
    const s = this.series.get(SYMBOLS[0]);
    const last = s.m1Candles[s.m1Candles.length - 1];
    return last ? last.t : Date.now();
  }

  // Advance every symbol's clock by one "tick" (default 1 minute of
  // synthetic time) — call this once per scan cycle.
  tick(minutes){
    for(const s of this.series.values()) s.advance(minutes || 1);
  }

  snapshot(symbol){
    const s = this.series.get(symbol);
    if(!s) return null;
    const last = s.m1Candles[s.m1Candles.length - 1];
    const spreadPct = (0.01 + Math.max(0, 1 - s.volRegime) * 0.01) * (0.6 + s.rng() * 0.8); // tighter when calm
    const liquidityScore = clamp(Math.round(
      40 + 45 * Math.min(1, BASE_VOL_24H_USD[symbol] / 2.2e9) + (s.rng() * 10 - 5)
    ), 5, 99);
    return {
      symbol,
      price: last.c,
      m5: s.aggregate(5, 120),
      m15: s.aggregate(15, 120),
      h1: s.aggregate(60, 60),
      meta: {
        spreadPct,                              // % round-trip spread estimate
        volume24hUsd: BASE_VOL_24H_USD[symbol] * s.volRegime,
        liquidityScore,                          // 0-100, higher = deeper/safer to fill
        fundingRatePct: s.fundingRate * 100,      // per 8h funding interval, in %
        openInterestUsd: s.openInterestUsd,
        volRegime: s.volRegime,
      },
    };
  }

  // BTC-specific "shock" read used by the altcoin market filter — large
  // recent BTC range relative to its own average = temporarily reduce/
  // disable new altcoin entries.
  btcShock(){
    const btc = this.series.get('BTCUSDT');
    const recent = btc.aggregate(5, 12); // last hour of 5m candles
    if(recent.length < 6) return { shocked: false, movePct: 0 };
    const ranges = recent.map(c => (c.h - c.l) / c.c);
    const avgRange = ranges.slice(0, -3).reduce((a, b) => a + b, 0) / Math.max(1, ranges.length - 3);
    const lastRange = ranges.slice(-3).reduce((a, b) => a + b, 0) / 3;
    const movePct = ((recent[recent.length - 1].c - recent[0].c) / recent[0].c) * 100;
    return { shocked: avgRange > 0 && lastRange > avgRange * 2.2, movePct };
  }
}

export const mockMarket = new MockMarket();
export const FUTURES_SYMBOLS = SYMBOLS;
