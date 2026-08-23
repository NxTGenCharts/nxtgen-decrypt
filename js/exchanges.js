// =============================================================
// exchanges.js — Bitget / Binance / Bybit loaders and
// exchange-specific normalization. Logic unchanged from the
// original monolithic file.
// =============================================================
import { fetchJSON } from './api.js';

export async function loadBitget(){
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
export async function loadBitgetCoinInfo(){
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

export async function loadBinance(){
  const [infoRes, tickerRes] = await Promise.all([
    fetchJSON('https://api.binance.com/api/v3/exchangeInfo'),
    fetchJSON('https://api.binance.com/api/v3/ticker/24hr'),
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

export async function loadBybit(){
  const [infoRes, tickerRes] = await Promise.all([
    fetchJSON('https://api.bybit.com/v5/market/instruments-info?category=spot'),
    fetchJSON('https://api.bybit.com/v5/market/tickers?category=spot'),
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

export const EXCHANGES = {
  bitget:  { label:'Bitget',  load:loadBitget },
  binance: { label:'Binance', load:loadBinance },
  bybit:   { label:'Bybit',   load:loadBybit },
};

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
