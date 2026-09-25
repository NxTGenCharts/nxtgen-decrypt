// =============================================================
// server-worker.js — the ONE arm switch on the Autotrade & Futures page.
//
// It replaces both the old "Sign and send real orders" checkbox (+ typed phrase +
// Arm button) and the separate "Run on server — 24/7" switch. Flip it ON to arm:
//
//   Trade Mode = Auto   -> the selected exchange/network is handed to the always-on
//                          server worker (server/worker.js), so the browser can be
//                          closed. It trades with the key already verified in this
//                          browser and the values ON SCREEN right now (Risk per
//                          trade, Leverage, Min confidence, Daily Profit Target,
//                          Max Daily Loss, High Selectivity, strategies) — read at
//                          the moment you flip it. Nothing falls back to a default:
//                          a blank/invalid field refuses and names the field.
//   Trade Mode = Manual -> arms THIS TAB instead (the server has no click-to-execute
//                          step): signals wait for your Execute click.
//
// Flip it OFF to stop new entries (server session and/or this tab). An open position
// keeps its exchange-side SL/TP either way.
//
// The switch mirrors what is actually happening — /api/worker/status for the server,
// state.futures.liveArmed for the tab — so it is also ON after a refresh, or when the
// server armed itself (WORKER_AUTOARM). futures-ui.js supplies the tab-side hooks via
// setBrowserArmHooks() and listens for 'nxtgen-server-arm-changed' to keep its status
// line and Start button in step (Start is disabled while the server runs that exchange,
// so two bots can never trade one account).
//
// The access token is still required by the server (the proxy URL is public, and CORS
// does not stop curl) — it is asked for ONCE, the first time the server is needed, and
// remembered on this device; a rejected token is asked for again. Live mode asks for a
// confirm() instead of typing a phrase. Keys stay in the server's memory only; a server
// restart stops the session unless WORKER_AUTOARM is on.
// =============================================================
import { state } from './state.js';
import { RISK_DEFAULTS } from './futures/risk.js';
import { ARM_PHRASE, LIVE_ONLY_EXCHANGES } from './futures/liveEngine.js';

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

// Tab-side arming lives in futures-ui.js (it owns state.futures.liveArmed and the Start loop);
// it hands us three small functions instead of us reaching into its internals.
let hooks = null; // { isArmed(), arm(), disarm() }
export function setBrowserArmHooks(h){ hooks = h; }
const tabArmed = () => !!(hooks && hooks.isArmed());

// ---- state + rendering ----
let lastStatus = null;   // last /api/worker/status payload — the switch mirrors THIS, not a local guess
let readOnly = false;
let busy = false;
let msg = { text: '', kind: '', key: '', src: '' };

// A rejected token gets a plain instruction instead of the server's terse text; the next flip asks for it again.
const failText = (r, dflt) => r.code === 'unauthorized' ? 'The server rejected the access token — flip the switch again to enter it.' : (r.message || dflt);

function fmtUsd(n){ if(n == null) return '—'; return (n < 0 ? '-$' : '+$') + Math.abs(n).toFixed(2); }
function sessionFor(exchange){ return lastStatus && lastStatus.sessions ? lastStatus.sessions[exchange] : null; }
export function isServerArmed(exchange){ const x = sessionFor(exchange); return !!(x && x.armed); }
// The server's live numbers for an exchange (balance, trades, P&L, open position, recent trades), or null when the
// server isn't running it. futures-ui.js paints these into the same Real Balance / stats cards the in-tab bot uses,
// so a server run shows up on the page instead of only the switch turning on.
export function getServerSession(exchange){
  const x = sessionFor(exchange);
  return x && (x.armed || Object.keys(x.openPositions || {}).length) ? x : null;
}
const announceStatus = () => document.dispatchEvent(new CustomEvent('nxtgen-server-status'));

