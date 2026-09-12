// =============================================================
// backtest.js — walk-forward simulation of THIS ENGINE'S OWN
// detection/scoring/cost/risk/gate logic (regime.js, setups.js,
// scoring.js, costs.js, risk.js, noTradeEngine.js, and
// engine.js's evaluateSymbol/combineEnsemble — all imported and run
// completely unchanged) against REAL historical price history, instead
// of mockMarket's synthetic random walk (Paper mode) or a live broker
// feed (Live/Demo mode). This is what makes it trustworthy as a
// backtest at all: it isn't a re-implementation of the strategy logic
// that could quietly drift from what real trading actually does — it
// IS that logic, fed historical bars one at a time.
//
// What's REAL: OHLCV price/volume, fetched by the caller via
// server.js's /api/backtest/klines (Binance/Bybit public kline
// endpoints — see that file's own comment) and passed in here as
// { [symbol]: [{t,o,h,l,c,v}, ...] } 5-minute candle arrays, already in
// chronological order.
//
// What's ESTIMATED, not fetched: spread%, funding rate%, open
// interest/liquidity score. No free historical feed for these exists
// at retail-accessible granularity going back any real distance — this
// uses fixed, user-adjustable defaults (see DEFAULT_BACKTEST_META)
// instead of quietly pretending they're real. Every result this module
// produces should be read with that caveat attached; the UI surfaces
// it directly rather than only in this comment.
//
// No lookahead bias, by construction: buildSnapshotAt() only ever
// slices each symbol's candle array up to (and including) the bar
// index being evaluated — never anything after it. Position management
// (TP1/TP2/TP3/SL/breakeven/time-stop) is checked one real historical
// bar at a time, in chronological order, against that bar's own actual
// high/low — never against the whole future series at once.
// =============================================================
import { classifyRegime } from './regime.js';
import { evaluateSymbol, netPnlForFraction, EXCLUDED_FUTURES_SYMBOLS } from './engine.js';
import { RISK_DEFAULTS } from './risk.js';
import { computeBtcShock } from './indicators.js';

export const DEFAULT_BACKTEST_META = {
  spreadPct: 0.04,      // round-trip, % of notional — see this file's header comment
  fundingRatePct: 0.0,  // per 8h funding interval, %
  liquidityScore: 60,   // 0-100
};

// Every symbol needs enough of its OWN base-timeframe history behind it
// before it's evaluated at all — regime.js's classifyRegime requires
// >=30 H1 candles and >=30 M15 candles to return anything but
// "insufficient history". How many BASE bars that translates to depends
// on which timeframe was actually fetched (intervalMinutes — 3/5/15/30/
// 60m, see js/backtest-ui.js's TIMEFRAME_MINUTES): at 5m it's the same
// 400-bar (~33h) figure this always used; at 1h (intervalMinutes=60,
// where the base IS already H1) it's a much smaller ~30 bars, so a
// short date range doesn't get entirely eaten by warmup the way a fixed
// 400 would have. warmupBarsFor() below computes this from the same
// aggregation group sizes buildSnapshotAt uses, plus a small buffer.
function m15GroupSize(intervalMinutes){ return Math.max(1, Math.round(15 / intervalMinutes)); }
function h1GroupSize(intervalMinutes){ return Math.max(1, Math.round(60 / intervalMinutes)); }
function warmupBarsFor(intervalMinutes){
  return Math.max(30 * m15GroupSize(intervalMinutes), 30 * h1GroupSize(intervalMinutes)) + 20;
}

function aggregateBase(baseCandles, uptoIndex, groupSize, count){
  const out = [];
  for(let end = uptoIndex + 1; end > 0 && out.length < count; end -= groupSize){
    const start = Math.max(0, end - groupSize);
    const slice = baseCandles.slice(start, end);
    if(!slice.length) continue;
    out.unshift({
      t: slice[0].t, o: slice[0].o,
      h: Math.max(...slice.map(c => c.h)), l: Math.min(...slice.map(c => c.l)),
      c: slice[slice.length - 1].c, v: slice.reduce((a, c) => a + c.v, 0),
    });
  }
  return out;
}

