// =============================================================
// Accounts — HTTP layer tests.   Run:  node --import ./tests/_stubs/register.mjs tests/accounts.test.mjs
// Fake Express + fake fetch (also stands in for Supabase Auth), so no network and no express needed.
// Proves: two accounts never see each other's bots/keys, secrets are never returned, a saved-key placeholder is swapped for
// the real credential only for the owning account, an unconfirmed/invalid session is refused, and the pre-account data can be
// claimed exactly once, by someone holding both a session and the old WORKER_TOKEN.
// =============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { attachBots } from '../server/bots.js';
import { createAuth } from '../server/auth.js';
import { openBotStore } from '../server/botVault.js';

const TOKEN = 't'.repeat(40);
process.env.WORKER_TOKEN = TOKEN;
const quiet = { warn(){}, error(){}, info(){} };
const SECRET = 'ultra-secret-signing-key-987654';
const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
const jwt = (who) => `eyJhbGciOiJIUzI1NiJ9.${who}.sig`;
const USERS = { [jwt('alice')]: { id: ALICE, email: 'a@x.io', email_confirmed_at: '2026-01-01' }, [jwt('bob')]: { id: BOB, email: 'b@x.io', email_confirmed_at: '2026-01-01' }, [jwt('unconf')]: { id: '33333333-3333-4333-8333-333333333333', email: 'c@x.io' } };

function fakeApp(){
  const routes = [];
  const reg = (method) => (p, ...handlers) => routes.push({ method, p, handlers });
  return { routes, get: reg('GET'), post: reg('POST'), use(){} };
}
async function call(app, method, url, { body, bearer, token, query = {} } = {}){
  const route = app.routes.find(r => r.method === method && r.p.split('/').length === url.split('/').length && r.p.split('/').every((seg, i) => seg.startsWith(':') || seg === url.split('/')[i]));
  assert.ok(route, `no route ${method} ${url}`);
  const params = {}; route.p.split('/').forEach((seg, i) => { if(seg.startsWith(':')) params[seg.slice(1)] = url.split('/')[i]; });
  const headers = {}; if(bearer) headers.authorization = `Bearer ${bearer}`; if(token) headers['x-worker-token'] = token;
  const req = { method, path: url, body, params, query, get: (h) => headers[h.toLowerCase()] };
  return new Promise((resolve, reject) => {
    const res = { code: 200, status(c){ this.code = c; return this; }, json(o){ resolve({ code: this.code, body: o, req }); } };
    let i = 0;
    const next = (err) => { if(err) return reject(err); const h = route.handlers[i++]; if(h) Promise.resolve(h(req, res, next)).catch(reject); };
    next();
  });
}
function build(opts = {}){
  const dir = opts.dir || fs.mkdtempSync(path.join(os.tmpdir(), 'nxacct-'));
  const app = fakeApp();
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if(u.endsWith('/auth/v1/user')){
      const t = /Bearer (.+)/.exec(init.headers.Authorization)[1];
      const user = USERS[t];
      return user ? { ok: true, status: 200, json: async () => user } : { ok: false, status: 401, json: async () => ({}) };
    }
    if(u.endsWith('/api/verify')) return { json: async () => ({ verified: true }) };
    return { json: async () => ({ ok: false, message: 'sim: exchange offline' }) };
  };
  const env = { BOT_VAULT_KEY: 'k'.repeat(40), BOT_DATA_DIR: dir, WORKER_TOKEN: TOKEN, BOT_SUPABASE_URL: 'https://proj.supabase.co', SUPABASE_ANON_KEY: 'sb_publishable_x', ...(opts.env || {}) };
  // BOT_SUPABASE_URL alone (no BOT_SUPABASE_KEY) keeps storage on disk, which is what these tests inspect
  const auth = createAuth({ env, log: quiet });
  const out = attachBots(app, { baseUrl: 'http://127.0.0.1:9', internalKey: 'int', env, log: quiet, startEngine: false, auth });
  return { app, dir, auth, ...out };
}
const key = (apiKey) => ({ exchange: 'bybit', mode: 'demo', apiKey, secretKey: SECRET, passphrase: '' });

