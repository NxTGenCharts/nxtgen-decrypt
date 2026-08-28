# nxtgen-verify-proxy

A small backend with two jobs:

1. Sign a read-only "what's my balance" request to Binance, Bybit, MEXC,
   or Gate.io on behalf of the Autotrade & Balances panel, and hand back
   the answer. Browsers cannot do this themselves — these exchanges
   reject authenticated requests that come from a browser origin (CORS),
   regardless of whether the key is valid. This is not a workaround for
   that restriction; it's the standard shape of the fix: the signing
   happens server-side, where CORS doesn't apply.
2. Fetch public market data (Bitget/Binance/Bybit/MEXC/Gate.io tickers)
   for the Overview, Cross-Exchange, and Triangular Arbitrage screens, and
   hand back one merged, cached response — see `/api/markets` below. This
   is what makes "connected" behave the same on every device: instead of
   each browser independently calling five exchanges (whose public
   endpoints are reachable inconsistently depending on the caller's own
   network/ISP/VPN/region), this one server does it, from the same place,
   every time, and every device just asks it.

**This proxy never places an order, never withdraws or moves funds, and
never stores a key.** Each request signs and forwards, in memory, for the
lifetime of that one HTTP call, then the key is gone. Read `server.js` —
it's under 120 lines specifically so that's easy to verify yourself.

## Endpoints

- `POST /api/verify` — body `{ exchange: "binance"|"bybit"|"mexc"|"gateio", mode: "live"|"demo", apiKey, secretKey }`.
  - `"demo"` only applies to Binance/Bybit — MEXC and Gate.io have no public
    Demo Trading environment, so requests for those two always run against
    Live. Binance/Bybit's `"demo"` is a distinct set of keys from a normal
    Live account, created from each exchange's own Demo Trading UI. It mirrors live market data but trades demo funds only. See:
    [Binance](https://developers.binance.com/docs/binance-spot-api-docs/demo-mode/general-info),
    [Bybit](https://bybit-exchange.github.io/docs/v5/demo).
  Returns `{ verified, rejected, balance, message }`.
  - `verified: true` — the exchange confirmed the key and returned a balance.
  - `rejected: true` — the exchange explicitly said the key/secret is invalid. Trust this.
  - both `false` — couldn't reach the exchange (network hiccup, outage). Not a verdict on the key.
- `GET /api/markets` — public market data for all five exchanges, fetched
  server-side in parallel and cached for 3 seconds. Returns
  `{ fetchedAt, bitget: { ok, pairs }, binance: {...}, bybit: {...}, mexc: {...}, gateio: {...} }`;
  an exchange that failed to respond comes back as `{ ok:false, error }`
  instead of failing the whole request. The front-end already points at
  this automatically (see `DEFAULT_VERIFY_PROXY_URL` in `js/state.js`) —
  nothing to configure per device.
- `GET /api/markets/bitget-coins` — Bitget's withdraw/deposit-enabled coin
  directory, cached for 10 minutes.
- `GET /api/health` — liveness check, returns `{ ok: true }`.

## Run it locally

```bash
cd server
npm install
cp .env.example .env      # edit ALLOWED_ORIGIN if you're testing against a real front-end
npm start                 # listens on :8787 by default
```

Then, in the app's **Autotrade & Balances → Connect Exchanges** panel, set
**Verification proxy URL** to `http://localhost:8787` (or wherever you
deploy it) and reconnect a Binance/Bybit/MEXC/Gate.io key. Without a proxy URL set, the
app falls back to trying the browser directly, which will reliably come
back UNVERIFIED for the CORS reason above — that's expected, not a bug.

## Deploying it for real

Any small Node host works — Render, Railway, Fly.io, a $5 VPS, or a
serverless function adapted from `server.js`. Whichever you pick:

1. **Set `ALLOWED_ORIGIN` to your real site**, not `*`. Leaving it wide
   open means any other website can route requests through your proxy.
2. **Serve it over HTTPS.** Keys are in the request body; don't send them
   over plain HTTP.
3. **Use read-only API keys** on the exchange side wherever you can —
   this proxy only ever calls read-only endpoints, so a read-only key is
   all it needs, and it means a leaked key can't be used to trade or
   withdraw even in the worst case.
4. **Consider tightening the rate limit** in `server.js` (currently 20
   verify calls/minute per caller) if you're exposing this publicly, and/or
   put it behind your host's own WAF or rate limiting.
5. **Don't add logging of the request body.** The one deliberate design
   choice in this file is that a key is never written anywhere but a local
   variable — keep it that way if you extend this.

## What this intentionally does not do

No order placement, no withdrawals, no persistence layer, no admin UI, no
multi-tenant key storage. If you later want the front-end's Autotrade
engine to place *real* orders instead of simulating them, that's a
meaningfully bigger, higher-stakes piece of infrastructure — this proxy is
deliberately not it, and extending it to sign order-placement requests
should be a separate, carefully-reviewed decision, not a quiet addition
here.
