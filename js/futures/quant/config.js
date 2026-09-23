// =============================================================
// quant/config.js — NxTGen HTF OrderFlow: identity, defaults, weights,
// selectivity tiers, and (localStorage-backed) user configuration.
//
// This module used to belong to "NxTGen HTF OrderFlow". That strategy has
// been REPLACED by NxTGen HTF OrderFlow (a high-selectivity multi-timeframe
// supply/demand + institutional order-block strategy — see setups.js and
// signal.js). The internal id (QUANT_ID = 'quantFutures') and every other
// export's NAME are kept unchanged on purpose, so the rest of the app
// (engine.js's self-contained risk/exit pipeline, risk.js, stats.js,
// diagnostics.js, the UI) keeps working without modification — only WHAT
// the strategy does, and its display name (QUANT_TYPE), changed. The saved
// config's localStorage key was bumped to a new version (see
// QUANT_CONFIG_KEY below) so an old "NxTGen HTF OrderFlow" config is never
// silently reinterpreted under the new strategy's very different schema —
// everyone starts from the new defaults.
//
// Everything tunable lives here so the detector, risk engine and UI all
// read ONE source of truth. sanitizeQuantConfig() is the only place raw
// (possibly stale/corrupt/hand-edited) config becomes trusted config —
// every field is clamped, so a bad saved value can never widen a risk
// limit past its hard ceiling.
// =============================================================

import { EXCLUDED_FUTURES_SYMBOLS } from '../excludedSymbols.js';

export const QUANT_ID = 'quantFutures'; // internal id — unchanged for backwards compatibility (saved strategy toggles, trade-log tags, etc.)
export const QUANT_TYPE = 'NxTGen HTF OrderFlow';
export const QUANT_CONFIG_KEY = 'nxtgen_htf_orderflow_config_v1'; // new key — an old Quant Futures config must never be reinterpreted under this schema

// Minimum sample before ANY win rate is displayed as a number. Below it the
// UI shows INSUFFICIENT SAMPLE — a 3-for-3 start is not a 100% win rate.
export const MIN_SAMPLE_TRADES = 30;

// Hard ceilings that no saved config / UI value can exceed.
export const HARD_LIMITS = {
  minRewardRisk: 2.0,       // spec: "the system must never open a trade below 1:2" — real, non-negotiable floor.
  maxRiskPct: 1.0,          // per-trade risk ceiling (spec: "maximum configurable risk: 1%")
  minRiskPct: 0.1,
  maxPositions: 3,          // also the platform-wide RISK_DEFAULTS.maxSimultaneousPositions
  minConfidence: 60,
  maxConfidence: 95,
  maxLeverage: 50,          // an outer safety ceiling only — engine.js already clamps the leverage it
                             // passes in per-mode (10 for Paper, up to 50 for Live/Demo) before quantSize()
                             // ever sees it, so this rarely binds; it exists so quantSize() is never handed
                             // an unbounded number if called from anywhere that skips that outer clamp.
  minAoThreshold: 0.5,
  maxAoThreshold: 20,
  minZoneToleranceAtr: 0.2,
  maxZoneToleranceAtr: 1.5,
  minEntryAtr: 0.25,
  maxEntryAtr: 2.0,
  minSlBufferAtr: 0.05,
  maxSlBufferAtr: 0.5,
};

// Default 0-100 confluence-score weights — the "CONFLUENCE ENGINE" from the
// spec. Every field maps 1:1 to a scored factor in signal.js. Configurable;
// sanitize re-normalizes to sum 100 so a hand-edited set can't silently
// change the scale.
export const QUANT_WEIGHTS_DEFAULT = {
  h4: 20,            // 4H trend alignment
  h1: 15,             // 1H trend alignment
  m30: 10,           // 30M structure quality
  supplyDemand: 15,  // HTF supply/demand zone quality
  orderBlock: 15,    // HTF order-block confluence (how many timeframes agree)
  emaAlign: 5,       // 5M EMA 50/100 alignment
  psar: 10,          // 5M PSAR crossover quality
  ao: 5,             // 5M Awesome Oscillator confirmation
  proximity: 5,      // entry-zone proximity (anti-chasing)
};

