// =============================================================
// mobile-shell.js — the "app" chrome for phones.
//
// Loaded as its OWN module on every page (not imported by app.js) so
// that if anything in the trading code ever throws during startup, the
// navigation still works. It builds:
//   • the fixed bottom tab bar (from the page's own .term-nav links, so
//     there is one source of truth for navigation)
//   • the app-bar status pill + menu button, and the status sheet
//   • PWA install handling and the service-worker registration
//   • #auto / #futures / #bots deep links on the Trade page
//   • the Home page ticker + market movers
//   • a "you're about to stop a running engine" guard on navigation
//
// All the chrome is hidden by css/mobile-app.css above 768px, so on
// desktop this script builds DOM that is never shown and does nothing else.
// =============================================================

const ICONS = {
  home:     '<path d="M3 11.5 12 4l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
  triangle: '<path d="M12 4 3.5 19h17z"/><circle cx="12" cy="4" r="1.2"/><circle cx="3.5" cy="19" r="1.2"/><circle cx="20.5" cy="19" r="1.2"/>',
  swap:     '<path d="M4 8h15m0 0-3.5-3.5M19 8l-3.5 3.5M20 16H5m0 0 3.5-3.5M5 16l3.5 3.5"/>',
  bolt:     '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>',
  key:      '<circle cx="8" cy="15" r="4"/><path d="m11 12 9-9m-3 3 3 3"/>',
  bot:      '<rect x="4" y="8" width="16" height="12" rx="3"/><path d="M12 8V4m-3 8h.01M15 12h.01M9 16h6"/>',
  wallet:   '<rect x="3" y="7" width="18" height="13" rx="2.5"/><path d="M3 10V6.5A1.5 1.5 0 0 1 4.5 5H17"/><circle cx="16.5" cy="13.5" r="1"/>',
  diamond:  '<path d="M12 3 21 12 12 21 3 12z"/>',
  refresh:  '<path d="M21 12a9 9 0 1 1-3-6.7M21 4v5h-5"/>',
  download: '<path d="M12 3v12m0 0-4-4m4 4 4-4M5 21h14"/>',
  wrench:   '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>',
  more:     '<circle cx="12" cy="5" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="12" cy="19" r="1.4"/>',
};
const icon = (name) => `<svg class="m-ic" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ''}</svg>`;

// Order here is the bottom-bar order (Trade sits in the raised centre slot).
const TABS = [
  { label: 'Home',       href: '/',                     icon: 'home' },
  { label: 'Triangular', href: '/triangular-arbitrage/', icon: 'triangle' },
  { label: 'Trade',      href: '/autotrade-futures/',   icon: 'bolt', center: true },
  { label: 'Cross',      href: '/cross-arbitrage/',     icon: 'swap' },
  { label: 'API Keys',   href: '/api-keys/',            icon: 'key' },
];

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const path = () => (location.pathname.replace(/index\.html$/, '').replace(/\/+$/, '') || '/');

// ---------- engine-running guard ----------
// The trading engines run inside the page (timers in the browser). Switching
// tabs loads a different page and stops them, and with a bottom bar that is a
// single thumb-tap away, so ask first.
let stateRef = null;
import('./state.js').then((m) => { stateRef = m.state; }).catch(() => {});
function runningEngines() {
  if (!stateRef) return [];
  const found = [];
  for (const group of ['autotrade', 'futures']) {
    const g = stateRef[group];
    if (!g) continue;
    for (const k of Object.keys(g)) if (/running$/i.test(k) && g[k] === true) found.push(group + '.' + k);
  }
  return found;
}
const LEAVE_MSG = 'A trading engine is running on this page. Engines run inside your browser, so leaving this page will stop it. Leave anyway?';
let skipUnloadPrompt = false;
function confirmLeave() {
  if (runningEngines().length === 0) return true;
  if (window.confirm(LEAVE_MSG)) { skipUnloadPrompt = true; return true; } // don't ask a second time via beforeunload
  return false;
}