function buildSnapshotAt(symbol, baseCandles, uptoIndex, metaOverrides, intervalMinutes){
  const last = baseCandles[uptoIndex];
  const barsPerDay = 1440 / intervalMinutes;
  return {
    symbol, price: last.c,
    // "m5" is really "the base/execution timeframe" now, not literally
    // always 5-minute bars — every setup/indicator reading snap.m5 just
    // wants the nearest-term price-action window at whatever granularity
    // trades are actually being evaluated/executed at (intervalMinutes),
    // and none of that logic hardcodes an actual 5-minute duration.
    m5: baseCandles.slice(Math.max(0, uptoIndex - 119), uptoIndex + 1),
    m15: aggregateBase(baseCandles, uptoIndex, m15GroupSize(intervalMinutes), 120),
    h1: aggregateBase(baseCandles, uptoIndex, h1GroupSize(intervalMinutes), 60),
    meta: {
      ...DEFAULT_BACKTEST_META, ...metaOverrides,
      // Rough day-volume estimate from this single bar's own turnover —
      // only feeds the liquidityScore/spread gates, which are overridden
      // to fixed values above anyway unless the caller passes real
      // overrides; kept for completeness, not depended on for anything
      // precise. barsPerDay scales with intervalMinutes instead of the
      // old fixed 288 (5m-bars/day).
      volume24hUsd: (last.v || 0) * barsPerDay * last.c,
    },
  };
}

function newDayState(startingEquity){
  return {
    equity: startingEquity, startingEquity, peakEquity: startingEquity, maxDrawdownPct: 0,
    realizedNetUsd: 0, realizedGrossUsd: 0, feesUsd: 0, fundingUsd: 0,
    trades: 0, wins: 0, losses: 0, consecutiveLosses: 0, lastLossAt: 0,
    dailyPnlPct: 0, openPositions: 0, openRiskPct: 0, positions: [], cooldownUntilBySymbol: {},
  };
}

function recomputeOpenRisk(dayState){
  dayState.openPositions = dayState.positions.length;
  dayState.openRiskPct = dayState.positions.reduce((a, p) => a + (p.riskAmountUsd || 0), 0) / Math.max(1, dayState.equity) * 100;
}

function openBacktestPosition(row, dayState, nowMs){
  const qty = row.sizing ? row.sizing.qty : 0;
  const position = {
    id: `${row.symbol}-${nowMs}-${Math.random().toString(36).slice(2, 7)}`,
    symbol: row.symbol, exchange: row.exchange, direction: row.direction,
    entry: row.entry, stop: row.stop, originalStop: row.stop,
    tp1: row.tp1, tp2: row.tp2, tp3: row.tp3,
    tpFractions: row.tpFractions || { tp1: 0.30, tp2: 0.30, tp3: 0.40 },
    breakevenStopPrice: row.breakevenStopPrice,
    qty, notionalUsd: row.sizing ? row.sizing.notionalUsd : 0,
    leverage: row.leverage, execution: row.execution,
    entryFeePct: row.costsBreakdown.entryFeePct, exitFeePct: row.costsBreakdown.exitFeePct,
    fundingRatePct: row.costsBreakdown.fundingCostPct > 0 ? row.costsBreakdown.fundingCostPct : 0,
    confidence: row.confidence, setup: row.setup, reasons: row.reasons, regime: row.regime,
    openedAt: nowMs, remainingFraction: 1, partialsTaken: [], accrued: null,
  };
  position.riskAmountUsd = row.sizing ? row.sizing.riskAmountUsd : 0;
  dayState.positions.push(position);
  recomputeOpenRisk(dayState);
  return position;
}