// Selectivity tiers. `floor` raises the minimum confluence score; the other
// two raise how much independent agreement is required on top of the score.
//   minCategories:    how many of the 6 confluence categories must pass
//                     (htf, structure, orderBlock, momentum, location, quality)
//   minConfirmations: how many of the discrete mandatory confirmations must be true
export const SELECTIVITY = {
  off:      { label: 'Normal (>=80)',        floor: 0,  minCategories: 5, minConfirmations: 6 },
  high:     { label: 'High Selectivity (>=85)', floor: 85, minCategories: 6, minConfirmations: 7 },
  veryHigh: { label: 'Very High (>=90)',     floor: 90, minCategories: 6, minConfirmations: 8 },
};

export const QUANT_DEFAULTS = {
  entryTimeframe: '5m',         // spec: 5M is the ONLY entry timeframe. Field kept (rather than removed) so
                                 // code elsewhere that reads qcfg.entryTimeframe keeps working; sanitize always
                                 // forces it back to '5m' regardless of what is saved/passed in.
  minConfidence: 80,            // spec: "Default minimum entry score: 80/100"
  selectivity: 'off',           // the 80 floor above already matches the spec default; 'high'/'veryHigh' raise
                                 // it further (85/90) for someone who wants fewer, even more selective trades.
  riskPct: 0.5,                 // spec: "Default: 0.5% account risk per trade"
  rewardRisk: 2,                 // spec: "Default minimum: 1:2 Risk:Reward"
  rewardRiskOptions: [2, 2.5, 3], // spec: "Preferred configurable targets: 1:2, 1:2.5, 1:3"
  adaptiveRR: false,             // when true, a high-score (85+) setup with enough clearance may target the
                                 // next tier up (2.5R, then 3R) instead of the base rewardRisk — off by default,
                                 // matching "Default should favor letting winners reach the intended RR".
  maxPositions: 2,               // spec: "Maximum simultaneous correlated positions... Default = 1-2"
  dailyLossLimitPct: 2,
  weeklyLossLimitPct: 5,
  maxConsecutiveLosses: 2,       // spec: cooldown "after a losing trade" — 2 losses in a row (not 3) triggers it,
                                 // since this strategy already targets very few, high-quality trades.
  cooldownMinutes: 180,          // spec: "Require a configurable cooldown period before another trade"
  ddTier1Pct: 3,                 // drawdown >= this -> risk x0.70 (0.50% -> 0.35%)
  ddTier2Pct: 5,                 // drawdown >= this -> risk x0.50 (0.50% -> 0.25%)
  ddPausePct: 8,                 // drawdown >= this -> PAUSE new entries
  pauseResumeHours: 48,          // auto-resume (at tier-2 risk) this long after a drawdown pause
  allowLong: true,
  allowShort: true,
  // null = "every USDT perpetual the current mode scans, except the platform-wide excluded list
  // (excludedSymbols.js: BTC/ETH/SOL/LTC/DOGE/BNB/CL)". With a `symbolFilter` it is exactly that list.
  symbolFilter: null,
  // Only one setup is implemented now (HTF OrderFlow, key 'A'). B/C/D are kept in the schema (always false,
  // no detector registered for them) purely so old sweep/validation tooling that iterates this shape doesn't
  // break — they do nothing either way. There is no UI for turning them on.
  setups: { A: true, B: false, C: false, D: false },
  useFunding: true,              // optional bonus confirmation when the feed provides it (not part of the
                                 // mandatory gate chain — purely an extra scoring nudge, same as before)
  maxSpreadPct: 0.04,            // part of the market-regime "poor liquidity / excessive spread" filter
  maxCorrelatedRiskMultiple: 2,  // total same-direction open risk <= this x per-trade risk (implements the
                                 // spec's "maximum simultaneous correlated positions" as a risk cap, not just a count)
  maxSymbolNotionalPct: 300,     // notional per symbol <= this % of equity
  maxHoldMinutes: { '5m': 360 }, // time-stop — entry timeframe is always 5m now
  // Round-trip cost (fees+spread+slippage) as a fraction of stop distance, in R. A tight stop makes fixed
  // costs a big slice of every 1R; trades whose cost/R is above this are skipped. 1 = filter off.
  maxCostR: 0.18,
  // Stop-distance floor in ATR — a structural stop tighter than this is treated as noise, not a real level,
  // and the trade is rejected (the spec's own SL buffer, below, is layered on top of the structural stop).
  minStopAtr: 0.8,
  weights: { ...QUANT_WEIGHTS_DEFAULT },

  // ---- HTF OrderFlow-specific parameters (spec: "DEFAULT PARAMETERS") ----
  htfTimeframes: ['30m', '1h', '4h'], // HTF 1 / HTF 2 / HTF 3
  emaFast: 50,                    // EMA Fast
  emaSlow: 100,                   // EMA Slow
  psarStep: 0.02,                 // PSAR acceleration step
  psarMaxStep: 0.2,               // PSAR acceleration cap
  aoLongThreshold: 3,             // AO Long Threshold (default +3)
  aoShortThreshold: -3,           // AO Short Threshold (default -3)
  aoNormalized: false,            // optional ATR-normalized AO mode (spec: "so the strategy can behave
                                  // consistently across BTC, ETH and other futures contracts") — when true,
                                  // the +3/-3 thresholds are read in normalized units instead of raw AO.
  maxEntryAtr: 0.75,              // Maximum Entry Distance (spec: "0.5-1.0 x 5M ATR") — anti-chasing filter
  slBufferAtr: 0.15,              // SL buffer (spec: "0.1-0.25 x 5M ATR")
  zoneToleranceAtr: 0.75,         // ATR-based proximity tolerance used to decide whether 30M/1H/4H order
                                  // blocks / supply-demand zones "overlap" for HTF confluence
  preferBreakoutRetest: true,     // spec: "Prefer this setup when available" — a bonus to score/evidence,
                                  // never a hard requirement (a fresh reaction off the zone is still valid)
  useBreakEven: false,            // Trade-management toggles (spec: "Implement... Optional break-even /
  usePartialTp: false,            // Optional partial take profit / Optional trailing stop"). NOTE: the
  useTrailingStop: false,         // Futures Engine's Quant-flagged positions currently use ONE fixed
                                  // stop/target exit end-to-end (see engine.js's "Quant Futures: one fixed
                                  // exit" branch) — these three switches are exposed in config/UI as
                                  // requested, but do not yet change how a live/paper position is managed;
                                  // implementing partial exits/trailing there is a larger, separate change to
                                  // the shared position-management code and was intentionally left alone in
                                  // this pass rather than risk destabilizing every other strategy's exits.
};

