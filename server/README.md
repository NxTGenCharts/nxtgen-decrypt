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

## 24/7 Trading Bots (they keep trading with no browser open)

Grid, DCA and Smart bots used to be managed by a timer inside the web page, so closing the tab stopped
them. They now run **on this server**: `botEngine.js` is the same management logic, driven by bots saved
on disk (`botVault.js`) and the **same API keys you verify on the API Keys tab** — the browser sends each
key once and the server keeps it encrypted; there is no second set of keys to maintain. The page just
creates/stops bots and mirrors what the server is doing.

### Option A — Free: Render free plan + a free Supabase database + a free pinger

Render's free plan has two problems for bots: it **spins down after 15 minutes without traffic**, and its disk is
**erased on every restart** (and Render "might restart a free web service at any time"). This setup fixes both: a free
pinger keeps it awake, and the bots + encrypted keys live in a free database instead of the disk, so a restart just
reloads them. No credit card is needed for any of the three.

1. **Database (Supabase).** Create a free project at supabase.com. In **SQL Editor** run:

   ```sql
   create table if not exists public.nxtgen_bots_kv (
     k text primary key,
     v jsonb not null,
     updated_at timestamptz not null default now()
   );
   alter table public.nxtgen_bots_kv enable row level security;  -- no policies: the public key can read nothing
   ```
   Then **Project Settings → API Keys**: copy the **Project URL** and the **secret** key (`sb_secret_…`, or the legacy
   `service_role` key). This key is server-only — never put it in the website.
2. **Render → your service → Environment**, add:

   | Variable | Value |
   |---|---|
   | `BOT_SUPABASE_URL` | the Project URL |
   | `BOT_SUPABASE_KEY` | the secret key |
   | `BOT_VAULT_KEY` | 32+ random characters (encrypts your exchange keys *before* they reach the database) |
   | `WORKER_TOKEN` | a long random string — the page asks for it once |

   Do **not** set `BOT_DATA_DIR`. Redeploy; the log shows `[bots] server-side bots are OFF: …` only if something is missing.
3. **Keep it awake.** Create a free monitor at uptimerobot.com (or cron-job.org) that requests
   `https://<your-service>.onrender.com/health` every **5 minutes**. Anything that reaches the server counts as traffic.
4. **Free hours.** 24/7 = ~744 h, inside Render's 750 free hours per month — but those hours are shared by *all* free
   services in your workspace. Keep this the only free web service, or Render suspends them all at the limit.

What to expect on the free plan: it has no uptime guarantee and a small CPU, and a Render restart takes the server down for
about a minute. Nothing manages your bots in that gap (their orders stay on the exchange), then they reload from the
database and catch up; the card shows a "server was offline" note. Supabase pauses projects after about a week with no
activity, so if you stop all bots for a long time, open the project once to wake it.

Without Supabase *and* without a disk, on Render the bots refuse to start and say why — they would be forgotten at the next
restart while their orders still sat on the exchange.

**If the Trading Bots bar says the server can't save your bots.** The page now reads `/api/bots/status` → `storageHealth`.
A red "can't save" message means the last write to storage failed, so a restart would forget your bots and keys while their
orders stayed on the exchange. The server also refuses to take a new bot (and says why) while it can't save. With Supabase
the usual cause is `BOT_SUPABASE_KEY` being the public/anon key — it can *read* (an empty table) but not *write*; use the
**secret** key (`sb_secret_…` or `service_role`). Right after a restart the bar briefly says the server is "starting up and
loading your saved bots" — the page leaves its own bot list alone during that time.

### Option B — Paid Render with a disk (the sturdy setup)

1. **Paid, always-on instance.** A free Render web service sleeps after ~15 minutes without traffic, which
   silently stops every bot. Use a paid plan (or any VPS).
2. **Persistent disk.** Render's default disk is wiped on every deploy/restart. Add a Disk (1 GB is plenty)
   mounted at e.g. `/var/data`.
