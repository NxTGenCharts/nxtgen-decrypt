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
- `POST /api/futures/order` — body `{ exchange:"bybit"|"binance"|"gateio"|"mexc"|"bitget", mode, apiKey, secretKey, passphrase, symbol, side, qty, leverage, entryPrice, stopLossPrice, takeProfitPrice }`. `passphrase` is required for, and only used by, Bitget (same third credential its spot integration needs). `entryPrice` is only actually used by MEXC (its order-create endpoint requires a `price` field even for market orders, as a price-protection reference) and ignored by the other four. Sets leverage, then places a market order with the stop-loss and take-profit attached as **native, exchange-side, market-triggered orders** — not something this app watches and reacts to. That's deliberate: a real leveraged position left unmanaged if this server stops, the tab closes, or the connection drops would carry open liquidation risk with nothing watching it. Bybit, MEXC, and Bitget all attach TP/SL directly on the entry order (one call); Binance and Gate.io need two additional calls after the entry fills (Binance: `STOP_MARKET` + `TAKE_PROFIT_MARKET` via its `/fapi/v1/algoOrder` endpoint — conditional orders stopped working on the old order endpoint as of a Binance API change on 2025-12-09; Gate.io: two `price_orders` trigger orders with `order_type: plan-close-long/short-position`). If the entry fills on either of those two but an exit-order call fails, this returns a clearly-labeled error saying the position is open and unprotected, rather than a generic failure — check the exchange directly if you ever see that. Returns `{ ok, orderId, filledQty, avgPrice, leverage, stopLossPrice, takeProfitPrice }`.
- `POST /api/futures/position` — body `{ exchange, mode, apiKey, secretKey, passphrase, symbol, openedAtMs }`. `openedAtMs` is required for Binance, Gate.io, and MEXC (none has a single "closed PnL" endpoint like Bybit's — the realized result is reconstructed by summing or reading the account's income/ledger/history-positions entries for that symbol since the position opened) — Bitget also uses this same ledger-sum approach, reusing `openedAtMs` too. Ignored by Bybit.
- `POST /api/futures/balance` — body `{ exchange, mode, apiKey, secretKey, passphrase }`. Separate from spot's `/api/balance` on purpose: Bybit's account is unified (spot and derivatives share one USDT balance, so this just calls the same getter spot balance uses), but Binance, Gate.io, MEXC, and Bitget all keep futures in a completely separate wallet from spot — reusing the spot balance getter here would silently report the wrong number.
- `GET /api/futures/snapshot?exchange=X&symbol=Y` — real market data (klines + ticker) shaped into the same format the AI Futures Engine's scoring/regime/setup logic already consumes, cached 15s per exchange+symbol. This is what Live/Demo trading scans against instead of the synthetic Paper-mode feed — see "Live/Demo futures trading" below.

## Live/Demo futures trading (all five exchanges — MEXC is Live only)

The AI Futures Engine's Paper mode (synthetic random-walk prices) is untouched and still the default. A second, independent mode exists in that tab's UI: pick an exchange from the dropdown, select Demo or Live (MEXC: Live only — see below), and arm it — it runs the exact same detection/scoring code Paper mode does, but fed real market data via `/api/futures/snapshot` instead of the synthetic feed, and on an approved signal places a real order via `/api/futures/order` with native/exchange-enforced SL/TP attached. Every position it opens is capped at one at a time, deliberately, for this build. See `README-SCALP.md` for the full design writeup, including several real bugs caught and fixed along the way: a hardcoded reference to the simulated clock that would have made the cooldown-after-losses safety check compare real timestamps against fake time, Binance's conditional orders moving to a different endpoint entirely in a December 2025 API change, Gate.io running its futures API on a completely separate domain from its spot API, MEXC's own API domain migration in January 2026 plus the fact that programmatic Futures order placement on MEXC didn't exist at all before March 2026 (making it the least battle-tested of the five integrations here), and Bitget reusing the exact same host/signing/Demo-header mechanism as its spot integration, with the one open question being that the Demo header's exact behavior on futures endpoints specifically hasn't been independently confirmed end-to-end.

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

## Running unattended (24/7 worker)

`worker.js` runs the same Auto-mode Live/Demo trading loop the app's
browser tab runs, but inside this server process, so new entries keep
getting placed even with every tab and every device closed. It's not a
separate deploy — it's mounted on this same Express app and starts the
moment you arm it.

Existing open positions (and their native exchange-side SL/TP) are
never at risk from any of this — see "Live/Demo futures trading" above.
What the worker adds is the ability to open **new** ones without a
browser open.