const SYMBOL_RE = /^[^\s]{1,30}USDT$/u; // any listed USDT perpetual (incl. 1000PEPEUSDT and non-ASCII new listings)
const num = (v, d) => (Number.isFinite(Number(v)) && v !== '' && v !== null ? Number(v) : d);
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const bool = (v, d) => (typeof v === 'boolean' ? v : d);

export function sanitizeQuantConfig(raw){
  const r = (raw && typeof raw === 'object') ? raw : {};
  const D = QUANT_DEFAULTS;
  const out = {};
  out.entryTimeframe = '5m'; // spec: 5M is the ONLY entry timeframe — never configurable, whatever is saved/passed.
  out.minConfidence = clamp(Math.round(num(r.minConfidence, D.minConfidence)), HARD_LIMITS.minConfidence, HARD_LIMITS.maxConfidence);
  out.selectivity = Object.prototype.hasOwnProperty.call(SELECTIVITY, r.selectivity) ? r.selectivity : D.selectivity;
  out.riskPct = clamp(num(r.riskPct, D.riskPct), HARD_LIMITS.minRiskPct, HARD_LIMITS.maxRiskPct);
  out.rewardRisk = clamp(num(r.rewardRisk, D.rewardRisk), HARD_LIMITS.minRewardRisk, 4);
  out.rewardRiskOptions = Array.isArray(r.rewardRiskOptions) && r.rewardRiskOptions.length
    ? Array.from(new Set(r.rewardRiskOptions.map(v => clamp(num(v, 2), HARD_LIMITS.minRewardRisk, 4)))).sort((a, b) => a - b)
    : D.rewardRiskOptions.slice();
  out.adaptiveRR = bool(r.adaptiveRR, D.adaptiveRR);
  out.maxPositions = clamp(Math.round(num(r.maxPositions, D.maxPositions)), 1, HARD_LIMITS.maxPositions);
  out.dailyLossLimitPct = clamp(num(r.dailyLossLimitPct, D.dailyLossLimitPct), 0.25, 10);
  out.weeklyLossLimitPct = clamp(num(r.weeklyLossLimitPct, D.weeklyLossLimitPct), 0.5, 25);
  out.maxConsecutiveLosses = clamp(Math.round(num(r.maxConsecutiveLosses, D.maxConsecutiveLosses)), 1, 10);
  out.cooldownMinutes = clamp(Math.round(num(r.cooldownMinutes, D.cooldownMinutes)), 15, 7 * 24 * 60);
  out.ddTier1Pct = clamp(num(r.ddTier1Pct, D.ddTier1Pct), 1, 20);
  out.ddTier2Pct = clamp(num(r.ddTier2Pct, D.ddTier2Pct), out.ddTier1Pct, 30);
  out.ddPausePct = clamp(num(r.ddPausePct, D.ddPausePct), out.ddTier2Pct, 50);
  out.pauseResumeHours = clamp(num(r.pauseResumeHours, D.pauseResumeHours), 1, 24 * 14);
  out.allowLong = bool(r.allowLong, D.allowLong);
  out.allowShort = bool(r.allowShort, D.allowShort);
  // Optional hand-picked restriction (see QUANT_DEFAULTS.symbolFilter). Excluded pairs are stripped either way.
  if(Array.isArray(r.symbolFilter)){
    const f = Array.from(new Set(r.symbolFilter.map(x => String(x).trim().toUpperCase()).filter(x => SYMBOL_RE.test(x) && !EXCLUDED_FUTURES_SYMBOLS.has(x))));
    out.symbolFilter = f.length ? f : null; // an empty / all-excluded list means "no restriction", not "trade nothing"
  } else out.symbolFilter = null;
  const su = (r.setups && typeof r.setups === 'object') ? r.setups : {};
  // Only 'A' (HTF OrderFlow) has a detector; B/C/D are always false — see the QUANT_DEFAULTS.setups comment.
  out.setups = { A: bool(su.A, D.setups.A), B: false, C: false, D: false };
  out.maxCostR = clamp(num(r.maxCostR, D.maxCostR), 0.05, 1);
  out.minStopAtr = clamp(num(r.minStopAtr, D.minStopAtr), 0.3, 2.5);
  out.useFunding = bool(r.useFunding, D.useFunding);
  out.maxSpreadPct = clamp(num(r.maxSpreadPct, D.maxSpreadPct), 0.005, 0.08);
  out.maxCorrelatedRiskMultiple = clamp(num(r.maxCorrelatedRiskMultiple, D.maxCorrelatedRiskMultiple), 1, 3);
  out.maxSymbolNotionalPct = clamp(num(r.maxSymbolNotionalPct, D.maxSymbolNotionalPct), 50, 1000);
  const mh = (r.maxHoldMinutes && typeof r.maxHoldMinutes === 'object') ? r.maxHoldMinutes : {};
  out.maxHoldMinutes = { '5m': clamp(Math.round(num(mh['5m'], D.maxHoldMinutes['5m'])), 30, 4320) };

  // ---- HTF OrderFlow-specific ----
  out.htfTimeframes = D.htfTimeframes.slice(); // fixed — 30M/1H/4H is the architecture, not a user choice
  out.emaFast = clamp(Math.round(num(r.emaFast, D.emaFast)), 10, 100);
  out.emaSlow = clamp(Math.round(num(r.emaSlow, D.emaSlow)), out.emaFast + 5, 300);
  out.psarStep = clamp(num(r.psarStep, D.psarStep), 0.005, 0.05);
  out.psarMaxStep = clamp(num(r.psarMaxStep, D.psarMaxStep), out.psarStep, 0.5);
  out.aoLongThreshold = clamp(num(r.aoLongThreshold, D.aoLongThreshold), HARD_LIMITS.minAoThreshold, HARD_LIMITS.maxAoThreshold);
  out.aoShortThreshold = -clamp(num(r.aoShortThreshold != null ? Math.abs(r.aoShortThreshold) : Math.abs(D.aoShortThreshold), Math.abs(D.aoShortThreshold)), HARD_LIMITS.minAoThreshold, HARD_LIMITS.maxAoThreshold);
  out.aoNormalized = bool(r.aoNormalized, D.aoNormalized);
  out.maxEntryAtr = clamp(num(r.maxEntryAtr, D.maxEntryAtr), HARD_LIMITS.minEntryAtr, HARD_LIMITS.maxEntryAtr);
  out.slBufferAtr = clamp(num(r.slBufferAtr, D.slBufferAtr), HARD_LIMITS.minSlBufferAtr, HARD_LIMITS.maxSlBufferAtr);
  out.zoneToleranceAtr = clamp(num(r.zoneToleranceAtr, D.zoneToleranceAtr), HARD_LIMITS.minZoneToleranceAtr, HARD_LIMITS.maxZoneToleranceAtr);
  out.preferBreakoutRetest = bool(r.preferBreakoutRetest, D.preferBreakoutRetest);
  out.useBreakEven = bool(r.useBreakEven, D.useBreakEven);
  out.usePartialTp = bool(r.usePartialTp, D.usePartialTp);
  out.useTrailingStop = bool(r.useTrailingStop, D.useTrailingStop);

  // Weights: keep only known keys, non-negative, then renormalize to sum 100
  // so a hand-edited weight set can't silently change the 0-100 scale.
  const w = {};
  let total = 0;
  for(const k of Object.keys(QUANT_WEIGHTS_DEFAULT)){
    const v = Math.max(0, num(r.weights && r.weights[k], QUANT_WEIGHTS_DEFAULT[k]));
    w[k] = v; total += v;
  }
  if(!(total > 0)){ Object.assign(w, QUANT_WEIGHTS_DEFAULT); total = 100; }
  for(const k of Object.keys(w)) w[k] = (w[k] / total) * 100;
  out.weights = w;
  return out;
}

