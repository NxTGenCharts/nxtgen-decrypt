// =============================================================
// engine.js — the orchestrator. runScanCycle() produces one
// "Live Opportunity Scanner" row per symbol (APPROVED or
// REJECTED-with-reasons), and managePositions() advances any open
// paper trades against the latest price action (partial TP1,
// break-even stop, trailing, time-stop) using realistic costs.
//
// This module is data-source agnostic: it only calls
// mockMarket.snapshot()/btcShock() through the two functions at the
// top, so swapping in a real exchange feed later means changing
// those two call sites (or the mockMarket module itself), not this
// orchestration logic.
// =============================================================
import { mockMarket, FUTURES_SYMBOLS } from './mockMarket.js';
import { classifyRegime, REGIMES } from './regime.js';
import { detectAllSetups } from './setups.js';
import { computeFactorScores, weightedScore, DEFAULT_WEIGHTS } from './scoring.js';
import { decideExecution, estimateCosts, DEFAULT_FEE_CONFIG, DEFAULT_MIN_NET_PROFIT_PCT } from './costs.js';
import { positionSize, checkLiquidationSafety, RISK_DEFAULTS } from './risk.js';
import { evaluateNoTradeFilters } from './noTradeEngine.js';
import { buildExplanation } from './explain.js';
import { atr, swingLevels, volumeExpansion, clamp } from './indicators.js';

function getSnapshot(symbol){ return mockMarket.snapshot(symbol); }
function getBtcShock(){ return mockMarket.btcShock(); }

// Ensemble: each setup already carries its own direction+confidence.
// If setups disagree on direction, NO TRADE. If they agree, combine
// via a simple confidence-weighted average and take the strongest
// setup's reasons as the primary explanation.
function combineEnsemble(signals){
  if(signals.length === 0) return null;
  const longs = signals.filter(s => s.direction === 'LONG');
  const shorts = signals.filter(s => s.direction === 'SHORT');
  if(longs.length && shorts.length) return { conflict: true, signals };

  const group = longs.length ? longs : shorts;
  const totalConf = group.reduce((a, s) => a + s.rawConfidence, 0);
  const weighted = Math.round(group.reduce((a, s) => a + s.rawConfidence * s.rawConfidence, 0) / totalConf); // confidence-weighted
  const primary = group.reduce((best, s) => (s.rawConfidence > best.rawConfidence ? s : best), group[0]);
  return { conflict: false, direction: primary.direction, ensembleConfidence: clamp(weighted, 0, 99), primary, all: group };
}

function buildLevels(snap, direction){
  const entry = snap.price;
  const atrM15 = atr(snap.m15, 14) || entry * 0.003;
  const atrPct = (atrM15 / entry) * 100;
  const { support, resistance } = swingLevels(snap.m15, 30);

  const structuralStopPct = direction === 'LONG'
    ? Math.abs((entry - support) / entry) * 100
    : Math.abs((resistance - entry) / entry) * 100;

  // Stop uses the tighter of (structure invalidation, a volatility-scaled
  // cap) so a single distant swing point can't blow the stop out — but
  // never tighter than 1x ATR, so it isn't sitting inside normal noise.
  const stopDistancePct = clamp(Math.max(atrPct * 1.0, Math.min(structuralStopPct, atrPct * 2.0)), 0.12, 1.2);
  const stopPrice = direction === 'LONG' ? entry * (1 - stopDistancePct / 100) : entry * (1 + stopDistancePct / 100);

  const tp1Pct = clamp(Math.max(0.4, atrPct * 1.5), 0.25, 1.5);
  const tp2Pct = clamp(Math.max(0.7, atrPct * 2.4), tp1Pct + 0.1, 2.2);
  const tp3Pct = clamp(Math.max(1.0, atrPct * 3.2), tp2Pct + 0.1, 3.2);

  const sign = direction === 'LONG' ? 1 : -1;
  const tp1 = entry * (1 + sign * tp1Pct / 100);
  const tp2 = entry * (1 + sign * tp2Pct / 100);
  const tp3 = entry * (1 + sign * tp3Pct / 100);

  return { entry, stopPrice, stopDistancePct, tp1, tp2, tp3, tp1Pct, tp2Pct, tp3Pct, atrPct };
}

