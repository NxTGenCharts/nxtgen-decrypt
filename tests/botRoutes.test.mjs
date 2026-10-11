// =============================================================
// Server-side bots — HTTP layer tests.   Run:  node --import ./tests/_stubs/register.mjs tests/botRoutes.test.mjs
// Uses a tiny fake Express app and a fake fetch, so it needs neither express nor a network.
// Proves: auth fails closed, keys are verified before they are stored, no secret is ever returned,
// the vault stays off without BOT_VAULT_KEY. Does NOT prove Express-specific behaviour (body parsing, CORS).
// =============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { attachBots } from '../server/bots.js';
import { buildManualGridPlan } from '../js/futures/grid.js';

const TOKEN = 't'.repeat(40);
process.env.WORKER_TOKEN = TOKEN; // requireRole() reads the admin token from the real environment
const quiet = { warn(){}, error(){}, info(){} };
const SECRET = 'ultra-secret-signing-key-987654';

function fakeApp(){
  const routes = [];
  const reg = (method) => (p, ...handlers) => routes.push({ method, p, handlers });
  return { routes, get: reg('GET'), post: reg('POST'), use(){} };
}
async function call(app, method, url, { body, token = TOKEN, query = {} } = {}){
  const route = app.routes.find(r => {
    if(r.method !== method) return false;
    const a = r.p.split('/'), b = url.split('/');
    return a.length === b.length && a.every((seg, i) => seg.startsWith(':') || seg === b[i]);
  });
  assert.ok(route, `no route ${method} ${url}`);
  const params = {}; route.p.split('/').forEach((seg, i) => { if(seg.startsWith(':')) params[seg.slice(1)] = url.split('/')[i]; });
  const headers = token ? { 'x-worker-token': token } : {};
  const req = { body, params, query, get: (h) => headers[h.toLowerCase()] };
  return new Promise((resolve, reject) => {
    const res = { code: 200, status(c){ this.code = c; return this; }, json(o){ resolve({ code: this.code, body: o }); } };
    let i = 0;
    const next = (err) => { if(err) return reject(err); const h = route.handlers[i++]; if(h) Promise.resolve(h(req, res, next)).catch(reject); };
    next();
  });
}
function build({ vaultKey = 'k'.repeat(40), verify = { verified: true } } = {}){
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nxroutes-'));
  const app = fakeApp();
  const fetched = [];
  globalThis.fetch = async (url, init) => {
    fetched.push(String(url));
    const u = String(url);
    if(u.endsWith('/api/verify')) return { json: async () => verify };
    return { json: async () => ({ ok: false, message: 'sim: exchange offline' }) };
  };
  const out = attachBots(app, { baseUrl: 'http://127.0.0.1:9', internalKey: 'int', env: { BOT_VAULT_KEY: vaultKey, BOT_DATA_DIR: dir, WORKER_TOKEN: TOKEN }, log: quiet, startEngine: false });
  return { app, dir, fetched, ...out };
}
const keyBody = { exchange: 'bybit', mode: 'demo', apiKey: 'AKIA1234ABCD', secretKey: SECRET, passphrase: '' };

test('every route fails closed without the access token', async () => {
  const { app } = build();
  for(const [m, u] of [['GET', '/api/bots/status'], ['GET', '/api/bots/trades'], ['POST', '/api/bots/keys'], ['POST', '/api/bots'], ['POST', '/api/bots/abc/stop']]){
    const r = await call(app, m, u, { token: '', body: {} });
    assert.equal(r.code, 401, `${m} ${u}`);
  }
  const wrong = await call(app, 'GET', '/api/bots/status', { token: 'w'.repeat(40) });
  assert.equal(wrong.code, 401);
});