// A message belongs to the exchange/network it was raised for — switching the row clears it,
// so an old "no verified live key" can never linger under a Demo selection.
// Success notes ("Running on the server…") fade after a few seconds — they described a moment, and left up they kept
// claiming it long after the server had stopped. Errors stay until the state changes.
function setMsg(text, kind, src){
  msg = { text: text || '', kind: kind || '', key: selKey(), src: src || '', until: kind === 'ok' ? Date.now() + 7000 : 0 };
  render();
}
// Set when a session this page saw running is no longer running on the server and the user didn't stop it here.
let lostNote = null; // { exchange, mode }

let lastStateKey = null;
function render(){
  const cb = $('swToggle'); if(!cb) return;
  const sel = selection();
  const f = fu();
  const manual = f.liveTradeMode === 'manual';
  const sess = sessionFor(sel.exchange);
  const serverOn = !!(sess && sess.armed);
  const tabOn = tabArmed();
  const on = serverOn || tabOn;
  cb.checked = busy ? cb.checked : on;
  cb.disabled = busy || (readOnly && (serverOn || !manual));

  $('swPill').textContent = serverOn || (!tabOn && !manual) ? 'RUNS ON SERVER 24/7' : 'RUNS IN THIS TAB';

  const noToken = !getToken(false);
  let sub;
  if(serverOn){
    const bits = [`${nameOf(sess.exchange)} · ${sess.mode === 'live' ? 'LIVE' : 'Demo'}`, `${sess.trades || 0} trades (${sess.wins || 0}W/${sess.losses || 0}L)`, `net ${fmtUsd(sess.netPnlUsd)}`];
    const open = Object.keys(sess.openPositions || {});
    if(open.length) bits.push('open: ' + open.join(', '));
    sub = 'ON — running on the server, you can close this tab. ' + bits.join(' · ');
  } else if(tabOn){
    sub = 'ON — armed in this tab. ' + (manual ? 'Signals wait for your Execute click.' : 'Orders are placed automatically while this tab is open.') +
      (f.liveRunning ? '' : ' Press Start Live/Demo Trading to begin.');
  } else if(sess && Object.keys(sess.openPositions || {}).length){
    sub = 'OFF — no new entries. The open position keeps its exchange-side SL/TP until it closes.';
  } else if(noToken){
    sub = 'Server status not loaded on this device yet.';
  } else if(manual){
    sub = 'OFF — Manual mode arms this tab: signals wait for your Execute click.';
  } else {
    sub = `OFF — switching on runs ${nameOf(sel.exchange)} on the server, so the browser can be closed.`;
  }
  $('swSub').textContent = sub;

  let text = '', kind = '';
  if(msg.text && msg.key === selKey() && (!msg.until || Date.now() < msg.until)){ text = msg.text; kind = msg.kind; }
  if(!text && serverOn && tabOn && f.liveRunning){
    text = 'This tab is also armed and running on this exchange — switch off and on again, or trades will double up.'; kind = 'error';
  }
  if(!text && readOnly){ text = 'This token is read-only: you can watch, not switch the server on or off.'; }
  if(!text && serverOn && sess.lastMessageKind === 'error' && sess.lastMessage){ text = sess.lastMessage; kind = 'error'; }
  if(!text && lostNote && lostNote.exchange === sel.exchange && !on){
    text = `The server is no longer running ${nameOf(lostNote.exchange)} (${lostNote.mode === 'live' ? 'LIVE' : 'Demo'}) — it restarted, went to sleep, or was stopped from another device. ` +
      `An open position keeps its exchange-side SL/TP, so check it on the exchange. Flip the switch to start again.`;
    kind = 'error';
  }
  // Other exchanges the server is running (this device's row may be a different one) — so the page never looks "idle" while it isn't.
  const others = lastStatus && lastStatus.sessions ? Object.values(lastStatus.sessions).filter(x => x.armed && x.exchange !== sel.exchange) : [];
  if(!text && others.length) text = 'Also running on the server: ' + others.map(x => `${nameOf(x.exchange)} · ${x.mode === 'live' ? 'LIVE' : 'Demo'}`).join(', ') + '.';
  // A device that has never been given the access token can't see the server at all, so "OFF" here would be a guess.
  if(!text && noToken) text = 'Not connected to the server on this device yet — enter the access token to see what it is running.';
  $('swTokenBtn').style.display = noToken ? '' : 'none';
  const el = $('swMsg');
  el.textContent = text;
  el.style.color = kind === 'error' ? 'var(--red)' : kind === 'ok' ? 'var(--green)' : 'var(--dim)';

  // Tell futures-ui.js when the server's state for the selected exchange flips (its status line + Start button).
  const stateKey = sel.exchange + ':' + serverOn;
  if(stateKey !== lastStateKey){ lastStateKey = stateKey; document.dispatchEvent(new CustomEvent('nxtgen-server-arm-changed')); }
}