// Produces one row per symbol: APPROVED opportunities plus REJECTED
// ones (kept so the scanner table can show "why not" transparently,
// matching the No-Trade Engine's job of explaining a pass).
export function runScanCycle(cfg, dayState){
  const btcShock = getBtcShock();
  const rows = [];

  // Cooling-off period elapsed — allow the consecutive-loss streak to
  // reset so the bot doesn't stay locked out for the rest of the
  // session (see RISK_DEFAULTS.coolingOffMinutes).
  if(dayState.consecutiveLosses >= RISK_DEFAULTS.maxConsecutiveLosses){
    const cooldownUntil = (dayState.lastLossAt || 0) + RISK_DEFAULTS.coolingOffMinutes * 60_000;
    if(mockMarket.now() >= cooldownUntil) dayState.consecutiveLosses = 0;
  }

  for(const symbol of FUTURES_SYMBOLS){
    const snap = getSnapshot(symbol);
    const regime = classifyRegime(snap.h1, snap.m15);
    const setups = detectAllSetups(snap, regime);
    const ensemble = combineEnsemble(setups);

    if(!ensemble){
      rows.push(baseRow(symbol, snap, regime, 'REJECTED', ['No qualifying setup detected this cycle']));
      continue;
    }
    if(ensemble.conflict){
      rows.push(baseRow(symbol, snap, regime, 'REJECTED', ['Setups disagree on direction — ensemble requires agreement']));
      continue;
    }

    const direction = ensemble.direction;
    const primary = ensemble.primary;
    const factorScores = computeFactorScores(snap, regime, primary);
    const weights = cfg.weights || DEFAULT_WEIGHTS;
    let confidence = weightedScore(factorScores, weights);
    confidence = Math.round((confidence + ensemble.ensembleConfidence) / 2);

    const levels = buildLevels(snap, direction);
    const volExp = volumeExpansion(snap.m5, 10);
    const execution = decideExecution({ setupType: primary.type, volExpansionRatio: volExp });
    const holdMinutes = 90; // typical expected hold for TP1, used for funding-cost estimation

    const costs = estimateCosts({
      exchange: cfg.exchange || 'binance',
      execution,
      grossTargetPct: levels.tp1Pct,
      spreadPct: snap.meta.spreadPct,
      slippagePct: clamp(snap.meta.spreadPct * 0.6, 0.005, 0.05),
      fundingRatePct: snap.meta.fundingRatePct,
      holdMinutes,
      feeConfig: cfg.feeConfig || DEFAULT_FEE_CONFIG,
    });

    const riskRewardRatio = levels.stopDistancePct > 0 ? levels.tp1Pct / levels.stopDistancePct : 0;
    const leverage = cfg.leverage || RISK_DEFAULTS.defaultLeverage;
    const liqSafety = checkLiquidationSafety({ entryPrice: levels.entry, stopPrice: levels.stopPrice, side: direction, leverage });
    const isAltcoin = symbol !== 'BTCUSDT';

    const minConfidence = cfg.highSelectivity ? 82 : (cfg.minConfidence ?? 60);
    const minRR = cfg.highSelectivity ? 1.5 : (cfg.minRiskReward ?? 1.2);
    const minNetProfit = cfg.minNetProfitPct ?? DEFAULT_MIN_NET_PROFIT_PCT;

    const gate = evaluateNoTradeFilters({
      snap, regime, confidence, minConfidence,
      netTargetPct: costs.netTargetPct, minNetProfitPct: minNetProfit,
      riskRewardRatio, minRiskReward: minRR,
      liquidationSafety: liqSafety, dayState, btcShock, isAltcoin,
      fundingCostPct: costs.fundingCostPct, grossTargetPct: levels.tp1Pct,
      nowMs: mockMarket.now(),
    });

    const sizing = positionSize({
      equity: dayState.equity, riskPct: cfg.riskPctPerTrade || RISK_DEFAULTS.riskPctPerTrade,
      entryPrice: levels.entry, stopPrice: levels.stopPrice, leverage,
    });

    const row = {
      symbol, exchange: (cfg.exchange || 'binance').toUpperCase(), direction,
      setup: primary.type, confidence,
      entry: levels.entry, stop: levels.stopPrice, tp1: levels.tp1, tp2: levels.tp2, tp3: levels.tp3,
      expectedGrossPct: levels.tp1Pct, estFeesPct: costs.entryFeePct + costs.exitFeePct,
      estSlippagePct: costs.slippageCostPct, estFundingPct: costs.fundingCostPct,
      expectedNetPct: costs.netTargetPct, riskReward: riskRewardRatio,
      liquidityScore: snap.meta.liquidityScore, regime: regime.regime,
      status: gate.allowed ? 'APPROVED' : 'REJECTED', rejectReasons: gate.reasons,
      execution, sizing, leverage, liqPrice: liqSafety.liqPrice,
      reasons: primary.reasons, costsBreakdown: costs,
    };
    row.explanation = buildExplanation({
      symbol, direction, confidence, setup: primary.type, regime: regime.regime,
      reasons: primary.reasons, netTargetPct: costs.netTargetPct, totalCostPct: costs.totalCostPct,
      riskRewardRatio, status: row.status, rejectReasons: gate.reasons,
    });
    rows.push(row);
  }

  return { rows, btcShock };
}

