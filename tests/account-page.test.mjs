// Account page (browser side), run in Node with a stubbed DOM + fake Supabase/proxy.   Run: node tests/account-page.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';

const store = new Map();
globalThis.localStorage = { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) };
globalThis.sessionStorage = { getItem: () => null, setItem(){}, removeItem(){} };
globalThis.document = { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], addEventListener(){}, createElement: () => ({ style: {}, addEventListener(){}, appendChild(){}, classList: { add(){}, remove(){} } }), hidden: false, body: { appendChild(){} } };
globalThis.window = globalThis;
globalThis.addEventListener = () => {};
globalThis.dispatchEvent = () => {};
globalThis.CustomEvent = class { constructor(t){ this.type = t; } };

const PROXY = 'https://proxy.example', SB = 'https://proj.supabase.co';
const calls = []; let seq = 0, serverKeys = [], deleteReply = { ok: true, deleted: true };
globalThis.fetch = async (url, init = {}) => {
  const u = String(url); calls.push({ url: u, method: init.method || 'GET', body: init.body, headers: init.headers instanceof Headers ? Object.fromEntries(init.headers.entries()) : (init.headers || {}) });
  const json = (o, status = 200) => ({ ok: status < 400, status, json: async () => o });
  if(u === `${PROXY}/api/auth/config`) return json({ ok: true, enabled: true, url: SB, anonKey: 'anon' });
  if(u.startsWith(`${SB}/auth/v1/token?grant_type=password`)){
    const b = JSON.parse(init.body);
    if(b.password !== 'old-password-1') return json({ error_description: 'Invalid login credentials' }, 400);
    return json({ access_token: `eyJa.at${++seq}.s`, refresh_token: `rt${seq}`, expires_in: 3600, user: { id: 'u-alice', email: 'a@x.io' } });
  }
  if(u === `${SB}/auth/v1/user` && init.method === 'GET') return json({ id: 'u-alice', email: 'a@x.io', created_at: '2026-01-02T00:00:00Z', email_confirmed_at: '2026-01-02T00:01:00Z', user_metadata: { display_name: 'Alice' } });
  if(u === `${SB}/auth/v1/user` && init.method === 'PUT') return json({});
  if(u.startsWith(`${SB}/auth/v1/logout`)) return json({});
  if(u === `${PROXY}/api/bots/keys`){ const b = JSON.parse(init.body); serverKeys = [{ exchange: b.exchange, mode: b.mode, last4: b.apiKey.slice(-4), fp: 'f', updatedAt: 5, verifiedAt: 5, hasPassphrase: !!b.passphrase }]; return json({ ok: true, creds: serverKeys, balance: 12.5 }); }
  if(u === `${PROXY}/api/account/keys`) return json({ ok: true, enabled: true, creds: serverKeys });
  if(u === `${PROXY}/api/account/keys/test`) return json({ ok: true, verified: true, balance: 99, checkedAt: 9, creds: serverKeys.map(k => ({ ...k, verifiedAt: 9 })) });
  if(u === `${PROXY}/api/account/delete`) return json(deleteReply);
  if(u === `${PROXY}/api/account/me`) return json({ ok: true, user: { id: 'u-alice', email: 'a@x.io' } });
  if(u === `${PROXY}/api/bots/status`) return json({ ok: true, bots: [], creds: serverKeys, day: {} });
  if(u === `${PROXY}/api/bots/trades`) return json({ ok: true, trades: [] });
  return json({ ok: false }, 404);
};

const { state } = await import('../js/state.js');
state.verifyProxyUrl = PROXY;
const acct = await import('../js/account.js');
const page = await import('../js/account-page.js');

test('page helpers: tab routing, money, running bots, summaries and derived events use only real fields', () => {
  assert.equal(page.tabFromHash('#exchanges'), 'exchanges');
  assert.equal(page.tabFromHash('#api-keys'), 'exchanges');
  assert.equal(page.tabFromHash('#nonsense'), 'dashboard');
  assert.equal(page.tabFromHash(''), 'dashboard');
  assert.equal(page.fmtUsd(1605.1, false), '$1,605.10'); assert.equal(page.fmtUsd(3.92, true), '+$3.92'); assert.equal(page.fmtUsd(-2, true), '-$2.00'); assert.equal(page.fmtUsd(null), '—');
  assert.equal(page.esc('<b onclick="x">&'), '&lt;b onclick=&quot;x&quot;&gt;&amp;');
  const bots = [
    { id: 1, status: 'active', paused: false, realizedUsd: 5, runtime: { unrealizedUsd: 1.5 } },
    { id: 2, status: 'active', paused: true, runtime: { unrealizedUsd: 9 } },     // paused: flat, not running
    { id: 3, status: 'closed', stoppedAtMs: 20, createdAtMs: 10, symbol: 'SOLUSDT', type: 'dca', exchange: 'bybit', mode: 'demo' },
    { id: 4, status: 'error', statusMessage: 'Deployment failed', createdAtMs: 30, symbol: 'ENAUSDT', type: 'grid', exchange: 'bybit', mode: 'demo' },
  ];
  const s = page.summarize({ keys: [{ verifiedAt: 1 }, {}], bots, trades: [{ netUsd: 2 }, { netUsd: -0.5 }], day: { tbDayKey: 'k', tbDayRealizedUsd: 1 } });
  assert.deepEqual([s.keyCount, s.keysVerified, s.running, s.stopped, s.errored, s.realized, s.unrealized, s.todayRealized], [2, 1, 1, 1, 1, 1.5, 1.5, 1]);
  // a bot stopped by hand (legacy status 'stopped') counts as stopped too
  assert.equal(page.summarize({ bots: [{ status: 'stopped' }, { status: 'closed' }] }).stopped, 2);
  const none = page.summarize({});
  assert.equal(none.realized, null); assert.equal(none.unrealized, null); assert.equal(none.running, 0);   // nothing invented for a new user
  const ev = page.deriveEvents({ keys: [{ exchange: 'bybit', mode: 'demo', last4: '1234', updatedAt: 100, verifiedAt: 200 }], bots, checks: { 'binance:live': { at: 300, ok: false, message: 'IP not allowed' } } });
  assert.equal(ev[0].text.includes('connection check failed'), true); assert.equal(ev[0].bad, true);
  assert.ok(ev.some(e => /key saved \(…1234\)/.test(e.text)) && ev.some(e => /Bot error/.test(e.text)));
  assert.deepEqual(page.deriveEvents({}), []);
});

