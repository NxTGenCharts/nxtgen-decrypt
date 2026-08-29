// =============================================================
// exchanges.js — Bitget / Binance / Bybit / MEXC / Gate.io loaders
// and exchange-specific normalization.
//
// Market data is fetched from ONE place: this app's own backend (see
// /server, same server that already signs verify/balance/order calls),
// which fetches all five exchanges server-side and hands back one merged
// response. That's what actually fixes the "connects on some devices,
// takes minutes on others" problem — it wasn't a per-device setting, it
// was every browser independently hitting five exchanges whose public
// endpoints are reachable inconsistently depending on the caller's
// network/ISP/VPN/region, one after another, so a single slow/blocked
// exchange stalled everything queued behind it. Routing through a fixed
// server means every device gets the exact same fast, already-cached
// answer, with nothing to configure — same pattern Genesis Arbitrage
// (or any site that "just works") uses under the hood.
//
// If the backend is ever unreachable, each loader below falls back to
// the original direct-from-browser call so the app keeps working (with
// the old variability) rather than going fully dark.
// =============================================================
import { fetchJSON } from './api.js';
import { DEFAULT_VERIFY_PROXY_URL } from './state.js';

const MARKET_PROXY_BASE = DEFAULT_VERIFY_PROXY_URL;
const MARKET_CACHE_MS = 2000; // matches the server's own cache window

let marketCache = { data: null, at: 0 };
let marketInFlight = null;

// One shared request feeds all five loaders below. Whichever loader is
// called first in a given scan triggers the real network request; the
// other four (called moments later in the same pass) just read the
// already-resolved result — so a "load every exchange" pass is one round
// trip to our server, not five round trips to five different exchanges.
async function fetchMergedMarkets(){
  const now = Date.now();
  if(marketCache.data && (now - marketCache.at) < MARKET_CACHE_MS) return marketCache.data;
  if(marketInFlight) return marketInFlight;
  marketInFlight = (async () => {
    const data = await fetchJSON(MARKET_PROXY_BASE + '/api/markets');
    marketCache = { data, at: Date.now() };
    return data;
  })();
  try{
    return await marketInFlight;
  } finally {
    marketInFlight = null;
  }
}

async function loadViaProxy(key, directLoader){
  try{
    const merged = await fetchMergedMarkets();
    const entry = merged && merged[key];
    if(entry && entry.ok && Array.isArray(entry.pairs)) return entry.pairs;
    throw new Error((entry && entry.error) || `market proxy returned no ${key} data`);
  }catch(proxyErr){
    console.warn(`Market proxy unavailable for ${key} (${proxyErr.message}) — falling back to a direct call.`);
    return directLoader();
  }
}

async function loadBitgetDirect(){
  const [symbolsRes, tickersRes] = await Promise.all([
    fetchJSON('https://api.bitget.com/api/v2/spot/public/symbols'),
    fetchJSON('https://api.bitget.com/api/v2/spot/market/tickers'),
  ]);
  if(symbolsRes.code !== '00000') throw new Error('symbols: ' + symbolsRes.msg);
  if(tickersRes.code !== '00000') throw new Error('tickers: ' + tickersRes.msg);

  const tickerMap = new Map();
  for(const t of tickersRes.data) tickerMap.set(t.symbol, t);

  const pairs = [];
  for(const s of symbolsRes.data){
    if(s.status !== 'online') continue;
    const t = tickerMap.get(s.symbol);
    if(!t || !t.bidPr || !t.askPr) continue;
    const bid = parseFloat(t.bidPr);
    const ask = parseFloat(t.askPr);
    if(!bid || !ask) continue;
    // bidSz/askSz = size resting at the top of book; quoteVolume = 24h turnover in quote currency
    // close = last traded price — captured only so "Theoretical mode" can reproduce
    // the CLI scanner's last-price/no-spread math for side-by-side comparison.
    pairs.push({
      symbol:s.symbol, base:s.baseCoin, quote:s.quoteCoin, bid, ask,
      last: parseFloat(t.close) || (bid + ask) / 2,
      bidQty: parseFloat(t.bidSz) || 0, askQty: parseFloat(t.askSz) || 0,
      quoteVolume24h: parseFloat(t.quoteVolume) || 0,
    });
  }
  return pairs;
}

// Public coin/network directory — used to flag when Bitget itself has withdrawals
// or deposits disabled for a coin (a hard, verifiable "not transferable" signal).
async function loadBitgetCoinInfoDirect(){
  const res = await fetchJSON('https://api.bitget.com/api/v2/spot/public/coins');
  if(res.code !== '00000') throw new Error('coins: ' + res.msg);
  const map = new Map();
  for(const c of res.data){
    let withdrawable = false, rechargeable = false;
    for(const ch of (c.chains || [])){
      if(ch.withdrawable === 'true') withdrawable = true;
      if(ch.rechargeable === 'true') rechargeable = true;
    }
    map.set(c.coin, { withdrawable, rechargeable });
  }
  return map;
}

