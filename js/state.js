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
  tabTradingBtn: document.getElementById('tabTradingBtn'),
  tabKeysBtn: document.getElementById('tabKeysBtn'),
  panelKeys: document.getElementById('panelKeys'),
  goToKeysBtn: document.getElementById('goToKeysBtn'),
  panelTrading: document.getElementById('panelTrading'),
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
  xFilterMinVolume: document.getElementById('xFilterMinVolume'),
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
  atModeAutoBtn: document.getElementById('atModeAutoBtn'),
  atModeManualBtn: document.getElementById('atModeManualBtn'),
  atPendingCard: document.getElementById('atPendingCard'),
  atPendingDetail: document.getElementById('atPendingDetail'),
  atPendingExecuteBtn: document.getElementById('atPendingExecuteBtn'),
  atPendingDismissBtn: document.getElementById('atPendingDismissBtn'),
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
  fuStrategyRows: document.getElementById('fuStrategyRows'),
  fuGridPanel: document.getElementById('fuGridPanel'),
  fuStrategiesDetails: document.getElementById('fuStrategiesDetails'),
  fuStrategiesBadge: document.getElementById('fuStrategiesBadge'),
  fuStrategiesBest: document.getElementById('fuStrategiesBest'),
  fuTradingBotsDetails: document.getElementById('fuTradingBotsDetails'),
  fuTradingBotsBadge: document.getElementById('fuTradingBotsBadge'),
  fuTradingBotsCreate: document.getElementById('fuTradingBotsCreate'),
  fuTradingBotsList: document.getElementById('fuTradingBotsList'),
  fuLiveExchRows: document.getElementById('fuLiveExchRows'),
  fuLiveStatusLabel: document.getElementById('fuLiveStatusLabel'),
  fuLiveArmWrap: document.getElementById('fuLiveArmWrap'),
  fuLiveSwitch: document.getElementById('fuLiveSwitch'),
  fuLiveSwitchSub: document.getElementById('fuLiveSwitchSub'),
  fuLiveBalance: document.getElementById('fuLiveBalance'),
  fuLiveStartingBalance: document.getElementById('fuLiveStartingBalance'),
  fuLiveOpenPosition: document.getElementById('fuLiveOpenPosition'),
  fuLiveCloseRow: document.getElementById('fuLiveCloseRow'),
  fuLiveTrades: document.getElementById('fuLiveTrades'),
  fuLiveWinRate: document.getElementById('fuLiveWinRate'),
  fuLiveGrossPnl: document.getElementById('fuLiveGrossPnl'),
  fuLiveFees: document.getElementById('fuLiveFees'),
  fuLiveNetPnl: document.getElementById('fuLiveNetPnl'),
  fuLiveHistoryRows: document.getElementById('fuLiveHistoryRows'),
  // --- Trade Log (persistent, day/week/month/custom — see js/futures-ui.js) ---
  fuLogRangeToday: document.getElementById('fuLogRangeToday'),
  fuLogRangeWeek: document.getElementById('fuLogRangeWeek'),
  fuLogRangeMonth: document.getElementById('fuLogRangeMonth'),
  fuLogRangeAll: document.getElementById('fuLogRangeAll'),
  fuLogRangeCustom: document.getElementById('fuLogRangeCustom'),
  fuLogCustomRow: document.getElementById('fuLogCustomRow'),
  fuLogCustomFrom: document.getElementById('fuLogCustomFrom'),
  fuLogCustomTo: document.getElementById('fuLogCustomTo'),
  fuLogCustomApply: document.getElementById('fuLogCustomApply'),
  fuLogCount: document.getElementById('fuLogCount'),
  fuLogGross: document.getElementById('fuLogGross'),
  fuLogFees: document.getElementById('fuLogFees'),
  fuLogNet: document.getElementById('fuLogNet'),
  fuLogRows: document.getElementById('fuLogRows'),
  fuLogSelectAll: document.getElementById('fuLogSelectAll'),
  fuLogSelectedCount: document.getElementById('fuLogSelectedCount'),
  fuLogDeleteBtn: document.getElementById('fuLogDeleteBtn'),
  fuLogExportCsvBtn: document.getElementById('fuLogExportCsvBtn'),
  fuLogExportXlsBtn: document.getElementById('fuLogExportXlsBtn'),
  fuLogExportPdfBtn: document.getElementById('fuLogExportPdfBtn'),
  btExchange: document.getElementById('btExchange'),
  btRangePreset: document.getElementById('btRangePreset'),
  btCustomFromField: document.getElementById('btCustomFromField'),
  btCustomToField: document.getElementById('btCustomToField'),
  btCustomFrom: document.getElementById('btCustomFrom'),
  btCustomTo: document.getElementById('btCustomTo'),
  btStartingBalance: document.getElementById('btStartingBalance'),
  btRiskPct: document.getElementById('btRiskPct'),
  btLeverage: document.getElementById('btLeverage'),
  btMinConfidence: document.getElementById('btMinConfidence'),
  btMakerFee: document.getElementById('btMakerFee'),
  btTakerFee: document.getElementById('btTakerFee'),
  btSpreadPct: document.getElementById('btSpreadPct'),
  btFundingPct: document.getElementById('btFundingPct'),
  btMaxDailyLossPct: document.getElementById('btMaxDailyLossPct'),
  btDailyProfitTargetPct: document.getElementById('btDailyProfitTargetPct'),
  btSymbolChecks: document.getElementById('btSymbolChecks'),
  btSymbolsAllBtn: document.getElementById('btSymbolsAllBtn'),
  btSymbolsNoneBtn: document.getElementById('btSymbolsNoneBtn'),
  btStrategyChecks: document.getElementById('btStrategyChecks'),
  btGridParamsNote: document.getElementById('btGridParamsNote'),
  btRunBtn: document.getElementById('btRunBtn'),
  btProgress: document.getElementById('btProgress'),
  btMessages: document.getElementById('btMessages'),
  btResults: document.getElementById('btResults'),
  btrTrades: document.getElementById('btrTrades'),
  btrWinRate: document.getElementById('btrWinRate'),
  btrPF: document.getElementById('btrPF'),
  btrNet: document.getElementById('btrNet'),
  btrReturn: document.getElementById('btrReturn'),
  btrDD: document.getElementById('btrDD'),
  btrAvg: document.getElementById('btrAvg'),
  btrFees: document.getElementById('btrFees'),
  btEquityChart: document.getElementById('btEquityChart'),
  btByStrategy: document.getElementById('btByStrategy'),
  btExportCsvBtn: document.getElementById('btExportCsvBtn'),
  btExportXlsBtn: document.getElementById('btExportXlsBtn'),
  btExportPdfBtn: document.getElementById('btExportPdfBtn'),
  btTradeRows: document.getElementById('btTradeRows'),
  fuMinConfidence: document.getElementById('fuMinConfidence'),
  fuMinRR: document.getElementById('fuMinRR'),
  fuMinNetProfit: document.getElementById('fuMinNetProfit'),
  fuRiskPct: document.getElementById('fuRiskPct'),
  fuLiveRiskPct: document.getElementById('fuLiveRiskPct'),
  fuLiveDailyProfitTargetPct: document.getElementById('fuLiveDailyProfitTargetPct'),
  fuLiveMaxDailyLossPct: document.getElementById('fuLiveMaxDailyLossPct'),
  btTimeframe: document.getElementById('btTimeframe'),
  fuLiveTimeframe: document.getElementById('fuLiveTimeframe'),
  fuLiveModeAutoBtn: document.getElementById('fuLiveModeAutoBtn'),
  fuLiveModeManualBtn: document.getElementById('fuLiveModeManualBtn'),
  fuLivePendingCard: document.getElementById('fuLivePendingCard'),
  fuLivePendingDetail: document.getElementById('fuLivePendingDetail'),
  fuLivePendingExecuteBtn: document.getElementById('fuLivePendingExecuteBtn'),
  fuLivePendingDismissBtn: document.getElementById('fuLivePendingDismissBtn'),
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
  // --- AI Signal Provider (API Keys tab) ---
  aiProviderSelect: document.getElementById('aiProviderSelect'),
  aiApiKeyInput: document.getElementById('aiApiKeyInput'),
  aiKeyRevealBtn: document.getElementById('aiKeyRevealBtn'),
  aiSaveBtn: document.getElementById('aiSaveBtn'),
  aiTestBtn: document.getElementById('aiTestBtn'),
  aiRemoveBtn: document.getElementById('aiRemoveBtn'),
  aiEnabledToggle: document.getElementById('aiEnabledToggle'),
  aiStatusNote: document.getElementById('aiStatusNote'),
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
    tradeMode: 'auto',       // 'auto' | 'manual' — see tick() in autotrade.js
    pendingCycle: null,      // the latest qualifying cycle awaiting a manual Execute click, Manual mode only
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
    minConfidence: 70, // 60 was the floor of NxTGen Scalp's 60-87 confidence range — filtered nothing; see setups.js. 70 requires at least one real confirmation (RSI alignment, or strong momentum + volume together).
    minRiskReward: 2.0, // legacy fallback only now — see js/futures/setups.js STRATEGY_REGISTRY for the real, per-strategy ratios
    // Per-strategy enable/disable and reward:risk override — populated
    // from STRATEGY_REGISTRY's defaults by initStrategySelector() in
    // futures-ui.js on first load, then persisted to localStorage from
    // there. Empty objects here just mean "use each strategy's own
    // registry default" until that init runs.
    strategies: {}, strategyRR: {},
    minNetProfitPct: 0.30,
    riskPctPerTrade: 1.0,
    leverage: 5,
    dayState: null,           // built lazily by futures-ui.js: { equity, startingEquity, trades, wins, losses, ... , positions:[] }
    tradeHistory: [],
    // NxTGen Grid — Paper mode only (see js/futures/grid.js and the
    // "Enabled (Paper)" toggle in the Strategies panel's Grid config).
    // Entirely separate capital/session from dayState above, same way
    // Live/Demo below is separate — a grid deployment sizes itself as a
    // % of ITS OWN allocated equity, not a slice of whatever the
    // six-strategy ensemble happens to have open. Built lazily by
    // futures-ui.js's runGridPaperTick on first tick after being enabled.
    gridSession: null,
    gridTradeHistory: [],
    // NxTGen Grid — Live/Demo (Bybit/Binance only, single symbol at a
    // time — see js/futures-ui.js's runGridLiveCycle header comment for
    // why single-symbol is the deliberate starting scope). Entirely its
    // own arm/run state, separate from liveArmed/liveRunning below,
    // since it drives a completely different order-management model
    // (resting multi-level limit orders, not one market entry + bracket).
    gridLiveSymbol: 'BTCUSDT',
    // Auto-scan: cycles through GRID_SYMBOLS (the same watchlist Paper/
    // backtest use) looking for one that clears the Grid Score gate,
    // instead of being pinned to a single manually-picked pair — see
    // scanForGridLiveDeployment's header comment in futures-ui.js.
    // gridLiveScanCursor is the round-robin position so idle scanning
    // covers the whole watchlist a few symbols per cycle rather than
    // hammering every symbol's API calls at once. Turning autoScan off
    // falls back to the old single-symbol behavior (gridLiveSymbol only).
    gridLiveAutoScan: true,
    gridLiveScanCursor: 0,
    // Grid's own exchange choice for Live/Demo — deliberately separate
    // from liveExchange below (the six single-entry strategies' shared
    // selector). Grid only ever supports Bybit or Binance (see
    // GRID_LIVE_EXCHANGES in futures-ui.js), and picking one here no
    // longer requires switching the six strategies' Live/Demo exchange
    // away from whatever they're already trading on.
    gridLiveExchange: 'bybit',
    gridLiveArmed: false,
    gridLiveRunning: false,
    gridLiveTimer: null,
    gridLiveState: null,      // the single active deployment for gridLiveSymbol, or null — see runGridLiveCycle
    gridLiveTradeHistory: [],
    gridLiveDayAnchorEquity: null, gridLiveDailyHalted: false, gridLiveCurrentDayKey: null,
    // ---- Trading Bots (Futures Grid + DCA) — user-created, multi-
    // instance, Binance/Bybit Live/Demo only. Deliberately separate from
    // gridLive* above (NxTGen Grid's own auto-scanning single deployment)
    // — these are bots the person explicitly creates with their own
    // price range/investment/etc, mirroring a manual grid-bot or DCA-bot
    // creator, and several can run side by side. See futures-ui.js's
    // Trading Bots section for the create-flow and per-tick management.
    // Session-only, like gridLiveState — does not survive a reload, same
    // as every other Live/Demo runtime state in this app.
    tradingBots: [],       // { id, type:'grid'|'dca', exchange, mode, symbol, direction, investmentUsd, leverage, status, createdAtMs, config, plan, runtime, statusMessage, realizedUsd }
    tradingBotsTimer: null,
    tradingBotsRunning: false,
    // Cross-bot daily profit/loss cap — separate from any single bot's
    // own risk settings (DCA's stopLossPct, Grid's per-bot maxLossPct):
    // this tracks TOTAL realized P&L across every Trading Bot today
    // against the total capital committed to Trading Bots today, and
    // once either threshold hits, EVERY active bot is force-stopped and
    // no new one can be created until the next calendar day — no matter
    // what any individual bot's own state looks like. See
    // rollTradingBotsDay/checkTradingBotsDailyLimits in futures-ui.js.
    tbDailyProfitTargetPct: 20,
    tbDailyMaxLossPct: 10,
    tbDayAnchorInvestmentUsd: 0, // sum of investmentUsd for every bot created today
    tbDayRealizedUsd: 0,         // sum of realized P&L from every bot's closes today
    tbDayKey: null,
    tbDailyHalted: false,
    tbDailyHaltMessage: null,
    // Futures Grid Auto-Scan — watches GRID_SYMBOLS (the same watchlist
    // NxTGen Grid uses) and auto-creates new Trading Bots grid deployments
    // sized with tbAutoScanConfig's fixed investment/leverage the moment a
    // symbol clears Minimum Grid Score, up to maxConcurrent auto bots at
    // once. See toggleGridAutoScan/runGridAutoScan in futures-ui.js.
    tbAutoScanEnabled: false,
    tbAutoScanExchange: null,
    tbAutoScanConfig: null,
    tbAutoScanCursor: 0,
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
    // symbol -> timestamp (ms) until which re-entry on that symbol is
    // blocked, set on every close (TP/SL/manual) in runLiveCycle — see
    // buildLiveDayStateShim and noTradeEngine.js's SYMBOL_COOLDOWN_MINUTES.
    liveCooldownUntilBySymbol: {},
    liveTradeHistory: [],
    liveTrades: 0, liveWins: 0, liveLosses: 0, liveNetPnlUsd: 0, liveGrossPnlUsd: 0, liveFeesUsd: 0, liveStartingEquity: null,
    // Rolling real-performance tracking, used for the adaptive confidence/
    // circuit-breaker system — see js/futures-ui.js recordLiveTradeOutcome.
    // Every one of these resets with the rest of the session on any
    // exchange/network switch — an adaptive adjustment tuned against one
    // account's recent results has no business carrying over to a
    // different one.
    liveConsecutiveLosses: 0, livePausedByCircuitBreaker: false, liveAdaptiveConfidenceBoost: 0, liveAdaptiveConfidenceBoostAtMs: 0,
    liveTradeMode: 'auto', // 'auto' | 'manual' — see js/futures-ui.js runLiveCycle
    livePendingSignal: null, // the latest APPROVED row awaiting a manual Execute click, Manual mode only
  },

  // ---- AI Signal Provider (optional, experimental) — a second opinion
  // from a user-supplied LLM key, consulted only on Live/Demo signals the
  // AI Futures Engine's own scoring/risk/no-trade logic has ALREADY
  // approved (see js/ai-signal.js and server/server.js's /api/ai/confirm).
  // Persisted separately from exchangeCreds (own localStorage key, see
  // ai-signal.js) since it's a conceptually distinct credential, not an
  // exchange one. ----
  aiSignal: {
    provider: 'openai',   // 'openai' | 'anthropic' | 'google' | 'xai'
    apiKey: null,          // never rendered back in full; only ever sent to OUR OWN server per-check, which forwards it straight to the provider and keeps nothing
    enabled: false,
    lastVerdict: null,     // { ok, approve, confidence, reason, provider, symbol, at } — most recent check's result, for display
  },
};

export const EXCHANGE_BADGE_IDS = { bitget:'badgeBitget', binance:'badgeBinance', bybit:'badgeBybit', mexc:'badgeMexc', gateio:'badgeGateio' };
