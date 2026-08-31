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

// ---- Binance USDⓈ-M real market data — same shape, klines are already
// chronological (unlike Bybit's, which need reversing) and interval
// strings are "5m"/"15m"/"1h" rather than raw minute counts. ----
function binanceCandlesFromKline(raw){
  if(!Array.isArray(raw)) return [];
  return raw.map(row => ({
    t: row[0], o: parseFloat(row[1]), h: parseFloat(row[2]), l: parseFloat(row[3]), c: parseFloat(row[4]), v: parseFloat(row[5]),
  }));
}
async function binanceBuildFuturesSnapshot(symbol){
  const base = BINANCE_FAPI_BASE.live; // public market data — same regardless of Live/Demo trading mode
  const [m5Res, m15Res, h1Res, bookRes, premiumRes, tickerRes] = await Promise.all([
    fetch(`${base}/fapi/v1/klines?symbol=${symbol}&interval=5m&limit=150`),
    fetch(`${base}/fapi/v1/klines?symbol=${symbol}&interval=15m&limit=150`),
    fetch(`${base}/fapi/v1/klines?symbol=${symbol}&interval=1h&limit=80`),
    fetch(`${base}/fapi/v1/ticker/bookTicker?symbol=${symbol}`),
    fetch(`${base}/fapi/v1/premiumIndex?symbol=${symbol}`),
    fetch(`${base}/fapi/v1/ticker/24hr?symbol=${symbol}`),
  ]);
  const [m5Raw, m15Raw, h1Raw, book, premium, ticker24h] = await Promise.all([
    m5Res.json(), m15Res.json(), h1Res.json(), bookRes.json(), premiumRes.json(), tickerRes.json(),
  ]);

  const m5 = binanceCandlesFromKline(m5Raw);
  const m15 = binanceCandlesFromKline(m15Raw);
  const h1 = binanceCandlesFromKline(h1Raw);
  if(m5.length < 30 || m15.length < 20 || h1.length < 10){
    throw new Error(`Not enough Binance kline history for ${symbol} yet (${m5.length}/${m15.length}/${h1.length} m5/m15/h1 candles).`);
  }
  if(!book || !book.bidPrice) throw new Error(`No Binance book ticker data for ${symbol}.`);

  const bid = parseFloat(book.bidPrice || '0'), ask = parseFloat(book.askPrice || '0');
  const spreadPct = (bid > 0 && ask > 0) ? ((ask - bid) / ((ask + bid) / 2)) * 100 : 0.02;
  const volume24hUsd = parseFloat(ticker24h?.quoteVolume || '0');
  const liquidityScore = Math.max(5, Math.min(99, Math.round(40 + 45 * Math.min(1, volume24hUsd / 2.2e9))));
  const fundingRatePct = parseFloat(premium?.lastFundingRate || '0') * 100;
  const last = parseFloat(premium?.markPrice || ticker24h?.lastPrice || '0');

  return {
    symbol, price: last || m5[m5.length - 1].c,
    m5, m15, h1,
    meta: { spreadPct, volume24hUsd, liquidityScore, fundingRatePct, openInterestUsd: 0 },
  };
}

// ---- Gate.io USDT-M real market data. Candlestick objects are already
// chronological and use short keys ({t,o,h,l,c,v}) that happen to
// already match this app's own candle shape almost exactly. ----
function gateioCandlesFromKline(raw){
  if(!Array.isArray(raw)) return [];
  return raw.map(row => ({
    t: (parseInt(row.t, 10) || 0) * 1000, o: parseFloat(row.o), h: parseFloat(row.h), l: parseFloat(row.l), c: parseFloat(row.c), v: parseFloat(row.v),
  }));
}
async function gateioBuildFuturesSnapshot(symbol){
  const base = GATEIO_FAPI_BASE.live; // public market data — same regardless of Live/Demo trading mode
  const contract = toGateioContract(symbol);
  const [m5Res, m15Res, h1Res, tickerRes] = await Promise.all([
    fetch(`${base}/api/v4/futures/usdt/candlesticks?contract=${contract}&interval=5m&limit=150`),
    fetch(`${base}/api/v4/futures/usdt/candlesticks?contract=${contract}&interval=15m&limit=150`),
    fetch(`${base}/api/v4/futures/usdt/candlesticks?contract=${contract}&interval=1h&limit=80`),
    fetch(`${base}/api/v4/futures/usdt/tickers?contract=${contract}`),
  ]);
  const [m5Raw, m15Raw, h1Raw, tickerRaw] = await Promise.all([m5Res.json(), m15Res.json(), h1Res.json(), tickerRes.json()]);

  const m5 = gateioCandlesFromKline(m5Raw);
  const m15 = gateioCandlesFromKline(m15Raw);
  const h1 = gateioCandlesFromKline(h1Raw);
  if(m5.length < 30 || m15.length < 20 || h1.length < 10){
    throw new Error(`Not enough Gate.io kline history for ${symbol} yet (${m5.length}/${m15.length}/${h1.length} m5/m15/h1 candles).`);
  }
  const t = Array.isArray(tickerRaw) ? tickerRaw[0] : tickerRaw;
  if(!t) throw new Error(`No Gate.io ticker data for ${symbol}.`);

  const bid = parseFloat(t.highest_bid || '0'), ask = parseFloat(t.lowest_ask || '0');
  const last = parseFloat(t.last || '0');
  const spreadPct = (bid > 0 && ask > 0) ? ((ask - bid) / ((ask + bid) / 2)) * 100 : 0.02;
  const volume24hUsd = parseFloat(t.volume_24h_quote || t.volume_24h_settle || '0');
  const liquidityScore = Math.max(5, Math.min(99, Math.round(40 + 45 * Math.min(1, volume24hUsd / 2.2e9))));
  const fundingRatePct = parseFloat(t.funding_rate || '0') * 100;

  return {
    symbol, price: last || m5[m5.length - 1].c,
    m5, m15, h1,
    meta: { spreadPct, volume24hUsd, liquidityScore, fundingRatePct, openInterestUsd: 0 },
  };
}


