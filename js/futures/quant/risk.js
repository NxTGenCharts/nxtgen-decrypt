// =============================================================
// quant/risk.js — the Quant Futures risk engine.
//
// Everything here is strategy-scoped: it only ever blocks or resizes
// NxTGen HTF OrderFlow entries. It does not alter the shared no-trade
// gate, the global daily limits, or any other strategy's behaviour.
//
//  * Risk state is REPLAYED from the strategy's own closed-trade list
//    (deterministic: same trades in -> same state out) so Paper,
//    Backtest and Live all derive it identically and it can't drift
//    from a separately-mutated counter.
//  * Position size comes from equity x risk% and the stop distance.
//    Leverage only sets margin requirements / a notional ceiling — it is
//    never allowed to raise the amount of account risk.
//  * Risk steps DOWN as drawdown deepens (0.50% -> 0.35% -> 0.25% -> pause).
//    No martingale, no size increase after a loss, no averaging down.
// =============================================================
import { positionSize } from '../risk.js';
import { QUANT_TYPE, HARD_LIMITS } from './config.js';

const DAY_MS = 86_400_000;
export const utcDayKey = (ms) => Math.floor(ms / DAY_MS);
// ISO-style week key: weeks start Monday 00:00 UTC (epoch day 0 was a Thursday).
export const utcWeekKey = (ms) => Math.floor((Math.floor(ms / DAY_MS) + 3) / 7);

function rollingStats(trades, n){
  const tail = trades.slice(-n);
  if(!tail.length) return { n: 0, winRate: null, profitFactor: null, expectancyUsd: null, netUsd: 0 };
  const wins = tail.filter(t => t.netUsd > 0);
  const gp = wins.reduce((a, t) => a + t.netUsd, 0);
  const gl = Math.abs(tail.filter(t => t.netUsd <= 0).reduce((a, t) => a + t.netUsd, 0));
  const net = tail.reduce((a, t) => a + t.netUsd, 0);
  return {
    n: tail.length, winRate: (wins.length / tail.length) * 100,
    profitFactor: gl > 0 ? gp / gl : (gp > 0 ? Infinity : null),
    expectancyUsd: net / tail.length, netUsd: net,
  };
}

