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
import crypto from 'node:crypto';
import {
  ARM_PHRASE, LIVE_CYCLE_MS, LIVE_TRADEABLE_EXCHANGES, LIVE_ONLY_EXCHANGES,
  runLiveCycleInner, getTradeableSymbols,
} from '../js/futures/liveEngine.js';
import { RISK_DEFAULTS } from '../js/futures/risk.js';
import { sanitizeQuantConfig, QUANT_DEFAULTS } from '../js/futures/quant/config.js';

export { ARM_PHRASE };

const MAX_LOG_LINES = 300;

// One "runner" per exchange: { session, timer, cycleInFlight, adapter }.
// Each exchange has its own credential, settings, cooldowns, equity baseline,
// position tracking and log — running Bybit and Binance at once means two
// independent runners, never a shared one. Keyed by exchange id, so an exchange
// can only ever have one armed session at a time.
const runners = new Map();
let selfBaseUrl = 'http://127.0.0.1:8787';

function log(runner, msg, kind){
  const session = runner.session;
  session.logs.push({ ts: Date.now(), msg: String(msg), kind: kind || 'info', exchange: session.exchange });
  if(session.logs.length > MAX_LOG_LINES) session.logs.splice(0, session.logs.length - MAX_LOG_LINES);
  session.lastMessage = String(msg);
  session.lastMessageKind = kind || 'info';
  console.log(`[worker:${session.exchange}] ${msg}`);
}

// The Node adapter liveEngine.js's shared functions run against — see the
// "adapter shape" comment at the top of liveEngine.js. Built per runner so each
// exchange's credential/settings/log stay separate. Only proxyCall/fetchSnapshot/
// getCred are required; the rest is this process's (mostly log-only) version of
// what the browser adapter in futures-ui.js does with the DOM.
function buildAdapter(runner){
  const session = runner.session;
  return {
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
      if(exchange !== session.exchange || mode !== session.mode) return null; // a runner only ever holds its own one credential
      return session.cred;
    },
    notify(msg, kind){ log(runner, msg, kind); },
    // Same merge the browser's getQuantCfg (quant-ui.js) does: the Quant-only
    // settings that were saved in the app (sent at arm time as quantCfg) form the
    // base; the shared Min confidence / Risk % / High Selectivity are laid over them.
    getQuantCfg(opts){
      const o = opts || {};
      const base = session.quantBase || QUANT_DEFAULTS;
      return sanitizeQuantConfig({
        ...base,
        riskPct: o.riskPct != null ? o.riskPct : base.riskPct,
        minConfidence: o.minConfidence != null ? o.minConfidence : base.minConfidence,
        selectivity: o.highSelectivity != null ? (o.highSelectivity ? 'high' : 'off') : base.selectivity,
      });
    },
    onPositionsChanged(){ /* session.livePositions is already the live source of truth for /api/worker/status — nothing else to persist here */ },
    onRender(){ /* no UI to redraw */ },
    onPendingSignal(){ /* Manual mode isn't used here — session.liveTradeMode is always 'auto' */ },
    onDisarmedIdle(){
      log(runner, 'Disarmed and nothing left open — stopping the polling loop.');
      clearInterval(runner.timer);
      runner.timer = null;
    },
    updateOpenPositionLabel(){ /* see statusOf() — reads session.livePositions directly instead */ },
    updateBalanceLabel(){ /* see statusOf() if a balance field is added later */ },
    appendPersistentTrade(){ /* the session-scoped liveTradeHistory already covers /api/worker/status's "recent trades"; no separate cross-session log server-side */ },
    syncSettings(){ /* no form to read from — session's cfg fields are set once, at arm time */ },
    isAiEnabled(){ return false; }, // no AI-signal-provider key exists server-side
    getAiConfirmation(){ return null; },
    onScanRows(){ /* no scanner table to render */ },
  };
}

