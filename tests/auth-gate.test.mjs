// Server-side login gate (PROXY_REQUIRES_LOGIN), negative token cache, and the public config the sign-in pages read.
//   Run: node tests/auth-gate.test.mjs        (fake fetch stands in for Supabase Auth; no network)
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAuth } from '../server/auth.js';

const quiet = { warn(){}, error(){}, info(){} };
const jwt = (w) => `eyJhbGciOiJIUzI1NiJ9.${w}.sig`;
const USERS = {
  [jwt('alice')]: { id: '11111111-1111-4111-8111-111111111111', email: 'a@x.io', email_confirmed_at: '2026-01-01' },
  [jwt('unconf')]: { id: '33333333-3333-4333-8333-333333333333', email: 'c@x.io' },
};
let lookups = 0;
globalThis.fetch = async (url, init) => {
  lookups++;
  const t = /Bearer (.+)/.exec(init.headers.Authorization)[1];
  const u = USERS[t];
  return u ? { ok: true, status: 200, json: async () => u } : { ok: false, status: 401, json: async () => ({}) };
};
const base = { BOT_SUPABASE_URL: 'https://proj.supabase.co', SUPABASE_ANON_KEY: 'sb_publishable_x' };
const mkAuth = (extra = {}) => createAuth({ env: { ...base, ...extra }, log: quiet });

// Runs a middleware against a fake request; resolves { passed, code, body, req }.
function run(mw, { method = 'POST', path = '/api/verify', bearer, internal = false } = {}){
  const headers = {}; if(bearer) headers.authorization = `Bearer ${bearer}`;
  const req = { method, path, get: (h) => headers[h.toLowerCase()] };
  return new Promise((resolve) => {
    const res = { code: 200, status(c){ this.code = c; return this; }, json(b){ resolve({ passed: false, code: this.code, body: b, req }); } };
    mw(req, res, () => resolve({ passed: true, req }));
  });
}
const isInternal = (req) => req.internal === true;

test('gate OFF (default): nothing changes, even with no login', async () => {
  const a = mkAuth();
  const mw = a.gateProxy({ isInternal });
  assert.equal(a.proxyGateOn, false);
  assert.equal((await run(mw, { path: '/api/order' })).passed, true);
});

test('gate ON: key-bearing POSTs need a valid, confirmed account session', async () => {
  const a = mkAuth({ PROXY_REQUIRES_LOGIN: 'true' });
  const mw = a.gateProxy({ isInternal });
  for(const path of ['/api/verify', '/api/balance', '/api/order', '/api/futures/order', '/api/futures/balance', '/api/ai/confirm', '/api/backtest/klines']){
    const none = await run(mw, { path });
    assert.equal(none.passed, false, `${path} must refuse a stranger`); assert.equal(none.code, 401, path);
    const bad = await run(mw, { path, bearer: jwt('mallory') });
    assert.equal(bad.code, 401, `${path} must refuse an unknown token`);
    const legacy = await run(mw, { path, bearer: 'not-a-jwt-just-a-shared-token' });
    assert.equal(legacy.code, 401, `${path}: the old shared token is not an account session`);
    const unconf = await run(mw, { path, bearer: jwt('unconf') });
    assert.equal(unconf.code, 401, `${path} must refuse an unconfirmed email`);
    const ok = await run(mw, { path, bearer: jwt('alice') });
    assert.equal(ok.passed, true, `${path} must accept alice`); assert.equal(ok.req.user.email, 'a@x.io');
  }
});

test('gate ON: reads, preflights, own-auth routes and internal loopback calls are left alone', async () => {
  const mw = mkAuth({ PROXY_REQUIRES_LOGIN: 'true' }).gateProxy({ isInternal });
  assert.equal((await run(mw, { method: 'GET', path: '/api/markets' })).passed, true);
  assert.equal((await run(mw, { method: 'GET', path: '/api/futures/snapshot' })).passed, true);
  assert.equal((await run(mw, { method: 'OPTIONS', path: '/api/order' })).passed, true);
  for(const path of ['/api/bots', '/api/bots/abc/stop', '/api/account/me', '/api/worker/arm', '/api/auth/config']) assert.equal((await run(mw, { path })).passed, true, `${path} does its own access control`);
  // look-alike prefixes are NOT exempt
  assert.equal((await run(mw, { path: '/api/botsX/steal' })).code, 401);
  assert.equal((await run(mw, { path: '/api/accounts-export' })).code, 401);
  // the bot engine / futures worker call back over loopback with the per-boot key
  const internal = new Promise((resolve) => { const req = { method: 'POST', path: '/api/futures/order', internal: true, get: () => undefined }; mw(req, { status(){ return this; }, json: (b) => resolve({ passed: false, b }) }, () => resolve({ passed: true })); });
  assert.equal((await internal).passed, true);
});

test('gate ON but accounts not configured: fails CLOSED (503), never open', async () => {
  const a = createAuth({ env: { PROXY_REQUIRES_LOGIN: 'true' }, log: quiet });
  const r = await run(a.gateProxy({ isInternal }), { path: '/api/order' });
  assert.equal(r.passed, false); assert.equal(r.code, 503); assert.equal(r.body.code, 'accounts_disabled');
});

test('a rejected token is remembered briefly: a flood costs one upstream lookup, not one per request', async () => {
  const a = mkAuth({ PROXY_REQUIRES_LOGIN: 'true' });
  const mw = a.gateProxy({ isInternal });
  lookups = 0;
  for(let i = 0; i < 25; i++) assert.equal((await run(mw, { bearer: jwt('flood') })).code, 401);
  assert.equal(lookups, 1);
  lookups = 0;
  for(let i = 0; i < 5; i++) assert.equal((await run(mw, { bearer: jwt('alice') })).passed, true);   // valid tokens were already cached
  assert.equal(lookups, 1);
});

test('/api/auth/config tells the pages what is on, and only exposes public values', async () => {
  const routes = {};
  const app = { get(p, h){ routes[p] = h; } };
  const grab = (a) => { const out = {}; a.mountConfig(app); routes['/api/auth/config']({}, { json: (b) => Object.assign(out, b) }); return out; };
  const off = grab(mkAuth());
  assert.deepEqual(off.oauth, { google: false }); assert.equal(off.proxyGate, false); assert.equal(off.enabled, true);
  const on = grab(mkAuth({ AUTH_GOOGLE_ENABLED: 'true', PROXY_REQUIRES_LOGIN: 'true' }));
  assert.equal(on.oauth.google, true); assert.equal(on.proxyGate, true);
  assert.deepEqual(Object.keys(on).sort(), ['anonKey', 'enabled', 'oauth', 'ok', 'proxyGate', 'url']);   // nothing secret leaks into this response
  assert.deepEqual(grab(createAuth({ env: {}, log: quiet })), { ok: true, enabled: false });
});
