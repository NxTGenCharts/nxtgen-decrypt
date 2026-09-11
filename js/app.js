// =============================================================
// app.js — application initialization and orchestration.
// The site is now a set of separate HTML pages (Overview,
// Triangular Arbitrage, Cross-Exchange, Autotrade & Futures, API
// Keys) instead of one single-page app with JS-driven tabs, so
// top-level nav is just real <a href> links now — no click-based
// tab switching needed for it.
//
// This module is still imported on every page, but each page
// only contains a subset of the elements below, so every wire-up
// is guarded on the element actually existing before touching it.
// =============================================================
import { els, state } from './state.js';
import { switchSubTab } from './ui.js';
import { runScan, startLiveScan, stopLiveScan } from './triangular.js';
import { runXScan } from './cross-exchange.js';
import { initAutotrade } from './autotrade.js';
import { initFuturesEngine } from './futures-ui.js';
import { initAiSignal } from './ai-signal.js';
import { initBacktestUI } from './backtest-ui.js';

// ---- Overview page ----
// "Run Full Scan" runs both engines to refresh the dashboard cards. Overview
// carries a hidden copy of the Triangular/Cross-Exchange panel markup (see
// index.html) purely so these two functions have the input/output elements
// they expect — same scan code as the dedicated pages, just not shown.
if(els.ovRunBtn) els.ovRunBtn.addEventListener('click', () => { runScan(); runXScan(); });

// Auto-run the triangular scan on load wherever its panel exists (visibly on
// the Triangular Arbitrage page, or hidden on Overview) so the Overview
// dashboard and the Triangular results are populated without a click —
// matches the original single-page behavior. Cross-Exchange has never
// auto-scanned on load; it only runs via its own Scan button or Overview's
// Run Full Scan.
if(els.results) window.addEventListener('load', runScan);

// ---- Triangular Arbitrage page ----
if(els.liveBtn) els.liveBtn.addEventListener('click', () => { state.isLive ? stopLiveScan() : startLiveScan(); });
if(els.scanBtn) els.scanBtn.addEventListener('click', runScan);

// ---- Cross-Exchange page ----
if(els.xScanBtn) els.xScanBtn.addEventListener('click', runXScan);

// ---- Autotrade & Futures page ----
// tabAutoBtn/tabFuturesBtn are the sub-tab switch within this one page.
if(els.tabAutoBtn) els.tabAutoBtn.addEventListener('click', () => switchSubTab('auto'));
if(els.tabFuturesBtn) els.tabFuturesBtn.addEventListener('click', () => switchSubTab('futures'));

// ---- Init calls: each one is a no-op (or close to it) on a page that
// doesn't have its elements, since every render function it calls now
// guards on its own elements existing. ----
initAutotrade();
initFuturesEngine();
initAiSignal();
initBacktestUI();
