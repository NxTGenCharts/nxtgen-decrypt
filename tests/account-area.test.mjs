// =============================================================
// Account area — server side.   Run:  node --import ./tests/_stubs/register.mjs tests/account-area.test.mjs
// Proves: keys for all five exchanges can be saved per account (Bitget needs its passphrase); the secret never comes back; the
// connection test is read-only and only reaches the caller's OWN key; account deletion is refused while a bot runs, needs the typed
// email, erases the stored data and the login, and cannot touch another account.
// =============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { attachBots } from '../server/bots.js';
import { createAuth } from '../server/auth.js';

const quiet = { warn(){}, error(){}, info(){} };
const SECRET = 'ultra-secret-signing-key-987654';
const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
const jwt = (who) => `eyJhbGciOiJIUzI1NiJ9.${who}.sig`;
const USERS = { [jwt('alice')]: { id: ALICE, email: 'a@x.io', email_confirmed_at: '2026-01-01' }, [jwt('bob')]: { id: BOB, email: 'b@x.io', email_confirmed_at: '2026-01-01' } };

function fakeApp(){
  const routes = []; const reg = (m) => (p, ...handlers) => routes.push({ method: m, p, handlers });
  return { routes, get: reg('GET'), post: reg('POST'), use(){} };
}
async function call(app, method, url, { body, bearer } = {}){
  const route = app.routes.find(r => r.method === method && r.p === url);
  assert.ok(route, `no route ${method} ${url}`);
  const headers = {}; if(bearer) headers.authorization = `Bearer ${bearer}`;
  const req = { method, path: url, body, params: {}, query: {}, get: (h) => headers[h.toLowerCase()] };
  return new Promise((resolve, reject) => {
    const res = { code: 200, status(c){ this.code = c; return this; }, json(o){ resolve({ code: this.code, body: o }); } };
    let i = 0; const next = (err) => { if(err) return reject(err); const h = route.handlers[i++]; if(h) Promise.resolve(h(req, res, next)).catch(reject); };
    next();
  });
}
function build(opts = {}){
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nxarea-'));
  const log = { verify: [], admin: [] };
  const verdict = { verified: true, rejected: false, balance: 1605.14, message: '' };
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if(u.endsWith('/auth/v1/user')){ const u2 = USERS[/Bearer (.+)/.exec(init.headers.Authorization)[1]]; return u2 ? { ok: true, status: 200, json: async () => u2 } : { ok: false, status: 401, json: async () => ({}) }; }
    if(u.includes('/auth/v1/admin/users/')){ log.admin.push({ url: u, method: init.method, apikey: init.headers.apikey }); return { ok: true, status: 200 }; }
    if(u.endsWith('/api/verify')){ log.verify.push(JSON.parse(init.body)); return { json: async () => ({ ...verdict }) }; }
    return { json: async () => ({ ok: false, message: 'sim: exchange offline' }) };
  };
  const env = { BOT_VAULT_KEY: 'k'.repeat(40), BOT_DATA_DIR: dir, WORKER_TOKEN: 't'.repeat(40), BOT_SUPABASE_URL: 'https://proj.supabase.co', SUPABASE_ANON_KEY: 'sb_publishable_x', SUPABASE_SERVICE_KEY: 'sb_secret_admin', ...(opts.env || {}) };
  const auth = createAuth({ env, log: quiet });
  const out = attachBots(app0(), { baseUrl: 'http://127.0.0.1:9', internalKey: 'int', env, log: quiet, startEngine: false, auth });
  return { dir, log, verdict, ...out };
  function app0(){ build.app = fakeApp(); return build.app; }
}
const app = () => build.app;
const k = (exchange, mode, apiKey, passphrase = '') => ({ exchange, mode, apiKey, secretKey: SECRET, passphrase });

