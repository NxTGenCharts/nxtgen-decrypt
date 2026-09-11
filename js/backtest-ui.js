// =============================================================
// backtest-ui.js — wires the Backtest section (index.html) to
// js/futures/backtest.js's simulation engine: gathers the form inputs,
// fetches real historical candles per symbol via server.js's
// /api/backtest/klines (through the same callProxy futures-ui.js
// already uses for Live/Demo), runs the walk-forward simulation, and
// renders the results (stat cards, an equity curve, per-strategy
// breakdown, and an exportable trade list).
// =============================================================
import { els } from './state.js';
import { callProxy, fmtUsd } from './futures-ui.js';
import { TRADEABLE_FUTURES_SYMBOLS } from './futures/engine.js';
import { STRATEGY_REGISTRY } from './futures/setups.js';
import { DEFAULT_FEE_CONFIG } from './futures/costs.js';
import { runBacktest, summarizeTrades } from './futures/backtest.js';

let lastResult = null; // kept for CSV/XLS/PDF export after a run

function showBtMessage(msg, kind){
  if(!els.btMessages) return;
  els.btMessages.textContent = msg;
  els.btMessages.style.color = kind === 'error' ? 'var(--red)' : (kind === 'ok' ? 'var(--green)' : 'var(--dim)');
}

function populateSymbolChecks(){
  if(!els.btSymbolChecks) return;
  // A reasonable default selection (not literally all 29 tradeable
  // symbols) so a first run finishes in a sensible time — Select
  // All/None below make widening or narrowing it a one-click choice.
  const defaultOn = new Set(TRADEABLE_FUTURES_SYMBOLS.slice(0, 10));
  els.btSymbolChecks.innerHTML = TRADEABLE_FUTURES_SYMBOLS.map(sym => `
    <label style="display:flex;align-items:center;gap:5px;font-size:12px;white-space:nowrap;">
      <input type="checkbox" class="bt-symbol-check" value="${sym}" ${defaultOn.has(sym) ? 'checked' : ''}>${sym}
    </label>
  `).join('');
}

function populateStrategyChecks(){
  if(!els.btStrategyChecks) return;
  els.btStrategyChecks.innerHTML = STRATEGY_REGISTRY.map(s => `
    <label style="display:flex;align-items:center;gap:6px;font-size:12.5px;" title="${s.description.replace(/"/g, '&quot;')}">
      <input type="checkbox" class="bt-strategy-check" value="${s.id}" ${s.defaultEnabled ? 'checked' : ''}>${s.label}
    </label>
  `).join('');
}

function selectedSymbols(){
  return Array.from(document.querySelectorAll('.bt-symbol-check:checked')).map(el => el.value);
}

function selectedStrategyConfig(){
  const cfg = {};
  document.querySelectorAll('.bt-strategy-check').forEach(el => { cfg[el.value] = el.checked; });
  return cfg;
}

function updateFeeDefaults(){
  const exchange = els.btExchange ? els.btExchange.value : 'binance';
  const fees = DEFAULT_FEE_CONFIG[exchange] || DEFAULT_FEE_CONFIG.binance;
  if(els.btMakerFee) els.btMakerFee.value = fees.makerPct;
  if(els.btTakerFee) els.btTakerFee.value = fees.takerPct;
}

function computeRangeMs(){
  const preset = els.btRangePreset ? els.btRangePreset.value : '30';
  const endMs = Date.now();
  if(preset !== 'custom'){
    const days = parseInt(preset, 10) || 30;
    return { startMs: endMs - days * 24 * 60 * 60_000, endMs };
  }
  const fromVal = els.btCustomFrom && els.btCustomFrom.value;
  const toVal = els.btCustomTo && els.btCustomTo.value;
  if(!fromVal || !toVal) return null;
  const startMs = new Date(fromVal + 'T00:00:00Z').getTime();
  const customEndMs = new Date(toVal + 'T23:59:59Z').getTime();
  if(!(startMs < customEndMs)) return null;
  return { startMs, endMs: Math.min(customEndMs, endMs) };
}

