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
| `js/quant-ui.js` | Merges the page's shared settings into Quant's config (`getQuantCfg`), the Strategies-card stats line, and the Backtest tab's validation section |

Modified (additively): `setups.js` (registry entry), `engine.js` (Quant branch, open/close), `backtest.js`, `mockMarket.js` (1 flag), `futures-ui.js`, `backtest-ui.js`, `index.html`, `sw.js` (precache). Non-Quant positions take the identical code path as before.

## Settings (no separate Quant panel)
There is no Quant configuration panel. Quant reads the same controls as every other strategy:

| Setting | Where it comes from |
|---|---|
| Min confidence | Top **Min confidence** field (Backtest tab: its own Min confidence field). Clamped to 60–95 for Quant |
| Risk per trade | Top **Risk per trade (%)** field (Backtest tab: its own field). **Capped at Quant's 1% hard ceiling**, then scaled down by the drawdown tiers / high-volatility multiplier as before |
| Selectivity | Top **High Selectivity Mode** toggle: on → *High* tier (score ≥ 80, 5/6 categories, 5 confirmations); off → *Normal*. Backtest always uses Normal. (*Very High* is no longer selectable) |
| Reward:Risk | The Reward:Risk dropdown on Quant's own Strategies card (1:2 minimum) |
| Leverage, min net profit, exchange | Already shared top controls |
| Everything else (entry timeframe, symbols, long/short, setups A–D, max positions, daily/weekly loss limits, loss-streak pause + cooldown, drawdown tiers, auto-resume, funding confirmation, adaptive RR) | No inputs. Uses the defaults in `quant/config.js`, or whatever was previously saved under `nxtgen_quant_futures_config_v1` |

The Quant-only performance table, risk-state readout, equity curve and `[QUANT]` log viewer that lived in that panel were removed with it. The Strategies card still shows a one-line Paper / Live/Demo / Backtest summary, the Backtest tab still shows the full validation section, and `[QUANT]` events still go to the browser console.

## Score (defaults, renormalized to 100)
Trend 20 · Structure 15 · Momentum 15 · Volume/liquidity 10 · Volatility regime 10 · Higher-TF alignment 15 · Entry quality 10 · RR quality 5, ± funding adjustment (−6…+2) when the feed provides it.
Min confidence 70 (60–95); High Selectivity ≥ 80, Very High ≥ 85, both also demanding more agreeing confluence categories/confirmations; +5 in High Volatility.

## Risk
* Risk/trade = the shared Risk per trade field, capped at 1.0% (old Quant default: 0.5% — set the field to 0.5 for that), ×0.7 at 3% drawdown, ×0.5 at 5%, **pause** at 8% (auto-resume after 48 h at ×0.5 for the next 5 trades), ×0.6 in High Volatility. No martingale, no size-up after losses, no averaging.
* Pause after 3 consecutive losses (cooldown 240 min), daily loss limit 2%, weekly 5%, max 3 positions, same-direction risk ≤ 2× per-trade risk (BTC/ETH/SOL are one correlated bet), margin check, per-symbol notional cap.
* These are **strategy-scoped**: they never block other strategies. The shared no-trade gate (fee-to-stop ≤ 25%, min net target, spread, liquidity, portfolio open-risk cap, global daily limits) still applies on top.
* Entry = taker fill at slippage-adjusted price; single limit target; stop-market fill slips against you; no partials/breakeven (they would push realized RR under 1:2).

## Known limitations
* No Daily series exists in any feed → daily context not used; 4H is 15 bars derived from 1H.
* Open-interest / long-short / liquidation data are not provided by any current feed (hooks exist; only funding is used).
* Live/Demo places one real position at a time (existing platform rule), uses the exchange bracket (SL+TP) with no time-stop (Paper/Backtest apply a 6h/12h time-stop), and gets exact lot/tick rounding from the server. Paper/Backtest assume a 3-significant-digit lot step.
* Slippage in Paper/Backtest is modelled (½ spread + 0.6× spread), not observed.
* Quant's risk ledger counts Quant trades only.
* **Excluded pairs are never traded — by Quant either.** BTC/ETH/SOL/LTC/DOGE/BNB/CL are excluded platform-wide (`js/futures/excludedSymbols.js`, the single source of truth) in Paper, Backtest and Live/Demo. `sanitizeQuantConfig` strips them from Quant's symbol list, `evaluateSymbol` rejects them for every strategy, and the backtest loop skips them. Default Quant symbols: XRP, ADA, AVAX, LINK, DOT.

