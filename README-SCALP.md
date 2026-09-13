# What changed, and why the numbers are what they are

## UPDATE — the skewed stop:target shape below was replaced
Everything in this file up to this point (the 2.2:1 Range Scalp skew,
the "genuine 1:1" AI Scalp target) reflects the design as it stood
before live trading exposed the problem with it: at a real ~50-55% win
rate, small wins against occasionally-large losses came out net
negative even though the theoretical hit-rate math below looked fine on
paper. `js/futures/engine.js` now builds every setup's target from its
stop distance via a single configurable reward:risk ratio
(`RISK_DEFAULTS.riskRewardRatio`, default 1.2, same field as the "Min
risk/reward" UI control — see `applyRewardRiskFloor()`), instead of the
per-setup skews described below. A 1% stop now targets 1.2%, for every
setup, so the strategy is profitable at any win rate above ~45.5%
instead of needing 69-85% to break even. The reasoning below is kept as
a record of what was tried and why it didn't hold up live, not as a
description of the current behavior.

## 1. Why the strategy kept changing
The old `detectAllSetups()` ran **four independent detectors** every cycle
(Trend Continuation, Breakout + Retest, Range Reversal, Liquidity Sweep
Reversal) and traded whichever one fired. That's why the trade history
jumped between strategy names — it wasn't a bug, it was an ensemble, but
it does make performance impossible to reason about, since every trade
came from a different rule set.

**Fix:** `setups.js` now only calls one detector, `detectRangeScalp()`
("Range Scalp"). The other four are still defined and exported (in case
you want them back later) but the engine no longer ensembles between
strategies.

## 2. The 80–90% win-rate ask — the math, and why I didn't ship it as-is
For a symmetric, driftless random walk sitting between a stop-loss and
a take-profit barrier, the probability of hitting the *near* barrier
first is:

```
P(hit TP first) = stopDistance / (stopDistance + targetDistance)
```

To get an 85% hit rate you need `stopDistance ≈ 5.7x targetDistance`.
I built that version first. Backtesting it against this project's own
mock market showed the problem immediately: with a stop ~5.7x wider
than the target, the target itself came out to roughly **0.05%**, while
round-trip trading cost (entry+exit fees, spread, slippage) on this
mock market is roughly **0.10–0.15%**. That means *every single winning
trade was already a net loser before the position even existed* — an
85% win rate on a target smaller than the cost of entering and exiting
is not a strategy, it's a fee-generating machine with a green number on
top.

**What I shipped instead:** a ~2.2:1 stop:target skew (~69% theoretical
win rate), which is the tightest skew that still clears round-trip costs
with real room to spare. `minRiskReward` and `minNetProfitPct` now have
scalp-specific floors (`scalpMinRiskReward`, `scalpMinNetProfitPct` in
`engine.js`) instead of inheriting the trend-strategy defaults, which
would have rejected almost every scalp signal outright.

## 3. Real backtest results (not a promise — measured)
40,000 simulated minutes (~28 days), daily-reset like a live session
(the app doesn't currently roll the day over, so an uninterrupted run
trips the 2% daily-loss governor once and then never trades again —
that's a harness issue, not a strategy fix, so the backtest resets state
every simulated day the way a fresh live session would):

| | |
|---|---|
| Trades | 83 |
| Win rate | **47.0%** (not 69%, not 80-90%) |
| Avg win | $8.82 |
| Avg loss | -$38.51 |
| Net P&L | **-$1,350.59** on $10,000/day |

The measured win rate came in well under the theoretical 69%, and net
P&L is still negative, because:
- The mock market's price process is close to a fair game (mild
  mood-driven drift, but nothing a mean-reversion fade reliably
  captures) — see the header comment in `mockMarket.js`, which is
  explicit that it isn't tuned to make any strategy look good.
- Fees + spread + slippage are a constant drag every single trade pays,
  win or lose.
- A structurally small-target/wide-stop strategy is, almost by
  definition, a small-win/rare-big-loss strategy. Consistency (one
  strategy) fixed the *readability* problem. It did not, and could not,
  fix the *no genuine edge on synthetic random-walk data* problem.

## 4. A bug I found and fixed along the way
`managePositions()` takes partial profit at TP1 (50%) and TP2 (25%)
before the final close. Those partial fills were correctly added to
the day's running total, but `closeTrade()` only recorded the **final**
slice's dollar amount into `pos.finalNetUsd` and the trade-history row
— it silently dropped any profit already banked from TP1/TP2. That
means the win/loss label and the per-trade dollar amount shown in the
Trade History table under-reported real multi-part trades (this affects
every strategy, not just the scalp). Fixed by accruing each partial's
P&L on the position and folding it into the final trade-history record
(`pos.accrued` in `engine.js`).

## 5. Honest bottom line
On a price feed with no real directional edge, no win-rate/R:R
combination beats a fair game after transaction costs — a high win
rate just concentrates the loss into rarer, larger draws instead of
spreading it evenly. If you want this to actually make money, the
lever that matters is a genuine statistical edge (only available once
Phase 2 wires real Binance/Bybit data and you can test whether any of
these setups actually predict anything) and minimizing cost per trade
— not pushing the win rate higher by shrinking the target.

If you'd like, I can:
- Wire in a realistic ~50-60% win rate / ≥1:1 R:R version, which is
  the profile that historically has a chance of being profitable if
  there's any real edge at all, and re-backtest it the same way.
- Leave Range Scalp as the one strategy (fixes the "keeps changing"
  complaint) but tune it further once real market data is in.

## Update: AI Scalp replaces Range Scalp as the active strategy

