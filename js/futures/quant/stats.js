// =============================================================
// quant/stats.js — honest performance statistics + equity curve.
//
// Rules this file enforces:
//  * Nothing is filtered, smoothed or cherry-picked: every closed trade
//    passed in is counted, in order.
//  * A win rate is only reported once there are MIN_SAMPLE_TRADES (30)
//    completed trades. Below that, `sufficient` is false and `winRate`
//    is null — the UI must show INSUFFICIENT SAMPLE, never a number.
//  * Backtest / Paper / Live are separate inputs. Callers pass ONE
//    source at a time; this module never mixes them.
//  * Sharpe/Sortino/Calmar need >= 30 trades spanning >= 10 UTC days;
//    otherwise they are null ("not enough data"), not zero.
// =============================================================
import { MIN_SAMPLE_TRADES, QUANT_TYPE } from './config.js';

const DAY_MS = 86_400_000;

// ---- normalizers: each source stores trades in a slightly different shape ----
export function fromPaperLog(rows){
  return rows.filter(t => t.strategy === QUANT_TYPE).map(t => ({
    closedAtMs: t.timestamp, netUsd: t.netPnlUsd, grossUsd: t.grossPnlUsd, feesUsd: t.feesUsd,
    fundingUsd: t.fundingUsd || 0, slippageUsd: (t.quant && t.quant.slippageUsd) || 0,
    symbol: t.symbol, direction: t.direction, quant: t.quant || null, source: 'paper',
  })).sort((a, b) => a.closedAtMs - b.closedAtMs);
}
export function fromBacktest(rows){
  return rows.filter(t => t.setupType === QUANT_TYPE).map(t => ({
    closedAtMs: t.closedAtMs, openedAtMs: t.openedAtMs, netUsd: t.netUsd, grossUsd: t.grossUsd, feesUsd: t.feesUsd,
    fundingUsd: t.fundingUsd || 0, slippageUsd: (t.quant && t.quant.slippageUsd) || 0,
    symbol: t.symbol, direction: t.direction, quant: t.quant || null, source: 'backtest',
  })).sort((a, b) => a.closedAtMs - b.closedAtMs);
}
export function fromLiveLog(rows){
  return rows.filter(t => t.setupType === QUANT_TYPE).map(t => ({
    closedAtMs: t.closedAtMs, netUsd: t.netUsd, grossUsd: t.grossUsd, feesUsd: t.feesUsd || 0,
    fundingUsd: 0, slippageUsd: 0, symbol: t.symbol, direction: t.side === 'Buy' ? 'LONG' : 'SHORT',
    quant: t.quant || null, source: 'live',
  })).sort((a, b) => a.closedAtMs - b.closedAtMs);
}

export function buildEquityCurve(trades, startingEquity){
  const points = [{ t: trades.length ? trades[0].closedAtMs : 0, equity: startingEquity, balance: startingEquity, drawdownPct: 0, peak: startingEquity }];
  let eq = startingEquity, peak = startingEquity;
  for(const t of trades){
    eq += t.netUsd;
    peak = Math.max(peak, eq);
    points.push({ t: t.closedAtMs, equity: eq, balance: eq, drawdownPct: peak > 0 ? ((peak - eq) / peak) * 100 : 0, peak });
  }
  return points;
}

function bucketPnl(trades, keyFn){
  const m = new Map();
  for(const t of trades){ const k = keyFn(t.closedAtMs); m.set(k, (m.get(k) || 0) + t.netUsd); }
  return m;
}

function streaks(trades){
  let maxW = 0, maxL = 0, w = 0, l = 0;
  for(const t of trades){
    if(t.netUsd > 0){ w++; l = 0; maxW = Math.max(maxW, w); }
    else { l++; w = 0; maxL = Math.max(maxL, l); }
  }
  return { maxW, maxL, curW: w, curL: l };
}

// Daily equity returns (24/7 market: sqrt(365) annualisation).
function dailyReturns(trades, startingEquity){
  if(!trades.length) return [];
  const byDay = new Map();
  for(const t of trades){ const d = Math.floor(t.closedAtMs / DAY_MS); byDay.set(d, (byDay.get(d) || 0) + t.netUsd); }
  const days = Array.from(byDay.keys()).sort((a, b) => a - b);
  const first = days[0], last = days[days.length - 1];
  const out = [];
  let eq = startingEquity;
  for(let d = first; d <= last; d++){
    const pnl = byDay.get(d) || 0;
    out.push(eq > 0 ? pnl / eq : 0);
    eq += pnl;
  }
  return out;
}