- `POST /api/worker/arm` — body: `{ armPhrase, exchange, mode, apiKey, secretKey, passphrase, leverage, riskPctPerTrade, minConfidence, minRiskReward, dailyProfitTargetPct, maxDailyLossPct }`. `armPhrase` must be exactly `"PLACE REAL ORDERS"` — same phrase the app's own Arm control uses. Starts an 8-second scan/manage loop for that exchange immediately. One position at a time per exchange, same as the browser bot. **Each exchange is its own independent session** (own key, settings, cooldowns, equity baseline, log), so several can run side by side; arming an exchange that's already armed is refused. Extra optional fields: `strategies`, `strategyRR`, `quantCfg`, `tzOffsetMinutes` (so daily targets reset at your midnight), and `explicitSettings: true` — with that flag set the server refuses to arm unless leverage, risk %, min confidence, daily profit target, max daily loss and a strategy selection were all actually sent, so nothing falls back to a default. Values outside the app's own ranges are clamped, and Demo is never silently turned into Live (MEXC has no Demo, so a Demo request for it is rejected).
- `POST /api/worker/disarm` — body `{ exchange? }` (omit to stop every exchange). Stops placing new entries. Any position already open keeps its exchange-side SL/TP either way; this just means the worker stops polling it for closure bookkeeping until you re-arm.
- `GET /api/worker/status` — `{ status: { armed, sessions: { <exchange>: { armed, mode, openPositions, trades/wins/losses, netPnlUsd, recentTrades, lastMessage, settings } } } }`. `settings` echoes exactly what each session is trading with (never a credential).
- `GET /api/worker/logs?since=<epoch_ms>&exchange=<id>` — log lines since that time (all exchanges merged, each tagged with its `exchange`, or one exchange), for a "what happened while I was away" view.

**Credentials are never persisted by this code** — same rule as the rest of this
proxy (unless you opt in to server-saved settings below). They live in a variable in this process for as long as it's
armed, and nothing else. That means:

- A process restart (redeploy, crash, host maintenance) clears the
  armed session. It comes back disarmed, waiting for you — nothing
  re-arms itself. Re-arm with a `POST /api/worker/arm` call (from the
  app, or a saved request in a phone shortcut/HTTP client) whenever you
  want it running again.
- Anyone who can reach this server directly (not through the app UI)
  with the arm phrase and a valid key can arm it — the same
  `ALLOWED_ORIGIN`/HTTPS/no-withdrawal-permission points under
  "Deploying it for real" above are what actually protect this once
  it's reachable by more than just you.

## Access tokens, saved settings and auto-arm (for hands-off use)

All `/api/worker/*` routes now require an access token, sent as the
`X-Worker-Token` header (or `Authorization: Bearer <token>`). **With no
`WORKER_TOKEN` set, the routes answer 503 and the worker is locked** — a fresh
deploy can't be reached by accident. Set these in the host's environment
(Render: your service → **Environment**). None of them is ever returned to a
browser, and none is written to disk by this code.

