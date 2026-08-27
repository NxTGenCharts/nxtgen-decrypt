// =============================================================
// app.js — application initialization and orchestration.
// Wires up the tab-level and cross-cutting event listeners that
// don't belong to a single engine module, then kicks off the
// first scan on load (same behavior as the original file).
// =============================================================
import { els, state } from './state.js';
import { switchTabAll } from './ui.js';
import { runScan, startLiveScan, stopLiveScan } from './triangular.js';
import { runXScan } from './cross-exchange.js';
import { initAutotrade } from './autotrade.js';
import { initFuturesEngine } from './futures-ui.js';

els.tabOverviewBtn.addEventListener('click', () => switchTabAll('overview'));
els.ovRunBtn.addEventListener('click', () => { runScan(); runXScan(); });

// Route the tri/x/auto tab buttons through the 4-way switch too, so clicking
// them also deactivates the other panels correctly.
els.tabTriBtn.addEventListener('click', () => switchTabAll('tri'));
els.tabXBtn.addEventListener('click', () => switchTabAll('x'));
els.tabAutoBtn.addEventListener('click', () => switchTabAll('auto'));
els.tabFuturesBtn.addEventListener('click', () => switchTabAll('futures'));

els.liveBtn.addEventListener('click', () => { state.isLive ? stopLiveScan() : startLiveScan(); });

els.scanBtn.addEventListener('click', runScan);
els.xScanBtn.addEventListener('click', runXScan);

window.addEventListener('load', runScan);
initAutotrade();
initFuturesEngine();