document.addEventListener('click', (e) => {
  const a = e.target.closest && e.target.closest('a[href]');
  if (!a || a.target === '_blank' || e.defaultPrevented || e.metaKey || e.ctrlKey) return;
  let url;
  try { url = new URL(a.href, location.href); } catch { return; }
  if (url.origin !== location.origin) return;
  const samePage = url.pathname.replace(/\/+$/, '') === location.pathname.replace(/\/+$/, '');
  if (samePage) return; // hash-only jumps within the page are safe
  if (!confirmLeave()) { e.preventDefault(); e.stopPropagation(); }
}, true);
window.addEventListener('beforeunload', (e) => {
  if (!skipUnloadPrompt && runningEngines().length) { e.preventDefault(); e.returnValue = ''; }
});

// ---------- fill icon slots in static markup (quick actions etc.) ----------
$$('[data-icon]').forEach((el) => { el.innerHTML = icon(el.dataset.icon); });

// ---------- bottom tab bar ----------
function buildTabbar() {
  const nav = document.createElement('nav');
  nav.className = 'm-tabbar';
  nav.setAttribute('aria-label', 'Primary');
  const here = path();
  nav.innerHTML = TABS.map((t) => {
    const p = t.href.replace(/\/+$/, '') || '/';
    const active = p === '/' ? here === '/' : here === p || here.startsWith(p + '/');
    return `<a class="m-tab${t.center ? ' is-center' : ''}" href="${t.href}"${active ? ' aria-current="page"' : ''}>` +
           `<span class="m-tab-ic">${icon(t.icon)}</span><span>${t.label}</span></a>`;
  }).join('');
  document.body.appendChild(nav);
  document.body.classList.add('has-tabbar');
}

// ---------- app-bar actions + status sheet ----------
function buildAppBar() {
  const brand = $('.brand-block');
  if (!brand) return;
  const actions = document.createElement('div');
  actions.className = 'm-appbar-actions';
  actions.innerHTML =
    '<span class="m-live" id="mLive"><span class="dot" id="mLiveDot"></span><b id="mLiveText">connecting</b></span>' +
    `<button type="button" class="m-iconbtn" id="mMenuBtn" aria-label="Connection status and app menu" aria-haspopup="dialog">${icon('more')}</button>`;
  brand.appendChild(actions);

  // mirror the page's own status dot/text (the scan code writes to #statusDot / #statusText)
  const srcDot = $('#statusDot'), srcText = $('#statusText');
  const sync = () => {
    if (srcDot) $('#mLiveDot').className = srcDot.className;
    if (srcText) $('#mLiveText').textContent = srcText.textContent;
  };
  sync();
  const mo = new MutationObserver(sync);
  if (srcDot) mo.observe(srcDot, { attributes: true, attributeFilter: ['class'] });
  if (srcText) mo.observe(srcText, { childList: true, characterData: true, subtree: true });

  // sheet
  const overlay = document.createElement('div');
  overlay.className = 'm-overlay';
  const sheet = document.createElement('div');
  sheet.className = 'm-sheet';
  sheet.setAttribute('role', 'dialog');
  sheet.setAttribute('aria-modal', 'true');
  sheet.setAttribute('aria-label', 'Connection status');
  sheet.innerHTML =
    '<div class="m-sheet-grab"></div>' +
    '<h3>Exchange connections</h3><div id="mSheetX"></div>' +
    '<p class="m-sheet-note" id="mSheetUpdate"></p>' +
    '<div class="m-sheet-actions">' +
      `<button type="button" class="primary" id="mInstallBtn" data-m-install hidden>${icon('download').replace('class="m-ic"', 'class="m-ic" style="width:18px;height:18px"')}Install app</button>` +
      '<p class="m-sheet-note" id="mInstallHint" hidden></p>' +
      `<button type="button" class="primary ghost" id="mToolsBtn">${icon('wrench').replace('class="m-ic"', 'class="m-ic" style="width:18px;height:18px"')}Utilities &amp; Tools</button>` +
      '<button type="button" class="primary ghost" id="mReloadBtn">Reload app</button>' +
      '<button type="button" class="primary ghost" id="mCloseBtn">Close</button>' +
    '</div>';
  document.body.append(overlay, sheet);

  const NAMES = { badgeBitget: 'Bitget', badgeBinance: 'Binance', badgeBybit: 'Bybit', badgeMexc: 'MEXC', badgeGateio: 'Gate.io' };
  const LABEL = { up: 'connected', down: 'unreachable', idle: 'not checked yet' };
  function fill() {
    $('#mSheetX').innerHTML = Object.keys(NAMES).map((id) => {
      const el = document.getElementById(id);
      const s = (el && el.dataset.state) || 'idle';
      return `<div class="m-xrow"><span>${NAMES[id]}</span><span class="m-xstate" data-state="${s}">${LABEL[s] || s}</span></div>`;
    }).join('');
    const lu = $('#lastUpdate');
    $('#mSheetUpdate').textContent = lu ? lu.textContent : '';
  }
  const open = () => { fill(); overlay.classList.add('open'); sheet.classList.add('open'); };
  const close = () => { overlay.classList.remove('open'); sheet.classList.remove('open'); };
  $('#mMenuBtn').addEventListener('click', open);
  overlay.addEventListener('click', close);
  $('#mCloseBtn').addEventListener('click', close);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  $('#mToolsBtn').addEventListener('click', () => { if (confirmLeave()) location.href = '/utilities-tools/'; });
  $('#mReloadBtn').addEventListener('click', () => { if (confirmLeave()) location.reload(); });
  window.__mCloseSheet = close;
}