async function loadBinanceDirect(){
  const base = 'https://api.binance.com';
  const [infoRes, tickerRes] = await Promise.all([
    fetchJSON(base + '/api/v3/exchangeInfo'),
    fetchJSON(base + '/api/v3/ticker/24hr'),
  ]);
  const tickerMap = new Map();
  for(const t of tickerRes) tickerMap.set(t.symbol, t);

  const pairs = [];
  for(const s of infoRes.symbols){
    if(s.status !== 'TRADING') continue;
    const t = tickerMap.get(s.symbol);
    if(!t || !t.bidPrice || !t.askPrice) continue;
    const bid = parseFloat(t.bidPrice);
    const ask = parseFloat(t.askPrice);
    if(!bid || !ask) continue;
    pairs.push({
      symbol:s.symbol, base:s.baseAsset, quote:s.quoteAsset, bid, ask,
      last: parseFloat(t.lastPrice) || (bid + ask) / 2,
      bidQty: parseFloat(t.bidQty) || 0, askQty: parseFloat(t.askQty) || 0,
      quoteVolume24h: parseFloat(t.quoteVolume) || 0,
    });
  }
  return pairs;
}

async function loadBybitDirect(){
  const base = 'https://api.bybit.com';
  const [infoRes, tickerRes] = await Promise.all([
    fetchJSON(base + '/v5/market/instruments-info?category=spot'),
    fetchJSON(base + '/v5/market/tickers?category=spot'),
  ]);
  if(infoRes.retCode !== 0) throw new Error('instruments: ' + infoRes.retMsg);
  if(tickerRes.retCode !== 0) throw new Error('tickers: ' + tickerRes.retMsg);

  const tickerMap = new Map();
  for(const t of tickerRes.result.list) tickerMap.set(t.symbol, t);

  const pairs = [];
  for(const s of infoRes.result.list){
    if(s.status !== 'Trading') continue;
    const t = tickerMap.get(s.symbol);
    if(!t || !t.bid1Price || !t.ask1Price) continue;
    const bid = parseFloat(t.bid1Price);
    const ask = parseFloat(t.ask1Price);
    if(!bid || !ask) continue;
    pairs.push({
      symbol:s.symbol, base:s.baseCoin, quote:s.quoteCoin, bid, ask,
      last: parseFloat(t.lastPrice) || (bid + ask) / 2,
      bidQty: parseFloat(t.bid1Size) || 0, askQty: parseFloat(t.ask1Size) || 0,
      quoteVolume24h: parseFloat(t.turnover24h) || 0,
    });
  }
  return pairs;
}

// MEXC's Spot API v3 is intentionally modeled on Binance's — same
// exchangeInfo/ticker/24hr shape, same bid/ask-on-the-ticker convenience —
// so this loader mirrors loadBinance() above.
async function loadMexcDirect(){
  const base = 'https://api.mexc.com';
  const [infoRes, tickerRes] = await Promise.all([
    fetchJSON(base + '/api/v3/exchangeInfo'),
    fetchJSON(base + '/api/v3/ticker/24hr'),
  ]);
  const tickerMap = new Map();
  for(const t of tickerRes) tickerMap.set(t.symbol, t);

  const pairs = [];
  for(const s of infoRes.symbols){
    if(s.status !== 'ENABLED' && s.status !== '1') continue; // MEXC has used both a text status and a legacy numeric one across API versions
    const t = tickerMap.get(s.symbol);
    if(!t || !t.bidPrice || !t.askPrice) continue;
    const bid = parseFloat(t.bidPrice);
    const ask = parseFloat(t.askPrice);
    if(!bid || !ask) continue;
    pairs.push({
      symbol:s.symbol, base:s.baseAsset, quote:s.quoteAsset, bid, ask,
      last: parseFloat(t.lastPrice) || (bid + ask) / 2,
      bidQty: parseFloat(t.bidQty) || 0, askQty: parseFloat(t.askQty) || 0,
      quoteVolume24h: parseFloat(t.quoteVolume) || 0,
    });
  }
  return pairs;
}

// Gate.io Spot API v4 — currency_pairs for the tradeable list, tickers for
// live bid/ask + volume. Gate.io uses "BASE_QUOTE" symbols (underscore),
// unlike the concatenated symbols the other three exchanges use.
async function loadGateioDirect(){
  const base = 'https://api.gateio.ws';
  const [pairsRes, tickerRes] = await Promise.all([
    fetchJSON(base + '/api/v4/spot/currency_pairs'),
    fetchJSON(base + '/api/v4/spot/tickers'),
  ]);
  const tickerMap = new Map();
  for(const t of tickerRes) tickerMap.set(t.currency_pair, t);

  const pairs = [];
  for(const s of pairsRes){
    if(s.trade_status !== 'tradable') continue;
    const t = tickerMap.get(s.id);
    if(!t || !t.highest_bid || !t.lowest_ask) continue;
    const bid = parseFloat(t.highest_bid);
    const ask = parseFloat(t.lowest_ask);
    if(!bid || !ask) continue;
    pairs.push({
      symbol:s.id, base:s.base, quote:s.quote, bid, ask,
      last: parseFloat(t.last) || (bid + ask) / 2,
      bidQty: 0, askQty: 0, // Gate.io's tickers endpoint doesn't publish top-of-book size
      quoteVolume24h: parseFloat(t.quote_volume) || 0,
    });
  }
  return pairs;
}

