// =============================================================
// ui.js — presentation layer: status/messages, exchange badges,
// the Overview dashboard, and tab switching. No calculation
// happens here — only formatting and display of numbers that
// triangular.js / cross-exchange.js already produced.
// =============================================================
import { els, state, EXCHANGE_BADGE_IDS } from './state.js';
import { EXCHANGES } from './exchanges.js';
import { fmtPct } from './utils.js';

export function setStatus(stateName, text){
  els.statusDot.className = 'dot' + (stateName ? ' ' + stateName : '');
  els.statusText.textContent = text;
}

export function showMessage(html, type){
  els.messages.innerHTML = html ? `<div class="msg ${type}">${html}</div>` : '';
}

export function showXMessage(html, type){
  els.xMessages.innerHTML = html ? `<div class="msg ${type}">${html}</div>` : '';
}

export function updateExchangeBadge(key, badgeState){
  state.exchangeState[key] = badgeState;
  const el = els[EXCHANGE_BADGE_IDS[key]];
  if(el) el.dataset.state = badgeState;
}

export function renderOverview(){
  // Only the Overview page's HTML actually has these elements — every
  // other page (Triangular, Cross-Exchange, Autotrade, API Keys) is its
  // own separate document since the site was split into multiple pages,
  // so els.ovExchanges etc. are null there. This function is still called
  // from triangular.js/cross-exchange.js after every scan (correctly —
  // state.lastTri/lastX need updating no matter which page you scanned
  // from, so Overview shows fresh numbers whenever you do visit it); it
  // just has no DOM to write to on those other pages, so it returns early
  // instead of throwing. Before this guard, that throw was caught by the
  // scan's own try/catch and mis-reported as "Could not reach the exchange
  // API(s)" even on a scan that actually succeeded — the status badge got
  // set to 'error' by the catch block after already briefly being set to
  // 'live' moments earlier, and the exact same crash refired on every page
  // load and every tab click, since a scan (and this call) auto-runs then.
  if(!els.ovExchanges) return;
  const connected = Object.values(state.exchangeState).filter(s => s === 'up').length;
  els.ovExchanges.textContent = connected + ' / 3';

  let markets = 0;
  Object.keys(EXCHANGES).forEach(k => { if(state.pairsCache[k]) markets += state.pairsCache[k].length; });
  els.ovMarkets.textContent = (state.lastTri || state.lastX) ? markets.toLocaleString() : '—';

  els.ovCycles.textContent = state.lastTri ? state.lastTri.cyclesChecked.toLocaleString() : '—';

  if(state.lastTri || state.lastX){
    const profitable = (state.lastTri ? state.lastTri.profitable : 0) + (state.lastX ? state.lastX.profitable : 0);
    els.ovProfitable.textContent = profitable.toLocaleString();
  } else {
    els.ovProfitable.textContent = '—';
  }

  let bestPct = null, bestLabel = '';
  if(state.lastTri && state.lastTri.bestPct !== null && (bestPct === null || state.lastTri.bestPct > bestPct)){
    bestPct = state.lastTri.bestPct; bestLabel = 'Triangular · ' + (state.lastTri.bestExchange || '');
  }
  if(state.lastX && state.lastX.bestPct !== null && (bestPct === null || state.lastX.bestPct > bestPct)){
    bestPct = state.lastX.bestPct; bestLabel = 'Cross-Exchange';
  }
  els.ovBest.textContent = bestPct === null ? '—' : fmtPct(bestPct);

  els.ovTriSummary.textContent = state.lastTri
    ? `${state.lastTri.pairsLoaded.toLocaleString()} pairs loaded · ${state.lastTri.cyclesChecked.toLocaleString()} cycles checked · ${state.lastTri.profitable} cleared filter` + (state.lastTri.failed.length ? ` · ${state.lastTri.failed.join(', ')} unavailable` : '')
    : 'Waiting for the first scan — this runs automatically on page load.';
  els.ovXSummary.textContent = state.lastX
    ? `${state.lastX.assetsCompared.toLocaleString()} assets compared · best ${fmtPct(state.lastX.bestPct)} · avg ${state.lastX.avgPct===null?'–':fmtPct(state.lastX.avgPct)}` + (state.lastX.failed.length ? ` · ${state.lastX.failed.join(', ')} unavailable` : '')
    : 'No scan run yet. Open the Cross-Exchange tab and click Scan Markets, or use Run Full Scan above.';
}