## Integration note (merged with the rebuilt Nova Scalp)
This copy carries the Quant strategy on top of the current Nova Scalp (PSAR/EMA50+100 break, MACD + AO, Smart Range Filter, structure stop, single 2R exit, no time stop in Paper/Backtest — see README-SCALP.md). Two independent single-exit mechanisms now coexist and neither touches the other:
* **Nova Scalp** → `singleTarget` (tp1=tp2=tp3 = the 2R price, fractions 0/0/1, exits through the existing TP3 path).
* **Quant Futures** → `singleTp` (one target in `tp1`, handled by the `singleTp` branch in `engine.js` / `backtest.js`, with Quant's own 6h/12h time-stop and slippage model).
Live/Demo routes both through the single take-profit order path (`usePartialTp` is off when either flag is set).
Shared helpers in `indicators.js`: `efficiencyRatio(values, period)` (takes a values array — the Smart Range Filter calls it with closes), `swingLowPoints` / `swingHighPoints`.

## Watchlist (Paper / Backtest / Live-Demo)
All three modes use the same list, on all five exchanges (Binance, Bybit, MEXC, Gate.io, Bitget — Backtest history for Bitget comes from `/api/v2/mix/market/history-candles`, paged backward and rate-paced): the selected exchange's **top 25 USDT perpetuals by 24h volume**, minus the platform-wide excluded pairs (`js/futures/watchlist.js`, fed by `/api/futures/universe`). Live/Demo scans it directly. Backtest loads it into the symbol picker (all ticked; "Reload top 25" re-fetches; falls back to the built-in list if the proxy is unreachable) — note it is *today's* ranking applied to the whole date range. Paper mirrors the real pair names with synthetic candles (the pair's real last price/volume only seed the random walk); it needs a proxy running the updated `server.js` (which now returns `lastPrice`) and otherwise falls back to the built-in synthetic list. Quant's own symbols are still added on top of whichever list is in use.


## Fix log — "Quant takes no trades" (2026-09)
Two independent causes, both fixed:
1. **Stale 1:2 gate.** `engine.js` `evaluateQuantRow()` and the shared no-trade gate hard-coded a 1:2 minimum after the shipped profile moved to 1:1.5 (`HARD_LIMITS.minRewardRisk` = 1.2), so every signal was rejected. Both now use `HARD_LIMITS.minRewardRisk`. The Reward:Risk dropdown previously offered only 2/2.5/3/4 and displayed "1:2" while 1.5 ran; its options are now 1.3/1.5/1.75/2/2.5/3/4 and always include the default.
2. **Symbol coverage.** Quant only applied to the Paper synthetic list (`mockMarket.js`), so most real Binance/Bybit top-25 names (ZEC, HYPE, ENA, TAO, WLD, TRUMP, 1000PEPE...) were silently skipped. `symbolFilter` now defaults to `null` = every non-excluded pair the mode scans; the old saved `symbols` array is ignored. Set `symbolFilter: [...]` in the config only to restrict Quant by hand.

Added: setup A-D checkboxes and entry-timeframe selector on the Quant card; a pipeline funnel in the Backtest tab (`quant/diagnostics.js`) showing where evaluations stopped; a Quant-only 15m backtest speed-up (identical results); server-side kline pacing, 429/Bybit-10006 retry and symbol aliases (PEPE -> 1000PEPE, SHIB -> SHIB1000 on Bybit); unlisted pairs are reported as a note, not an error.
Thresholds were NOT retuned: no real market data was available when this was fixed. Judge the strategy with real-data Backtest runs and the funnel.


## Fix log — "win rate is very poor" (2026-09, first real 30-day backtest)
**What the first real run showed** (Binance top-25, 5m data, 30 days — the earlier "5 days only" fetch bug was fixed first): 53 trades, 37.7% win rate, profit factor 0.77, expectancy −0.14R, avg win +1.43R / avg loss −1.10R, fees $251.
* The nominal reward:risk is 1:1.5 but the **realized** payoff was 1:1.31 (fees + spread + slippage make wins smaller and losses bigger than 1R). Real break-even win rate ≈ 1.10 / (1.10 + 1.43) ≈ **43.5%**, not 40%. Every +0.1R of cost adds ~4 points to the win rate needed.
* Costs are fixed in price terms, so they hit tight stops hardest: at ~0.16% all-in cost, a 0.5% stop pays 0.32R before the market moves. The shared no-trade gate only limits *fees* to 25% of the stop (spread/slippage not counted), so trades with very tight stops were passing.
* 53 trades is a small sample: the 95% interval on a 37.7% win rate is roughly ±13 points. It cannot tell "no edge" from "a modest edge plus bad luck", and neither can any tweak judged on it.

**Changes (all in `quant/config.js` + `quant/signal.js`; every one can only REMOVE signals, never add them):**
| Knob | Default | Meaning |
|---|---|---|
| `maxCostR` | **0.18** (was: no such filter; 1 = off) | Skip a signal when its estimated round-trip cost (taker in + out + spread + slippage) is more than this fraction of the stop distance. At default fees/spread that means stops of roughly ≥ 0.9%. Shown in the Backtest funnel as the "stop too tight for the fees/spread" stage. |
| `minStopAtr` | 1.2 (unchanged) | ATR floor for the stop; wider = fewer noise stop-outs and a smaller cost/R, but a farther target. |
| `trendFilter` | `'any'` (unchanged) | `'strong'` = trend setups only fire in a STRONG bull/bear regime. |

Thresholds still were NOT tuned on data: no exchange data is reachable from the environment these changes were made in. `maxCostR` is a cost-arithmetic argument, not a fitted number.

**`tools/quant-sweep.mjs`** — runs the app's real backtest engine (same code as the Backtest tab) over ~23 configs (or `--grid full` = 96) on 90 days of real candles, downloaded through the Render proxy and cached, in parallel worker threads. It splits each config's trades chronologically into TRAIN (first ~2/3) and TEST (last ~1/3), ranks on TRAIN, and reports TEST beside it so overfit configs are visible. Needs Node 22+, the fixed `server.js` deployed, and no npm install. `node tools/quant-sweep.mjs --synthetic` is a self-test on fake candles (results meaningless). Run it, then apply the winning settings as defaults only if they hold on TEST and on a later re-run.
