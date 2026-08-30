// =============================================================
// server.js — the backend for the Autotrade & Balances panel.
//
// What this is for: confirming a Binance/Bybit/MEXC/Gate.io/Bitget
// key+secret(+passphrase for Bitget) pair is real, reading its balance,
// and placing the actual orders when Autotrade's real-order-execution
// switch is armed. A browser can't do any of this itself — every one of
// these exchanges rejects cross-origin authenticated requests (CORS), by
// design, from a static front-end. This server exists to make those
// signed requests on the front-end's behalf and hand back the result. It
// also serves the public market-data proxy (see /api/markets below).
//
// What this is NOT: a product, or something that persists keys anywhere
// (no database, no file, no log line contains a key/secret/passphrase).
// It DOES move funds once real order execution is armed client-side —
// treat it as the security-sensitive core of this app, not incidental
// infrastructure, and read this whole file before deploying it.
// =============================================================
import express from 'express';
import cors from 'cors';
import crypto from 'crypto';
import rateLimit from 'express-rate-limit';

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '10kb' }));

// Lock this down to your actual front-end origin(s) in production — a
// comma-separated list, e.g. "https://nxtgendecrypt.site,https://www.nxtgendecrypt.site".
// Left as "*" only for local testing; the README explains why that matters here.
const allowedOrigins = (process.env.ALLOWED_ORIGIN || '*').split(',').map(s => s.trim());
app.use(cors({
  origin: allowedOrigins.includes('*') ? true : allowedOrigins,
  methods: ['GET', 'POST'],
}));

// Basic abuse guard — each caller gets a modest number of verify attempts
// per minute. This is not a substitute for putting this behind your own
// infra-level rate limiting/WAF if you expose it publicly.
app.use('/api/verify', rateLimit({ windowMs: 60_000, max: 20, standardHeaders: true, legacyHeaders: false }));

function hmacSha256Hex(secret, message){
  return crypto.createHmac('sha256', secret).update(message).digest('hex');
}
// Bitget signs with the same HMAC-SHA256 algorithm as Binance/Bybit, but
// base64-encodes the result instead of hex — see bitgetSignedRequest below.
function hmacSha256Base64(secret, message){
  return crypto.createHmac('sha256', secret).update(message).digest('base64');
}

class VerifyRejected extends Error {}

// Base URLs per network. "demo" is each exchange's own separate sandbox
// environment (its own keys, created from that exchange's own Demo/Testnet
// UI) — never the same account as Live. See each exchange's docs:
//   Binance: https://developers.binance.com/docs/binance-spot-api-docs/demo-mode/general-info
//   Bybit:   https://bybit-exchange.github.io/docs/v5/demo
//   Gate.io: https://www.gate.com/docs/developers/apiv4/en/ ("TestNet trading" base URL)
// Bitget is the odd one out: same host as Live, no separate base URL at
// all — demo mode is a request header (paptrading: 1) sent alongside a
// Demo API Key created from Bitget's own Demo Trading UI. See
// bitgetSignedRequest below for where that header gets added.
const BINANCE_BASE = { live: 'https://api.binance.com', demo: 'https://demo-api.binance.com' };
const BYBIT_BASE = { live: 'https://api.bybit.com', demo: 'https://api-demo.bybit.com' };
const GATEIO_BASE = { live: 'https://api.gateio.ws', demo: 'https://api-testnet.gateapi.io' };
const BITGET_BASE = 'https://api.bitget.com';
// MEXC has no public Demo Trading environment — always 'live'.
const MEXC_BASE = { live: 'https://api.mexc.com' };

function sha512Hex(message){
  return crypto.createHash('sha512').update(message).digest('hex');
}
function hmacSha512Hex(secret, message){
  return crypto.createHmac('sha512', secret).update(message).digest('hex');
}

// ---- Binance: GET /api/v3/account, signed with HMAC-SHA256 ----
async function binanceAccount(mode, apiKey, secretKey){
  const base = BINANCE_BASE[mode] || BINANCE_BASE.live;
  const qs = `timestamp=${Date.now()}&recvWindow=5000`;
  const signature = hmacSha256Hex(secretKey, qs);
  const res = await fetch(`${base}/api/v3/account?${qs}&signature=${signature}`, {
    headers: { 'X-MBX-APIKEY': apiKey },
  });
  const data = await res.json().catch(() => null);
  if(!res.ok || (data && typeof data.code === 'number' && data.code < 0)){
    throw new VerifyRejected(data && data.msg ? data.msg : `HTTP ${res.status}`);
  }
  return data;
}
async function verifyBinance(mode, apiKey, secretKey){
  const data = await binanceAccount(mode, apiKey, secretKey);
  const usdt = (data.balances || []).find(b => b.asset === 'USDT');
  return { balance: usdt ? parseFloat(usdt.free) + parseFloat(usdt.locked) : null };
}
// Actual spendable/sellable balance of one asset right now — used to size
// every leg after the first, and every unwind step, instead of trusting
// the previous order's reported fill (which is gross, before whatever fee
// the exchange took out of the asset you just received).
async function binanceAssetBalance(mode, apiKey, secretKey, asset){
  const data = await binanceAccount(mode, apiKey, secretKey);
  const b = (data.balances || []).find(x => x.asset === asset);
  return b ? parseFloat(b.free) : 0;
}

// ---- Bybit v5: GET /v5/account/wallet-balance, signed with HMAC-SHA256 ----
async function bybitWalletBalance(mode, apiKey, secretKey){
  const base = BYBIT_BASE[mode] || BYBIT_BASE.live;
  const timestamp = String(Date.now());
  const recvWindow = '5000';
  const query = 'accountType=UNIFIED';
  const signature = hmacSha256Hex(secretKey, timestamp + apiKey + recvWindow + query);
  const res = await fetch(`${base}/v5/account/wallet-balance?${query}`, {
    headers: {
      'X-BAPI-API-KEY': apiKey,
      'X-BAPI-SIGN': signature,
      'X-BAPI-SIGN-TYPE': '2',
      'X-BAPI-TIMESTAMP': timestamp,
      'X-BAPI-RECV-WINDOW': recvWindow,
    },
  });
  const data = await res.json().catch(() => null);
  if(!res.ok || !data || data.retCode !== 0){
    throw new VerifyRejected(data && data.retMsg ? data.retMsg : `HTTP ${res.status}`);
  }
  return data.result?.list?.[0]?.coin || [];
}
async function verifyBybit(mode, apiKey, secretKey){
  const coins = await bybitWalletBalance(mode, apiKey, secretKey);
  const usdt = coins.find(c => c.coin === 'USDT');
  return { balance: usdt ? parseFloat(usdt.walletBalance) : null };
}
async function bybitAssetBalance(mode, apiKey, secretKey, asset){
  const coins = await bybitWalletBalance(mode, apiKey, secretKey);
  const c = coins.find(x => x.coin === asset);
  // walletBalance, not equity — equity includes unrealized PnL on
  // derivatives that spot can't actually spend.
  return c ? parseFloat(c.walletBalance) : 0;
}

// ---- MEXC Spot v3: GET /api/v3/account, signed exactly like Binance's
// v3 API (MEXC modeled its Spot v3 API on Binance's) — query-string
// HMAC-SHA256, key in the X-MEXC-APIKEY header instead of X-MBX-APIKEY. ----
async function mexcAccount(mode, apiKey, secretKey){
  const base = MEXC_BASE.live;
  const qs = `timestamp=${Date.now()}&recvWindow=5000`;
  const signature = hmacSha256Hex(secretKey, qs);
  const res = await fetch(`${base}/api/v3/account?${qs}&signature=${signature}`, {
    headers: { 'X-MEXC-APIKEY': apiKey },
  });
  const data = await res.json().catch(() => null);
  if(!res.ok || (data && typeof data.code === 'number' && data.code < 0)){
    throw new VerifyRejected(data && data.msg ? data.msg : `HTTP ${res.status}`);
  }
  return data;
}
async function verifyMexc(mode, apiKey, secretKey){
  const data = await mexcAccount(mode, apiKey, secretKey);
  const usdt = (data.balances || []).find(b => b.asset === 'USDT');
  return { balance: usdt ? parseFloat(usdt.free) + parseFloat(usdt.locked) : null };
}
async function mexcAssetBalance(mode, apiKey, secretKey, asset){
  const data = await mexcAccount(mode, apiKey, secretKey);
  const b = (data.balances || []).find(x => x.asset === asset);
  return b ? parseFloat(b.free) : 0;
}

