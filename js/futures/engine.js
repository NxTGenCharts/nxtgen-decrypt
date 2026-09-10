// =============================================================
// engine.js — the orchestrator. runScanCycle() produces one
// "Live Opportunity Scanner" row per symbol (APPROVED or
// REJECTED-with-reasons), and managePositions() advances any open
// paper trades against the latest price action (partial TP1,
// break-even stop, trailing, time-stop) using realistic costs.
//
// This module is data-source agnostic: runScanCycle() defaults to
// mockMarket.snapshot()/btcShock()/now() (Paper mode), but accepts an
// optional `opts` object ({ symbols, getSnapshot, getBtcShock, now }) to
// override every one of them — that's what js/futures-ui.js's
// runLiveCycle() passes to run this exact same detection/scoring logic
// against real Bybit market data for Live/Demo mode instead. Nothing in
// this file needed to change for that beyond adding the override
// points; regime.js, setups.js, scoring.js, risk.js, costs.js, and
// noTradeEngine.js are all equally data-source agnostic already.
// =============================================================
import { mockMarket, FUTURES_SYMBOLS } from './mockMarket.js';
import { classifyRegime, REGIMES } from './regime.js';
import { detectAllSetups, STRATEGY_REGISTRY } from './setups.js';
import { computeFactorScores, weightedScore, DEFAULT_WEIGHTS } from './scoring.js';
import { decideExecution, estimateCosts, DEFAULT_FEE_CONFIG, DEFAULT_MIN_NET_PROFIT_PCT } from './costs.js';
import { positionSize, checkLiquidationSafety, RISK_DEFAULTS } from './risk.js';
import { evaluateNoTradeFilters } from './noTradeEngine.js';
import { buildExplanation } from './explain.js';
import { atr, swingLevels, volumeExpansion, clamp } from './indicators.js';

function getSnapshot(symbol){ return mockMarket.snapshot(symbol); }
function getBtcShock(){ return mockMarket.btcShock(); }