// Short cache + request coalescing, same pattern as getMarketsCached
// above — Live/Demo cycles run every few seconds, but real kline data
// doesn't need refetching that often, and this keeps a handful of
// concurrent app instances from each hammering an exchange's public
// endpoints independently. Keyed by exchange+symbol since the same
// symbol string can mean different things (or just different data) on
// different exchanges.
// ---- MEXC Futures real market data. Kline response is COLUMNAR (parallel
// arrays: time[], open[], high[], low[], close[], vol[]) rather than an
// array of candle objects like every other exchange here — needs zipping
// into the shared {t,o,h,l,c,v} shape. ----
function mexcCandlesFromKline(raw){
  if(!raw || !Array.isArray(raw.time)) return [];
  const out = [];
  for(let i = 0; i < raw.time.length; i++){
    out.push({ t: raw.time[i] * 1000, o: raw.open[i], h: raw.high[i], l: raw.low[i], c: raw.close[i], v: raw.vol[i] });
  }
  return out;
}
async function mexcBuildFuturesSnapshot(symbol){
  const contract = toMexcContract(symbol);
  const [m5Res, m15Res, h1Res, tickerRes] = await Promise.all([
    fetch(`${MEXC_FAPI_BASE}/api/v1/contract/kline/${contract}?interval=Min5`),
    fetch(`${MEXC_FAPI_BASE}/api/v1/contract/kline/${contract}?interval=Min15`),
    fetch(`${MEXC_FAPI_BASE}/api/v1/contract/kline/${contract}?interval=Min60`),
    fetch(`${MEXC_FAPI_BASE}/api/v1/contract/ticker?symbol=${contract}`),
  ]);
  const [m5Data, m15Data, h1Data, tickerData] = await Promise.all([m5Res.json(), m15Res.json(), h1Res.json(), tickerRes.json()]);

  const m5 = mexcCandlesFromKline(m5Data && m5Data.data);
  const m15 = mexcCandlesFromKline(m15Data && m15Data.data);
  const h1 = mexcCandlesFromKline(h1Data && h1Data.data);
  if(m5.length < 30 || m15.length < 20 || h1.length < 10){
    throw new Error(`Not enough MEXC kline history for ${symbol} yet (${m5.length}/${m15.length}/${h1.length} m5/m15/h1 candles).`);
  }
  const t = tickerData && tickerData.data;
  if(!t) throw new Error(`No MEXC ticker data for ${symbol}.`);

  const bid = parseFloat(t.bid1 || '0'), ask = parseFloat(t.ask1 || '0');
  const spreadPct = (bid > 0 && ask > 0) ? ((ask - bid) / ((ask + bid) / 2)) * 100 : 0.02;
  const volume24hUsd = parseFloat(t.amount24 || '0'); // already quote-currency turnover
  const liquidityScore = Math.max(5, Math.min(99, Math.round(40 + 45 * Math.min(1, volume24hUsd / 2.2e9))));
  const fundingRatePct = parseFloat(t.fundingRate || '0') * 100;
  const last = parseFloat(t.lastPrice || t.fairPrice || '0');

  return {
    symbol, price: last || m5[m5.length - 1].c,
    m5, m15, h1,
    meta: { spreadPct, volume24hUsd, liquidityScore, fundingRatePct, openInterestUsd: 0 },
  };
}

const FUTURES_SNAPSHOT_BUILDERS = { bybit: bybitBuildFuturesSnapshot, binance: binanceBuildFuturesSnapshot, gateio: gateioBuildFuturesSnapshot, mexc: mexcBuildFuturesSnapshot };
const FUTURES_SNAPSHOT_CACHE_TTL_MS = 15_000;
const futuresSnapshotCache = new Map(); // "exchange:symbol" -> { data, at }
const futuresSnapshotInFlight = new Map();

async function getFuturesSnapshotCached(exchange, symbol){
  const builder = FUTURES_SNAPSHOT_BUILDERS[exchange];
  if(!builder) throw new Error(`No real-data snapshot builder for "${exchange}" yet.`);
  const key = `${exchange}:${symbol}`;
  const now = Date.now();
  const cached = futuresSnapshotCache.get(key);
  if(cached && (now - cached.at) < FUTURES_SNAPSHOT_CACHE_TTL_MS) return cached.data;
  if(futuresSnapshotInFlight.has(key)) return futuresSnapshotInFlight.get(key);
  const p = (async () => {
    const data = await builder(symbol);
    futuresSnapshotCache.set(key, { data, at: Date.now() });
    return data;
  })();
  futuresSnapshotInFlight.set(key, p);
  try{
    return await p;
  } finally {
    futuresSnapshotInFlight.delete(key);
  }
}

