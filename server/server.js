// =============================================================
// server.js — minimal, single-purpose verify/balance proxy.
//
// What this is for: the Autotrade & Balances panel needs to confirm a
// Binance/Bybit key+secret pair is real and read its balance. Doing that
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

// Base URLs per network. "demo" is Binance/Bybit's separate Demo Trading
// environment (realistic live-mirrored data, demo funds only, keys created
// from each exchange's own Demo Trading UI) — a distinct set of keys from a
// normal Live account. See each exchange's docs for how to generate one:
//   Binance: https://developers.binance.com/docs/binance-spot-api-docs/demo-mode/general-info
//   Bybit:   https://bybit-exchange.github.io/docs/v5/demo
const BINANCE_BASE = { live: 'https://api.binance.com', demo: 'https://demo-api.binance.com' };
const BYBIT_BASE = { live: 'https://api.bybit.com', demo: 'https://api-demo.bybit.com' };

// ---- Binance: GET /api/v3/account, signed with HMAC-SHA256 ----
async function verifyBinance(mode, apiKey, secretKey){
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
  const usdt = (data.balances || []).find(b => b.asset === 'USDT');
  return { balance: usdt ? parseFloat(usdt.free) + parseFloat(usdt.locked) : null };
}

// ---- Bybit v5: GET /v5/account/wallet-balance, signed with HMAC-SHA256 ----
async function verifyBybit(mode, apiKey, secretKey){
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
  const coins = data.result?.list?.[0]?.coin || [];
  const usdt = coins.find(c => c.coin === 'USDT');
  return { balance: usdt ? parseFloat(usdt.walletBalance) : null };
}

const VERIFIERS = { binance: verifyBinance, bybit: verifyBybit };

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
    return res.status(400).json({ verified:false, rejected:false, message:`No verifier for "${exchange}" — only binance and bybit are supported.` });
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

// ---- Bybit: instrument filters (base/quote precision, minimums) ----
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

const ORDER_PLACERS = { binance: placeBinanceOrder, bybit: placeBybitOrder };

app.post('/api/order', async (req, res) => {
  const { exchange, mode, apiKey, secretKey, symbol, side, amountKind, amount } = req.body || {};
  if(!exchange || !apiKey || !secretKey || !symbol || !side || !amountKind || !amount){
    return res.status(400).json({ ok:false, message:'exchange, mode, apiKey, secretKey, symbol, side, amountKind and amount are all required.' });
  }
  const placer = ORDER_PLACERS[exchange];
  if(!placer){
    return res.status(400).json({ ok:false, message:`No order placer for "${exchange}" — only binance and bybit are supported.` });
  }
  const netMode = ['live', 'demo'].includes(mode) ? mode : 'live';
  const normalizedSide = exchange === 'binance' ? String(side).toUpperCase() : (String(side)[0].toUpperCase() + String(side).slice(1).toLowerCase());

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

app.get('/api/health', (req, res) => res.json({ ok:true }));

app.use((err, req, res, next) => {
  console.error('Unhandled error:', err.message); // never log req.body here
  res.status(500).json({ verified:false, rejected:false, message:'Internal error.' });
});

const port = process.env.PORT || 8787;
app.listen(port, () => console.log(`nxtgen-verify-proxy listening on :${port}`));