// trades: [{ closedAtMs, netUsd }] oldest first.
export function computeQuantRiskState(trades, startingEquity, nowMs, qcfg){
  let eq = startingEquity, riskPeak = startingEquity, truePeak = startingEquity;
  let displayStreak = 0, pauseStreak = 0, cooldownUntil = 0;
  let ddPausedUntil = 0, ddPaused = false, resumeIdx = -1;

  trades.forEach((t, idx) => {
    if(ddPaused && t.closedAtMs >= ddPausedUntil){ ddPaused = false; riskPeak = eq; resumeIdx = idx; }
    eq += t.netUsd;
    truePeak = Math.max(truePeak, eq);
    riskPeak = Math.max(riskPeak, eq);
    if(t.netUsd > 0){ displayStreak = 0; pauseStreak = 0; }
    else {
      displayStreak++; pauseStreak++;
      if(pauseStreak >= qcfg.maxConsecutiveLosses){ cooldownUntil = t.closedAtMs + qcfg.cooldownMinutes * 60_000; pauseStreak = 0; }
    }
    const dd = riskPeak > 0 ? ((riskPeak - eq) / riskPeak) * 100 : 0;
    if(!ddPaused && dd >= qcfg.ddPausePct){ ddPaused = true; ddPausedUntil = t.closedAtMs + qcfg.pauseResumeHours * 3_600_000; }
  });
  if(ddPaused && nowMs >= ddPausedUntil){ ddPaused = false; riskPeak = eq; resumeIdx = trades.length; }

  const drawdownPct = riskPeak > 0 ? ((riskPeak - eq) / riskPeak) * 100 : 0;
  const trueDrawdownPct = truePeak > 0 ? ((truePeak - eq) / truePeak) * 100 : 0;

  // Daily / weekly realized P&L, measured against equity at the start of that period.
  const dk = utcDayKey(nowMs), wk = utcWeekKey(nowMs);
  let dayStartEq = startingEquity, weekStartEq = startingEquity, dayNet = 0, weekNet = 0;
  let running = startingEquity;
  for(const t of trades){
    if(utcDayKey(t.closedAtMs) < dk) dayStartEq = running + t.netUsd;
    if(utcWeekKey(t.closedAtMs) < wk) weekStartEq = running + t.netUsd;
    running += t.netUsd;
    if(utcDayKey(t.closedAtMs) === dk) dayNet += t.netUsd;
    if(utcWeekKey(t.closedAtMs) === wk) weekNet += t.netUsd;
  }
  const dailyPnlPct = dayStartEq > 0 ? (dayNet / dayStartEq) * 100 : 0;
  const weeklyPnlPct = weekStartEq > 0 ? (weekNet / weekStartEq) * 100 : 0;

  const r20 = rollingStats(trades, 20), r50 = rollingStats(trades, 50), r100 = rollingStats(trades, 100);

  // Multipliers on the base risk. Never > 1.
  let ddMult = 1, tier = 'normal';
  if(drawdownPct >= qcfg.ddTier2Pct){ ddMult = 0.5; tier = 'minimum'; }
  else if(drawdownPct >= qcfg.ddTier1Pct){ ddMult = 0.7; tier = 'reduced'; }
  let perfMult = 1;
  // Performance deterioration only means something with a real sample (>=30 of the last 50).
  if(r50.n >= 30 && r50.profitFactor != null){
    if(r50.profitFactor < 0.6) perfMult = 0.5; else if(r50.profitFactor < 0.8) perfMult = 0.7;
  }
  // After an automatic resume, the next 5 trades run at the minimum tier.
  const sinceResume = resumeIdx >= 0 ? trades.length - resumeIdx : Infinity;
  const resumeMult = sinceResume < 5 ? 0.5 : 1;
  const riskMult = Math.min(ddMult, perfMult, resumeMult);
  if(riskMult < 1 && tier === 'normal') tier = 'reduced';

  const pauseReasons = [];
  if(ddPaused) pauseReasons.push(`Drawdown ${drawdownPct.toFixed(2)}% >= ${qcfg.ddPausePct}% — strategy paused until ${new Date(ddPausedUntil).toISOString().slice(0, 16).replace('T', ' ')}Z`);
  if(nowMs < cooldownUntil) pauseReasons.push(`${qcfg.maxConsecutiveLosses} consecutive losses — cooling down until ${new Date(cooldownUntil).toISOString().slice(0, 16).replace('T', ' ')}Z`);
  if(dailyPnlPct <= -qcfg.dailyLossLimitPct) pauseReasons.push(`Quant daily loss limit reached (${dailyPnlPct.toFixed(2)}% <= -${qcfg.dailyLossLimitPct}%) — no new positions today`);
  if(weeklyPnlPct <= -qcfg.weeklyLossLimitPct) pauseReasons.push(`Quant weekly loss limit reached (${weeklyPnlPct.toFixed(2)}% <= -${qcfg.weeklyLossLimitPct}%) — no new positions this week`);

  return {
    equity: eq, peakEquity: truePeak, drawdownPct, trueDrawdownPct, dailyPnlPct, weeklyPnlPct,
    consecutiveLosses: displayStreak, cooldownUntil, ddPaused, ddPausedUntil,
    paused: pauseReasons.length > 0, pauseReasons, tier, riskMult,
    rolling: { r20, r50, r100 }, tradeCount: trades.length,
  };
}

// Final per-trade risk %: base x drawdown/perf state x regime (high vol = x0.6), hard-capped at 1%.
export function effectiveRiskPct(qcfg, state, regimeRiskMult){
  const r = qcfg.riskPct * (state ? state.riskMult : 1) * (regimeRiskMult || 1);
  return Math.max(HARD_LIMITS.minRiskPct, Math.min(HARD_LIMITS.maxRiskPct, Math.round(r * 1000) / 1000));
}

// Round quantity down to the exchange's lot step. With real contract specs
// (snap.meta.contract = {qtyStep, minQty, maxQty}) this is exact; without
// them (Paper/Backtest have no instrument-info feed) it floors to 3
// significant digits and says so. Live orders are additionally rounded to
// the real exchange filters server-side (server.js floorToStep/tickSize).
export function applyContractSpecs(qty, contract){
  if(!(qty > 0)) return { qty: 0, source: 'none' };
  if(contract && contract.qtyStep > 0){
    let q = Math.floor(qty / contract.qtyStep + 1e-9) * contract.qtyStep;
    if(contract.maxQty > 0 && q > contract.maxQty) q = contract.maxQty;
    if(q < (contract.minQty || 0)) return { qty: 0, source: 'contract' };
    return { qty: q, source: 'contract' };
  }
  const step = Math.pow(10, Math.floor(Math.log10(qty)) - 2);
  return { qty: Math.floor(qty / step + 1e-9) * step, source: 'assumed' };
}