// BTC, ETH, SOL, LTC, DOGE and BNB are excluded from the tradeable/scanned
// set everywhere — Paper mode (below), Live/Demo mode (see
// js/futures-ui.js's LIVE_TRADEABLE_WATCHLIST), on all five exchanges
// alike. BTC/ETH/SOL: disproportionately high fees relative to the rest
// of the watchlist. LTC/DOGE/BNB: excluded on explicit request, on top of
// the general fee-vs-stop fix elsewhere in this file (see buildLevels'
// stop-distance floor and the fee-to-stop-ratio gate in noTradeEngine.js)
// which is what actually addresses the underlying fee-drag problem for
// every symbol, not just these three specifically. This only removes them
// from being scanned, scored, or opened as positions: BTCUSDT's own price
// data is still read separately for the cross-market "BTC shock" filter
// (getBtcShock above / isAltcoin below), which every remaining altcoin
// signal is still checked against.
export const EXCLUDED_FUTURES_SYMBOLS = new Set(['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'LTCUSDT', 'DOGEUSDT', 'BNBUSDT']);
export const TRADEABLE_FUTURES_SYMBOLS = FUTURES_SYMBOLS.filter(s => !EXCLUDED_FUTURES_SYMBOLS.has(s));

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

function buildLevels(snap, direction, setupType){
  const entry = snap.price;
  const atrM15 = atr(snap.m15, 14) || entry * 0.003;
  const atrPct = (atrM15 / entry) * 100;

  if(setupType === 'AI Scalp'){
    // Stop distance is ATR-scaled so it self-adjusts to each symbol's/
    // moment's own volatility instead of a fixed %. The floor was
    // previously 0.15% — against real round-trip taker fees of roughly
    // 0.10-0.12% (Bybit/Binance/Gate.io/Bitget; see costs.js), that meant
    // fees alone could eat 70-80%+ of the stop, which is what real
    // Live/Demo trading exposed: a near-breakeven GROSS win rate turning
    // sharply net-negative purely on fee drag, not a bad signal. Floor
    // raised to 0.35% so fees are a materially smaller, survivable slice
    // of the risk on every trade — the noTradeEngine.js fee-to-stop-ratio
    // gate is the general-purpose backstop for this; this floor is the
    // fix at the source. Target is set from the stop distance via
    // applyRewardRiskFloor using this strategy's own reward:risk ratio
    // (per-strategy now, via cfg.strategyRR / STRATEGY_REGISTRY — see
    // setups.js and this file's own scan loop below — not a single
    // fixed global ratio).
    const atrM5 = atr(snap.m5, 14) || entry * 0.0015;
    const atrPct5 = (atrM5 / entry) * 100;
    const distPct = clamp(atrPct5 * 1.1, 0.35, 0.9);
    const stopPrice = direction === 'LONG' ? entry * (1 - distPct / 100) : entry * (1 + distPct / 100);
    const sign = direction === 'LONG' ? 1 : -1;
    const tp1 = entry * (1 + sign * distPct / 100);
    // Single-exit — no partial-scale levels for a strategy this fast.
    return { entry, stopPrice, stopDistancePct: distPct, tp1, tp2: tp1, tp3: tp1, tp1Pct: distPct, tp2Pct: distPct, tp3Pct: distPct, atrPct: atrPct5 };
  }

  if(setupType === 'Range Scalp'){
    // Stop sits outside normal noise (wide enough that the mean-reversion
    // thesis is genuinely invalidated, not just noise) — same ATR-scaled
    // stop distance as before. The target is NO LONGER a tight skewed
    // fraction of the stop (that shape needs a very high win rate just to
    // break even, and in live use didn't reliably reach it — small wins,
    // occasional large losses, net negative even near a 50% hit rate).
    // Target is now derived from the stop distance via the configured
    // reward:risk ratio (applyRewardRiskFloor below), same as every other
    // setup, seeded at a small placeholder here that the floor will raise.
    const atrM5 = atr(snap.m5, 14) || entry * 0.0015;
    const atrPct5 = (atrM5 / entry) * 100;
    const stopDistancePct = clamp(atrPct5 * 1.8, 0.35, 1.0);
    const tp1Pct = clamp(stopDistancePct / 2.2, 0.16, 0.5); // placeholder — applyRewardRiskFloor raises this to stopDistancePct * riskRewardRatio
    const stopPrice = direction === 'LONG' ? entry * (1 - stopDistancePct / 100) : entry * (1 + stopDistancePct / 100);
    const sign = direction === 'LONG' ? 1 : -1;
    const tp1 = entry * (1 + sign * tp1Pct / 100);
    // Single-exit: tp2/tp3 set equal to tp1 so the whole position closes at the one target instead of scaling out.
    return { entry, stopPrice, stopDistancePct, tp1, tp2: tp1, tp3: tp1, tp1Pct, tp2Pct: tp1Pct, tp3Pct: tp1Pct, atrPct: atrPct5 };
  }

  const { support, resistance } = swingLevels(snap.m15, 30);

  const structuralStopPct = direction === 'LONG'
    ? Math.abs((entry - support) / entry) * 100
    : Math.abs((resistance - entry) / entry) * 100;

  // Stop uses the tighter of (structure invalidation, a volatility-scaled
  // cap) so a single distant swing point can't blow the stop out — but
  // never tighter than 1x ATR, so it isn't sitting inside normal noise.
  // Floor raised from 0.12% to 0.35% for the same reason as AI Scalp's
  // own floor above (see its comment): a 0.12% stop against real
  // round-trip futures fees of ~0.10-0.12% (costs.js) means fees alone
  // could eat 80-100%+ of the risk on every trade, independent of signal
  // quality — this was never actually exercised while every non-AI-Scalp
  // setup sat inactive (see detectAllSetups in setups.js), so it never
  // got caught in Live/Demo trading the way AI Scalp's did, but it was
  // the same landmine waiting for whichever setup got enabled next.
  const stopDistancePct = clamp(Math.max(atrPct * 1.0, Math.min(structuralStopPct, atrPct * 2.0)), 0.35, 1.2);
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

// Guarantees every trade's actual reward:risk meets whichever ratio its
// own strategy is configured for (per-strategy now — see STRATEGY_REGISTRY
// in setups.js and cfg.strategyRR in this file's scan loop), regardless
// of which setup produced it — this is what makes that ratio a real,
// enforced target rather than just a filter that quietly lets
// underpowered setups through with their own much smaller built-in
// targets. If the setup's own structure/ATR-based target already clears
// the ratio, it's left alone (a bigger natural target is never scaled
// down); if not, tp1/tp2/tp3 are scaled up together (preserving their
// relative spacing) so tp1 lands at exactly stopDistancePct *
// riskRewardRatio — e.g. a 1% stop at a 1:2.5 ratio targets 2.5%, so a
// $10 loss is matched by a $25 win.
function applyRewardRiskFloor(levels, direction, riskRewardRatio){
  if(!(levels.stopDistancePct > 0) || !(levels.tp1Pct > 0)) return levels;
  const targetPct = levels.stopDistancePct * riskRewardRatio;
  if(levels.tp1Pct >= targetPct) return levels;
  const scale = targetPct / levels.tp1Pct;
  const sign = direction === 'LONG' ? 1 : -1;
  const tp1Pct = levels.tp1Pct * scale, tp2Pct = levels.tp2Pct * scale, tp3Pct = levels.tp3Pct * scale;
  return {
    ...levels, tp1Pct, tp2Pct, tp3Pct,
    tp1: levels.entry * (1 + sign * tp1Pct / 100),
    tp2: levels.entry * (1 + sign * tp2Pct / 100),
    tp3: levels.entry * (1 + sign * tp3Pct / 100),
  };
}

// Produces one row per symbol: APPROVED opportunities plus REJECTED
// ones (kept so the scanner table can show "why not" transparently,
// matching the No-Trade Engine's job of explaining a pass).
export function runScanCycle(cfg, dayState, opts){
  const symbols = (opts && opts.symbols) || TRADEABLE_FUTURES_SYMBOLS;
  const snapshotFor = (opts && opts.getSnapshot) || getSnapshot;
  const nowFn = (opts && opts.now) || (() => mockMarket.now());
  const btcShock = (opts && opts.getBtcShock) ? opts.getBtcShock() : getBtcShock();
  const rows = [];

  // Cooling-off period elapsed — allow the consecutive-loss streak to
  // reset so the bot doesn't stay locked out for the rest of the
  // session (see RISK_DEFAULTS.coolingOffMinutes).
  if(dayState.consecutiveLosses >= RISK_DEFAULTS.maxConsecutiveLosses){
    const cooldownUntil = (dayState.lastLossAt || 0) + RISK_DEFAULTS.coolingOffMinutes * 60_000;
    if(nowFn() >= cooldownUntil) dayState.consecutiveLosses = 0;
  }

  for(const symbol of symbols){
    const snap = snapshotFor(symbol);
    if(!snap) continue; // real-data fetch for this symbol failed/unavailable this cycle — skip it, don't crash the whole scan
    const regime = classifyRegime(snap.h1, snap.m15);
    const setups = detectAllSetups(snap, regime, cfg.strategies);
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

    // Reward:risk is now PER-STRATEGY (cfg.strategyRR, keyed by
    // STRATEGY_REGISTRY id — see setups.js) instead of one fixed global
    // ratio. Still both the floor AND the actual target construction
    // for whichever strategy produced this signal, so a trade can never
    // be approved with a smaller built-in target than its own strategy's
    // ratio calls for. Falls back to that strategy's own defaultRR (from
    // the registry) if the UI hasn't set one, and to the registry's own
    // aiScalp entry if the primary type can't be matched to a registry
    // id at all (shouldn't happen — every detector output type has a
    // matching registry entry — but never silently fall back to nothing).
    const strategyEntry = STRATEGY_REGISTRY.find(s => s.type === primary.type);
    const targetRiskReward = (cfg.strategyRR && strategyEntry && cfg.strategyRR[strategyEntry.id] != null)
      ? cfg.strategyRR[strategyEntry.id]
      : (strategyEntry ? strategyEntry.defaultRR : RISK_DEFAULTS.riskRewardRatio);
    const levels = applyRewardRiskFloor(buildLevels(snap, direction, primary.type), direction, targetRiskReward);
    const volExp = volumeExpansion(snap.m5, 10);
    const execution = decideExecution({ setupType: primary.type, volExpansionRatio: volExp });
    const holdMinutes = primary.type === 'AI Scalp' ? 12 : primary.type === 'Range Scalp' ? 20 : 90; // scalp strategies are meant to resolve fast; used for funding-cost estimation

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
    // Every setup is now held to the SAME reward:risk floor — the one
    // just used to actually build the target above — instead of Range
    // Scalp/AI Scalp getting their own much lower floors (0.35 / 0.9).
    // That old split is what let both scalp setups through with a
    // built-in target smaller than their stop, which needs a very high
    // win rate just to break even and in live use wasn't reliably
    // hitting one (small wins, occasional large losses, net negative
    // even near a 50% hit rate). Since applyRewardRiskFloor already
    // guarantees every trade's actual ratio meets targetRiskReward, this
    // check should effectively never fire — it's a safety net, not the
    // primary mechanism, anymore.
    const minRR = targetRiskReward;
    // This floor is unrelated to R:R — it's still true that both scalp
    // strategies' gross targets are comparatively small in absolute %
    // terms, so the default 0.30% net-profit floor (sized for the
    // bigger trend/breakout targets) would reject nearly every scalp
    // signal even when it clears round-trip costs. Each still has to
    // clear costs, just not by as much. Raised from 0.03% to 0.15% for
    // AI Scalp after real Live/Demo trading showed 0.03% left almost no
    // margin above real round-trip fees (~0.10-0.12%) once spread and
    // slippage were added on top — trades were clearing the floor on
    // paper while being fee-negative in practice.
    const minNetProfit = primary.type === 'AI Scalp' ? (cfg.aiScalpMinNetProfitPct ?? 0.15)
      : primary.type === 'Range Scalp' ? (cfg.scalpMinNetProfitPct ?? 0.04)
      : (cfg.minNetProfitPct ?? DEFAULT_MIN_NET_PROFIT_PCT);

    const riskPctPerTrade = clamp(cfg.riskPctPerTrade || RISK_DEFAULTS.riskPctPerTrade, 0.1, RISK_DEFAULTS.maxRiskPctPerTrade);

    // How much of the stop distance itself is round-trip fees — the
    // direct measure of "is this stop too tight to survive real costs"
    // that a net-profit floor on the WIN side alone can't catch (see
    // noTradeEngine.js's cap on this).
    const feeToStopRatioPct = levels.stopDistancePct > 0
      ? ((costs.entryFeePct + costs.exitFeePct) / levels.stopDistancePct) * 100
      : null;

    const gate = evaluateNoTradeFilters({
      snap, regime, confidence, minConfidence,
      netTargetPct: costs.netTargetPct, minNetProfitPct: minNetProfit,
      riskRewardRatio, minRiskReward: minRR,
      liquidationSafety: liqSafety, dayState, btcShock, isAltcoin,
      fundingCostPct: costs.fundingCostPct, grossTargetPct: levels.tp1Pct,
      nowMs: nowFn(), riskPctPerTrade, feeToStopRatioPct,
    });

    const sizing = positionSize({
      equity: dayState.equity, riskPct: riskPctPerTrade,
      entryPrice: levels.entry, stopPrice: levels.stopPrice, leverage,
    });

    const row = {
      symbol, exchange: (cfg.exchange === 'gateio' ? 'GATE.IO' : (cfg.exchange || 'binance').toUpperCase()), direction,
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
    const timeStopMinutes = pos.setup === 'AI Scalp' ? (cfg.aiScalpTimeStopMinutes || 40)
      : pos.setup === 'Range Scalp' ? (cfg.scalpTimeStopMinutes || 45)
      : (cfg.timeStopMinutes || 240);

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
      // BUGFIX: earlier partial fills were added to dayState totals above
      // (correct) but were never carried into pos.finalNetUsd, so a
      // trade's win/loss verdict and its trade-history row only ever
      // reflected whichever leg happened to close it, silently dropping
      // any TP1/TP2 partial profit already banked. Accrue it on the
      // position so closeTrade() below can report the true full-trade
      // total instead of just the last slice.
      pos.accrued = pos.accrued || { netUsd: 0, grossUsd: 0, feesUsd: 0, fundingUsd: 0 };
      pos.accrued.netUsd += pnl.netUsd; pos.accrued.grossUsd += pnl.grossUsd;
      pos.accrued.feesUsd += pnl.feesUsd; pos.accrued.fundingUsd += pnl.fundingUsd;
      events.push('Partial TP1 taken, stop moved to break-even');
    }

    if(pos.remainingFraction > 0 && !pos.partialsTaken.includes('tp2') && hitTP(pos.tp2)){
      const pnl = netPnlForFraction(pos, pos.tp2, 0.25, dayState);
      pos.remainingFraction -= 0.25;
      pos.partialsTaken.push('tp2');
      pos.stop = pos.tp1; // trail stop up to TP1 after TP2
      dayState.realizedNetUsd += pnl.netUsd; dayState.realizedGrossUsd += pnl.grossUsd;
      dayState.feesUsd += pnl.feesUsd; dayState.fundingUsd += pnl.fundingUsd;
      pos.accrued = pos.accrued || { netUsd: 0, grossUsd: 0, feesUsd: 0, fundingUsd: 0 };
      pos.accrued.netUsd += pnl.netUsd; pos.accrued.grossUsd += pnl.grossUsd;
      pos.accrued.feesUsd += pnl.feesUsd; pos.accrued.fundingUsd += pnl.fundingUsd;
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

  // Win/loss (and the trade-history row) reflect the FULL trade's net
  // P&L across every partial fill, not just whichever slice closed it.
  const accrued = pos.accrued || { netUsd: 0, grossUsd: 0, feesUsd: 0, fundingUsd: 0 };
  pos.finalNetUsd = accrued.netUsd + pnl.netUsd;
  const totalGrossUsd = accrued.grossUsd + pnl.grossUsd;
  const totalFeesUsd = accrued.feesUsd + pnl.feesUsd;
  const totalFundingUsd = accrued.fundingUsd + pnl.fundingUsd;

  dayState.trades++;
  if(pos.finalNetUsd > 0){ dayState.wins++; dayState.consecutiveLosses = 0; }
  else { dayState.losses++; dayState.consecutiveLosses++; dayState.lastLossAt = mockMarket.now(); }

  // Same bug class the comment above already fixed for win/loss and the
  // trade-history row: this was `+= pnl.netUsd` (only the slice that
  // closed the trade), silently dropping any TP1/TP2 partial P&L from the
  // balance itself even though it WAS correctly counted in realizedNetUsd
  // above and in pos.finalNetUsd. Any trade with 2+ partial exits before
  // its final close — which for AI Scalp is nearly every winning trade,
  // since TP1/TP2/TP3 share the same price and fire back-to-back in one
  // candle — was crediting equity with only the last 25-50% of its actual
  // profit. That's why Current Balance could end up BELOW the starting
  // balance in the same session Net P&L reports a genuine profit: the P&L
  // stat was already correct (it's summed straight from realizedNetUsd),
  // it was equity that was under-crediting winners.
  dayState.equity += pos.finalNetUsd;
  dayState.dailyPnlPct = ((dayState.equity - dayState.startingEquity) / dayState.startingEquity) * 100;
  dayState.peakEquity = Math.max(dayState.peakEquity, dayState.equity);
  dayState.maxDrawdownPct = Math.max(dayState.maxDrawdownPct, ((dayState.peakEquity - dayState.equity) / dayState.peakEquity) * 100);

  tradeHistory.unshift({
    timestamp: mockMarket.now(), exchange: pos.exchange, symbol: pos.symbol, direction: pos.direction,
    entry: pos.entry, exit: exitPrice, qty: pos.qty, leverage: pos.leverage,
    grossPnlUsd: totalGrossUsd, feesUsd: totalFeesUsd, fundingUsd: totalFundingUsd, netPnlUsd: pos.finalNetUsd,
    confidence: pos.confidence, strategy: pos.setup, reasonEntry: (pos.reasons || []).join('; '),
    reasonExit: exitReason, durationMin: Math.round((mockMarket.now() - pos.openedAt) / 60_000),
  });
  if(tradeHistory.length > 200) tradeHistory.length = 200;
}
