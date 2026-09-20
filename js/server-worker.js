// =============================================================
// server-worker.js — "Run on server" for the Autotrade & Futures page.
//
// Arms the always-on worker (server/worker.js) for the exchange + network
// selected in the Live / Demo Trading panel above, using:
//   * that exchange's key already saved & verified in this browser, and
//   * the risk / target / strategy values CURRENTLY ON SCREEN in that same page
//     (Risk per trade, Leverage, Min confidence, Daily Profit Target, Max Daily
//     Loss, High Selectivity, and the Strategies list) — read at the moment you
//     press the button and shown in the summary first. Nothing falls back to a
//     default: if a field is blank/invalid the button refuses and says which.
//
// The worker keeps one independent session per exchange, so you can arm Bybit,
// Binance, ... side by side, each with its own settings taken from the screen at
// the time you armed it. Keys stay in the server's memory only (never written to
// disk); a server restart disarms the session, so re-press to arm again.
// =============================================================
import { state } from './state.js';
import { RISK_DEFAULTS } from './futures/risk.js';
import { STRATEGY_REGISTRY } from './futures/setups.js';
import { ARM_PHRASE, LIVE_ONLY_EXCHANGES } from './futures/liveEngine.js';
import { getQuantCfg } from './quant-ui.js';

const TOKEN_KEY = 'nxtgen_server_worker_token_v1';
const DASH_KEY = 'nxtgen_worker_dash_v1'; // the /worker/ dashboard's own prefs (same origin) — reused if it already has a token
const POLL_MS = 8000;
const EXCHANGE_NAMES = { bybit: 'Bybit', binance: 'Binance', gateio: 'Gate.io', mexc: 'MEXC', bitget: 'Bitget' };

const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fu = () => state.futures;

function proxyBase(){ return (state.verifyProxyUrl || '').trim().replace(/\/$/, ''); }

function savedToken(){
  try{
    const own = localStorage.getItem(TOKEN_KEY);
    if(own) return own;
    const dash = JSON.parse(localStorage.getItem(DASH_KEY) || '{}');
    return dash.token || '';
  }catch(e){ return ''; }
}
function saveToken(t){ try{ localStorage.setItem(TOKEN_KEY, t); }catch(e){ /* non-fatal */ } }

