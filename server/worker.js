// =============================================================
// worker.js — the always-on Live/Demo trading loop, running IN this
// server process instead of a browser tab.
//
// This now calls js/futures/liveEngine.js directly — the SAME module
// js/futures-ui.js calls for the browser's own Auto-mode loop — rather
// than a separate hand-written copy of that orchestration. Only what's
// genuinely different between a browser tab and this process lives here:
// the Node "adapter" (loopback HTTP calls into this server's own
// /api/futures/* routes instead of DOM/localStorage) and the arm/disarm
// HTTP surface. Auto mode only — Manual mode's click-to-execute step is
// a UI concept with no server equivalent.
//
// `session` uses the exact same field names js/state.js's state.futures
// object does (liveArmed, liveExchange, livePositions, ...) — that's
// what lets liveEngine.js's functions operate on it identically to how
// they operate on the browser's own state object.
//
// Credentials live in memory only, exactly like the rest of this proxy
// (see server/README.md) — never written to disk. A process restart
// clears the armed session; nothing re-arms itself.
// =============================================================
import {
  ARM_PHRASE, LIVE_CYCLE_MS, LIVE_TRADEABLE_EXCHANGES, LIVE_ONLY_EXCHANGES,
  runLiveCycleInner, getTradeableSymbols,
} from '../js/futures/liveEngine.js';
import { RISK_DEFAULTS } from '../js/futures/risk.js';
import { sanitizeQuantConfig, QUANT_DEFAULTS } from '../js/futures/quant/config.js';

export { ARM_PHRASE };

const MAX_LOG_LINES = 300;

let session = null;    // null when disarmed; see armSession() for shape
let timer = null;
let cycleInFlight = false;
let selfBaseUrl = 'http://127.0.0.1:8787';

function log(msg, kind){
  if(!session) return;
  session.logs.push({ ts: Date.now(), msg: String(msg), kind: kind || 'info' });
  if(session.logs.length > MAX_LOG_LINES) session.logs.splice(0, session.logs.length - MAX_LOG_LINES);
  session.lastMessage = String(msg);
  session.lastMessageKind = kind || 'info';
  console.log(`[worker] ${msg}`);
}

// The Node adapter liveEngine.js's shared functions run against — see
// the "adapter shape" comment at the top of liveEngine.js for what each
// of these is for. Only proxyCall/fetchSnapshot/getCred are required;
// everything else here is this process's (mostly log-only) version of
// what the browser adapter in futures-ui.js does with the DOM.
const adapter = {
  async proxyCall(path, body){
    const res = await fetch(selfBaseUrl + path, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}),
    });
    const data = await res.json().catch(() => null);
    if(!data) throw new Error('Internal call to ' + path + ' returned an unreadable response.');
    return data;
  },
  async fetchSnapshot(exchange, symbol, timeframe){
    const tf = timeframe || '5m';
    const res = await fetch(`${selfBaseUrl}/api/futures/snapshot?exchange=${exchange}&symbol=${symbol}&interval=${tf}`);
    const data = await res.json().catch(() => null);
    if(!data || !data.ok) throw new Error((data && data.message) || 'Snapshot fetch failed.');
    return data.snapshot;
  },
  getCred(exchange, mode){
    if(!session || !session.cred) return null;
    if(exchange !== session.exchange || mode !== session.mode) return null; // this worker only ever holds one armed credential at a time
    return session.cred;
  },
  notify(msg, kind){ log(msg, kind); },
  getQuantCfg(opts){
    const o = opts || {};
    return sanitizeQuantConfig({
      ...QUANT_DEFAULTS,
      riskPct: o.riskPct != null ? o.riskPct : QUANT_DEFAULTS.riskPct,
      minConfidence: o.minConfidence != null ? o.minConfidence : QUANT_DEFAULTS.minConfidence,
      highSelectivity: o.highSelectivity != null ? !!o.highSelectivity : QUANT_DEFAULTS.highSelectivity,
    });
  },
  onPositionsChanged(){ /* session.livePositions is already the live source of truth for /api/worker/status — nothing else to persist here */ },
  onRender(){ /* no UI to redraw */ },
  onPendingSignal(){ /* Manual mode isn't used here — session.liveTradeMode is always 'auto' */ },
  onDisarmedIdle(){
    log('Disarmed and nothing left open — stopping the polling loop.');
    clearInterval(timer);
    timer = null;
  },
  updateOpenPositionLabel(){ /* see getStatus() — reads session.livePositions directly instead */ },
  updateBalanceLabel(){ /* see getStatus() if a balance field is added later */ },
  appendPersistentTrade(){ /* the session-scoped liveTradeHistory already covers /api/worker/status's "recent trades"; no separate cross-session log server-side */ },
  syncSettings(){ /* no form to read from — session's cfg fields are set once, at arm time */ },
  isAiEnabled(){ return false; }, // no AI-signal-provider key exists server-side
  getAiConfirmation(){ return null; },
  onScanRows(){ /* no scanner table to render */ },
};

async function runCycle(){
  if(cycleInFlight || !session) return;
  cycleInFlight = true;
  try{
    session.lastCycleAtMs = Date.now();
    await runLiveCycleInner(session, adapter);
  }catch(err){
    log(`Cycle error: ${err.message}`, 'error');
  } finally {
    cycleInFlight = false;
  }
}

