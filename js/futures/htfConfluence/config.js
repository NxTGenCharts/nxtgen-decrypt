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
// UI control, exactly like Nova Scalp's own constants in setups.js.
// =============================================================

export const HTF_CONFLUENCE_ID = 'nxtgenHtfConfluence';
export const HTF_CONFLUENCE_TYPE = 'NxTGen HTF Confluence';

// PSAR/EMA confirmation strictness — see signal.js's psarConfirmation().
// STRICT (default): the PSAR-vs-EMA-band relationship must genuinely
// flip on this bar. STANDARD: current bar just has to be on the right
// side, however long it's been there. EARLY: current bar merely isn't
// on the wrong side yet (may still be "inside" the band) — fires a bar
// or two sooner, at the cost of more false starts.
export const PSAR_MODES = ['STRICT', 'STANDARD', 'EARLY'];

export const HTF_CONFLUENCE_DEFAULTS = {
  entryTimeframe: '5m',
  htf1: '1h',
  htf2: '4h', // aggregated from H1 — see structure.js's aggregateH1ToH4; the platform doesn't fetch a native 4H feed
  emaFast: 50,
  emaSlow: 100,
  psarStep: 0.02,
  psarMaxStep: 0.2,
  psarConfirmationMode: 'STRICT',
  // Confluence score gate (0-100) — see signal.js's scoring breakdown.
  // These are targets to validate through backtesting, not guarantees —
  // see the strategy's description in STRATEGY_REGISTRY.
  minConfluenceScore: 70,
  minConfluenceScoreHighSelectivity: 88, // used when cfg.highSelectivity is on — the platform's existing shared "stricter tier" toggle
  // Minimum reward:risk a trade must clear, measured against the actual
  // nearest opposing HTF structure level — never fabricated to hit this
  // floor; a signal with a real R below this is rejected outright.
  minRewardRisk: 2.0,
  // Structure stop = far edge of the zone/order block, pushed out by
  // whichever of these is larger: a flat % buffer, or ATR(14) on the 5M
  // entry timeframe x this multiplier.
  structureBufferPct: 0.10,
  atrBufferMultiplier: 0.35,
  // A demand/supply zone or order block older than this many bars (on
  // its own timeframe) still scores, but its freshness component drops
  // toward 0 well before this — see structure.js's findZones. This is a
  // hard cutoff for consideration at all, not the freshness curve.
  maxZoneAgeBars4h: 40,
  maxZoneAgeBars1h: 55,
  // Swing-fractal confirmation window used for HH/HL/LH/LL structure —
  // see structure.js's classifyStructure.
  swingLeft: 2,
  swingRight: 2,
  // This is a swing-style setup working off 1H/4H structure, not a
  // scalp — it's given hours, not minutes, to reach its structure
  // target before the platform's generic time-stop closes it out.
  timeStopMinutes: 360,
};

export function sanitizeHtfConfluenceConfig(overrides){
  const cfg = { ...HTF_CONFLUENCE_DEFAULTS, ...(overrides || {}) };
  cfg.minRewardRisk = Math.max(HTF_CONFLUENCE_DEFAULTS.minRewardRisk, Number(cfg.minRewardRisk) || HTF_CONFLUENCE_DEFAULTS.minRewardRisk);
  cfg.psarConfirmationMode = PSAR_MODES.includes(cfg.psarConfirmationMode) ? cfg.psarConfirmationMode : 'STRICT';
  return cfg;
}
