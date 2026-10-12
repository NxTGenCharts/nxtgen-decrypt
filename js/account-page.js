// =============================================================
// account-page.js — the signed-in user's own area: Dashboard, Exchange Connections, Profile, Security, Preferences.
//
// Everything shown here comes from a real source — nothing is invented:
//   * the account's saved keys and bots/trades come from the same server endpoints the Trading Bots page already uses
//     (/api/account/keys, /api/bots/status, /api/bots/trades), always scoped to the signed-in session by the server;
//   * balances appear only after a read-only check with the exchange (POST /api/account/keys/test) and say when it ran;
//   * profile and password operations talk to Supabase Auth through js/account.js.
// When a figure is not available the card says so ("—" plus a reason) instead of showing a made-up number.
//
// The Exchange Connections form itself (renderConnectRows) lives in js/autotrade.js, which owns the key handling; this file only
// hosts it. Pure formatting/derivation helpers are exported for tests/account-page.test.mjs.
// =============================================================
import {
  whenAccountReady, onAccountChange, isSignedIn, accountEmail, accountsAvailable, accountsProblem, savedKeys, keysStatus,
  fetchProfile, updateDisplayName, changePassword, resetPassword, signOut, signOutEverywhere, testSavedKey, loadDashboardData, deleteMyAccount,
} from './account.js';
import { passwordIssues, MIN_PASSWORD } from './auth-utils.js';

const EX_NAMES = { bybit: 'Bybit', binance: 'Binance', bitget: 'Bitget', mexc: 'MEXC', gateio: 'Gate.io' };
const TABS = ['dashboard', 'exchanges', 'profile', 'security', 'preferences'];