function closeBacktestTrade(pos, exitPrice, pnl, exitReason, dayState, closedTrades, nowMs){
  dayState.realizedNetUsd += pnl.netUsd; dayState.realizedGrossUsd += pnl.grossUsd;
  dayState.feesUsd += pnl.feesUsd; dayState.fundingUsd += pnl.fundingUsd;

  const accrued = pos.accrued || { netUsd: 0, grossUsd: 0, feesUsd: 0, fundingUsd: 0 };
  const finalNetUsd = accrued.netUsd + pnl.netUsd;
  const totalGrossUsd = accrued.grossUsd + pnl.grossUsd;
  const totalFeesUsd = accrued.feesUsd + pnl.feesUsd;

  dayState.trades++;
  if(finalNetUsd > 0){ dayState.wins++; dayState.consecutiveLosses = 0; }
  else { dayState.losses++; dayState.consecutiveLosses++; dayState.lastLossAt = nowMs; }

  dayState.equity += finalNetUsd;
  dayState.dailyPnlPct = ((dayState.equity - dayState.startingEquity) / dayState.startingEquity) * 100;
  dayState.peakEquity = Math.max(dayState.peakEquity, dayState.equity);
  dayState.maxDrawdownPct = Math.max(dayState.maxDrawdownPct, ((dayState.peakEquity - dayState.equity) / dayState.peakEquity) * 100);

  closedTrades.push({
    closedAtMs: nowMs, openedAtMs: pos.openedAt, exchange: pos.exchange, symbol: pos.symbol, direction: pos.direction,
    entry: pos.entry, exit: exitPrice, qty: pos.qty, leverage: pos.leverage,
    grossUsd: totalGrossUsd, feesUsd: totalFeesUsd, netUsd: finalNetUsd,
    confidence: pos.confidence, setupType: pos.setup, reasonEntry: (pos.reasons || []).join('; '),
    exitReason, durationMin: Math.round((nowMs - pos.openedAt) / 60_000),
  });
}

// Advances every currently-open position against ITS OWN symbol's bar
// at `nowMs` (if that symbol has one) — identical TP1(30%)/TP2(30%,
// breakeven)/TP3(40%)/SL/time-stop logic as engine.js's managePositions,
// just reading a real historical candle instead of mockMarket's.
function managePositionsAtBar(dayState, closedTrades, base5mBySymbol, idxBySymbol, nowMs, timeStopMinutesFor){
  const stillOpen = [];
  for(const pos of dayState.positions){
    const idx = idxBySymbol[pos.symbol] && idxBySymbol[pos.symbol].get(nowMs);
    if(idx == null){ stillOpen.push(pos); continue; } // no bar for this symbol exactly at this timestamp — nothing to check this tick
    const candle = base5mBySymbol[pos.symbol][idx];
    const dir = pos.direction === 'LONG' ? 1 : -1;
    const hitTP = (price) => dir === 1 ? candle.h >= price : candle.l <= price;
    const hitSL = dir === 1 ? candle.l <= pos.stop : candle.h >= pos.stop;
    const ageMinutes = (nowMs - pos.openedAt) / 60_000;
    const timeStopMinutes = timeStopMinutesFor(pos.setup);

    if(hitSL){
      const pnl = netPnlForFraction(pos, pos.stop, pos.remainingFraction, dayState);
      closeBacktestTrade(pos, pos.stop, pnl, 'STOP_LOSS', dayState, closedTrades, nowMs);
      dayState.cooldownUntilBySymbol[pos.symbol] = nowMs + 30 * 60_000;
      continue;
    }

    const tp1Fraction = pos.tpFractions.tp1, tp2Fraction = pos.tpFractions.tp2;

    if(!pos.partialsTaken.includes('tp1') && hitTP(pos.tp1)){
      const pnl = netPnlForFraction(pos, pos.tp1, tp1Fraction, dayState);
      pos.remainingFraction -= tp1Fraction;
      pos.partialsTaken.push('tp1');
      dayState.realizedNetUsd += pnl.netUsd; dayState.realizedGrossUsd += pnl.grossUsd;
      dayState.feesUsd += pnl.feesUsd; dayState.fundingUsd += pnl.fundingUsd;
      pos.accrued = pos.accrued || { netUsd: 0, grossUsd: 0, feesUsd: 0, fundingUsd: 0 };
      pos.accrued.netUsd += pnl.netUsd; pos.accrued.grossUsd += pnl.grossUsd;
      pos.accrued.feesUsd += pnl.feesUsd; pos.accrued.fundingUsd += pnl.fundingUsd;
    }

    if(pos.remainingFraction > 0 && !pos.partialsTaken.includes('tp2') && hitTP(pos.tp2)){
      const pnl = netPnlForFraction(pos, pos.tp2, tp2Fraction, dayState);
      pos.remainingFraction -= tp2Fraction;
      pos.partialsTaken.push('tp2');
      if(pos.breakevenStopPrice != null) pos.stop = pos.breakevenStopPrice;
      dayState.realizedNetUsd += pnl.netUsd; dayState.realizedGrossUsd += pnl.grossUsd;
      dayState.feesUsd += pnl.feesUsd; dayState.fundingUsd += pnl.fundingUsd;
      pos.accrued.netUsd += pnl.netUsd; pos.accrued.grossUsd += pnl.grossUsd;
      pos.accrued.feesUsd += pnl.feesUsd; pos.accrued.fundingUsd += pnl.fundingUsd;
    }

    if(pos.remainingFraction > 0 && hitTP(pos.tp3)){
      const pnl = netPnlForFraction(pos, pos.tp3, pos.remainingFraction, dayState);
      closeBacktestTrade(pos, pos.tp3, pnl, 'TP3', dayState, closedTrades, nowMs);
      dayState.cooldownUntilBySymbol[pos.symbol] = nowMs + 30 * 60_000;
      continue;
    }

    if(pos.remainingFraction > 0 && ageMinutes > timeStopMinutes){
      const pnl = netPnlForFraction(pos, candle.c, pos.remainingFraction, dayState);
      closeBacktestTrade(pos, candle.c, pnl, 'TIME_STOP', dayState, closedTrades, nowMs);
      dayState.cooldownUntilBySymbol[pos.symbol] = nowMs + 30 * 60_000;
      continue;
    }

    stillOpen.push(pos);
  }
  dayState.positions = stillOpen;
  recomputeOpenRisk(dayState);
}

