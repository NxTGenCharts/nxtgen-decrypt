# nxtgen-verify-proxy

A small backend with three jobs:

1. Sign a read-only "what's my balance" request to Binance, Bybit, MEXC,
   Gate.io, or Bitget on behalf of the Autotrade & Balances panel, and hand
   back the answer. Browsers cannot do this themselves — these exchanges
   reject authenticated requests that come from a browser origin (CORS),
   regardless of whether the key is valid. This is not a workaround for
   that restriction; it's the standard shape of the fix: the signing
   happens server-side, where CORS doesn't apply.
2. Sign and place the actual order when Autotrade's "Real order execution"
   switch is explicitly armed client-side. This is real money movement,
   not read-only — see "Arming real order execution" below before you
   deploy this anywhere reachable by anyone but you.
3. Fetch public market data (Bitget/Binance/Bybit/MEXC/Gate.io tickers)
   for the Overview, Cross-Exchange, and Triangular Arbitrage screens, and
   hand back one merged, cached response — see `/api/markets` below. This
   is what makes "connected" behave the same on every device: instead of
   each browser independently calling five exchanges (whose public
   endpoints are reachable inconsistently depending on the caller's own
   network/ISP/VPN/region), this one server does it, from the same place,
   every time, and every device just asks it.

**This proxy never persists a key anywhere.** Each request signs and
forwards, in memory, for the lifetime of that one HTTP call, then the key
is gone — no database, no file, no log line contains a key, secret, or
passphrase. Read `server.js` yourself; that's what it's short enough for.

## Endpoints