test('keys are verified with the exchange first, then stored; secrets are never returned', async () => {
  const bad = build({ verify: { rejected: true, message: 'Invalid API key' } });
  const rej = await call(bad.app, 'POST', '/api/bots/keys', { body: keyBody });
  assert.equal(rej.code, 400);
  assert.equal(bad.store.getCred('bybit', 'demo'), null, 'a rejected key must not be stored');

  const down = build({ verify: { verified: false } });
  assert.equal((await call(down.app, 'POST', '/api/bots/keys', { body: keyBody })).code, 502);
  assert.equal(down.store.getCred('bybit', 'demo'), null);

  const good = build();
  const ok = await call(good.app, 'POST', '/api/bots/keys', { body: keyBody });
  assert.equal(ok.code, 200);
  assert.equal(good.store.getCred('bybit', 'demo').secretKey, SECRET);
  const status = await call(good.app, 'GET', '/api/bots/status');
  const text = JSON.stringify(status.body);
  assert.ok(!text.includes(SECRET) && !text.includes('AKIA1234ABCD'), 'status must never contain key material');
  assert.equal(status.body.creds[0].last4, 'ABCD');
  assert.equal(status.body.enabled, true);
});

test('only Bybit and Binance, live or demo, can be saved', async () => {
  const { app } = build();
  assert.equal((await call(app, 'POST', '/api/bots/keys', { body: { ...keyBody, exchange: 'mexc' } })).code, 400);
  assert.equal((await call(app, 'POST', '/api/bots/keys', { body: { ...keyBody, mode: 'paper' } })).code, 400);
  assert.equal((await call(app, 'POST', '/api/bots/keys', { body: { exchange: 'bybit', mode: 'demo' } })).code, 400);
});

test('without BOT_VAULT_KEY the key/bot routes answer 503 and say how to fix it; status still works', async () => {
  const { app, store } = build({ vaultKey: '' });
  const r = await call(app, 'POST', '/api/bots/keys', { body: keyBody });
  assert.equal(r.code, 503);
  assert.match(r.body.message, /BOT_VAULT_KEY/);
  assert.equal((await call(app, 'POST', '/api/bots', { body: { bot: {} } })).code, 503);
  const s = await call(app, 'GET', '/api/bots/status');
  assert.equal(s.body.enabled, false);
  assert.equal(store.listCreds().length, 0);
});

test('hand-off needs a saved key, validates the plan, and never echoes secrets', async () => {
  const { app } = build();
  const plan = buildManualGridPlan({ symbol: 'ABCUSDT', direction: 'NEUTRAL', upper: 110, lower: 90, levelCount: 6, leverage: 5, investmentUsd: 600 });
  const bot = { id: 'BOT-GRID-1700000000000-ab12', type: 'grid', exchange: 'bybit', mode: 'demo', symbol: 'ABCUSDT', direction: 'NEUTRAL', leverage: 5, investmentUsd: 600, config: {}, plan };
  const noKey = await call(app, 'POST', '/api/bots', { body: { bot } });
  assert.equal(noKey.code, 412);
  await call(app, 'POST', '/api/bots/keys', { body: keyBody });
  assert.equal((await call(app, 'POST', '/api/bots', { body: { bot: { ...bot, plan: { levels: [1] } } } })).code, 400);
  const ok = await call(app, 'POST', '/api/bots', { body: { bot, limits: { tbDailyMaxLossPct: 7 } } });
  assert.equal(ok.code, 200);
  assert.equal(ok.body.bot.server, true);
  assert.ok(!JSON.stringify(ok.body).includes(SECRET));
});

test('a key cannot be deleted while a bot still runs on it', async () => {
  const { app, store } = build();
  await call(app, 'POST', '/api/bots/keys', { body: keyBody });
  store.state.tradingBots.push({ id: 'BOT-DCA-1-aaaa', exchange: 'bybit', mode: 'demo', status: 'active' });
  const r = await call(app, 'POST', '/api/bots/keys/delete', { body: { exchange: 'bybit', mode: 'demo' } });
  assert.equal(r.code, 409);
  assert.ok(store.getCred('bybit', 'demo'));
  store.state.tradingBots[0].status = 'stopped';
  assert.equal((await call(app, 'POST', '/api/bots/keys/delete', { body: { exchange: 'bybit', mode: 'demo' } })).code, 200);
  assert.equal(store.getCred('bybit', 'demo'), null);
});