test('two accounts keep separate keys; the secret is never returned', async () => {
  const { app, dir } = build();
  const a = await call(app, 'POST', '/api/bots/keys', { bearer: jwt('alice'), body: key('ALICEKEY1234') });
  assert.equal(a.code, 200);
  const sa = await call(app, 'GET', '/api/bots/status', { bearer: jwt('alice') });
  const sb = await call(app, 'GET', '/api/bots/status', { bearer: jwt('bob') });
  assert.equal(sa.body.creds.length, 1);
  assert.equal(sa.body.creds[0].last4, '1234');
  assert.equal(sb.body.creds.length, 0, "bob must not see alice's key");
  assert.equal(sa.body.account.email, 'a@x.io');
  assert.ok(!JSON.stringify(sa.body).includes(SECRET) && !JSON.stringify(sa.body).includes('ALICEKEY1234'));
  const keys = await call(app, 'GET', '/api/account/keys', { bearer: jwt('alice') });
  assert.ok(!JSON.stringify(keys.body).includes(SECRET));
  // on disk: one file per account, secret encrypted
  await new Promise(r => setTimeout(r, 50));
  const f = path.join(dir, 'users', `${ALICE}.json`);
  assert.ok(fs.existsSync(f));
  assert.ok(!fs.readFileSync(f, 'utf8').includes(SECRET));
});

test("one account's saved key cannot be decrypted by another account's store", async () => {
  const { app, dir } = build();
  await call(app, 'POST', '/api/bots/keys', { bearer: jwt('alice'), body: key('ALICEKEY1234') });
  await new Promise(r => setTimeout(r, 50));
  // copy alice's file into bob's slot: it must not decrypt (per-user derived key)
  fs.copyFileSync(path.join(dir, 'users', `${ALICE}.json`), path.join(dir, 'users', `${BOB}.json`));
  const bobStore = openBotStore({ dir, vaultKey: 'k'.repeat(40), log: quiet, userId: BOB });
  assert.equal(bobStore.getCred('bybit', 'demo'), null);
  const aliceStore = openBotStore({ dir, vaultKey: 'k'.repeat(40), log: quiet, userId: ALICE });
  assert.equal(aliceStore.getCred('bybit', 'demo').secretKey, SECRET);
});

test('invalid, expired or unconfirmed sessions are refused', async () => {
  const { app } = build();
  assert.equal((await call(app, 'GET', '/api/bots/status', { bearer: jwt('nobody') })).code, 401);
  assert.equal((await call(app, 'GET', '/api/bots/status', { bearer: jwt('unconf') })).code, 401);
  assert.equal((await call(app, 'GET', '/api/account/me', {})).code, 401);
});

test('a srv: placeholder is swapped for the real key only for its owner', async () => {
  const { app, auth } = build();
  await call(app, 'POST', '/api/bots/keys', { bearer: jwt('alice'), body: key('ALICEKEY1234') });
  const run = async (bearer, apiKey, mode = 'demo') => {
    const req = { method: 'POST', path: '/api/futures/balance', body: { exchange: 'bybit', mode, apiKey, secretKey: 'srv', passphrase: '' }, get: (h) => (h.toLowerCase() === 'authorization' && bearer ? `Bearer ${bearer}` : undefined) };
    return new Promise((resolve) => { const res = { code: 200, status(c){ this.code = c; return this; }, json(o){ resolve({ code: this.code, body: o }); } }; auth.heldKeyMiddleware(req, res, () => resolve({ code: 200, req })); });
  };
  const ok = await run(jwt('alice'), 'srv:bybit:demo:1234');
  assert.equal(ok.req.body.apiKey, 'ALICEKEY1234');
  assert.equal(ok.req.body.secretKey, SECRET);
  assert.equal((await run(jwt('bob'), 'srv:bybit:demo:1234')).code, 404, "bob has no such key — must not get alice's");
  assert.equal((await run(null, 'srv:bybit:demo:1234')).code, 401);
  assert.equal((await run(jwt('alice'), 'srv:bybit:live:1234', 'live')).code, 404, 'alice only saved a demo key');
  assert.equal((await run(jwt('alice'), 'srv:bybit:live:1234', 'demo')).code, 400, 'placeholder network must match the request');
  const mismatch = await run(jwt('alice'), 'srv:binance:demo:1234'); // body says bybit
  assert.equal(mismatch.code, 400);
  // a normal request with a real key is left alone
  const plain = await run(null, 'REALKEY123456');
  assert.equal(plain.req.body.apiKey, 'REALKEY123456');
});