// Effective minimum confidence: the user's floor, raised by the selectivity tier.
export function effectiveMinConfidence(qcfg){
  const tier = SELECTIVITY[qcfg.selectivity] || SELECTIVITY.off;
  return Math.max(qcfg.minConfidence, tier.floor);
}

// Which symbols does HTF OrderFlow trade? By default every non-excluded USDT perpetual (`has()` answers for any
// symbol name, iteration is empty because there is nothing to ADD to a scan list — the mode's own watchlist is
// used). With a `symbolFilter` it is exactly that list. The platform's permanently excluded pairs
// (excludedSymbols.js) are never in it, even if an old saved config or a hand-built cfg lists them.
class AnySymbolSet extends Set {
  has(sym){ return typeof sym === 'string' && SYMBOL_RE.test(sym) && !EXCLUDED_FUTURES_SYMBOLS.has(sym); }
}
const ANY_SYMBOL = new AnySymbolSet();
export function quantSymbolSet(qcfg){
  const list = qcfg && Array.isArray(qcfg.symbolFilter) ? qcfg.symbolFilter.filter(s => !EXCLUDED_FUTURES_SYMBOLS.has(s)) : null;
  return list && list.length ? new Set(list) : ANY_SYMBOL;
}

// Symbols the user typed that the platform excludes (for the UI to tell them, not fail silently).
export function excludedSymbolsIn(list){
  return Array.from(new Set((list || []).map(s => String(s).trim().toUpperCase()).filter(s => EXCLUDED_FUTURES_SYMBOLS.has(s))));
}

export function loadQuantConfig(){
  try{
    const raw = (typeof localStorage !== 'undefined') ? localStorage.getItem(QUANT_CONFIG_KEY) : null;
    return sanitizeQuantConfig(raw ? JSON.parse(raw) : null);
  }catch(e){ return sanitizeQuantConfig(null); }
}

export function saveQuantConfig(qcfg){
  try{ localStorage.setItem(QUANT_CONFIG_KEY, JSON.stringify(sanitizeQuantConfig(qcfg))); }
  catch(e){ /* non-fatal — config just won't survive a reload */ }
}
