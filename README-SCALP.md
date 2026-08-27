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