Range Scalp (above) is still defined in `js/futures/setups.js` and still
exported, but the engine's active strategy is now **AI Scalp** — a
genuine 1:1 stop:target instead of Range Scalp's deliberate skew, per a
direct request for a fast (target: 8-16 min), high-win-rate, 1:1 R:R
strategy with a configurable simulation balance and a much broader
symbol watchlist (6 → 35 pairs).

**The 1:1 + high-win-rate combination needed a real approach change, not
just new numbers.** The honest math from the section above still holds:
on a fair, driftless random walk, P(hit TP first) = stopDistance /
(stopDistance + targetDistance) = exactly 50% at 1:1, before costs. A
first attempt at AI Scalp reused Range Scalp's core idea — fade a
stretched move back toward the M5 EMA9 — just with symmetric levels
instead of a skew. Backtested win rate: **~25-29%**, well *below* even
the fair-coin-flip baseline. `mockMarket.js`'s "mood" process gives price
genuine short-run persistence (see its header comment), and a naive fade
was systematically fighting that persistence, not exploiting it.

The fix was to flip the detector to trade **with** that momentum instead
— M5 EMA9 sloping in the trade direction, price confirming on the
momentum side of it, a push candle, RSI in a continuation (not yet
exhausted) zone, and a volume expansion behind the move. Same 1:1
construction, opposite thesis. That backtested at (numbers superseded — see "Update: a much bigger bug" further down):

- Win rate ~69-73% across two runs (135 and 196 closed trades)
- Avg time-to-resolve: ~14 minutes (target band was 8-16 min)
- Profit factor: 1.2-1.5, net of fees/spread/slippage/funding

This is a real, measured property of trading with THIS synthetic feed's
built-in momentum — not a hardcoded number, not a re-skewed stop/target
dressed up as 1:1, and not a promise about live markets. It could look
very different once Phase 2 wires in real exchange data, where
short-term momentum is generally weaker and less persistent than in this
seeded generator. Nothing in the confidence scoring or gating logic
targets a win-rate number directly — it only rejects lower-confluence
setups (no push candle, fighting a strong opposing HTF trend, no volume
behind the move); the win rate is whatever falls out of that filter
against the actual price path, exactly as the in-app banner says.

**Watchlist**: expanded from BTC/ETH/SOL/BNB/XRP/DOGE to 35 USDT-M
pairs spanning large caps, majors, L1/L2 alts, and higher-beta
meme/mid-cap names (`js/futures/mockMarket.js`) — no longer confined to
the same handful of symbols every scan.

**Simulation balance**: now a configurable "Simulation balance (USDT)"
field on the Futures tab (defaults to $10,000) instead of a hardcoded
constant, with a "Reset Session" button to start a fresh paper session
at whatever balance is entered. Default risk per trade is 1% of that
balance (was 0.375%); `RISK_DEFAULTS.maxPortfolioRiskPct` was raised
from 1.5% to 3% so three simultaneous 1%-risk positions still fit under
the portfolio-risk cap the way three 0.375% ones used to.

## Update: two calculation bugs fixed

