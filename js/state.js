// =============================================================
// state.js — DOM element cache + mutable application state.
// This module is imported everywhere so all other modules share
// the same `els` references and the same `state` object. Because
// this is a module script (deferred by spec), it runs after the
// document has been parsed, so every getElementById call below
// resolves exactly as it did in the original inline <script>.
// =============================================================

// The verification proxy this deployment ships with by default (see
// /server). Baked in here so every device that loads the site gets working
// balance verification with zero setup — nobody has to find or type a proxy
// URL. This is intentionally NOT a secret (it's just a public HTTPS
// endpoint, same as any API base URL), so hardcoding it here is fine; the
// actual secrets (API key/secret) still never leave the browser except in
// the one signed verify call this proxy forwards.
export const DEFAULT_VERIFY_PROXY_URL = 'https://nxtgen-decrypt-2.onrender.com';

export const els = {
  exchange: document.getElementById('exchange'),
  anchor: document.getElementById('anchor'),
  fee: document.getElementById('fee'),
  cliMode: document.getElementById('cliMode'),
  minProfit: document.getElementById('minProfit'),
  minVolume: document.getElementById('minVolume'),
  scanInterval: document.getElementById('scanInterval'),
  scanBtn: document.getElementById('scanBtn'),
  liveBtn: document.getElementById('liveBtn'),
  results: document.getElementById('results'),
  messages: document.getElementById('messages'),
  closedStrip: document.getElementById('closedStrip'),
  statusDot: document.getElementById('statusDot'),
  statusText: document.getElementById('statusText'),
  lastUpdate: document.getElementById('lastUpdate'),
  statPairs: document.getElementById('statPairs'),
  statCycles: document.getElementById('statCycles'),
  statHits: document.getElementById('statHits'),
  tabTriBtn: document.getElementById('tabTriBtn'),
  tabXBtn: document.getElementById('tabXBtn'),
  panelTri: document.getElementById('panelTri'),
  panelX: document.getElementById('panelX'),
  xAmount: document.getElementById('xAmount'),
  xFee: document.getElementById('xFee'),
  xMinProfit: document.getElementById('xMinProfit'),
  xScanBtn: document.getElementById('xScanBtn'),
  xMessages: document.getElementById('xMessages'),
  xResults: document.getElementById('xResults'),
  xStatAssets: document.getElementById('xStatAssets'),
  xStatBest: document.getElementById('xStatBest'),
  xStatAvg: document.getElementById('xStatAvg'),
  // --- presentation-layer elements (dashboard, nav, badges) ---
  tabOverviewBtn: document.getElementById('tabOverviewBtn'),
  panelOverview: document.getElementById('panelOverview'),
  ovExchanges: document.getElementById('ovExchanges'),
  ovMarkets: document.getElementById('ovMarkets'),
  ovCycles: document.getElementById('ovCycles'),
  ovProfitable: document.getElementById('ovProfitable'),
  ovBest: document.getElementById('ovBest'),
  ovStatus: document.getElementById('ovStatus'),
  ovTriSummary: document.getElementById('ovTriSummary'),
  ovXSummary: document.getElementById('ovXSummary'),
  ovRunBtn: document.getElementById('ovRunBtn'),
  badgeBitget: document.getElementById('badgeBitget'),
  badgeBinance: document.getElementById('badgeBinance'),
  badgeBybit: document.getElementById('badgeBybit'),
  // --- Autotrade & Balances tab ---
  tabAutoBtn: document.getElementById('tabAutoBtn'),
  panelAuto: document.getElementById('panelAuto'),
  connectRows: document.getElementById('connectRows'),
  balanceRows: document.getElementById('balanceRows'),
  atExchange: document.getElementById('atExchange'),
  atProxyUrl: document.getElementById('atProxyUrl'),
  atModeRow: document.getElementById('atModeRow'),
  atModeLive: document.getElementById('atModeLive'),
  atModeTestnet: document.getElementById('atModeTestnet'),
  atModeDemo: document.getElementById('atModeDemo'),
  atAnchor: document.getElementById('atAnchor'),
  atFee: document.getElementById('atFee'),
  atMinVolume: document.getElementById('atMinVolume'),
  atMinProfit: document.getElementById('atMinProfit'),
  atDailyTarget: document.getElementById('atDailyTarget'),
  atInterval: document.getElementById('atInterval'),
  atStartBalance: document.getElementById('atStartBalance'),
  atToggleBtn: document.getElementById('atToggleBtn'),
  atMessages: document.getElementById('atMessages'),
  atStatDay: document.getElementById('atStatDay'),
  atStatBalance: document.getElementById('atStatBalance'),
  atStatProfitPct: document.getElementById('atStatProfitPct'),
  atStatProfitAmt: document.getElementById('atStatProfitAmt'),
  atStatCycles: document.getElementById('atStatCycles'),
  atProgressBar: document.getElementById('atProgressBar'),
  atProgressLabel: document.getElementById('atProgressLabel'),
  atCycleLog: document.getElementById('atCycleLog'),
};

