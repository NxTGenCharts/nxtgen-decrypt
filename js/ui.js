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

// Single source of truth for tab switching across all 3 panels.
export function switchTabAll(which){
  els.tabOverviewBtn.classList.toggle('active', which === 'overview');
  els.tabTriBtn.classList.toggle('active', which === 'tri');
  els.tabXBtn.classList.toggle('active', which === 'x');
  els.tabAutoBtn.classList.toggle('active', which === 'auto');
  els.panelOverview.classList.toggle('active', which === 'overview');
  els.panelTri.classList.toggle('active', which === 'tri');
  els.panelX.classList.toggle('active', which === 'x');
  els.panelAuto.classList.toggle('active', which === 'auto');
  els.tabOverviewBtn.setAttribute('aria-selected', which === 'overview');
  els.tabTriBtn.setAttribute('aria-selected', which === 'tri');
  els.tabXBtn.setAttribute('aria-selected', which === 'x');
  els.tabAutoBtn.setAttribute('aria-selected', which === 'auto');
}