| Variable | What it does |
|---|---|
| `WORKER_TOKEN` | **Required.** Admin token, at least 20 random characters. Can arm, disarm and watch. |
| `WORKER_VIEW_TOKEN` | Optional read-only token (status + logs only). Safe to give to someone who should watch but not control. |
| `WORKER_EXCHANGE` | `bybit`, `binance`, `gateio`, `mexc` or `bitget` |
| `WORKER_MODE` | `demo` (default) or `live` |
| `WORKER_API_KEY`, `WORKER_SECRET_KEY`, `WORKER_PASSPHRASE` | The credential the worker trades with (passphrase: Bitget only). |
| `WORKER_LEVERAGE`, `WORKER_RISK_PCT`, `WORKER_MIN_CONFIDENCE`, `WORKER_DAILY_PROFIT_TARGET_PCT`, `WORKER_MAX_DAILY_LOSS_PCT` | **Required to arm from the environment** (auto-arm or the dashboard's "saved keys" arm). The worker refuses to trade on default risk numbers — it names whichever of these is missing. Same meaning as the app's fields of the same names. |
| `WORKER_MIN_RR`, `WORKER_MIN_NET_PROFIT_PCT`, `WORKER_HIGH_SELECTIVITY` | Optional extras. |
| `WORKER_TZ_OFFSET_MINUTES` | When "daily" targets reset, as minutes from UTC (e.g. `60` for UTC+1). Default: UTC midnight. |
| `WORKER_STRATEGIES` | Optional JSON of strategy on/off, e.g. `{"novaScalp":true,"rangeReversal":true,"quantFutures":true}`. Ids: `aiScalp`, `novaScalp`, `trendContinuation`, `liquiditySweep`, `rangeReversal`, `breakoutRetest`, `quantFutures`. Unlisted ids use their defaults. |
| `WORKER_AUTOARM` | `true` = arm automatically ~3 s after every server start, using the saved settings above. |

When `WORKER_EXCHANGE` + `WORKER_API_KEY` + `WORKER_SECRET_KEY` are set:

- The dashboard hides the key/exchange/risk fields and arms with `{ armPhrase, useServerKeys: true }` — no key ever crosses the browser again. The arm phrase is still typed by a person.
- With `WORKER_AUTOARM=true` the worker survives restarts/redeploys/crashes on its own. **That also means it resumes trading with no human present — including in `live` mode. Use `demo` until you trust it.** Disarming from the dashboard holds only until the next restart.
- Session counters (daily profit/loss tracking, trade totals, cooldowns) live in the process, so they reset on every restart.
- A free Render instance sleeps when idle and the worker sleeps with it; wake-up re-arms it (if auto-arm is on), but it isn't trading while asleep. Use an always-on instance for real 24/7.

**Sharing the dashboard.** `nxtgendecrypt.site/worker/#token=<token>&proxy=<server url>` opens pre-filled: the page saves both on that device and removes them from the address bar immediately (the part after `#` is never sent to any server). Give people the `WORKER_VIEW_TOKEN` version unless they should be able to arm/disarm — the admin token can start and stop trading on your account.

## "Run on server" button (Autotrade & Futures page)

Under the Live / Demo Trading panel there's a single **Run on server — 24/7** switch
(`js/server-worker.js`). Flip it ON and the exchange + network currently selected in
that panel is handed to the server, using the key already saved and verified in the
browser and the values **currently on screen** on that page: Risk per trade, Leverage,
Min confidence, Daily Profit Target, Max Daily Loss, High Selectivity and the
Strategies list (plus the saved NxTGen Quant settings). They're re-read at the moment
you flip it and sent with `explicitSettings: true` — a blank field makes the switch
refuse and name it. Flip it OFF to stop new entries (an open position keeps its
exchange-side SL/TP). The switch mirrors `/api/worker/status`, so it also shows ON after
a refresh or when the server auto-armed itself.

The access token is asked for once (a prompt, the first time you flip the switch) and
remembered on that device; a rejected token is asked for again. Live mode asks for a
confirm() instead of typing the arm phrase. If the server answers 503, the message says
whether `WORKER_TOKEN` is not set on the service that answered or is set but shorter than
20 characters.

- **Several exchanges:** switch the exchange row, flip the switch again — each keeps the settings it was armed with. Change a value later and it only applies to the *next* time you switch it on; switch off and on again to apply it.
- **Daily targets roll over:** "daily" profit target / max daily loss are measured against the balance at the start of the local day (the browser's timezone, sent at arm time). At local midnight the baseline resets, so a hit target pauses the bot until the next day rather than forever.
- **Don't run both:** the switch refuses if the in-browser bot is already running on that exchange — two bots on one account would double up trades.
- **Restart = stopped:** the key lives only in server memory. A restart/redeploy/sleep stops every session (and resets the day baseline); flip the switch again, or use the env-var route above for one exchange with auto-arm.
- **Not included:** NxTGen Grid and the Trading Bots (Futures Grid / DCA) still run in the browser only.

**Dashboard:** `worker/index.html` (repo root) is a self-contained mobile-friendly page for this — point it at your deployed proxy URL, arm/disarm, and watch status + the activity log live. Deploy it alongside the rest of the static site (or open the file directly) — it only talks to the endpoints above, nothing else to configure.

**Start in Demo mode.** The worker is a new, independently-running
implementation of the browser bot's Auto-mode loop — reusing the exact
same detection/scoring modules and the exact same order-placement
routes, but its own copy of the orchestration (cooldowns, the
daily-loss-cap shim, closure detection). Watch it place a few cycles
against a Demo key before ever arming it with a Live one.

## Binance "shared IP weight usage" / IP-restricted key errors

Binance counts request weight per **IP address** (2,400/min). On a shared host (e.g. Render's default outbound
IPs, which are shared with other customers in the region) other tenants' traffic counts against the same cap, and
the app's proactive guard then pauses Binance calls — you'll see *"Binance's shared IP weight usage is at N/2400 …"*
even though this app alone sends far less. If your Binance key is also set to "Restrict access to trusted IPs
only", the shared/rotating IP can't be whitelisted reliably either.

Permanent fix: run this proxy on a host with its **own fixed IPv4** (a small VPS, or Render Dedicated IPs), start it
with `NODE_OPTIONS=--dns-result-order=ipv4first`, put HTTPS in front of it, and whitelist that IP on the Binance key.
This app's own Binance scan cost is kept low by sharing bookTicker/premiumIndex/24h-volume calls across symbols and
caching the 15m/1h context candles briefly (see "Binance scan-weight reduction" in `server.js`) — about 650-800
weight/min for a 25-pair watchlist.