async function poll(){
  if(document.visibilityState === 'hidden' || busy) return;
  const tok = getToken(false);
  if(!tok) return; // never asked yet — the switch just shows OFF until you flip it
  try{
    const r = await wcall('/api/worker/status', 'GET', null, tok);
    if(!r.ok){ setMsg(failText(r, 'The server refused the request.'), 'error', 'poll'); return; }
    const prev = lastStatus;
    lastStatus = r.status;
    readOnly = r.role === 'view';
    if(prev && prev.sessions){
      for(const [ex, p] of Object.entries(prev.sessions)){
        const now = r.status.sessions && r.status.sessions[ex];
        if(p.armed && !(now && now.armed)) lostNote = { exchange: ex, mode: p.mode };
      }
    }
    if(lostNote && r.status.sessions && r.status.sessions[lostNote.exchange] && r.status.sessions[lostNote.exchange].armed) lostNote = null;
    if(msg.src === 'poll') msg = { text: '', kind: '', key: '', src: '' }; // the earlier poll problem is gone
    render();
    announceStatus();
  }catch(err){
    setMsg(`Can't reach the server: ${err.message}`, 'error', 'poll');
  }
}

function turnOnTab(){
  const sel = selection();
  const name = nameOf(sel.exchange);
  if(!sel.verified){ setMsg(`No verified ${sel.mode} key for ${name} in this browser — connect and verify one in API Keys first.`, 'error'); return; }
  if(!hooks){ setMsg('Arming is not available on this page.', 'error'); return; }
  if(sel.mode === 'live' && !window.confirm(`Arm ${name} for REAL funds in this tab?\n\nReal orders can be placed from this tab while it stays open.`)) return;
  hooks.arm();
  setMsg(`Armed in this tab. Press Start Live/Demo Trading to begin scanning; qualifying signals wait for your Execute click.`, 'ok');
}

async function turnOnServer(){
  const sel = selection();
  const f = fu();
  const name = nameOf(sel.exchange);
  if(!sel.verified){ setMsg(`No verified ${sel.mode} key for ${name} in this browser — connect and verify one in API Keys first.`, 'error'); return; }
  if(f.liveRunning && f.liveArmed && f.liveExchange === sel.exchange){
    setMsg(`This tab is already armed and running ${name}. Stop it first — two bots on one account would double up trades.`, 'error'); return;
  }
  const { settings, problems } = readSettings();
  if(problems.length){ setMsg(`Not started — fill in: ${problems.join(', ')}.`, 'error'); return; }
  if(sel.mode === 'live' && !window.confirm(`Run ${name} on the server with REAL funds?\n\nIt will place real orders 24/7, using the settings currently on this page, until you switch it off.`)) return;
  const tok = getToken(true);
  if(!tok){ setMsg('The access token is needed to switch the server on.', 'error'); return; }

  const { _enabledIds, ...sendSettings } = settings;

  const body = {
    armPhrase: ARM_PHRASE, explicitSettings: true, // the switch itself is the deliberate act; Live also got the confirm() above
    exchange: sel.exchange, mode: sel.mode,
    apiKey: sel.cred.apiKey, secretKey: sel.cred.secretKey, passphrase: sel.cred.passphrase || '',
    ...sendSettings,
    tzOffsetMinutes: -new Date().getTimezoneOffset(), // so "daily" targets reset at YOUR midnight
  };
  const r = await wcall('/api/worker/arm', 'POST', body, tok);
  if(r.ok){
    lastStatus = r.status;
    setMsg(`Running on the server: ${name} (${sel.mode}). You can close this tab now.`, 'ok');
    announceStatus();
  } else if(/^Already armed/i.test(r.message || '')){
    const s = await wcall('/api/worker/status', 'GET', null, tok).catch(() => null);
    if(s && s.ok){ lastStatus = s.status; readOnly = s.role === 'view'; }
    setMsg(`${name} is already running on the server.`, 'ok');
  } else {
    setMsg(failText(r, 'The server refused to start.'), 'error');
  }
}