test('saving a key on the account leaves NO raw secret in this browser, and it becomes a placeholder', async () => {
  await acct.initAccount();
  await acct.signIn('a@x.io', 'old-password-1');
  state.exchangeCreds.mexc = { live: { apiKey: 'RAWKEYMEXC9999', secretKey: 'RAWSECRET', passphrase: '', connected: true, verified: true }, demo: null };
  const r = await acct.moveKeyToAccount('bybit', 'live', { apiKey: 'RAWKEYBYBIT1234', secretKey: 'RAWSECRET2', passphrase: '' });
  assert.equal(r.ok, true); assert.equal(r.balance, 12.5);
  const slot = state.exchangeCreds.bybit.live;
  assert.equal(slot.serverHeld, true); assert.equal(slot.apiKey, 'srv:bybit:live:1234'); assert.equal(slot.secretKey, 'srv');
  assert.equal(slot.verified, true); assert.equal(slot.verifiedAt, 5);
  assert.ok(!JSON.stringify(state.exchangeCreds.bybit).includes('RAWSECRET2'));
  assert.ok(![...store.values()].some(v => v.includes('RAWSECRET2')), 'secret never reached localStorage');
});

test('all five exchanges can be held on the account (Bitget keeps a passphrase marker, not the passphrase)', async () => {
  serverKeys = [{ exchange: 'bitget', mode: 'live', last4: 'abcd', fp: 'g', updatedAt: 1, verifiedAt: null, hasPassphrase: true }];
  state.exchangeCreds.bitget = { live: null, demo: null };
  await acct.refreshKeys();
  const c = state.exchangeCreds.bitget.live;
  assert.equal(c.serverHeld, true); assert.equal(c.apiKey, 'srv:bitget:live:abcd'); assert.equal(c.passphrase, 'srv');
  assert.match(c.verifyNote, /Verified with the exchange when it was saved/);   // no verifiedAt yet: says exactly that, nothing more
});

test('testSavedKey refreshes the confirmation time from the server verdict', async () => {
  const r = await acct.testSavedKey('bitget', 'live');
  assert.equal(r.verified, true);
  assert.equal(state.exchangeCreds.bitget.live.verifiedAt, 9);
  assert.match(state.exchangeCreds.bitget.live.verifyNote, /Confirmed by the exchange on/);
});

test('profile: reads created/verified/display name; saving the name sends only metadata', async () => {
  const p = await acct.fetchProfile();
  assert.equal(p.displayName, 'Alice'); assert.equal(p.emailConfirmedAt, '2026-01-02T00:01:00Z');
  calls.length = 0;
  assert.equal(await acct.updateDisplayName('  <Al>ice\u0001  '), 'Alice');
  const put = calls.find(c => c.method === 'PUT');
  assert.deepEqual(JSON.parse(put.body), { data: { display_name: 'Alice' } });
});

test('change password: proves the current one, sets the new one, signs OTHER sessions out, keeps this browser signed in', async () => {
  await assert.rejects(() => acct.changePassword('wrong-wrong', 'new-password-22'), /current password is not correct/i);
  calls.length = 0;
  const r = await acct.changePassword('old-password-1', 'new-password-22');
  assert.equal(r.otherSessionsSignedOut, true);
  const put = calls.find(c => c.method === 'PUT' && c.url.endsWith('/auth/v1/user'));
  assert.deepEqual(JSON.parse(put.body), { password: 'new-password-22' });
  assert.ok(calls.some(c => c.url.includes('/logout?scope=others')));
  assert.equal(acct.isSignedIn(), true);
});

test('sign out of all devices revokes globally and ends this session', async () => {
  calls.length = 0;
  const r = await acct.signOutEverywhere();
  assert.equal(r.allDevices, true);
  assert.ok(calls.some(c => c.url.includes('/logout?scope=global')));
  assert.equal(acct.isSignedIn(), false);
});

test('delete account: the server refusal is passed through and the session stays; success ends it', async () => {
  await acct.signIn('a@x.io', 'old-password-1');
  deleteReply = { ok: false, message: '1 bot is still running.' };
  const no = await acct.deleteMyAccount('a@x.io');
  assert.equal(no.ok, false); assert.equal(acct.isSignedIn(), true);
  deleteReply = { ok: true, deleted: true };
  const yes = await acct.deleteMyAccount('a@x.io');
  assert.equal(yes.ok, true); assert.equal(acct.isSignedIn(), false);
  assert.ok(![...store.keys()].includes('nxtgen-acct-session'));
});
