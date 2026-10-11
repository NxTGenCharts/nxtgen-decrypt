// Browser-side sign-in flows (js/account.js) with a stubbed DOM and a fake Supabase + proxy.   Run: node tests/auth-flows.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';

const mkStore = () => { const m = new Map(); return { m, getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k) }; };
const local = mkStore(), sess = mkStore();
globalThis.localStorage = local; globalThis.sessionStorage = sess;
const nav = { assigned: [], replaced: [] };
globalThis.location = { origin: 'https://nxtgendecrypt.site', pathname: '/utilities-tools/', search: '', assign: (u) => nav.assigned.push(u), replace: (u) => nav.replaced.push(u) };
globalThis.document = { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], addEventListener(){}, createElement: () => ({ style: {}, addEventListener(){}, appendChild(){}, classList: { add(){}, remove(){} } }), hidden: false, body: { appendChild(){} } };
globalThis.window = globalThis;
globalThis.addEventListener = () => {};
globalThis.dispatchEvent = () => {};
globalThis.CustomEvent = class { constructor(type){ this.type = type; } };

const PROXY = 'https://proxy.example', SB = 'https://proj.supabase.co';
const calls = [];
let mode = {};           // per-test switches for the fake services
let seq = 0;
const json = (o, status = 200) => ({ ok: status < 400, status, json: async () => o });
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  const headers = init.headers instanceof Headers ? Object.fromEntries(init.headers.entries()) : Object.fromEntries(Object.entries(init.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
  calls.push({ url: u, method: init.method || 'GET', headers, body: init.body });
  if(mode.offline && u.startsWith(SB)) throw new TypeError('Failed to fetch');
  if(u === `${PROXY}/api/auth/config`) return json({ ok: true, enabled: true, url: SB, anonKey: 'anon', oauth: { google: true }, proxyGate: !!mode.proxyGate });
  if(u.startsWith(`${SB}/auth/v1/token?grant_type=password`)){
    const b = JSON.parse(init.body);
    if(mode.signinStatus) return json(mode.signinBody || { msg: 'x' }, mode.signinStatus);
    if(b.password !== 'correct-horse-9') return json({ error_description: 'Invalid login credentials' }, 400);
    return json({ access_token: `eyJa.at${++seq}.s`, refresh_token: 'rt1', expires_in: 3600, user: { id: 'u-alice', email: 'a@x.io' } });
  }
  if(u.startsWith(`${SB}/auth/v1/token?grant_type=refresh_token`)) return json({ error: 'invalid_grant' }, 400);
  if(u.startsWith(`${SB}/auth/v1/signup`)) return json({ id: 'new-user', email: 'n@x.io' });          // confirmation required: no session returned
  if(u.startsWith(`${SB}/auth/v1/recover`) || u.startsWith(`${SB}/auth/v1/resend`)) return json({});
  if(u === `${SB}/auth/v1/user` && init.method === 'PUT'){
    if(init.headers.Authorization !== 'Bearer eyJrecovery.tok.en') return json({ msg: 'invalid JWT' }, 401);
    return json({ id: 'u-alice' });
  }
  if(u === `${SB}/auth/v1/user` && init.method === 'GET') return json({ id: 'u-oauth', email: 'g@x.io' });
  if(u.startsWith(`${SB}/auth/v1/logout`)) return mode.logoutFails ? json({}, 500) : json({});
  if(u === `${PROXY}/api/account/keys`) return json({ ok: true, enabled: true, creds: [] });
  if(u === `${PROXY}/api/account/me`) return json({ ok: true, legacyAvailable: false });
  return json({ ok: true });
};

const { state } = await import('../js/state.js');
state.verifyProxyUrl = PROXY;
const acct = await import('../js/account.js');
await acct.initAccount();
const reset = () => { calls.length = 0; mode = {}; nav.assigned.length = 0; nav.replaced.length = 0; };

test('"Remember me" ON keeps the login in localStorage only; OFF keeps it in sessionStorage only', async () => {
  reset();
  await acct.signIn('a@x.io', 'correct-horse-9', { remember: false });
  assert.equal(acct.isSignedIn(), true);
  assert.equal(local.getItem('nxtgen-acct-session'), null);
  assert.ok(JSON.parse(sess.getItem('nxtgen-acct-session')).access_token);
  await acct.signOut();
  assert.equal(sess.getItem('nxtgen-acct-session'), null);
  await acct.signIn('a@x.io', 'correct-horse-9', { remember: true });
  assert.ok(JSON.parse(local.getItem('nxtgen-acct-session')).access_token);
  assert.equal(sess.getItem('nxtgen-acct-session'), null);
  await acct.signOut();
  assert.equal(local.getItem('nxtgen-acct-session'), null);
});

test('wrong password gives the generic message; 429, 500 and offline are friendly and distinct', async () => {
  reset();
  await assert.rejects(acct.signIn('a@x.io', 'nope'), (e) => e.message === 'Wrong email or password.');
  mode = { signinStatus: 429, signinBody: { error_code: 'over_request_rate_limit', msg: 'rate limit' } };
  await assert.rejects(acct.signIn('a@x.io', 'x'), (e) => /Too many attempts/.test(e.message));
  mode = { signinStatus: 503, signinBody: { msg: 'upstream connect error' } };
  await assert.rejects(acct.signIn('a@x.io', 'x'), (e) => /having trouble/.test(e.message) && !/upstream/.test(e.message));
  mode = { signinStatus: 400, signinBody: { error_code: 'email_not_confirmed', msg: 'Email not confirmed' } };
  await assert.rejects(acct.signIn('a@x.io', 'x'), (e) => e.code === 'email_not_confirmed');
  mode = { offline: true };
  await assert.rejects(acct.signIn('a@x.io', 'x'), (e) => e.code === 'network' && /Could not reach/.test(e.message));
  assert.equal(acct.isSignedIn(), false);
});

test('sign-up and password-reset emails link back to this site\'s own pages; sign-up reply never says whether the address existed', async () => {
  reset();
  const r = await acct.signUp('n@x.io', 'Tr1ckyHorse-77x');
  assert.equal(r.signedIn, false);
  assert.match(r.message, /If this address can be registered/);
  assert.ok(calls.some(c => c.url === `${SB}/auth/v1/signup?redirect_to=${encodeURIComponent('https://nxtgendecrypt.site/verify-email/')}`));
  await acct.resetPassword('n@x.io');
  assert.ok(calls.some(c => c.url === `${SB}/auth/v1/recover?redirect_to=${encodeURIComponent('https://nxtgendecrypt.site/reset-password/')}`));
  await acct.resendVerification('n@x.io');
  const rs = calls.find(c => c.url.startsWith(`${SB}/auth/v1/resend`));
  assert.deepEqual(JSON.parse(rs.body), { type: 'signup', email: 'n@x.io' });
});

test('setNewPassword: PUT with the recovery token, then revoke ALL sessions; never creates a login', async () => {
  reset();
  const r = await acct.setNewPassword('eyJrecovery.tok.en', 'Tr1ckyHorse-77x');
  assert.equal(r.allSignedOut, true);
  const put = calls.find(c => c.method === 'PUT');
  assert.equal(put.headers.authorization, 'Bearer eyJrecovery.tok.en');
  assert.deepEqual(JSON.parse(put.body), { password: 'Tr1ckyHorse-77x' });
  assert.ok(calls.some(c => c.url === `${SB}/auth/v1/logout?scope=global`));
  assert.equal(acct.isSignedIn(), false); assert.equal(local.getItem('nxtgen-acct-session'), null);
  // if the revoke call fails the password is still changed, and the caller is told so it can say so honestly
  reset(); mode = { logoutFails: true };
  assert.equal((await acct.setNewPassword('eyJrecovery.tok.en', 'Tr1ckyHorse-77x')).allSignedOut, false);
  // a wrong/expired token is rejected
  reset();
  await assert.rejects(acct.setNewPassword('eyJexpired.tok.en', 'Tr1ckyHorse-77x'), (e) => e.status === 401);
});

test('a signed-in session is also ended when the password is reset from the same browser', async () => {
  reset();
  await acct.signIn('a@x.io', 'correct-horse-9', { remember: true });
  assert.equal(acct.isSignedIn(), true);
  await acct.setNewPassword('eyJrecovery.tok.en', 'Tr1ckyHorse-77x');
  assert.equal(acct.isSignedIn(), false);
});

test('Google: only offered when the server says so; completes only if THIS tab started it, and only once', async () => {
  reset();
  assert.equal(acct.oauthAvailable('google'), true); assert.equal(acct.oauthAvailable('github'), false);
  assert.throws(() => acct.startOAuth('github'));
  const tokens = { accessToken: 'eyJg.at.s', refreshToken: 'rtg', expiresIn: 3600, expiresAt: 0 };
  // a crafted link (no marker from this tab) must not log the victim into someone else's account
  await assert.rejects(acct.finishOAuth(tokens), /not valid here/);
  assert.equal(acct.isSignedIn(), false);
  acct.startOAuth('google');
  assert.equal(nav.assigned.length, 1);
  assert.equal(nav.assigned[0], `${SB}/auth/v1/authorize?provider=google&redirect_to=${encodeURIComponent('https://nxtgendecrypt.site/login/')}`);
  await acct.finishOAuth(tokens);
  assert.equal(acct.isSignedIn(), true); assert.equal(acct.accountEmail(), 'g@x.io');
  await acct.signOut();
  await assert.rejects(acct.finishOAuth(tokens), /not valid here/);          // the marker was single-use
});

test('gate OFF (server default): key-bearing requests are untouched, exactly as before accounts existed', async () => {
  reset();
  await acct.signIn('a@x.io', 'correct-horse-9', { remember: true });
  await fetch(`${PROXY}/api/verify`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ apiKey: 'real', secretKey: 's' }) });
  assert.equal(calls.at(-1).headers.authorization, undefined);
  await acct.signOut();
});
