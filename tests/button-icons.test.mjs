import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Load the classic script in a tiny fake browser so the label -> icon rules can be checked without a DOM.
function load(){
  const window = {}; const document = { readyState: 'complete', querySelectorAll: () => [], body: {}, addEventListener(){} };
  vm.runInNewContext(fs.readFileSync(new URL('../js/button-icons.js', import.meta.url), 'utf8'), { window, document, setTimeout, MutationObserver: undefined });
  return window.__nxBiPick;
}
const sprite = fs.readFileSync(new URL('../assets/icons.svg', import.meta.url), 'utf8');

test('labels map to the expected icon and tone', () => {
  const pick = load();
  const cases = {
    'Sign out': ['log-out', undefined], 'Sync API keys': ['refresh-cw', undefined], 'Save my keys to account': ['cloud-upload', undefined],
    '← Back to My Bots': ['arrow-left', undefined], 'Delete': ['trash', 'danger'], 'Terminate': ['octagon-x', 'danger'], 'Stop': ['square', 'danger'],
    'Export PDF': ['file-text', undefined], 'Export CSV': ['table', undefined], 'Run Backtest': ['play', 'go'], 'Create account': ['user-plus', undefined],
    'Launch Terminal': ['terminal', undefined], 'Resend confirmation email': ['mail', undefined], 'Test connection': ['activity', undefined],
    'Pause': ['pause', undefined], 'Resume': ['play', 'go'], 'Copy Bot': ['copy', undefined], 'Smart Fill': ['sparkles', undefined],
  };
  for(const [label, [icon, tone]] of Object.entries(cases)){ const r = pick(label); assert.ok(r, label); assert.equal(r[1], icon, label); assert.equal(r[2], tone, label); }
});

test('segmented toggles and unknown labels get no icon', () => {
  const pick = load();
  for(const l of ['Live', 'Demo', 'Manual', 'Auto', 'Today', 'All Time', 'Last 7 Days', 'Long', 'Short', 'Something unrelated']) assert.equal(pick(l), null, l);
});

test('every icon the script can pick exists in the sprite', () => {
  const src = fs.readFileSync(new URL('../js/button-icons.js', import.meta.url), 'utf8');
  const names = new Set([...src.matchAll(/\/,\s*'([a-z-]+)'/g)].map(m => m[1]));
  assert.ok(names.size > 20);
  for(const n of names) assert.ok(sprite.includes(`id="i-${n}"`), `missing icon i-${n}`);
});

test('every page with buttons loads the button stylesheet and script', () => {
  for(const p of ['overview', 'account', 'utilities-tools', 'login', 'register', 'triangular-arbitrage', 'cross-arbitrage', 'autotrade-futures', 'about']){
    const html = fs.readFileSync(new URL(`../${p}/index.html`, import.meta.url), 'utf8');
    assert.ok(html.includes('/css/buttons.css') && html.includes('/js/button-icons.js'), p);
  }
});