function timeStopMinutesFor(setupType){
  return setupType === 'AI Scalp' ? 40 : setupType === 'Range Scalp' ? 45 : 240;
}

// candlesBySymbol: { [symbol]: [{t,o,h,l,c,v}, ...] } — 5-minute candles,
// chronologically sorted, one array per symbol to test. If BTCUSDT isn't
// among the symbols being tested, pass it in anyway under its own key
// (fetched the same way) so the cross-market BTC-shock filter — which
// every non-BTC signal is checked against in real trading too — has
// real data to work from instead of being silently disabled.
//
// cfg: same shape runScanCycle/evaluateSymbol already take (exchange,
// strategies, weights, minConfidence, riskPctPerTrade, leverage,
// feeConfig, etc.)
//
// Returns { trades, equityCurve, dayState, barsEvaluated, skippedBars }.
// onProgress(fraction 0..1) is called periodically if provided —
// backtests over months of 5m data across several symbols are tens of
// thousands of bars and can take a few seconds.
export async function runBacktest({ candlesBySymbol, symbols, cfg, startingEquity, metaOverrides, onProgress, intervalMinutes }){
  const barIntervalMinutes = intervalMinutes || 5; // defaults to the original 5m assumption if a caller doesn't pass one
  const testSymbols = (symbols || Object.keys(candlesBySymbol)).filter(s => candlesBySymbol[s] && candlesBySymbol[s].length);
  if(!testSymbols.length) throw new Error('No historical candles to backtest against.');

  const idxBySymbol = {};
  for(const [sym, arr] of Object.entries(candlesBySymbol)){
    const map = new Map();
    arr.forEach((c, i) => map.set(c.t, i));
    idxBySymbol[sym] = map;
  }

  // Shared simulated clock: the union of every symbol's own bar
  // timestamps in the requested range, walked in chronological order —
  // this is what lets "one entry per bar, correct chronological order,
  // portfolio-wide risk/position limits shared across every symbol"
  // hold exactly the way it does in Paper/Live mode's own single shared
  // dayState, rather than simulating each symbol in isolation.
  const timelineSet = new Set();
  for(const sym of testSymbols) for(const c of candlesBySymbol[sym]) timelineSet.add(c.t);
  const timeline = Array.from(timelineSet).sort((a, b) => a - b);

  const dayState = newDayState(startingEquity);
  const closedTrades = [];
  const equityCurve = [];
  const btcCandles = candlesBySymbol.BTCUSDT || null;
  const btcIdx = idxBySymbol.BTCUSDT || null;

  let barsEvaluated = 0, skippedWarmup = 0;

  for(let ti = 0; ti < timeline.length; ti++){
    const nowMs = timeline[ti];

    managePositionsAtBar(dayState, closedTrades, candlesBySymbol, idxBySymbol, nowMs, timeStopMinutesFor);

    if(dayState.consecutiveLosses >= RISK_DEFAULTS.maxConsecutiveLosses){
      const cooldownUntil = (dayState.lastLossAt || 0) + RISK_DEFAULTS.coolingOffMinutes * 60_000;
      if(nowMs >= cooldownUntil) dayState.consecutiveLosses = 0;
    }

    let btcShock = null;
    if(btcCandles && btcIdx){
      const bi = btcIdx.get(nowMs);
      if(bi != null && bi >= 12) btcShock = computeBtcShock(btcCandles.slice(Math.max(0, bi - 11), bi + 1));
    }

    for(const symbol of testSymbols){
      if(EXCLUDED_FUTURES_SYMBOLS.has(symbol)) continue; // same permanently-excluded set Paper/Live use (BTC/ETH/SOL/LTC/DOGE/BNB — see engine.js)
      if(dayState.positions.some(p => p.symbol === symbol)) continue; // already open — evaluateSymbol's own gate would reject this anyway, skip the compute
      const idx = idxBySymbol[symbol].get(nowMs);
      if(idx == null || idx < warmupBarsFor(barIntervalMinutes)){ if(idx != null) skippedWarmup++; continue; }

      barsEvaluated++;
      const snap = buildSnapshotAt(symbol, candlesBySymbol[symbol], idx, metaOverrides, barIntervalMinutes);
      const regime = classifyRegime(snap.h1, snap.m15);
      const row = evaluateSymbol(symbol, snap, regime, cfg, dayState, btcShock, nowMs);
      if(row.status === 'APPROVED' && row.sizing && row.sizing.qty > 0){
        openBacktestPosition(row, dayState, nowMs);
      }
    }

    equityCurve.push({ t: nowMs, equity: dayState.equity });
    if(ti % 300 === 0 || ti === timeline.length - 1){
      if(onProgress) onProgress((ti + 1) / timeline.length);
      // Yields to the browser's event loop every 300 bars so the tab can
      // repaint the progress indicator and stay responsive instead of
      // freezing solid for the whole run — a multi-month, multi-symbol
      // backtest is tens of thousands of bars and would otherwise block
      // the main thread for several seconds straight.
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  }

  // Mark-to-market close anything still open at the very end of the
  // range, at that symbol's last available price, so the final equity/
  // stats reflect every position that was opened — flagged with its own
  // exit reason (OPEN_AT_END) rather than silently folded into TP/SL
  // stats, since it wasn't actually closed by the strategy's own logic.
  for(const pos of dayState.positions.slice()){
    const arr = candlesBySymbol[pos.symbol];
    const lastCandle = arr[arr.length - 1];
    const pnl = netPnlForFraction(pos, lastCandle.c, pos.remainingFraction, dayState);
    closeBacktestTrade(pos, lastCandle.c, pnl, 'OPEN_AT_END', dayState, closedTrades, lastCandle.t);
  }
  dayState.positions = [];

  return { trades: closedTrades, equityCurve, dayState, barsEvaluated, skippedWarmup, symbols: testSymbols };
}

// Summary stats block for the results header — kept separate from
// runBacktest itself so the UI can recompute it cheaply (e.g. after
// filtering the trade list by strategy) without re-running the sim.
export function summarizeTrades(trades, startingEquity){
  const count = trades.length;
  const wins = trades.filter(t => t.netUsd > 0);
  const losses = trades.filter(t => t.netUsd <= 0);
  const grossProfit = wins.reduce((a, t) => a + t.netUsd, 0);
  const grossLoss = Math.abs(losses.reduce((a, t) => a + t.netUsd, 0));
  const netUsd = trades.reduce((a, t) => a + t.netUsd, 0);
  const feesUsd = trades.reduce((a, t) => a + t.feesUsd, 0);
  const winRate = count ? (wins.length / count) * 100 : 0;
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? Infinity : 0);
  const avgWinUsd = wins.length ? grossProfit / wins.length : 0;
  const avgLossUsd = losses.length ? -grossLoss / losses.length : 0;
  const expectancyUsd = count ? netUsd / count : 0;
  const byStrategy = {};
  for(const t of trades){
    const key = t.setupType || 'Unknown';
    byStrategy[key] = byStrategy[key] || { trades: 0, wins: 0, netUsd: 0 };
    byStrategy[key].trades++;
    if(t.netUsd > 0) byStrategy[key].wins++;
    byStrategy[key].netUsd += t.netUsd;
  }
  return {
    count, winRate, profitFactor, netUsd, feesUsd, avgWinUsd, avgLossUsd, expectancyUsd,
    netReturnPct: startingEquity ? (netUsd / startingEquity) * 100 : 0,
    byStrategy,
  };
}