// Single mutable state object. Every other module imports `state` and
// mutates its properties in place (never reassigns the binding itself),
// so live updates are visible across module boundaries.
export const state = {
  // Cache of the last successful per-exchange pairs fetch, so switching tabs
  // (or re-scanning cross-exchange) doesn't force a redundant round-trip.
  pairsCache: {}, // { bitget: [...], binance: [...], bybit: [...] }

  // ---- Live Scan state: mirrors main.py's `tracked` dict + NEW/OPEN/CLOSED lifecycle ----
  trackedCycles: new Map(), // canonicalKey -> { number, firstSeen }
  opportunityCounter: 0,
  isLive: false,
  liveTimer: null,
  scanInFlight: false,

  // Coin/network directory cache, keyed by exchange. Only Bitget exposes this
  // without authentication, so transfer-status detection is Bitget-anchored.
  coinNetworkCache: {},

  // Exchange badge + overview dashboard state, fed only by real scan results.
  exchangeState: { bitget:'idle', binance:'idle', bybit:'idle' },

  lastTri: null, // populated after each triangular scan from real results
  lastX: null,   // populated after each cross-exchange scan from real results

  // ---- Window: how long each gap has been visible across scans (client-side, this session) ----
  xFirstSeen: new Map(), // "base|quote|buyExch|sellExch" -> timestamp first observed

  // ---- Optional self-hosted verify proxy (see /server) — a plain URL,
  // not a secret, so it's fine to keep alongside the rest of this state.
  // Defaults to the deployment's own hosted proxy; not user-editable in the
  // UI (see autotrade.js) so every device gets working verification without
  // any setup. ----
  verifyProxyUrl: DEFAULT_VERIFY_PROXY_URL,

  // ---- Exchange "connections" — labels/status only. Keys are kept in the
  // browser's localStorage for this session's convenience and are never
  // sent anywhere by this app; nothing here places real orders. See
  // autotrade.js for the full explanation shown in the UI. Bitget only has
  // a `live` slot (no public spot testnet); Binance/Bybit have both. ----
  exchangeCreds: {
    bitget:  { live:null, testnet:null, demo:null },
    binance: { live:null, testnet:null, demo:null },
    bybit:   { live:null, testnet:null, demo:null },
  }, // each slot: { apiKey, connectedAt } — secret is stored but never rendered back

  // ---- Which network each exchange is currently set to. Bitget is always 'live'. ----
  exchangeMode: { bitget:'live', binance:'live', bybit:'live' },

  // ---- Manually-entered balances, per exchange+mode (spot only) ----
  balances: {
    bitget:  { live:null },
    binance: { live:null, testnet:null, demo:null },
    bybit:   { live:null, testnet:null, demo:null },
  },

  // ---- Autotrade (Triangular-only) simulation state ----
  autotrade: {
    enabled: false,
    running: false,
    exchange: 'bitget',
    mode: 'live',           // 'live' | 'testnet' | 'demo' — testnet/demo only meaningful for binance/bybit
    dateKey: null,          // local date string; a new day resets the counters below
    startingBalance: 0,
    currentBalance: 0,
    dayProfitPct: 0,
    dayProfitAmt: 0,
    targetReached: false,
    cycles: [],             // executed cycles today: {path, profitPct, profitAmt, balanceAfter, time}
    timer: null,
  },
};

export const EXCHANGE_BADGE_IDS = { bitget:'badgeBitget', binance:'badgeBinance', bybit:'badgeBybit' };