async function fetchSymbolKlines(exchange, symbol, startMs, endMs){
  const data = await callProxy('/api/backtest/klines', { exchange, symbol, interval: '5m', startMs, endMs });
  if(!data.ok) throw new Error(data.message || `Could not fetch ${symbol} history.`);
  return data.candles || [];
}

async function runBacktestFlow(){
  const range = computeRangeMs();
  if(!range){ showBtMessage('Pick a valid custom date range (From before To).', 'error'); return; }
  const symbols = selectedSymbols();
  if(!symbols.length){ showBtMessage('Select at least one symbol to test.', 'error'); return; }
  const strategies = selectedStrategyConfig();
  if(!Object.values(strategies).some(Boolean)){ showBtMessage('Enable at least one strategy to test.', 'error'); return; }

  const exchange = els.btExchange.value;
  const startingEquity = Math.max(100, parseFloat(els.btStartingBalance.value) || 10000);
  const riskPctPerTrade = Math.min(50, Math.max(0.1, parseFloat(els.btRiskPct.value) || 1));
  const leverage = Math.min(10, Math.max(1, parseInt(els.btLeverage.value, 10) || 5));
  const minConfidence = Math.min(100, Math.max(0, parseInt(els.btMinConfidence.value, 10) || 70));
  const makerPct = parseFloat(els.btMakerFee.value) || 0;
  const takerPct = parseFloat(els.btTakerFee.value) || 0;
  const spreadPct = Math.max(0, parseFloat(els.btSpreadPct.value) || 0);
  const fundingRatePct = parseFloat(els.btFundingPct.value) || 0;

  els.btRunBtn.disabled = true;
  els.btResults.style.display = 'none';
  showBtMessage('Fetching real historical candles…');

  // Always fetch BTCUSDT too (even if not selected to trade) — the
  // cross-market BTC-shock filter every non-BTC signal is checked
  // against in real trading needs real data to work from, not a
  // silently-disabled filter.
  const fetchList = Array.from(new Set([...symbols, 'BTCUSDT']));
  const candlesBySymbol = {};
  const failed = [];
  for(let i = 0; i < fetchList.length; i++){
    const sym = fetchList[i];
    els.btProgress.textContent = `Fetching history: ${i + 1}/${fetchList.length} (${sym})`;
    try{
      candlesBySymbol[sym] = await fetchSymbolKlines(exchange, sym, range.startMs, range.endMs);
      if(!candlesBySymbol[sym].length) failed.push(`${sym} (no data returned)`);
    }catch(err){
      failed.push(`${sym} (${err.message})`);
    }
  }

  const usableSymbols = symbols.filter(s => candlesBySymbol[s] && candlesBySymbol[s].length);
  if(!usableSymbols.length){
    els.btRunBtn.disabled = false;
    els.btProgress.textContent = '';
    showBtMessage(`Couldn't fetch usable history for any selected symbol. ${failed.join('; ')}`, 'error');
    return;
  }

  // Sanity-check coverage BEFORE simulating: what was actually fetched,
  // in days, versus what was requested — so a fetch that silently comes
  // up short (a pagination bug, a symbol with less exchange history than
  // the range asked for, etc.) is visible immediately instead of only
  // showing up as "surprisingly few trades" after the fact.
  const requestedDays = (range.endMs - range.startMs) / 86_400_000;
  const coverage = usableSymbols.slice(0, 4).map(s => {
    const arr = candlesBySymbol[s];
    const gotDays = arr.length ? (arr[arr.length - 1].t - arr[0].t) / 86_400_000 : 0;
    return `${s}: ${arr.length} bars (~${gotDays.toFixed(1)}d)`;
  }).join(', ');
  console.log(`[Backtest] Requested ~${requestedDays.toFixed(1)}d — got: ${coverage}${usableSymbols.length > 4 ? ', …' : ''}`);

  const cfg = {
    exchange, strategies, minConfidence, riskPctPerTrade, leverage,
    feeConfig: { ...DEFAULT_FEE_CONFIG, [exchange]: { makerPct, takerPct } },
  };

  showBtMessage(failed.length ? `Simulating (skipped: ${failed.join('; ')})…` : 'Simulating…');
  try{
    const result = await runBacktest({
      candlesBySymbol, symbols: usableSymbols, cfg, startingEquity,
      metaOverrides: { spreadPct, fundingRatePct },
      onProgress: (frac) => { els.btProgress.textContent = `Simulating… ${Math.round(frac * 100)}%`; },
    });
    lastResult = { ...result, startingEquity };
    renderBacktestResults(lastResult);
    showBtMessage(
      failed.length
        ? `Done. Skipped: ${failed.join('; ')}.`
        : `Done — ${result.barsEvaluated.toLocaleString()} symbol-bars evaluated across ${usableSymbols.length} symbol(s). Coverage: ${coverage}${usableSymbols.length > 4 ? ', …' : ''} (requested ~${requestedDays.toFixed(1)}d).`,
      failed.length ? 'error' : 'ok'
    );
  }catch(err){
    showBtMessage(`Backtest failed: ${err.message}`, 'error');
  }finally{
    els.btRunBtn.disabled = false;
    els.btProgress.textContent = '';
  }
}