// ---- Gate.io Spot v4: GET /api/v4/spot/accounts, signed with the v4
// scheme — HMAC-SHA512 over METHOD\nPATH\nQUERY\nSHA512(BODY)\nTIMESTAMP,
// sent as KEY/Timestamp/SIGN headers. Docs:
// https://www.gate.io/docs/developers/apiv4/en/#authentication ----
async function gateioSignedRequest(method, path, query, body, apiKey, secretKey, mode){
  const base = GATEIO_BASE[mode] || GATEIO_BASE.live;
  const timestamp = String(Math.floor(Date.now() / 1000));
  const bodyStr = body ? JSON.stringify(body) : '';
  const bodyHash = sha512Hex(bodyStr);
  const signString = `${method}\n${path}\n${query}\n${bodyHash}\n${timestamp}`;
  const sign = hmacSha512Hex(secretKey, signString);
  const res = await fetch(`${base}${path}${query ? '?' + query : ''}`, {
    method,
    headers: {
      KEY: apiKey, Timestamp: timestamp, SIGN: sign,
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: bodyStr } : {}),
  });
  const data = await res.json().catch(() => null);
  if(!res.ok){
    throw new VerifyRejected(data && data.message ? data.message : `HTTP ${res.status}`);
  }
  return data;
}
async function verifyGateio(mode, apiKey, secretKey){
  const accounts = await gateioSignedRequest('GET', '/api/v4/spot/accounts', '', null, apiKey, secretKey, mode);
  const usdt = Array.isArray(accounts) ? accounts.find(a => a.currency === 'USDT') : null;
  return { balance: usdt ? parseFloat(usdt.available) + parseFloat(usdt.locked || 0) : null };
}
async function gateioAssetBalance(mode, apiKey, secretKey, asset){
  const accounts = await gateioSignedRequest('GET', '/api/v4/spot/accounts', `currency=${asset}`, null, apiKey, secretKey, mode);
  const a = Array.isArray(accounts) ? accounts.find(x => x.currency === asset) : null;
  return a ? parseFloat(a.available) : 0;
}

// ---- Bitget Spot v2: GET /api/v2/spot/account/assets, signed with
// Bitget's own scheme — base64(HMAC-SHA256(secretKey, timestamp + METHOD +
// requestPath + "?" + queryString + body)), sent as ACCESS-KEY/ACCESS-SIGN/
// ACCESS-TIMESTAMP/ACCESS-PASSPHRASE headers. Bitget requires a third
// credential (a passphrase set when the API key was created) that none of
// the other four exchanges use — see js/exchanges.js `needsPassphrase`.
// Demo mode adds one header (paptrading: 1) to a Demo API Key's requests;
// see BITGET_BASE above for why there's no separate demo host to switch to.
// Docs: https://www.bitget.com/api-doc/common/signature ----
async function bitgetSignedRequest(method, path, query, body, apiKey, secretKey, passphrase, mode){
  const timestamp = String(Date.now());
  const bodyStr = body ? JSON.stringify(body) : '';
  const prehash = `${timestamp}${method.toUpperCase()}${path}${query ? '?' + query : ''}${bodyStr}`;
  const sign = hmacSha256Base64(secretKey, prehash);
  const headers = {
    'ACCESS-KEY': apiKey, 'ACCESS-SIGN': sign, 'ACCESS-TIMESTAMP': timestamp,
    'ACCESS-PASSPHRASE': passphrase, 'Content-Type': 'application/json', locale: 'en-US',
  };
  if(mode === 'demo') headers.paptrading = '1';
  const res = await fetch(`${BITGET_BASE}${path}${query ? '?' + query : ''}`, {
    method, headers, ...(body ? { body: bodyStr } : {}),
  });
  const data = await res.json().catch(() => null);
  if(!res.ok || !data || data.code !== '00000'){
    throw new VerifyRejected(data && (data.msg || data.message) ? (data.msg || data.message) : `HTTP ${res.status}`);
  }
  return data.data;
}
async function verifyBitget(mode, apiKey, secretKey, passphrase){
  const data = await bitgetSignedRequest('GET', '/api/v2/spot/account/assets', 'coin=USDT', null, apiKey, secretKey, passphrase, mode);
  const usdt = Array.isArray(data) ? data.find(c => String(c.coin || '').toUpperCase() === 'USDT') : null;
  const balance = usdt ? parseFloat(usdt.available || '0') + parseFloat(usdt.frozen || '0') + parseFloat(usdt.locked || '0') : null;
  return { balance };
}
async function bitgetAssetBalance(mode, apiKey, secretKey, asset, passphrase){
  const data = await bitgetSignedRequest('GET', '/api/v2/spot/account/assets', `coin=${asset}`, null, apiKey, secretKey, passphrase, mode);
  const c = Array.isArray(data) ? data.find(x => String(x.coin || '').toUpperCase() === asset.toUpperCase()) : null;
  return c ? parseFloat(c.available || '0') : 0;
}

const ASSET_BALANCE_GETTERS = { binance: binanceAssetBalance, bybit: bybitAssetBalance, mexc: mexcAssetBalance, gateio: gateioAssetBalance, bitget: bitgetAssetBalance };


const VERIFIERS = { binance: verifyBinance, bybit: verifyBybit, mexc: verifyMexc, gateio: verifyGateio, bitget: verifyBitget };

app.post('/api/verify', async (req, res) => {
  const { exchange, mode, apiKey, secretKey, passphrase } = req.body || {};

  // Keys live only in this function's local variables for the lifetime of
  // this one request. Nothing here writes them to disk, a database, or a
  // log — verify that for yourself, this file is short on purpose.
  if(!exchange || !apiKey || !secretKey){
    return res.status(400).json({ verified:false, rejected:false, message:'exchange, apiKey and secretKey are all required.' });
  }
  if(exchange === 'bitget' && !passphrase){
    return res.status(400).json({ verified:false, rejected:false, message:'Bitget also requires the passphrase set when the API key was created.' });
  }
  const verifier = VERIFIERS[exchange];
  if(!verifier){
    return res.status(400).json({ verified:false, rejected:false, message:`No verifier for "${exchange}" — only binance, bybit, mexc, gateio, and bitget are supported.` });
  }
  const netMode = ['live', 'demo'].includes(mode) ? mode : 'live';

  try{
    const result = await verifier(netMode, apiKey, secretKey, passphrase);
    return res.json({ verified:true, rejected:false, balance: result.balance, message:`Confirmed with ${exchange}.` });
  }catch(err){
    if(err instanceof VerifyRejected){
      // The exchange itself said no — this is a real answer, safe to trust.
      return res.json({ verified:false, rejected:true, balance:null, message: err.message });
    }
    // Network error, timeout, exchange outage, etc. — not a verdict on the key.
    return res.json({ verified:false, rejected:false, balance:null, message: `Could not reach ${exchange}: ${err.message}` });
  }
});

