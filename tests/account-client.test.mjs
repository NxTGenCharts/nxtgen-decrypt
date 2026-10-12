// Browser-side account module, run in Node with a stubbed DOM + fake Supabase/proxy.
//   Run: node tests/account-client.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';

const store = new Map();
globalThis.localStorage = { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) };
const doc = { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], addEventListener(){}, createElement: () => ({ style: {}, addEventListener(){}, appendChild(){}, classList: { add(){}, remove(){} } }), hidden: false, body: { appendChild(){} } };
globalThis.document = doc;
const events = [];
globalThis.window = globalThis;
globalThis.addEventListener = () => {};
globalThis.dispatchEvent = (e) => { events.push(e.type); };
globalThis.CustomEvent = class { constructor(type){ this.type = type; } };

const PROXY = 'https://proxy.example';
const SB = 'https://proj.supabase.co';
let tokenSeq = 0, refreshFails = false;
const calls = [];
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  const hdr = init.headers instanceof Headers ? Object.fromEntries(init.headers.entries()) : (init.headers || {});
  calls.push({ url: u, headers: hdr, body: init.body });
  const json = (o, status = 200) => ({ ok: status < 400, status, json: async () => o });
  if(u === `${PROXY}/api/auth/config`) return json({ ok: true, enabled: true, url: SB, anonKey: 'anon' });
  if(u.startsWith(`${SB}/auth/v1/token?grant_type=password`)){
    const b = JSON.parse(init.body);
    if(b.password !== 'correct-horse') return json({ error_description: 'Invalid login credentials' }, 400);
    return json({ access_token: `eyJa.at${++tokenSeq}.s`, refresh_token: 'rt1', expires_in: 3600, user: { id: 'u-alice', email: 'a@x.io' } });
  }
  if(u.startsWith(`${SB}/auth/v1/token?grant_type=refresh_token`)){
    if(refreshFails) return json({ error: 'invalid_grant' }, 400);
    return json({ access_token: `eyJa.at${++tokenSeq}.s`, refresh_token: 'rt2', expires_in: 3600, user: { id: 'u-alice', email: 'a@x.io' } });
  }
  if(u === `${SB}/auth/v1/logout`) return json({});
  if(u === `${PROXY}/api/account/keys`) return json({ ok: true, enabled: true, creds: [{ exchange: 'bybit', mode: 'live', last4: '9f3a', fp: 'x1', updatedAt: 1 }] });
  if(u === `${PROXY}/api/markets`) return json({ ok: true });
  return json({ ok: false }, 404);
};

const { state } = await import('../js/state.js');
state.verifyProxyUrl = PROXY;
const acct = await import('../js/account.js');

test('start-up reads the server config; no session yet', async () => {
  await acct.initAccount();
  assert.equal(acct.accountsAvailable(), true);
  assert.equal(acct.isSignedIn(), false);
});

test('wrong password gives a friendly error and signs nothing in', async () => {
  await assert.rejects(() => acct.signIn('a@x.io', 'nope-nope'), /Wrong email or password/);
  assert.equal(acct.isSignedIn(), false);
});

test('sign-in stores the session under a non-backup key and layers the account\'s key on as a placeholder', async () => {
  state.futures = { tradingBots: [{ id: 'old', server: true }, { id: 'mine', server: false }] };
  await acct.signIn('a@x.io', 'correct-horse');
  assert.equal(acct.isSignedIn(), true);
  assert.equal(acct.accountEmail(), 'a@x.io');
  assert.ok(store.has('nxtgen-acct-session'));
  assert.ok(![...store.keys()].some(k => k.startsWith('nxtgen_') && /session|token/i.test(k)), 'must not use the nxtgen_ prefix backup.js exports');
  const c = state.exchangeCreds.bybit.live;
  assert.equal(c.serverHeld, true);
  assert.equal(c.apiKey, 'srv:bybit:live:9f3a');
  assert.equal(c.secretKey, 'srv', 'the browser never holds a real secret for an account key');
  assert.equal(state.exchangeCreds.bybit.demo, null);
  assert.ok(events.includes('nxtgen:creds-changed'));
  // first sign-in on this device (no previous user): nothing purged
  assert.equal(state.futures.tradingBots.length, 2);
});