export async function loadBitget(){ return loadViaProxy('bitget', loadBitgetDirect); }
export async function loadBinance(){ return loadViaProxy('binance', loadBinanceDirect); }
export async function loadBybit(){ return loadViaProxy('bybit', loadBybitDirect); }
export async function loadMexc(){ return loadViaProxy('mexc', loadMexcDirect); }
export async function loadGateio(){ return loadViaProxy('gateio', loadGateioDirect); }

export async function loadBitgetCoinInfo(){
  try{
    const res = await fetchJSON(MARKET_PROXY_BASE + '/api/markets/bitget-coins');
    if(!res.ok || !Array.isArray(res.coins)) throw new Error(res.error || 'malformed response');
    const map = new Map();
    for(const c of res.coins) map.set(c.coin, { withdrawable: c.withdrawable, rechargeable: c.rechargeable });
    return map;
  }catch(proxyErr){
    console.warn(`Market proxy unavailable for bitget coin info (${proxyErr.message}) — falling back to a direct call.`);
    return loadBitgetCoinInfoDirect();
  }
}

export const EXCHANGES = {
  bitget:  { label:'Bitget',  load:loadBitget, demoSupported:true, needsPassphrase:true },
  binance: { label:'Binance', load:loadBinance, demoSupported:true },
  bybit:   { label:'Bybit',   load:loadBybit, demoSupported:true },
  mexc:    { label:'MEXC',    load:loadMexc, demoSupported:false },
  gateio:  { label:'Gate.io', load:loadGateio, demoSupported:true },
};

// Direct spot-trading page for a base/quote pair on each exchange — used by
// the Cross-Exchange table's "open on exchange" links. These mirror each
// exchange's documented public URL pattern for a spot pair page (not an API
// call), so a listing/rename on their end could occasionally break one; the
// link still opens the exchange's own trade UI either way, which is where
// the user needed to end up anyway.
export function tradeUrl(exchange, base, quote){
  if(!base || !quote) return null;
  const b = encodeURIComponent(base), q = encodeURIComponent(quote);
  switch(exchange){
    case 'bitget':  return `https://www.bitget.com/spot/${b}${q}`;
    case 'binance': return `https://www.binance.com/en/trade/${b}_${q}?type=spot`;
    case 'bybit':   return `https://www.bybit.com/en/trade/spot/${b}/${q}`;
    case 'mexc':    return `https://www.mexc.com/exchange/${b}_${q}`;
    case 'gateio':  return `https://www.gate.io/trade/${b}_${q}`;
    default: return null;
  }
}

// National fiat currency codes. Exchanges sometimes list fiat on/off-ramp
// markets (e.g. USDT/TRY, USDC/IDR) as regular spot pairs, but these are
// frequently thin, region-restricted, or otherwise not really tradeable the
// way normal crypto-crypto pairs are — which produces cycles that look
// profitable on paper but aren't actually executable. Excluded from the
// routable graph entirely, same as the CLI scanner's FIAT_CURRENCIES set.
export const FIAT_CURRENCIES = new Set([
  "USD","EUR","GBP","JPY","AUD","CAD","CHF","CNY","HKD","NZD",
  "SEK","KRW","SGD","NOK","MXN","INR","RUB","ZAR","TRY","BRL",
  "TWD","DKK","PLN","THB","IDR","HUF","CZK","ILS","CLP","PHP",
  "AED","COP","SAR","MYR","RON","BGN","ARS","VND","UAH","EGP",
  "PKR","BDT","NGN","KES","GHS","QAR","KWD","BHD","OMR","JOD",
  "LKR","MAD","TND","DZD","XOF","XAF","PEN","UYU","PYG","BOB",
  "CRC","GTQ","HNL","NIO","DOP","JMD","TTD","BBD","BSD","BZD",
  "KZT","UZS","AZN","GEL","AMD","MDL","RSD","MKD","ALL","ISK",
  "HRK","BAM","LBP",
]);

// Mirrors detector.py's get_last_prices(): drop fiat on/off-ramp pairs and
// anything whose 24h quote-currency volume can't support a real fill. Runs
// before the graph is built, so a thin/misleading market never produces a
// cycle in the first place — the exact filtering order the CLI scanner uses.
export function filterTriPairs(pairs, minQuoteVolume){
  return pairs.filter(p => {
    if(FIAT_CURRENCIES.has(p.base) || FIAT_CURRENCIES.has(p.quote)) return false;
    if(minQuoteVolume > 0 && (p.quoteVolume24h || 0) < minQuoteVolume) return false;
    return true;
  });
}