3. **Environment variables** (Render → Environment):

   | Variable | Value |
   |---|---|
   | `WORKER_TOKEN` | already set for the Futures worker — the page reuses it, so you enter it once |
   | `BOT_VAULT_KEY` | **32+ random characters** (e.g. `openssl rand -base64 36`). Encrypts the saved API keys. Keep a copy: change or lose it and the saved keys can't be read (just re-sync them from the page). |
   | `BOT_DATA_DIR` | `/var/data` (the disk's mount path) — not used if you set the Supabase variables |

4. Make sure the service starts from a checkout that includes the `js/` folder (`node server/server.js`
   from the repo root) — the engine and the worker import `../js/futures/*`.
5. Redeploy. The log should say the vault is on; if not it prints exactly what's missing
   (`[bots] server-side bots are OFF: ...`). Until it is on, bots keep running in the browser as before and
   the page says so.

### Using it

Open **Utilities & Tools → Trading Bots**. The green bar at the top shows server mode. Create a bot as usual:
the first time you'll be asked for your access token (`WORKER_TOKEN`); your verified key for that
exchange/mode is sent over HTTPS, checked against the exchange, then stored encrypted. After that the bot
runs on the server — close the tab, shut the laptop, it keeps going. Reopen the page any time and the
bots, daily totals and closed trades are synced back into the lists and the Trade Log. Stop / Pause /
Resume / Delete / Rename from the page act on the server. "Sync API keys" re-sends every verified
Bybit/Binance key; replacing a key on the API Keys tab updates the server copy automatically.

### What runs where

| | Runs on |
|---|---|
| Manual Trading Bots + Smart Bots (Grid, DCA) on Bybit / Binance, Live or Demo | **the server** (when server mode is on) |
| Grid **Auto-Scan** (the bot that creates other bots) | still the browser — it needs the page's scanner |
| Futures Engine **Auto** mode | the Futures worker (`worker.js`), armed from the Futures Engine tab (see below) |
| Paper trading / backtests | the browser (no real orders) |

### Safety notes — read these

- **Use a trade-only key.** Create the exchange key with *Trade* permission only (no Withdraw), and whitelist
  this server's outbound IP on the exchange if it has a fixed one. Anyone who gets into this server could
  trade with the saved keys; withdrawal permission must never be on them.
- Keys are encrypted at rest (AES-256-GCM, key derived from `BOT_VAULT_KEY`), the file is owner-only, and
  keys are never returned by any endpoint (the status route only shows the last 4 characters).
- Every `/api/bots/*` route needs the access token and fails closed if `WORKER_TOKEN` is unset or short.
- **After a restart** the engine reloads the bots and simply keeps managing them — it re-reads open orders and
  positions from the exchange on its first tick, so fills that happened while it was down are picked up. A bot
  that was caught *mid-deployment* is flagged as an error instead of resumed (some orders may be resting on the
  exchange: press Stop to cancel them).
- The server and the browser never manage the same bot: a bot handed to the server is skipped by the page's
  own timer.
- The Futures worker and the bots share one exchange account and its margin. They are separate engines — don't
  point both at the same symbol.
- `bots.json` in `BOT_DATA_DIR` holds bots + trade history. Back it up if you care about the history.

### Futures Engine (Auto) 24/7

`worker.js` is now mounted by `server.js` (`/api/worker/*`). Arm it from the Futures Engine tab. Its session
lives in server memory (by design — see the top of `worker.js`), so a server restart disarms it unless you set
`WORKER_AUTOARM=true` with the `WORKER_*` credential variables (see the worker's header).

### Accounts — sign in from any device (Supabase Auth)

Without accounts the bots belong to whoever holds `WORKER_TOKEN`, on one browser. With accounts each person signs in with
email + password and sees **their own** bots, trades and saved exchange keys on every device. Bots keep trading on the
server whether or not any device is open.

**How it works**

- The page signs up / signs in directly with Supabase Auth and sends the session token as `Authorization: Bearer …`. The
  server never sees a password; it asks Supabase who the token belongs to (cached ~60 s, so a revoked session stops working
  within about a minute). Unconfirmed emails are refused.
- Each account gets its own store (`u:<id>:state|creds|trades` rows in the same `nxtgen_bots_kv` table — **no new SQL needed**)
  and its own bot engine. Exchange keys are encrypted with a key derived from `BOT_VAULT_KEY` **and** the account id.
- **Secrets never go back to a browser.** After a key is saved to an account, every device only learns "Bybit demo …1234 is
  saved". Balances, margin checks and bot creation work on a phone that has never seen the key: the page sends a placeholder
  (`srv:bybit:demo:1234`) and the server swaps in the real credential — only for a valid session of the account that owns it —
  just before signing the request.
- The old shared-token path keeps working until an account **claims** the earlier data (below), so nothing stops during rollout.

**Turn it on**

1. Supabase → **Authentication → Sign In / Providers**: Email enabled, **Confirm email** on. **Authentication → URL
   Configuration**: set *Site URL* to your site (password-reset links go there).
2. Supabase → **Project Settings → API Keys**: copy the **publishable** (anon) key. It is public by design.
3. Render → Environment, add `SUPABASE_ANON_KEY` (that key). `BOT_SUPABASE_URL`, `BOT_SUPABASE_KEY` and `BOT_VAULT_KEY` stay as they are.
4. Optional but recommended: `ALLOWED_EMAILS` (e.g. `you@mail.com, @yourcompany.com`) to keep it invite-only, and
   `BOT_MAX_USERS` (default 25 — every account runs its own 8-second engine loop on your instance).
5. Redeploy the server **and** the site (the service worker is bumped to v50, so devices pick up the new code).
6. Open **/register/**, create the account, confirm the email, then sign in at **/login/** (API Keys → Your Account links there too).
7. **Keep your existing bots:** Utilities & Tools → Trading Bots → **Move my earlier bots & keys here**, enter `WORKER_TOKEN`
   once. The bots, their trade history and saved keys are copied into your account and confirmed saved *before* the old copy
   is retired; the bots keep their orders on the exchange and the account's engine simply resumes managing them. Only one
   account can claim, and only someone holding both a login and `WORKER_TOKEN`.

| Variable | Meaning |
|---|---|
| `SUPABASE_ANON_KEY` | Enables accounts. Without it the shared-token behaviour is unchanged. |
| `ALLOWED_EMAILS` | Invite list: addresses and/or `@domains`. Unset = any confirmed account may use the server. |
| `BOT_MAX_USERS` | Accounts the server will run (default 25). |
| `ACCOUNTS_REQUIRED` | `true` = refuse the shared `WORKER_TOKEN` path entirely. |

**Read before letting other people sign up**

- You are then holding other people's trading API keys. They are encrypted at rest, but one `BOT_VAULT_KEY` protects all of
  them and the server decrypts them to trade — anyone who controls this server or its environment can use them. Tell users to
  create **Trade-only keys with Withdraw disabled** and, where the exchange allows it, IP-whitelist this server. This build
  does not yet *check* that a key has withdrawal switched off.
- All accounts share this server's outbound IP, so one Binance IP-weight budget (see "Binance shared IP weight" above).
- Update your Terms/Privacy pages: you now store email addresses and encrypted exchange credentials.
- Sign-out removes that account's bots from the device's list and the key placeholders. Trade-log rows already copied into the
  device's local log stay there; use a private window on a shared computer.
- The Futures Engine worker (`/api/worker/*`) is still single-owner (shared token) — accounts cover Trading Bots and saved keys.

### Sign-in pages and route protection

Accounts have their own pages (all static files, same design system as the terminal):

| Page | Purpose |
|---|---|
| `/login/` | Email + password, "Remember me", forgot-password link, optional Google. Honours `?next=` (same-site dashboard paths only). |
| `/register/` | Email + password (10+ chars, letters and numbers), strength meter, Terms/Privacy acceptance, "check your inbox" state with resend. |
| `/forgot-password/` | Requests a reset link. Always answers the same way, whether or not the address has an account. |
| `/reset-password/` | Opened from the reset email. Sets the new password, then **revokes every session** of the account (all devices). |
| `/verify-email/` | Landing page for the confirmation link; shows "confirmed", or an expired/invalid-link state with a resend form. |

The six dashboard pages load `js/auth-gate.js`: with no stored login they redirect to `/login/` (remembering the page), and `js/account.js`
sends you back there if the session later expires or you sign out (in this tab or another). A header chip shows who is signed in.
The landing page, docs, legal pages and the market-data endpoints stay public.

**What the page guard is, and is not.** The site is static files, so anyone can still download a page's HTML/JS — the guard is a
convenience, not a lock. The real enforcement is on this server: bots, trades and saved exchange keys already require a valid account
session and are isolated per account, and `PROXY_REQUIRES_LOGIN=true` extends that to the key-bearing proxy routes (below).

**Supabase dashboard settings these flows depend on** (Authentication, in your project):

1. *Sign In / Providers → Email*: enabled, **Confirm email = on**. The server already refuses unconfirmed accounts.
2. *URL Configuration*: **Site URL** = `https://nxtgendecrypt.site`, and add these to **Redirect URLs**: `https://nxtgendecrypt.site/verify-email/`,
   `https://nxtgendecrypt.site/reset-password/`, `https://nxtgendecrypt.site/login/` (plus your localhost origin when testing locally).
   If they are missing, Supabase sends people to the Site URL instead and the email links will not land on the right page.
3. *Password policy* (Sign In / Providers → Email): set the **minimum length to at least 10** and require letters + digits. The page checks
   this in the browser for feedback, but **only Supabase enforces it** — a direct API call skips the page.
4. *SMTP*: the built-in Supabase mailer is heavily rate-limited (a handful of emails per hour for the whole project) and meant for testing.
   For real users configure your own SMTP provider, or sign-up/reset/resend emails will be refused ("Too many attempts").
5. Optional hardening Supabase offers on paid plans: leaked-password protection, session time-box / inactivity timeout, CAPTCHA on sign-up.
6. Optional **Google**: enable the Google provider in Supabase (Client ID/secret from Google Cloud, with Supabase's callback URL authorised),
   then set `AUTH_GOOGLE_ENABLED=true` on this server. Without it no Google button is shown.

| Variable | Meaning |
|---|---|
| `PROXY_REQUIRES_LOGIN` | `true` = `/api/verify`, `/balance`, `/order`, `/futures/*`, `/ai/confirm`, `/backtest/klines` need a signed-in account session (the pages send it automatically). Off by default. Fails closed (503) if accounts are not configured. |
| `AUTH_GOOGLE_ENABLED` | `true` = show "Continue with Google" on the sign-in pages. Set only after the provider is enabled in Supabase. |

Turn `PROXY_REQUIRES_LOGIN` on only after you and your users are signing in: until then the Futures worker (`/api/worker/*`, shared token)
and bots keep working either way — the worker's own loopback calls carry the per-boot internal key and are exempt from the gate.

**How "Remember me" works.** On: the login is kept in this browser's localStorage and survives closing it. Off: it is kept in
sessionStorage and ends when the tab/browser closes. How long Supabase keeps the *refresh token* valid is a project setting
(Supabase's default is until sign-out); the page cannot shorten that.

**Known limits.**
- Login tokens live in browser storage (that is how the existing account module and Supabase's own client work), so a cross-site-scripting bug
  on this site would expose them. The auth pages ship a strict Content-Security-Policy (`script-src 'self'`) for that reason; the dashboard pages
  do not yet (their inline handlers/styles would need to be removed first). GitHub Pages cannot set HTTP headers, so framing protection
  (`X-Frame-Options`/`frame-ancestors`) is not available unless you put the site behind Cloudflare or similar.
- Cookies are not used, so CSRF does not apply to the API; it authenticates with a bearer token in the `Authorization` header.
- Rate limiting of sign-in/sign-up/reset attempts is Supabase's (per IP/email), not this server's, because the browser talks to Supabase directly.
- The Futures worker (`/api/worker/*`) is still single-owner (shared `WORKER_TOKEN`), as noted above.
- Terms and Privacy pages have not been updated for the fact that you now store emails and encrypted exchange credentials — that wording is yours to write.

### Tests

```
node tests/bots.test.mjs                                                        # engine vs a simulated exchange
node --import ./tests/_stubs/register.mjs tests/botRoutes.test.mjs              # HTTP layer (no express needed)
node --import ./tests/_stubs/register.mjs tests/accounts.test.mjs               # accounts: isolation, saved-key swap, claim, invites
node tests/account-client.test.mjs                                              # browser account module (stubbed DOM)
node tests/auth-utils.test.mjs                                                  # sign-in helpers: open-redirect guard, password rules, email-link parsing
node tests/auth-gate.test.mjs                                                   # PROXY_REQUIRES_LOGIN gate, negative token cache, public auth config
node tests/auth-flows.test.mjs                                                  # remember-me storage, sign-up/reset/resend, recovery, Google marker
node tests/auth-gate-client.test.mjs                                            # dashboard redirect on missing/expired session, token attachment with the gate on
```
These prove the engine's logic and the key handling. They do **not** prove the real Bybit/Binance endpoints
behave like the simulator — run on **Demo with a small amount** before trusting real money to it.