- `POST /api/verify` — body `{ exchange: "binance"|"bybit"|"mexc"|"gateio"|"bitget", mode: "live"|"demo", apiKey, secretKey, passphrase }`. `passphrase` is required for, and only used by, Bitget — it's the third credential set when that API key was created; the other four exchanges ignore it.
  - `"demo"` applies to Binance, Bybit, Gate.io, and Bitget — each is a
    distinct set of keys from a normal Live account, created from that
    exchange's own Demo Trading / Testnet UI, mirroring live-like market
    data but trading demo funds only. MEXC has no public Demo Trading
    environment, so requests for it always run against Live regardless of
    `mode`. See:
    [Binance](https://developers.binance.com/docs/binance-spot-api-docs/demo-mode/general-info),
    [Bybit](https://bybit-exchange.github.io/docs/v5/demo),
    [Gate.io](https://www.gate.com/docs/developers/apiv4/en/) (the "TestNet trading" base URL — keys are created at [testnet.gate.com](https://testnet.gate.com), not gate.com),
    [Bitget](https://www.bitget.com/api-doc/common/demotrading/intro) (a `paptrading: 1` request header on the same host, not a separate URL — keys are created from Bitget's own Demo Trading UI).
  Returns `{ verified, rejected, balance, message }`.
  - `verified: true` — the exchange confirmed the key and returned a balance.
  - `rejected: true` — the exchange explicitly said the key/secret(/passphrase) is invalid. Trust this.
  - both `false` — couldn't reach the exchange (network hiccup, outage). Not a verdict on the key.
- `POST /api/balance` — body `{ exchange, mode, apiKey, secretKey, passphrase, asset }`. Reads the free/available balance of one asset — used mid-cycle to re-check what a previous leg actually left in the wallet (gross fill reports are pre-fee; see `fetchAssetBalance` in `js/autotrade.js`). Returns `{ ok, balance }` or `{ ok:false, rejected, message }`.
- `POST /api/order` — body `{ exchange, mode, apiKey, secretKey, passphrase, symbol, side, amountKind, amount }`. Places one real market order and returns its actual fill: `{ ok, orderId, filledBaseQty, filledQuoteQty, avgPrice }`. `amountKind` is `"quote"` (spend this much quote currency — the BUY leg) or `"base"` (sell this much base currency — the SELL leg), matching how each exchange's own market-order API expects the amount to be expressed. This is the endpoint that moves real funds once Autotrade's real-order-execution switch is armed — see "Arming real order execution" below.
  - Bitget is structurally different here from the other four: its place-order response returns only an order id, no fill data, so `placeBitgetOrder` in `server.js` polls `GET /api/v2/spot/trade/orderInfo` afterward until it confirms `filled` (or gives up after ~2.4s). An order that fills slower than that comes back as an error, which the caller treats as a failed leg and attempts to unwind — worth knowing before trusting this with real size on a thin/illiquid Bitget pair.
- `GET /api/markets` — public market data for all five exchanges, fetched
  server-side in parallel and cached for 3 seconds. Returns
  `{ fetchedAt, bitget: { ok, pairs }, binance: {...}, bybit: {...}, mexc: {...}, gateio: {...} }`;
  an exchange that failed to respond comes back as `{ ok:false, error }`
  instead of failing the whole request. The front-end already points at
  this automatically (see `DEFAULT_VERIFY_PROXY_URL` in `js/state.js`) —
  nothing to configure per device.
- `GET /api/markets/bitget-coins` — Bitget's withdraw/deposit-enabled coin
  directory, cached for 10 minutes.
- `GET /api/futures/snapshot?symbol=X` — real Bybit market data (klines + ticker) shaped into the same `{symbol, price, m5, m15, h1, meta}` format the AI Futures Engine's scoring/regime/setup logic already consumes, cached 15s per symbol. This is what Live/Demo trading scans against instead of the synthetic Paper-mode feed — see "Live/Demo futures trading" below.
- `POST /api/futures/order` — body `{ exchange:"bybit", mode, apiKey, secretKey, symbol, side, qty, leverage, stopLossPrice, takeProfitPrice }`. Sets leverage, then places a market order with the stop-loss and take-profit attached as **native, exchange-side, market-triggered orders** (`tpslMode: "Full"`) — not something this app watches and reacts to. That's deliberate: a real leveraged position left unmanaged if this server stops, the tab closes, or the connection drops would carry open liquidation risk with nothing watching it; native TP/SL means Bybit enforces the exit regardless. Returns `{ ok, orderId, filledQty, avgPrice, feeUsd, leverage, stopLossPrice, takeProfitPrice }`.
- `POST /api/futures/position` — body `{ exchange:"bybit", mode, apiKey, secretKey, symbol }`. Returns `{ ok, open:true, position }` if still open, or `{ ok, open:false, closed }` with the realized P&L once Bybit's native TP/SL has closed it.

## Live/Demo futures trading (Bybit only, so far)

The AI Futures Engine's Paper mode (synthetic random-walk prices) is untouched and still the default. A second, independent mode exists in that tab's UI for Bybit specifically: it runs the exact same detection/scoring code, but fed real Bybit market data via `/api/futures/snapshot` instead of the synthetic feed, and on an approved signal places a real order via `/api/futures/order` with native SL/TP attached. Every position it opens is capped at one at a time, deliberately, for this first build. See `README-SCALP.md` for the full design writeup, including the bug caught and fixed along the way (a hardcoded reference to the simulated clock that would have made the cooldown-after-losses safety check compare real timestamps against fake time).

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
deploy it) and reconnect a key. Without a proxy URL set, the app falls
back to trying the browser directly, which will reliably come back
UNVERIFIED for the CORS reason above — that's expected, not a bug.

## Deploying it for real

Any small Node host works — Render, Railway, Fly.io, a $5 VPS, or a
serverless function adapted from `server.js`. Whichever you pick:

1. **Set `ALLOWED_ORIGIN` to your real site**, not `*`. Leaving it wide
   open means any other website can route requests through your proxy.
2. **Serve it over HTTPS.** Keys are in the request body; don't send them
   over plain HTTP.
3. **Key permissions depend on what you're using this for.** If you only
   ever connect keys to verify/read balance, a read-only key is all this
   proxy needs — leaked, it can't trade or withdraw. If you plan to arm
   real order execution (see below), the key needs Spot trading
   permission, which by definition means it CAN place orders if it leaks.
   Whatever you do: never grant withdrawal permission. This proxy never
   calls a withdrawal endpoint and has no reason to ever need that
   permission — leaving it off means a worst-case key leak still can't
   move funds out of the account, only trade within it.
4. **Consider tightening the rate limit** in `server.js` (currently 20
   verify calls/minute per caller) if you're exposing this publicly, and/or
   put it behind your host's own WAF or rate limiting.
5. **Don't add logging of the request body.** The one deliberate design
   choice in this file is that a key is never written anywhere but a local
   variable — keep it that way if you extend this.

## Arming real order execution

`/api/order` will sign and place an actual order the moment a valid
request hits it — there is no server-side confirmation step. All the
safety gating (the typed arm-phrase, the reset-every-page-load behavior,
test-mode-only-in-demo, the daily loss cap and kill switch) lives in
`js/autotrade.js` on the front-end, not here. That means anyone who can
reach this server directly (not through the app's UI) with a valid key
can place an order — so everything in "Deploying it for real" above
(locked-down `ALLOWED_ORIGIN`, HTTPS, no withdrawal permission on the key)
is the actual safety boundary once you deploy this somewhere reachable by
more than just you. Start in Demo mode with Test Mode on, watch it place a
few forced-test cycles, and confirm the fills look right before ever
pointing a Live key at an armed session.