// "Daily" profit target / max daily loss are measured against liveStartingEquity,
// which the shared engine captures once. A worker that runs for days needs that
// baseline to roll over, or a hit target would halt it forever (and a week of
// cumulative gains would count as one day's P&L). So at each local-midnight
// boundary the baseline is cleared and re-captured from the next cycle's equity.
function dayKeyFor(session){
  return Math.floor((Date.now() + session.tzOffsetMin * 60_000) / 86_400_000);
}

async function runCycle(runner){
  const session = runner.session;
  if(runner.cycleInFlight || !session) return;
  runner.cycleInFlight = true;
  try{
    session.lastCycleAtMs = Date.now();
    const dk = dayKeyFor(session);
    if(session.dayKey != null && session.dayKey !== dk){
      session.liveStartingEquity = null;
      session.liveConsecutiveLosses = 0;
      log(runner, 'New trading day — daily profit target / max daily loss baselines reset to today\'s starting balance.', 'success');
    }
    session.dayKey = dk;
    await runLiveCycleInner(session, runner.adapter);
  }catch(err){
    log(runner, `Cycle error: ${err.message}`, 'error');
  } finally {
    runner.cycleInFlight = false;
  }
}

// -------------------------------------------------------------
// Server-side saved settings + access tokens
//
// Everything below is opt-in via environment variables set on the host
// (Render: service -> Environment). Nothing here is written to disk by this
// code, and nothing is ever sent back to a browser — the dashboard only learns
// THAT keys are configured (and for which exchange/mode), never what they are.
//
//   WORKER_TOKEN        admin access token (>= 20 chars). Required for every
//                       /api/worker/* call — without it the routes answer 503.
//   WORKER_VIEW_TOKEN   optional read-only token (status + logs only) — safe to
//                       hand to someone who should watch but not arm/disarm.
//   WORKER_EXCHANGE, WORKER_MODE, WORKER_API_KEY, WORKER_SECRET_KEY,
//   WORKER_PASSPHRASE   the credential the worker trades with.
//   WORKER_LEVERAGE, WORKER_RISK_PCT, WORKER_MIN_CONFIDENCE, WORKER_MIN_RR,
//   WORKER_MIN_NET_PROFIT_PCT, WORKER_DAILY_PROFIT_TARGET_PCT,
//   WORKER_MAX_DAILY_LOSS_PCT, WORKER_HIGH_SELECTIVITY, WORKER_STRATEGIES
//                       optional settings (WORKER_STRATEGIES is JSON, e.g.
//                       {"novaScalp":true,"quantFutures":true}).
//   WORKER_AUTOARM=true arm automatically on every server start.
// -------------------------------------------------------------
const MIN_TOKEN_LEN = 20;