function baseRow(symbol, snap, regime, status, rejectReasons){
  return {
    symbol, exchange: '—', direction: '—', setup: '—', confidence: 0,
    entry: snap.price, stop: null, tp1: null, tp2: null, tp3: null,
    expectedGrossPct: 0, estFeesPct: 0, estSlippagePct: 0, estFundingPct: 0, expectedNetPct: 0,
    riskReward: 0, liquidityScore: snap.meta.liquidityScore, regime: regime.regime,
    status, rejectReasons, reasons: [], explanation: null,
  };
}

// ---- Paper position lifecycle ----
// Opens new positions for APPROVED rows (subject to daily-risk gate,
// already enforced by the no-trade filters above), then on every
// cycle advances existing open positions against the latest M5
// candle's high/low: partial TP1 -> break-even stop -> partial TP2 ->
// trail -> TP3 or SL or time-stop. All P&L is computed net of the
// same fee/slippage/funding model used for pre-trade filtering.
export function openPosition(row, dayState){
  const qty = row.sizing ? row.sizing.qty : 0;
  const position = {
    id: `${row.symbol}-${mockMarket.now()}-${Math.random().toString(36).slice(2,7)}`,
    symbol: row.symbol, exchange: row.exchange, direction: row.direction,
    entry: row.entry, stop: row.stop, originalStop: row.stop,
    tp1: row.tp1, tp2: row.tp2, tp3: row.tp3,
    qty, notionalUsd: row.sizing ? row.sizing.notionalUsd : 0,
    leverage: row.leverage, execution: row.execution,
    entryFeePct: row.costsBreakdown.entryFeePct, exitFeePct: row.costsBreakdown.exitFeePct,
    fundingRatePct: row.costsBreakdown.fundingCostPct > 0 ? row.costsBreakdown.fundingCostPct : 0,
    confidence: row.confidence, setup: row.setup, reasons: row.reasons, regime: row.regime,
    openedAt: mockMarket.now(), remainingFraction: 1, partialsTaken: [], status: 'OPEN',
  };
  position.riskAmountUsd = row.sizing ? row.sizing.riskAmountUsd : 0;
  dayState.positions.push(position);
  recomputeOpenRisk(dayState);
  return position;
}

export function recomputeOpenRisk(dayState){
  dayState.openPositions = dayState.positions.length;
  dayState.openRiskPct = dayState.positions.reduce((a, p) => a + (p.riskAmountUsd || 0), 0) / Math.max(1, dayState.equity) * 100;
}

function netPnlForFraction(position, exitPrice, fraction, dayState){
  const grossPct = ((exitPrice - position.entry) / position.entry) * 100 * (position.direction === 'LONG' ? 1 : -1);
  const costPct = position.entryFeePct + position.exitFeePct + position.fundingRatePct;
  const netPct = grossPct - costPct;
  const notionalSlice = position.notionalUsd * fraction;
  return {
    grossUsd: (grossPct / 100) * notionalSlice,
    feesUsd: ((position.entryFeePct + position.exitFeePct) / 100) * notionalSlice,
    fundingUsd: (position.fundingRatePct / 100) * notionalSlice,
    netUsd: (netPct / 100) * notionalSlice,
    grossPct, netPct,
  };
}

