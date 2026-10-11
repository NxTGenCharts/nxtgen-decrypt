// =============================================================
// account.js — sign in once, see the same bots, trades and exchange keys on every device.
//
//   * Accounts live in Supabase Auth. This page talks to it directly (email + password); the server only ever receives the
//     resulting session token and checks it (see server/auth.js). The server hands us the public project URL + anon key at
//     /api/auth/config, so nothing is configured here.
//   * Exchange SECRETS NEVER COME BACK TO THE BROWSER. A key you save to your account stays on the server (encrypted). Other
//     devices only learn "Bybit demo …1234 is saved" and use it through a placeholder apiKey `srv:<exchange>:<mode>:<last4>`
//     that the server swaps for the real credential — after checking your session — just before it signs a request.
//     That is how balances, margin checks and bot creation work on a phone that has never seen your key.
//   * Placeholders are in-memory only (autotrade.js never persists them) and are removed on sign-out.
//   * The login session is stored under "nxtgen-acct-session" — a HYPHEN, deliberately: backup.js only exports "nxtgen_"
//     keys, so a login can never end up inside a backup file. "Remember me" ON keeps it in localStorage (survives closing the
//     browser); OFF keeps it in sessionStorage (gone when the tab/browser closes).
//   * The sign-in PAGES (/login/, /register/, …) live in js/auth-pages.js and use the exports below; dashboard pages are
//     guarded by js/auth-gate.js (no stored session -> /login/) plus the redirects at the bottom of this file.
// =============================================================
import { state } from './state.js';
import { safeNext, DEFAULT_DESTINATION } from './auth-utils.js';

const SESSION_KEY = 'nxtgen-acct-session';
const LAST_USER_KEY = 'nxtgen-acct-last-user';
const EX = ['bybit', 'binance'];                 // exchanges the server-side bots support
const REFRESH_SKEW_MS = 90_000;

let config = null;            // { enabled, url, anonKey } from the server
let session = null;           // { access_token, refresh_token, expires_at (ms), user:{ id, email } }
let keys = [];                // masked key summaries saved on the account: [{ exchange, mode, last4, fp, updatedAt }]
let keysState = { loaded: false, enabled: true, reason: '' };
let refreshTimer = null, refreshing = null, started = false;
let persist = true;           // true = localStorage ("remember me"), false = sessionStorage (this browser session only)
let endReason = '';           // why the last session ended: 'user' | 'expired'
let configProblem = '';       // '' | 'unreachable' | 'disabled' — why accounts are not usable, when they are not
const OAUTH_PENDING_KEY = 'nxtgen-oauth-pending';
const listeners = new Set();

const proxyBase = () => (state.verifyProxyUrl || '').trim().replace(/\/$/, '');
const emit = (type) => { listeners.forEach(fn => { try{ fn(type); }catch(e){ console.error(e); } }); };
export const onAccountChange = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
export const accountsAvailable = () => !!(config && config.enabled);
export const isSignedIn = () => !!(session && session.access_token);
export const accountEmail = () => (session && session.user && session.user.email) || '';
export const accountUserId = () => (session && session.user && session.user.id) || '';
export const savedKeys = () => keys.slice();
export const hasSavedKey = (exchange, mode) => keys.some(k => k.exchange === exchange && k.mode === mode);

// ---------- storage ----------
function readStored(){
  for(const [get, p] of [[() => localStorage, true], [() => sessionStorage, false]]){
    try{ const v = JSON.parse(get().getItem(SESSION_KEY) || 'null'); if(v && v.access_token){ persist = p; return v; } }catch(e){ /* storage unavailable or corrupt: try the next one */ }
  }
  return null;
}
function writeStored(s){
  // Never leave a copy in the store we are NOT using (that would silently turn "this session only" into "remembered").
  // Only that other store is cleared first, so other tabs never see a transient "signed out" state during a refresh.
  try{ (persist ? sessionStorage : localStorage).removeItem(SESSION_KEY); }catch(e){ /* */ }
  try{
    const store = persist ? localStorage : sessionStorage;
    if(s) store.setItem(SESSION_KEY, JSON.stringify(s)); else store.removeItem(SESSION_KEY);
  }catch(e){ /* storage unavailable: the session just won't survive a reload */ }
}