export function armSession(params){
  const {
    armPhrase, exchange, mode, apiKey, secretKey, passphrase,
    leverage, riskPctPerTrade, minConfidence, minRiskReward, minNetProfitPct,
    highSelectivity, strategies, strategyRR, dailyProfitTargetPct, maxDailyLossPct,
  } = params || {};

  if(armPhrase !== ARM_PHRASE){
    return { ok: false, message: `Arm phrase must be exactly "${ARM_PHRASE}".` };
  }
  if(!LIVE_TRADEABLE_EXCHANGES.includes(exchange)){
    return { ok: false, message: `Unknown/unsupported exchange "${exchange}".` };
  }
  if(!apiKey || !secretKey){
    return { ok: false, message: 'apiKey and secretKey are required (passphrase too, for Bitget).' };
  }
  if(session && session.liveArmed){
    return { ok: false, message: 'Already armed — disarm first if you want to change settings.' };
  }

  const resolvedMode = mode === 'demo' ? 'demo' : 'live';
  session = {
    liveArmed: true, armedAtMs: Date.now(), lastCycleAtMs: null, lastMessage: '', lastMessageKind: 'info',
    exchange, mode: resolvedMode,
    liveExchange: exchange, liveModeByExchange: { [exchange]: resolvedMode },
    cred: { apiKey, secretKey, passphrase: passphrase || '' },
    liveTradeMode: 'auto', livePendingSignal: null, liveRunning: true,
    leverage: Number(leverage) || RISK_DEFAULTS.defaultLeverage || 5,
    riskPctPerTrade: Number(riskPctPerTrade) || 0.5,
    minConfidence: Number(minConfidence) || 70,
    minRiskReward: Number(minRiskReward) || 2,
    minNetProfitPct: minNetProfitPct != null ? Number(minNetProfitPct) : undefined,
    highSelectivity: !!highSelectivity,
    strategies: strategies || undefined,
    strategyRR: strategyRR || undefined,
    liveDailyProfitTargetPct: dailyProfitTargetPct != null ? Number(dailyProfitTargetPct) : undefined,
    liveMaxDailyLossPct: maxDailyLossPct != null ? Number(maxDailyLossPct) : undefined,
    livePositions: {}, liveTradeHistory: [],
    liveCooldownUntilBySymbol: {}, liveOrderFailUntilBySymbol: {},
    liveStartingEquity: null, liveTrades: 0, liveWins: 0, liveLosses: 0,
    liveNetPnlUsd: 0, liveGrossPnlUsd: 0, liveFeesUsd: 0,
    liveConsecutiveLosses: 0, liveAdaptiveConfidenceBoost: 0, liveAdaptiveConfidenceBoostAtMs: 0,
    logs: [],
  };
  log(`Armed on ${exchange} (${resolvedMode}). Watching for entries every ${LIVE_CYCLE_MS / 1000}s. TP/SL on any position opened are native exchange orders and stay protected even if this process stops.`, 'success');
  clearInterval(timer);
  timer = setInterval(runCycle, LIVE_CYCLE_MS);
  runCycle(); // don't wait a full cycle for the first tick
  return { ok: true, status: getStatus() };
}

export function disarmSession(){
  if(!session){ return { ok: true, status: getStatus() }; }
  const hasOpenPositions = Object.keys(session.livePositions).length > 0;
  session.liveArmed = false;
  if(!hasOpenPositions){
    clearInterval(timer);
    timer = null;
  }
  log(hasOpenPositions
    ? 'Disarmed — no NEW entries will be placed. Open position(s) keep their native exchange-side SL/TP either way; this worker keeps polling just to detect their closure and run the breakeven-move automation until they close, then stops.'
    : 'Disarmed.', 'success');
  return { ok: true, status: getStatus() };
}

export function getStatus(){
  if(!session){
    return { armed: false };
  }
  return {
    armed: session.liveArmed, exchange: session.exchange, mode: session.mode,
    armedAtMs: session.armedAtMs, lastCycleAtMs: session.lastCycleAtMs,
    lastMessage: session.lastMessage, lastMessageKind: session.lastMessageKind,
    openPositions: session.livePositions,
    trades: session.liveTrades, wins: session.liveWins, losses: session.liveLosses,
    netPnlUsd: session.liveNetPnlUsd, grossPnlUsd: session.liveGrossPnlUsd, feesUsd: session.liveFeesUsd,
    recentTrades: session.liveTradeHistory.slice(0, 20),
    consecutiveLosses: session.liveConsecutiveLosses, adaptiveConfidenceBoost: session.liveAdaptiveConfidenceBoost,
  };
}

export function getLogs(sinceMs){
  if(!session) return [];
  const since = Number(sinceMs) || 0;
  return session.logs.filter(l => l.ts > since);
}

// Mounts /api/worker/* routes on the given Express app. Call once, after
// app.use(express.json()) is set up (server.js already does that).
// `baseUrl` is where the worker calls back into THIS SAME server's own
// /api/futures/* routes — normally http://127.0.0.1:<port>.
export function attachWorker(app, baseUrl){
  selfBaseUrl = baseUrl;

  app.post('/api/worker/arm', (req, res) => {
    const result = armSession(req.body || {});
    res.json(result);
  });

  app.post('/api/worker/disarm', (req, res) => {
    res.json(disarmSession());
  });

  app.get('/api/worker/status', (req, res) => {
    res.json({ ok: true, status: getStatus() });
  });

  app.get('/api/worker/logs', (req, res) => {
    res.json({ ok: true, logs: getLogs(req.query.since) });
  });
}