test('keys for all five exchanges can be saved per account; the secret never comes back; Bitget needs its passphrase', async () => {
  const { dir } = build();
  for(const ex of ['bybit', 'binance', 'mexc', 'gateio']){
    const r = await call(app(), 'POST', '/api/bots/keys', { bearer: jwt('alice'), body: k(ex, 'live', `${ex.toUpperCase()}KEY1234`) });
    assert.equal(r.code, 200, ex);
    assert.equal(r.body.balance, 1605.14);
  }
  assert.equal((await call(app(), 'POST', '/api/bots/keys', { bearer: jwt('alice'), body: k('bitget', 'live', 'BITGETKEY1234') })).code, 400, 'no passphrase');
  assert.equal((await call(app(), 'POST', '/api/bots/keys', { bearer: jwt('alice'), body: k('bitget', 'live', 'BITGETKEY1234', 'pass-phrase-1') })).code, 200);
  const list = await call(app(), 'GET', '/api/account/keys', { bearer: jwt('alice') });
  assert.equal(list.body.creds.length, 5);
  assert.ok(list.body.creds.every(c => c.verifiedAt > 0), 'each key records when the exchange confirmed it');
  assert.ok(list.body.creds.find(c => c.exchange === 'bitget').hasPassphrase);
  const text = JSON.stringify(list.body) + JSON.stringify(await call(app(), 'GET', '/api/bots/status', { bearer: jwt('alice') }));
  assert.ok(!text.includes(SECRET) && !text.includes('pass-phrase-1') && !text.includes('BITGETKEY1234'));
  await new Promise(r => setTimeout(r, 50));
  assert.ok(!fs.readFileSync(path.join(dir, 'users', `${ALICE}.json`), 'utf8').includes(SECRET), 'encrypted at rest');
  assert.equal((await call(app(), 'GET', '/api/account/keys', { bearer: jwt('bob') })).body.creds.length, 0);
  assert.equal((await call(app(), 'POST', '/api/bots/keys', { bearer: jwt('alice'), body: k('kraken', 'live', 'KRAKENKEY1234') })).code, 400);
});

test('a rejected key is never stored', async () => {
  const { verdict } = build();
  verdict.verified = false; verdict.rejected = true; verdict.message = 'Invalid API-key';
  const r = await call(app(), 'POST', '/api/bots/keys', { bearer: jwt('alice'), body: k('mexc', 'live', 'MEXCKEY12345') });
  assert.equal(r.code, 400);
  assert.equal((await call(app(), 'GET', '/api/account/keys', { bearer: jwt('alice') })).body.creds.length, 0);
});

test('connection test: read-only verify of the CALLER\'s own key, reports the exchange verdict, records the time', async () => {
  const { log, verdict } = build();
  await call(app(), 'POST', '/api/bots/keys', { bearer: jwt('alice'), body: k('gateio', 'live', 'GATEKEY123456') });
  log.verify.length = 0;
  await new Promise(r => setTimeout(r, 3100));        // the per-key spacing is 3 s
  const ok = await call(app(), 'POST', '/api/account/keys/test', { bearer: jwt('alice'), body: { exchange: 'gateio', mode: 'live' } });
  assert.equal(ok.code, 200); assert.equal(ok.body.verified, true); assert.equal(ok.body.balance, 1605.14);
  assert.equal(log.verify.length, 1, 'exactly one read-only verify call, no order endpoints touched');
  assert.equal(log.verify[0].apiKey, 'GATEKEY123456');
  assert.ok(!JSON.stringify(ok.body).includes(SECRET));
  // too soon again
  assert.equal((await call(app(), 'POST', '/api/account/keys/test', { bearer: jwt('alice'), body: { exchange: 'gateio', mode: 'live' } })).code, 429);
  // bob has no such key — he can never reach alice's
  const bob = await call(app(), 'POST', '/api/account/keys/test', { bearer: jwt('bob'), body: { exchange: 'gateio', mode: 'live' } });
  assert.equal(bob.code, 404);
  assert.equal(log.verify.length, 1);
  assert.equal((await call(app(), 'POST', '/api/account/keys/test', { bearer: null, body: { exchange: 'gateio', mode: 'live' } })).code, 401);
  // a failing key is reported, not hidden
  verdict.verified = false; verdict.rejected = true; verdict.message = 'IP not allowed';
  await new Promise(r => setTimeout(r, 3100));
  const bad = await call(app(), 'POST', '/api/account/keys/test', { bearer: jwt('alice'), body: { exchange: 'gateio', mode: 'live' } });
  assert.equal(bad.body.verified, false); assert.equal(bad.body.rejected, true); assert.match(bad.body.message, /IP not allowed/);
});

