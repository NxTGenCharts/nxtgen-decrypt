// Dashboard-page behaviour (js/account.js) when the page is marked protected by js/auth-gate.js and the server requires a login
// for key-bearing requests (PROXY_REQUIRES_LOGIN=true -> config.proxyGate).   Run: node tests/auth-gate-client.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';

const mkStore = () => { const m = new Map(); return { m, getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k) }; };
const local = mkStore(), sess = mkStore();
globalThis.localStorage = local; globalThis.sessionStorage = sess;
const nav = { replaced: [] };
globalThis.location = { origin: 'https://nxtgendecrypt.site', pathname: '/utilities-tools/', search: '', hash: '#trading-bots', assign(){}, replace: (u) => nav.replaced.push(u) };
globalThis.document = { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], addEventListener(){}, createElement: () => ({ style: {}, addEventListener(){}, appendChild(){}, classList: { add(){}, remove(){} } }), hidden: false, body: { appendChild(){} } };
globalThis.window = globalThis;
globalThis.window.__nxtgenProtected = true;            // what js/auth-gate.js sets on dashboard pages
globalThis.addEventListener = () => {};
globalThis.dispatchEvent = () => {};
globalThis.CustomEvent = class { constructor(type){ this.type = type; } };

const PROXY = 'https://proxy.example', SB = 'https://proj.supabase.co';
const calls = []; let refreshDies = false, configEnabled = true;
const json = (o, status = 200) => ({ ok: status < 400, status, json: async () => o });
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  const headers = init.headers instanceof Headers ? Object.fromEntries(init.headers.entries()) : Object.fromEntries(Object.entries(init.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
  calls.push({ url: u, method: init.method || 'GET', headers });
  if(u === `${PROXY}/api/auth/config`) return json(configEnabled ? { ok: true, enabled: true, url: SB, anonKey: 'anon', oauth: { google: false }, proxyGate: true } : { ok: true, enabled: false });
  if(u.startsWith(`${SB}/auth/v1/token?grant_type=password`)) return json({ access_token: 'eyJa.at1.s', refresh_token: 'rt1', expires_in: 3600, user: { id: 'u-alice', email: 'a@x.io' } });
  if(u.startsWith(`${SB}/auth/v1/token?grant_type=refresh_token`)) return refreshDies ? json({ error: 'invalid_grant' }, 400) : json({ access_token: 'eyJa.at2.s', refresh_token: 'rt2', expires_in: 3600, user: { id: 'u-alice', email: 'a@x.io' } });
  if(u.startsWith(`${SB}/auth/v1/logout`)) return json({});
  if(u === `${PROXY}/api/account/keys`) return json({ ok: true, enabled: true, creds: [] });
  return json({ ok: true });
};

const { state } = await import('../js/state.js');
state.verifyProxyUrl = PROXY;
const acct = await import('../js/account.js');

test('protected page with no session and accounts ON: sent to /login/ remembering where it was headed', async () => {
  await acct.initAccount();
  assert.equal(acct.accountsAvailable(), true);
  assert.equal(nav.replaced.at(-1), '/login/?next=%2Futilities-tools%2F&reason=required');
});

test('gate ON: key-bearing POSTs carry the session; public GETs and the worker stay untouched', async () => {
  await acct.signIn('a@x.io', 'correct-horse-9', { remember: true });
  const post = (path, headers = {}) => fetch(`${PROXY}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ apiKey: 'real', secretKey: 's' }) });
  for(const path of ['/api/verify', '/api/balance', '/api/order', '/api/futures/order']){ await post(path); assert.equal(calls.at(-1).headers.authorization, 'Bearer eyJa.at1.s', path); }
  await fetch(`${PROXY}/api/markets`); assert.equal(calls.at(-1).headers.authorization, undefined);
  await post('/api/worker/arm'); assert.equal(calls.at(-1).headers.authorization, undefined);
  await post('/api/verify', { 'X-Worker-Token': 'w' }); assert.equal(calls.at(-1).headers.authorization, undefined);
  await fetch('https://api.binance.com/x', { method: 'POST', body: '{}' }); assert.equal(calls.at(-1).headers.authorization, undefined, 'never sent to another origin');
});

test('session that dies while a dashboard page is open -> /login/ with the "expired" notice', async () => {
  nav.replaced.length = 0; refreshDies = true;
  await acct.freshToken(true);                                            // the refresh is rejected: the login is genuinely gone
  assert.equal(acct.isSignedIn(), false);
  assert.equal(nav.replaced.at(-1), '/login/?next=%2Futilities-tools%2F&reason=expired');
});

test('explicit sign-out on a dashboard page -> /login/ with the "signed out" notice, and the stored login is gone', async () => {
  refreshDies = false; nav.replaced.length = 0;
  await acct.signIn('a@x.io', 'correct-horse-9', { remember: true });
  await acct.signOut();
  assert.equal(nav.replaced.at(-1), '/login/?next=%2Futilities-tools%2F&reason=signedout');
  assert.equal(local.getItem('nxtgen-acct-session'), null);
  assert.ok(calls.some(c => c.url.startsWith(`${SB}/auth/v1/logout`)), 'the server-side session was revoked too');
});

test('loginUrl never carries an unsafe destination', () => {
  assert.equal(acct.loginUrl('https://evil.example/overview/', 'required'), '/login/?reason=required');
  assert.equal(acct.loginUrl('//evil.example', ''), '/login/');
  assert.equal(acct.loginUrl('/account/#exchanges', 'expired'), '/login/?next=%2Faccount%2F%23exchanges&reason=expired');
  assert.equal(acct.loginUrl('/api-keys/', 'expired'), '/login/?next=%2Faccount%2F%23exchanges&reason=expired');
});
