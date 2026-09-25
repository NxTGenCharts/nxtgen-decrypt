// =============================================================
// htfConfluence/config.js — identity + tunable defaults for the
// "NxTGen HTF Confluence" strategy (Strategy #7). Mirrors the shape
// STRATEGY_REGISTRY expects (setups.js) and the sanitizer pattern this
// codebase already used for its previous self-contained strategy. No
// new exchange/risk/backtest engine here — every default below is
// consumed by htfConfluence/signal.js and engine.js's
// evaluateHtfConfluenceRow, which reuse the platform's existing
// cost/risk/gate machinery (positionSize, evaluateNoTradeFilters,
// estimateCosts, etc. — see engine.js).
//
// There is deliberately NO separate settings panel for this strategy,
// matching how the platform's previous self-contained strategy ended
// up wired: it reads the same shared "High Selectivity" toggle every
// other strategy uses (stricter confluence-score floor when it's on),
// the same shared exchange/leverage/risk-per-trade settings, and the
// same platform-wide excluded-symbols list (excludedSymbols.js) — see
// engine.js's evaluateSymbol, which rejects excluded symbols for every
// strategy before any detector even runs. Everything else below is a
// plain constant, meant to be tuned here in code rather than through a
// UI control.
//
// CURRENT LOGIC (rewritten — no order block, no PSAR):
//   1. Entry trigger: EMA50 crosses EMA100 on the 5M entry timeframe.
//      A crossover from below = Buy candidate, from above = Sell
//      candidate. Alignment alone (no fresh cross) does NOT fire —
//      see signal.js's crossedUp/crossedDown check.
//   2. Awesome Oscillator must already agree: AO > 0 for a Buy, AO < 0
//      for a Sell.
//   3. Trend filter: the 15M, 30M (aggregated from 15M) and 1H
//      timeframes must ALL show the same EMA50-vs-EMA100 relationship
//      as the crossover direction — this is what keeps a random 5M
//      whipsaw from firing against the higher-timeframe trend.
//   4. Price must be interacting with a valid HTF supply (Sell) or
//      demand (Buy) level — see structure.js's findZones.
// =============================================================

export const HTF_CONFLUENCE_ID = 'nxtgenHtfConfluence';
export const HTF_CONFLUENCE_TYPE = 'NxTGen HTF Confluence';

export const HTF_CONFLUENCE_DEFAULTS = {
  entryTimeframe: '5m',
  trendTimeframes: ['15m', '30m', '1h'], // must all agree with the 5M crossover direction — see signal.js
  emaFast: 50,
  emaSlow: 100,
  // Confluence score gate (0-100) — see signal.js's scoring breakdown.
  // These are targets to validate through backtesting, not guarantees.
  minConfluenceScore: 70,
  minConfluenceScoreHighSelectivity: 88, // used when cfg.highSelectivity is on — the platform's existing shared "stricter tier" toggle
  // Minimum reward:risk a trade must clear, measured against the actual
  // nearest opposing HTF supply/demand level — never fabricated to hit
  // this floor; a signal with a real R below this is rejected outright.
  minRewardRisk: 2.0,
  // Structure stop = far edge of the supply/demand zone, pushed out by
  // whichever of these is larger: a flat % buffer, or ATR(14) on the
  // 5M entry timeframe x this multiplier.
  structureBufferPct: 0.10,
  atrBufferMultiplier: 0.35,
  // A demand/supply zone older than this many bars (on its own
  // timeframe) still scores, but its freshness component drops toward
  // 0 well before this — see structure.js's findZones. This is a hard
  // cutoff for consideration at all, not the freshness curve.
  maxZoneAgeBars4h: 40,
  maxZoneAgeBars1h: 55,
  // This is a swing-style setup working off HTF supply/demand levels,
  // not a scalp — it's given hours, not minutes, to reach its
  // structure target before the platform's generic time-stop closes
  // it out.
  timeStopMinutes: 360,
};

export function sanitizeHtfConfluenceConfig(overrides){
  const cfg = { ...HTF_CONFLUENCE_DEFAULTS, ...(overrides || {}) };
  cfg.minRewardRisk = Math.max(HTF_CONFLUENCE_DEFAULTS.minRewardRisk, Number(cfg.minRewardRisk) || HTF_CONFLUENCE_DEFAULTS.minRewardRisk);
  return cfg;
}