// =============================================================
// ORDER EXECUTION — this is the part that moves real funds (Live) or demo
// funds (Demo). Everything above this line is read-only. Read this whole
// block before deploying it; it was written and reviewed against each
// exchange's official docs, but has NOT been executed against a live
// account from this codebase's own testing — there is no substitute for
// you validating it yourself in Demo mode with small amounts first.
//
// Binance and Bybit behave differently after you submit a market order:
//   - Binance's POST /api/v3/order response is synchronous and already
//     contains the fill (executedQty, cummulativeQuoteQty, fills[]).
//   - Bybit's POST /v5/order/create only ACKs that the order was accepted
//     — you must separately poll GET /v5/order/realtime for the actual
//     fill (cumExecQty, cumExecValue, avgPrice, orderStatus). This is
//     documented, not a guess: https://bybit-exchange.github.io/docs/v5/order/create-order
// Getting this distinction wrong means feeding the next leg of a triangle
// a guessed amount instead of what was actually received — so Bybit
// orders below always resolve through the poll before returning.
// =============================================================
app.use('/api/order', rateLimit({ windowMs: 60_000, max: 30, standardHeaders: true, legacyHeaders: false }));

function floorToStep(value, step){
  if(!step || step <= 0) return value;
  const decimals = (String(step).split('.')[1] || '').length;
  const floored = Math.floor(value / step) * step;
  return parseFloat(floored.toFixed(decimals));
}

// ---- Binance: symbol filters (LOT_SIZE step, NOTIONAL minimum) ----
async function binanceSymbolFilters(base, symbol){
  const res = await fetch(`${base}/api/v3/exchangeInfo?symbol=${symbol}`);
  const data = await res.json().catch(() => null);
  const s = data?.symbols?.[0];
  if(!s) throw new Error(`Unknown Binance symbol ${symbol}`);
  const lot = s.filters.find(f => f.filterType === 'LOT_SIZE');
  const notional = s.filters.find(f => f.filterType === 'NOTIONAL' || f.filterType === 'MIN_NOTIONAL');
  return {
    stepSize: lot ? parseFloat(lot.stepSize) : 0,
    minQty: lot ? parseFloat(lot.minQty) : 0,
    minNotional: notional ? parseFloat(notional.minNotional) : 0,
  };
}