// ---------- install (PWA) ----------
let deferredInstall = null;
const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);

function refreshInstallUI() {
  const hide = isStandalone();
  $$('[data-m-install]').forEach((el) => { el.hidden = hide; });
}
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferredInstall = e; refreshInstallUI(); });
window.addEventListener('appinstalled', () => { deferredInstall = null; refreshInstallUI(); });

async function doInstall() {
  const hint = $('#mInstallHint');
  if (deferredInstall) {
    deferredInstall.prompt();
    try { await deferredInstall.userChoice; } catch { /* dismissed */ }
    deferredInstall = null;
    return;
  }
  const msg = isIOS
    ? 'On iPhone/iPad: tap the Share button in Safari, then “Add to Home Screen”.'
    : 'Open your browser menu (⋮) and choose “Install app” or “Add to Home screen”.';
  if (hint) { hint.textContent = msg; hint.hidden = false; }
  const menu = $('#mMenuBtn');
  if (menu && !$('.m-sheet.open')) menu.click();
}
document.addEventListener('click', (e) => {
  if (e.target.closest('[data-m-install]')) doInstall();
});

// ---------- Home quick action: run scan ----------
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-m-action="scan"]');
  if (!b) return;
  const real = document.getElementById('ovRunBtn');
  if (real) real.click();
});

// ---------- Trade page deep links: #auto  #futures ----------
// (Utilities & Tools sub-tabs — #paper-trading, #backtesting, #trading-bots — are routed by ui.js.)
function routeHash() {
  const h = location.hash.replace('#', '');
  if (!h) return;
  const click = (id) => { const b = document.getElementById(id); if (b) b.click(); };
  if (h === 'auto') click('tabAutoBtn');
  if (h === 'futures') click('tabFuturesBtn');
}
window.addEventListener('hashchange', routeHash);
// app.js wires the sub-tab buttons in its own module; wait a tick so its listeners exist.
window.addEventListener('load', () => setTimeout(routeHash, 0));

// ---------- Home: ticker + movers ----------
// Fourteen fills the desktop movers board evenly (an auto-fitting grid,
// 7 per row at typical desktop widths) without making the phone's
// single-column list endless — renderMarket() caps the phone at the
// top 8. The ticker always runs the full set.
const SYMS = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT', 'DOGEUSDT', 'ADAUSDT', 'TRXUSDT',
              'LINKUSDT', 'AVAXUSDT', 'LTCUSDT', 'DOTUSDT', 'SUIUSDT', 'NEARUSDT'];
const isPhone = () => window.matchMedia('(max-width:768px)').matches;
const fmtPrice = (n) => {
  if (!isFinite(n)) return '—';
  const [min, max] = n >= 1000 ? [2, 2] : n >= 1 ? [2, 4] : [4, 6];
  return n.toLocaleString('en-US', { minimumFractionDigits: min, maximumFractionDigits: max });
};
const fmtVol = (n) => {
  if (!isFinite(n)) return '—';
  if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
  return '$' + Math.round(n).toLocaleString('en-US');
};
const fmtChg = (n) => (n >= 0 ? '+' : '') + n.toFixed(2) + '%';