// ---------- Supabase Auth (GoTrue REST) ----------
const RATE_LIMITED = /rate.?limit|too many/i;
function friendlyError(status, msg, code){
  if(/invalid login credentials/i.test(msg) || code === 'invalid_credentials') return 'Wrong email or password.';   // deliberately the same whether or not the address has an account
  if(code === 'email_not_confirmed' || /email not confirmed/i.test(msg)) return 'Confirm your email address first — check your inbox for the link.';
  if(status === 429 || RATE_LIMITED.test(code || '') || RATE_LIMITED.test(msg)) return 'Too many attempts. Please wait a minute and try again.';
  if(status >= 500) return 'The sign-in service is having trouble. Please try again shortly.';
  return msg;
}
async function gotrue(path, body, token, method){
  if(!config || !config.enabled) throw Object.assign(new Error('Accounts are not enabled on this server.'), { code: 'accounts_disabled' });
  let res;
  try{
    res = await fetch(`${config.url}/auth/v1${path}`, {
      method: method || 'POST',
      headers: { apikey: config.anonKey, 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: method === 'GET' ? undefined : JSON.stringify(body || {}),
    });
  }catch(err){
    throw Object.assign(new Error('Could not reach the sign-in service. Check your connection and try again.'), { code: 'network', status: 0 });
  }
  const data = await res.json().catch(() => ({}));
  if(!res.ok){
    const raw = data.error_description || data.msg || data.message || data.error || `Sign-in service error (${res.status})`;
    const code = data.error_code || data.code || '';
    const e = new Error(friendlyError(res.status, String(raw), String(code)));
    e.status = res.status; e.code = typeof code === 'string' ? code : '';
    if(/email not confirmed/i.test(String(raw))) e.code = 'email_not_confirmed';
    throw e;
  }
  return data;
}
function toSession(d){
  const expiresAt = d.expires_at ? d.expires_at * 1000 : Date.now() + (d.expires_in || 3600) * 1000;
  return { access_token: d.access_token, refresh_token: d.refresh_token, expires_at: expiresAt, user: { id: (d.user && d.user.id) || '', email: (d.user && d.user.email) || '' } };
}
function schedule(){
  if(refreshTimer) clearTimeout(refreshTimer);
  if(!session) return;
  const wait = Math.max(5_000, session.expires_at - Date.now() - REFRESH_SKEW_MS);
  refreshTimer = setTimeout(() => { freshToken(true).catch(() => {}); }, Math.min(wait, 2_000_000_000));
}

// A token that is valid for at least a minute more, refreshing if needed. Several tabs share one login, and a refresh token
// is single-use, so look at what another tab may have already stored before spending ours.
export async function freshToken(force){
  if(!session) return '';
  const stored = readStored();
  if(stored && stored.access_token && stored.expires_at > session.expires_at) session = stored;
  if(!force && session.expires_at - Date.now() > 60_000) return session.access_token;
  if(refreshing) return refreshing;
  refreshing = (async () => {
    try{
      const d = await gotrue('/token?grant_type=refresh_token', { refresh_token: session.refresh_token });
      session = toSession(d); writeStored(session); schedule();
      return session.access_token;
    }catch(e){
      if(e.status === 400 || e.status === 401 || e.status === 403){ await endSession(false); return ''; }   // the login is genuinely gone
      return session ? session.access_token : '';                                                              // offline: keep what we have
    }finally{ refreshing = null; }
  })();
  return refreshing;
}
export async function authHeader(){ const t = await freshToken(); return t ? { Authorization: `Bearer ${t}` } : {}; }

// Adds the session token to the few kinds of request that need it. Everything else (the public market-data polling) is
// left alone so it stays a plain, preflight-free GET.
function needsAuth(url, init){
  const base = proxyBase();
  if(!base || !url.startsWith(base + '/')) return false;
  const path = url.slice(base.length);
  if(path.startsWith('/api/bots') || path.startsWith('/api/account')) return true;
  if(path.startsWith('/api/worker') || path.startsWith('/api/auth')) return false;   // the worker has its own token; auth config is public
  // Only when the server says it requires a login for key-bearing POSTs (PROXY_REQUIRES_LOGIN=true, advertised as
  // config.proxyGate) do those requests carry the session. Otherwise they stay exactly as before, and public GETs
  // (market data) are always plain, preflight-free requests.
  if(config && config.proxyGate && init && String(init.method || 'GET').toUpperCase() === 'POST') return true;
  return !!(init && typeof init.body === 'string' && init.body.includes('"srv:'));
}
function installFetchAuth(){
  if(window.__nxtgenFetchAuth) return;
  window.__nxtgenFetchAuth = true;
  const native = window.fetch.bind(window);
  window.fetch = async function(input, init){
    try{
      const url = typeof input === 'string' ? input : (input && input.url) || String(input);
      if(isSignedIn() && needsAuth(url, init)){
        const t = await freshToken();
        if(t){
          const headers = new Headers((init && init.headers) || (typeof input !== 'string' && input.headers) || undefined);
          if(!headers.has('Authorization') && !headers.has('X-Worker-Token')){ headers.set('Authorization', `Bearer ${t}`); init = { ...(init || {}), headers }; }
        }
      }
    }catch(e){ /* never block a request over this */ }
    return native(input, init);
  };
}

// ---------- sign up / in / out ----------
const here = () => (typeof location !== 'undefined' && location.origin) || '';
const redirectTo = (path) => `redirect_to=${encodeURIComponent(here() + path)}`;

export async function signUp(email, password){
  const d = await gotrue(`/signup?${redirectTo('/verify-email/')}`, { email: String(email).trim(), password });
  if(d.access_token){ persist = true; await beginSession(toSession(d)); return { signedIn: true }; }
  // Same wording whether the address is new or already registered — Supabase answers both the same way, and so do we.
  return { signedIn: false, message: 'If this address can be registered, a confirmation link is on its way.' };
}
export async function signIn(email, password, opts){
  const d = await gotrue('/token?grant_type=password', { email: String(email).trim(), password });
  persist = !(opts && opts.remember === false);
  await beginSession(toSession(d));
}
export async function resendVerification(email){ await gotrue(`/resend?${redirectTo('/verify-email/')}`, { type: 'signup', email: String(email).trim() }); }
export async function resetPassword(email){ await gotrue(`/recover?${redirectTo('/reset-password/')}`, { email: String(email).trim() }); }

// Sets a new password using the short-lived token from a recovery email, then revokes every session of that account (all
// devices, including any open in this browser). The recovery token is never turned into a login: the user signs in afresh.
export async function setNewPassword(recoveryToken, newPassword){
  await gotrue('/user', { password: newPassword }, recoveryToken, 'PUT');
  let allSignedOut = true;
  try{ await gotrue('/logout?scope=global', {}, recoveryToken); }catch(e){ allSignedOut = false; }
  if(isSignedIn()) await endSession(false);
  return { allSignedOut };
}

// ---------- Google (optional; the server only advertises it when AUTH_GOOGLE_ENABLED=true and Supabase has the provider on) ----------
export const oauthAvailable = (provider) => !!(config && config.enabled && config.oauth && config.oauth[provider]);
export function startOAuth(provider){
  if(!oauthAvailable(provider)) throw new Error('That sign-in method is not available.');
  // A marker that only THIS browser tab holds. We refuse to finish an OAuth sign-in from a URL fragment unless we started it,
  // so a crafted link cannot sign a victim into someone else's account (login fixation).
  try{ sessionStorage.setItem(OAUTH_PENDING_KEY, String(Date.now())); }catch(e){ throw new Error('Your browser blocked storage, which sign-in needs.'); }
  location.assign(`${config.url}/auth/v1/authorize?provider=${encodeURIComponent(provider)}&${redirectTo('/login/')}`);
}
export async function finishOAuth(tokens){
  let started = 0;
  try{ started = Number(sessionStorage.getItem(OAUTH_PENDING_KEY)) || 0; sessionStorage.removeItem(OAUTH_PENDING_KEY); }catch(e){ /* */ }
  if(!started || Date.now() - started > 10 * 60_000) throw new Error('That sign-in link is not valid here. Please start again.');
  if(!tokens || !tokens.accessToken || !tokens.refreshToken) throw new Error('The sign-in did not complete. Please try again.');
  const user = await gotrue('/user', null, tokens.accessToken, 'GET');
  persist = true;
  await beginSession(toSession({ access_token: tokens.accessToken, refresh_token: tokens.refreshToken, expires_in: tokens.expiresIn, expires_at: tokens.expiresAt, user }));
}

// After signing in: can this account actually use the server? (e.g. the invite list may not include it)
export async function checkAccess(){
  try{ const r = await accountApi('/api/account/me'); return { ok: !!r.ok, code: r.code || '', message: r.message || '' }; }
  catch(e){ return { ok: false, code: 'unreachable', message: e.message }; }
}

export async function signOut(){
  const t = session && session.access_token;
  if(t) gotrue('/logout', {}, t).catch(() => {});
  await endSession(true);
}

// Server-mirrored bots belong to ONE account. Drop them whenever the account changes (or ends) so the next person to use
// this browser never sees — or worse, starts managing — someone else's bots.
function purgeMirroredBots(){
  try{
    const f = state.futures;
    if(f && Array.isArray(f.tradingBots)) f.tradingBots = f.tradingBots.filter(b => !b.server);
  }catch(e){ /* non-fatal */ }
}
async function beginSession(s){
  let last = ''; try{ last = localStorage.getItem(LAST_USER_KEY) || ''; }catch(e){ /* */ }
  if(last && last !== s.user.id) purgeMirroredBots();
  try{ localStorage.setItem(LAST_USER_KEY, s.user.id); }catch(e){ /* */ }
  session = s; writeStored(s); schedule();
  emit('signin');
  await refreshKeys();
}
async function endSession(userInitiated){
  endReason = userInitiated ? 'user' : 'expired';
  if(refreshTimer){ clearTimeout(refreshTimer); refreshTimer = null; }
  session = null; keys = []; keysState = { loaded: false, enabled: true, reason: '' };
  writeStored(null);
  if(userInitiated) purgeMirroredBots();
  clearHeldKeys();
  emit('signout');
}

// ---------- keys saved on the account ----------
async function accountApi(path, method, body){
  const t = await freshToken();
  if(!t) throw new Error('Please sign in.');
  const res = await fetch(proxyBase() + path, {
    method: method || 'GET',
    headers: { Authorization: `Bearer ${t}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  if(!data) throw new Error('The server sent an unreadable response.');
  return data;
}
export async function refreshKeys(){
  if(!isSignedIn()) return;
  try{
    const r = await accountApi('/api/account/keys');
    if(r.ok){ keys = r.creds || []; keysState = { loaded: true, enabled: r.enabled !== false, reason: r.reason || '' }; applyHeldKeys(); }
    else keysState = { loaded: true, enabled: false, reason: r.message || '' };
  }catch(e){ keysState = { ...keysState, reason: e.message }; }
  emit('keys');
}
export const keysStatus = () => ({ ...keysState });

// Called by server-bots.js with the creds list it already polls, so both stay in step without an extra request.
export function setSavedKeys(creds){
  const next = creds || [];
  if(JSON.stringify(next.map(k => [k.exchange, k.mode, k.fp])) === JSON.stringify(keys.map(k => [k.exchange, k.mode, k.fp]))) return;
  keys = next; applyHeldKeys(); emit('keys');
}

// Save (verify first, server-side) a key to the account. The server never returns the secret.
export async function saveKeyToAccount(exchange, mode, cred){
  if(!isSignedIn() || !EX.includes(exchange) || !cred || cred.serverHeld) return { ok: false, skipped: true };
  const r = await accountApi('/api/bots/keys', 'POST', { exchange, mode, apiKey: cred.apiKey, secretKey: cred.secretKey, passphrase: cred.passphrase || '' });
  if(r.ok){ keys = r.creds || keys; applyHeldKeys(); emit('keys'); }
  return r;
}
export async function removeKeyFromAccount(exchange, mode){
  const r = await accountApi('/api/bots/keys/delete', 'POST', { exchange, mode });
  if(r.ok){ keys = r.creds || []; const slot = state.exchangeCreds[exchange]; if(slot && slot[mode] && slot[mode].serverHeld) slot[mode] = null; emit('keys'); announceCreds(); }
  return r;
}

// ---------- server-held placeholders ----------
const placeholder = (k) => `srv:${k.exchange}:${k.mode}:${k.last4}`;
function announceCreds(){ try{ window.dispatchEvent(new CustomEvent('nxtgen:creds-changed')); }catch(e){ /* */ } }
function applyHeldKeys(){
  let changed = false;
  for(const ex of EX){
    const slot = state.exchangeCreds[ex]; if(!slot) continue;
    for(const mode of ['live', 'demo']){
      const k = keys.find(x => x.exchange === ex && x.mode === mode);
      const cur = slot[mode];
      if(k && (!cur || (cur.serverHeld && cur.apiKey !== placeholder(k)))){
        slot[mode] = { apiKey: placeholder(k), secretKey: 'srv', passphrase: '', connectedAt: new Date(k.updatedAt || Date.now()).toLocaleString(), connected: true, verified: true, verifyNote: 'Saved on your account — the secret stays on the server.', serverHeld: true, last4: k.last4 };
        changed = true;
      } else if(!k && cur && cur.serverHeld){ slot[mode] = null; changed = true; }
    }
  }
  if(changed) announceCreds();
}
function clearHeldKeys(){
  let changed = false;
  for(const ex of Object.keys(state.exchangeCreds)) for(const mode of ['live', 'demo']){
    const c = state.exchangeCreds[ex] && state.exchangeCreds[ex][mode];
    if(c && c.serverHeld){ state.exchangeCreds[ex][mode] = null; changed = true; }
  }
  if(changed) announceCreds();
}

// ---------- claiming the pre-account data ----------
export async function legacyStatus(){ try{ const r = await accountApi('/api/account/me'); return r.ok ? !!r.legacyAvailable : false; }catch(e){ return false; } }
export async function claimLegacy(workerToken){
  const t = await freshToken();
  const res = await fetch(proxyBase() + '/api/account/claim-legacy', { method: 'POST', headers: { Authorization: `Bearer ${t}`, 'X-Worker-Token': workerToken, 'Content-Type': 'application/json' }, body: '{}' });
  const data = await res.json().catch(() => null);
  if(!data) throw new Error('The server sent an unreadable response.');
  if(data.ok) await refreshKeys();
  return data;
}

// ---------- sign-in dialog ----------
const css = (el, s) => { el.style.cssText = s; return el; };
const h = (tag, style, text) => { const el = document.createElement(tag); if(style) css(el, style); if(text != null) el.textContent = text; return el; };

export function openAuthModal(initialMode){
  return new Promise((resolve) => {
    if(document.getElementById('nxAuthModal')) return resolve(false);
    let mode = initialMode === 'signup' ? 'signup' : 'signin';
    const back = css(h('div'), 'position:fixed;inset:0;background:rgba(0,0,0,.66);display:flex;align-items:center;justify-content:center;z-index:10000;padding:16px;');
    back.id = 'nxAuthModal';
    const box = css(h('div'), 'width:100%;max-width:380px;background:var(--panel,#111411);border:1px solid var(--line,#212a23);border-radius:12px;padding:22px;color:var(--ink,#eef1ee);font-size:13px;');
    back.setAttribute('role', 'dialog'); back.setAttribute('aria-modal', 'true');
    const title = h('div', 'font-family:var(--disp,inherit);font-size:17px;font-weight:600;margin-bottom:4px;');
    const sub = h('div', 'color:var(--dim,#7f9385);line-height:1.5;margin-bottom:14px;');
    const field = (type, ph, ac) => { const i = document.createElement('input'); i.type = type; i.placeholder = ph; i.autocomplete = ac; css(i, 'width:100%;box-sizing:border-box;margin-bottom:10px;padding:10px 12px;border-radius:8px;border:1px solid var(--line,#212a23);background:var(--panel2,#161a17);color:inherit;font:inherit;'); return i; };
    const email = field('email', 'Email', 'email'), pass = field('password', 'Password (8+ characters)', 'current-password');
    const msg = h('div', 'min-height:18px;margin:2px 0 10px;line-height:1.4;');
    const go = h('button', 'width:100%;margin-bottom:8px;'); go.type = 'button'; go.className = 'primary';
    const swap = h('button', 'background:none;border:0;color:var(--amber,#f0b429);cursor:pointer;font:inherit;padding:4px 0;'); swap.type = 'button';
    const forgot = h('button', 'background:none;border:0;color:var(--dim,#7f9385);cursor:pointer;font:inherit;padding:4px 0;float:right;', 'Forgot password?'); forgot.type = 'button';
    const close = h('button', 'background:none;border:0;color:var(--dim,#7f9385);cursor:pointer;font:inherit;position:absolute;top:10px;right:14px;font-size:18px;', '\u00d7'); close.type = 'button'; close.setAttribute('aria-label', 'Close');
    box.style.position = 'relative';
    const note = (t, bad) => { msg.textContent = t; msg.style.color = bad ? 'var(--red,#f2637a)' : 'var(--green,#3ddc97)'; };
    const paint = () => {
      title.textContent = mode === 'signup' ? 'Create your account' : 'Sign in';
      sub.textContent = mode === 'signup'
        ? 'One login for every device. Your bots keep trading on the server, and your exchange keys stay encrypted there — they are never sent back to a browser.'
        : 'See your bots, trades and saved exchange keys on any device.';
      go.textContent = mode === 'signup' ? 'Create account' : 'Sign in';
      swap.textContent = mode === 'signup' ? 'Have an account? Sign in' : 'New here? Create an account';
      pass.autocomplete = mode === 'signup' ? 'new-password' : 'current-password';
      forgot.style.display = mode === 'signup' ? 'none' : '';
      msg.textContent = '';
    };
    const done = (ok) => { document.removeEventListener('keydown', onKey); back.remove(); resolve(ok); };
    const onKey = (e) => { if(e.key === 'Escape') done(false); if(e.key === 'Enter' && !go.disabled) go.click(); };
    go.addEventListener('click', async () => {
      const em = email.value.trim(), pw = pass.value;
      if(!/^\S+@\S+\.\S+$/.test(em)) return note('Enter a valid email address.', true);
      if(pw.length < 8) return note('Use at least 8 characters.', true);
      go.disabled = true; note(mode === 'signup' ? 'Creating account\u2026' : 'Signing in\u2026');
      try{
        if(mode === 'signup'){ const r = await signUp(em, pw); if(r.signedIn) return done(true); note(r.message); mode = 'signin'; go.disabled = false; go.textContent = 'Sign in'; return; }
        await signIn(em, pw); done(true);
      }catch(e){ note(e.message || 'Something went wrong.', true); go.disabled = false; }
    });
    swap.addEventListener('click', () => { mode = mode === 'signup' ? 'signin' : 'signup'; paint(); });
    forgot.addEventListener('click', async () => {
      const em = email.value.trim(); if(!/^\S+@\S+\.\S+$/.test(em)) return note('Type your email above first.', true);
      try{ await resetPassword(em); note('If that address has an account, a reset link is on its way.'); }catch(e){ note(e.message, true); }
    });
    close.addEventListener('click', () => done(false));
    back.addEventListener('mousedown', (e) => { if(e.target === back) done(false); });
    document.addEventListener('keydown', onKey);
    box.append(close, title, sub, email, pass, msg, go, swap, forgot);
    back.appendChild(box); document.body.appendChild(back); paint(); email.focus();
  });
}

// ---------- account card (API Keys page) ----------
const EX_NAMES = { bybit: 'Bybit', binance: 'Binance' };
function mountAccountCard(host){
  const paint = () => {
    host.textContent = '';
    const wrap = css(h('div'), 'display:flex;flex-direction:column;gap:10px;');
    const say = (t, style) => wrap.appendChild(h('div', style || 'font-size:12px;color:var(--dim);line-height:1.5;max-width:760px;', t));
    const btnRow = css(h('div'), 'display:flex;flex-wrap:wrap;gap:8px;');
    const btn = (t, fn, primary) => { const b = h('button', null, t); b.type = 'button'; b.className = primary ? 'primary' : 'primary ghost'; b.addEventListener('click', fn); btnRow.appendChild(b); };
    if(!accountsAvailable()){
      say('Accounts are not switched on for this server yet. Add SUPABASE_ANON_KEY to the server\u2019s environment (see server/README.md) and redeploy \u2014 until then keys stay on this device only.');
    } else if(!isSignedIn()){
      say('Sign in to carry your exchange keys, bots and trade history to any device. Keys you save to your account are stored encrypted on the server and are never sent back to a browser \u2014 other devices use them through the server.');
      btn('Sign in', () => { location.assign(loginUrl('/api-keys/')); }, true); btn('Create account', () => { location.assign('/register/'); });
    } else {
      say(`Signed in as ${accountEmail()}`, 'font-weight:600;');
      const ks = savedKeys();
      say(ks.length
        ? 'Saved on your account (secret stays on the server): ' + ks.map(k => `${EX_NAMES[k.exchange] || k.exchange} ${k.mode} \u2026${k.last4}`).join(' \u00b7 ')
        : (keysState.enabled === false && keysState.reason ? `Server storage unavailable: ${keysState.reason}` : 'No exchange keys saved on your account yet. Connect one below and it is saved here automatically (Bybit and Binance).'));
      btn('Sign out', () => signOut());
    }
    wrap.appendChild(btnRow); host.appendChild(wrap);
  };
  paint(); onAccountChange(paint);
}

// ---------- start-up ----------
export async function initAccount(){
  if(started) return; started = true;
  installFetchAuth();
  const cardHost = document.getElementById('acctCardHost');
  if(cardHost) mountAccountCard(cardHost);
  try{
    const res = await fetch(`${proxyBase()}/api/auth/config`);
    config = await res.json();
    configProblem = config && config.enabled ? '' : 'disabled';
  }catch(e){ config = { enabled: false }; configProblem = 'unreachable'; }
  mountUserChip();
  if(!config || !config.enabled){ emit('ready'); return; }
  const stored = readStored();
  if(stored && stored.access_token){
    session = stored;
    if(session.expires_at - Date.now() < 60_000) await freshToken(true);
    if(session){ schedule(); emit('signin'); await refreshKeys(); }
  }
  window.addEventListener('storage', (e) => {          // another tab signed in/out or refreshed
    if(e.key !== SESSION_KEY) return;
    const s = readStored();
    if(s && s.access_token){ const was = isSignedIn(); session = s; schedule(); if(!was){ emit('signin'); refreshKeys(); } }
    else if(isSignedIn()){ endReason = 'user'; session = null; keys = []; clearHeldKeys(); emit('signout'); }
  });
  document.addEventListener('visibilitychange', () => { if(!document.hidden && isSignedIn()) freshToken().catch(() => {}); });
  // Dashboard pages (js/auth-gate.js marks them): leave for the login page whenever there is no valid session — now, or later
  // when it expires or the user signs out (here or in another tab).
  onAccountChange((type) => { if(type === 'signout') gateRedirect(endReason === 'user' ? 'signedout' : 'expired'); });
  if(!isSignedIn()) gateRedirect(endReason === 'expired' ? 'expired' : 'required');
  emit('ready');
}

// ---------- page protection helpers ----------
export const accountsProblem = () => configProblem;      // '' | 'unreachable' | 'disabled'
export function loginUrl(next, reason){
  const q = new URLSearchParams();
  const n = safeNext(next || (typeof location !== 'undefined' ? location.pathname + location.search : ''), here() || undefined);
  if(n !== DEFAULT_DESTINATION) q.set('next', n);
  if(reason) q.set('reason', reason);
  const qs = q.toString();
  return '/login/' + (qs ? '?' + qs : '');
}
function gateRedirect(reason){
  if(typeof window === 'undefined' || !window.__nxtgenProtected || !accountsAvailable()) return;
  location.replace(loginUrl(location.pathname + location.search, reason));
}

// Small "who am I / sign out" chip in the dashboard header.
function mountUserChip(){
  const host = document.querySelector && document.querySelector('.status-cluster');
  if(!host || !window.__nxtgenProtected || document.getElementById('nxUserChip')) return;
  const chip = css(h('div'), 'display:none;align-items:center;gap:8px;font-family:var(--mono,monospace);font-size:11px;color:var(--dim,#7f9385);max-width:100%;');
  chip.id = 'nxUserChip';
  const who = css(h('span'), 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:min(240px,50vw);');
  const out = css(h('button', null, 'Sign out'), 'background:none;border:1px solid var(--line,#212a23);border-radius:6px;color:var(--ink-dim,#aebcb2);cursor:pointer;font:inherit;padding:4px 8px;min-height:28px;');
  out.type = 'button'; out.setAttribute('aria-label', 'Sign out of NxTGen DeCrypt');
  out.addEventListener('click', () => { out.disabled = true; signOut(); });
  chip.append(who, out); host.insertBefore(chip, host.firstChild);
  const paint = () => { const on = isSignedIn(); chip.style.display = on ? 'flex' : 'none'; who.textContent = on ? accountEmail() : ''; who.title = on ? accountEmail() : ''; };
  paint(); onAccountChange(paint);
}