export function computeQuantStats(trades, startingEquity){
  const n = trades.length;
  const sufficient = n >= MIN_SAMPLE_TRADES;
  const wins = trades.filter(t => t.netUsd > 0);
  const losses = trades.filter(t => t.netUsd <= 0);
  const grossProfit = wins.reduce((a, t) => a + t.netUsd, 0);
  const grossLoss = Math.abs(losses.reduce((a, t) => a + t.netUsd, 0));
  const net = trades.reduce((a, t) => a + t.netUsd, 0);
  const fees = trades.reduce((a, t) => a + (t.feesUsd || 0), 0);
  const funding = trades.reduce((a, t) => a + (t.fundingUsd || 0), 0);
  const slippage = trades.reduce((a, t) => a + (t.slippageUsd || 0), 0);
  const curve = buildEquityCurve(trades, startingEquity);
  const maxDdPct = curve.reduce((m, p) => Math.max(m, p.drawdownPct), 0);
  const maxDdUsd = curve.reduce((m, p) => Math.max(m, p.peak - p.equity), 0);
  const avgDdPct = curve.length ? curve.reduce((a, p) => a + p.drawdownPct, 0) / curve.length : 0;
  const rs = trades.map(t => t.quant && t.quant.realizedR).filter(v => v != null && Number.isFinite(v));
  const irr = trades.map(t => t.quant && t.quant.initialRR).filter(v => v != null && Number.isFinite(v));
  const winR = rs.filter(v => v > 0), lossR = rs.filter(v => v <= 0);
  const avgWinR = winR.length ? winR.reduce((a, b) => a + b, 0) / winR.length : null;
  const avgLossR = lossR.length ? lossR.reduce((a, b) => a + b, 0) / lossR.length : null;
  const st = streaks(trades);

  const spanDays = n ? (trades[n - 1].closedAtMs - trades[0].closedAtMs) / DAY_MS : 0;
  const rets = dailyReturns(trades, startingEquity);
  let sharpe = null, sortino = null, calmar = null;
  if(sufficient && rets.length >= 10){
    const mu = rets.reduce((a, b) => a + b, 0) / rets.length;
    const sd = Math.sqrt(rets.reduce((a, b) => a + (b - mu) ** 2, 0) / (rets.length - 1));
    const dd = Math.sqrt(rets.reduce((a, b) => a + Math.min(0, b) ** 2, 0) / rets.length);
    if(sd > 0) sharpe = (mu / sd) * Math.sqrt(365);
    if(dd > 0) sortino = (mu / dd) * Math.sqrt(365);
    const totalRet = startingEquity > 0 ? net / startingEquity : 0;
    const annual = spanDays > 0 ? Math.pow(Math.max(1e-9, 1 + totalRet), 365 / spanDays) - 1 : 0;
    if(maxDdPct > 0) calmar = (annual * 100) / maxDdPct;
  }

  return {
    trades: n, sufficient, minSample: MIN_SAMPLE_TRADES,
    wins: wins.length, losses: losses.length,
    winRate: sufficient ? (wins.length / n) * 100 : null,
    observedWinRate: n ? (wins.length / n) * 100 : null, // never render this one without the sample caveat
    avgWinUsd: wins.length ? grossProfit / wins.length : 0,
    avgLossUsd: losses.length ? -grossLoss / losses.length : 0,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? Infinity : null),
    expectancyUsd: n ? net / n : 0,
    expectancyR: rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : null,
    avgInitialRR: irr.length ? irr.reduce((a, b) => a + b, 0) / irr.length : null,
    avgRealizedR: rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : null, // = expectancy in R
    avgWinR, avgLossR,
    // Realized payoff ratio: average winning R over average losing R. Below the initial RR because fees,
    // funding and slippage shrink wins and enlarge losses — this is the number the win rate must beat.
    realizedRR: avgWinR != null && avgLossR != null && avgLossR < 0 ? avgWinR / Math.abs(avgLossR) : null,
    maxDrawdownPct: maxDdPct, avgDrawdownPct: avgDdPct,
    largestWinUsd: wins.length ? Math.max(...wins.map(t => t.netUsd)) : 0,
    largestLossUsd: losses.length ? Math.min(...losses.map(t => t.netUsd)) : 0,
    maxConsecWins: st.maxW, maxConsecLosses: st.maxL, curConsecWins: st.curW, curConsecLosses: st.curL,
    netUsd: net, feesUsd: fees, fundingUsd: funding, slippageUsd: slippage,
    roiPct: startingEquity > 0 ? (net / startingEquity) * 100 : 0,
    recoveryFactor: maxDdUsd > 0 ? net / maxDdUsd : null,
    sharpe, sortino, calmar, spanDays,
    equity: curve.length ? curve[curve.length - 1].equity : startingEquity,
    peakEquity: curve.reduce((m, p) => Math.max(m, p.peak), startingEquity),
    curve,
    dailyPnl: bucketPnl(trades, ms => Math.floor(ms / DAY_MS)),
    weeklyPnl: bucketPnl(trades, ms => Math.floor((Math.floor(ms / DAY_MS) + 3) / 7)),
    monthlyPnl: bucketPnl(trades, ms => { const d = new Date(ms); return d.getUTCFullYear() * 12 + d.getUTCMonth(); }),
  };
}

// Text for the win-rate cell — the ONE place the sample rule is applied for display.
export function winRateLabel(stats){
  if(!stats || stats.trades === 0) return 'No trades yet';
  if(!stats.sufficient) return `INSUFFICIENT SAMPLE (${stats.trades}/${MIN_SAMPLE_TRADES})`;
  return `${stats.winRate.toFixed(1)}%`;
}
