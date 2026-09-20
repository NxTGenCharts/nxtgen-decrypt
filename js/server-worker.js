// =============================================================
// server-worker.js — the ONE switch for "Run on server — 24/7" on the
// Autotrade & Futures page.
//
// Switch ON  -> hands the exchange/network selected in the Live / Demo panel to
//               the always-on server worker (server/worker.js). It trades with
//               the key already verified in this browser and the values that are
//               ON SCREEN right now (Risk per trade, Leverage, Min confidence,
//               Daily Profit Target, Max Daily Loss, High Selectivity, and the
//               strategies switched on) — read at the moment you flip it.
//               Nothing falls back to a default: a blank/invalid field refuses
//               and names the field.
// Switch OFF -> stops new entries on the server. An open position keeps its
//               exchange-side SL/TP.
//
// There is no token box, arm phrase, settings summary or session list here any
// more (the settings live in one place — the fields above; the /worker/ page
// still has the full log). The switch mirrors what the server is actually doing,
// so it is also ON after a refresh, or if the server armed itself
// (WORKER_AUTOARM).
//
// The access token is still required by the server (the proxy URL is public, and
// CORS does not stop curl) — it is asked for ONCE, the first time you flip the
// switch, and remembered on this device. A rejected token is asked for again.
// Live mode asks for a confirm() instead of typing a phrase.
//
// Each exchange is its own server session, so Bybit, Binance, ... can each be
// switched on separately (select the exchange row, flip the switch). Keys stay in
// the server's memory only; a server restart stops the session unless
// WORKER_AUTOARM is on.
// =============================================================
import { state } from './state.js';
import { RISK_DEFAULTS } from './futures/risk.js';
import { ARM_PHRASE, LIVE_ONLY_EXCHANGES } from './futures/liveEngine.js';
import { getQuantCfg } from './quant-ui.js';

const TOKEN_KEY = 'nxtgen_server_worker_token_v1';
const DASH_KEY = 'nxtgen_worker_dash_v1'; // the /worker/ dashboard's own prefs (same origin) — reused if it already has a token
const POLL_MS = 8000;
const EXCHANGE_NAMES = { bybit: 'Bybit', binance: 'Binance', gateio: 'Gate.io', mexc: 'MEXC', bitget: 'Bitget' };

const $ = id => document.getElementById(id);
const fu = () => state.futures;

function proxyBase(){ return (state.verifyProxyUrl || '').trim().replace(/\/$/, ''); }

// ---- access token: asked once, remembered on this device ----
function savedToken(){
  try{
    const own = localStorage.getItem(TOKEN_KEY);
    if(own) return own;
    const dash = JSON.parse(localStorage.getItem(DASH_KEY) || '{}');
    return dash.token || '';
  }catch(e){ return ''; }
}
function saveToken(t){ try{ localStorage.setItem(TOKEN_KEY, t); }catch(e){ /* non-fatal */ } }

let forcePrompt = false; // set when the server rejected the saved token, so we ask again instead of resending it
function getToken(askIfMissing){
  if(!forcePrompt){ const t = savedToken(); if(t) return t; }
  if(!askIfMissing) return '';
  const t = (window.prompt('Enter your server access token (the WORKER_TOKEN you set on Render).\nIt is saved on this device, so you only do this once.') || '').trim();
  if(t){ saveToken(t); forcePrompt = false; }
  return t;
}

