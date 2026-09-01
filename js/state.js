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
  resultsLimit: document.getElementById('resultsLimit'),
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
  xResultsLimit: document.getElementById('xResultsLimit'),
  xScanBtn: document.getElementById('xScanBtn'),
  xMessages: document.getElementById('xMessages'),
  xResults: document.getElementById('xResults'),
  xStatAssets: document.getElementById('xStatAssets'),
  xStatBest: document.getElementById('xStatBest'),
  xStatAvg: document.getElementById('xStatAvg'),
  xFiltersToggleBtn: document.getElementById('xFiltersToggleBtn'),
  xFiltersPanel: document.getElementById('xFiltersPanel'),
  xFiltersSummary: document.getElementById('xFiltersSummary'),
  xFilterLiquidity: document.getElementById('xFilterLiquidity'),
  xFilterWindow: document.getElementById('xFilterWindow'),
  xFilterQuote: document.getElementById('xFilterQuote'),
  xFilterDwVerified: document.getElementById('xFilterDwVerified'),
  xFilterExBitget: document.getElementById('xFilterExBitget'),
  xFilterExBinance: document.getElementById('xFilterExBinance'),
  xFilterExBybit: document.getElementById('xFilterExBybit'),
  xFilterExMexc: document.getElementById('xFilterExMexc'),
  xFilterExGateio: document.getElementById('xFilterExGateio'),
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
  badgeMexc: document.getElementById('badgeMexc'),
  badgeGateio: document.getElementById('badgeGateio'),
  // --- Autotrade & Balances tab ---
  tabAutoBtn: document.getElementById('tabAutoBtn'),
  panelAuto: document.getElementById('panelAuto'),
  connectRows: document.getElementById('connectRows'),
  balanceRows: document.getElementById('balanceRows'),
  atExchange: document.getElementById('atExchange'),
  atProxyUrl: document.getElementById('atProxyUrl'),
  atModeRow: document.getElementById('atModeRow'),
  atModeLive: document.getElementById('atModeLive'),
  atModeDemo: document.getElementById('atModeDemo'),
  atAnchor: document.getElementById('atAnchor'),
  atFee: document.getElementById('atFee'),
  atMinVolume: document.getElementById('atMinVolume'),
  atMinProfit: document.getElementById('atMinProfit'),
  atTestMode: document.getElementById('atTestMode'),
  atSpendPct: document.getElementById('atSpendPct'),
  atLiveExecution: document.getElementById('atLiveExecution'),
  atArmRow: document.getElementById('atArmRow'),
  atArmPhrase: document.getElementById('atArmPhrase'),
  atArmBtn: document.getElementById('atArmBtn'),
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
  // --- AI Futures Engine tab ---
  tabFuturesBtn: document.getElementById('tabFuturesBtn'),
  panelFutures: document.getElementById('panelFutures'),
  fuStatus: document.getElementById('fuStatus'),
  fuModeBtn: document.getElementById('fuModeBtn'),
  fuSelectivityToggle: document.getElementById('fuSelectivityToggle'),
  fuExchange: document.getElementById('fuExchange'),
  fuStartingBalance: document.getElementById('fuStartingBalance'),
  fuResetSessionBtn: document.getElementById('fuResetSessionBtn'),
  fuLiveExchRows: document.getElementById('fuLiveExchRows'),
  fuLiveStatusLabel: document.getElementById('fuLiveStatusLabel'),
  fuLiveArmWrap: document.getElementById('fuLiveArmWrap'),
  fuLiveConfirmCheck: document.getElementById('fuLiveConfirmCheck'),
  fuLiveConfirmLabel: document.getElementById('fuLiveConfirmLabel'),
  fuLiveArmRow: document.getElementById('fuLiveArmRow'),
  fuLiveArmPhrase: document.getElementById('fuLiveArmPhrase'),
  fuLiveArmBtn: document.getElementById('fuLiveArmBtn'),
  fuLiveToggleBtn: document.getElementById('fuLiveToggleBtn'),
  fuLiveBalance: document.getElementById('fuLiveBalance'),
  fuLiveOpenPosition: document.getElementById('fuLiveOpenPosition'),
  fuLiveTrades: document.getElementById('fuLiveTrades'),
  fuLiveNetPnl: document.getElementById('fuLiveNetPnl'),
  fuLiveHistoryRows: document.getElementById('fuLiveHistoryRows'),
  fuMinConfidence: document.getElementById('fuMinConfidence'),
  fuMinRR: document.getElementById('fuMinRR'),
  fuMinNetProfit: document.getElementById('fuMinNetProfit'),
  fuRiskPct: document.getElementById('fuRiskPct'),
  fuLeverage: document.getElementById('fuLeverage'),
  fuRegime: document.getElementById('fuRegime'),
  fuBalance: document.getElementById('fuBalance'),
  fuConfidenceAvg: document.getElementById('fuConfidenceAvg'),
  fuOpenPositions: document.getElementById('fuOpenPositions'),
  fuTradesToday: document.getElementById('fuTradesToday'),
  fuWins: document.getElementById('fuWins'),
  fuLosses: document.getElementById('fuLosses'),
  fuWinRate: document.getElementById('fuWinRate'),
  fuGrossPnl: document.getElementById('fuGrossPnl'),
  fuFees: document.getElementById('fuFees'),
  fuFunding: document.getElementById('fuFunding'),
  fuSlippage: document.getElementById('fuSlippage'),
  fuNetPnl: document.getElementById('fuNetPnl'),
  fuProfitFactor: document.getElementById('fuProfitFactor'),
  fuDailyDrawdown: document.getElementById('fuDailyDrawdown'),
  fuMaxDrawdown: document.getElementById('fuMaxDrawdown'),
  fuScannerRows: document.getElementById('fuScannerRows'),
  fuHistoryRows: document.getElementById('fuHistoryRows'),
  fuExplain: document.getElementById('fuExplain'),
  fuMessages: document.getElementById('fuMessages'),
};