async function turnOff(){
  const sel = selection();
  const name = nameOf(sel.exchange);
  const serverOn = isServerArmed(sel.exchange);
  // The tab first: it's local and instant, so a cancelled token prompt below can't leave it armed.
  if(tabArmed()) hooks.disarm();
  if(!serverOn){ setMsg(`Stopped ${name}. Any open position keeps its exchange-side SL/TP.`, 'ok'); return; }
  const tok = getToken(true);
  if(!tok){ setMsg('The access token is needed to switch the server off.', 'error'); return; }
  const r = await wcall('/api/worker/disarm', 'POST', { exchange: sel.exchange }, tok);
  if(r.ok){
    lastStatus = r.status;
    announceStatus();
    setMsg(`Stopped ${name}. Any open position keeps its exchange-side SL/TP.` +
      (r.status && r.status.autoArm ? ' Server auto-arm is on, so it will start itself again after the next server restart.' : ''), 'ok');
  } else {
    setMsg(failText(r, 'Stop failed.'), 'error');
  }
}

async function onToggle(){
  if(busy) return;
  const want = $('swToggle').checked;
  busy = true; msg = { text: '', kind: '', key: '', src: '' }; lostNote = null; render();
  try{
    if(!want) await turnOff();
    else if(fu().liveTradeMode === 'manual') turnOnTab();
    else await turnOnServer();
  }catch(err){
    setMsg(err.message === 'No verification proxy configured.' ? err.message : `Can't reach the server: ${err.message}`, 'error');
  }finally{
    busy = false;
    render(); // re-syncs the switch to what is really armed (a refused "on" flips back to off)
  }
}

export function initServerWorker(){
  const host = $('fuServerWorker');
  if(!host) return; // not the Autotrade & Futures page
  host.innerHTML = `
    <div>
      <label class="toggle-check" style="font-size:13px;align-items:center;" title="Arm: sign and send real orders instead of simulating. Auto mode runs on the server 24/7 (the browser can be closed); Manual mode arms this tab.">
        <input id="swToggle" type="checkbox">
        <span>
          <b>Arm — sign &amp; send real orders</b>
          <span id="swPill" class="pill" style="margin-left:6px;color:var(--amber);border-color:var(--amber-dim);"></span><br>
          <span id="swSub" style="font-size:11.5px;"></span>
        </span>
      </label>
      <div id="swMsg" role="status" aria-live="polite" style="font-size:12px;min-height:16px;margin-top:6px;"></div>
      <button type="button" id="swTokenBtn" class="primary ghost" style="display:none;font-size:11px;padding:4px 10px;margin-top:6px;">Enter access token</button>
    </div>`;

  $('swToggle').addEventListener('change', onToggle);
  $('swTokenBtn').addEventListener('click', () => { if(getToken(true)) poll(); });
  render();
  setInterval(render, 1500); // cheap: keeps the switch matching the selected exchange row, and clears a message that belonged to another row
  poll();
  setInterval(poll, POLL_MS);
  document.addEventListener('visibilitychange', () => { if(document.visibilityState === 'visible') poll(); });
}