// Single source of truth for tab switching across all panels.
const TAB_KEYS = ['overview', 'tri', 'x', 'trading', 'keys'];
const TAB_BTN_ELS = { overview: 'tabOverviewBtn', tri: 'tabTriBtn', x: 'tabXBtn', trading: 'tabTradingBtn', keys: 'tabKeysBtn' };
const TAB_PANEL_ELS = { overview: 'panelOverview', tri: 'panelTri', x: 'panelX', trading: 'panelTrading', keys: 'panelKeys' };

export function switchTabAll(which){
  TAB_KEYS.forEach(key => {
    const btn = els[TAB_BTN_ELS[key]];
    const panel = els[TAB_PANEL_ELS[key]];
    if(!btn || !panel) return; // tolerate a tab whose markup isn't present
    const active = which === key;
    btn.classList.toggle('active', active);
    panel.classList.toggle('active', active);
    btn.setAttribute('aria-selected', active);
  });
}

// Sub-tab switch WITHIN the combined Autotrade & Futures panel — same
// active-class-toggle pattern as switchTabAll above, just scoped to the
// two sub-panels nested inside panelTrading instead of the top-level nav.
//
// The active sub-tab lives in the URL hash so it can be linked to, survives a
// reload, and works with the browser's Back/Forward buttons:
//   /autotrade-futures/#autotrade-balances   (also the default with no hash)
//   /autotrade-futures/#ai-futures-engine
// The old short links (#auto, #futures, #bots) keep working as aliases.
const SUBTAB_KEYS = ['auto', 'futures'];
const SUBTAB_BTN_ELS = { auto: 'tabAutoBtn', futures: 'tabFuturesBtn' };
const SUBTAB_PANEL_ELS = { auto: 'panelAuto', futures: 'panelFutures' };
const SUBTAB_SLUGS = { auto: 'autotrade-balances', futures: 'ai-futures-engine' };
const SUBTAB_ALIASES = {
  'autotrade-balances': 'auto', 'auto': 'auto',
  'ai-futures-engine': 'futures', 'futures': 'futures', 'bots': 'futures',
};

// Which sub-tab a URL hash points at, or null if it isn't one of ours.
export function subTabFromHash(hash){
  const h = String(hash === undefined ? location.hash : hash).replace(/^#/, '').toLowerCase();
  return SUBTAB_ALIASES[h] || null;
}

export function switchSubTab(which, opts){
  SUBTAB_KEYS.forEach(key => {
    const btn = els[SUBTAB_BTN_ELS[key]];
    const panel = els[SUBTAB_PANEL_ELS[key]];
    if(!btn || !panel) return;
    const active = which === key;
    btn.classList.toggle('active', active);
    panel.classList.toggle('active', active);
    btn.setAttribute('aria-selected', active);
  });
  // Only write to the URL when the person actually clicked a tab, and only if
  // it doesn't already point here (an alias like #bots is left as it is).
  if(opts && opts.updateUrl && SUBTAB_SLUGS[which] && subTabFromHash() !== which){
    history.pushState(null, '', location.pathname + location.search + '#' + SUBTAB_SLUGS[which]);
  }
}

export function initSubTabRouting(){
  if(!els.tabAutoBtn || !els.tabFuturesBtn) return; // other pages don't have the sub-tabs
  const buttons = { auto: els.tabAutoBtn, futures: els.tabFuturesBtn };
  Object.keys(buttons).forEach(which => {
    buttons[which].addEventListener('click', (e) => {
      // Let ctrl/cmd/shift/middle-click do their normal "open in new tab/window" thing.
      if(e.button || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
      e.preventDefault(); // we set the hash ourselves so the page doesn't jump
      switchSubTab(which, { updateUrl: true });
    });
  });
  // Back/Forward, or someone editing the hash by hand. No hash at all means the
  // default tab; a hash that isn't ours (e.g. some future in-page anchor) is ignored.
  const syncFromUrl = () => {
    const which = subTabFromHash() || (location.hash ? null : 'auto');
    if(which) switchSubTab(which);
  };
  window.addEventListener('hashchange', syncFromUrl);
  window.addEventListener('popstate', syncFromUrl);
  const initial = subTabFromHash();
  if(initial) switchSubTab(initial);
}