test('the session token is attached only where needed', async () => {
  calls.length = 0;
  await fetch(`${PROXY}/api/markets`);
  await fetch(`${PROXY}/api/bots/status`);
  await fetch(`${PROXY}/api/futures/balance`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ apiKey: 'srv:bybit:live:9f3a' }) });
  await fetch(`${PROXY}/api/futures/balance`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ apiKey: 'REALKEY' }) });
  const h = (i) => Object.fromEntries(Object.entries(calls[i].headers).map(([k, v]) => [k.toLowerCase(), v]));
  assert.equal(h(0).authorization, undefined, 'public market polling stays a plain request');
  assert.match(h(1).authorization, /^Bearer eyJa\./);
  assert.match(h(2).authorization, /^Bearer eyJa\./);
  assert.equal(h(3).authorization, undefined, 'a request carrying its own real key is untouched');
});

test('an expiring token is refreshed transparently', async () => {
  const s = JSON.parse(store.get('nxtgen-acct-session'));
  s.expires_at = Date.now() + 5_000;               // about to expire
  store.set('nxtgen-acct-session', JSON.stringify(s));
  // module copy: touch via freshToken(true)
  const t = await acct.freshToken(true);
  assert.match(t, /^eyJa\.at\d+\.s$/);
  assert.equal(JSON.parse(store.get('nxtgen-acct-session')).refresh_token, 'rt2');
});

test('sign-out removes the placeholder, the session and this account\'s mirrored bots', async () => {
  await acct.signOut();
  assert.equal(acct.isSignedIn(), false);
  assert.equal(store.has('nxtgen-acct-session'), false);
  assert.equal(state.exchangeCreds.bybit.live, null);
  assert.deepEqual(state.futures.tradingBots.map(b => b.id), ['mine'], 'server-mirrored bots are dropped, the device\'s own stay');
});

test('a different account signing in on the same device never inherits the previous account\'s bots', async () => {
  state.futures = { tradingBots: [{ id: 'alice-bot', server: true }] };
  store.set('nxtgen-acct-last-user', 'u-someone-else');
  await acct.signIn('a@x.io', 'correct-horse');      // fake server answers as u-alice
  assert.equal(state.futures.tradingBots.length, 0);
});

test('a revoked login (refresh rejected) signs the device out cleanly', async () => {
  refreshFails = true;
  const t = await acct.freshToken(true);
  assert.equal(t, '');
  assert.equal(acct.isSignedIn(), false);
  assert.equal(state.exchangeCreds.bybit.live, null);
});

// ---- keys saved only on this device are handed to the account automatically (so a key is entered once) ----
test('pendingLocalKeys picks only verified, raw, not-yet-saved keys — and never retries an attempted one', () => {
  const raw = (k) => ({ apiKey: k, secretKey: 's', verified: true });
  const creds = {
    bybit:  { live: raw('BYBITLIVE123456'), demo: { ...raw('BYBITDEMO654321'), verified: false } },   // demo is unverified: left for the user
    binance:{ live: raw('BINANCELIVE9999'), demo: null },                                              // the account already has this one
    bitget: { live: { apiKey: 'srv:bitget:live:1234', secretKey: 'srv', verified: true, serverHeld: true }, demo: null },   // already a placeholder
    mexc:   { live: raw('MEXCLIVE0000001'), demo: null },
  };
  const saved = [{ exchange: 'binance', mode: 'live' }];
  const tried = new Set();
  const first = acct.pendingLocalKeys(creds, saved, tried);
  assert.deepEqual(first.map(x => `${x.exchange}:${x.mode}`).sort(), ['bybit:live', 'mexc:live']);
  first.forEach(x => tried.add(x.sig));
  assert.deepEqual(acct.pendingLocalKeys(creds, saved, tried), [], 'a refused/attempted key is not retried in a loop');
  assert.deepEqual(acct.pendingLocalKeys({}, [], tried), []);
});

test('refreshKeys announces only real changes (it now also runs on a timer and when the tab is refocused)', async () => {
  await acct.signIn('a@x.io', 'correct-horse');
  const seen = [];
  const off = acct.onAccountChange((t) => { if(t === 'keys') seen.push(t); });
  await acct.refreshKeys();           // same list as the sign-in already loaded
  await acct.refreshKeys();
  off();
  assert.equal(seen.length, 0, 'no change -> no event, so pages are not redrawn every minute');
  await acct.signOut();
});
