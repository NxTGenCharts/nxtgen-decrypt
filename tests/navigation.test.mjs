// Static checks on the shipped pages: API Keys is no longer a primary destination, Account is, mobile has visible auth entry points.
//   Run: node tests/navigation.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const DASH = ['overview', 'triangular-arbitrage', 'cross-arbitrage', 'autotrade-futures', 'utilities-tools', 'account'];

test('no dashboard page has API Keys as a navigation item; each has Account', () => {
  for(const pg of DASH){
    const html = read(`${pg}/index.html`);
    const nav = html.slice(html.indexOf('id="termNav"'), html.indexOf('</nav>', html.indexOf('id="termNav"')));
    assert.ok(!/href="\/api-keys\//.test(nav) && !/>API Keys</.test(nav), `${pg}: API Keys still in nav`);
    assert.ok(/href="\/account\/"/.test(nav), `${pg}: missing Account nav item`);
    assert.ok(html.includes('/js/auth-gate.js'), `${pg}: not behind the sign-in guard`);
  }
});

test('nothing else links to /api-keys/ (except its redirect stub and the service worker\'s old-URL cache entry)', () => {
  for(const pg of [...DASH, 'docs', 'about', 'contact', 'terms', 'privacy', 'login', 'register']) assert.ok(!read(`${pg}/index.html`).includes('/api-keys/'), pg);
  assert.ok(!read('index.html').includes('/api-keys/'));
  assert.ok(!read('js/mobile-shell.js').includes('/api-keys/'));
  assert.ok(!read('manifest.webmanifest').includes('/api-keys/'));
});

test('the old URL redirects into Account → Exchange Connections without any gate loop', () => {
  const html = read('api-keys/index.html');
  assert.match(html, /http-equiv="refresh" content="0; url=\/account\/#exchanges"/);
  assert.match(html, /location\.replace\('\/account\/#exchanges'\)/);
  assert.ok(!html.includes('auth-gate.js'));
});

test('mobile shell: Account is a bottom tab and in the header; the menu sheet carries identity, sign out and sign-in/register', () => {
  const js = read('js/mobile-shell.js');
  assert.match(js, /label: 'Account',\s+href: '\/account\/'/);
  for(const tab of ['Home', 'Triangular', 'Trade', 'Cross']) assert.ok(js.includes(`label: '${tab}'`), tab);
  assert.ok(js.includes('id="mSignOut"') && js.includes('Create account'));
  // Account lives in the bottom bar only: no duplicate account icon in the app bar
  assert.ok(!js.includes('id="mAcctBtn"'));
});

test('landing page: Sign in and Create account are real links, not hidden on phones', () => {
  const html = read('index.html'), css = read('css/landing.css');
  assert.ok(html.includes('href="/login/"') && html.includes('href="/register/"'));
  assert.ok(!/\.nav-cta \.btn-signin\{display:none\}/.test(css));
});

test('account page hosts the elements the existing key/AI/backup scripts bind to by id', () => {
  const html = read('account/index.html');
  for(const id of ['connectRows', 'atMessages', 'aiProviderSelect', 'aiApiKeyInput', 'aiSaveBtn', 'bkExportBtn', 'bkImportBtn', 'bkExportPass']) assert.ok(html.includes(`id="${id}"`), id);
  for(const t of ['dashboard', 'exchanges', 'profile', 'security', 'preferences']) assert.ok(html.includes(`data-ac-section="${t}"`), t);
  assert.equal((html.match(/id="connectRows"/g) || []).length, 1, 'one exchange form only — no duplicate of the same functionality');
  assert.ok(html.includes('/js/account-page.js'));
});

test('service worker precaches the account page and its assets', () => {
  const sw = read('sw.js');
  for(const f of ['/account/', '/css/account.css', '/js/account-page.js']) assert.ok(sw.includes(`"${f}"`), f);
});