test('removing a key works for any exchange and only for its owner', async () => {
  build();
  await call(app(), 'POST', '/api/bots/keys', { bearer: jwt('alice'), body: k('mexc', 'live', 'MEXCKEY12345') });
  await call(app(), 'POST', '/api/bots/keys/delete', { bearer: jwt('bob'), body: { exchange: 'mexc', mode: 'live' } });
  assert.equal((await call(app(), 'GET', '/api/account/keys', { bearer: jwt('alice') })).body.creds.length, 1, "bob's delete did nothing to alice");
  await call(app(), 'POST', '/api/bots/keys/delete', { bearer: jwt('alice'), body: { exchange: 'mexc', mode: 'live' } });
  assert.equal((await call(app(), 'GET', '/api/account/keys', { bearer: jwt('alice') })).body.creds.length, 0);
});

test('delete account: needs the typed email, refused while a bot runs, then erases data and login', async () => {
  const { dir, log, userCtx } = build();
  await call(app(), 'POST', '/api/bots/keys', { bearer: jwt('alice'), body: k('bybit', 'demo', 'ALICEKEY1234') });
  await call(app(), 'POST', '/api/bots/keys', { bearer: jwt('bob'), body: k('bybit', 'demo', 'BOBKEYBOB1234') });
  const ctx = await userCtx(ALICE);
  ctx.store.state.tradingBots.push({ id: 'b1', type: 'grid', exchange: 'bybit', mode: 'demo', symbol: 'ENAUSDT', status: 'active', paused: false });

  assert.equal((await call(app(), 'POST', '/api/account/delete', { bearer: jwt('alice'), body: { confirmEmail: 'wrong@x.io' } })).code, 400);
  assert.equal((await call(app(), 'POST', '/api/account/delete', { bearer: jwt('alice'), body: {} })).code, 400);
  const blocked = await call(app(), 'POST', '/api/account/delete', { bearer: jwt('alice'), body: { confirmEmail: 'a@x.io' } });
  assert.equal(blocked.code, 409); assert.match(blocked.body.message, /still running/);
  assert.equal(log.admin.length, 0, 'nothing removed while a bot runs');
  assert.equal((await call(app(), 'GET', '/api/account/keys', { bearer: jwt('alice') })).body.creds.length, 1);

  ctx.store.state.tradingBots[0].status = 'closed';      // the user stopped it through the normal Stop
  assert.equal((await call(app(), 'POST', '/api/account/delete', { bearer: jwt('bob'), body: { confirmEmail: 'a@x.io' } })).code, 400, "bob cannot delete alice by typing her email");
  const done = await call(app(), 'POST', '/api/account/delete', { bearer: jwt('alice'), body: { confirmEmail: 'A@X.io' } });
  assert.equal(done.code, 200); assert.equal(done.body.dataErased, true); assert.equal(done.body.loginRemoved, true);
  assert.equal(log.admin.length, 1);
  assert.match(log.admin[0].url, new RegExp(`/auth/v1/admin/users/${ALICE}$`)); assert.equal(log.admin[0].method, 'DELETE');
  await new Promise(r => setTimeout(r, 50));
  assert.ok(!fs.existsSync(path.join(dir, 'users', `${ALICE}.json`)), "alice's stored file is gone");
  assert.ok(fs.existsSync(path.join(dir, 'users', `${BOB}.json`)), "bob's data is untouched");
  assert.equal((await call(app(), 'GET', '/api/account/keys', { bearer: jwt('bob') })).body.creds.length, 1);
});

test('delete account: a paused bot (flat, no orders) does not block; without an admin key the data is still erased and the login is reported as kept', async () => {
  const { userCtx, log } = build({ env: { SUPABASE_SERVICE_KEY: '' } });
  await call(app(), 'POST', '/api/bots/keys', { bearer: jwt('alice'), body: k('bybit', 'demo', 'ALICEKEY1234') });
  (await userCtx(ALICE)).store.state.tradingBots.push({ id: 'b2', type: 'dca', exchange: 'bybit', mode: 'demo', symbol: 'SOLUSDT', status: 'active', paused: true });
  const r = await call(app(), 'POST', '/api/account/delete', { bearer: jwt('alice'), body: { confirmEmail: 'a@x.io' } });
  assert.equal(r.code, 200); assert.equal(r.body.dataErased, true); assert.equal(r.body.loginRemoved, false); assert.match(r.body.note, /admin key/);
  assert.equal(log.admin.length, 0);
});
