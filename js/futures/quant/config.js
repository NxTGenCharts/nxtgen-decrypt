// =============================================================
// quant/config.js — NxTGen Quant Futures: identity, defaults, weights,
// selectivity tiers, and (localStorage-backed) user configuration.
//
// Everything tunable lives here so the detector, risk engine and UI all
// read ONE source of truth. sanitizeQuantConfig() is the only place raw
// (possibly stale/corrupt/hand-edited) config becomes trusted config —
// every field is clamped, so a bad saved value can never widen a risk
// limit past its hard ceiling.
// =============================================================

export const QUANT_ID = 'quantFutures';
export const QUANT_TYPE = 'NxTGen Quant Futures';
export const QUANT_CONFIG_KEY = 'nxtgen_quant_futures_config_v1';

// Minimum sample before ANY win rate is displayed as a number. Below it the
// UI shows INSUFFICIENT SAMPLE — a 3-for-3 start is not a 100% win rate.
export const MIN_SAMPLE_TRADES = 30;

// Hard ceilings that no saved config / UI value can exceed.
export const HARD_LIMITS = {
  minRewardRisk: 2,        // the system NEVER opens a trade below 1:2
  maxRiskPct: 1.0,         // per-trade risk ceiling (spec: "maximum configurable risk: 1%")
  minRiskPct: 0.1,
  maxPositions: 3,         // also the platform-wide RISK_DEFAULTS.maxSimultaneousPositions
  minConfidence: 60,
  maxConfidence: 95,
  maxLeverage: 10,
};

// Default score weights (sum to 100). Configurable; sanitize re-normalizes.
export const QUANT_WEIGHTS_DEFAULT = {
  trend: 20,       // trend alignment
  structure: 15,   // market-structure quality of the setup
  momentum: 15,
  volume: 10,      // volume + liquidity/spread
  volatility: 10,  // volatility-regime fit
  htf: 15,         // higher-timeframe alignment
  entry: 10,       // entry quality (extension, candle, stop sanity)
  rr: 5,           // room-to-target / cost-adjusted RR quality
};

// Selectivity tiers. `floor` raises the minimum confidence; the other two
// raise how much independent confluence is required on top of the score.
//   minCategories:   how many of the 6 confluence categories must pass
//                    (trend, structure, momentum, volume, htf, quality)
//   minConfirmations: how many of the 7 discrete confirmations must be true
export const SELECTIVITY = {
  off:      { label: 'Normal (>=70)',        floor: 0,  minCategories: 4, minConfirmations: 3 },
  high:     { label: 'High Selectivity (>=80)', floor: 80, minCategories: 5, minConfirmations: 5 },
  veryHigh: { label: 'Very High (>=85)',     floor: 85, minCategories: 6, minConfirmations: 6 },
};

export const QUANT_DEFAULTS = {
  entryTimeframe: '15m',        // '5m' | '15m'
  minConfidence: 70,            // 60-95
  selectivity: 'off',           // 'off' | 'high' | 'veryHigh'
  riskPct: 0.5,                 // % of equity risked per trade (before adaptive scaling)
  rewardRisk: 2,                // target R: 2 | 2.5 | 3 | 4
  adaptiveRR: false,            // allow one tier above rewardRisk on top-quality setups with room
  maxPositions: 3,              // 1-3
  dailyLossLimitPct: 2,
  weeklyLossLimitPct: 5,
  maxConsecutiveLosses: 3,
  cooldownMinutes: 240,         // pause after maxConsecutiveLosses
  ddTier1Pct: 3,                // drawdown >= this -> risk x0.70 (0.50% -> 0.35%)
  ddTier2Pct: 5,                // drawdown >= this -> risk x0.50 (0.50% -> 0.25%)
  ddPausePct: 8,                // drawdown >= this -> PAUSE new entries
  pauseResumeHours: 48,         // auto-resume (at tier-2 risk) this long after a drawdown pause
  allowLong: true,
  allowShort: true,
  symbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT'],
  setups: { A: true, B: true, C: true, D: true },
  useFunding: true,             // optional funding-rate confirmation when the feed provides it
  maxSpreadPct: 0.04,           // reject entries when spread is wider than this
  maxCorrelatedRiskMultiple: 2, // total same-direction open risk <= this x per-trade risk
  maxSymbolNotionalPct: 300,    // notional per symbol <= this % of equity
  maxHoldMinutes: { '5m': 360, '15m': 720 },
  weights: { ...QUANT_WEIGHTS_DEFAULT },
};

