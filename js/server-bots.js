// =============================================================
// server-bots.js — runs your Trading Bots on the always-on server, so they keep
// trading with this tab closed (see server/botEngine.js for the engine itself).
//
// What this page does:
//   * hands a freshly-created bot to the server instead of managing it here
//   * keeps the SAME API keys you verified on the API Keys tab on the server (sent
//     once, encrypted there; re-sent if you replace the key) — there is no second
//     set of keys to maintain
//   * mirrors the server's bots, daily counters and closed trades back into this
//     page every few seconds, so the lists/trade log look exactly as before
//   * routes Stop / Pause / Resume / Delete / Rename for those bots to the server
//
// Sign-in: with an ACCOUNT (see account.js) every device that signs in sees the same bots, trades and saved keys, because
// they live on the server under that account. Without accounts it falls back to the shared access token (WORKER_TOKEN):
// you are asked for it once, the first time you create a bot, and it is remembered on this device.
// If the server isn't set up (or is unreachable) a bot simply runs in this browser as
// before, and the card says so — it never silently pretends to be running 24/7.
// =============================================================
import { state } from './state.js';
import { isSignedIn, accountsAvailable, accountEmail, freshToken, openAuthModal, onAccountChange, setSavedKeys, signOut, legacyStatus, claimLegacy, savedKeys } from './account.js';

const TOKEN_KEY = 'nxtgen_server_worker_token_v1';   // shared with js/server-worker.js
const DASH_KEY = 'nxtgen_worker_dash_v1';
const PREF_KEY = 'nxtgen_bots_on_server_v1';
const MIRROR_MS = 6000;
const BOT_EXCHANGES = ['bybit', 'binance'];
const EX_NAMES = { bybit: 'Bybit', binance: 'Binance' };

let hooks = { fu: () => state.futures, onChange(){}, hasTrade: () => false, addTrade(){} };
let status = null;          // last /api/bots/status payload
let lastError = '';
let timer = null, refreshing = false, tradesSince = 0, forcePrompt = false, needAccount = false, legacyAvail = false;
const ACCOUNT = '@account';   // stand-in "token": the real credential is the signed-in session (see api())

export function initServerBots(h){
  hooks = { ...hooks, ...h };
  renderBar();
  if(isSignedIn() || savedToken()) startMirror();
  onAccountChange((type) => {
    if(type === 'signin'){ status = null; lastError = ''; tradesSince = 0; needAccount = false; stopMirror(); startMirror(); legacyStatus().then(v => { legacyAvail = v; renderBar(); }); }
    else if(type === 'signout'){ stopMirror(); status = null; lastError = ''; tradesSince = 0; hooks.onChange(); }
    renderBar();
  });
}

// ---------- token / transport ----------
function proxyBase(){ return (state.verifyProxyUrl || '').trim().replace(/\/$/, ''); }
function savedToken(){
  try{
    const own = localStorage.getItem(TOKEN_KEY);
    if(own) return own;
    return JSON.parse(localStorage.getItem(DASH_KEY) || '{}').token || '';
  }catch(e){ return ''; }
}
async function getToken(askIfMissing){
  if(isSignedIn()) return ACCOUNT;
  if(!forcePrompt && !needAccount){ const t = savedToken(); if(t) return t; }
  if(!askIfMissing) return '';
  if(accountsAvailable()){ await openAuthModal(); return isSignedIn() ? ACCOUNT : ''; }
  const t = (window.prompt('Enter your server access token (the WORKER_TOKEN you set on Render).\nIt is saved on this device, so you only do this once.') || '').trim();
  if(t){ try{ localStorage.setItem(TOKEN_KEY, t); }catch(e){ /* non-fatal */ } forcePrompt = false; }
  return t;
}
async function api(path, method, body, token){
  const base = proxyBase();
  if(!base) throw new Error('No verification proxy configured — the server connection is managed automatically — reload the page.');
  const headers = {};
  if(token === ACCOUNT){
    const t = await freshToken();
    if(!t) throw new Error('Please sign in again.');
    headers.Authorization = `Bearer ${t}`;
  } else headers['X-Worker-Token'] = token;
  if(body) headers['Content-Type'] = 'application/json';
  const res = await fetch(base + path, { method: method || 'GET', headers, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => null);
  if(!data) throw new Error('The server sent an unreadable response.');
  if(data.code === 'use_account'){ needAccount = true; }
  else if(data.code === 'unauthorized' && token !== ACCOUNT) forcePrompt = true;
  return data;
}

export function serverModePreferred(){ try{ return localStorage.getItem(PREF_KEY) !== '0'; }catch(e){ return true; } }
function setPref(on){ try{ localStorage.setItem(PREF_KEY, on ? '1' : '0'); }catch(e){ /* non-fatal */ } renderBar(); }
export const isServerBot = (bot) => !!(bot && bot.server);

async function fingerprint(apiKey){
  try{
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(apiKey)));
    return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 12);
  }catch(e){ return null; }
}
function localCred(exchange, mode){
  const c = state.exchangeCreds && state.exchangeCreds[exchange] && state.exchangeCreds[exchange][mode];
  return (c && c.apiKey && c.verified && !c.serverHeld) ? c : null;   // a placeholder for a key held on the account is not a key to send anywhere
}

