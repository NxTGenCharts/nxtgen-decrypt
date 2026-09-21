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
import { decideExecution, estimateCosts, DEFAULT_FEE_CONFIG, DEFAULT_MIN_NET_PROFIT_PCT, buildTpLevels, buildSingleTargetLevel, feeAdjustedBreakevenPrice } from './costs.js';
import { positionSize, checkLiquidationSafety, RISK_DEFAULTS } from './risk.js';
import { evaluateNoTradeFilters, SYMBOL_COOLDOWN_MINUTES } from './noTradeEngine.js';
import { buildExplanation } from './explain.js';
import { atr, swingLevels, volumeExpansion, clamp } from './indicators.js';
import { QUANT_ID, QUANT_TYPE, quantSymbolSet, effectiveMinConfidence } from './quant/config.js';
import { computeQuantRiskState, effectiveRiskPct, quantSize, quantEntryGate, quantExitPrice, quantTradeFields } from './quant/risk.js';
import { buildQuantExplanation } from './quant/signal.js';
import { qlog } from './quant/log.js';
import { EXCLUDED_FUTURES_SYMBOLS } from './excludedSymbols.js';

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
// The excluded-pairs list lives in excludedSymbols.js (shared with the Quant config sanitizer). Re-exported
// here under its original name so every existing import keeps working.
export { EXCLUDED_FUTURES_SYMBOLS };
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
function buildLevels(snap, direction, setupType, signalMeta){
  const entry = snap.price;
  const atrM15 = atr(snap.m15, 14) || entry * 0.003;
  const atrPct = (atrM15 / entry) * 100;

  if(setupType === 'NxTGen Scalp'){
    // Stop distance is ATR-scaled so it self-adjusts to each symbol's/
    // moment's own volatility instead of a fixed %. Floor raised again,
    // 0.35% -> 0.45%, after a real measured run (6 single-strategy
    // backtests, 30d/5m/Bybit, ~250-425 trades each) showed EVERY scalp-
    // style setup still fee-negative even with the earlier 0.35% floor —
    // NxTGen Scalp alone: 388 trades, 38.1% win rate, PROFIT-POSITIVE gross
    // (net -$5012 + fees $6562 = +$1550 gross), but fees alone (~65% of
    // the whole starting balance across the run) erased it entirely. Fee
    // $ scales with notional, and notional = riskAmount / stopDistancePct
    // (see risk.js positionSize) — so fee$-per-trade is proportional to
    // riskAmount x (feePct / stopDistancePct); widening the stop directly
    // shrinks that ratio without changing how much is actually risked.
    // 0.35% -> 0.45% is roughly a 22% cut to fee $ per trade, all else
    // equal. This is a mechanical fix to a measured cost problem, not a
    // tuned guess at improving the win rate itself — re-run the backtest
    // to see the actual before/after, the way every other change in this
    // file has been.
    const atrM5 = atr(snap.m5, 14) || entry * 0.0015;
    const atrPct5 = (atrM5 / entry) * 100;
    const distPct = clamp(atrPct5 * 1.1, 0.45, 1.0);
    const stopPrice = direction === 'LONG' ? entry * (1 - distPct / 100) : entry * (1 + distPct / 100);
    return { entry, stopPrice, stopDistancePct: distPct, atrPct: atrPct5 };
  }

  if(setupType === 'Nova Scalp'){
    // Structure stop: Nova Scalp's detector (setups.js) hands back the stop
    // it wants — the recent swing low/high near the Parabolic SAR dots plus
    // a small ATR buffer — and it is used AS-IS, not widened to a floor
    // like the other scalps. Widening it would move the stop off the
    // structure that defines the trade. The fee protection that floor used
    // to provide is still enforced downstream by noTradeEngine's
    // fee-to-stop cap: a swing stop too tight to survive round-trip fees is
    // REJECTED there rather than silently changed here. Only distance is
    // recomputed against the live entry price (the detector measured off the
    // last 5m close).
    const atrM5 = atr(snap.m5, 14) || entry * 0.0015;
    const atrPct5 = (atrM5 / entry) * 100;
    const sp = signalMeta && signalMeta.stopPrice;
    const valid = sp && (direction === 'LONG' ? sp < entry : sp > entry);
    if(valid){
      const distPct = Math.abs(entry - sp) / entry * 100;
      return { entry, stopPrice: sp, stopDistancePct: distPct, atrPct: atrPct5, singleTargetR: signalMeta.targetR || 2 };
    }
    // Defensive fallback only (a Nova signal always carries meta.stopPrice).
    const distPct = clamp(atrPct5 * 1.0, 0.45, 0.95);
    const stopPrice = direction === 'LONG' ? entry * (1 - distPct / 100) : entry * (1 + distPct / 100);
    return { entry, stopPrice, stopDistancePct: distPct, atrPct: atrPct5, singleTargetR: 2 };
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
  // Floor raised again, 0.35% -> 0.45%, same measured basis and same
  // reasoning as NxTGen Scalp/Nova Scalp's own floor bump just above (see
  // that comment for the fee$-scales-with-notional math) — the same
  // 6-run measurement showed Trend Continuation, Liquidity Sweep
  // Reversal, and Breakout + Retest all still fee-heavy at 0.35% (fees
  // ran 45-99% of the whole account's starting balance across each
  // 30-day/~250-425-trade run), not just the two dedicated scalps.
  const stopDistancePct = clamp(Math.max(atrPct * 1.0, Math.min(structuralStopPct, atrPct * 2.0)), 0.45, 1.3);
  const stopPrice = direction === 'LONG' ? entry * (1 - stopDistancePct / 100) : entry * (1 + stopDistancePct / 100);

  return { entry, stopPrice, stopDistancePct, atrPct };
}

// Attaches the fixed 1.5R / 2.5R / 3.25R partial take-profit structure
// (buildTpLevels, costs.js) to whatever stop-distance buildLevels()
// above already produced for this setup — same structure for every
// setup type now (previously NxTGen Scalp/Range Scalp were single-exit and
// the trend/breakout setups used a per-strategy reward:risk ratio; the
// exact TP1/TP2/TP3-at-1.5R/2.5R/3.25R structure requested replaces
// both). entryFeePct/exitFeePct/spreadPct/slippagePct are what makes
// TP1 fee-aware (requirement #3) instead of a raw 1.5R distance that
// could still be a net loss after real costs on a very tight stop.
function attachTpLevels(levels, direction, feeInputs){
  // Single-exit setups (Nova Scalp: everything closes at 2R) skip the
  // 30/30/40 structure — see costs.js's buildSingleTargetLevel.
  if(levels.singleTargetR){
    const t = buildSingleTargetLevel({
      entry: levels.entry, direction, stopDistancePct: levels.stopDistancePct, rMultiple: levels.singleTargetR,
      entryFeePct: feeInputs.entryFeePct, exitFeePct: feeInputs.exitFeePct,
      spreadPct: feeInputs.spreadPct, slippagePct: feeInputs.slippagePct,
    });
    return {
      ...levels,
      tp1: t.price, tp2: t.price, tp3: t.price,
      tp1Pct: t.pct, tp2Pct: t.pct, tp3Pct: t.pct,
      tpFractions: { tp1: 0, tp2: 0, tp3: 1 },
      singleTarget: true,
    };
  }
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

// NxTGen Quant Futures trades its OWN configurable symbol list (default XRP/ADA/AVAX/LINK/DOT),
// which can include liquid pairs outside the platform's default scan universe. This adds those
// extra symbols to a scan list when — and only when — Quant is enabled. The platform's excluded
// pairs (excludedSymbols.js: BTC/ETH/SOL/LTC/DOGE/BNB/CL) are NEVER added and never traded by
// Quant either: the exclusion applies to every strategy in every mode.
export function isQuantEnabled(cfg){
  const on = cfg && cfg.strategies ? !!cfg.strategies[QUANT_ID] : false;
  return on && !!cfg.quant;
}
export function scanSymbolsWithQuant(baseSymbols, cfg){
  if(!isQuantEnabled(cfg)) return baseSymbols;
  const extra = Array.from(quantSymbolSet(cfg.quant)).filter(x => !EXCLUDED_FUTURES_SYMBOLS.has(x) && !baseSymbols.includes(x));
  return baseSymbols.filter(x => !EXCLUDED_FUTURES_SYMBOLS.has(x)).concat(extra);
}

// Produces one row per symbol: APPROVED opportunities plus REJECTED
// ones (kept so the scanner table can show "why not" transparently,
// matching the No-Trade Engine's job of explaining a pass).
export function runScanCycle(cfg, dayState, opts){
  const symbols = (opts && opts.symbols) || scanSymbolsWithQuant(TRADEABLE_FUTURES_SYMBOLS, cfg);
  if(dayState && !dayState.quantTrades) dayState.quantTrades = [];
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
  // Single choke point for Paper, Backtest and Live/Demo (all three evaluate through here): a pair on the
  // platform's excluded list is rejected for EVERY strategy, Quant included — no exceptions, whatever the
  // caller's symbol list or a saved Quant config says.
  if(EXCLUDED_FUTURES_SYMBOLS.has(symbol)) return baseRow(symbol, snap, regime, 'REJECTED', ['Symbol is on the platform\'s excluded list (BTC/ETH/SOL/LTC/DOGE/BNB/CL) — not traded by any strategy']);
  const quantApplies = isQuantEnabled(cfg) && quantSymbolSet(cfg.quant).has(symbol);
  let quantCtx = null;
  if(quantApplies){
    const fees = (cfg.feeConfig || DEFAULT_FEE_CONFIG)[cfg.exchange || 'binance'] || DEFAULT_FEE_CONFIG.binance;
    const slipEst = clamp(snap.meta.spreadPct * 0.6, 0.005, 0.05);
    // Conservative round-trip cost estimate (taker in, taker out) the score's RR-quality factor uses.
    quantCtx = { qcfg: cfg.quant, ctx: { nowMs, log: !!cfg.quant.log, costPct: fees.takerPct * 2 + snap.meta.spreadPct + slipEst } };
  }
  const detected = detectAllSetups(snap, regime, cfg.strategies, quantCtx);
  // Quant Futures is a self-contained system (own stop, own risk engine, own exit): when it produces a
  // qualifying signal it is evaluated on its own, not blended into the ensemble average.
  const quantSig = detected.find(sg => sg.type === QUANT_TYPE && !(sg.vetoes && sg.vetoes.length));
  if(quantSig) return evaluateQuantRow(symbol, snap, regime, cfg, dayState, btcShock, nowMs, quantSig);
  // A detector can hand back a genuine trigger that one of ITS OWN filters
  // vetoed (e.g. Quant's confluence/regime gates — a signal object with a
  // `vetoes` list and no direction). Those never take part in the ensemble —
  // they can't create a conflict or lend confidence — but their reasons are
  // surfaced if nothing else qualified, so the scanner says WHY instead of a
  // blank "no setup".
  const vetoed = detected.filter(sg => sg.vetoes && sg.vetoes.length);
  const setups = detected.filter(sg => !(sg.vetoes && sg.vetoes.length));
  const ensemble = combineEnsemble(setups);

  if(!ensemble){
    return baseRow(symbol, snap, regime, 'REJECTED', vetoed.length ? vetoed.flatMap(sg => sg.vetoes) : ['No qualifying setup detected this cycle']);
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
  const levelsStopOnly = buildLevels(snap, direction, primary.type, primary.meta);
  const volExp = volumeExpansion(snap.m5, 10);
  const execution = decideExecution({ setupType: primary.type, volExpansionRatio: volExp });
  const holdMinutes = primary.type === 'NxTGen Scalp' ? 12 : primary.type === 'Nova Scalp' ? 60 : primary.type === 'Range Scalp' ? 20 : 90; // scalp strategies are meant to resolve fast; used for funding-cost estimation

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
  // clear costs, just not by as much. Raised again, 0.15% -> 0.20%,
  // after the same measured 6-run backtest showed 0.15% still letting
  // through trades whose gross edge fees would erase in aggregate —
  // paired with the wider stop floors above, this demands a genuinely
  // wider margin above real costs before either scalp is approved at
  // all, not just a wider stop on the same thin edge.
  const minNetProfit = primary.type === 'NxTGen Scalp' ? (cfg.aiScalpMinNetProfitPct ?? 0.20)
    : primary.type === 'Nova Scalp' ? (cfg.novaScalpMinNetProfitPct ?? 0.20)
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
    singleTarget: !!levels.singleTarget, // Nova Scalp: whole position exits at one 2R target
    breakevenStopPrice: feeAdjustedBreakevenPrice({ entry: levels.entry, direction, entryFeePct, exitFeePct, spreadPct: snap.meta.spreadPct, slippagePct }),
    expectedGrossPct: levels.tp1Pct, estFeesPct: costs.entryFeePct + costs.exitFeePct,
    estSlippagePct: costs.slippageCostPct, estFundingPct: costs.fundingCostPct,
    expectedNetPct: costs.netTargetPct, riskReward: riskRewardRatio,
    liquidityScore: snap.meta.liquidityScore, regime: regime.regime,
    status: gate.allowed ? 'APPROVED' : 'REJECTED', rejectReasons: gate.reasons,
    execution, sizing, leverage, liqPrice: liqSafety.liqPrice,
    // TP hits are resting limit orders (maker); SL/time-stop exits need
    // guaranteed immediate execution (taker) — see netPnlForFraction's
    // comment for why the two are charged different fee rates once a
    // position is actually open. estFeesPct/costsBreakdown above stay
    // the conservative all-taker estimate used for pre-trade sizing and
    // the approval gate (unchanged) — this is only consulted afterward,
    // for the fee actually applied to a TP-closed slice.
    makerFeePct: feeLookup.makerPct,
    reasons: primary.reasons, costsBreakdown: costs,
  };
  row.explanation = buildExplanation({
    symbol, direction, confidence, setup: primary.type, regime: regime.regime,
    reasons: primary.reasons, netTargetPct: costs.netTargetPct, totalCostPct: costs.totalCostPct,
    riskRewardRatio, status: row.status, rejectReasons: gate.reasons,
  });
  return row;
}

// The Quant Futures pipeline: stop/target/score were already built by the
// signal engine (quant/signal.js); this applies costs, the Quant risk engine
// (drawdown-scaled risk, streak/daily pauses, correlation, margin), position
// sizing, and the platform's shared no-trade gate, then shapes the same row
// every other strategy produces. Entry is a taker fill at the slippage-adjusted
// price; the single target is a resting limit (maker); the stop is a stop-market
// (taker + slippage). No partials and no breakeven move — a partial would drag
// the realized RR below the configured floor, which the spec forbids.
function evaluateQuantRow(symbol, snap, regime, cfg, dayState, btcShock, nowMs, sig){
  const m = sig.meta;
  const qcfg = cfg.quant;
  const direction = sig.direction;
  const rejectFast = (msg) => baseRow(symbol, snap, regime, 'REJECTED', [msg]);
  if(!Number.isFinite(m.stopPrice) || !Number.isFinite(m.entryFill)) return rejectFast('Quant: stop loss could not be calculated');
  const rr = m.rewardRisk;
  if(!(rr >= 2 - 1e-9)) return rejectFast(`Quant: risk/reward 1:${(rr || 0).toFixed(2)} is below the 1:2 minimum`);

  const equity = dayState.equity;
  const startEq = dayState.startingEquity || equity;
  const riskState = computeQuantRiskState(dayState.quantTrades || [], startEq, nowMs, qcfg);
  const riskPct = effectiveRiskPct(qcfg, riskState, m.regime.riskMult);
  // Ceiling comes from whichever cfg built this (Paper leaves it unset and
  // gets RISK_DEFAULTS.maxLeverage=10; Live/Demo passes its own higher
  // maxLeverage — see LIVE_LEVERAGE_MAX_LEVERAGE in futures-ui.js/liveEngine.js)
  // rather than a number fixed here, so raising Live's cap can never also
  // raise what Paper allows.
  const leverage = clamp(cfg.leverage || RISK_DEFAULTS.defaultLeverage, 1, cfg.maxLeverage || RISK_DEFAULTS.maxLeverage);

  const feeLookup = (cfg.feeConfig || DEFAULT_FEE_CONFIG)[cfg.exchange || 'binance'] || DEFAULT_FEE_CONFIG.binance;
  const entryFeePct = feeLookup.takerPct, exitFeePct = feeLookup.takerPct;
  const stopDistancePct = m.stopDistPct;
  const tpPct = stopDistancePct * rr;
  const sign = direction === 'LONG' ? 1 : -1;
  const tp1 = m.entryFill * (1 + sign * tpPct / 100);
  const costs = estimateCosts({
    exchange: cfg.exchange || 'binance', execution: 'TAKER', grossTargetPct: tpPct,
    spreadPct: snap.meta.spreadPct, slippagePct: m.slipPct, fundingRatePct: snap.meta.fundingRatePct,
    holdMinutes: Math.round(m.holdMinutes / 2), feeConfig: cfg.feeConfig || DEFAULT_FEE_CONFIG,
  });
  const liqSafety = checkLiquidationSafety({ entryPrice: m.entryFill, stopPrice: m.stopPrice, side: direction, leverage });
  const sizing = quantSize({ equity, riskPct, entry: m.entryFill, stop: m.stopPrice, leverage, qcfg, contract: snap.meta && snap.meta.contract });
  const feeToStopRatioPct = stopDistancePct > 0 ? ((costs.entryFeePct + costs.exitFeePct) / stopDistancePct) * 100 : null;

  const gate = evaluateNoTradeFilters({
    snap, regime, confidence: m.score, minConfidence: m.minConfidenceUsed,
    netTargetPct: costs.netTargetPct, minNetProfitPct: cfg.minNetProfitPct ?? DEFAULT_MIN_NET_PROFIT_PCT,
    riskRewardRatio: rr, minRiskReward: 2.0 - 1e-9,
    liquidationSafety: liqSafety, dayState, btcShock, isAltcoin: symbol !== 'BTCUSDT',
    fundingCostPct: costs.fundingCostPct, grossTargetPct: tpPct,
    nowMs, riskPctPerTrade: riskPct, feeToStopRatioPct,
  });
  const quantReasons = quantEntryGate({ qcfg, state: riskState, dayState, direction, symbol, sizing, equity, meta: { spreadPct: snap.meta.spreadPct, atrPct: m.atrPct, entryTf: m.entryTf } });
  const reasons = [...gate.reasons, ...quantReasons];
  const approved = reasons.length === 0;

  const exitSlipPct = m.slipPct + snap.meta.spreadPct / 2;
  const row = {
    symbol, exchange: (cfg.exchange === 'gateio' ? 'GATE.IO' : (cfg.exchange || 'binance').toUpperCase()), direction,
    setup: QUANT_TYPE, confidence: m.score,
    entry: m.entryFill, stop: m.stopPrice, tp1, tp2: null, tp3: null,
    tpFractions: { tp1: 1, tp2: 0, tp3: 0 }, breakevenStopPrice: null, singleTp: true,
    rangeFilter: null,
    expectedGrossPct: tpPct, estFeesPct: costs.entryFeePct + costs.exitFeePct,
    estSlippagePct: costs.slippageCostPct, estFundingPct: costs.fundingCostPct,
    expectedNetPct: costs.netTargetPct, riskReward: rr,
    liquidityScore: snap.meta.liquidityScore, regime: m.regime.label,
    status: approved ? 'APPROVED' : 'REJECTED', rejectReasons: reasons,
    execution: 'TAKER', sizing, leverage, liqPrice: liqSafety.liqPrice,
    makerFeePct: feeLookup.makerPct, reasons: sig.reasons, costsBreakdown: costs,
    // Quant-specific
    quantMeta: m, riskPctUsed: riskPct, quantRiskState: riskState,
    quantExit: { exitSlipPct, timeStopMinutes: m.holdMinutes },
    quantLog: !!qcfg.log,
  };
  row.explanation = buildQuantExplanation(row);
  if(qcfg.log){
    const k = `${symbol}|${m.setup}|${direction}|${m.candleTime}`;
    if(approved) qlog(`${symbol} risk = ${riskPct.toFixed(2)}% ($${sizing ? sizing.riskAmountUsd.toFixed(2) : '—'}), tier ${riskState.tier}`);
    else qlog(`${symbol} ${direction} signal REJECTED by risk/filters: ${reasons.join('; ')}`, 'warn');
  }
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
    breakevenStopPrice: row.breakevenStopPrice, singleTarget: !!row.singleTarget,
    singleTp: !!row.singleTp, // Quant Futures: one fixed exit (managePositions' singleTp branch)
    qty, notionalUsd: row.sizing ? row.sizing.notionalUsd : 0,
    leverage: row.leverage, execution: row.execution,
    entryFeePct: row.costsBreakdown.entryFeePct, exitFeePct: row.costsBreakdown.exitFeePct,
    // The cheaper maker rate charged specifically when a TP level (not
    // SL/time-stop) is what closes the slice — see netPnlForFraction.
    // Falls back to the conservative taker estimate if a row somehow
    // doesn't carry it, so this can never be worse than the old behavior.
    tpExitFeePct: row.makerFeePct != null ? row.makerFeePct : row.costsBreakdown.exitFeePct,
    fundingRatePct: row.costsBreakdown.fundingCostPct > 0 ? row.costsBreakdown.fundingCostPct : 0,
    confidence: row.confidence, setup: row.setup, reasons: row.reasons, regime: row.regime,
    openedAt: mockMarket.now(), remainingFraction: 1, partialsTaken: [], status: 'OPEN',
  };
  position.riskAmountUsd = row.sizing ? row.sizing.riskAmountUsd : 0;
  if(row.quantMeta){
    const m = row.quantMeta;
    position.quant = {
      setup: m.setup, setupName: m.setupName, score: m.score, regime: m.regime.label, entryTf: m.entryTf,
      rewardRisk: m.rewardRisk, riskPctUsed: row.riskPctUsed, stopDistPct: m.stopDistPct, factors: m.factors,
      exitSlipPct: row.quantExit.exitSlipPct,
      entrySlipUsd: position.notionalUsd * (m.slipPct + m.spreadPct / 2) / 100,
      log: row.quantLog,
    };
    position.timeStopMinutes = row.quantExit.timeStopMinutes;
    position.tpLabel = `TAKE_PROFIT_${m.rewardRisk}R`;
    if(row.quantLog){
      qlog(`${row.symbol} order submitted: ${row.direction} qty ${position.qty.toPrecision(6)} @ ~${row.entry.toPrecision(7)} (paper)`);
      qlog(`${row.symbol} position opened (${m.setupName}, score ${m.score})`);
      qlog(`${row.symbol} stop loss set @ ${row.stop.toPrecision(7)} (${m.stopDistPct.toFixed(2)}%, ${m.stopBasis})`);
      qlog(`${row.symbol} take profit set @ ${row.tp1.toPrecision(7)} (1:${m.rewardRisk})`);
    }
  }
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

// isMakerExit: true when THIS slice closed via a TP level (a resting
// limit order — filled passively, at the maker rate), false for SL/
// time-stop/forced-close exits (need guaranteed execution regardless of
// price — a taker fill). Real exchanges charge meaningfully less for
// maker fills (e.g. Binance: 0.02% maker vs 0.05% taker — more than
// half), and TP hits are the majority of a healthy strategy's exits, so
// charging every exit at the taker rate (the old behavior — simpler,
// but a real overstatement) measurably inflated simulated/backtested
// fees relative to what real trading would actually pay. The
// conservative all-taker assumption is kept for pre-trade sizing and
// the approval gate (position.exitFeePct, costs.js, noTradeEngine.js's
// fee-to-stop-ratio cap) — deciding whether a setup clears real costs
// should stay worst-case. This only changes the fee actually realized
// once a position is open, and only for the slice that closed via TP.
export function netPnlForFraction(position, exitPrice, fraction, dayState, isMakerExit){
  const grossPct = ((exitPrice - position.entry) / position.entry) * 100 * (position.direction === 'LONG' ? 1 : -1);
  const exitFeePct = (isMakerExit && position.tpExitFeePct != null) ? position.tpExitFeePct : position.exitFeePct;
  const costPct = position.entryFeePct + exitFeePct + position.fundingRatePct;
  const netPct = grossPct - costPct;
  const notionalSlice = position.notionalUsd * fraction;
  return {
    grossUsd: (grossPct / 100) * notionalSlice,
    feesUsd: ((position.entryFeePct + exitFeePct) / 100) * notionalSlice,
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
    const timeStopMinutes = pos.quant ? pos.timeStopMinutes
      : pos.setup === 'NxTGen Scalp' ? (cfg.aiScalpTimeStopMinutes || 40)
      // Nova Scalp has NO time stop in Paper (removed on request): it exits only at its
      // structure stop or its single 2R target. Infinity makes the age check below never
      // fire; set cfg.novaScalpTimeStopMinutes to a number to bring one back.
      : pos.setup === 'Nova Scalp' ? (cfg.novaScalpTimeStopMinutes || Infinity)
      : pos.setup === 'Range Scalp' ? (cfg.scalpTimeStopMinutes || 45)
      : (cfg.timeStopMinutes || 240);

    let closedFraction = 0;
    const events = [];

    if(hitSL){
      // Quant: a stop-market fill slips against the position (other strategies keep their original fill-at-stop behavior).
      const slipPx = quantExitPrice(pos, pos.stop, 'STOP');
      const pnl = netPnlForFraction(pos, slipPx, pos.remainingFraction, dayState, false);
      closeTrade(pos, slipPx, pnl, 'STOP_LOSS', dayState, tradeHistory, undefined, pos.quant ? Math.abs(slipPx - pos.stop) / pos.entry * pos.notionalUsd * pos.remainingFraction : 0);
      setSymbolCooldown(dayState, pos.symbol);
      continue;
    }

    const tp1Fraction = pos.tpFractions ? pos.tpFractions.tp1 : 0.30;
    const tp2Fraction = pos.tpFractions ? pos.tpFractions.tp2 : 0.30;

    // Quant Futures: one fixed target (>= 1:2) for the whole position. No partials,
    // no breakeven move — a partial would drag the realized RR under the configured
    // floor. (Nova Scalp's own single 2R exit is the tp3-only path further down, and is
    // controlled by `singleTarget`, not this branch.) The time stop here is Quant's own
    // 6h/12h limit (pos.timeStopMinutes).
    if(pos.singleTp){
      if(hitTP(pos.tp1)){
        const pnl = netPnlForFraction(pos, pos.tp1, pos.remainingFraction, dayState, true);
        closeTrade(pos, pos.tp1, pnl, pos.tpLabel || 'TAKE_PROFIT_2R', dayState, tradeHistory, [pos.quant ? `Fixed ${pos.quant.rewardRisk}R target hit` : 'Fixed 2R target hit']);
        setSymbolCooldown(dayState, pos.symbol);
        continue;
      }
      if(ageMinutes > timeStopMinutes){
        const slipPx = quantExitPrice(pos, snap.price, 'MARKET');
        const pnl = netPnlForFraction(pos, slipPx, pos.remainingFraction, dayState, false);
        closeTrade(pos, slipPx, pnl, 'TIME_STOP', dayState, tradeHistory, events, pos.quant ? Math.abs(slipPx - snap.price) / pos.entry * pos.notionalUsd * pos.remainingFraction : 0);
        setSymbolCooldown(dayState, pos.symbol);
        continue;
      }
      pos.lastEvents = events;
      stillOpen.push(pos);
      continue;
    }

    if(tp1Fraction > 0 && !pos.partialsTaken.includes('tp1') && hitTP(pos.tp1)){
      const pnl = netPnlForFraction(pos, pos.tp1, tp1Fraction, dayState, true);
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

    if(tp2Fraction > 0 && pos.remainingFraction > 0 && !pos.partialsTaken.includes('tp2') && hitTP(pos.tp2)){
      const pnl = netPnlForFraction(pos, pos.tp2, tp2Fraction, dayState, true);
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
      const pnl = netPnlForFraction(pos, pos.tp3, pos.remainingFraction, dayState, true);
      closeTrade(pos, pos.tp3, pnl, 'TP3', dayState, tradeHistory, events);
      setSymbolCooldown(dayState, pos.symbol);
      continue;
    }

    if(pos.remainingFraction > 0 && ageMinutes > timeStopMinutes){
      const pnl = netPnlForFraction(pos, snap.price, pos.remainingFraction, dayState, false);
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

function closeTrade(pos, exitPrice, pnl, exitReason, dayState, tradeHistory, extraEvents, exitSlipUsd){
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
  // its final close — which for NxTGen Scalp is nearly every winning trade,
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

  if(pos.quant){
    // Quant's own ledger: risk state (drawdown tiers, streak pause, daily/weekly limits) replays from this.
    dayState.quantTrades = dayState.quantTrades || [];
    dayState.quantTrades.push({ closedAtMs: mockMarket.now(), netUsd: pos.finalNetUsd });
    dayState.slippageUsd = (dayState.slippageUsd || 0) + (pos.quant.entrySlipUsd || 0) + (exitSlipUsd || 0);
    if(pos.quant.log){
      qlog(`${pos.symbol} position closed @ ${exitPrice.toPrecision(7)} (${exitReason})`);
      qlog(`${pos.symbol} realized PnL = ${pos.finalNetUsd >= 0 ? '+' : ''}$${pos.finalNetUsd.toFixed(2)} (${pos.riskAmountUsd > 0 ? (pos.finalNetUsd / pos.riskAmountUsd).toFixed(2) : '—'}R, fees $${totalFeesUsd.toFixed(2)})`);
      qlog(`${pos.symbol} trade result: ${pos.finalNetUsd > 0 ? 'WIN' : 'LOSS'}`);
      qlog(`Strategy statistics updated (${dayState.quantTrades.length} Quant trade(s) this session)`);
    }
  }
  tradeHistory.unshift({
    timestamp: mockMarket.now(), exchange: pos.exchange, symbol: pos.symbol, direction: pos.direction,
    entry: pos.entry, exit: exitPrice, qty: pos.qty, leverage: pos.leverage,
    grossPnlUsd: totalGrossUsd, feesUsd: totalFeesUsd, fundingUsd: totalFundingUsd, netPnlUsd: pos.finalNetUsd,
    confidence: pos.confidence, strategy: pos.setup, reasonEntry: (pos.reasons || []).join('; '),
    reasonExit: exitReason, durationMin: Math.round((mockMarket.now() - pos.openedAt) / 60_000),
    ...quantTradeFields(pos, pos.finalNetUsd, exitSlipUsd),
  });
  if(tradeHistory.length > 200) tradeHistory.length = 200;
}