// Single mutable state object. Every other module imports `state` and
// mutates its properties in place (never reassigns the binding itself),
// so live updates are visible across module boundaries.
export const state = {
  // Cache of the last successful per-exchange pairs fetch, so switching tabs
  // (or re-scanning cross-exchange) doesn't force a redundant round-trip.
  pairsCache: {}, // { bitget: [...], binance: [...], bybit: [...], mexc: [...], gateio: [...] }

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
  exchangeState: { bitget:'idle', binance:'idle', bybit:'idle', mexc:'idle', gateio:'idle' },

  lastTri: null, // populated after each triangular scan from real results
  lastX: null,   // populated after each cross-exchange scan from real results
  lastXScan: null, // { displaySet, amount, feePct } snapshot the Advanced Filters panel re-filters/re-renders without re-scanning

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
  // a `live` slot (no public Demo Trading environment); Binance/Bybit have both. ----
  exchangeCreds: {
    bitget:  { live:null, demo:null },
    binance: { live:null, demo:null },
    bybit:   { live:null, demo:null },
    mexc:    { live:null, demo:null },
    gateio:  { live:null, demo:null },
  }, // each slot: { apiKey, connectedAt } — secret is stored but never rendered back

  // ---- Which network each exchange is currently set to. Bitget, MEXC and
  // Gate.io have no public Demo Trading environment, so they're always 'live'. ----
  exchangeMode: { bitget:'live', binance:'live', bybit:'live', mexc:'live', gateio:'live' },

  // ---- Manually-entered balances, per exchange+mode (spot only) ----
  balances: {
    bitget:  { live:null },
    binance: { live:null, demo:null },
    bybit:   { live:null, demo:null },
    mexc:    { live:null },
    gateio:  { live:null },
  },

  // ---- Autotrade (Triangular-only) simulation state ----
  autotrade: {
    enabled: false,
    running: false,
    exchange: 'bitget',
    mode: 'live',           // 'live' | 'demo' — demo only meaningful for binance/bybit
    dateKey: null,          // local date string; a new day resets the counters below
    startingBalance: 0,
    currentBalance: 0,
    dayProfitPct: 0,
    dayProfitAmt: 0,
    targetReached: false,
    cycles: [],             // executed cycles today: {path, profitPct, profitAmt, balanceAfter, time}
    timer: null,
    testMode: false,        // when true, ignores the min-profit floor entirely and executes the
                             // best cycle found each scan regardless of profitability — for
                             // exercising the execute/log/balance-update path only, never for
                             // real decisions. See MIN_PROFIT_FLOOR in autotrade.js.
    liveExecution: false,   // when true (and armed), places real signed orders via /api/order
                             // instead of simulating. ALWAYS forced to false on page load and on
                             // any exchange/mode change — see restore() in autotrade.js. Never
                             // persisted as "on" across a refresh, on purpose.
    lastCanonicalKey: null,  // canonicalKey of the cycle executed on the previous tick — used to
    lastCanonicalStreak: 0,  // detect "stuck on the same pair" and break the streak (see tick()).
  },

  // ---- AI Futures Engine (PAPER MODE only — see js/futures/*.js) ----
  // Market data driving this is currently the synthetic generator in
  // js/futures/mockMarket.js (Phase 1: strategy/scoring/dashboard).
  // Wiring real Binance/Bybit USDT-M futures data is a separate phase;
  // nothing below assumes mock data specifically.
  futures: {
    running: false,
    timer: null,
    mode: 'PAPER',           // PAPER only for now — LIVE requires the backend/key-security work called out in the architecture assessment
    highSelectivity: false,
    exchange: 'binance',
    minConfidence: 60,
    minRiskReward: 1.2,
    minNetProfitPct: 0.30,
    riskPctPerTrade: 1.0,
    leverage: 2,
    dayState: null,           // built lazily by futures-ui.js: { equity, startingEquity, trades, wins, losses, ... , positions:[] }
    tradeHistory: [],
    lastRows: [],
    lastRegimeSummary: null,
    lastExplainIndex: null,
    // Live/Demo trading — entirely separate from the paper dayState above,
    // which keeps running unaffected regardless of any of this. Only one
    // exchange trades Live/Demo at a time; liveExchange picks which, and
    // liveModeByExchange remembers each exchange's own last-picked network
    // (so switching exchanges doesn't reset what you'd already set for one
    // you'd used before) — MEXC only ever holds 'live', it has no Demo API.
    liveExchange: 'bybit',
    liveModeByExchange: { bybit: 'live', binance: 'live', gateio: 'live', mexc: 'live', bitget: 'live' },
    liveArmed: false,       // resets to false on load and whenever the selected exchange/network changes
    liveRunning: false,
    liveTimer: null,
    livePositions: {},      // symbol -> { orderId, side, qty, entry, stopLossPrice, takeProfitPrice, leverage, openedAt }
    liveTradeHistory: [],
    liveTrades: 0, liveNetPnlUsd: 0, liveStartingEquity: null,
  },
};

export const EXCHANGE_BADGE_IDS = { bitget:'badgeBitget', binance:'badgeBinance', bybit:'badgeBybit', mexc:'badgeMexc', gateio:'badgeGateio' };