// ---------- status + mirror ----------
async function fetchStatus(token){
  const r = await api('/api/bots/status', 'GET', null, token);
  if(!r.ok) throw new Error(r.message || 'The server refused the request.');
  status = r; lastError = '';
  if(r.account) setSavedKeys(r.creds);   // keep the API Keys page in step with what the account holds
  return r;
}

function applyStatus(st){
  const f = hooks.fu();
  const incoming = st.bots || [];
  const ids = new Set(incoming.map(b => b.id));
  // A bot this page remembers as a server bot, but the server no longer lists. It used to be deleted here — which made a
  // bot that is STILL TRADING on the exchange vanish from both Active and Stopped (e.g. after the server restarted and
  // came back without it). Never forget it: hand it to this page's own manager (which re-reads the exchange itself),
  // and say so on the card.
  for(const b of f.tradingBots){
    if(!b.server || ids.has(b.id)) continue;
    b.server = false;
    if(b.status === 'active'){
      b.browserOnlyNote = 'the server lost this bot (it was restarted without its saved bots), so this page took it over.';
      if(b.runtime) delete b.runtime.lastTickAtMs;
    } else if(b.status === 'deploying'){
      b.status = 'error'; b.statusIsError = true;
      b.statusMessage = 'The server lost this bot while it was deploying — some orders may be resting on the exchange. Press Stop to cancel them.';
    }
  }
  for(const sb of incoming){
    sb.server = true;
    const i = f.tradingBots.findIndex(b => b.id === sb.id);
    if(i >= 0) f.tradingBots[i] = sb; else f.tradingBots.push(sb);
  }
  // The cross-bot daily counters are authoritative on the server for server bots (the targets stay yours).
  if(st.day && !f.tradingBots.some(b => !b.server && b.status === 'active')){
    for(const k of ['tbDayKey', 'tbDayAnchorInvestmentUsd', 'tbDayRealizedUsd', 'tbDailyHalted', 'tbDailyHaltMessage']) f[k] = st.day[k];
  }
}

async function mergeTrades(token){
  const r = await api(`/api/bots/trades?since=${Math.max(0, tradesSince - 60_000)}`, 'GET', null, token);
  if(!r.ok) return;
  const fresh = (r.trades || []).filter(t => !hooks.hasTrade(t.id));
  for(const t of fresh.reverse()) hooks.addTrade(t); // oldest first, so the newest ends up on top
  for(const t of (r.trades || [])) tradesSince = Math.max(tradesSince, t.closedAtMs || 0);
}

// Re-sends a key only when you've replaced it on the API Keys tab (fingerprint differs) — it keeps the server in step
// with the keys you actually use, without ever adding an exchange you haven't opted in.
async function resyncChangedKeys(token){
  for(const k of (status && status.creds) || []){
    const c = localCred(k.exchange, k.mode);
    if(!c) continue;
    const fp = await fingerprint(c.apiKey);
    if(fp && k.fp && fp !== k.fp) await pushKey(token, k.exchange, k.mode, c).catch(() => {});
  }
}

export async function refresh(){
  if(refreshing) return;
  const token = await getToken(false);
  if(!token){ renderBar(); return; }
  refreshing = true;
  try{
    const st = await fetchStatus(token);
    if(st.enabled){
      applyStatus(st);
      await mergeTrades(token);
      await resyncChangedKeys(token);
      hooks.onChange();
    }
  }catch(e){ lastError = e.message || String(e); }
  finally{ refreshing = false; renderBar(); }
}

export function startMirror(){
  if(timer) return;
  refresh();
  timer = setInterval(refresh, MIRROR_MS);
}
function stopMirror(){ if(timer){ clearInterval(timer); timer = null; } }

