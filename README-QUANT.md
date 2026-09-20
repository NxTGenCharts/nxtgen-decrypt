# NxTGen Quant Futures

An additional strategy in the existing AI Futures Engine (Strategies list → *NxTGen Quant Futures*, listed after NxTGen Grid, so it is the 8th). It reuses the platform's scan loop, no-trade gate, Paper Engine, Backtest engine, Live/Demo order path, Trade Logs and UI components. Off by default.

`node tests/quant.test.mjs` runs the regression tests (Node 22+, no dependencies).

## Honest scope
* **68%+ win rate is a design target, never a displayed result.** Win rate is shown only after 30+ completed trades in *that* mode; below that the UI says `INSUFFICIENT SAMPLE (n/30)`. Backtest, Paper and Live/Demo are separate columns and are never blended. Nothing is filtered, smoothed or cherry-picked.
* **Paper mode runs on the platform's synthetic price feed** (`mockMarket.js`, a seeded random walk with no real edge — an existing design decision). Paper stats therefore test *plumbing and risk behaviour*, not profitability. Judge the strategy with **Backtest** (real Binance/Bybit/MEXC/Gate.io history) and **Live/Demo** (real prices).
* Thresholds (setup rules, score weights, gates) are principled design choices that have **not** been tuned or validated on real market data. The tests use constructed synthetic patterns.

## Pipeline
`snapshot → features → regime → setups A–D → stop → target → 8-factor score → confluence gates → signal → cost estimate → Quant risk engine → sizing → shared no-trade gate → order`

| File | Role |
|---|---|
| `js/futures/quant/config.js` | Defaults, hard limits (RR ≥ 1:2, risk ≤ 1%, ≤ 3 positions), weights, selectivity tiers, persisted config (`nxtgen_quant_futures_config_v1`) |
| `quant/features.js` | Indicators/features; 4H derived from 1H; drops the still-forming candle on real feeds; stale-data check |
| `quant/regime.js` | 9 regimes (Strong/Weak Bull, Strong/Weak Bear, Range, High Vol, Low Vol, Breakout/Expansion, Compression) → which setups may fire, confidence boost, risk multiplier |
| `quant/setups.js` | A Trend Pullback · B Breakout+Retest · C Liquidity Sweep Reversal · D Range Extremes (long/short symmetric) |
| `quant/signal.js` | Stop = max(structure, 1.2 ATR floor, recent swing) capped at 3 ATR (3.5 for sweeps); target = RR × risk; clearance check; 0–100 score; confluence; explanation text |
| `quant/risk.js` | Drawdown-scaled risk, streak/daily/weekly pauses, correlated exposure, margin, sizing + contract step, slippage-aware exits |
| `quant/stats.js` | Stats, equity curve, sample rule, ratios |
| `quant/validation.js` | 70/30 split, Monte Carlo (bootstrap), real walk-forward (parameters chosen on train only, traded on the next unseen window) |
| `quant/log.js` | `[QUANT]` log channel (the codebase had no central logger) |
| `js/quant-ui.js` | Config panel, risk state, stats/equity curve, log viewer, backtest validation section |

Modified (additively): `setups.js` (registry entry), `engine.js` (Quant branch, open/close), `backtest.js`, `mockMarket.js` (1 flag), `futures-ui.js`, `backtest-ui.js`, `index.html`, `sw.js` (precache). Non-Quant positions take the identical code path as before.

## Score (defaults, configurable, renormalized to 100)
Trend 20 · Structure 15 · Momentum 15 · Volume/liquidity 10 · Volatility regime 10 · Higher-TF alignment 15 · Entry quality 10 · RR quality 5, ± funding adjustment (−6…+2) when the feed provides it.
Min confidence 70 (60–95); High Selectivity ≥ 80, Very High ≥ 85, both also demanding more agreeing confluence categories/confirmations; +5 in High Volatility.

## Risk
* Risk/trade 0.5% (0.25/0.5/0.75/1.0), ×0.7 at 3% drawdown, ×0.5 at 5%, **pause** at 8% (auto-resume after 48 h at ×0.5 for the next 5 trades), ×0.6 in High Volatility. No martingale, no size-up after losses, no averaging.
* Pause after 3 consecutive losses (cooldown 240 min), daily loss limit 2%, weekly 5%, max 3 positions, same-direction risk ≤ 2× per-trade risk (BTC/ETH/SOL are one correlated bet), margin check, per-symbol notional cap.
* These are **strategy-scoped**: they never block other strategies. The shared no-trade gate (fee-to-stop ≤ 25%, min net target, spread, liquidity, portfolio open-risk cap, global daily limits) still applies on top.
* Entry = taker fill at slippage-adjusted price; single limit target; stop-market fill slips against you; no partials/breakeven (they would push realized RR under 1:2).

## Known limitations
* No Daily series exists in any feed → daily context not used; 4H is 15 bars derived from 1H.
* Open-interest / long-short / liquidation data are not provided by any current feed (hooks exist; only funding is used).
* Live/Demo places one real position at a time (existing platform rule), uses the exchange bracket (SL+TP) with no time-stop (Paper/Backtest apply a 6h/12h time-stop), and gets exact lot/tick rounding from the server. Paper/Backtest assume a 3-significant-digit lot step.
* Slippage in Paper/Backtest is modelled (½ spread + 0.6× spread), not observed.
* Quant's risk ledger counts Quant trades only.
* The shared fee-to-stop gate makes 5m entries on BTC/ETH almost always untradeable at taker fees — that is the fee math, not a bug.

## Integration note (merged with the rebuilt Nova Scalp)
This copy carries the Quant strategy on top of the current Nova Scalp (PSAR/EMA50+100 break, MACD + AO, Smart Range Filter, structure stop, single 2R exit, no time stop in Paper/Backtest — see README-SCALP.md). Two independent single-exit mechanisms now coexist and neither touches the other:
* **Nova Scalp** → `singleTarget` (tp1=tp2=tp3 = the 2R price, fractions 0/0/1, exits through the existing TP3 path).
* **Quant Futures** → `singleTp` (one target in `tp1`, handled by the `singleTp` branch in `engine.js` / `backtest.js`, with Quant's own 6h/12h time-stop and slippage model).
Live/Demo routes both through the single take-profit order path (`usePartialTp` is off when either flag is set).
Shared helpers in `indicators.js`: `efficiencyRatio(values, period)` (takes a values array — the Smart Range Filter calls it with closes), `swingLowPoints` / `swingHighPoints`.