app.use('/api/futures/snapshot', rateLimit({ windowMs: 60_000, max: 120, standardHeaders: true, legacyHeaders: false }));
app.get('/api/futures/snapshot', async (req, res) => {
  const symbol = req.query.symbol;
  const exchange = String(req.query.exchange || 'bybit');
  if(!symbol) return res.status(400).json({ ok:false, message:'symbol is required.' });
  try{
    const snap = await getFuturesSnapshotCached(exchange, String(symbol));
    res.set('Cache-Control', 'public, max-age=10');
    res.json({ ok:true, snapshot: snap });
  }catch(err){
    res.status(502).json({ ok:false, message: `Could not fetch ${exchange} market data for ${symbol}: ${err.message}` });
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

// =============================================================
// Gate.io USDT-M Futures — the third Live/Demo exchange.
//
// Two things genuinely different from Bybit/Binance here, worth stating
// plainly: (1) Gate.io futures runs on its own base domain entirely
// separate from spot — fx-api.gateio.ws / fx-api-testnet.gateio.ws, not
// api.gateio.ws / api-testnet.gateapi.io — confirmed from Gate's own API
// changelog ("Domain of base URLs are changed to fx-api.gateio.ws...").
// Reusing the spot base here would silently hit the wrong host. (2)
// Gate.io futures orders are sized in whole CONTRACTS, not base-asset
// quantity — each contract represents a fixed amount of the underlying
// (quanto_multiplier, from the contract's own public info), so the
// engine's computed base qty has to be converted to a contract count
// before it means anything to this API. This implementation floors to
// whole contracts (no partial-contract sizing) since that's correct for
// the large majority of contracts, which don't support decimal sizes.
//
// TP/SL uses Gate's price-triggered order API (POST
// /futures/{settle}/price_orders) — two separate trigger orders after
// the entry fills, same "separate calls" shape as Binance rather than
// Bybit's one-call inline attachment, using order_type:
// plan-close-long-position / plan-close-short-position so each trigger
// closes the WHOLE position regardless of size, the same closePosition
// semantic as the other two exchanges. Gate does have a newer, less
// battle-tested inline TP/SL field on the entry order itself
// (tpsl_tp_trigger_price/tpsl_sl_trigger_price per their changelog) —
// deliberately not used here: the trigger-order API is older, more
// thoroughly documented, and this is not code to guess on.
// =============================================================
const GATEIO_FAPI_BASE = { live: 'https://fx-api.gateio.ws', demo: 'https://fx-api-testnet.gateio.ws' };

async function gateioFuturesSignedRequest(method, path, query, body, apiKey, secretKey, mode){
  const base = GATEIO_FAPI_BASE[mode] || GATEIO_FAPI_BASE.live;
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

// USDT-M symbol like "BTCUSDT" -> Gate.io's underscore-separated contract
// name "BTC_USDT". Every symbol on this app's futures watchlist ends in
// USDT, so this is a fixed suffix split rather than a lookup table.
function toGateioContract(symbol){
  return symbol.endsWith('USDT') ? `${symbol.slice(0, -4)}_USDT` : symbol;
}

async function gateioFuturesBalance(mode, apiKey, secretKey){
  const account = await gateioFuturesSignedRequest('GET', '/api/v4/futures/usdt/accounts', '', null, apiKey, secretKey, mode);
  return account && account.available != null ? parseFloat(account.available) : null;
}

async function gateioContractInfo(mode, contract){
  const base = GATEIO_FAPI_BASE[mode] || GATEIO_FAPI_BASE.live;
  const res = await fetch(`${base}/api/v4/futures/usdt/contracts/${contract}`);
  const data = await res.json().catch(() => null);
  if(!data || !data.name) throw new Error(`Unknown Gate.io futures contract ${contract}`);
  return {
    quantoMultiplier: parseFloat(data.quanto_multiplier || '1'), // base-asset amount represented by 1 contract
    orderSizeMin: parseInt(data.order_size_min, 10) || 1,        // in contracts
    leverageMax: parseFloat(data.leverage_max || '20'),
  };
}

async function gateioFuturesSetLeverage(mode, apiKey, secretKey, contract, leverage){
  await gateioFuturesSignedRequest('POST', `/api/v4/futures/usdt/positions/${contract}/leverage`, `leverage=${leverage}`, null, apiKey, secretKey, mode);
}

async function placeGateioFuturesOrder(mode, apiKey, secretKey, { symbol, side, rawQty, leverage, rawStopLossPrice, rawTakeProfitPrice }){
  const contract = toGateioContract(symbol);
  const info = await gateioContractInfo(mode, contract);

  // Convert base-asset qty to a whole number of contracts.
  const contracts = Math.floor(rawQty / info.quantoMultiplier);
  if(contracts < info.orderSizeMin){
    throw new VerifyRejected(`Size ${rawQty} ${symbol} converts to ${contracts} contract(s) (1 contract = ${info.quantoMultiplier} ${symbol.replace('USDT','')}), below the exchange minimum (${info.orderSizeMin}) — nothing was sent.`);
  }
  const clampedLeverage = Math.min(leverage, info.leverageMax);
  const signedSize = side === 'buy' ? contracts : -contracts; // Gate.io encodes direction in the sign of size, not a separate side field

  await gateioFuturesSetLeverage(mode, apiKey, secretKey, contract, clampedLeverage);

  const order = await gateioFuturesSignedRequest('POST', '/api/v4/futures/usdt/orders', '', {
    contract, size: signedSize, price: '0', tif: 'ioc', text: 't-nxtgen', // price:"0" + tif:"ioc" = market order
  }, apiKey, secretKey, mode);
  if(!order || order.status !== 'finished' || parseFloat(order.size || '0') === parseFloat(order.left ?? order.size ?? '0')){
    // A market IOC order that didn't finish (fully or partially cancelled
    // for lack of liquidity) is not something to treat as a live position.
    if(!order || order.status !== 'finished'){
      throw new VerifyRejected(`Order did not finish (status: ${order ? order.status : 'unknown'}). No further legs will be attempted automatically.`);
    }
  }
  const filledContracts = Math.abs(parseFloat(order.size || '0') - parseFloat(order.left || '0')) || Math.abs(parseFloat(order.size || '0'));
  const filledQty = filledContracts * info.quantoMultiplier;
  const avgPrice = parseFloat(order.fill_price || order.price || '0');

  const closeOrderType = side === 'buy' ? 'plan-close-long-position' : 'plan-close-short-position';
  // rule 1 = triggers when price >= trigger.price; rule 2 = triggers when price <= trigger.price.
  const slRule = side === 'buy' ? 2 : 1;
  const tpRule = side === 'buy' ? 1 : 2;
  try{
    await gateioFuturesSignedRequest('POST', '/api/v4/futures/usdt/price_orders', '', {
      initial: { contract, size: 0, price: '0', tif: 'ioc', reduce_only: true },
      trigger: { strategy_type: 0, price_type: 0, price: rawStopLossPrice.toString(), rule: slRule },
      order_type: closeOrderType,
    }, apiKey, secretKey, mode);
    await gateioFuturesSignedRequest('POST', '/api/v4/futures/usdt/price_orders', '', {
      initial: { contract, size: 0, price: '0', tif: 'ioc', reduce_only: true },
      trigger: { strategy_type: 0, price_type: 0, price: rawTakeProfitPrice.toString(), rule: tpRule },
      order_type: closeOrderType,
    }, apiKey, secretKey, mode);
  }catch(err){
    throw new VerifyRejected(`Position OPENED (${symbol} ${side} ${filledQty} @ ${avgPrice}, order ${order.id}) but attaching stop-loss/take-profit FAILED: ${err.message}. This position has no protective orders on it — check Gate.io directly and close or protect it manually.`);
  }

  return { orderId: order.id, filledQty, avgPrice, leverage: clampedLeverage, stopLossPrice: rawStopLossPrice, takeProfitPrice: rawTakeProfitPrice };
}

async function getGateioFuturesPosition(mode, apiKey, secretKey, symbol){
  const contract = toGateioContract(symbol);
  const pos = await gateioFuturesSignedRequest('GET', `/api/v4/futures/usdt/positions/${contract}`, '', null, apiKey, secretKey, mode);
  const size = pos ? parseFloat(pos.size || '0') : 0;
  if(!pos || size === 0) return null;
  return {
    size: Math.abs(size), side: size > 0 ? 'Buy' : 'Sell', avgPrice: parseFloat(pos.entry_price || '0'),
    markPrice: parseFloat(pos.mark_price || '0'), unrealisedPnl: parseFloat(pos.unrealised_pnl || '0'),
    leverage: parseFloat(pos.leverage || '0'), liqPrice: pos.liq_price ? parseFloat(pos.liq_price) : null,
  };
}

// No single "closed PnL" endpoint — sums the account ledger's pnl entries
// for this contract since the position was opened, matching the same
// approach used for Binance (see getBinanceFuturesRealizedResult).
async function getGateioFuturesRealizedResult(mode, apiKey, secretKey, symbol, passphrase, openedAtMs){
  const contract = toGateioContract(symbol);
  const sinceSec = Math.floor((openedAtMs || (Date.now() - 24 * 60 * 60 * 1000)) / 1000);
  const rows = await gateioFuturesSignedRequest('GET', '/api/v4/futures/usdt/account_book', `contract=${contract}&from=${sinceSec}&limit=200`, null, apiKey, secretKey, mode);
  if(!Array.isArray(rows) || rows.length === 0) return null;
  const relevant = rows.filter(r => ['pnl', 'fee', 'fund'].includes(r.type));
  if(relevant.length === 0) return null;
  const closedPnl = relevant.reduce((a, r) => a + parseFloat(r.change || '0'), 0);
  return { closedPnl, entries: relevant.length };
}

// =============================================================
// MEXC Futures — the fourth and final Live/Demo exchange, LIVE ONLY (see
// below for why there's no Demo option here, unlike the other three).
//
// Worth stating plainly, because it's a real difference from the other
// three exchanges: MEXC only launched programmatic Futures order
// placement via API on 2026-03-31 — about five months before this was
// written. That's not a reason to distrust the mechanics below (the
// official docs for it are thorough and internally consistent, and
// everything here is sourced directly from them, not guessed by analogy
// to MEXC's older, more established spot API), but it does mean this
// exchange has the least real-world mileage of the four — the smallest
// body of other bots/tooling having already found and fixed the rough
// edges. Treat it accordingly.
//
// Also worth noting: MEXC's Futures API domain itself changed as
// recently as 2026-01-14 (contract.mexc.com -> api.mexc.com, old domain
// fully decommissioned within a week) — confirmed from MEXC's own
// announcement, not assumed from older docs/tooling that would now point
// at a dead host.
//
// No Demo mode: MEXC's Futures Demo Trading exists, but only as a
// website/app feature (with its own separate "receive demo coins" flow)
// — nothing in MEXC's current API documentation exposes a demo/testnet
// base URL the way Binance/Bybit/Gate.io each do. Same situation as
// MEXC spot, which has never had Live/Demo toggle in this app either.
//
// Simpler than the other three in one respect: MEXC's order-create
// endpoint takes stopLossPrice/takeProfitPrice AND leverage directly —
// one call opens the position with both already attached, no separate
// leverage-setting or exit-order calls needed.
// =============================================================
const MEXC_FAPI_BASE = 'https://api.mexc.com';

async function mexcFuturesSignedRequest(method, path, params, apiKey, secretKey){
  const timestamp = String(Date.now());
  let paramString, url;
  if(method === 'GET'){
    const qs = new URLSearchParams(params || {});
    paramString = qs.toString(); // already key=value&key=value in insertion order; MEXC just wants sorted-dictionary-order concatenation
    url = `${MEXC_FAPI_BASE}${path}${paramString ? '?' + paramString : ''}`;
  } else {
    paramString = params ? JSON.stringify(params) : '';
    url = `${MEXC_FAPI_BASE}${path}`;
  }
  const target = apiKey + timestamp + paramString;
  const signature = hmacSha256Hex(secretKey, target);
  const res = await fetch(url, {
    method,
    headers: {
      ApiKey: apiKey, 'Request-Time': timestamp, Signature: signature,
      'Content-Type': 'application/json',
    },
    ...(method !== 'GET' ? { body: paramString } : {}),
  });
  const data = await res.json().catch(() => null);
  if(!res.ok || !data || data.success !== true){
    throw new VerifyRejected(data && data.message ? data.message : `HTTP ${res.status}`);
  }
  return data.data;
}

async function mexcFuturesBalance(mode, apiKey, secretKey){
  const asset = await mexcFuturesSignedRequest('GET', '/api/v1/private/account/asset/USDT', null, apiKey, secretKey);
  return asset && asset.availableBalance != null ? parseFloat(asset.availableBalance) : null;
}

function toMexcContract(symbol){
  return symbol.endsWith('USDT') ? `${symbol.slice(0, -4)}_USDT` : symbol;
}

async function mexcContractInfo(contract){
  const res = await fetch(`${MEXC_FAPI_BASE}/api/v1/contract/detail/country?symbol=${contract}`);
  const data = await res.json().catch(() => null);
  if(!data || !data.success || !data.data) throw new Error(`Unknown MEXC futures contract ${contract}`);
  const c = data.data;
  return {
    contractSize: parseFloat(c.contractSize || '1'), volUnit: parseFloat(c.volUnit || '1'),
    minVol: parseFloat(c.minVol || '1'), maxLeverage: parseFloat(c.maxLeverage || '20'),
    priceUnit: parseFloat(c.priceUnit || '0.01'),
  };
}

async function placeMexcFuturesOrder(mode, apiKey, secretKey, { symbol, side, rawQty, leverage, rawEntryPrice, rawStopLossPrice, rawTakeProfitPrice }){
  const contract = toMexcContract(symbol);
  const info = await mexcContractInfo(contract);

  // Convert base-asset qty to whole contracts (volUnit step, floored).
  const contracts = Math.floor((rawQty / info.contractSize) / info.volUnit) * info.volUnit;
  if(contracts < info.minVol){
    throw new VerifyRejected(`Size ${rawQty} ${symbol} converts to ${contracts} contract(s) (1 contract = ${info.contractSize} ${symbol.replace('USDT', '')}), below the exchange minimum (${info.minVol}) — nothing was sent.`);
  }
  const roundToTick = p => Math.round(p / info.priceUnit) * info.priceUnit;
  const entryPrice = roundToTick(rawEntryPrice);
  const stopLossPrice = roundToTick(rawStopLossPrice);
  const takeProfitPrice = roundToTick(rawTakeProfitPrice);
  const clampedLeverage = Math.min(Math.round(leverage), info.maxLeverage);
  const mexcSide = side === 'buy' ? 1 : 3; // 1 = open long, 3 = open short (this app never sends close orders through this path)

  const order = await mexcFuturesSignedRequest('POST', '/api/v1/private/order/create', {
    symbol: contract, price: entryPrice, // required even for type:5 (market) — used as a price-protection reference, not a limit
    vol: contracts, leverage: clampedLeverage, side: mexcSide, type: 5, openType: 1,
    stopLossPrice, takeProfitPrice, lossTrend: 2, profitTrend: 2, // trigger off fair (mark) price, not last price
  }, apiKey, secretKey);
  const orderId = order && order.orderId;
  if(!orderId) throw new VerifyRejected('MEXC accepted the order but returned no orderId to confirm the fill with.');

  // Order-create's own response is just {orderId, ts} — no fill data —
  // so confirm the position actually opened by reading it back, same
  // polling need as Bitget/Bybit had for their own order-ack-only responses.
  const deadline = Date.now() + 6000;
  let filled = null;
  while(Date.now() < deadline){
    await new Promise(r => setTimeout(r, 400));
    const positions = await mexcFuturesSignedRequest('GET', '/api/v1/private/position/open_positions', { symbol: contract }, apiKey, secretKey);
    const pos = Array.isArray(positions) ? positions.find(p => p.symbol === contract && p.state === 1) : null;
    if(pos && parseFloat(pos.holdVol) > 0){ filled = pos; break; }
  }
  if(!filled){
    throw new VerifyRejected(`Order ${orderId} was accepted but no open position confirmed within 6s — check MEXC directly before assuming anything about it.`);
  }
  const filledQty = parseFloat(filled.holdVol) * info.contractSize;
  const avgPrice = parseFloat(filled.openAvgPrice || filled.holdAvgPrice || '0');
  return { orderId, filledQty, avgPrice, leverage: clampedLeverage, stopLossPrice, takeProfitPrice };
}

async function getMexcFuturesPosition(mode, apiKey, secretKey, symbol){
  const contract = toMexcContract(symbol);
  const positions = await mexcFuturesSignedRequest('GET', '/api/v1/private/position/open_positions', { symbol: contract }, apiKey, secretKey);
  const pos = Array.isArray(positions) ? positions.find(p => p.symbol === contract && p.state === 1) : null;
  if(!pos || parseFloat(pos.holdVol) === 0) return null;
  return {
    size: parseFloat(pos.holdVol), side: pos.positionType === 1 ? 'Buy' : 'Sell',
    avgPrice: parseFloat(pos.holdAvgPrice || '0'), markPrice: null,
    unrealisedPnl: parseFloat(pos.unRealizedPnl || '0'), leverage: parseFloat(pos.leverage || '0'),
    liqPrice: pos.liquidatePrice ? parseFloat(pos.liquidatePrice) : null,
  };
}

async function getMexcFuturesRealizedResult(mode, apiKey, secretKey, symbol, passphrase, openedAtMs){
  const contract = toMexcContract(symbol);
  const history = await mexcFuturesSignedRequest('GET', '/api/v1/private/position/list/history_positions', {
    symbol: contract, start_time: String(openedAtMs || (Date.now() - 24 * 60 * 60 * 1000)), page_num: '1', page_size: '5',
  }, apiKey, secretKey);
  const list = Array.isArray(history) ? history : (history && history.resultList) || [];
  const row = list[0]; // most recent closed position for this contract
  if(!row) return null;
  return { closedPnl: parseFloat(row.realised || '0'), entries: 1 };
}

const ORDER_PLACERS = { binance: placeBinanceOrder, bybit: placeBybitOrder, mexc: placeMexcOrder, gateio: placeGateioOrder, bitget: placeBitgetOrder };




// =============================================================
// Binance USDⓈ-M Futures — the second Live/Demo exchange (after Bybit).
// Reuses hmacSha256Hex + the X-MBX-APIKEY header scheme already proven
// for Binance spot, and binanceAssetBalance/verifyBinance's account
// balance path doesn't apply here — futures has its own wallet, queried
// separately below (binanceFuturesBalance).
//
// The one thing that made this NOT a copy-paste of the Bybit version:
// Binance does not support attaching a stop-loss/take-profit to a market
// order the way Bybit does. As of a Binance API change on 2025-12-09,
// conditional orders (STOP_MARKET/TAKE_PROFIT_MARKET) also can't go
// through the regular order endpoint at all anymore — they 404/reject
// with "-4120, use the Algo Order API instead". So opening a position
// here is three signed calls, not one: the market entry, then a
// STOP_MARKET algo order and a TAKE_PROFIT_MARKET algo order, both with
// closePosition:true (close the whole thing, not a fixed quantity) and
// workingType:MARK_PRICE (trigger off mark price, harder to wick-hunt
// than last-traded price). Same safety property as Bybit's native
// TP/SL either way: Binance enforces the exit, not this server watching
// a price feed in a loop.
// =============================================================
const BINANCE_FAPI_BASE = { live: 'https://fapi.binance.com', demo: 'https://testnet.binancefuture.com' };

async function binanceFuturesSignedRequest(method, path, params, apiKey, secretKey, mode){
  const base = BINANCE_FAPI_BASE[mode] || BINANCE_FAPI_BASE.live;
  const qs = new URLSearchParams({ ...params, timestamp: String(Date.now()), recvWindow: '5000' });
  const signature = hmacSha256Hex(secretKey, qs.toString());
  qs.set('signature', signature);
  const url = method === 'GET' ? `${base}${path}?${qs.toString()}` : `${base}${path}`;
  const res = await fetch(url, {
    method,
    headers: { 'X-MBX-APIKEY': apiKey, ...(method !== 'GET' ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
    ...(method !== 'GET' ? { body: qs.toString() } : {}),
  });
  const data = await res.json().catch(() => null);
  if(!res.ok || (data && typeof data.code === 'number' && data.code < 0)){
    throw new VerifyRejected(data && data.msg ? data.msg : `HTTP ${res.status}`);
  }
  return data;
}

async function binanceFuturesBalance(mode, apiKey, secretKey){
  const data = await binanceFuturesSignedRequest('GET', '/fapi/v3/positionRisk', {}, apiKey, secretKey, mode).catch(() => null);
  // positionRisk isn't the balance — used here only to confirm the key
  // works against futures at all before the real balance call below,
  // since a spot-only key will fail THIS call with a clear permissions
  // error rather than a confusing one on the balance endpoint.
  void data;
  const account = await binanceFuturesSignedRequest('GET', '/fapi/v2/account', {}, apiKey, secretKey, mode);
  const usdt = (account.assets || []).find(a => a.asset === 'USDT');
  return usdt ? parseFloat(usdt.availableBalance) : null;
}

async function binanceFuturesSymbolFilters(base, symbol){
  const res = await fetch(`${base}/fapi/v1/exchangeInfo?symbol=${symbol}`);
  const data = await res.json().catch(() => null);
  const s = data?.symbols?.[0];
  if(!s) throw new Error(`Unknown Binance futures symbol ${symbol}`);
  const lotSize = (s.filters || []).find(f => f.filterType === 'LOT_SIZE');
  const minNotional = (s.filters || []).find(f => f.filterType === 'MIN_NOTIONAL');
  return {
    qtyStep: lotSize ? parseFloat(lotSize.stepSize) : Math.pow(10, -(s.quantityPrecision ?? 3)),
    minQty: lotSize ? parseFloat(lotSize.minQty) : 0,
    pricePrecision: s.pricePrecision ?? 2,
    minNotional: minNotional ? parseFloat(minNotional.notional) : 0,
  };
}

async function binanceFuturesSetLeverage(mode, apiKey, secretKey, symbol, leverage){
  await binanceFuturesSignedRequest('POST', '/fapi/v1/leverage', { symbol, leverage: String(Math.round(leverage)) }, apiKey, secretKey, mode);
}

async function placeBinanceFuturesOrder(mode, apiKey, secretKey, { symbol, side, rawQty, leverage, rawStopLossPrice, rawTakeProfitPrice }){
  const base = BINANCE_FAPI_BASE[mode] || BINANCE_FAPI_BASE.live;
  const filters = await binanceFuturesSymbolFilters(base, symbol);

  const qty = floorToStep(rawQty, filters.qtyStep);
  if(qty <= 0 || qty < filters.minQty){
    throw new VerifyRejected(`Size ${rawQty} ${symbol} rounds down to ${qty}, below the exchange minimum (${filters.minQty}) — nothing was sent.`);
  }
  const roundPrice = p => Number(p.toFixed(filters.pricePrecision));
  const stopLossPrice = roundPrice(rawStopLossPrice);
  const takeProfitPrice = roundPrice(rawTakeProfitPrice);
  const exitSide = side === 'BUY' ? 'SELL' : 'BUY'; // TP/SL close the position, so they trade the opposite direction from entry

  await binanceFuturesSetLeverage(mode, apiKey, secretKey, symbol, leverage);

  let order = await binanceFuturesSignedRequest('POST', '/fapi/v1/order', {
    symbol, side, type: 'MARKET', quantity: qty.toString(), newOrderRespType: 'RESULT',
  }, apiKey, secretKey, mode);
  // MARKET orders should return the filled result synchronously with
  // newOrderRespType:RESULT — but if avgPrice ever comes back empty/zero
  // (edge case under heavy load), fall back to polling the order once,
  // same defensive pattern used for the exchanges that never return fill
  // data synchronously at all.
  if(!order || !(parseFloat(order.avgPrice) > 0)){
    await new Promise(r => setTimeout(r, 500));
    order = await binanceFuturesSignedRequest('GET', '/fapi/v1/order', { symbol, orderId: order.orderId }, apiKey, secretKey, mode);
  }
  if(!order || order.status !== 'FILLED'){
    throw new VerifyRejected(`Order did not fully fill (status: ${order ? order.status : 'unknown'}). No further legs will be attempted automatically.`);
  }
  const filledQty = parseFloat(order.executedQty);
  const avgPrice = parseFloat(order.avgPrice);

  // Entry is live — now attach the exit orders. If either of these
  // fails, the position is open with NO protection, which is worse than
  // the order never having been placed at all, so this surfaces as a
  // clearly-labeled partial-failure rather than a generic order error.
  try{
    await binanceFuturesSignedRequest('POST', '/fapi/v1/algoOrder', {
      algoType: 'CONDITIONAL', symbol, side: exitSide, type: 'STOP_MARKET',
      triggerPrice: stopLossPrice.toString(), closePosition: 'true', workingType: 'MARK_PRICE',
    }, apiKey, secretKey, mode);
    await binanceFuturesSignedRequest('POST', '/fapi/v1/algoOrder', {
      algoType: 'CONDITIONAL', symbol, side: exitSide, type: 'TAKE_PROFIT_MARKET',
      triggerPrice: takeProfitPrice.toString(), closePosition: 'true', workingType: 'MARK_PRICE',
    }, apiKey, secretKey, mode);
  }catch(err){
    throw new VerifyRejected(`Position OPENED (${symbol} ${side} ${filledQty} @ ${avgPrice}, order ${order.orderId}) but attaching stop-loss/take-profit FAILED: ${err.message}. This position has no protective orders on it — check Binance directly and close or protect it manually.`);
  }

  return { orderId: order.orderId, filledQty, avgPrice, leverage, stopLossPrice, takeProfitPrice };
}

async function getBinanceFuturesPosition(mode, apiKey, secretKey, symbol){
  const list = await binanceFuturesSignedRequest('GET', '/fapi/v3/positionRisk', { symbol }, apiKey, secretKey, mode);
  const pos = Array.isArray(list) ? list.find(p => p.symbol === symbol) : null;
  const amt = pos ? parseFloat(pos.positionAmt) : 0;
  if(!pos || amt === 0) return null;
  return {
    size: Math.abs(amt), side: amt > 0 ? 'Buy' : 'Sell', avgPrice: parseFloat(pos.entryPrice),
    markPrice: parseFloat(pos.markPrice), unrealisedPnl: parseFloat(pos.unRealizedProfit),
    leverage: parseFloat(pos.leverage), liqPrice: pos.liquidationPrice ? parseFloat(pos.liquidationPrice) : null,
  };
}

// No single "closed PnL" endpoint like Bybit's — sums the income ledger
// (realized PnL from price movement, trading fees, and any funding paid)
// for this symbol since the position was opened, which nets out to the
// same real economic result Bybit's closedPnl reports as one number.
// Signature matches the shared closed-pnl-getter shape (mode, apiKey,
// secretKey, symbol, passphrase, openedAtMs) even though Binance doesn't
// use a passphrase — openedAtMs is what this one actually needs, and
// keeping the positional shape uniform across exchanges is what lets
// the /api/futures/position route call any of them the same way.
async function getBinanceFuturesRealizedResult(mode, apiKey, secretKey, symbol, passphrase, openedAtMs){
  const sinceMs = openedAtMs || (Date.now() - 24 * 60 * 60 * 1000); // fallback: last 24h, if the caller somehow didn't send it
  const income = await binanceFuturesSignedRequest('GET', '/fapi/v1/income', { symbol, startTime: String(sinceMs), limit: '200' }, apiKey, secretKey, mode);
  if(!Array.isArray(income) || income.length === 0) return null;
  const relevant = income.filter(e => ['REALIZED_PNL', 'COMMISSION', 'FUNDING_FEE'].includes(e.incomeType));
  if(relevant.length === 0) return null;
  const closedPnl = relevant.reduce((a, e) => a + parseFloat(e.income), 0);
  return { closedPnl, entries: relevant.length };
}


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
const FUTURES_ORDER_PLACERS = { bybit: placeBybitFuturesOrder, binance: placeBinanceFuturesOrder, gateio: placeGateioFuturesOrder, mexc: placeMexcFuturesOrder };
const FUTURES_POSITION_GETTERS = { bybit: getBybitPosition, binance: getBinanceFuturesPosition, gateio: getGateioFuturesPosition, mexc: getMexcFuturesPosition };
const FUTURES_CLOSED_PNL_GETTERS = { bybit: getBybitClosedPnl, binance: getBinanceFuturesRealizedResult, gateio: getGateioFuturesRealizedResult, mexc: getMexcFuturesRealizedResult };
// Bybit's account is unified (spot + derivatives share one USDT
// balance), so its futures balance is just its regular asset-balance
// getter. Binance, Gate.io, and MEXC all keep futures in a completely
// separate wallet from spot — reusing a spot balance getter would
// silently read the wrong number, so each needs its own entry here
// rather than falling back to ASSET_BALANCE_GETTERS.
const FUTURES_BALANCE_GETTERS = {
  bybit: (mode, apiKey, secretKey) => bybitAssetBalance(mode, apiKey, secretKey, 'USDT'),
  binance: binanceFuturesBalance,
  gateio: gateioFuturesBalance,
  mexc: mexcFuturesBalance,
};
// Bybit wants 'Buy'/'Sell'; Binance wants 'BUY'/'SELL'; Gate.io and MEXC
// both want lowercase 'buy'/'sell' (neither uses the word as a literal
// API field — Gate.io encodes direction in the sign of the order size,
// MEXC encodes it in a numeric side enum — but both placers still need
// the word itself to know which one to apply).
const FUTURES_SIDE_CASING = {
  bybit: side => side[0].toUpperCase() + side.slice(1).toLowerCase(),
  binance: side => side.toUpperCase(),
  gateio: side => side.toLowerCase(),
  mexc: side => side.toLowerCase(),
};

app.post('/api/futures/balance', async (req, res) => {
  const { exchange, mode, apiKey, secretKey, passphrase } = req.body || {};
  if(!exchange || !apiKey || !secretKey){
    return res.status(400).json({ ok:false, message:'exchange, apiKey and secretKey are all required.' });
  }
  const getter = FUTURES_BALANCE_GETTERS[exchange];
  if(!getter){
    return res.status(400).json({ ok:false, message:`No futures balance getter for "${exchange}" yet — only bybit, binance, gateio, and mexc are supported so far.` });
  }
  const netMode = ['live', 'demo'].includes(mode) ? mode : 'live';
  try{
    const balance = await getter(netMode, apiKey, secretKey, passphrase);
    return res.json({ ok:true, balance });
  }catch(err){
    if(err instanceof VerifyRejected){
      return res.json({ ok:false, rejected:true, message: err.message });
    }
    return res.json({ ok:false, rejected:false, message: `Could not read futures balance on ${exchange}: ${err.message}` });
  }
});

app.post('/api/futures/order', async (req, res) => {
  const { exchange, mode, apiKey, secretKey, symbol, side, qty, leverage, entryPrice, stopLossPrice, takeProfitPrice, passphrase } = req.body || {};
  if(!exchange || !apiKey || !secretKey || !symbol || !side || !qty || !leverage || !stopLossPrice || !takeProfitPrice){
    return res.status(400).json({ ok:false, message:'exchange, mode, apiKey, secretKey, symbol, side, qty, leverage, stopLossPrice, and takeProfitPrice are all required — every futures order this app places carries a stop-loss and take-profit from the moment it opens, no exceptions.' });
  }
  const placer = FUTURES_ORDER_PLACERS[exchange];
  if(!placer){
    return res.status(400).json({ ok:false, message:`No futures order placer for "${exchange}" yet — only bybit, binance, gateio, and mexc are supported so far.` });
  }
  const netMode = ['live', 'demo'].includes(mode) ? mode : 'live';
  const casingFn = FUTURES_SIDE_CASING[exchange] || (s => s[0].toUpperCase() + s.slice(1).toLowerCase());
  const normalizedSide = casingFn(String(side));

  try{
    const result = await placer(netMode, apiKey, secretKey, {
      symbol, side: normalizedSide, rawQty: parseFloat(qty), leverage: parseFloat(leverage),
      rawEntryPrice: entryPrice != null ? parseFloat(entryPrice) : undefined, // only MEXC's placer actually needs this — others ignore it
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
  const { exchange, mode, apiKey, secretKey, symbol, passphrase, openedAtMs } = req.body || {};
  if(!exchange || !apiKey || !secretKey || !symbol){
    return res.status(400).json({ ok:false, message:'exchange, mode, apiKey, secretKey, and symbol are all required.' });
  }
  const positionGetter = FUTURES_POSITION_GETTERS[exchange];
  const closedPnlGetter = FUTURES_CLOSED_PNL_GETTERS[exchange];
  if(!positionGetter){
    return res.status(400).json({ ok:false, message:`No futures position getter for "${exchange}" yet — only bybit, binance, gateio, and mexc are supported so far.` });
  }
  const netMode = ['live', 'demo'].includes(mode) ? mode : 'live';
  try{
    const open = await positionGetter(netMode, apiKey, secretKey, symbol, passphrase);
    if(open){
      return res.json({ ok:true, open: true, position: open });
    }
    // Not open anymore — pull the realized result, if we can, so the
    // caller can record what actually happened rather than just "it's gone".
    const closed = closedPnlGetter ? await closedPnlGetter(netMode, apiKey, secretKey, symbol, passphrase, openedAtMs).catch(() => null) : null;
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