export function managePositions(dayState, tradeHistory, cfg){
  const stillOpen = [];
  for(const pos of dayState.positions){
    const snap = getSnapshot(pos.symbol);
    const candle = snap.m5[snap.m5.length - 1];
    const dir = pos.direction === 'LONG' ? 1 : -1;
    const hitTP = (price) => dir === 1 ? candle.h >= price : candle.l <= price;
    const hitSL = candle.h !== undefined && (dir === 1 ? candle.l <= pos.stop : candle.h >= pos.stop);
    const ageMinutes = (mockMarket.now() - pos.openedAt) / 60_000;
    const timeStopMinutes = cfg.timeStopMinutes || 240;

    let closedFraction = 0;
    const events = [];

    if(hitSL){
      const pnl = netPnlForFraction(pos, pos.stop, pos.remainingFraction, dayState);
      closeTrade(pos, pos.stop, pnl, 'STOP_LOSS', dayState, tradeHistory);
      continue;
    }

    if(!pos.partialsTaken.includes('tp1') && hitTP(pos.tp1)){
      const pnl = netPnlForFraction(pos, pos.tp1, 0.5, dayState);
      pos.remainingFraction -= 0.5;
      pos.partialsTaken.push('tp1');
      pos.stop = pos.entry; // move to break-even after TP1
      dayState.realizedNetUsd += pnl.netUsd; dayState.realizedGrossUsd += pnl.grossUsd;
      dayState.feesUsd += pnl.feesUsd; dayState.fundingUsd += pnl.fundingUsd;
      events.push('Partial TP1 taken, stop moved to break-even');
    }

    if(pos.remainingFraction > 0 && !pos.partialsTaken.includes('tp2') && hitTP(pos.tp2)){
      const pnl = netPnlForFraction(pos, pos.tp2, 0.25, dayState);
      pos.remainingFraction -= 0.25;
      pos.partialsTaken.push('tp2');
      pos.stop = pos.tp1; // trail stop up to TP1 after TP2
      dayState.realizedNetUsd += pnl.netUsd; dayState.realizedGrossUsd += pnl.grossUsd;
      dayState.feesUsd += pnl.feesUsd; dayState.fundingUsd += pnl.fundingUsd;
      events.push('Partial TP2 taken, stop trailed to TP1');
    }

    if(pos.remainingFraction > 0 && hitTP(pos.tp3)){
      const pnl = netPnlForFraction(pos, pos.tp3, pos.remainingFraction, dayState);
      closeTrade(pos, pos.tp3, pnl, 'TP3', dayState, tradeHistory, events);
      continue;
    }

    if(pos.remainingFraction > 0 && ageMinutes > timeStopMinutes){
      const pnl = netPnlForFraction(pos, snap.price, pos.remainingFraction, dayState);
      closeTrade(pos, snap.price, pnl, 'TIME_STOP', dayState, tradeHistory, events);
      continue;
    }

    pos.lastEvents = events;
    stillOpen.push(pos);
  }
  dayState.positions = stillOpen;
  recomputeOpenRisk(dayState);
}

function closeTrade(pos, exitPrice, pnl, exitReason, dayState, tradeHistory, extraEvents){
  dayState.realizedNetUsd += pnl.netUsd;
  dayState.realizedGrossUsd += pnl.grossUsd;
  dayState.feesUsd += pnl.feesUsd;
  dayState.fundingUsd += pnl.fundingUsd;

  // Win/loss is judged on the FULL trade's net P&L across all partials,
  // tracked on the position object as it accrues, not just this slice.
  pos.finalNetUsd = (pos.finalNetUsd || 0) + pnl.netUsd;

  dayState.trades++;
  if(pos.finalNetUsd > 0){ dayState.wins++; dayState.consecutiveLosses = 0; }
  else { dayState.losses++; dayState.consecutiveLosses++; dayState.lastLossAt = mockMarket.now(); }

  dayState.equity += pnl.netUsd;
  dayState.dailyPnlPct = ((dayState.equity - dayState.startingEquity) / dayState.startingEquity) * 100;
  dayState.peakEquity = Math.max(dayState.peakEquity, dayState.equity);
  dayState.maxDrawdownPct = Math.max(dayState.maxDrawdownPct, ((dayState.peakEquity - dayState.equity) / dayState.peakEquity) * 100);

  tradeHistory.unshift({
    timestamp: mockMarket.now(), exchange: pos.exchange, symbol: pos.symbol, direction: pos.direction,
    entry: pos.entry, exit: exitPrice, qty: pos.qty, leverage: pos.leverage,
    grossPnlUsd: pnl.grossUsd, feesUsd: pnl.feesUsd, fundingUsd: pnl.fundingUsd, netPnlUsd: pnl.netUsd,
    confidence: pos.confidence, strategy: pos.setup, reasonEntry: (pos.reasons || []).join('; '),
    reasonExit: exitReason, durationMin: Math.round((mockMarket.now() - pos.openedAt) / 60_000),
  });
  if(tradeHistory.length > 200) tradeHistory.length = 200;
}