async function fetchTickers() {
  const q = '/api/v3/ticker/24hr?symbols=' + encodeURIComponent(JSON.stringify(SYMS));
  for (const host of ['https://data-api.binance.vision', 'https://api.binance.com']) {
    try {
      const r = await fetch(host + q, { cache: 'no-store' });
      if (!r.ok) continue;
      const j = await r.json();
      if (Array.isArray(j) && j.length) return j.map((t) => ({ sym: t.symbol, price: +t.lastPrice, chg: +t.priceChangePercent, vol: +t.quoteVolume }));
    } catch { /* try next */ }
  }
  try {
    const r = await fetch('https://api.bybit.com/v5/market/tickers?category=spot', { cache: 'no-store' });
    if (r.ok) {
      const j = await r.json();
      const list = (j && j.result && j.result.list) || [];
      const out = list.filter((t) => SYMS.includes(t.symbol))
        .map((t) => ({ sym: t.symbol, price: +t.lastPrice, chg: +t.price24hPcnt * 100, vol: +t.turnover24h }));
      if (out.length) return out;
    }
  } catch { /* give up */ }
  return null;
}

function renderMarket(rows) {
  const tick = $('#mTicker'), movers = $('#mMovers');
  if (!rows) {
    if (tick && !tick.dataset.loaded) tick.hidden = true;
    const list = $('#mMoversList');
    if (list && !movers.dataset.loaded) movers.hidden = true;
    return;
  }
  if (tick) {
    const grp = rows.map((r) => `<span class="m-tk"><b>${r.sym.replace('USDT', '')}</b>${fmtPrice(r.price)}<i class="${r.chg >= 0 ? 'm-up' : 'm-down'}">${fmtChg(r.chg)}</i></span>`).join('');
    $('#mTickerTrack').innerHTML = `<span class="m-ticker-grp">${grp}</span><span class="m-ticker-grp" aria-hidden="true">${grp}</span>`;
    tick.hidden = false; tick.dataset.loaded = '1';
  }
  if (movers) {
    const sorted = rows.slice().sort((a, b) => b.chg - a.chg);
    const shown = isPhone() ? sorted.slice(0, 8) : sorted;
    $('#mMoversList').innerHTML = shown.map((r) => {
      const base = r.sym.replace('USDT', '');
      return `<div class="m-mrow"><div class="m-pair">${base}/USDT<small>Vol ${fmtVol(r.vol)}</small></div>` +
             `<div class="m-price">${fmtPrice(r.price)}</div>` +
             `<div class="m-chg ${r.chg >= 0 ? 'up' : 'down'}">${fmtChg(r.chg)}</div></div>`;
    }).join('');
    movers.hidden = false; movers.dataset.loaded = '1';
  }
}

let lastRows = null;
function startMarket() {
  if (!$('#mTicker') && !$('#mMovers')) return; // Home page only
  const tick = async () => {
    if (document.visibilityState !== 'visible') return;
    const rows = await fetchTickers();
    if (rows) lastRows = rows;
    renderMarket(rows);
  };
  tick();
  setInterval(tick, 20000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') tick(); });
  // Phone shows the top 8, desktop the full board — re-render on the crossing
  // rather than leaving a stale list until the next 20s poll.
  const mq = window.matchMedia('(max-width:768px)');
  const onCross = () => { if (lastRows) renderMarket(lastRows); };
  if (mq.addEventListener) mq.addEventListener('change', onCross);
  else if (mq.addListener) mq.addListener(onCross);
}

// ---------- service worker ----------
function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  const ok = location.protocol === 'https:' || location.hostname === 'localhost';
  if (!ok) return;
  window.addEventListener('load', () => { navigator.serviceWorker.register('/sw.js').catch(() => {}); });
}

// ---------- boot ----------
function boot() {
  buildTabbar();
  buildAppBar();
  refreshInstallUI();
  startMarket();
  registerSW();
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