test('the old shared token still works until an account claims the old data, then only that account does', async () => {
  const { app, legacy } = build();
  assert.equal((await call(app, 'POST', '/api/bots/keys', { token: TOKEN, body: key('OLDKEYABCD') })).code, 200);
  legacy.store.state.tradingBots.push({ id: 'bot_old', type: 'dca', exchange: 'bybit', mode: 'demo', symbol: 'SOLUSDT', status: 'stopped', investmentUsd: 100 });
  legacy.store.state.trades.push({ id: 't1', closedAtMs: 1000, symbol: 'SOLUSDT' });
  const me = await call(app, 'GET', '/api/account/me', { bearer: jwt('alice') });
  assert.equal(me.body.legacyAvailable, true);
  // session alone is not enough
  const noTok = await call(app, 'POST', '/api/account/claim-legacy', { bearer: jwt('alice'), body: {} });
  assert.equal(noTok.code, 401);
  const claim = await call(app, 'POST', '/api/account/claim-legacy', { bearer: jwt('alice'), token: TOKEN, body: {} });
  assert.equal(claim.code, 200);
  assert.deepEqual(claim.body.moved, { bots: 1, trades: 1, keys: 1 });
  const st = await call(app, 'GET', '/api/bots/status', { bearer: jwt('alice') });
  assert.equal(st.body.bots[0].id, 'bot_old');
  assert.equal(st.body.creds[0].last4, 'ABCD');
  const tr = await call(app, 'GET', '/api/bots/trades', { bearer: jwt('alice') });
  assert.equal(tr.body.trades.length, 1);
  // retired from the legacy side; the shared token no longer reaches anything; a second claim is refused
  assert.equal(legacy.store.listCreds().length, 0);
  assert.equal((await call(app, 'GET', '/api/bots/status', { token: TOKEN })).code, 401);
  assert.equal((await call(app, 'POST', '/api/account/claim-legacy', { bearer: jwt('bob'), token: TOKEN, body: {} })).code, 409, 'already claimed');
  const bobSt = await call(app, 'GET', '/api/bots/status', { bearer: jwt('bob') });
  assert.equal(bobSt.body.bots.length, 0, "bob never sees alice's claimed bots");
});

test('accounts disabled: bearer tokens are ignored and the shared token path is unchanged', async () => {
  const { app } = build({ env: { SUPABASE_ANON_KEY: '' } });
  assert.equal((await call(app, 'GET', '/api/bots/status', { token: TOKEN })).code, 200);
  assert.equal((await call(app, 'GET', '/api/account/me', { bearer: jwt('alice') })).code, 503);
});

test('the account cap is enforced', async () => {
  const { app } = build({ env: { BOT_MAX_USERS: '1' } });
  assert.equal((await call(app, 'GET', '/api/bots/status', { bearer: jwt('alice') })).code, 200);
  const b = await call(app, 'GET', '/api/bots/status', { bearer: jwt('bob') });
  assert.equal(b.code, 503);
  assert.match(b.body.message, /limit of 1 account/);
});

test('ALLOWED_EMAILS keeps the server invite-only (addresses and @domains)', async () => {
  const { app } = build({ env: { ALLOWED_EMAILS: 'a@x.io, @corp.example' } });
  assert.equal((await call(app, 'GET', '/api/bots/status', { bearer: jwt('alice') })).code, 200);
  const b = await call(app, 'GET', '/api/bots/status', { bearer: jwt('bob') });
  assert.equal(b.code, 403);
  assert.equal(b.body.code, 'not_invited');
  assert.equal((await call(app, 'GET', '/api/account/me', { bearer: jwt('bob') })).code, 403);
  const { app: app2 } = build({ env: { ALLOWED_EMAILS: '@x.io' } });
  assert.equal((await call(app2, 'GET', '/api/bots/status', { bearer: jwt('bob') })).code, 200, 'domain match');
});