// ---------- keys ----------
async function pushKey(token, exchange, mode, cred){
  const r = await api('/api/bots/keys', 'POST', { exchange, mode, apiKey: cred.apiKey, secretKey: cred.secretKey, passphrase: cred.passphrase || '' }, token);
  if(!r.ok) throw new Error(r.message || 'The server did not accept the key.');
  if(status) status.creds = r.creds;
  return r;
}
async function ensureKey(token, exchange, mode, cred){
  if(cred && cred.serverHeld) return;   // already on the server — that's what the placeholder means
  const saved = ((status && status.creds) || []).find(k => k.exchange === exchange && k.mode === mode);
  const fp = await fingerprint(cred.apiKey);
  if(saved && fp && saved.fp === fp) return;
  await pushKey(token, exchange, mode, cred);
}

// Sends every key you've verified (Bybit / Binance, live + demo) — the same ones the rest of the app uses.
export async function syncAllKeys(){
  const token = await getToken(true);
  if(!token) return { ok: false, message: 'No access token entered.' };
  try{
    await fetchStatus(token);
    if(!status.enabled) return { ok: false, message: status.reason || 'Server bots are not enabled.' };
    let n = 0;
    for(const ex of BOT_EXCHANGES) for(const mode of ['live', 'demo']){
      const c = localCred(ex, mode);
      if(c){ await pushKey(token, ex, mode, c); n++; }
    }
    startMirror(); await refresh();
    return { ok: true, message: n ? `Saved ${n} key${n === 1 ? '' : 's'} ${token === ACCOUNT ? 'on your account' : 'on the server'}.` : 'No verified Bybit/Binance keys found — verify one under Account → Exchange Connections first.' };
  }catch(e){ lastError = e.message; renderBar(); return { ok: false, message: e.message }; }
}

// ---------- hand-off ----------
function plainBot(bot){
  const { id, type, exchange, mode, symbol, direction, leverage, investmentUsd, config, plan, origin, nickname } = bot;
  return { id, type, exchange, mode, symbol, direction, leverage, investmentUsd, config, plan, origin, nickname };
}

// Returns { used: true } when the server took the bot over, otherwise { used: false, reason } and the
// caller deploys it in this browser exactly as before.
export async function tryHandoff(bot, cred, limits){
  if(!serverModePreferred()) return { used: false };
  if(!BOT_EXCHANGES.includes(bot.exchange)) return { used: false };
  const token = await getToken(true);
  if(!token) return { used: false, reason: isSignedIn() || accountsAvailable() ? 'you are not signed in.' : 'no server access token was entered.' };
  try{
    const st = await fetchStatus(token);
    if(!st.enabled) return { used: false, reason: `the server isn't set up for 24/7 bots yet (${st.reason || 'vault disabled'}).` };
    await ensureKey(token, bot.exchange, bot.mode, cred);
    const r = await api('/api/bots', 'POST', { bot: plainBot(bot), limits }, token);
    if(!r.ok) return { used: false, reason: r.message || 'the server refused the bot.' };
    Object.assign(bot, r.bot, { server: true });
    startMirror();
    setTimeout(refresh, 1500);
    return { used: true };
  }catch(e){
    return { used: false, reason: `the server could not be reached (${e.message}).` };
  }
}

async function act(id, action, body){
  const token = await getToken(true);
  if(!token) return { ok: false, message: 'No access token entered.' };
  try{
    const r = await api(`/api/bots/${encodeURIComponent(id)}/${action}`, 'POST', body || {}, token);
    await refresh();
    return r;
  }catch(e){ return { ok: false, message: e.message }; }
}
export const serverStop = (id) => act(id, 'stop');
export const serverPause = (id) => act(id, 'pause');
export const serverResume = (id) => act(id, 'resume');
export const serverRemove = (id) => act(id, 'delete');
export const serverRename = (id, nickname) => act(id, 'rename', { nickname });

