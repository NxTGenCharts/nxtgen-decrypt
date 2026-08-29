# What changed, and why the numbers are what they are

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
construction, opposite thesis. That backtested at:

- **Win rate: 65-76%** across two independent runs (135 and 196 closed trades)
- **Avg time-to-resolve: ~14 minutes** (target band was 8-16 min)
- **Profit factor: 1.2-1.5**, net of fees/spread/slippage/funding

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
be opened. Re-running the backtest after both fixes: still 65-76% win
rate, profit factor improved slightly to ~1.5-1.7 (fees now a smaller,
realistic drag rather than an inflated one).