function renderEquityCurveSvg(equityCurve){
  if(!els.btEquityChart) return;
  if(!equityCurve.length){ els.btEquityChart.innerHTML = ''; return; }
  const W = 760, H = 160, PAD = 8;
  const values = equityCurve.map(p => p.equity);
  const min = Math.min(...values), max = Math.max(...values);
  const span = (max - min) || 1;
  const stepX = (W - PAD * 2) / Math.max(1, equityCurve.length - 1);
  const points = equityCurve.map((p, i) => {
    const x = PAD + i * stepX;
    const y = H - PAD - ((p.equity - min) / span) * (H - PAD * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  const positive = equityCurve[equityCurve.length - 1].equity >= equityCurve[0].equity;
  const color = positive ? 'var(--green)' : 'var(--red)';
  els.btEquityChart.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" style="width:100%;height:${H}px;display:block;">
      <polyline points="${points}" fill="none" stroke="${color}" stroke-width="1.6" />
    </svg>
    <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--dim);margin-top:4px;">
      <span>${fmtUsd(min - equityCurve[0].equity + equityCurve[0].equity).replace('+', '')}</span>
      <span>Low $${min.toLocaleString('en-US', { maximumFractionDigits: 0 })} · High $${max.toLocaleString('en-US', { maximumFractionDigits: 0 })}</span>
      <span></span>
    </div>
  `;
}

function renderBacktestResults(result){
  const stats = summarizeTrades(result.trades, result.startingEquity);
  els.btResults.style.display = '';
  els.btrTrades.textContent = String(stats.count);
  els.btrWinRate.textContent = stats.winRate.toFixed(1) + '%';
  els.btrPF.textContent = Number.isFinite(stats.profitFactor) ? stats.profitFactor.toFixed(2) : '∞';
  els.btrNet.textContent = fmtUsd(stats.netUsd);
  els.btrNet.style.color = stats.netUsd >= 0 ? 'var(--green)' : 'var(--red)';
  els.btrReturn.textContent = stats.netReturnPct.toFixed(2) + '%';
  els.btrDD.textContent = result.dayState.maxDrawdownPct.toFixed(2) + '%';
  els.btrAvg.textContent = `${fmtUsd(stats.avgWinUsd)} / ${fmtUsd(stats.avgLossUsd)}`;
  els.btrFees.textContent = '-$' + stats.feesUsd.toFixed(2);

  renderEquityCurveSvg(result.equityCurve);

  const strategyRows = Object.entries(stats.byStrategy).sort((a, b) => b[1].netUsd - a[1].netUsd);
  els.btByStrategy.innerHTML = strategyRows.length ? `
    <div style="display:grid;grid-template-columns:1.4fr .7fr .7fr .9fr;gap:6px;font-weight:600;color:var(--dim);padding:4px 0;">
      <div>Strategy</div><div>Trades</div><div>Win Rate</div><div>Net</div>
    </div>
    ${strategyRows.map(([name, s]) => `
      <div style="display:grid;grid-template-columns:1.4fr .7fr .7fr .9fr;gap:6px;padding:4px 0;border-top:1px solid var(--line);">
        <div>${name}</div><div>${s.trades}</div><div>${((s.wins / s.trades) * 100).toFixed(1)}%</div>
        <div style="color:${s.netUsd >= 0 ? 'var(--green)' : 'var(--red)'};">${fmtUsd(s.netUsd)}</div>
      </div>
    `).join('')}
  ` : '<div class="fu-empty">No trades to break down.</div>';

  els.btTradeRows.innerHTML = result.trades.length ? result.trades.slice(0, 1000).map(t => `
    <div class="fu-hrow ${t.netUsd >= 0 ? 'fu-win' : 'fu-loss'}" style="grid-template-columns:1.1fr .7fr 1fr .6fr .8fr .8fr .5fr .7fr .8fr .8fr .8fr .6fr .9fr;">
      <div>${new Date(t.closedAtMs).toLocaleString()}</div>
      <div>${t.exchange}</div>
      <div>${t.symbol}</div>
      <div>${t.direction}</div>
      <div>${Number(t.entry).toFixed(4)}</div>
      <div>${Number(t.exit).toFixed(4)}</div>
      <div>${t.leverage}x</div>
      <div>${t.qty.toFixed(4)}</div>
      <div>${fmtUsd(t.grossUsd)}</div>
      <div>${fmtUsd(-Math.abs(t.feesUsd))}</div>
      <div>${fmtUsd(t.netUsd)}</div>
      <div>${t.durationMin}m</div>
      <div>${t.exitReason}</div>
    </div>
  `).join('') : '<div class="fu-empty">No trades this run.</div>';
}

// ---- Export (CSV / XLS / PDF) — same approach as the Trade Log's own
// exporters (js/futures-ui.js), duplicated in miniature here rather
// than shared, since this operates on an in-memory backtest result
// instead of the persisted Trade Log. ----
function btColumns(){
  return [
    { label: 'Date/Time', get: t => new Date(t.closedAtMs).toLocaleString() },
    { label: 'Exchange', get: t => t.exchange },
    { label: 'Symbol', get: t => t.symbol },
    { label: 'Dir', get: t => t.direction },
    { label: 'Entry', get: t => Number(t.entry) },
    { label: 'Exit', get: t => Number(t.exit) },
    { label: 'Leverage', get: t => `${t.leverage}x` },
    { label: 'Qty', get: t => t.qty },
    { label: 'Gross', get: t => t.grossUsd },
    { label: 'Fees', get: t => t.feesUsd },
    { label: 'Net', get: t => t.netUsd },
    { label: 'Duration (min)', get: t => t.durationMin },
    { label: 'Strategy', get: t => t.setupType },
    { label: 'Exit Reason', get: t => t.exitReason },
  ];
}

function csvEscapeBt(val){
  const s = String(val ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function downloadBlobBt(filename, content, mime){
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportBacktestCsv(){
  if(!lastResult || !lastResult.trades.length){ showBtMessage('Run a backtest first — nothing to export yet.', 'error'); return; }
  const cols = btColumns();
  const lines = [cols.map(c => csvEscapeBt(c.label)).join(',')];
  lastResult.trades.forEach(t => lines.push(cols.map(c => csvEscapeBt(c.get(t))).join(',')));
  downloadBlobBt(`nxtgen-backtest-${Date.now()}.csv`, lines.join('\r\n'), 'text/csv;charset=utf-8;');
}

function exportBacktestXls(){
  if(!lastResult || !lastResult.trades.length){ showBtMessage('Run a backtest first — nothing to export yet.', 'error'); return; }
  const cols = btColumns();
  const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const head = `<tr>${cols.map(c => `<th>${esc(c.label)}</th>`).join('')}</tr>`;
  const body = lastResult.trades.map(t => `<tr>${cols.map(c => `<td>${esc(c.get(t))}</td>`).join('')}</tr>`).join('');
  const html = `<html><head><meta charset="UTF-8"></head><body><table border="1">${head}${body}</table></body></html>`;
  downloadBlobBt(`nxtgen-backtest-${Date.now()}.xls`, html, 'application/vnd.ms-excel');
}

async function ensureJsPdfBt(){
  if(window.jspdf && window.jspdf.jsPDF) return window.jspdf;
  const loadScript = src => new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src; s.onload = () => resolve(); s.onerror = () => reject(new Error(`could not load ${src}`));
    document.head.appendChild(s);
  });
  await loadScript('https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.2/jspdf.umd.min.js');
  await loadScript('https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.8.4/jspdf.plugin.autotable.min.js');
  if(!window.jspdf || !window.jspdf.jsPDF) throw new Error('PDF library failed to initialize');
  return window.jspdf;
}

async function exportBacktestPdf(){
  if(!lastResult || !lastResult.trades.length){ showBtMessage('Run a backtest first — nothing to export yet.', 'error'); return; }
  showBtMessage('Building PDF…');
  try{
    const { jsPDF } = await ensureJsPdfBt();
    const cols = btColumns();
    const stats = summarizeTrades(lastResult.trades, lastResult.startingEquity);
    const doc = new jsPDF({ orientation: 'landscape' });
    doc.setFontSize(12);
    doc.text('NxTGen Backtest Results', 14, 14);
    doc.setFontSize(8);
    doc.text(`${stats.count} trades · ${stats.winRate.toFixed(1)}% win rate · net ${fmtUsd(stats.netUsd)} · ${new Date().toLocaleString()}`, 14, 20);
    doc.autoTable({
      startY: 24,
      head: [cols.map(c => c.label)],
      body: lastResult.trades.map(t => cols.map(c => String(c.get(t)))),
      styles: { fontSize: 7 },
      headStyles: { fillColor: [20, 20, 30] },
    });
    doc.save(`nxtgen-backtest-${Date.now()}.pdf`);
    showBtMessage('Exported PDF.', 'ok');
  }catch(err){
    showBtMessage(`PDF export failed: ${err.message} — needs an internet connection the first time, to load the PDF library.`, 'error');
  }
}

export function initBacktestUI(){
  populateSymbolChecks();
  populateStrategyChecks();
  updateFeeDefaults();

  if(els.btExchange) els.btExchange.addEventListener('change', updateFeeDefaults);
  if(els.btRangePreset) els.btRangePreset.addEventListener('change', () => {
    const custom = els.btRangePreset.value === 'custom';
    if(els.btCustomFromField) els.btCustomFromField.style.display = custom ? '' : 'none';
    if(els.btCustomToField) els.btCustomToField.style.display = custom ? '' : 'none';
  });
  if(els.btSymbolsAllBtn) els.btSymbolsAllBtn.addEventListener('click', () => {
    document.querySelectorAll('.bt-symbol-check').forEach(el => { el.checked = true; });
  });
  if(els.btSymbolsNoneBtn) els.btSymbolsNoneBtn.addEventListener('click', () => {
    document.querySelectorAll('.bt-symbol-check').forEach(el => { el.checked = false; });
  });
  if(els.btRunBtn) els.btRunBtn.addEventListener('click', runBacktestFlow);
  if(els.btExportCsvBtn) els.btExportCsvBtn.addEventListener('click', exportBacktestCsv);
  if(els.btExportXlsBtn) els.btExportXlsBtn.addEventListener('click', exportBacktestXls);
  if(els.btExportPdfBtn) els.btExportPdfBtn.addEventListener('click', exportBacktestPdf);
}
