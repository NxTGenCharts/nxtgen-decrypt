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

// ---- Binance: GET /api/v3/account, signed with HMAC-SHA256 ----
async function verifyBinance(testnet, apiKey, secretKey){
  const base = testnet ? 'https://testnet.binance.vision' : 'https://api.binance.com';
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
async function verifyBybit(testnet, apiKey, secretKey){
  const base = testnet ? 'https://api-testnet.bybit.com' : 'https://api.bybit.com';
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

  try{
    const result = await verifier(mode === 'testnet', apiKey, secretKey);
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

app.get('/api/health', (req, res) => res.json({ ok:true }));

app.use((err, req, res, next) => {
  console.error('Unhandled error:', err.message); // never log req.body here
  res.status(500).json({ verified:false, rejected:false, message:'Internal error.' });
});

const port = process.env.PORT || 8787;
app.listen(port, () => console.log(`nxtgen-verify-proxy listening on :${port}`));
