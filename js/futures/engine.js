// =============================================================
// engine.js — the orchestrator. runScanCycle() produces one
// "Live Opportunity Scanner" row per symbol (APPROVED or
// REJECTED-with-reasons), and managePositions() advances any open
// paper trades against the latest price action: TP1 @ 1.5R closes 30%
// (original stop unchanged), TP2 @ 2.5R closes another 30% (stop THEN
// moves to a fee-adjusted breakeven for what's left), TP3 @ 3.25R
// closes the remaining 40% — see costs.js's buildTpLevels/
// feeAdjustedBreakevenPrice for where the actual prices come from.
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
import { detectAllSetups } from './setups.js';
import { computeFactorScores, weightedScore, DEFAULT_WEIGHTS } from './scoring.js';
import { decideExecution, estimateCosts, DEFAULT_FEE_CONFIG, DEFAULT_MIN_NET_PROFIT_PCT, buildTpLevels, feeAdjustedBreakevenPrice } from './costs.js';
import { positionSize, checkLiquidationSafety, RISK_DEFAULTS } from './risk.js';
import { evaluateNoTradeFilters, SYMBOL_COOLDOWN_MINUTES } from './noTradeEngine.js';
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
// CLUSDT is also excluded: it's a TradFi-underlying pair (WTI Crude Oil),
// not a normal perpetual, and it doesn't trade on Bybit's Demo account
// at all — the engine could still "approve" it in Demo mode and then have
// the order rejected at the exchange, or (worse) behave inconsistently
// between Demo and Live. Excluded from both, same as everything else here.
export const EXCLUDED_FUTURES_SYMBOLS = new Set(['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'LTCUSDT', 'DOGEUSDT', 'BNBUSDT', 'CLUSDT']);
export const TRADEABLE_FUTURES_SYMBOLS = FUTURES_SYMBOLS.filter(s => !EXCLUDED_FUTURES_SYMBOLS.has(s));

// Ensemble: each setup already carries its own direction+confidence.
// If setups disagree on direction, NO TRADE. If they agree, combine
// via a simple confidence-weighted average and take the strongest
// setup's reasons as the primary explanation.
export function combineEnsemble(signals){
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

// Only computes entry/stop now — take-profit construction moved to
// buildTpLevels (costs.js), applied once fees/execution are known (see
// runScanCycle below), since TP1's placement has to account for real
// round-trip costs. Every setup's own stop-distance math below is
// UNCHANGED from before; only the TP part of what buildLevels used to
// return has moved out.
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
    // fix at the source.
    const atrM5 = atr(snap.m5, 14) || entry * 0.0015;
    const atrPct5 = (atrM5 / entry) * 100;
    const distPct = clamp(atrPct5 * 1.1, 0.35, 0.9);
    const stopPrice = direction === 'LONG' ? entry * (1 - distPct / 100) : entry * (1 + distPct / 100);
    return { entry, stopPrice, stopDistancePct: distPct, atrPct: atrPct5 };
  }

  if(setupType === 'Range Scalp'){
    // Stop sits outside normal noise (wide enough that the mean-reversion
    // thesis is genuinely invalidated, not just noise) — same ATR-scaled
    // stop distance as before.
    const atrM5 = atr(snap.m5, 14) || entry * 0.0015;
    const atrPct5 = (atrM5 / entry) * 100;
    const stopDistancePct = clamp(atrPct5 * 1.8, 0.35, 1.0);
    const stopPrice = direction === 'LONG' ? entry * (1 - stopDistancePct / 100) : entry * (1 + stopDistancePct / 100);
    return { entry, stopPrice, stopDistancePct, atrPct: atrPct5 };
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

  return { entry, stopPrice, stopDistancePct, atrPct };
}

// Attaches the fixed 1.5R / 2.5R / 3.25R partial take-profit structure
// (buildTpLevels, costs.js) to whatever stop-distance buildLevels()
// above already produced for this setup — same structure for every
// setup type now (previously AI Scalp/Range Scalp were single-exit and
// the trend/breakout setups used a per-strategy reward:risk ratio; the
// exact TP1/TP2/TP3-at-1.5R/2.5R/3.25R structure requested replaces
// both). entryFeePct/exitFeePct/spreadPct/slippagePct are what makes
// TP1 fee-aware (requirement #3) instead of a raw 1.5R distance that
// could still be a net loss after real costs on a very tight stop.
function attachTpLevels(levels, direction, feeInputs){
  const tp = buildTpLevels({
    entry: levels.entry, direction, stopDistancePct: levels.stopDistancePct,
    entryFeePct: feeInputs.entryFeePct, exitFeePct: feeInputs.exitFeePct,
    spreadPct: feeInputs.spreadPct, slippagePct: feeInputs.slippagePct,
  });
  const [tp1, tp2, tp3] = tp;
  return {
    ...levels,
    tp1: tp1.price, tp2: tp2.price, tp3: tp3.price,
    tp1Pct: tp1.pct, tp2Pct: tp2.pct, tp3Pct: tp3.pct,
    tpFractions: { tp1: tp1.closeFraction, tp2: tp2.closeFraction, tp3: tp3.closeFraction },
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
    if(!snap){ continue; } // real-data fetch for this symbol failed/unavailable this cycle — skip it, don't crash the whole scan
    const regime = classifyRegime(snap.h1, snap.m15);
    rows.push(evaluateSymbol(symbol, snap, regime, cfg, dayState, btcShock, nowFn()));
  }

  return { rows, btcShock };
}

// The per-symbol detection -> scoring -> cost -> risk -> gate pipeline,
// pulled out of runScanCycle's loop body so backtest.js can run the
// EXACT same logic bar-by-bar against real historical candles — not a
// re-implementation that could quietly drift from what Paper/Live mode
// actually do. Takes an already-built snapshot/regime (so the caller
// controls the data source and "now" entirely) and returns one scanner
// row, APPROVED or REJECTED, same shape either way.
export function evaluateSymbol(symbol, snap, regime, cfg, dayState, btcShock, nowMs){
  const setups = detectAllSetups(snap, regime, cfg.strategies);
  const ensemble = combineEnsemble(setups);

  if(!ensemble){
    return baseRow(symbol, snap, regime, 'REJECTED', ['No qualifying setup detected this cycle']);
  }
  if(ensemble.conflict){
    return baseRow(symbol, snap, regime, 'REJECTED', ['Setups disagree on direction — ensemble requires agreement']);
  }

  const direction = ensemble.direction;
  const primary = ensemble.primary;
  const factorScores = computeFactorScores(snap, regime, primary);
  const weights = cfg.weights || DEFAULT_WEIGHTS;
  let confidence = weightedScore(factorScores, weights);
  confidence = Math.round((confidence + ensemble.ensembleConfidence) / 2);

  // Stop distance only, at this point (see buildLevels' own comment) —
  // strategyEntry/STRATEGY_REGISTRY is still consulted for the setup's
  // enabled/disabled state elsewhere (detectAllSetups) and its display
  // metadata, but no longer scales the take-profit target: TP1/TP2/TP3
  // are now ALWAYS built at the fixed 1.0R/1.5R/2.25R structure below,
  // the same for every strategy, per an explicit request that
  // superseded the old per-strategy reward:risk target.
  const levelsStopOnly = buildLevels(snap, direction, primary.type);
  const volExp = volumeExpansion(snap.m5, 10);
  const execution = decideExecution({ setupType: primary.type, volExpansionRatio: volExp });
  const holdMinutes = primary.type === 'AI Scalp' ? 12 : primary.type === 'Range Scalp' ? 20 : 90; // scalp strategies are meant to resolve fast; used for funding-cost estimation

  // Fees/spread/slippage have to be known BEFORE the TP levels are
  // built (not after, like the old single-target flow) — TP1 has to
  // be checked against them (requirement #3), not just informed by
  // them after the fact.
  const feeLookup = (cfg.feeConfig || DEFAULT_FEE_CONFIG)[cfg.exchange || 'binance'] || DEFAULT_FEE_CONFIG.binance;
  const entryFeePct = execution === 'MAKER' ? feeLookup.makerPct : feeLookup.takerPct;
  const exitFeePct = feeLookup.takerPct; // exits (SL/TP) conservatively assumed taker unless stated otherwise
  const slippagePct = clamp(snap.meta.spreadPct * 0.6, 0.005, 0.05);
  const levels = attachTpLevels(levelsStopOnly, direction, {
    entryFeePct, exitFeePct, spreadPct: snap.meta.spreadPct, slippagePct,
  });

  const costs = estimateCosts({
    exchange: cfg.exchange || 'binance',
    execution,
    grossTargetPct: levels.tp1Pct,
    spreadPct: snap.meta.spreadPct,
    slippagePct,
    fundingRatePct: snap.meta.fundingRatePct,
    holdMinutes,
    feeConfig: cfg.feeConfig || DEFAULT_FEE_CONFIG,
  });

  // Weighted across all 3 legs (0.3 x TP1's R + 0.3 x TP2's R + 0.4 x
  // TP3's R) rather than just TP1's — this is what actually reflects
  // the whole trade's reward:risk now that it exits in three pieces,
  // not one. With the fixed structure this is exactly 2.5R (never
  // lower — a fee bump only pushes TP1 further out, which can only
  // raise the weighted figure) — see the minRR floor below.
  const riskRewardRatio = levels.stopDistancePct > 0
    ? (levels.tp1Pct * levels.tpFractions.tp1 + levels.tp2Pct * levels.tpFractions.tp2 + levels.tp3Pct * levels.tpFractions.tp3) / levels.stopDistancePct
    : 0;
  const leverage = cfg.leverage || RISK_DEFAULTS.defaultLeverage;
  const liqSafety = checkLiquidationSafety({ entryPrice: levels.entry, stopPrice: levels.stopPrice, side: direction, leverage });
  const isAltcoin = symbol !== 'BTCUSDT';

  const minConfidence = cfg.highSelectivity ? 82 : (cfg.minConfidence ?? 60);
  // Sanity floor now that TP1/TP2/TP3 are always built at the same
  // 1.5R/2.5R/3.25R structure (weighted exactly 2.5R) rather than
  // scaled per-strategy. Set to 2.0 — the "at least 1:2R" requirement
  // itself, not just a backstop below it — so a signal only reaches
  // this gate with room to spare (the fixed structure is always 2.5R
  // pre-bump, and a TP1 fee-bump only raises it further); this still
  // catches a genuine bug in the TP math (e.g. a degenerate stop
  // distance) without ever approving something under 1:2. NOTE: the
  // old per-strategy Reward:Risk setting in the UI (cfg.strategyRR /
  // STRATEGY_REGISTRY.defaultRR) no longer drives TP placement or this
  // gate — it's superseded by the fixed structure requested. That
  // control is left in place but is currently a no-op; worth removing
  // from the UI in a follow-up if it shouldn't linger there looking
  // live.
  const minRR = 2.0;
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
    nowMs, riskPctPerTrade, feeToStopRatioPct,
  });

  const sizing = positionSize({
    equity: dayState.equity, riskPct: riskPctPerTrade,
    entryPrice: levels.entry, stopPrice: levels.stopPrice, leverage,
  });

  const row = {
    symbol, exchange: (cfg.exchange === 'gateio' ? 'GATE.IO' : (cfg.exchange || 'binance').toUpperCase()), direction,
    setup: primary.type, confidence,
    entry: levels.entry, stop: levels.stopPrice, tp1: levels.tp1, tp2: levels.tp2, tp3: levels.tp3,
    // Fractions to close at each level (always 30/30/40 — see
    // costs.js TP_LEVELS) plus the fee-adjusted breakeven price the
    // remaining 40% moves its stop to once TP2 fully fills (never at
    // TP1 — see requirements #4-#7), so both Paper's managePositions
    // and the real Live/Demo order placer read the exact same numbers.
    tpFractions: levels.tpFractions,
    breakevenStopPrice: feeAdjustedBreakevenPrice({ entry: levels.entry, direction, entryFeePct, exitFeePct, spreadPct: snap.meta.spreadPct, slippagePct }),
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
  return row;
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
// candle's high/low: TP1 (30%, stop unchanged) -> TP2 (30%, stop moves
// to fee-adjusted breakeven) -> TP3 (remaining 40%) or SL or time-stop.
// All P&L is computed net of the same fee/slippage/funding model used
// for pre-trade filtering.
export function openPosition(row, dayState){
  const qty = row.sizing ? row.sizing.qty : 0;
  const position = {
    id: `${row.symbol}-${mockMarket.now()}-${Math.random().toString(36).slice(2,7)}`,
    symbol: row.symbol, exchange: row.exchange, direction: row.direction,
    entry: row.entry, stop: row.stop, originalStop: row.stop,
    tp1: row.tp1, tp2: row.tp2, tp3: row.tp3,
    // Always 30/30/40 (costs.js TP_LEVELS) and the fee-adjusted
    // breakeven price the stop moves to ONLY once TP2 is fully closed
    // (requirements #4-#7) — never at TP1, and the original stop is
    // otherwise left exactly as it was set at entry.
    tpFractions: row.tpFractions || { tp1: 0.30, tp2: 0.30, tp3: 0.40 },
    breakevenStopPrice: row.breakevenStopPrice,
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

// Puts a symbol on a 30-minute no-re-entry cooldown the moment ANY
// close happens on it — SL, TP3, time-stop here in Paper mode; the
// Live/Demo equivalent (futures-ui.js's runLiveCycle close-detection,
// which also covers a manual close done directly on the exchange) sets
// the same field on its own dayState-shaped shim. evaluateNoTradeFilters
// (noTradeEngine.js) is what actually blocks a new entry while it's set;
// this only records the timestamp. Other symbols are completely
// unaffected — a fresh signal on any other pair is still tradeable the
// very next cycle.
export function setSymbolCooldown(dayState, symbol, nowMs){
  if(!dayState) return;
  dayState.cooldownUntilBySymbol = dayState.cooldownUntilBySymbol || {};
  dayState.cooldownUntilBySymbol[symbol] = (nowMs ?? mockMarket.now()) + SYMBOL_COOLDOWN_MINUTES * 60_000;
}

export function recomputeOpenRisk(dayState){
  dayState.openPositions = dayState.positions.length;
  dayState.openRiskPct = dayState.positions.reduce((a, p) => a + (p.riskAmountUsd || 0), 0) / Math.max(1, dayState.equity) * 100;
}

export function netPnlForFraction(position, exitPrice, fraction, dayState){
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
      setSymbolCooldown(dayState, pos.symbol);
      continue;
    }

    const tp1Fraction = pos.tpFractions ? pos.tpFractions.tp1 : 0.30;
    const tp2Fraction = pos.tpFractions ? pos.tpFractions.tp2 : 0.30;

    if(!pos.partialsTaken.includes('tp1') && hitTP(pos.tp1)){
      const pnl = netPnlForFraction(pos, pos.tp1, tp1Fraction, dayState);
      pos.remainingFraction -= tp1Fraction;
      pos.partialsTaken.push('tp1');
      // Requirement #4/#5: SL stays exactly where it was — TP1 does NOT
      // move it to break-even (that used to happen here; it no longer
      // does, on purpose).
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
      events.push(`TP1 hit — closed ${Math.round(tp1Fraction * 100)}%, original stop unchanged`);
    }

    if(pos.remainingFraction > 0 && !pos.partialsTaken.includes('tp2') && hitTP(pos.tp2)){
      const pnl = netPnlForFraction(pos, pos.tp2, tp2Fraction, dayState);
      pos.remainingFraction -= tp2Fraction;
      pos.partialsTaken.push('tp2');
      // Requirement #6/#7: ONLY now, after TP2 fully closes, does the
      // stop on what's left move — to a fee-adjusted breakeven (computed
      // up front in runScanCycle/attachTpLevels, carried onto the
      // position as breakevenStopPrice), not the raw entry price.
      if(pos.breakevenStopPrice != null) pos.stop = pos.breakevenStopPrice;
      dayState.realizedNetUsd += pnl.netUsd; dayState.realizedGrossUsd += pnl.grossUsd;
      dayState.feesUsd += pnl.feesUsd; dayState.fundingUsd += pnl.fundingUsd;
      pos.accrued = pos.accrued || { netUsd: 0, grossUsd: 0, feesUsd: 0, fundingUsd: 0 };
      pos.accrued.netUsd += pnl.netUsd; pos.accrued.grossUsd += pnl.grossUsd;
      pos.accrued.feesUsd += pnl.feesUsd; pos.accrued.fundingUsd += pnl.fundingUsd;
      events.push('TP2 hit — closed another 30%, remaining 40% stop moved to fee-adjusted breakeven');
    }

    if(pos.remainingFraction > 0 && hitTP(pos.tp3)){
      const pnl = netPnlForFraction(pos, pos.tp3, pos.remainingFraction, dayState);
      closeTrade(pos, pos.tp3, pnl, 'TP3', dayState, tradeHistory, events);
      setSymbolCooldown(dayState, pos.symbol);
      continue;
    }

    if(pos.remainingFraction > 0 && ageMinutes > timeStopMinutes){
      const pnl = netPnlForFraction(pos, snap.price, pos.remainingFraction, dayState);
      closeTrade(pos, snap.price, pnl, 'TIME_STOP', dayState, tradeHistory, events);
      setSymbolCooldown(dayState, pos.symbol);
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