async function wcall(path, method, body){
  const base = proxyBase();
  if(!base) throw new Error('No verification proxy configured.');
  const headers = {};
  const tok = ($('swToken') && $('swToken').value.trim()) || savedToken();
  if(tok) headers['X-Worker-Token'] = tok;
  if(body) headers['Content-Type'] = 'application/json';
  const res = await fetch(base + path, { method: method || 'GET', headers, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => null);
  if(!data) throw new Error('The server sent an unreadable response.');
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

function strategyLabel(id){
  const r = STRATEGY_REGISTRY.find(s => s.id === id);
  return (r && r.type) || id;
}

function selection(){
  const f = fu();
  const exchange = f.liveExchange;
  const mode = LIVE_ONLY_EXCHANGES.includes(exchange) ? 'live' : (f.liveModeByExchange[exchange] || 'live');
  const cred = state.exchangeCreds[exchange] && state.exchangeCreds[exchange][mode];
  const verified = !!(cred && cred.apiKey && cred.secretKey && cred.verified);
  return { exchange, mode, cred, verified };
}

// ---- rendering ----
const dim = 'color:var(--dim);';

function summaryHtml(){
  const { exchange, mode, verified } = selection();
  const { settings: s, problems } = readSettings();
  const name = EXCHANGE_NAMES[exchange] || exchange;
  const live = mode === 'live';
  const row = (k, v) => `<div style="display:flex;justify-content:space-between;gap:12px;padding:3px 0;border-bottom:1px dashed var(--line);font-size:12.5px;"><span style="${dim}">${k}</span><span>${v}</span></div>`;
  const val = (v, suffix) => v == null ? '<span style="color:var(--red);">not set</span>' : esc(v) + (suffix || '');
  const strategies = s._enabledIds.length ? s._enabledIds.map(id => esc(strategyLabel(id))).join(', ') : '<span style="color:var(--red);">none</span>';
  return `
    <div style="font-size:13px;margin-bottom:6px;"><b>${esc(name)}</b> · <b style="color:${live ? 'var(--red)' : 'var(--green)'};">${live ? 'LIVE — real funds' : 'Demo'}</b>
      <span style="${dim}"> · ${verified ? 'verified key found in this browser' : 'no verified ' + esc(mode) + ' key — connect one in API Keys first'}</span></div>
    ${row('Risk per trade', val(s.riskPctPerTrade, '%'))}
    ${row('Leverage', val(s.leverage, 'x'))}
    ${row('Min confidence', val(s.minConfidence))}
    ${row('Daily profit target', val(s.dailyProfitTargetPct, '%'))}
    ${row('Max daily loss', val(s.maxDailyLossPct, '%'))}
    ${row('High selectivity', s.highSelectivity ? 'on' : 'off')}
    ${row('Strategies', strategies)}
    <div style="font-size:11px;${dim}margin-top:6px;">These come from the fields above on this page, read again the moment you press Arm. Change them there first if they're not what you want.${problems.length ? ` <span style="color:var(--red);">Fill in: ${esc(problems.join(', '))}.</span>` : ''}</div>`;
}

function fmtUsd(n){ if(n == null) return '—'; return (n < 0 ? '-$' : '+$') + Math.abs(n).toFixed(2); }
function fmtAgo(ms){
  if(!ms) return '—';
  const sec = Math.max(0, Math.round((Date.now() - ms) / 1000));
  return sec < 60 ? sec + 's ago' : sec < 3600 ? Math.round(sec / 60) + 'm ago' : Math.round(sec / 3600) + 'h ago';
}

function sessionsHtml(status){
  const entries = Object.values(status.sessions || {});
  if(!entries.length) return `<div style="font-size:12.5px;${dim}">Nothing is running on the server right now.</div>`;
  return entries.map(x => {
    const st = x.settings || {};
    const pos = Object.keys(x.openPositions || {});
    const posLine = pos.length ? pos.map(sym => { const p = x.openPositions[sym]; return `${esc(sym)} ${esc(p.side || '')} @ ${esc(p.entry ?? '')}`; }).join(' · ') : 'no open position';
    const used = `${st.leverage}x · ${st.riskPctPerTrade}% risk · conf ${st.minConfidence} · target ${st.dailyProfitTargetPct ?? '—'}% · loss cap ${st.maxDailyLossPct ?? '—'}%${st.highSelectivity ? ' · high selectivity' : ''}`;
    return `<div style="border:1px solid var(--line);border-radius:8px;padding:10px 12px;margin-bottom:8px;background:var(--panel2);" data-sw-exchange="${esc(x.exchange)}">
      <div style="display:flex;align-items:center;gap:10px;justify-content:space-between;flex-wrap:wrap;">
        <div style="font-size:13px;"><b>${esc(EXCHANGE_NAMES[x.exchange] || x.exchange)}</b> · ${x.mode === 'live' ? '<b style="color:var(--red);">LIVE</b>' : 'Demo'}
          <span style="margin-left:8px;font-weight:700;font-size:11px;color:${x.armed ? 'var(--green)' : 'var(--dim)'};">${x.armed ? '● ARMED' : '○ STOPPED'}</span></div>
        ${x.armed ? `<button type="button" class="primary ghost sw-stop" data-exchange="${esc(x.exchange)}" style="padding:4px 12px;">Stop</button>` : ''}
      </div>
      <div style="font-size:12px;margin-top:6px;">Trades ${x.trades || 0} (${x.wins || 0}W/${x.losses || 0}L) · Net ${fmtUsd(x.netPnlUsd)} · last cycle ${fmtAgo(x.lastCycleAtMs)}</div>
      <div style="font-size:12px;${dim}">Using: ${esc(used)}</div>
      <div style="font-size:12px;${dim}">${posLine}</div>
      ${x.lastMessage ? `<div style="font-size:11.5px;margin-top:4px;color:${x.lastMessageKind === 'error' ? 'var(--red)' : 'var(--dim)'};">${esc(x.lastMessage)}</div>` : ''}
    </div>`;
  }).join('');
}

let lastStatus = null;
let pollTimer = null;

function setMsg(text, kind){
  const el = $('swMsg'); if(!el) return;
  el.textContent = text || '';
  el.style.color = kind === 'error' ? 'var(--red)' : kind === 'ok' ? 'var(--green)' : 'var(--dim)';
}

function renderSummary(){
  const el = $('swSummary'); if(el) el.innerHTML = summaryHtml();
}

async function poll(){
  if(document.visibilityState === 'hidden') return;
  const listEl = $('swSessions'); if(!listEl) return;
  const tok = ($('swToken') && $('swToken').value.trim()) || savedToken();
  if(!tok){ listEl.innerHTML = `<div style="font-size:12.5px;${dim}">Enter the access token above to see what's running on the server.</div>`; return; }
  try{
    const r = await wcall('/api/worker/status', 'GET');
    if(!r.ok){
      listEl.innerHTML = `<div style="font-size:12.5px;color:var(--red);">${esc(r.message || 'Server refused the request.')}</div>`;
      return;
    }
    lastStatus = r.status;
    listEl.innerHTML = sessionsHtml(r.status);
    const ro = r.role === 'view';
    if($('swArmRow')) $('swArmRow').style.display = ro ? 'none' : '';
    if(ro) setMsg('This token is read-only: you can watch, not arm or stop.', null);
  }catch(err){
    listEl.innerHTML = `<div style="font-size:12.5px;color:var(--red);">Can't reach the server: ${esc(err.message)}</div>`;
  }
}

async function arm(){
  setMsg('');
  const sel = selection();
  const f = fu();
  const name = EXCHANGE_NAMES[sel.exchange] || sel.exchange;
  if(!sel.verified){ setMsg(`No verified ${sel.mode} key for ${name} in this browser — connect and verify one in API Keys first.`, 'error'); return; }
  if(f.liveRunning && f.liveArmed && f.liveExchange === sel.exchange){
    setMsg(`The in-browser bot is running on ${name}. Stop it first — two bots on one account would double up trades.`, 'error'); return;
  }
  const tok = ($('swToken').value || '').trim();
  if(!tok){ setMsg('Enter the access token first.', 'error'); return; }
  if(($('swArmPhrase').value || '').trim() !== ARM_PHRASE){ setMsg(`Type exactly "${ARM_PHRASE}" to arm.`, 'error'); return; }
  const { settings, problems } = readSettings();
  if(problems.length){ setMsg(`Not armed — fill in: ${problems.join(', ')}.`, 'error'); return; }
  saveToken(tok);

  const { _enabledIds, ...sendSettings } = settings;
  let quantCfg;
  try{
    quantCfg = getQuantCfg({ minConfidence: settings.minConfidence, riskPct: settings.riskPctPerTrade, highSelectivity: settings.highSelectivity });
    delete quantCfg.log;
  }catch(e){ quantCfg = undefined; }

  const body = {
    armPhrase: ARM_PHRASE, explicitSettings: true,
    exchange: sel.exchange, mode: sel.mode,
    apiKey: sel.cred.apiKey, secretKey: sel.cred.secretKey, passphrase: sel.cred.passphrase || '',
    ...sendSettings, quantCfg,
    tzOffsetMinutes: -new Date().getTimezoneOffset(), // so "daily" targets reset at YOUR midnight
  };
  $('swArmBtn').disabled = true;
  try{
    const r = await wcall('/api/worker/arm', 'POST', body);
    if(r.ok){
      setMsg(`Armed on the server: ${name} (${sel.mode}). You can close this tab now.`, 'ok');
      $('swArmPhrase').value = '';
      lastStatus = r.status;
      $('swSessions').innerHTML = sessionsHtml(r.status);
    } else {
      setMsg(r.message || 'The server refused to arm.', 'error');
    }
  }catch(err){
    setMsg('Request failed: ' + err.message, 'error');
  }
  $('swArmBtn').disabled = false;
}

async function stop(exchange){
  setMsg('');
  try{
    const r = await wcall('/api/worker/disarm', 'POST', { exchange });
    if(r.ok){ setMsg(`Stopped ${EXCHANGE_NAMES[exchange] || exchange}. Any open position keeps its exchange-side SL/TP.`, 'ok'); lastStatus = r.status; $('swSessions').innerHTML = sessionsHtml(r.status); }
    else setMsg(r.message || 'Stop failed.', 'error');
  }catch(err){ setMsg('Request failed: ' + err.message, 'error'); }
}

export function initServerWorker(){
  const host = $('fuServerWorker');
  if(!host) return; // not the Autotrade & Futures page
  host.innerHTML = `
    <div class="ov-block" style="margin-top:14px;border-color:var(--amber-dim);">
      <div class="ov-block-title">Run on server — 24/7 <span class="pill" style="margin-left:6px;color:var(--amber);border-color:var(--amber-dim);">BROWSER CAN BE CLOSED</span></div>
      <div style="font-size:12.5px;${dim}line-height:1.55;margin-bottom:10px;">
        Hands the exchange selected above to your server, which then runs the same Auto-mode bot without this tab. It trades with the
        <b>exact values from the fields on this page</b> (shown below) — never defaults. Each exchange runs as its own session, so you can arm several.
        The key is held in the server's memory only; if the server restarts, the session stops and you press Arm again.
      </div>
      <div id="swSummary" style="margin-bottom:12px;"></div>
      <div id="swArmRow">
        <div class="field" style="max-width:420px;">
          <label for="swToken">Access token</label>
          <input id="swToken" type="password" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Your WORKER_TOKEN — saved on this device once entered">
        </div>
        <div class="kv-field" style="display:flex;gap:8px;align-items:center;margin-top:8px;">
          <input id="swArmPhrase" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Type PLACE REAL ORDERS to arm" style="flex:1;">
          <button type="button" class="primary" id="swArmBtn">Arm on server</button>
        </div>
      </div>
      <div id="swMsg" style="font-size:12px;min-height:16px;margin-top:8px;"></div>
      <div style="font-size:11px;${dim}margin:12px 0 6px;text-transform:uppercase;letter-spacing:.04em;">Running on the server</div>
      <div id="swSessions"></div>
    </div>`;

  $('swToken').value = savedToken();
  $('swArmBtn').addEventListener('click', arm);
  $('swToken').addEventListener('change', () => { const t = $('swToken').value.trim(); if(t) saveToken(t); poll(); });
  $('swSessions').addEventListener('click', e => {
    const b = e.target.closest('.sw-stop');
    if(b) stop(b.dataset.exchange);
  });

  renderSummary();
  setInterval(renderSummary, 1500); // cheap: keeps the summary matching whatever is on screen, incl. exchange row / strategy toggles
  poll();
  pollTimer = setInterval(poll, POLL_MS);
  document.addEventListener('visibilitychange', () => { if(document.visibilityState === 'visible') poll(); });
}