export function quantSize({ equity, riskPct, entry, stop, leverage, qcfg, contract }){
  const lev = Math.max(1, Math.min(HARD_LIMITS.maxLeverage, leverage || 1));
  const base = positionSize({ equity, riskPct, entryPrice: entry, stopPrice: stop, leverage: lev });
  if(!base) return null;
  let notional = base.notionalUsd;
  let capped = base.marginCapped;
  const symbolCap = equity * qcfg.maxSymbolNotionalPct / 100;
  if(notional > symbolCap){ notional = symbolCap; capped = true; }
  const spec = applyContractSpecs(notional / entry, contract);
  const stopFrac = Math.abs(entry - stop) / entry;
  const finalNotional = spec.qty * entry;
  return {
    qty: spec.qty, notionalUsd: finalNotional, marginRequiredUsd: finalNotional / lev,
    riskAmountUsd: finalNotional * stopFrac, nominalRiskAmountUsd: equity * riskPct / 100,
    stopDistancePct: stopFrac * 100, marginCapped: capped, contractSource: spec.source, leverage: lev,
  };
}

// Entry-time gates that need portfolio context. Returns an array of reasons (empty = pass).
export function quantEntryGate({ qcfg, state, dayState, direction, symbol, sizing, equity, meta }){
  const reasons = [];
  if(state && state.paused) reasons.push(...state.pauseReasons);

  const open = (dayState && dayState.positions) || [];
  const quantOpen = open.filter(p => p.setup === QUANT_TYPE).length;
  if(quantOpen >= qcfg.maxPositions) reasons.push(`Quant max positions reached (${quantOpen}/${qcfg.maxPositions})`);

  // Correlated exposure: BTC/ETH/SOL/... move together, so same-direction positions
  // are one directional bet, not independent ones.
  const baseRiskUsd = equity * qcfg.riskPct / 100;
  const cap = qcfg.maxCorrelatedRiskMultiple * baseRiskUsd;
  const sameDir = open.filter(p => p.direction === direction);
  const sameRisk = sameDir.reduce((a, p) => a + (p.riskAmountUsd || 0), 0);
  if(sizing && sameRisk + sizing.riskAmountUsd > cap * 1.0001){
    reasons.push(`Correlated exposure: ${sameDir.length} open ${direction} position(s) already carry $${sameRisk.toFixed(2)} risk (cap $${cap.toFixed(2)} for correlated crypto exposure)`);
  }

  if(sizing){
    const usedMargin = open.reduce((a, p) => a + ((p.notionalUsd || 0) / Math.max(1, p.leverage || 1)), 0);
    const free = equity - usedMargin;
    if(sizing.marginRequiredUsd > free) reasons.push(`Insufficient margin: need $${sizing.marginRequiredUsd.toFixed(2)}, free $${Math.max(0, free).toFixed(2)}`);
    if(!(sizing.qty > 0)) reasons.push('Position size invalid (rounds to zero at the contract\'s lot step)');
    if(!(sizing.riskAmountUsd > 0)) reasons.push('Position risk could not be computed');
  } else reasons.push('Position size could not be computed');

  if(meta){
    if(meta.spreadPct > qcfg.maxSpreadPct) reasons.push(`Spread ${meta.spreadPct.toFixed(3)}% exceeds the Quant limit ${qcfg.maxSpreadPct}%`);
    const atrCap = meta.entryTf === '5m' ? 2.0 : 3.5;
    if(meta.atrPct > atrCap) reasons.push(`Extreme ATR (${meta.atrPct.toFixed(2)}% per ${meta.entryTf} candle, cap ${atrCap}%)`);
  }
  return reasons;
}

// Realistic exits for Paper/Backtest: a stop-market or time-stop fill slips
// against you; a resting take-profit limit does not.
export function quantExitPrice(pos, rawPrice, kind){
  if(!pos.quant || kind === 'TP') return rawPrice;
  const slip = (pos.quant.exitSlipPct || 0) / 100;
  return pos.direction === 'LONG' ? rawPrice * (1 - slip) : rawPrice * (1 + slip);
}

// Fields added to a closed-trade row so Quant stats (R-multiples, score
// buckets, regime attribution) can be computed later from the trade log.
export function quantTradeFields(pos, netUsd, exitSlipUsd){
  if(!pos.quant) return {};
  const q = pos.quant;
  return {
    quant: {
      setup: q.setup, setupName: q.setupName, score: q.score, regime: q.regime, entryTf: q.entryTf,
      initialRR: q.rewardRisk, riskUsd: pos.riskAmountUsd, riskPctUsed: q.riskPctUsed,
      realizedR: pos.riskAmountUsd > 0 ? netUsd / pos.riskAmountUsd : null,
      stopDistPct: q.stopDistPct, slippageUsd: (q.entrySlipUsd || 0) + (exitSlipUsd || 0),
      factors: q.factors,
    },
  };
}