// ---------- status bar (above the bots list) ----------
function renderBar(){
  const host = document.getElementById('sbServerHost');
  if(!host) return;
  host.textContent = '';
  const box = document.createElement('div');
  box.style.cssText = 'display:flex;flex-wrap:wrap;align-items:center;gap:10px 14px;padding:10px 14px;margin-bottom:14px;border:1px solid var(--line);border-radius:10px;font-size:12px;';
  const text = document.createElement('div');
  text.style.cssText = 'flex:1 1 280px;min-width:0;line-height:1.5;';
  const signedIn = isSignedIn();
  const hasAuth = signedIn || !!savedToken();
  const acct = signedIn ? `Signed in as ${accountEmail()} \u2014 ` : '';
  let tone = '', msg;
  if(!hasAuth || (needAccount && !signedIn)){
    msg = accountsAvailable()
      ? 'Sign in to see your bots, trades and saved exchange keys on any device \u2014 they keep trading on the server with this tab closed.'
      : 'Server mode: not connected yet. Create a bot and you\u2019ll be asked for your server access token once, then it keeps trading with this tab closed.';
  } else if(lastError){
    tone = 'var(--red)'; msg = `${acct}Server mode: can\u2019t reach the server \u2014 ${lastError}`;
  } else if(status && status.loading){
    tone = 'var(--amber)'; msg = `${acct}Server mode: the server is starting up and loading your saved bots\u2026`;
  } else if(status && !status.enabled){
    tone = 'var(--amber)'; msg = `${acct}Server mode is not set up on the server: ${status.reason || 'vault disabled'} Bots will run in this browser only.`;
  } else if(status && status.storageHealth && status.storageHealth.failing){
    tone = 'var(--red)';
    msg = `${acct}Server mode: the server can\u2019t save your bots (${status.storageHealth.lastSaveError || 'storage error'}). If it restarts it will forget them while their orders stay on the exchange \u2014 fix its storage (see server/README.md) before relying on it.`;
  } else if(status){
    const keys = (status.creds || []).map(k => `${EX_NAMES[k.exchange] || k.exchange} ${k.mode} \u2026${k.last4}`).join(', ');
    const running = (status.bots || []).filter(b => b.status === 'active' && !b.paused).length;
    tone = 'var(--green)';
    msg = `${acct}Server mode ON \u2014 ${running} bot${running === 1 ? '' : 's'} running on the server, safe to close this tab. Keys ${signedIn ? 'on your account' : 'on server'}: ${keys || 'none yet'}.`;
  } else {
    msg = `${acct}Server mode: connecting\u2026`;
  }
  text.textContent = msg;
  if(tone) text.style.color = tone;
  box.appendChild(text);

  const label = document.createElement('label');
  label.style.cssText = 'display:inline-flex;align-items:center;gap:6px;cursor:pointer;white-space:nowrap;';
  const cb = document.createElement('input');
  cb.type = 'checkbox'; cb.checked = serverModePreferred();
  cb.addEventListener('change', () => setPref(cb.checked));
  label.appendChild(cb); label.appendChild(document.createTextNode('Run new bots on the server'));
  box.appendChild(label);

  const mkBtn = (txt, fn, primary) => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = primary ? 'primary' : 'primary ghost'; b.textContent = txt;
    b.addEventListener('click', async () => { b.disabled = true; try{ await fn(text); } finally{ b.disabled = false; } });
    box.appendChild(b); return b;
  };
  const localOnly = signedIn && EX_LIST_LOCAL().some(([ex, mode]) => !savedKeys().some(k => k.exchange === ex && k.mode === mode));
  if(accountsAvailable() && !signedIn) mkBtn('Sign in', async () => { await openAuthModal(); }, true);
  if(hasAuth && (!accountsAvailable() || signedIn || savedToken())){
    mkBtn(localOnly ? 'Save my keys to account' : 'Sync API keys', async (t) => { const r = await syncAllKeys(); if(r && r.message) t.textContent = r.message; });
  }
  if(signedIn && legacyAvail){
    mkBtn('Move my earlier bots & keys here', async (t) => {
      const tok = window.prompt('To move the bots, trades and keys you had before accounts into this account, enter the server access token (WORKER_TOKEN) once.');
      if(!tok) return;
      try{
        const r = await claimLegacy(tok.trim());
        if(!r.ok){ t.textContent = r.message || 'Could not move them.'; return; }
        legacyAvail = false; const m = r.moved || {};
        t.textContent = `Moved ${m.bots || 0} bot(s), ${m.trades || 0} trade(s) and ${m.keys || 0} key(s) into your account. They keep running.`;
        await refresh();
      }catch(e){ t.textContent = e.message; }
    });
  }
  if(signedIn) mkBtn('Sign out', async () => { await signOut(); });
  host.appendChild(box);
}
// verified Bybit/Binance keys this device holds itself (not placeholders) — [exchange, mode] pairs
function EX_LIST_LOCAL(){
  const out = [];
  for(const ex of BOT_EXCHANGES) for(const mode of ['live', 'demo']) if(localCred(ex, mode)) out.push([ex, mode]);
  return out;
}
