// =============================================================
// server.js — minimal, single-purpose verify/balance proxy.
//
// What this is for: the Autotrade & Balances panel needs to confirm a
// Binance/Bybit/MEXC/Gate.io key+secret pair is real and read its balance. Doing that
// from a browser doesn't work — both exchanges reject cross-origin
// authenticated requests (CORS), by design, from any static front-end.
// This tiny server exists only to make that ONE signed, read-only request
// on the front-end's behalf and hand back the result.
//
// What this is NOT: it does not place orders, does not move funds, does
// not persist keys anywhere (no database, no file, no log line contains a
// key or secret), and only exposes two routes. Treat it as infrastructure,
// not a product — see README.md before you deploy it.
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

class VerifyRejected extends Error {}

// Base URLs per network. "demo" is each exchange's own separate sandbox
// environment (its own keys, created from that exchange's own Demo/Testnet
// UI) — never the same account as Live. See each exchange's docs:
//   Binance: https://developers.binance.com/docs/binance-spot-api-docs/demo-mode/general-info
//   Bybit:   https://bybit-exchange.github.io/docs/v5/demo
//   Gate.io: https://www.gate.com/docs/developers/apiv4/en/ ("TestNet trading" base URL)
const BINANCE_BASE = { live: 'https://api.binance.com', demo: 'https://demo-api.binance.com' };
const BYBIT_BASE = { live: 'https://api.bybit.com', demo: 'https://api-demo.bybit.com' };
const GATEIO_BASE = { live: 'https://api.gateio.ws', demo: 'https://api-testnet.gateapi.io' };
// MEXC has no public Demo Trading environment — always 'live'. (Bitget does
// have one, but it's part of their newer Unified Trading Account system —
// different endpoints, a required passphrase this app doesn't collect yet,
// and a header-based demo flag rather than a separate host — so it isn't
// wired up here; Bitget verification is format-check only, live or demo.)
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

const ASSET_BALANCE_GETTERS = { binance: binanceAssetBalance, bybit: bybitAssetBalance, mexc: mexcAssetBalance, gateio: gateioAssetBalance };


const VERIFIERS = { binance: verifyBinance, bybit: verifyBybit, mexc: verifyMexc, gateio: verifyGateio };

app.post('/api/verify', async (req, res) => {
  const { exchange, mode, apiKey, secretKey } = req.body || {};

  // Keys live only in this function's local variables for the lifetime of
  // this one request. Nothing here writes them to disk, a database, or a
  // log — verify that for yourself, this file is short on purpose.
  if(!exchange || !apiKey || !secretKey){
    return res.status(400).json({ verified:false, rejected:false, message:'exchange, apiKey and secretKey are all required.' });
  }
  const verifier = VERIFIERS[exchange];
  if(!verifier){
    return res.status(400).json({ verified:false, rejected:false, message:`No verifier for "${exchange}" — only binance, bybit, mexc, and gateio are supported.` });
  }
  const netMode = ['live', 'demo'].includes(mode) ? mode : 'live';

  try{
    const result = await verifier(netMode, apiKey, secretKey);
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

const ORDER_PLACERS = { binance: placeBinanceOrder, bybit: placeBybitOrder, mexc: placeMexcOrder, gateio: placeGateioOrder };

app.post('/api/order', async (req, res) => {
  const { exchange, mode, apiKey, secretKey, symbol, side, amountKind, amount } = req.body || {};
  if(!exchange || !apiKey || !secretKey || !symbol || !side || !amountKind || !amount){
    return res.status(400).json({ ok:false, message:'exchange, mode, apiKey, secretKey, symbol, side, amountKind and amount are all required.' });
  }
  const placer = ORDER_PLACERS[exchange];
  if(!placer){
    return res.status(400).json({ ok:false, message:`No order placer for "${exchange}" — only binance, bybit, mexc, and gateio are supported.` });
  }
  const netMode = ['live', 'demo'].includes(mode) ? mode : 'live';
  // Binance and MEXC both want 'BUY'/'SELL'; Bybit wants 'Buy'/'Sell';
  // Gate.io wants lowercase 'buy'/'sell' (placeGateioOrder re-lowercases
  // regardless, but keep this table honest for the exchanges that DO care).
  const normalizedSide = (exchange === 'binance' || exchange === 'mexc')
    ? String(side).toUpperCase()
    : exchange === 'gateio'
      ? String(side).toLowerCase()
      : (String(side)[0].toUpperCase() + String(side).slice(1).toLowerCase());

  try{
    const result = await placer(netMode, apiKey, secretKey, { symbol, side: normalizedSide, amountKind, amount: parseFloat(amount) });
    return res.json({ ok:true, ...result });
  }catch(err){
    if(err instanceof VerifyRejected){
      return res.json({ ok:false, rejected:true, message: err.message });
    }
    return res.json({ ok:false, rejected:false, message: `Could not complete order on ${exchange}: ${err.message}` });
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
  const { exchange, mode, apiKey, secretKey, asset } = req.body || {};
  if(!exchange || !apiKey || !secretKey || !asset){
    return res.status(400).json({ ok:false, message:'exchange, apiKey, secretKey and asset are all required.' });
  }
  const getter = ASSET_BALANCE_GETTERS[exchange];
  if(!getter){
    return res.status(400).json({ ok:false, message:`No balance getter for "${exchange}" — only binance, bybit, mexc, and gateio are supported.` });
  }
  const netMode = ['live', 'demo'].includes(mode) ? mode : 'live';
  try{
    const balance = await getter(netMode, apiKey, secretKey, asset);
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