function envNum(name){
  const v = process.env[name];
  if(v == null || String(v).trim() === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function envStrategies(){
  const raw = process.env.WORKER_STRATEGIES;
  if(!raw || !raw.trim()) return undefined;
  try{
    const parsed = JSON.parse(raw);
    return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : undefined;
  }catch(e){
    console.log('[worker] WORKER_STRATEGIES is not valid JSON — ignoring it (strategy defaults will be used).');
    return undefined;
  }
}

function hasEnvCreds(){
  const e = process.env;
  return !!(e.WORKER_EXCHANGE && e.WORKER_API_KEY && e.WORKER_SECRET_KEY);
}

// The armSession() params built from the WORKER_* env vars, or null if the
// credential trio isn't there. `armPhrase` is filled in by the caller: a
// dashboard arm passes what the person typed; auto-arm passes ARM_PHRASE
// itself, because setting WORKER_AUTOARM=true IS the operator's explicit opt-in.
function envParams(armPhrase){
  if(!hasEnvCreds()) return null;
  const e = process.env;
  return {
    armPhrase,
    exchange: String(e.WORKER_EXCHANGE).trim().toLowerCase(),
    mode: String(e.WORKER_MODE || 'demo').trim().toLowerCase(),
    apiKey: String(e.WORKER_API_KEY).trim(),
    secretKey: String(e.WORKER_SECRET_KEY).trim(),
    passphrase: String(e.WORKER_PASSPHRASE || '').trim(),
    leverage: envNum('WORKER_LEVERAGE'),
    riskPctPerTrade: envNum('WORKER_RISK_PCT'),
    minConfidence: envNum('WORKER_MIN_CONFIDENCE'),
    minRiskReward: envNum('WORKER_MIN_RR'),
    minNetProfitPct: envNum('WORKER_MIN_NET_PROFIT_PCT'),
    dailyProfitTargetPct: envNum('WORKER_DAILY_PROFIT_TARGET_PCT'),
    maxDailyLossPct: envNum('WORKER_MAX_DAILY_LOSS_PCT'),
    highSelectivity: String(e.WORKER_HIGH_SELECTIVITY || '').toLowerCase() === 'true',
    strategies: envStrategies(),
    tzOffsetMinutes: envNum('WORKER_TZ_OFFSET_MINUTES'), // e.g. 60 for UTC+1 — when the "daily" targets reset (default: UTC midnight)
    requireRiskSettings: true, // env-armed sessions must state their risk numbers too — see armSession
  };
}

// Non-secret facts about the server's saved config — what the dashboard uses to
// decide whether to show key fields at all.
function serverInfo(){
  const e = process.env;
  return {
    envConfigured: hasEnvCreds(),
    envExchange: hasEnvCreds() ? String(e.WORKER_EXCHANGE).trim().toLowerCase() : null,
    envMode: hasEnvCreds() ? String(e.WORKER_MODE || 'demo').trim().toLowerCase() : null,
    autoArm: String(e.WORKER_AUTOARM || '').toLowerCase() === 'true',
  };
}

function safeEq(a, b){
  const A = Buffer.from(String(a || ''));
  const B = Buffer.from(String(b || ''));
  return A.length === B.length && crypto.timingSafeEqual(A, B);
}

// Trimmed, so a stray space/newline pasted into the host's env screen can't make a
// token that "looks right" fail to match (or count towards the length check).
const adminToken = () => String(process.env.WORKER_TOKEN || '').trim();
const viewToken = () => String(process.env.WORKER_VIEW_TOKEN || '').trim();

function roleFor(req){
  const admin = adminToken();
  const view = viewToken();
  const presented = String(req.get('x-worker-token') || (req.get('authorization') || '').replace(/^Bearer\s+/i, '')).trim();
  if(!presented) return null;
  if(admin.length >= MIN_TOKEN_LEN && safeEq(presented, admin)) return 'admin';
  if(view.length >= MIN_TOKEN_LEN && safeEq(presented, view)) return 'view';
  return null;
}

// Fails closed: with no (or a too-short) WORKER_TOKEN nothing under
// /api/worker/* answers, so a fresh deploy can never expose the worker by accident.
function requireRole(min){
  return (req, res, next) => {
    const adminTok = adminToken();
    if(adminTok.length < MIN_TOKEN_LEN){
      // Say which of the two it is — "not set" (usually: the env group isn't linked
      // to THIS service, or it hasn't redeployed yet) vs "too short". Only the length
      // of a token that is unusable anyway is revealed; nothing about a valid one.
      const why = adminTok.length === 0
        ? 'WORKER_TOKEN is not set on the server that answered.'
        : `WORKER_TOKEN is set but only ${adminTok.length} characters long.`;
      return res.status(503).json({ ok: false, code: 'no_token_configured',
        message: `${why} It must be at least ${MIN_TOKEN_LEN} characters, set in the environment of the service this page talks to (and that service redeployed) — the worker is locked until then.` });
    }
    const role = roleFor(req);
    if(!role) return res.status(401).json({ ok: false, code: 'unauthorized', message: 'Missing or incorrect access token.' });
    if(min === 'admin' && role !== 'admin') return res.status(403).json({ ok: false, code: 'forbidden', message: 'This token is read-only — it can watch the worker but not arm or disarm it.' });
    req.workerRole = role;
    next();
  };
}

function scheduleAutoArm(){
  if(String(process.env.WORKER_AUTOARM || '').toLowerCase() !== 'true') return;
  const params = envParams(ARM_PHRASE);
  if(!params){
    console.log('[worker] WORKER_AUTOARM=true but WORKER_EXCHANGE / WORKER_API_KEY / WORKER_SECRET_KEY are not all set — staying disarmed.');
    return;
  }
  // Wait a moment so this server is listening before the first cycle's loopback calls.
  setTimeout(() => {
    const r = armSession(params);
    if(r.ok){
      const runner = runners.get(params.exchange);
      if(runner) log(runner, 'Auto-armed on server start from the server\'s saved settings (WORKER_AUTOARM=true).', 'success');
    } else console.log('[worker] Auto-arm failed: ' + r.message);
  }, 3000);
}

const clampNum = (v, lo, hi, dflt) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
};
const isNum = v => v != null && v !== '' && Number.isFinite(Number(v));

export function armSession(params){
  const {
    armPhrase, exchange, mode, apiKey, secretKey, passphrase,
    leverage, riskPctPerTrade, minConfidence, minRiskReward, minNetProfitPct,
    highSelectivity, strategies, strategyRR, dailyProfitTargetPct, maxDailyLossPct,
    quantCfg, tzOffsetMinutes, explicitSettings, requireRiskSettings,
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
  if(exchange === 'bitget' && !passphrase){
    return { ok: false, message: 'Bitget also needs its passphrase.' };
  }
  const requestedMode = mode === 'demo' ? 'demo' : 'live';
  if(requestedMode === 'demo' && LIVE_ONLY_EXCHANGES.includes(exchange)){
    // Never silently turn a Demo request into real-money trading.
    return { ok: false, message: `${exchange} has no public Demo environment — refusing to treat a Demo request as Live. Arm it with mode "live" only if you mean real funds.` };
  }

  // When arming from the app's button the person's own on-screen settings ARE the
  // request — refuse to fill any gap with a default rather than trade on numbers
  // they never chose.
  if(explicitSettings || requireRiskSettings){
    const missing = [];
    const need = (ok, label, envName) => { if(!ok) missing.push(requireRiskSettings && !explicitSettings ? envName : label); };
    need(isNum(leverage), 'leverage', 'WORKER_LEVERAGE');
    need(isNum(riskPctPerTrade), 'risk per trade', 'WORKER_RISK_PCT');
    need(isNum(minConfidence), 'min confidence', 'WORKER_MIN_CONFIDENCE');
    need(isNum(dailyProfitTargetPct), 'daily profit target', 'WORKER_DAILY_PROFIT_TARGET_PCT');
    need(isNum(maxDailyLossPct), 'max daily loss', 'WORKER_MAX_DAILY_LOSS_PCT');
    if(explicitSettings && (!strategies || typeof strategies !== 'object' || !Object.keys(strategies).length)) missing.push('strategy selection');
    if(missing.length){
      return { ok: false, message: requireRiskSettings && !explicitSettings
        ? `Not armed — the worker won't trade on default risk numbers. Set these in the server's environment: ${missing.join(', ')}.`
        : `Not armed — these settings weren't sent, and the worker won't fall back to defaults: ${missing.join(', ')}.` };
    }
  }

  const existing = runners.get(exchange);
  if(existing && existing.session.liveArmed){
    return { ok: false, message: `Already armed on ${exchange} — disarm it first if you want to change its settings.` };
  }
  if(existing && Object.keys(existing.session.livePositions).length){
    return { ok: false, message: `The previous ${exchange} session is still managing an open position (its exchange-side SL/TP stay active). Wait for it to close, then arm again.` };
  }
  if(existing && existing.timer) clearInterval(existing.timer);

  let quantBase;
  if(quantCfg && typeof quantCfg === 'object'){
    try{ quantBase = sanitizeQuantConfig(quantCfg); }catch(e){ quantBase = undefined; }
  }

  const resolvedLeverage = clampNum(leverage, 1, RISK_DEFAULTS.maxLeverage, RISK_DEFAULTS.defaultLeverage || 5);
  const resolvedRisk = clampNum(riskPctPerTrade, 0.25, RISK_DEFAULTS.maxRiskPctPerTrade, 0.5);
  const resolvedConf = clampNum(minConfidence, 0, 100, 70);
  const resolvedRR = clampNum(minRiskReward, 1, 10, 2);
  const resolvedProfitTarget = isNum(dailyProfitTargetPct) ? clampNum(dailyProfitTargetPct, 1, 50, undefined) : undefined;
  const resolvedMaxLoss = isNum(maxDailyLossPct) ? clampNum(maxDailyLossPct, 0.5, 50, undefined) : undefined;

  const session = {
    liveArmed: true, armedAtMs: Date.now(), lastCycleAtMs: null, lastMessage: '', lastMessageKind: 'info',
    exchange, mode: requestedMode,
    liveExchange: exchange, liveModeByExchange: { [exchange]: requestedMode },
    cred: { apiKey, secretKey, passphrase: passphrase || '' },
    liveTradeMode: 'auto', livePendingSignal: null, liveRunning: true,
    leverage: resolvedLeverage,
    riskPctPerTrade: resolvedRisk,
    minConfidence: resolvedConf,
    minRiskReward: resolvedRR,
    minNetProfitPct: isNum(minNetProfitPct) ? Number(minNetProfitPct) : undefined,
    highSelectivity: !!highSelectivity,
    strategies: (strategies && typeof strategies === 'object') ? strategies : undefined,
    strategyRR: (strategyRR && typeof strategyRR === 'object') ? strategyRR : undefined,
    quantBase,
    liveDailyProfitTargetPct: resolvedProfitTarget,
    liveMaxDailyLossPct: resolvedMaxLoss,
    tzOffsetMin: clampNum(tzOffsetMinutes, -720, 840, 0), dayKey: null,
    livePositions: {}, liveTradeHistory: [],
    liveCooldownUntilBySymbol: {}, liveOrderFailUntilBySymbol: {},
    liveStartingEquity: null, liveTrades: 0, liveWins: 0, liveLosses: 0,
    liveNetPnlUsd: 0, liveGrossPnlUsd: 0, liveFeesUsd: 0,
    liveConsecutiveLosses: 0, liveAdaptiveConfidenceBoost: 0, liveAdaptiveConfidenceBoostAtMs: 0,
    logs: [],
  };
  const runner = { session, timer: null, cycleInFlight: false, adapter: null };
  runner.adapter = buildAdapter(runner);
  runners.set(exchange, runner);

  log(runner, `Armed on ${exchange} (${requestedMode}). Watching for entries every ${LIVE_CYCLE_MS / 1000}s. TP/SL on any position opened are native exchange orders and stay protected even if this process stops.`, 'success');
  log(runner, `Settings in use — leverage ${session.leverage}x · risk ${session.riskPctPerTrade}%/trade · min confidence ${session.minConfidence} · daily profit target ${session.liveDailyProfitTargetPct ?? 'default'}% · max daily loss ${session.liveMaxDailyLossPct ?? 'default'}%${session.highSelectivity ? ' · high selectivity' : ''}.`);
  runner.timer = setInterval(() => runCycle(runner), LIVE_CYCLE_MS);
  runCycle(runner); // don't wait a full cycle for the first tick
  return { ok: true, status: getStatus() };
}

// exchange omitted -> disarm every exchange.
export function disarmSession(exchange){
  if(exchange != null && !LIVE_TRADEABLE_EXCHANGES.includes(exchange)){
    return { ok: false, message: `Unknown exchange "${exchange}".` };
  }
  const targets = exchange ? [runners.get(exchange)].filter(Boolean) : [...runners.values()];
  for(const runner of targets){
    const session = runner.session;
    const hasOpenPositions = Object.keys(session.livePositions).length > 0;
    session.liveArmed = false;
    if(!hasOpenPositions){
      clearInterval(runner.timer);
      runner.timer = null;
    }
    log(runner, hasOpenPositions
      ? 'Disarmed — no NEW entries will be placed. Open position(s) keep their native exchange-side SL/TP either way; this worker keeps polling just to detect their closure and run the breakeven-move automation until they close, then stops.'
      : 'Disarmed.', 'success');
  }
  return { ok: true, status: getStatus() };
}

function statusOf(runner){
  const s = runner.session;
  const on = s.strategies ? Object.keys(s.strategies).filter(id => s.strategies[id]) : null;
  return {
    armed: s.liveArmed, exchange: s.exchange, mode: s.mode,
    armedAtMs: s.armedAtMs, lastCycleAtMs: s.lastCycleAtMs,
    lastMessage: s.lastMessage, lastMessageKind: s.lastMessageKind,
    openPositions: s.livePositions,
    trades: s.liveTrades, wins: s.liveWins, losses: s.liveLosses,
    netPnlUsd: s.liveNetPnlUsd, grossPnlUsd: s.liveGrossPnlUsd, feesUsd: s.liveFeesUsd,
    recentTrades: s.liveTradeHistory.slice(0, 20),
    consecutiveLosses: s.liveConsecutiveLosses, adaptiveConfidenceBoost: s.liveAdaptiveConfidenceBoost,
    // Echo of exactly what this session is trading with — never any credential.
    settings: {
      leverage: s.leverage, riskPctPerTrade: s.riskPctPerTrade, minConfidence: s.minConfidence,
      minRiskReward: s.minRiskReward, dailyProfitTargetPct: s.liveDailyProfitTargetPct,
      maxDailyLossPct: s.liveMaxDailyLossPct, highSelectivity: s.highSelectivity, strategiesOn: on,
    },
  };
}

export function getStatus(){
  const sessions = {};
  let anyArmed = false;
  for(const [exchange, runner] of runners){
    sessions[exchange] = statusOf(runner);
    if(runner.session.liveArmed) anyArmed = true;
  }
  return { ...serverInfo(), armed: anyArmed, sessions };
}

// Lines from every exchange (or just one), oldest first; each carries its `exchange`.
export function getLogs(sinceMs, exchange){
  const since = Number(sinceMs) || 0;
  const out = [];
  for(const [ex, runner] of runners){
    if(exchange && ex !== exchange) continue;
    for(const l of runner.session.logs) if(l.ts > since) out.push(l);
  }
  return out.sort((a, b) => a.ts - b.ts);
}

// Mounts /api/worker/* routes on the given Express app. Call once, after
// app.use(express.json()) is set up (server.js already does that).
// `baseUrl` is where the worker calls back into THIS SAME server's own
// /api/futures/* routes — normally http://127.0.0.1:<port>.
export function attachWorker(app, baseUrl){
  selfBaseUrl = baseUrl;

  app.post('/api/worker/arm', requireRole('admin'), (req, res) => {
    const body = req.body || {};
    if(body.useServerKeys){
      // Arm with the credential + settings saved in the server's environment —
      // no key ever crosses the browser. The arm phrase is still typed by a person.
      const params = envParams(body.armPhrase);
      if(!params) return res.json({ ok: false, message: 'The server has no saved credential (WORKER_EXCHANGE / WORKER_API_KEY / WORKER_SECRET_KEY are not set).' });
      return res.json(armSession(params));
    }
    res.json(armSession(body));
  });

  app.post('/api/worker/disarm', requireRole('admin'), (req, res) => {
    const out = disarmSession((req.body && req.body.exchange) || undefined);
    if(out.ok && serverInfo().autoArm){
      console.log('[worker] Note: WORKER_AUTOARM is on, so the env-configured exchange will arm itself again the next time this server restarts.');
    }
    res.json(out);
  });

  app.get('/api/worker/status', requireRole('view'), (req, res) => {
    res.json({ ok: true, role: req.workerRole, status: getStatus() });
  });

  app.get('/api/worker/logs', requireRole('view'), (req, res) => {
    res.json({ ok: true, logs: getLogs(req.query.since, req.query.exchange) });
  });

  scheduleAutoArm();
}