// side/amountKind come from the caller: 'quote' means "spend this much of
// the currency I'm converting FROM" (maps to Binance quoteOrderQty, which
// respects LOT_SIZE automatically per Binance's own docs — no manual
// rounding needed for this path). 'base' means "sell exactly this much of
// the base asset I already hold" (needs LOT_SIZE rounding ourselves, since
// we're handing Binance a raw quantity).
async function placeBinanceOrder(mode, apiKey, secretKey, { symbol, side, amountKind, amount }){
  const base = BINANCE_BASE[mode] || BINANCE_BASE.live;
  const params = new URLSearchParams({ symbol, side, type: 'MARKET', timestamp: String(Date.now()), recvWindow: '5000' });

  if(amountKind === 'quote'){
    params.set('quoteOrderQty', amount.toString());
  } else {
    const filters = await binanceSymbolFilters(base, symbol);
    const qty = floorToStep(amount, filters.stepSize || 0.00000001);
    if(qty <= 0 || qty < filters.minQty){
      throw new VerifyRejected(`Amount ${amount} ${symbol} rounds down to ${qty}, below the exchange minimum (${filters.minQty}) — nothing was sent.`);
    }
    params.set('quantity', qty.toString());
  }

  const signature = hmacSha256Hex(secretKey, params.toString());
  params.set('signature', signature);
  const res = await fetch(`${base}/api/v3/order`, {
    method: 'POST',
    headers: { 'X-MBX-APIKEY': apiKey, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  const data = await res.json().catch(() => null);
  if(!res.ok || (data && typeof data.code === 'number' && data.code < 0)){
    throw new VerifyRejected(data && data.msg ? data.msg : `HTTP ${res.status}`);
  }
  if(data.status !== 'FILLED'){
    // Spot MARKET orders on Binance either fill immediately or get
    // rejected — anything else here (e.g. EXPIRED from insufficient
    // liquidity) means we did not receive what we asked for.
    throw new VerifyRejected(`Order did not fully fill (status: ${data.status}). No further legs will be attempted automatically.`);
  }
  return {
    orderId: data.orderId,
    filledBaseQty: parseFloat(data.executedQty),
    filledQuoteQty: parseFloat(data.cummulativeQuoteQty),
    avgPrice: parseFloat(data.executedQty) > 0 ? parseFloat(data.cummulativeQuoteQty) / parseFloat(data.executedQty) : 0,
  };
}

// ---- MEXC: symbol filters. MEXC's v3 exchangeInfo doesn't populate the
// Binance-style filters[] array for most symbols — the base-quantity step
// and minimum notional live directly on the symbol object instead
// (baseSizePrecision, quoteAmountPrecision). Fall back to Binance-style
// filters[] first in case a given symbol does have them, since that's the
// more precise source when present. ----
async function mexcSymbolFilters(base, symbol){
  const res = await fetch(`${base}/api/v3/exchangeInfo?symbol=${symbol}`);
  const data = await res.json().catch(() => null);
  const s = data?.symbols?.[0];
  if(!s) throw new Error(`Unknown MEXC symbol ${symbol}`);
  const lot = (s.filters || []).find(f => f.filterType === 'LOT_SIZE');
  const notional = (s.filters || []).find(f => f.filterType === 'NOTIONAL' || f.filterType === 'MIN_NOTIONAL');
  return {
    stepSize: lot ? parseFloat(lot.stepSize) : parseFloat(s.baseSizePrecision || '0.00000001'),
    minQty: lot ? parseFloat(lot.minQty) : 0,
    minNotional: notional ? parseFloat(notional.minNotional) : parseFloat(s.quoteAmountPrecision || '0'),
  };
}

// MEXC's Spot v3 order endpoint mirrors Binance's (quoteOrderQty for
// spend-this-much-quote, quantity for sell-exactly-this-much-base), signed
// the same way, just under the X-MEXC-APIKEY header.
async function placeMexcOrder(mode, apiKey, secretKey, { symbol, side, amountKind, amount }){
  const base = MEXC_BASE.live;
  const params = new URLSearchParams({ symbol, side, type: 'MARKET', timestamp: String(Date.now()), recvWindow: '5000' });

  if(amountKind === 'quote'){
    params.set('quoteOrderQty', amount.toString());
  } else {
    const filters = await mexcSymbolFilters(base, symbol);
    const qty = floorToStep(amount, filters.stepSize || 0.00000001);
    if(qty <= 0 || qty < filters.minQty){
      throw new VerifyRejected(`Amount ${amount} ${symbol} rounds down to ${qty}, below the exchange minimum (${filters.minQty}) — nothing was sent.`);
    }
    params.set('quantity', qty.toString());
  }

  const signature = hmacSha256Hex(secretKey, params.toString());
  params.set('signature', signature);
  const res = await fetch(`${base}/api/v3/order`, {
    method: 'POST',
    headers: { 'X-MEXC-APIKEY': apiKey, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  const data = await res.json().catch(() => null);
  if(!res.ok || (data && typeof data.code === 'number' && data.code < 0)){
    throw new VerifyRejected(data && data.msg ? data.msg : `HTTP ${res.status}`);
  }
  if(data.status !== 'FILLED'){
    throw new VerifyRejected(`Order did not fully fill (status: ${data.status}). No further legs will be attempted automatically.`);
  }
  return {
    orderId: data.orderId,
    filledBaseQty: parseFloat(data.executedQty),
    filledQuoteQty: parseFloat(data.cummulativeQuoteQty),
    avgPrice: parseFloat(data.executedQty) > 0 ? parseFloat(data.cummulativeQuoteQty) / parseFloat(data.executedQty) : 0,
  };
}
async function bybitSymbolFilters(base, symbol){
  const res = await fetch(`${base}/v5/market/instruments-info?category=spot&symbol=${symbol}`);
  const data = await res.json().catch(() => null);
  const s = data?.result?.list?.[0];
  if(!s) throw new Error(`Unknown Bybit symbol ${symbol}`);
  return {
    basePrecisionStep: parseFloat(s.lotSizeFilter?.basePrecision || '0.00000001'),
    quotePrecisionStep: parseFloat(s.lotSizeFilter?.quotePrecision || '0.00000001'),
    minOrderQty: parseFloat(s.lotSizeFilter?.minOrderQty || '0'),
    minOrderAmt: parseFloat(s.lotSizeFilter?.minOrderAmt || '0'),
  };
}

async function bybitSignedRequest(base, apiKey, secretKey, method, path, bodyOrQuery){
  const timestamp = String(Date.now());
  const recvWindow = '5000';
  const payload = method === 'GET' ? bodyOrQuery : JSON.stringify(bodyOrQuery);
  const signature = hmacSha256Hex(secretKey, timestamp + apiKey + recvWindow + payload);
  const url = method === 'GET' ? `${base}${path}?${bodyOrQuery}` : `${base}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      'X-BAPI-API-KEY': apiKey, 'X-BAPI-SIGN': signature, 'X-BAPI-SIGN-TYPE': '2',
      'X-BAPI-TIMESTAMP': timestamp, 'X-BAPI-RECV-WINDOW': recvWindow,
      ...(method !== 'GET' ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(method !== 'GET' ? { body: payload } : {}),
  });
  const data = await res.json().catch(() => null);
  if(!res.ok || !data || data.retCode !== 0){
    throw new VerifyRejected(data && data.retMsg ? data.retMsg : `HTTP ${res.status}`);
  }
  return data;
}

async function placeBybitOrder(mode, apiKey, secretKey, { symbol, side, amountKind, amount }){
  const base = BYBIT_BASE[mode] || BYBIT_BASE.live;
  // Bybit rejects a market order's qty ("Market order amount decimal too
  // long") if it has more decimal places than the symbol's precision for
  // whichever side you're specifying — basePrecision when qty means base
  // coin, quotePrecision when qty means quote coin (amountKind:'quote').
  // The base-side rounding below was already handled; the quote side was
  // being sent as a raw, unrounded float, which is what was failing here.
  const filters = await bybitSymbolFilters(base, symbol);
  let qty = amount;
  if(amountKind === 'base'){
    qty = floorToStep(amount, filters.basePrecisionStep || 0.00000001);
    if(qty <= 0 || qty < filters.minOrderQty){
      throw new VerifyRejected(`Amount ${amount} ${symbol} rounds down to ${qty}, below the exchange minimum (${filters.minOrderQty}) — nothing was sent.`);
    }
  } else {
    qty = floorToStep(amount, filters.quotePrecisionStep || 0.00000001);
    if(qty <= 0 || qty < filters.minOrderAmt){
      throw new VerifyRejected(`Amount ${amount} ${symbol} rounds down to ${qty}, below the exchange minimum order amount (${filters.minOrderAmt}) — nothing was sent.`);
    }
  }
  const created = await bybitSignedRequest(base, apiKey, secretKey, 'POST', '/v5/order/create', {
    category: 'spot', symbol, side, orderType: 'Market',
    qty: qty.toString(),
    marketUnit: amountKind === 'quote' ? 'quoteCoin' : 'baseCoin',
  });
  const orderId = created.result?.orderId;
  if(!orderId) throw new VerifyRejected('Bybit accepted the order but returned no orderId to confirm the fill with.');

  // Bybit's create-order response is just an ACK — poll for the actual
  // fill. Spot market orders fill almost instantly, but "almost" isn't
  // "always", so this polls briefly rather than assuming.
  const deadline = Date.now() + 6000;
  while(Date.now() < deadline){
    const check = await bybitSignedRequest(base, apiKey, secretKey, 'GET', '/v5/order/realtime', `category=spot&orderId=${orderId}`);
    const order = check.result?.list?.[0];
    if(order && (order.orderStatus === 'Filled')){
      const filledBaseQty = parseFloat(order.cumExecQty);
      const filledQuoteQty = parseFloat(order.cumExecValue);
      return {
        orderId,
        filledBaseQty,
        filledQuoteQty,
        avgPrice: filledBaseQty > 0 ? filledQuoteQty / filledBaseQty : parseFloat(order.avgPrice || '0'),
      };
    }
    if(order && ['Cancelled', 'Rejected', 'Deactivated'].includes(order.orderStatus)){
      throw new VerifyRejected(`Order ${order.orderStatus.toLowerCase()} before filling. No further legs will be attempted automatically.`);
    }
    await new Promise(r => setTimeout(r, 400));
  }
  throw new VerifyRejected(`Order ${orderId} was accepted but did not confirm as Filled within 6s — check Bybit's order history directly before assuming anything about the position.`);
}

// =============================================================
// Bybit Futures (USDT perpetual, category=linear) — for the AI Futures
// Engine's Live/Demo mode. Reuses bybitSignedRequest, BYBIT_BASE, and
// bybitAssetBalance/verifyBybit as-is: Bybit's UNIFIED account holds one
// shared USDT balance across spot AND derivatives, so the same credential
// and the same balance check already built for spot Autotrade cover this
// too — nothing new to connect.
//
// Safety design, stated explicitly because it's the most important
// decision in this section: every order placed here carries its
// stop-loss AND take-profit as native, exchange-side, market-triggered
// orders (tpslMode: 'Full') attached at creation time — Bybit itself
// exits the position, not this server watching prices in a loop. That
// matters because unlike the paper engine (which only "checks" a
// position when its own code happens to run), a real leveraged position
// left unmanaged if this server stops running, the browser tab closes,
// or the network drops would carry open liquidation risk with nothing
// watching it. Native TP/SL means the exchange enforces the exit
// regardless of whether anything of ours is still running.
// =============================================================
async function bybitFuturesSymbolFilters(base, symbol){
  const res = await fetch(`${base}/v5/market/instruments-info?category=linear&symbol=${symbol}`);
  const data = await res.json().catch(() => null);
  const s = data?.result?.list?.[0];
  if(!s) throw new Error(`Unknown Bybit linear symbol ${symbol}`);
  return {
    qtyStep: parseFloat(s.lotSizeFilter?.qtyStep || '0.001'),
    minOrderQty: parseFloat(s.lotSizeFilter?.minOrderQty || '0'),
    minNotionalValue: parseFloat(s.lotSizeFilter?.minNotionalValue || '0'),
    tickSize: parseFloat(s.priceFilter?.tickSize || '0.01'),
    maxLeverage: parseFloat(s.leverageFilter?.maxLeverage || '1'),
  };
}

async function bybitSetLeverage(mode, apiKey, secretKey, symbol, leverage){
  const base = BYBIT_BASE[mode] || BYBIT_BASE.live;
  try{
    await bybitSignedRequest(base, apiKey, secretKey, 'POST', '/v5/position/set-leverage', {
      category: 'linear', symbol, buyLeverage: String(leverage), sellLeverage: String(leverage),
    });
  }catch(err){
    // retCode 110043 "leverage not modified" means it's already set to
    // this value — not a failure, just a no-op. bybitSignedRequest only
    // gives us the message text, so match on that rather than the code.
    if(!/not modified/i.test(err.message)) throw err;
  }
}

// Places a market order with native TP/SL attached, sets leverage first,
// then polls for the fill exactly like placeBybitOrder does for spot
// (Bybit's create-order response is an ACK only, not a fill report).
// side: 'Buy' | 'Sell'. rawQty/rawStopLossPrice/rawTakeProfitPrice are the
// caller's intended values BEFORE rounding — this function rounds qty to
// the symbol's qtyStep and both prices to its tickSize itself (Bybit
// rejects values that don't land on-step), same division of
// responsibility as placeBybitOrder for spot.
async function placeBybitFuturesOrder(mode, apiKey, secretKey, { symbol, side, rawQty, leverage, rawStopLossPrice, rawTakeProfitPrice }){
  const base = BYBIT_BASE[mode] || BYBIT_BASE.live;
  const filters = await bybitFuturesSymbolFilters(base, symbol);

  const qty = floorToStep(rawQty, filters.qtyStep);
  if(qty <= 0 || qty < filters.minOrderQty){
    throw new VerifyRejected(`Size ${rawQty} ${symbol} rounds down to ${qty}, below the exchange minimum (${filters.minOrderQty}) — nothing was sent.`);
  }
  const roundToTick = p => Math.round(p / filters.tickSize) * filters.tickSize;
  const stopLossPrice = roundToTick(rawStopLossPrice);
  const takeProfitPrice = roundToTick(rawTakeProfitPrice);
  const clampedLeverage = Math.min(leverage, filters.maxLeverage);

  await bybitSetLeverage(mode, apiKey, secretKey, symbol, clampedLeverage);

  const created = await bybitSignedRequest(base, apiKey, secretKey, 'POST', '/v5/order/create', {
    category: 'linear', symbol, side, orderType: 'Market', qty: qty.toString(),
    timeInForce: 'IOC', positionIdx: 0, // one-way mode — see note below if this ever rejects
    takeProfit: takeProfitPrice.toString(), stopLoss: stopLossPrice.toString(),
    tpOrderType: 'Market', slOrderType: 'Market', tpslMode: 'Full',
  }).catch(err => {
    // positionIdx:0 is one-way mode, which is what a new/default Bybit
    // derivatives account uses. If this account was switched to hedge
    // mode (separate Buy/Sell position slots), Bybit rejects positionIdx
    // mismatches with a clear error — surface it as-is rather than
    // guessing which hedge-mode slot was meant.
    if(/position idx/i.test(err.message)){
      throw new VerifyRejected(`${err.message} — this account appears to be in hedge mode. Switch it to one-way position mode in Bybit's derivatives settings (this app only supports one-way).`);
    }
    throw err;
  });
  const orderId = created.result?.orderId;
  if(!orderId) throw new VerifyRejected('Bybit accepted the order but returned no orderId to confirm the fill with.');

  const deadline = Date.now() + 6000;
  while(Date.now() < deadline){
    const check = await bybitSignedRequest(base, apiKey, secretKey, 'GET', '/v5/order/realtime', `category=linear&orderId=${orderId}`);
    const order = check.result?.list?.[0];
    if(order && order.orderStatus === 'Filled'){
      const filledQty = parseFloat(order.cumExecQty);
      const avgPrice = parseFloat(order.avgPrice || '0');
      return { orderId, filledQty, avgPrice, feeUsd: parseFloat(order.cumExecFee || '0'), leverage: clampedLeverage, stopLossPrice, takeProfitPrice };
    }
    if(order && ['Cancelled', 'Rejected', 'Deactivated'].includes(order.orderStatus)){
      throw new VerifyRejected(`Order ${order.orderStatus.toLowerCase()} before filling. No position was opened.`);
    }
    await new Promise(r => setTimeout(r, 400));
  }
  throw new VerifyRejected(`Order ${orderId} was accepted but did not confirm as Filled within 6s — check Bybit's order history directly before assuming anything about the position.`);
}

// Reads the live position for one symbol — size:"0" (or no row at all)
// means it's closed, whether that was the native TP, the native SL, or a
// manual close on Bybit's own UI. Used to detect closure from our side;
// the actual exit was already handled exchange-side per the safety note
// above, this is just "has it happened yet".
async function getBybitPosition(mode, apiKey, secretKey, symbol){
  const base = BYBIT_BASE[mode] || BYBIT_BASE.live;
  const data = await bybitSignedRequest(base, apiKey, secretKey, 'GET', '/v5/position/list', `category=linear&symbol=${symbol}`);
  const pos = data.result?.list?.[0];
  if(!pos || parseFloat(pos.size || '0') === 0) return null;
  return {
    size: parseFloat(pos.size), side: pos.side, avgPrice: parseFloat(pos.avgPrice || '0'),
    markPrice: parseFloat(pos.markPrice || '0'), unrealisedPnl: parseFloat(pos.unrealisedPnl || '0'),
    leverage: parseFloat(pos.leverage || '0'), liqPrice: pos.liqPrice ? parseFloat(pos.liqPrice) : null,
  };
}

// Once getBybitPosition reports a symbol closed, this pulls the actual
// realized result for it — the definitive P&L figure (Bybit's own
// closedPnl, which already nets out entry+exit fees) rather than
// something reconstructed from separate fill records.
async function getBybitClosedPnl(mode, apiKey, secretKey, symbol){
  const base = BYBIT_BASE[mode] || BYBIT_BASE.live;
  const data = await bybitSignedRequest(base, apiKey, secretKey, 'GET', '/v5/position/closed-pnl', `category=linear&symbol=${symbol}&limit=1`);
  const row = data.result?.list?.[0];
  if(!row) return null;
  return {
    avgEntryPrice: parseFloat(row.avgEntryPrice || '0'), avgExitPrice: parseFloat(row.avgExitPrice || '0'),
    closedPnl: parseFloat(row.closedPnl || '0'), qty: parseFloat(row.qty || row.closedSize || '0'),
    side: row.side, leverage: parseFloat(row.leverage || '0'),
    createdTime: parseInt(row.createdTime, 10) || null, updatedTime: parseInt(row.updatedTime, 10) || null,
  };
}

// =============================================================
// Real Bybit market data for Live/Demo trading — builds the exact same
// {symbol, price, m5, m15, h1, meta} shape mockMarket.snapshot() produces
// (see that file's header), from real klines + a real ticker, so the
// unmodified scoring/regime/setup logic can run against it. This is what
// makes Live/Demo trading safe to wire up at all — entries, stops, and
// targets are computed from wherever Bybit is actually trading, not from
// the synthetic Paper-mode feed. Always reads from BYBIT_BASE.live
// (public market data is the same whether you go on to trade it in Live
// or Demo mode — only account/order execution differs between the two).
// =============================================================
function bybitCandlesFromKline(raw){
  const list = raw?.result?.list || [];
  // Bybit returns most-recent-first; reverse to oldest-first, matching
  // the {t,o,h,l,c,v} shape every js/futures/*.js module already expects.
  return list.slice().reverse().map(row => ({
    t: parseInt(row[0], 10), o: parseFloat(row[1]), h: parseFloat(row[2]), l: parseFloat(row[3]), c: parseFloat(row[4]), v: parseFloat(row[5]),
  }));
}

async function bybitBuildFuturesSnapshot(symbol){
  const base = BYBIT_BASE.live;
  const [m5Res, m15Res, h1Res, tickerRes] = await Promise.all([
    fetch(`${base}/v5/market/kline?category=linear&symbol=${symbol}&interval=5&limit=150`),
    fetch(`${base}/v5/market/kline?category=linear&symbol=${symbol}&interval=15&limit=150`),
    fetch(`${base}/v5/market/kline?category=linear&symbol=${symbol}&interval=60&limit=80`),
    fetch(`${base}/v5/market/tickers?category=linear&symbol=${symbol}`),
  ]);
  const [m5Data, m15Data, h1Data, tickerData] = await Promise.all([m5Res.json(), m15Res.json(), h1Res.json(), tickerRes.json()]);

  const m5 = bybitCandlesFromKline(m5Data);
  const m15 = bybitCandlesFromKline(m15Data);
  const h1 = bybitCandlesFromKline(h1Data);
  if(m5.length < 30 || m15.length < 20 || h1.length < 10){
    throw new Error(`Not enough Bybit kline history for ${symbol} yet (${m5.length}/${m15.length}/${h1.length} m5/m15/h1 candles).`);
  }

  const t = tickerData?.result?.list?.[0];
  if(!t) throw new Error(`No Bybit ticker data for ${symbol}.`);
  const bid = parseFloat(t.bid1Price || '0'), ask = parseFloat(t.ask1Price || '0'), last = parseFloat(t.lastPrice || '0');
  const spreadPct = (bid > 0 && ask > 0) ? ((ask - bid) / ((ask + bid) / 2)) * 100 : 0.02;
  const volume24hUsd = parseFloat(t.turnover24h || '0');
  // Same formula mockMarket.js uses for its synthetic liquidityScore, applied to a real volume figure.
  const liquidityScore = Math.max(5, Math.min(99, Math.round(40 + 45 * Math.min(1, volume24hUsd / 2.2e9))));
  const fundingRatePct = parseFloat(t.fundingRate || '0') * 100;
  const openInterestUsd = parseFloat(t.openInterestValue || '0');

  return {
    symbol, price: last || m5[m5.length - 1].c,
    m5, m15, h1,
    meta: { spreadPct, volume24hUsd, liquidityScore, fundingRatePct, openInterestUsd },
  };
}

// Short cache + request coalescing, same pattern as getMarketsCached
// above — Live/Demo cycles run every few seconds, but real kline data
// doesn't need refetching that often, and this keeps a handful of
// concurrent app instances from each hammering Bybit's public endpoints
// independently.
const FUTURES_SNAPSHOT_CACHE_TTL_MS = 15_000;
const futuresSnapshotCache = new Map(); // symbol -> { data, at }
const futuresSnapshotInFlight = new Map(); // symbol -> Promise

async function getBybitFuturesSnapshotCached(symbol){
  const now = Date.now();
  const cached = futuresSnapshotCache.get(symbol);
  if(cached && (now - cached.at) < FUTURES_SNAPSHOT_CACHE_TTL_MS) return cached.data;
  if(futuresSnapshotInFlight.has(symbol)) return futuresSnapshotInFlight.get(symbol);
  const p = (async () => {
    const data = await bybitBuildFuturesSnapshot(symbol);
    futuresSnapshotCache.set(symbol, { data, at: Date.now() });
    return data;
  })();
  futuresSnapshotInFlight.set(symbol, p);
  try{
    return await p;
  } finally {
    futuresSnapshotInFlight.delete(symbol);
  }
}

app.use('/api/futures/snapshot', rateLimit({ windowMs: 60_000, max: 120, standardHeaders: true, legacyHeaders: false }));
app.get('/api/futures/snapshot', async (req, res) => {
  const symbol = req.query.symbol;
  if(!symbol) return res.status(400).json({ ok:false, message:'symbol is required.' });
  try{
    const snap = await getBybitFuturesSnapshotCached(String(symbol));
    res.set('Cache-Control', 'public, max-age=10');
    res.json({ ok:true, snapshot: snap });
  }catch(err){
    res.status(502).json({ ok:false, message: `Could not fetch Bybit market data for ${symbol}: ${err.message}` });
  }
});

// ---- Gate.io: currency pair details (precision, minimum amounts) ----
async function gateioSymbolFilters(base, symbol){
  const res = await fetch(`${base}/api/v4/spot/currency_pairs/${symbol}`);
  const s = await res.json().catch(() => null);
  if(!s || !s.id) throw new Error(`Unknown Gate.io pair ${symbol}`);
  return {
    amountPrecision: parseInt(s.amount_precision, 10) || 8,   // base-side decimal places
    minBaseAmount: parseFloat(s.min_base_amount || '0'),
    minQuoteAmount: parseFloat(s.min_quote_amount || '0'),
  };
}

function floorToDecimals(value, decimals){
  const factor = Math.pow(10, decimals);
  return Math.floor(value * factor) / factor;
}

// Gate.io market orders are IOC (immediate-or-cancel) and take a single
// "amount" field whose meaning flips with side: for a market BUY, amount is
// the quote currency to spend (mirrors Binance's quoteOrderQty); for a
// market SELL, amount is the base currency to sell. There is no separate
// "quoteOrderQty" parameter the way Binance/MEXC have one, so amountKind
// here maps straight onto that side-dependent meaning rather than a
// distinct API field.
// Docs: https://www.gate.io/docs/developers/apiv4/en/#create-an-order
async function placeGateioOrder(mode, apiKey, secretKey, { symbol, side, amountKind, amount }){
  const base = GATEIO_BASE[mode] || GATEIO_BASE.live;
  const gateSide = side.toLowerCase(); // 'buy' | 'sell'
  let sendAmount = amount;
  if(amountKind === 'base'){
    const filters = await gateioSymbolFilters(base, symbol);
    sendAmount = floorToDecimals(amount, filters.amountPrecision);
    const floorAgainst = gateSide === 'buy' ? filters.minQuoteAmount : filters.minBaseAmount;
    if(sendAmount <= 0 || sendAmount < floorAgainst){
      throw new VerifyRejected(`Amount ${amount} ${symbol} rounds down to ${sendAmount}, below the exchange minimum (${floorAgainst}) — nothing was sent.`);
    }
  }
  // amountKind:'quote' is only ever used for the BUY leg with a plain
  // quote-currency spend amount, which is exactly what Gate.io's "amount"
  // already means for a market buy — no rounding needed there, same as
  // Binance's quoteOrderQty path.

  const created = await gateioSignedRequest('POST', '/api/v4/spot/orders', '', {
    currency_pair: symbol, side: gateSide, type: 'market',
    account: 'spot', time_in_force: 'ioc',
    amount: sendAmount.toString(),
  }, apiKey, secretKey, mode);

  const orderId = created.id;
  if(!orderId) throw new VerifyRejected('Gate.io accepted the order but returned no id to confirm the fill with.');
  if(created.status !== 'closed'){
    throw new VerifyRejected(`Order did not fully fill (status: ${created.status}). No further legs will be attempted automatically.`);
  }
  const filledBaseQty = parseFloat(created.filled_amount || created.amount || '0');
  const filledQuoteQty = parseFloat(created.filled_total || '0');
  return {
    orderId,
    filledBaseQty,
    filledQuoteQty,
    avgPrice: filledBaseQty > 0 ? filledQuoteQty / filledBaseQty : parseFloat(created.avg_deal_price || '0'),
  };
}

// ---- Bitget: symbol precision (base-side decimal places, minimum trade
// amount, minimum USDT notional). Same endpoint the market-data proxy
// already uses (fetchBitgetMarkets below) — public, live-only, no mode
// needed since Bitget's demo mode shares Live's host and market data. ----
async function bitgetSymbolFilters(symbol){
  const res = await fetch(`${BITGET_BASE}/api/v2/spot/public/symbols?symbol=${symbol}`);
  const data = await res.json().catch(() => null);
  const s = data && Array.isArray(data.data) ? data.data[0] : null;
  if(!s) throw new Error(`Unknown Bitget pair ${symbol}`);
  return {
    quantityPrecision: parseInt(s.quantityPrecision, 10) || 6,
    minTradeAmount: parseFloat(s.minTradeAmount || '0'),
    minTradeUSDT: parseFloat(s.minTradeUSDT || '0'),
  };
}

// Bitget's market orders follow the same side-dependent "size" convention
// as Binance/MEXC/Gate.io: for a market BUY, size is the quote amount to
// spend; for a market SELL, size is the base amount to sell.
//
// The one genuinely different thing about Bitget here: place-order's
// response is just `{orderId, clientOid}` — no fill data at all, unlike
// every other exchange in this file, which return executed
// quantity/price synchronously. Bitget's own Best Practices Guide says as
// much: "the order may not have reached the matching system yet, and
// users need to further check the order status for confirmation." So
// this polls GET /api/v2/spot/trade/orderInfo after placing until it
// reports filled (or we give up) — a market order on a liquid pair
// should resolve in well under a second, but there is a real, new-to-
// this-exchange failure mode here that the other four don't have: an
// order that filled but hasn't been confirmed as such within the poll
// window comes back as a thrown error, which the caller (executeCycleReal)
// treats as a failed leg and attempts to unwind. That's the safe
// direction to fail in — but a genuinely slow confirmation could trigger
// an unwind against an order that actually did fill, worth knowing before
// trusting this with real size.
async function placeBitgetOrder(mode, apiKey, secretKey, { symbol, side, amountKind, amount }, passphrase){
  const bgSide = side.toLowerCase(); // 'buy' | 'sell'
  let sendSize = amount;
  if(amountKind === 'base'){
    const filters = await bitgetSymbolFilters(symbol);
    sendSize = floorToDecimals(amount, filters.quantityPrecision);
    if(sendSize <= 0 || sendSize < filters.minTradeAmount){
      throw new VerifyRejected(`Amount ${amount} ${symbol} rounds down to ${sendSize}, below the exchange minimum (${filters.minTradeAmount}) — nothing was sent.`);
    }
  }
  // amountKind:'quote' (the BUY leg) is exactly what Bitget's market-buy
  // "size" already means — no rounding needed there.

  const placed = await bitgetSignedRequest('POST', '/api/v2/spot/trade/place-order', '', {
    symbol, side: bgSide, orderType: 'market', force: 'gtc', size: sendSize.toString(),
  }, apiKey, secretKey, passphrase, mode);
  const orderId = placed && placed.orderId;
  if(!orderId) throw new VerifyRejected('Bitget accepted the order but returned no id to confirm the fill with.');

  const POLL_ATTEMPTS = 6, POLL_DELAY_MS = 400;
  let info = null;
  for(let i = 0; i < POLL_ATTEMPTS; i++){
    await new Promise(r => setTimeout(r, POLL_DELAY_MS));
    const orderInfoData = await bitgetSignedRequest('GET', '/api/v2/spot/trade/orderInfo', `orderId=${orderId}`, null, apiKey, secretKey, passphrase, mode);
    info = Array.isArray(orderInfoData) ? orderInfoData[0] : orderInfoData;
    if(info && (info.status === 'filled' || info.status === 'cancelled' || info.status === 'rejected')) break;
  }
  if(!info || info.status !== 'filled'){
    throw new VerifyRejected(`Order placed (id ${orderId}) but did not confirm as filled within ${(POLL_ATTEMPTS * POLL_DELAY_MS / 1000).toFixed(1)}s (status: ${info ? info.status : 'unknown'}). No further legs will be attempted automatically.`);
  }
  const filledBaseQty = parseFloat(info.baseVolume || '0');
  const filledQuoteQty = parseFloat(info.quoteVolume || '0');
  return {
    orderId,
    filledBaseQty,
    filledQuoteQty,
    avgPrice: filledBaseQty > 0 ? filledQuoteQty / filledBaseQty : parseFloat(info.priceAvg || '0'),
  };
}

const ORDER_PLACERS = { binance: placeBinanceOrder, bybit: placeBybitOrder, mexc: placeMexcOrder, gateio: placeGateioOrder, bitget: placeBitgetOrder };

app.post('/api/order', async (req, res) => {
  const { exchange, mode, apiKey, secretKey, symbol, side, amountKind, amount, passphrase } = req.body || {};
  if(!exchange || !apiKey || !secretKey || !symbol || !side || !amountKind || !amount){
    return res.status(400).json({ ok:false, message:'exchange, mode, apiKey, secretKey, symbol, side, amountKind and amount are all required.' });
  }
  if(exchange === 'bitget' && !passphrase){
    return res.status(400).json({ ok:false, message:'Bitget also requires the passphrase set when the API key was created.' });
  }
  const placer = ORDER_PLACERS[exchange];
  if(!placer){
    return res.status(400).json({ ok:false, message:`No order placer for "${exchange}" — only binance, bybit, mexc, gateio, and bitget are supported.` });
  }
  const netMode = ['live', 'demo'].includes(mode) ? mode : 'live';
  // Binance and MEXC both want 'BUY'/'SELL'; Bybit wants 'Buy'/'Sell';
  // Gate.io and Bitget want lowercase 'buy'/'sell' (both re-lowercase
  // regardless, but keep this table honest for the exchanges that DO care).
  const normalizedSide = (exchange === 'binance' || exchange === 'mexc')
    ? String(side).toUpperCase()
    : (exchange === 'gateio' || exchange === 'bitget')
      ? String(side).toLowerCase()
      : (String(side)[0].toUpperCase() + String(side).slice(1).toLowerCase());

  try{
    const result = await placer(netMode, apiKey, secretKey, { symbol, side: normalizedSide, amountKind, amount: parseFloat(amount) }, passphrase);
    return res.json({ ok:true, ...result });
  }catch(err){
    if(err instanceof VerifyRejected){
      return res.json({ ok:false, rejected:true, message: err.message });
    }
    return res.json({ ok:false, rejected:false, message: `Could not complete order on ${exchange}: ${err.message}` });
  }
});

// ---- Futures (leveraged) order execution — separate route family from
// spot's /api/order above, since a futures order needs leverage, native
// TP/SL prices, and a directional Buy/Sell rather than a base/quote
// amount split. Only Bybit is wired up right now (the AI Futures Engine's
// first live/demo integration); the exchange-keyed maps below are set up
// so extending to the others later is additive, not a rewrite. ----
const FUTURES_ORDER_PLACERS = { bybit: placeBybitFuturesOrder };
const FUTURES_POSITION_GETTERS = { bybit: getBybitPosition };
const FUTURES_CLOSED_PNL_GETTERS = { bybit: getBybitClosedPnl };

app.post('/api/futures/order', async (req, res) => {
  const { exchange, mode, apiKey, secretKey, symbol, side, qty, leverage, stopLossPrice, takeProfitPrice, passphrase } = req.body || {};
  if(!exchange || !apiKey || !secretKey || !symbol || !side || !qty || !leverage || !stopLossPrice || !takeProfitPrice){
    return res.status(400).json({ ok:false, message:'exchange, mode, apiKey, secretKey, symbol, side, qty, leverage, stopLossPrice, and takeProfitPrice are all required — every futures order this app places carries a stop-loss and take-profit from the moment it opens, no exceptions.' });
  }
  const placer = FUTURES_ORDER_PLACERS[exchange];
  if(!placer){
    return res.status(400).json({ ok:false, message:`No futures order placer for "${exchange}" yet — only bybit is supported so far.` });
  }
  const netMode = ['live', 'demo'].includes(mode) ? mode : 'live';
  const normalizedSide = String(side)[0].toUpperCase() + String(side).slice(1).toLowerCase(); // Bybit wants 'Buy' | 'Sell'

  try{
    const result = await placer(netMode, apiKey, secretKey, {
      symbol, side: normalizedSide, rawQty: parseFloat(qty), leverage: parseFloat(leverage),
      rawStopLossPrice: parseFloat(stopLossPrice), rawTakeProfitPrice: parseFloat(takeProfitPrice),
    }, passphrase);
    return res.json({ ok:true, ...result });
  }catch(err){
    if(err instanceof VerifyRejected){
      return res.json({ ok:false, rejected:true, message: err.message });
    }
    return res.json({ ok:false, rejected:false, message: `Could not open futures position on ${exchange}: ${err.message}` });
  }
});

app.post('/api/futures/position', async (req, res) => {
  const { exchange, mode, apiKey, secretKey, symbol, passphrase } = req.body || {};
  if(!exchange || !apiKey || !secretKey || !symbol){
    return res.status(400).json({ ok:false, message:'exchange, mode, apiKey, secretKey, and symbol are all required.' });
  }
  const positionGetter = FUTURES_POSITION_GETTERS[exchange];
  const closedPnlGetter = FUTURES_CLOSED_PNL_GETTERS[exchange];
  if(!positionGetter){
    return res.status(400).json({ ok:false, message:`No futures position getter for "${exchange}" yet — only bybit is supported so far.` });
  }
  const netMode = ['live', 'demo'].includes(mode) ? mode : 'live';
  try{
    const open = await positionGetter(netMode, apiKey, secretKey, symbol, passphrase);
    if(open){
      return res.json({ ok:true, open: true, position: open });
    }
    // Not open anymore — pull the realized result, if we can, so the
    // caller can record what actually happened rather than just "it's gone".
    const closed = closedPnlGetter ? await closedPnlGetter(netMode, apiKey, secretKey, symbol, passphrase).catch(() => null) : null;
    return res.json({ ok:true, open: false, closed });
  }catch(err){
    if(err instanceof VerifyRejected){
      return res.json({ ok:false, rejected:true, message: err.message });
    }
    return res.json({ ok:false, rejected:false, message: `Could not read ${symbol} position on ${exchange}: ${err.message}` });
  }
});

// =============================================================
// Market data — Bitget/Binance/Bybit/MEXC/Gate.io tickers, fetched
// server-side and merged into one response.
//
// Why this exists: the front-end used to call each exchange's public
// REST API directly from the browser, one after another. Two problems
// came from that: (1) sequential requests meant one slow exchange
// stalled every exchange queued behind it, and (2) Binance/MEXC's
// public endpoints are reachable inconsistently depending on the
// caller's network/ISP/VPN/region — so "connected" behaved differently
// on every device. Doing the fetch here instead means it always runs
// from the same server, in parallel, regardless of which device or
// network the person is on — the front-end just asks this one endpoint
// and gets a consistent answer every time.
// =============================================================
async function fetchJSON(url, timeoutMs = 10_000){
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try{
    const res = await fetch(url, { signal: ctrl.signal });
    if(!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchBitgetMarkets(){
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
    const bid = parseFloat(t.bidPr), ask = parseFloat(t.askPr);
    if(!bid || !ask) continue;
    pairs.push({
      symbol:s.symbol, base:s.baseCoin, quote:s.quoteCoin, bid, ask,
      last: parseFloat(t.close) || (bid + ask) / 2,
      bidQty: parseFloat(t.bidSz) || 0, askQty: parseFloat(t.askSz) || 0,
      quoteVolume24h: parseFloat(t.quoteVolume) || 0,
    });
  }
  return pairs;
}

async function fetchBinanceMarkets(){
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
    const bid = parseFloat(t.bidPrice), ask = parseFloat(t.askPrice);
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

async function fetchBybitMarkets(){
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
    const bid = parseFloat(t.bid1Price), ask = parseFloat(t.ask1Price);
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

async function fetchMexcMarkets(){
  const base = 'https://api.mexc.com';
  const [infoRes, tickerRes] = await Promise.all([
    fetchJSON(base + '/api/v3/exchangeInfo'),
    fetchJSON(base + '/api/v3/ticker/24hr'),
  ]);
  const tickerMap = new Map();
  for(const t of tickerRes) tickerMap.set(t.symbol, t);
  const pairs = [];
  for(const s of infoRes.symbols){
    if(s.status !== 'ENABLED' && s.status !== '1') continue;
    const t = tickerMap.get(s.symbol);
    if(!t || !t.bidPrice || !t.askPrice) continue;
    const bid = parseFloat(t.bidPrice), ask = parseFloat(t.askPrice);
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

async function fetchGateioMarkets(){
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
    const bid = parseFloat(t.highest_bid), ask = parseFloat(t.lowest_ask);
    if(!bid || !ask) continue;
    pairs.push({
      symbol:s.id, base:s.base, quote:s.quote, bid, ask,
      last: parseFloat(t.last) || (bid + ask) / 2,
      bidQty: 0, askQty: 0,
      quoteVolume24h: parseFloat(t.quote_volume) || 0,
    });
  }
  return pairs;
}

const MARKET_LOADERS = {
  bitget: fetchBitgetMarkets, binance: fetchBinanceMarkets, bybit: fetchBybitMarkets,
  mexc: fetchMexcMarkets, gateio: fetchGateioMarkets,
};

// Shared, in-memory, short-lived cache — every device hitting this server
// within the TTL gets the same already-fetched data instead of triggering
// its own round trip to five exchanges. inFlight coalesces concurrent
// requests that land while a fetch is already running, so a burst of
// simultaneous callers still only ever causes one upstream fetch per exchange.
const MARKET_CACHE_TTL_MS = 3000;
let marketCache = { data: null, at: 0 };
let marketInFlight = null;

async function getMarketsCached(){
  const now = Date.now();
  if(marketCache.data && (now - marketCache.at) < MARKET_CACHE_TTL_MS) return marketCache.data;
  if(marketInFlight) return marketInFlight;
  marketInFlight = (async () => {
    const keys = Object.keys(MARKET_LOADERS);
    const settled = await Promise.allSettled(keys.map(k => MARKET_LOADERS[k]()));
    const out = { fetchedAt: Date.now() };
    keys.forEach((k, i) => {
      const r = settled[i];
      out[k] = r.status === 'fulfilled'
        ? { ok: true, pairs: r.value }
        : { ok: false, error: String((r.reason && r.reason.message) || r.reason) };
    });
    marketCache = { data: out, at: Date.now() };
    return out;
  })();
  try{
    return await marketInFlight;
  } finally {
    marketInFlight = null;
  }
}

app.use('/api/markets', rateLimit({ windowMs: 60_000, max: 120, standardHeaders: true, legacyHeaders: false }));
app.get('/api/markets', async (req, res) => {
  try{
    const data = await getMarketsCached();
    res.set('Cache-Control', 'public, max-age=2');
    res.json(data);
  }catch(err){
    res.status(502).json({ error: 'Could not fetch market data: ' + err.message });
  }
});

// Bitget's coin/network directory (withdraw/deposit flags for D/W badges).
// Changes rarely, so this gets a much longer cache TTL than tickers.
const COININFO_CACHE_TTL_MS = 10 * 60 * 1000;
let coinInfoCache = { data: null, at: 0 };
async function getBitgetCoinInfoCached(){
  const now = Date.now();
  if(coinInfoCache.data && (now - coinInfoCache.at) < COININFO_CACHE_TTL_MS) return coinInfoCache.data;
  const res = await fetchJSON('https://api.bitget.com/api/v2/spot/public/coins');
  if(res.code !== '00000') throw new Error('coins: ' + res.msg);
  const list = res.data.map(c => {
    let withdrawable = false, rechargeable = false;
    for(const ch of (c.chains || [])){
      if(ch.withdrawable === 'true') withdrawable = true;
      if(ch.rechargeable === 'true') rechargeable = true;
    }
    return { coin: c.coin, withdrawable, rechargeable };
  });
  coinInfoCache = { data: list, at: Date.now() };
  return list;
}
app.get('/api/markets/bitget-coins', async (req, res) => {
  try{
    const list = await getBitgetCoinInfoCached();
    res.set('Cache-Control', 'public, max-age=60');
    res.json({ ok: true, coins: list });
  }catch(err){
    res.status(502).json({ ok: false, error: 'Could not fetch coin info: ' + err.message });
  }
});

app.get('/api/health', (req, res) => res.json({ ok:true }));

// ---- Actual current balance of ONE asset — ground truth for sizing any
// leg after the first, and any unwind step. Never re-derive from a prior
// order's reported fill; fees come out of the asset you just received and
// the previous leg's response doesn't tell you that. ----
app.use('/api/balance', rateLimit({ windowMs: 60_000, max: 60, standardHeaders: true, legacyHeaders: false }));
app.post('/api/balance', async (req, res) => {
  const { exchange, mode, apiKey, secretKey, asset, passphrase } = req.body || {};
  if(!exchange || !apiKey || !secretKey || !asset){
    return res.status(400).json({ ok:false, message:'exchange, apiKey, secretKey and asset are all required.' });
  }
  const getter = ASSET_BALANCE_GETTERS[exchange];
  if(!getter){
    return res.status(400).json({ ok:false, message:`No balance getter for "${exchange}" — only binance, bybit, mexc, gateio, and bitget are supported.` });
  }
  const netMode = ['live', 'demo'].includes(mode) ? mode : 'live';
  try{
    const balance = await getter(netMode, apiKey, secretKey, asset, passphrase);
    return res.json({ ok:true, balance });
  }catch(err){
    if(err instanceof VerifyRejected){
      return res.json({ ok:false, rejected:true, message: err.message });
    }
    return res.json({ ok:false, rejected:false, message: `Could not fetch ${asset} balance on ${exchange}: ${err.message}` });
  }
});

app.use((err, req, res, next) => {
  console.error('Unhandled error:', err.message); // never log req.body here
  res.status(500).json({ verified:false, rejected:false, message:'Internal error.' });
});

const port = process.env.PORT || 8787;
app.listen(port, () => console.log(`nxtgen-verify-proxy listening on :${port}`));