**1. Current Balance could sit below the starting balance in a session
that was genuinely profitable.** `dayState.equity` was only ever
credited with the P&L of whichever slice of a position closed it — for a
trade that exited entirely on one leg (a stop-loss with no prior partial),
that's correct. But AI Scalp's TP1/TP2/TP3 share the same price, so a
winning trade usually fires all three partial exits (50%/25%/25%) back to
back in one candle, and equity was only picking up the LAST 25% slice,
silently dropping the other 75% of that trade's profit from the balance —
even though the "Net P&L" stat (summed separately, correctly, from every
slice) already had it right. Fixed by crediting equity with the trade's
full accrued net P&L (`pos.finalNetUsd`, the same figure already used
correctly for the trade's win/loss verdict and its trade-history row) —
not just the final slice.

**2. Fees looked disproportionate to the stated risk because the
underlying position size was, too.** Position sizing derived notional
purely from risk-amount ÷ stop-distance, with no check on whether the
resulting margin requirement (`notional / leverage`) was something the
account could actually support. For AI Scalp's genuinely tight stops
(0.15-0.42%), that produced notional positions of $24k-$67k against a
$10,000 account at 2x leverage — margin requirements 1.2x-3.3x the entire
account, which any real exchange would reject outright as insufficient
margin. Fees and funding are both charged on notional, so the fee dollar
amounts inherited that same unrealistic inflation. Fixed by capping
notional at 90% of `equity x leverage` — the dollar amount actually put
at risk on a very-tight-stop trade now legitimately comes in under the
nominal 1% target (that's what a real leveraged account does too, not a
bug to hide), and fees now scale off a position size that could actually
be opened. This backtest was measured before the deterministic-seed bug
below was found and fixed, so the specific numbers here are superseded —
see "Update: a much bigger bug" further down for the corrected picture.

## Update: Live/Demo trading, Bybit only (first exchange)

Paper mode is untouched — same synthetic feed, same default, nothing
about it changed. A second, independent trading mode was added for
Bybit specifically, reachable from the Futures tab's new "Live / Demo
Trading" section.

**The one non-negotiable design decision**: every order this places
carries a stop-loss AND take-profit as native, exchange-side,
market-triggered orders (`tpslMode: 'Full'`), attached at the moment the
position opens — not something this app watches a price feed and reacts
to. A real leveraged position managed by "check back every few seconds
and close it if price crosses a line" is only as safe as this app
staying open and connected; native TP/SL means Bybit itself enforces the
exit even if the tab closes or the connection drops.

**The bug this caught before it shipped**: the scanner's detection logic
was built entirely against `mockMarket.js`'s synthetic prices. Wiring
real order execution straight to that would have meant computing a
stop-loss and take-profit against a price with no relationship to where
Bybit is actually trading. Fixed by building a real data path instead —
`server.js` fetches actual Bybit klines + ticker data and shapes them
into the exact same `{m5, m15, h1, meta}` format the mock generator
already produces (this was **the point** of that shape being generic in
the first place — see `mockMarket.js`'s header). `engine.js`'s
`runScanCycle()` now takes an optional `opts` override
(`{symbols, getSnapshot, getBtcShock, now}`) so the identical
detection/scoring/risk/no-trade code runs against either source; Paper
mode passes nothing and gets the old default behavior unchanged.

**A second bug caught in the same pass**: the no-trade engine's
cooldown-after-consecutive-losses check compared a real timestamp
(`dayState.lastLossAt`) against `mockMarket.now()` — the *simulated*
clock, a completely different epoch from real wall-clock time. Anything
that mixed real and simulated timestamps would make that comparison
meaningless. Fixed by threading the same injectable `now()` through
that check too, so Live/Demo consistently uses `Date.now()` throughout.

**What's deliberately conservative about this first build**:
- One real position at a time, not the 3 Paper mode allows.
- A smaller, curated 10-symbol watchlist (must include BTCUSDT, which
  the shock filter reads directly), not Paper's full 35 — keeps real API
  call volume reasonable.
- Arming requires the same typed-phrase confirmation Autotrade's real
  spot execution already uses, resets on every page load AND on every
  trading-mode change, and is blocked outright unless a verified Bybit
  key already exists for the selected mode (reusing the same credential
  Autotrade & Balances manages — nothing new to connect).
- Switching Demo <-> Live wipes the session's stats rather than mixing
  two different accounts' numbers together.

**What's still Paper-only**: Binance Futures, MEXC Futures, and Gate.io
Futures. Bybit was the first; extending this to the others is additive
work (new market-data adapters, new order-placement functions per
exchange's own API) — the pattern from this build should make it faster,
not a redesign.

## Update: Binance Futures added as the second Live/Demo exchange

Same pattern as Bybit — real klines+ticker shaped into the shared
snapshot format, native/exchange-enforced stop-loss and take-profit,
one position at a time, arm-with-typed-phrase. Two things about Binance
specifically made this NOT a copy-paste of the Bybit version:

**Binance doesn't support attaching a stop-loss/take-profit to the entry
order.** Bybit does this in one call (`tpslMode: 'Full'`); Binance needs
three signed calls per position — the market entry, then a separate
`STOP_MARKET` and a separate `TAKE_PROFIT_MARKET`, both `closePosition:
true`. Worse, **Binance changed which endpoint conditional orders go
through at all, in an API change dated 2025-12-09** — `STOP_MARKET`/
`TAKE_PROFIT_MARKET` used to go through the regular order endpoint;
they now 404/reject there and have to go through a newer
`/fapi/v1/algoOrder` endpoint instead. This was caught during research
(a live GitHub issue from another bot's maintainer breaking on exactly
this), not discovered by trial and error against a real account. Because
opening a Binance position is three calls instead of one, there's a real
failure mode here that Bybit's single-call version doesn't have: the
entry can fill and then either exit-order call can fail, leaving a real
leveraged position open with no protection. That case is caught
explicitly and reported as its own clearly-worded error (not a generic
"order failed") telling you to go check Binance directly — it does not
retry silently or pretend the position isn't there.

**Binance keeps futures in a completely separate wallet from spot.**
Bybit's account is unified, so Live/Demo trading could just reuse the
same balance getter spot Autotrade already had. Binance can't — a new
`/api/futures/balance` route and a dedicated `binanceFuturesBalance`
were needed, or this would have silently read the wrong number (spot
balance) when sizing a futures position.

**No single "closed PnL" endpoint.** Bybit has one
(`/v5/position/closed-pnl`) that hands back a single net number.
Binance's closest equivalent is its income ledger
(`/fapi/v1/income`) — this sums every `REALIZED_PNL`, `COMMISSION`, and
`FUNDING_FEE` entry for the symbol since the position was opened
(tracked client-side as `openedAtMs`, sent with every position check) to
reconstruct the same net figure.

Everything else — the real-data snapshot shape, the injectable
`getSnapshot`/`now`/`getBtcShock` mechanism in `engine.js`, the one-
position-at-a-time policy, the arm-phrase flow — is unchanged and now
shared across both exchanges rather than hardcoded to either.

## Update: Gate.io Futures added as the third Live/Demo exchange

Same overall pattern again — real klines+ticker shaped into the shared
snapshot format, exchange-enforced stop-loss/take-profit, one position
at a time, arm-with-typed-phrase. Two things specific to Gate.io:

**Its futures API lives on an entirely different domain from spot** —
`fx-api.gateio.ws` / `fx-api-testnet.gateio.ws`, not `api.gateio.ws` /
`api-testnet.gateapi.io`. Confirmed from Gate's own API changelog
("Domain of base URLs are changed to fx-api.gateio.ws..."), not assumed
by analogy to the spot integration built earlier — reusing the spot base
would have silently pointed at the wrong host.

**Gate.io futures orders are sized in whole CONTRACTS, not base-asset
quantity.** Each contract represents a fixed amount of the underlying
(`quanto_multiplier`, from the contract's own public info) — the
engine's computed base-asset qty gets converted and floored to a whole
contract count before it means anything here. This implementation
doesn't support partial-contract sizing (most contracts don't either).
Direction is also encoded differently than the other two exchanges: Gate
uses the *sign* of the order size (positive = long, negative = short)
rather than a separate side field.

**TP/SL uses Gate's price-triggered order API** (`POST
/futures/{settle}/price_orders`) — two separate trigger orders after the
entry fills, same "separate calls" shape as Binance rather than Bybit's
one-call inline attachment, using `order_type:
plan-close-long-position`/`plan-close-short-position` so each trigger
closes the whole position regardless of size. Gate does have a newer
inline TP/SL field on the entry order itself
(`tpsl_tp_trigger_price`/`tpsl_sl_trigger_price`, per their changelog) —
deliberately not used: it's new enough that the full required schema
around it couldn't be confirmed with confidence during research, and
this isn't code to guess on. The trigger-order API used instead is
older, has a fully-documented request/response shape including a working
code example, and is what several third-party trading bots already use
in production.

Same separate-wallet situation as Binance (a dedicated
`/api/futures/balance` entry, not reused from spot) and same
no-single-closed-PnL-endpoint situation (reconstructed from the account
ledger's `pnl`/`fee`/`fund` entries for the contract since the position
opened, via `openedAtMs` — same approach as Binance's income-ledger sum).

**MEXC Futures is the one remaining exchange, not yet built.** Its
contract API lives on a different domain from its spot API with a
different, less-standard signing scheme — deliberately saved for last
rather than attempted under the same research/implementation pass as
the other three.

## Update: MEXC Futures added as the fourth and final Live/Demo exchange

Same overall pattern as the other three — real klines+ticker shaped into
the shared snapshot format, exchange-enforced stop-loss/take-profit, one
position at a time, arm-with-typed-phrase — with two things specific to
MEXC that made it the exchange to research most carefully, saved for
last on purpose:

**MEXC's programmatic Futures order placement is genuinely new** —
launched 2026-03-31, about five months before this was built, per MEXC's
own announcement ("Introducing API Futures Trading on Mar 31, 2026").
That's not a reason to distrust what's implemented here (everything
below comes straight from MEXC's own current API docs, not guessed by
analogy to MEXC's older, more established spot API), but it's real
context: this integration has the least real-world mileage of the four,
the smallest body of other bots/tooling having already found and fixed
the rough edges. Said plainly in the app's own UI, not just here.

**MEXC's Futures API domain changed on 2026-01-14** —
`contract.mexc.com` to `api.mexc.com`, with the old domain fully
decommissioned within a week of the transition period ending. Confirmed
from MEXC's own "Futures API Access Domain Update" announcement, not
assumed from older docs or tooling that would now silently point at a
dead host.

**No Demo mode.** MEXC does have a Futures "Demo Trading" — but it's a
website/app-only feature (its own "receive demo coins" flow) with
nothing in MEXC's current API documentation exposing a demo/testnet base
URL the way Binance/Bybit/Gate.io each do. This app's Trading Mode
selector blocks Demo for MEXC specifically (`LIVE_ONLY_EXCHANGES` in
`js/futures-ui.js`) rather than silently letting someone select it and
have it quietly hit Live — same "MEXC has no public Demo Trading" fact
this app has always shown for MEXC spot, extended to futures.

**Simpler than three of the four in one respect**: MEXC's order-create
endpoint takes `stopLossPrice`/`takeProfitPrice` AND `leverage` directly
on the entry order — one call opens the position with both already
attached, same as Bybit, and simpler than Binance/Gate.io's
separate-calls approach. It does need one thing neither of the others
require: a `price` field even on a market order (used as a
price-protection reference, not a limit) — the app threads the scanned
entry price through for this specifically (`entryPrice` in the
`/api/futures/order` body), ignored by every other exchange.

**Sizing is contract-based, same situation as Gate.io** — MEXC's
`contractSize` plays the same role as Gate.io's `quanto_multiplier`, and
this implementation floors to whole contracts the same way. **Symbol
format is also underscore-separated** (`BTC_USDT`), same conversion
pattern as Gate.io. **Kline response shape is genuinely different from
every other exchange here** — MEXC returns columnar parallel arrays
(`time[]`, `open[]`, `high[]`, `low[]`, `close[]`, `vol[]`) rather than
an array of candle rows, so the parsing step zips them together into the
shared `{t,o,h,l,c,v}` shape instead of just mapping over rows.

All four Live/Demo integrations are now built. What's still genuinely
missing, stated in the app's own footer: real historical backtesting,
walk-forward optimization, and Monte Carlo analysis, none of which this
static app has anywhere to store the historical OHLCV they'd need.

## Update: Bitget Futures added as the fifth and final Live/Demo exchange, plus two UI bugs fixed

**Bug fixes first, since they were reported directly:** the Paper-mode
Exchange dropdown was missing Bitget as an option (Binance, Bybit, MEXC,
Gate.io only) — simple oversight, added now; `cfg.exchange` in Paper
mode is purely a display label (never consumed by the cost/fee model),
so this was a safe, zero-risk fix. Separately, the Trading Mode
dropdown's "Demo" option had Bybit's name hardcoded into it
("Demo — Bybit Demo Trading") regardless of which exchange was actually
selected — misleading, since the underlying logic already correctly used
whichever exchange was selected. Fixed by making that label update live
as the Exchange dropdown changes, and by making switching exchanges
while Live/Demo is active trigger the same arm-reset/stats-reset safety
behavior that switching Trading Mode already did (extracted both into
one shared `resetLiveSession()` so the two paths can't drift apart) —
worth calling out because switching exchange mid-session without that
reset would have silently continued monitoring positions under a stale
context, not just shown a wrong label.

**Bitget Futures itself** turned out to be the simplest of the five to
wire up, for one specific reason: it's the only one that shares its
entire host and signing scheme with its own spot integration
(`api.bitget.com`, the same `bitgetSignedRequest` helper, the same
Demo-mode `paptrading: 1` header) — no new domain, no new signature
algorithm, no new credential type to collect. It also attaches TP/SL
directly on the entry order (`presetStopSurplusPrice`/
`presetStopLossPrice`), one call like Bybit and MEXC, not the
separate-calls pattern Binance and Gate.io need.

**Where confidence is lower than the other four, stated plainly rather
than smoothed over:** Bitget's Demo trading mechanism for the *classic*
mix (futures) API has conflicting documentation across Bitget's own
API history — an older v1 system used entirely different `productType`
values (`sumcbl`) and special demo-coin symbols (`SBTC`, `SUSDT`), while
newer documentation describes the `paptrading` header as a general
mechanism tied to their Unified Trading Account system. This
implementation uses the newer header-based approach, for consistency
with the Bitget spot integration already in this app (same mental model:
Demo API key + one header, not a special symbol set to memorize) — but
unlike the order-placement mechanics themselves (sourced from
directly-confirmed, internally-consistent v2 mix API documentation),
this specific piece hasn't been independently verified end-to-end
against a real Bitget Demo futures account. Said directly in the app's
own UI, not just here — start in Demo and confirm a few trades resolve
correctly on Bitget's own UI before trusting it further.

**One field-naming uncertainty, handled defensively rather than
guessed:** Bitget's contract-config endpoint's exact field names for
size step / minimum size weren't pinned down with the same certainty as
the rest of this integration — `bitgetFuturesSymbolFilters` tries
`volumePlace` (decimal-places count) first, falling back to
`sizeMultiplier` if that's absent, rather than trusting a single
assumed field name for something that affects order sizing.

All five exchanges are now built for Live/Demo futures trading (four
full Live+Demo, MEXC Live-only). Same standing caveat as every exchange
before it: none of this has been tested against a real account from
this codebase's own testing — that's not something an AI assistant can
do for you.

## Update: a much bigger bug — the mock market's seed was never random

While investigating a report of a ~30% real-money win rate on Binance
Demo (dramatically worse than this file's own quoted 65-76%), a much
more fundamental problem turned up: `mockMarket.js` seeded its random
walk with a **fixed constant** (`1337 + i*97` per symbol) — not derived
from the time, not derived from anything session-specific. Every random
draw in the price generator, including ongoing ticks during a live
session (not just the initial seed history), pulled from that same
seeded PRNG.

The practical effect: **every "backtest run" ever cited in this file, in
this codebase's code comments, and in the app's own Paper-mode banner
was replaying prefixes of the exact same one price sequence** — not
independent samples of different market scenarios. A fresh `node
run.mjs` process, or a fresh page load, always generated identical
prices. Apparent "variation" between runs earlier in this project's
history came entirely from *how many ticks* a wall-clock time budget
happened to consume before cutting off — different-length windows into
one deterministic path — not from genuine re-randomization. This is a
weaker form of evidence than "backtested across many independent runs"
ever implied, and every specific number quoted (69-73%, then 65-76%
after later fixes, 1.2-1.7 profit factor) inherited that weakness
without anyone — including the several prior passes through this exact
file — noticing.

**Fixed**: `MockMarket`'s constructor now seeds from `Date.now()` at
module load instead of a fixed constant, so every fresh session
generates a genuinely different synthetic history. Re-running the
(now actually independent) backtest six times:

| Run | Win rate | Profit factor |
|-----|----------|----------------|
| 1 | 62.0% | 0.82 |
| 2 | 59.0% | 0.79 |
| 3 | 72.0% | 1.36 |
| 4 | 59.5% | 0.79 |
| 5 | 61.0% | 0.86 |
| 6 | 70.0% | 1.28 |

Averaging roughly breakeven with real spread between clearly-losing and
clearly-profitable runs — nowhere near the confident 65-76% previously
documented. This doesn't retroactively fix anything that was already
measured under the bug, and it doesn't explain the full gap to a real
30% win rate on real data — but it does mean the synthetic baseline
itself was never as strong as this file claimed, which makes that gap
somewhat less alarming (though not okay) than it first looked.

**A strategy change was attempted and reverted, on the record:** given
the real-world report, a tightening of the detector was tried — RSI and
volume confirmation promoted from confidence bonuses to hard
requirements, blocking weak (not just strong) opposing-trend regimes,
and a stricter momentum-slope floor. All individually defensible on
standard multi-timeframe-confluence theory. Tested against the
(then-still-buggy-seed) synthetic feed across three runs, it turned
profit factor from ~1.5 into ~0.80-0.86 — a losing strategy — every
time. Shipping a change with no evidence it helps and clear evidence it
hurts the only thing measurable would have been worse than not shipping
it, so it was reverted rather than kept on the theory that it was
"probably right anyway."

**What was actually added instead**, since a real strategy fix can't be
responsibly claimed without real historical data to validate against
(which this app has no infrastructure to fetch/store — see "What's
next" in the app's footer):

- **Adaptive confidence**: every consecutive REAL Live/Demo loss raises
  the confidence bar the next signal has to clear (+8 per loss, capped
  at +25), on top of whatever Min Confidence is set to. A win resets it
  to zero. This is a plain rolling counter and two numbers, fully
  visible in `js/futures-ui.js` — not a trained model, and not described
  as one — but it is a genuine, inspectable way for live trading to get
  pickier in response to what's actually happening on the account, which
  is what "learn from the losers" can honestly mean without a real
  backtesting pipeline behind it.
- **Circuit breaker**: 4 consecutive real losses on the same
  exchange/network auto-pauses Live/Demo trading, force-disarms it (not
  just stops the loop — the typed arm-phrase has to be re-entered), and
  says plainly why. This exists specifically because Paper mode's
  backtest — even the corrected version — is not evidence about how a
  session will go on real money; a losing streak should stop and get
  reviewed, not run until the user notices.

## Update: fee/gross P&L transparency, and a second real accounting bug (Bybit Demo)

Live/Demo trading's stat tiles used to show Net P&L only — no Gross or
Fees, unlike Paper mode's own dashboard, which has always broken those
out. Binance, Gate.io, MEXC, and Bitget's closed-PnL getters already had
the raw components on hand (they were just being summed blind); each
now returns `{closedPnl, grossPnl, feesUsd}` (Binance/Bitget also
`fundingUsd`) instead of one opaque number, surfaced as two new stat
tiles and two new trade-history columns.

**Bybit is the exception, and for a real reason, not an oversight**:
`/v5/position/closed-pnl` — the endpoint the original implementation
used — **does not work on Bybit Demo accounts at all**, rejecting with
`ErrCode 10032, "Demo trading are not supported"` (confirmed from
Bybit's own SDK issue trackers). The position-check route's own
`.catch(() => null)` was silently swallowing that rejection, which means
**every closed Bybit Demo trade has likely been recording $0 P&L**
regardless of what actually happened on the account — a real accounting
bug, not just a missing feature. Fixed the same way the earlier
spot-Autotrade P&L bug was fixed: measure the actual account balance
before opening and after closing (`balanceBeforeUsd`, captured by the
client and threaded through to the position-check call) instead of
trusting an endpoint that doesn't work in one of the two modes it's used
for. Bybit's Gross/Fees now show as unavailable ("—") rather than
guessed, since that balance-delta approach only yields one net number,
not a breakdown — which is the honest tradeoff for fixing something that
was previously silently wrong 100% of the time.

## Update: diagnosable market-data fetch failures (all five exchanges)

Every one of the five `*BuildFuturesSnapshot` functions called `fetch()`
directly and never checked `res.ok` — if an exchange returned a 429
(rate limited), 451 (geo-blocked), 418 (IP banned), or any other non-2xx
status, the error BODY got parsed as if it were valid kline/ticker data,
producing a generic downstream "not enough kline history" error that
gave no indication of the real cause. Reported specifically as a
recurring Binance failure ("could not fetch real BTC market data").

Fixed by routing all five through one shared `fetchJSON` helper that
checks `res.ok`, includes a 10s timeout (none of the five had one
before, so a hung connection could previously stall a whole cycle
indefinitely), and — the actually useful part — surfaces the real HTTP
status and response body in the thrown error, with an explicit hint for
451 ("this usually means the exchange is geo-blocking this server's
IP") and 429/418 ("rate limited"). Binance in particular is known to
aggressively geo-block certain regions even for public, unauthenticated
market data, not just trading — if this keeps happening, the new error
message will say so plainly instead of leaving it a mystery, and the fix
at that point is deploying the server to a different region, not
anything in this codebase.

## Update: the fee-drag bug — real Bybit Demo trading, not a misreading

Reported directly from a live session: 6 real Bybit Demo trades, 50%
win rate, **Gross P&L +$2.89** but **Fees -$117.09**, netting **-$114.20**.
The instinct was "the app must be miscalculating fees" — it wasn't. The
fee shown ($25.12 on a $22,857 LTCUSDT position) matches Bybit's real
published 0.055% taker rate almost exactly. The bug was upstream of the
fee calculation entirely.

**The actual mechanism**: AI Scalp's stop-distance floor was 0.15% of
price. Real round-trip futures taker fees run ~0.10-0.12% on four of the
five exchanges here (0.06% one-way on Bitget, the highest — see
`DEFAULT_FEE_CONFIG` in `js/futures/costs.js`, sourced from each
exchange's own published fee schedule; Bitget's own 0.02%/0.06% entry
was missing from that table entirely until this fix, silently falling
back to Binance's slightly lower rate). At a 0.15% stop, round-trip fees
alone could be **70-80% of the entire risk budget on every trade** —
before the market even had to move against you. Worse, `positionSize()`'s
pre-existing margin cap (see `risk.js`) kicks in on stops this tight,
capping notional below what the 1%-risk math calls for — which reduces
the *actual* dollar risk taken below the intended 1%, while fees (which
scale with the now-capped notional itself, not the smaller actual risk)
end up an even larger fraction of what was really at stake. Combined
with the reward:risk ratio being only 1.2, a real trade's math looked
roughly like: lose (stop + fees) ≈ 0.15% + 0.12% = 0.27% on a loser,
net (target - fees) ≈ 0.18% - 0.12% = 0.06% on a winner — which needs
something like a **79-82% win rate just to break even**, not the ~50%
this build's own detector was ever designed or measured to produce (see
the sections above). A near-coin-flip win rate against a bar that high
was always going to net sharply negative, exactly as the real numbers
showed.

**Fixed at the source, not by hiding the symptom**:
- AI Scalp's stop-distance floor raised from 0.15% to 0.35% (cap raised
  0.42% → 0.9%) — see `buildLevels` in `engine.js`.
- Reward:risk changed from a user-adjustable 1.2 default to a **fixed
  2.0 (1:2) for every trade, no longer configurable** — see
  `RISK_DEFAULTS.riskRewardRatio` in `risk.js`; the "Reward:Risk" field
  in the UI is now read-only.
- AI Scalp's net-profit floor raised from 0.03% to 0.15% — the old
  figure left almost no margin above real fees once spread/slippage
  were added on top.
- A new no-trade gate rejects any setup where round-trip fees exceed
  35% of its own stop distance — a direct, general-purpose backstop for
  this exact failure mode, independent of which setup produces the
  signal in the future.
- Bitget's fee entry added to `DEFAULT_FEE_CONFIG` (0.02%/0.06%, its own
  published rate) instead of silently inheriting Binance's.
- LTCUSDT and DOGEUSDT added to `EXCLUDED_FUTURES_SYMBOLS` (joining
  BTC/ETH/SOL) per an explicit request to remove them specifically, on
  top of the general fix above.

**The math after the fix**, at the worst-case fee (Bitget, 0.12%
round-trip) and the new stop floor: a loser costs 0.35% + 0.12% =
0.47%, a winner nets 0.70% - 0.12% = 0.58%. Breakeven win rate works
out to roughly **37-45%** depending on exchange and where ATR places
the stop in its new range — down from ~79-82%. That is a real, checked
number, not a promise about what this build's actual win rate will be
live: no amount of stop/ratio engineering manufactures an edge that
isn't there, it only changes how much edge is required to survive real
costs. See the AI Futures Engine tab's own footer for the same account
in the app itself.

## Update: the doubled-position bug, and what real trading data did/didn't confirm

Reported from a real Bybit session: an ARBUSDT loss where this app's own
trade history showed qty 58884, but Bybit's own order history for what
was unmistakably the same close (same P&L to four decimal places, same
entry price) showed qty **117768 — exactly double**.

**The mechanism**: this app is designed to hold at most one real
position per symbol at a time (`runLiveCycle` bails out early if
anything is already open — see `js/futures-ui.js`). That guard relies on
the client's own in-memory record of what's open. `placeBybitFuturesOrder`
polls Bybit for up to 6 seconds after submitting an order, waiting for
`orderStatus === 'Filled'` before reporting success back to the client.
If that confirmation ever came back ambiguous — the 6s window elapsing,
or a dropped response after Bybit had already filled the order — the
server threw an error, the client showed "Order failed", and critically
**never recorded the position**. Its own memory now believed the account
was flat. On the next 8-second cycle, nothing stopped it from placing a
second real entry on the same symbol — and Bybit, like every exchange,
nets same-side fills on the same symbol into one bigger position rather
than tracking them as separate trades. The client only ever knew about
the second order's own size, which is exactly what its display showed;
the real, combined position — and the real risk taken — was double that.

**Fixed at the source, for all five exchanges, not just Bybit**:
`/api/futures/order` now asks the exchange itself — not this app's
memory — whether a position already exists for that exact symbol before
ever placing a new entry, using the same `FUTURES_POSITION_GETTERS` this
app already had for detecting closure. If one exists, or if that check
itself can't be confirmed (rate limit, transient error), the order is
refused outright rather than risking a repeat. Bybit's own ambiguous-
timeout message was also fixed to check for a real fill before giving up,
so it no longer reads like "nothing happened" when something likely did.

**What real data did NOT confirm, despite looking that way at first
glance**: that the 1:2 reward:risk isn't actually being built. Checked
directly against a matched win/loss pair on the same symbol from that
session (HYPEUSDT): the loss moved -0.35% into its stop, the win moved
+0.69% into its target — a real, working ~1:2 price ratio. The
appearance of "$100 losses vs. barely-$100 wins" comes from comparing
raw dollar P&L *across different symbols*, which naturally have
different position sizes for the same %-of-equity risk (a wider-stop
symbol gets a smaller qty, a tighter-stop one gets a larger qty, so the
dollar risk stays ~1% either way) — that's correct behavior, not a bug.
The doubling bug above is the far more likely real explanation for any
specific loss landing disproportionately large: a doubled loss is a
genuinely bigger number sitting next to a normally-sized win.

**What was a real, if quieter, bug**: the default "Min confidence" was
60 — which turned out to be the exact floor of AI Scalp's own 60-87
confidence range (see the formula in `setups.js`). Every signal that
cleared the earlier structural checks passed the confidence gate
regardless of whether RSI, volume, or momentum strength actually
confirmed it, because 60 was achievable with zero of those. Raised to
70, which requires at least one genuine confirmation now.

**What was deliberately NOT changed, on request to "improve the win
rate"**: AI Scalp's regime/direction logic. The obvious-looking fix —
penalize or block counter-trend entries against a merely-weak (not
strong) opposing trend — is exactly what an earlier revision of this
file already tried, with RSI and volume as hard requirements instead of
confidence bonuses on top of it. Tested against this synthetic feed
(the only data available to test against) across three separate runs,
it turned a ~1.5 profit factor into ~0.8 — a losing strategy. That
result is preserved as a comment directly above the regime check in
`setups.js` for exactly this reason: so a future change (including this
one) doesn't re-attempt it on intuition alone and silently reintroduce
a measured regression. Nothing here overrides that finding without new
evidence it no longer applies.

## Update: two more strategies enabled, on request for "a different one" specifically

Explicit ask: improve the win rate without touching the AI Signal
feature, "maybe a different strategy perhaps that offers that." Fair —
the AI Signal check is an external, optional filter; a genuinely
different DETECTOR is a different kind of change.

`setups.js` already had four other fully-built detectors sitting
inactive since the single-strategy build (see the "Single-strategy
build" comment this replaces): Trend Continuation, Breakout + Retest,
Range Reversal, and Liquidity Sweep Reversal. Two enabled, two left
alone, on purpose:

**Enabled — Trend Continuation.** Enters on a pullback INTO an
established trend (price retracing toward EMA20/VWAP on contracting
volume, then momentum resuming), not on fresh momentum the way AI Scalp
does. Different entry mechanism, different risk shape.

**Enabled — Liquidity Sweep Reversal.** A real reversal pattern, not a
continuation one: price sweeps past a recent swing high/low (a classic
stop-hunt shape) and immediately reclaims it, with volume confirmation
required to fire at all — a hard gate, not a confidence bonus like AI
Scalp's RSI/volume checks. `decideExecution` (costs.js) already had a
specific TAKER-execution case for this exact setup type, sitting
unused — a sign this one was built with reactivation already in mind.

**Left inactive — Range Reversal.** More strictly gated than the old,
disproven Range Scalp (validated swing-level support/resistance plus a
rejection candle, not just ATR-distance from an EMA) — but still
philosophically a fade/mean-reversion approach, and this synthetic feed
has a documented, MEASURED case of that style losing to its own
short-run momentum (Range Scalp's ~25-29% win rate — see the
"deterministic seed bug" section and detectAiScalp's own comment).
Re-enabling a fade-flavored setup without evidence it doesn't repeat
that isn't a risk worth taking on the strength of "it's gated better
this time" alone.

**Left inactive — Breakout + Retest.** Conceptually closer to AI
Scalp's own momentum-chasing character than a genuine change of style —
adds less diversification than the two enabled above for the same "is
this actually different" bar.

**A real bug this surfaced before either went live**: every setup
OTHER than AI Scalp shared one `buildLevels` fallback branch in
`engine.js` with a stop-distance floor of **0.12%** — tighter even than
the 0.15% value that caused AI Scalp's own fee-drag disaster (see
above). It was never exercised in real trading because nothing but AI
Scalp was ever active, so it never had the chance to blow up the way AI
Scalp's did — but it was the identical landmine, waiting. Raised to
0.35%, matching AI Scalp's own fixed floor, before enabling anything
that would actually reach that code path.

**Honesty note, same standard as everywhere else in this file**:
neither newly-enabled detector has been measured against this engine's
CURRENT fixed-1:2-RR, current fee model, or current stop-distance
floors. The win-rate figures quoted elsewhere in this file (Range
Scalp's ~25-29%, AI Scalp's murkier post-seed-bug numbers) are specific
to the old engine and do not transfer to these two. This is a reasoned,
differently-shaped addition — genuinely different entry logic, hard
volume gates, a real fixed landmine caught before it mattered — not a
proven improvement. It goes in the same bucket as everything else in
this build: judge it against real Live/Demo trade history, not a claim
made here.

## Update: NxTGen Scalp rebuilt around Parabolic SAR / EMA50+EMA100 / Awesome Oscillator

On direct request to trade a specific, chart-verified pattern instead of
the EMA9-slope momentum read described above, `detectAiScalp` in
`setups.js` (type `NxTGen Scalp`, id `aiScalp` in `STRATEGY_REGISTRY`) is
now a different detector entirely. `js/futures/indicators.js` gained two
new pure functions to support it: `parabolicSar()` (a standard Wilder
SAR, returning one value per bar) and `awesomeOscillator()` (SMA5-SMA34
of median price, with per-bar 'green'/'red' coloring — a bar is green
when it's higher than the prior bar, red when lower, matching the
standard convention rather than a simple positive/negative split).

**The setup, read directly off two reference chart screenshots**: watch
where the SAR dots sit relative to the EMA50/EMA100 band. SAR flipping
from above the band to below it is a Buy; the dots were riding above
price through a downtrend, then cross under both EMAs as the trend
turns up. The mirror flip (below the band to above it) is a Sell. Both
are confirmed by the Awesome Oscillator's bar color: green for Buy, red
for Sell — hard gates, not confidence bonuses, matching how the AO
histogram color lines up with the boxed cross in both reference charts.

**One thing that isn't obvious from the charts and needed real testing
to get right**: the SAR dots don't jump the whole EMA band in a single
bar, and the AO's own color doesn't necessarily flip on the exact same
bar the band-cross completes either — it's a lagging SMA5-vs-SMA34 read.
Against a synthetic oscillating price series built to check this
(sine-wave "trend" plus per-bar noise, not the two-phase drift used for
an earlier, misleading first test), the AO color typically caught up to
a completed cross something like 15-25 bars later, not on the same bar.
A same-bar-only requirement fired essentially never in that test. The
detector instead treats a cross as live for up to 30 bars after it
completes (scanning back, skipping ambiguous bars where SAR sits inside
the band, for the most recent bar clearly on the OTHER side) — confirmed
against that same synthetic series to correctly fire LONG near troughs
and SHORT near peaks once the recency window was wide enough for the AO
to realistically catch up.

**Confidence, not gated on**: EMA50-vs-EMA100 alignment (does the faster
EMA already sit on the trade's side of the slower one, i.e. does the
band itself agree the trend has turned, not just the SAR dot) and the AO
color streak (how many consecutive bars have held the confirming color).
A fresh SAR flip is often the leading edge of a trend change and won't
always have the EMAs fully aligned yet, so this isn't a hard requirement
the way the cross + AO color are.

**Stress-tested** (3,510 detector calls across flat, sine-wave, and pure
-noise synthetic series, no real-data backtest yet): zero exceptions,
no out-of-range confidence values, signals fired at a plausible rate.
Same standing caveat as every setup in this file — a clean mechanism and
a passing stress test are not a measured win rate. Run it through the
Backtest tab against real historical data before sizing anything real
behind it.