const num = (v, d) => (Number.isFinite(Number(v)) && v !== '' && v !== null ? Number(v) : d);
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const bool = (v, d) => (typeof v === 'boolean' ? v : d);

export function sanitizeQuantConfig(raw){
  const r = (raw && typeof raw === 'object') ? raw : {};
  const D = QUANT_DEFAULTS;
  const out = {};
  out.entryTimeframe = r.entryTimeframe === '5m' ? '5m' : (r.entryTimeframe === '15m' ? '15m' : D.entryTimeframe);
  out.minConfidence = clamp(Math.round(num(r.minConfidence, D.minConfidence)), HARD_LIMITS.minConfidence, HARD_LIMITS.maxConfidence);
  out.selectivity = Object.prototype.hasOwnProperty.call(SELECTIVITY, r.selectivity) ? r.selectivity : D.selectivity;
  out.riskPct = clamp(num(r.riskPct, D.riskPct), HARD_LIMITS.minRiskPct, HARD_LIMITS.maxRiskPct);
  out.rewardRisk = clamp(num(r.rewardRisk, D.rewardRisk), HARD_LIMITS.minRewardRisk, 4);
  out.adaptiveRR = bool(r.adaptiveRR, D.adaptiveRR);
  out.maxPositions = clamp(Math.round(num(r.maxPositions, D.maxPositions)), 1, HARD_LIMITS.maxPositions);
  out.dailyLossLimitPct = clamp(num(r.dailyLossLimitPct, D.dailyLossLimitPct), 0.25, 10);
  out.weeklyLossLimitPct = clamp(num(r.weeklyLossLimitPct, D.weeklyLossLimitPct), 0.5, 25);
  out.maxConsecutiveLosses = clamp(Math.round(num(r.maxConsecutiveLosses, D.maxConsecutiveLosses)), 2, 10);
  out.cooldownMinutes = clamp(Math.round(num(r.cooldownMinutes, D.cooldownMinutes)), 15, 7 * 24 * 60);
  out.ddTier1Pct = clamp(num(r.ddTier1Pct, D.ddTier1Pct), 1, 20);
  out.ddTier2Pct = clamp(num(r.ddTier2Pct, D.ddTier2Pct), out.ddTier1Pct, 30);
  out.ddPausePct = clamp(num(r.ddPausePct, D.ddPausePct), out.ddTier2Pct, 50);
  out.pauseResumeHours = clamp(num(r.pauseResumeHours, D.pauseResumeHours), 1, 24 * 14);
  out.allowLong = bool(r.allowLong, D.allowLong);
  out.allowShort = bool(r.allowShort, D.allowShort);
  const syms = Array.isArray(r.symbols) ? r.symbols : D.symbols;
  out.symbols = Array.from(new Set(syms.map(s => String(s).trim().toUpperCase()).filter(s => /^[A-Z0-9]{3,20}USDT$/.test(s)))).slice(0, 40);
  if(!out.symbols.length) out.symbols = D.symbols.slice();
  const su = (r.setups && typeof r.setups === 'object') ? r.setups : {};
  out.setups = { A: bool(su.A, true), B: bool(su.B, true), C: bool(su.C, true), D: bool(su.D, true) };
  out.useFunding = bool(r.useFunding, D.useFunding);
  out.maxSpreadPct = clamp(num(r.maxSpreadPct, D.maxSpreadPct), 0.005, 0.08);
  out.maxCorrelatedRiskMultiple = clamp(num(r.maxCorrelatedRiskMultiple, D.maxCorrelatedRiskMultiple), 1, 3);
  out.maxSymbolNotionalPct = clamp(num(r.maxSymbolNotionalPct, D.maxSymbolNotionalPct), 50, 1000);
  const mh = (r.maxHoldMinutes && typeof r.maxHoldMinutes === 'object') ? r.maxHoldMinutes : {};
  out.maxHoldMinutes = {
    '5m': clamp(Math.round(num(mh['5m'], D.maxHoldMinutes['5m'])), 30, 4320),
    '15m': clamp(Math.round(num(mh['15m'], D.maxHoldMinutes['15m'])), 60, 4320),
  };
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

// Which symbols does Quant Futures scan? User-configurable; TradFi/oddball
// symbols the platform permanently excludes stay excluded (engine.js).
export function quantSymbolSet(qcfg){
  return new Set((qcfg && qcfg.symbols) || QUANT_DEFAULTS.symbols);
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