async function wcall(path, method, body, token){
  const base = proxyBase();
  if(!base) throw new Error('No verification proxy configured.');
  const headers = { 'X-Worker-Token': token };
  if(body) headers['Content-Type'] = 'application/json';
  const res = await fetch(base + path, { method: method || 'GET', headers, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => null);
  if(!data) throw new Error('The server sent an unreadable response.');
  if(data.code === 'unauthorized') forcePrompt = true;
  return data;
}

// ---- settings: read from the same fields the rest of the page uses ----
function fieldNum(...ids){
  for(const id of ids){
    const el = $(id);
    if(el && String(el.value).trim() !== ''){
      const n = Number(el.value);
      if(Number.isFinite(n)) return n;
    }
  }
  return null;
}

// Returns { settings, problems[] }. `settings` is exactly what will be sent.
export function readSettings(){
  const f = fu();
  const problems = [];
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  const riskRaw = fieldNum('fuLiveRiskPct', 'fuRiskPct');
  const levRaw = fieldNum('fuLeverage');
  const confRaw = fieldNum('fuMinConfidence');
  const targetRaw = fieldNum('fuLiveDailyProfitTargetPct');
  const lossRaw = fieldNum('fuLiveMaxDailyLossPct');
  const netRaw = fieldNum('fuMinNetProfit');
  if(riskRaw == null) problems.push('Risk per trade');
  if(levRaw == null) problems.push('Leverage');
  if(confRaw == null) problems.push('Min confidence');
  if(targetRaw == null) problems.push('Daily Profit Target');
  if(lossRaw == null) problems.push('Max Daily Loss');

  const strategies = { ...(f.strategies || {}) };
  const strategyRR = { ...(f.strategyRR || {}) };
  const enabledIds = Object.keys(strategies).filter(id => strategies[id]);
  if(!enabledIds.length) problems.push('at least one strategy switched on');

  const highSelectivity = !!($('fuSelectivityToggle') && $('fuSelectivityToggle').checked);
  const settings = {
    leverage: levRaw == null ? null : clamp(levRaw, 1, RISK_DEFAULTS.maxLeverage),
    riskPctPerTrade: riskRaw == null ? null : clamp(riskRaw, 0.25, RISK_DEFAULTS.maxRiskPctPerTrade),
    minConfidence: confRaw == null ? null : clamp(confRaw, 0, 100),
    minRiskReward: 2, // fixed 1:2 in the app (the field is read-only there)
    minNetProfitPct: netRaw == null ? undefined : netRaw,
    dailyProfitTargetPct: targetRaw == null ? null : clamp(targetRaw, 1, 50),
    maxDailyLossPct: lossRaw == null ? null : clamp(lossRaw, 0.5, 50),
    highSelectivity,
    strategies, strategyRR,
  };
  settings._enabledIds = enabledIds;
  return { settings, problems };
}

function selection(){
  const f = fu();
  const exchange = f.liveExchange;
  const mode = LIVE_ONLY_EXCHANGES.includes(exchange) ? 'live' : (f.liveModeByExchange[exchange] || 'live');
  const cred = state.exchangeCreds[exchange] && state.exchangeCreds[exchange][mode];
  const verified = !!(cred && cred.apiKey && cred.secretKey && cred.verified);
  return { exchange, mode, cred, verified };
}
const selKey = () => { const s = selection(); return s.exchange + ':' + s.mode; };
const nameOf = ex => EXCHANGE_NAMES[ex] || ex;

// ---- state + rendering ----
let lastStatus = null;   // last /api/worker/status payload — the switch mirrors THIS, not a local guess
let readOnly = false;
let busy = false;
let msg = { text: '', kind: '', key: '', src: '' };

function fmtUsd(n){ if(n == null) return '—'; return (n < 0 ? '-$' : '+$') + Math.abs(n).toFixed(2); }
function sessionFor(exchange){ return lastStatus && lastStatus.sessions ? lastStatus.sessions[exchange] : null; }

// A message belongs to the exchange/network it was raised for — switching the row clears it,
// so an old "no verified live key" can never linger under a Demo selection.
function setMsg(text, kind, src){
  msg = { text: text || '', kind: kind || '', key: selKey(), src: src || '' };
  render();
}

function render(){
  const cb = $('swToggle'); if(!cb) return;
  const sel = selection();
  const sess = sessionFor(sel.exchange);
  const on = !!(sess && sess.armed);
  cb.checked = busy ? cb.checked : on;
  cb.disabled = busy || readOnly;

  let sub;
  if(on){
    const bits = [`${nameOf(sess.exchange)} · ${sess.mode === 'live' ? 'LIVE' : 'Demo'}`, `${sess.trades || 0} trades (${sess.wins || 0}W/${sess.losses || 0}L)`, `net ${fmtUsd(sess.netPnlUsd)}`];
    const open = Object.keys(sess.openPositions || {});
    if(open.length) bits.push('open: ' + open.join(', '));
    sub = 'ON — running on the server, you can close this tab. ' + bits.join(' · ');
  } else if(sess && Object.keys(sess.openPositions || {}).length){
    sub = 'OFF — no new entries. The open position keeps its exchange-side SL/TP until it closes.';
  } else {
    sub = `OFF — ${nameOf(sel.exchange)} only trades while this tab is open.`;
  }
  $('swSub').textContent = sub;

  let text = '', kind = '';
  if(msg.text && msg.key === selKey()){ text = msg.text; kind = msg.kind; }
  const f = fu();
  if(!text && on && f.liveRunning && f.liveArmed && f.liveExchange === sel.exchange){
    text = 'This tab is also running the bot on this exchange — stop one of them, or trades will double up.'; kind = 'error';
  }
  if(!text && readOnly){ text = 'This token is read-only: you can watch, not switch the server on or off.'; }
  if(!text && on && sess.lastMessageKind === 'error' && sess.lastMessage){ text = sess.lastMessage; kind = 'error'; }
  const el = $('swMsg');
  el.textContent = text;
  el.style.color = kind === 'error' ? 'var(--red)' : kind === 'ok' ? 'var(--green)' : 'var(--dim)';
}

async function poll(){
  if(document.visibilityState === 'hidden' || busy) return;
  const tok = getToken(false);
  if(!tok) return; // never asked yet — the switch just shows OFF until you flip it
  try{
    const r = await wcall('/api/worker/status', 'GET', null, tok);
    if(!r.ok){ setMsg(r.message || 'The server refused the request.', 'error', 'poll'); return; }
    lastStatus = r.status;
    readOnly = r.role === 'view';
    if(msg.src === 'poll') msg = { text: '', kind: '', key: '', src: '' }; // the earlier poll problem is gone
    render();
  }catch(err){
    setMsg(`Can't reach the server: ${err.message}`, 'error', 'poll');
  }
}

async function turnOn(){
  const sel = selection();
  const f = fu();
  const name = nameOf(sel.exchange);
  if(!sel.verified){ setMsg(`No verified ${sel.mode} key for ${name} in this browser — connect and verify one in API Keys first.`, 'error'); return; }
  if(f.liveRunning && f.liveArmed && f.liveExchange === sel.exchange){
    setMsg(`The in-browser bot is running on ${name}. Stop it first — two bots on one account would double up trades.`, 'error'); return;
  }
  const { settings, problems } = readSettings();
  if(problems.length){ setMsg(`Not started — fill in: ${problems.join(', ')}.`, 'error'); return; }
  if(sel.mode === 'live' && !window.confirm(`Run ${name} on the server with REAL funds?\n\nIt will place real orders 24/7, using the settings currently on this page, until you switch it off.`)) return;
  const tok = getToken(true);
  if(!tok){ setMsg('The access token is needed to switch the server on.', 'error'); return; }

  const { _enabledIds, ...sendSettings } = settings;
  let quantCfg;
  try{
    quantCfg = getQuantCfg({ minConfidence: settings.minConfidence, riskPct: settings.riskPctPerTrade, highSelectivity: settings.highSelectivity });
    delete quantCfg.log;
  }catch(e){ quantCfg = undefined; }

  const body = {
    armPhrase: ARM_PHRASE, explicitSettings: true, // the switch itself is the deliberate act; Live also got the confirm() above
    exchange: sel.exchange, mode: sel.mode,
    apiKey: sel.cred.apiKey, secretKey: sel.cred.secretKey, passphrase: sel.cred.passphrase || '',
    ...sendSettings, quantCfg,
    tzOffsetMinutes: -new Date().getTimezoneOffset(), // so "daily" targets reset at YOUR midnight
  };
  const r = await wcall('/api/worker/arm', 'POST', body, tok);
  if(r.ok){
    lastStatus = r.status;
    setMsg(`Running on the server: ${name} (${sel.mode}). You can close this tab now.`, 'ok');
  } else if(/^Already armed/i.test(r.message || '')){
    const s = await wcall('/api/worker/status', 'GET', null, tok).catch(() => null);
    if(s && s.ok){ lastStatus = s.status; readOnly = s.role === 'view'; }
    setMsg(`${name} is already running on the server.`, 'ok');
  } else {
    setMsg(r.message || 'The server refused to start.', 'error');
  }
}

async function turnOff(){
  const sel = selection();
  const tok = getToken(true);
  if(!tok){ setMsg('The access token is needed to switch the server off.', 'error'); return; }
  const r = await wcall('/api/worker/disarm', 'POST', { exchange: sel.exchange }, tok);
  if(r.ok){
    lastStatus = r.status;
    setMsg(`Stopped ${nameOf(sel.exchange)}. Any open position keeps its exchange-side SL/TP.` +
      (r.status && r.status.autoArm ? ' Server auto-arm is on, so it will start itself again after the next server restart.' : ''), 'ok');
  } else {
    setMsg(r.message || 'Stop failed.', 'error');
  }
}

async function onToggle(){
  if(busy) return;
  const want = $('swToggle').checked;
  busy = true; msg = { text: '', kind: '', key: '', src: '' }; render();
  try{
    if(want) await turnOn(); else await turnOff();
  }catch(err){
    setMsg(err.message === 'No verification proxy configured.' ? err.message : `Can't reach the server: ${err.message}`, 'error');
  }finally{
    busy = false;
    render(); // re-syncs the switch to what the server really reports (a refused "on" flips back to off)
  }
}

export function initServerWorker(){
  const host = $('fuServerWorker');
  if(!host) return; // not the Autotrade & Futures page
  host.innerHTML = `
    <div style="margin-top:14px;">
      <label class="toggle-check" style="font-size:13px;align-items:center;">
        <input id="swToggle" type="checkbox">
        <span>
          <b>Run on server — 24/7</b>
          <span class="pill" style="margin-left:6px;color:var(--amber);border-color:var(--amber-dim);">BROWSER CAN BE CLOSED</span><br>
          <span id="swSub" style="font-size:11.5px;"></span>
        </span>
      </label>
      <div id="swMsg" role="status" aria-live="polite" style="font-size:12px;min-height:16px;margin-top:6px;"></div>
    </div>`;

  $('swToggle').addEventListener('change', onToggle);
  render();
  setInterval(render, 1500); // cheap: keeps the switch matching the selected exchange row, and clears a message that belonged to another row
  poll();
  setInterval(poll, POLL_MS);
  document.addEventListener('visibilitychange', () => { if(document.visibilityState === 'visible') poll(); });
}