// ---------- pure helpers (exported for tests) ----------
export const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function tabFromHash(hash){
  const h = String(hash || '').replace(/^#/, '').toLowerCase();
  if(h === 'api-keys' || h === 'keys') return 'exchanges';        // old bookmarks
  return TABS.includes(h) ? h : 'dashboard';
}
export const fmtUsd = (n, signed) => {
  if(n == null || !isFinite(n)) return '—';
  const abs = Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${n < 0 ? '-' : (signed && n > 0 ? '+' : '')}$${abs}`;
};
export const pnlClass = (n) => (n == null || !isFinite(n) || n === 0) ? '' : (n > 0 ? 'ac-pos' : 'ac-neg');
export const fmtWhen = (ms) => { if(!ms) return '—'; const d = new Date(ms); return isNaN(d) ? '—' : d.toLocaleString(); };

// A bot that is trading (or about to) right now. Paused bots hold no orders or positions, closed/error bots are not running.
export const isRunning = (b) => !!b && (b.status === 'deploying' || (b.status === 'active' && !b.paused));
export const botLabel = (b) => (b.nickname && String(b.nickname).trim()) || `${b.symbol || 'Bot'} ${b.type === 'dca' ? 'DCA' : 'Grid'}`;
export const botState = (b) => b.status === 'deploying' ? 'Deploying' : b.status === 'active' ? (b.paused ? 'Paused' : 'Running') : b.status === 'closed' ? 'Stopped' : b.status === 'error' ? 'Error' : String(b.status || '—');

// Totals for the stat cards. Realized = closed trades the server booked; unrealized = open bot positions, only where the exchange reported it.
export function summarize({ keys = [], bots = [], trades = [], day = null } = {}){
  const running = bots.filter(isRunning);
  const realized = trades.reduce((a, t) => a + (Number.isFinite(t.netUsd) ? t.netUsd : 0), 0);
  const known = running.filter(b => b.runtime && Number.isFinite(b.runtime.unrealizedUsd));
  const unrealized = known.length ? known.reduce((a, b) => a + b.runtime.unrealizedUsd, 0) : null;
  return {
    keyCount: keys.length, keysVerified: keys.filter(k => k.verifiedAt).length,
    botCount: bots.length, running: running.length, stopped: bots.filter(b => b.status === 'closed').length, errored: bots.filter(b => b.status === 'error').length,
    tradeCount: trades.length, realized: trades.length ? realized : null,
    unrealized, unrealizedUnknown: running.length - known.length,
    todayRealized: day && Number.isFinite(day.tbDayRealizedUsd) && day.tbDayKey ? day.tbDayRealizedUsd : null,
  };
}

// Recent account events, derived from data the server really holds (key saves/verifications, bot lifecycle) plus checks run on this page.
export function deriveEvents({ keys = [], bots = [], checks = {} } = {}, limit = 10){
  const ev = [];
  for(const k of keys){
    const n = `${EX_NAMES[k.exchange] || k.exchange} ${k.mode}`;
    if(k.updatedAt) ev.push({ t: k.updatedAt, text: `${n} key saved (…${k.last4})` });
    if(k.verifiedAt) ev.push({ t: k.verifiedAt, text: `${n} connection confirmed by the exchange` });
  }
  for(const b of bots){
    if(b.createdAtMs) ev.push({ t: b.createdAtMs, text: `Bot created: ${botLabel(b)} on ${EX_NAMES[b.exchange] || b.exchange} ${b.mode}` });
    if(b.stoppedAtMs) ev.push({ t: b.stoppedAtMs, text: `Bot stopped: ${botLabel(b)}` });
    if(b.status === 'error') ev.push({ t: b.stoppedAtMs || b.createdAtMs || 0, text: `Bot error: ${botLabel(b)} — ${String(b.statusMessage || 'see its log').slice(0, 140)}`, bad: true });
  }
  for(const [id, c] of Object.entries(checks)){
    if(c && c.at && c.ok === false){ const [ex, mode] = id.split(':'); ev.push({ t: c.at, text: `${EX_NAMES[ex] || ex} ${mode} connection check failed: ${String(c.message || '').slice(0, 140)}`, bad: true }); }
  }
  return ev.filter(e => e.t).sort((a, b) => b.t - a.t).slice(0, limit);
}

// ---------- DOM ----------
const $ = (id) => document.getElementById(id);
let profile = null;
let dash = null;                 // { me, status, trades } from the server, or null before the first load
let dashError = '';
const checks = {};                // `${exchange}:${mode}` -> { at, ok, balance, message } — only checks run on this page view
let loaded = false;

function boot(){
  initTabs();
  initClicks();
  initProfileAndSecurity();
  whenAccountReady().then(() => { loaded = true; refreshAll(); });
  onAccountChange((t) => { if(loaded && (t === 'keys')) { renderDashboard(); } });
}

// ----- tabs (hash-routed so each section is linkable and Back/Forward work) -----
function initTabs(){
  const show = () => {
    const which = tabFromHash(location.hash);
    document.querySelectorAll('[data-ac-section]').forEach(el => { el.hidden = el.dataset.acSection !== which; });
    document.querySelectorAll('[data-ac-tab]').forEach(a => {
      const on = a.dataset.acTab === which;
      a.classList.toggle('active', on); a.setAttribute('aria-selected', on ? 'true' : 'false');
      if(on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
    document.title = `${{ dashboard: 'Dashboard', exchanges: 'Exchange Connections', profile: 'Profile', security: 'Security', preferences: 'Preferences' }[which]} — Account — NxTGen DeCrypt`;
  };
  window.addEventListener('hashchange', show);
  show();
}

async function refreshAll(){
  if(!accountsAvailable() || !isSignedIn()) { renderDashboard(); return; }
  renderDashboard();   // paint what we know (saved keys) immediately
  const [p, d] = await Promise.all([
    fetchProfile().catch(() => null),
    loadDashboardData().catch((e) => ({ error: e.message })),
  ]);
  profile = p;
  if(d && d.error){ dashError = d.error; dash = null; }
  else { dashError = ''; dash = d; }
  renderDashboard(); renderProfile();
}

// ----- dashboard -----
function setText(id, v){ const el = $(id); if(el) el.textContent = v; }
function listHtml(rows, empty){ return rows.length ? rows.join('') : `<div class="ac-empty">${esc(empty)}</div>`; }

function renderDashboard(){
  const host = $('acStats'); if(!host) return;
  const keys = savedKeys();
  const status = dash && dash.status && dash.status.ok ? dash.status : null;
  const bots = status ? (status.bots || []) : [];
  const trades = dash && dash.trades && dash.trades.ok ? (dash.trades.trades || []) : [];
  const sum = summarize({ keys, bots, trades, day: status && status.day });

  // welcome + notices
  const name = (profile && profile.displayName) || accountEmail() || 'there';
  setText('acWelcome', `Welcome, ${name}`);
  const bits = [];
  if(accountEmail()) bits.push(accountEmail());
  if(profile && profile.createdAt) bits.push(`Member since ${new Date(profile.createdAt).toLocaleDateString()}`);
  if(profile) bits.push(profile.emailConfirmedAt ? 'Email verified' : 'Email not verified');
  setText('acWelcomeSub', bits.join(' · ') || (isSignedIn() ? '' : 'You are not signed in.'));
  const notice = $('acDashNotice');
  let msg = '';
  if(!accountsAvailable()) msg = accountsProblem() === 'unreachable' ? 'The server could not be reached, so account data is unavailable right now. Try Refresh in a moment.' : 'Accounts are not switched on for this server yet.';
  else if(dashError) msg = `Could not load your account data: ${dashError}`;
  else if(dash && dash.status && dash.status.ok === false) msg = dash.status.message || 'The server could not load your bots.';
  else if(dash && dash.me && dash.me.ok === false) msg = dash.me.message || '';
  notice.innerHTML = msg ? `<div class="msg error">${esc(msg)}</div>` : '';

  // stat cards
  setText('acStatEx', String(sum.keyCount));
  setText('acStatExSub', sum.keyCount ? `Saved on your account${sum.keysVerified ? ` · ${sum.keysVerified} re-checked` : ''}` : 'No exchanges connected yet.');
  setText('acStatBots', status ? `${sum.running} / ${sum.botCount}` : '—');
  setText('acStatBotsSub', !status ? 'Server data unavailable' : (sum.botCount ? `${sum.running} running · ${sum.stopped} stopped${sum.errored ? ` · ${sum.errored} error` : ''}` : "You haven't created any trading bots."));
  const real = $('acStatReal'); real.textContent = status ? (sum.realized == null ? '$0.00' : fmtUsd(sum.realized, true)) : '—'; real.className = `ov-value ${status ? pnlClass(sum.realized) : ''}`;
  setText('acStatRealSub', !status ? 'Server data unavailable' : (sum.tradeCount ? `${sum.tradeCount} closed trade${sum.tradeCount === 1 ? '' : 's'} booked by the server${sum.todayRealized != null ? ` · today ${fmtUsd(sum.todayRealized, true)}` : ''}` : 'Your recent trading activity will appear here.'));
  const un = $('acStatUnreal'); un.textContent = fmtUsd(sum.unrealized, true); un.className = `ov-value ${pnlClass(sum.unrealized)}`;
  setText('acStatUnrealSub', !status ? 'Server data unavailable' : (sum.running ? (sum.unrealized == null ? 'Not reported by the exchange yet' : `Open bot positions${sum.unrealizedUnknown ? ` (${sum.unrealizedUnknown} not reported)` : ''}`) : 'No open bot positions'));

  // connected exchanges
  $('acExList').innerHTML = listHtml(keys.map((k) => {
    const id = `${k.exchange}:${k.mode}`, c = checks[id];
    let state, cls = '';
    if(c && c.ok === false){ state = `Check failed — ${c.message}`; cls = 'ac-neg'; }
    else if(c && c.ok){ state = `Confirmed just now${c.balance != null ? ` · ${fmtUsd(c.balance)} USDT balance` : ''}`; cls = 'ac-pos'; }
    else if(k.verifiedAt) state = `Confirmed ${fmtWhen(k.verifiedAt)}`;
    else state = 'Saved on your account (verified when it was added)';
    return `<div class="ac-row"><div class="ac-main"><strong>${esc(EX_NAMES[k.exchange] || k.exchange)}</strong> <span class="pill">${esc(k.mode.toUpperCase())}</span> <span class="ac-dim">…${esc(k.last4)}</span></div>` +
      `<div class="ac-cell ${cls}">${esc(state)}</div><div class="ac-cell ac-cell-act"><button type="button" class="ac-iconbtn ac-mini" data-ac-test="${esc(id)}" aria-label="Test connection" title="Test connection"><svg class="icon" aria-hidden="true" focusable="false"><use href="/assets/icons.svg#i-activity"/></svg></button></div></div>`;
  }), 'No exchanges connected yet.');
  const exFoot = document.querySelector('#acExList + .ac-foot'); if(exFoot) exFoot.hidden = !keys.length;
  if(!keys.length) $('acExList').insertAdjacentHTML('beforeend', '<div class="ac-empty"><a class="primary ac-link" href="#exchanges">Connect an exchange</a> to view your portfolio.</div>');

  // bots
  setText('acBotsScope', status ? '(running on the server)' : '');
  $('acBotList').innerHTML = listHtml(bots.slice().sort((a, b) => (b.createdAtMs || 0) - (a.createdAtMs || 0)).slice(0, 12).map((b) => {
    const u = b.runtime && Number.isFinite(b.runtime.unrealizedUsd) ? b.runtime.unrealizedUsd : null;
    return `<div class="ac-row"><div class="ac-main"><strong>${esc(botLabel(b))}</strong> <span class="ac-dim">${esc(EX_NAMES[b.exchange] || b.exchange)} ${esc(b.mode)}</span></div>` +
      `<div class="ac-cell"><span class="pill ${isRunning(b) ? 'tr-yes' : ''}">${esc(botState(b))}</span></div>` +
      `<div class="ac-cell ${pnlClass(b.realizedUsd)}">${fmtUsd(b.realizedUsd, true)} <span class="ac-dim">realized</span></div>` +
      `<div class="ac-cell ${pnlClass(u)}">${fmtUsd(u, true)} <span class="ac-dim">unrealized</span></div></div>`;
  }), status ? "You haven't created any trading bots." : 'Bot data is unavailable right now.');

  // trades
  $('acTradeList').innerHTML = listHtml(trades.slice(0, 8).map((t) =>
    `<div class="ac-row"><div class="ac-main"><strong>${esc(t.symbol || '—')}</strong> <span class="ac-dim">${esc(t.side || '')}</span></div>` +
    `<div class="ac-cell ac-dim">${esc(EX_NAMES[t.exchange] || t.exchange || '')} ${esc(t.mode || '')}</div><div class="ac-cell ac-dim">${esc(fmtWhen(t.closedAtMs))}</div>` +
    `<div class="ac-cell ${pnlClass(t.netUsd)}">${fmtUsd(t.netUsd, true)}</div></div>`), 'Your recent trading activity will appear here.');

  // events
  $('acEventList').innerHTML = listHtml(deriveEvents({ keys, bots, checks }).map((e) =>
    `<div class="ac-row"><div class="ac-main ${e.bad ? 'ac-neg' : ''}">${esc(e.text)}</div><div class="ac-cell ac-dim">${esc(fmtWhen(e.t))}</div></div>`), 'Account events will appear here once you connect an exchange or create a bot.');

  // exchange tab helper line
  const ks = keysStatus(), kh = $('acKeysState');
  if(kh) kh.textContent = accountsAvailable() && isSignedIn() && ks.enabled === false ? `Server key storage is unavailable${ks.reason ? ` (${ks.reason})` : ''}. Keys added now would stay in this browser only.` : '';
}

async function runCheck(id){
  const [exchange, mode] = id.split(':');
  const r = await testSavedKey(exchange, mode).catch((e) => ({ ok: false, message: e.message }));
  if(r.ok && r.verified) checks[id] = { at: Date.now(), ok: true, balance: r.balance };
  else checks[id] = { at: Date.now(), ok: false, message: r.rejected ? `The exchange rejected this key. ${r.message || ''}`.trim() : (r.message || 'Could not reach the exchange.') };
}

function initClicks(){
document.addEventListener('click', async (e) => {
  const t = e.target.closest('[data-ac-test]');
  if(t){ t.disabled = true; t.classList.add('is-busy'); await runCheck(t.dataset.acTest); renderDashboard(); return; }
  if(e.target.closest('#acCheckAllBtn')){
    const b = $('acCheckAllBtn'), bt = b.querySelector('.ac-btn-t'); b.disabled = true; b.classList.add('is-busy'); if(bt) bt.textContent = 'Checking…';
    for(const k of savedKeys()){ await runCheck(`${k.exchange}:${k.mode}`); renderDashboard(); await new Promise(r => setTimeout(r, 3100)); }   // the server spaces checks per key; gentle on the exchanges too
    b.disabled = false; b.classList.remove('is-busy'); if(bt) bt.textContent = 'Check connections & balances';
    return;
  }
  if(e.target.closest('#acRefreshBtn')){ const b = $('acRefreshBtn'); b.disabled = true; b.classList.add('is-busy'); await refreshAll(); b.disabled = false; b.classList.remove('is-busy'); }
});
}

// ----- profile / security -----
function msg(id, text, bad){ const el = $(id); if(!el) return; el.textContent = text || ''; el.className = `ac-msg${text ? (bad ? ' bad' : ' ok') : ''}`; }

function renderProfile(){
  const dl = $('acProfileDl'); if(!dl) return;
  const ks = keysStatus();
  const rows = [
    ['Email', accountEmail() || '—'],
    ['Display name', (profile && profile.displayName) || 'Not set'],
    ['Member since', profile && profile.createdAt ? new Date(profile.createdAt).toLocaleDateString() : '—'],
    ['Email status', profile ? (profile.emailConfirmedAt ? 'Verified' : 'Not verified') : '—'],
    ['Last sign-in', profile && profile.lastSignInAt ? new Date(profile.lastSignInAt).toLocaleString() : '—'],
    ['Account status', !isSignedIn() ? 'Signed out' : (dash && dash.me && dash.me.ok === false ? `Limited — ${dash.me.message || 'server access refused'}` : 'Active')],
    ['Key storage', ks.loaded ? (ks.enabled === false ? `Unavailable${ks.reason ? ` — ${ks.reason}` : ''}` : 'Encrypted on the server') : '—'],
  ];
  dl.innerHTML = rows.map(([k, v]) => `<div class="ac-dl-row"><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('');
  const inp = $('acDisplayName'); if(inp && document.activeElement !== inp && profile) inp.value = profile.displayName || '';
  const u = $('acPwUser'); if(u) u.value = accountEmail();
}

function initProfileAndSecurity(){
  const on = (id, ev, fn) => { const el = $(id); if(el) el.addEventListener(ev, fn); };

  on('acNameSave', 'click', async () => {
    const b = $('acNameSave'); b.disabled = true; msg('acNameMsg', 'Saving…');
    try{ const n = await updateDisplayName($('acDisplayName').value); if(profile) profile.displayName = n; msg('acNameMsg', 'Your account settings have been saved.'); renderProfile(); renderDashboard(); }
    catch(err){ msg('acNameMsg', err.message || 'Could not save.', true); }
    b.disabled = false;
  });

  on('acPwForm', 'submit', async (e) => {
    e.preventDefault();
    const cur = $('acPwCurrent').value, a = $('acPwNew').value, b2 = $('acPwNew2').value;
    if(!cur) return msg('acPwMsg', 'Enter your current password.', true);
    const issues = passwordIssues(a, accountEmail());
    if(issues.length) return msg('acPwMsg', issues[0], true);
    if(a !== b2) return msg('acPwMsg', 'The new passwords do not match.', true);
    if(a === cur) return msg('acPwMsg', 'Choose a password different from the current one.', true);
    const btn = $('acPwSave'); btn.disabled = true; msg('acPwMsg', 'Changing password…');
    try{
      const r = await changePassword(cur, a);
      $('acPwCurrent').value = $('acPwNew').value = $('acPwNew2').value = '';
      msg('acPwMsg', r.otherSessionsSignedOut ? 'Password changed. Every other device has been signed out.' : 'Password changed. Other devices could not be signed out automatically — use “Sign out of all devices” below.');
    }catch(err){ msg('acPwMsg', err.message || 'Could not change the password.', true); }
    btn.disabled = false;
  });

  on('acResetBtn', 'click', async () => {
    const b = $('acResetBtn'); b.disabled = true; msg('acResetMsg', 'Sending…');
    try{ await resetPassword(accountEmail()); msg('acResetMsg', 'If that address has an account, a reset link is on its way.'); }
    catch(err){ msg('acResetMsg', err.message || 'Could not send the email.', true); }
    b.disabled = false;
  });

  const out = () => { signOut(); };
  on('acSignOutBtn', 'click', out);
  on('acSignOutHere', 'click', out);
  on('acSignOutAll', 'click', async () => {
    if(!window.confirm('Sign out of every device, including this one?')) return;
    const b = $('acSignOutAll'); b.disabled = true; msg('acSessMsg', 'Signing out…');
    try{ await signOutEverywhere(); }catch(err){ msg('acSessMsg', err.message || 'Could not sign out everywhere.', true); b.disabled = false; }
  });

  // delete account
  const email = $('acDeleteEmail'), del = $('acDeleteBtn');
  const sync = () => { if(del) del.disabled = !email || !accountEmail() || email.value.trim().toLowerCase() !== accountEmail().toLowerCase(); };
  on('acDeleteEmail', 'input', sync);
  on('acDeleteBtn', 'click', async () => {
    if(!window.confirm('Permanently delete your account, saved exchange keys and bots on the server? This cannot be undone.')) return;
    del.disabled = true; msg('acDeleteMsg', 'Deleting…');
    try{
      const r = await deleteMyAccount(email.value.trim());
      if(!r.ok){ msg('acDeleteMsg', r.message || 'The server refused to delete the account.', true); sync(); }
      else if(r.note) msg('acDeleteMsg', `Your data was erased. ${r.note}`);
    }catch(err){ msg('acDeleteMsg', err.message || 'Could not delete the account.', true); sync(); }
  });
}

// Start only on the Account page (this module is also importable in Node for the helper tests).
if(typeof document !== 'undefined' && document.getElementById('panelAccount')) boot();
