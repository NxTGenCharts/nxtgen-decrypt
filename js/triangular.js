// =============================================================
// triangular.js — triangular arbitrage engine (graph build +
// cycle search), Live Scan NEW/OPEN/CLOSED tracking, and the
// opportunity-card rendering for the Triangular tab. Calculation
// logic is unchanged from the original monolithic file.
// =============================================================
import { els, state } from './state.js';
import { EXCHANGES, filterTriPairs } from './exchanges.js';
import { coinIconHtml, fmtPct } from './utils.js';
import { setStatus, showMessage, updateExchangeBadge, renderOverview } from './ui.js';

export function buildGraph(pairs, useLastPriceNoSpread){
  // adj[currency] = [{to, rate, symbol, side}]
  const adj = new Map();
  const add = (from, to, rate, symbol, side) => {
    if(!adj.has(from)) adj.set(from, []);
    adj.get(from).push({ to, rate, symbol, side });
  };
  for(const p of pairs){
    if(useLastPriceNoSpread){
      // Theoretical mode: reproduces the CLI scanner's math exactly — one
      // last-traded price used for both directions (no bid/ask spread).
      // Inflates results, since it assumes you can buy and sell at the same
      // price. Comparison-only; not a realistic fill.
      const last = p.last || (p.bid + p.ask) / 2;
      add(p.base, p.quote, last, p.symbol, 'SELL');
      add(p.quote, p.base, 1/last, p.symbol, 'BUY');
    } else {
      // sell base -> quote, using bid
      add(p.base, p.quote, p.bid, p.symbol, 'SELL');
      // buy base with quote, using ask (1 quote -> 1/ask base)
      add(p.quote, p.base, 1/p.ask, p.symbol, 'BUY');
    }
  }
  return adj;
}

export function findCycles(adj, anchor, feePct, exchangeKey){
  const feeMult = 1 - (feePct/100);
  const results = [];
  const seenKeys = new Set();
  let checked = 0;

  const currencies = anchor === 'ALL' ? Array.from(adj.keys()) : [anchor];

  for(const A of currencies){
    const edgesA = adj.get(A);
    if(!edgesA) continue;
    for(const e1 of edgesA){
      const B = e1.to;
      if(B === A) continue;
      const edgesB = adj.get(B);
      if(!edgesB) continue;
      for(const e2 of edgesB){
        const C = e2.to;
        if(C === A || C === B) continue;
        const edgesC = adj.get(C);
        if(!edgesC) continue;
        checked++;
        for(const e3 of edgesC){
          if(e3.to !== A) continue;
          // dedupe rotations of the same directed loop (A->B->C->A == B->C->A->B == C->A->B->C).
          // Rotate to start at the lexicographically-smallest currency; the *order* is preserved,
          // so the reverse-direction loop (A->C->B->A) still gets its own distinct key.
          const rotations = [[A,B,C], [B,C,A], [C,A,B]];
          rotations.sort((r1, r2) => r1[0].localeCompare(r2[0]));
          const canonical = rotations[0].join('|');
          if(seenKeys.has(canonical)) continue;

          const mult = e1.rate * e2.rate * e3.rate * Math.pow(feeMult, 3);
          const profitPct = (mult - 1) * 100;
          seenKeys.add(canonical);
          results.push({
            exchange: exchangeKey,
            path:[A,B,C],
            legs:[e1,e2,e3],
            profitPct,
            mult,
            // Identity of this loop across scans, independent of which node
            // it happened to be discovered from — same loop + same direction
            // = same key even if anchor/discovery order shifts between
            // scans. Used only for Live Scan's NEW/OPEN/CLOSED tracking.
            canonicalKey: exchangeKey + '|' + canonical,
          });
        }
      }
    }
  }
  return { results, checked };
}

// Tags each currently-visible cycle NEW (first time its canonicalKey has
// been seen this Live Scan session) or OPEN (seen on a previous pass too),
// and returns the cycles that were tracked last pass but didn't show up
// this pass — i.e. closed. Identical semantics to main.py's tracked-signature
// diffing, just keyed on canonicalKey instead of the rotated currency tuple.
function updateTracking(results){
  const currentKeys = new Set();
  for(const r of results){
    currentKeys.add(r.canonicalKey);
    const existing = state.trackedCycles.get(r.canonicalKey);
    if(existing){
      r.trackStatus = 'OPEN';
      r.firstSeen = existing.firstSeen;
    } else {
      state.opportunityCounter++;
      const firstSeen = new Date().toLocaleTimeString();
      state.trackedCycles.set(r.canonicalKey, { number: state.opportunityCounter, firstSeen });
      r.trackStatus = 'NEW';
      r.firstSeen = firstSeen;
    }
  }
  const closedKeys = [];
  for(const key of state.trackedCycles.keys()){
    if(!currentKeys.has(key)) closedKeys.push(key);
  }
  const closed = closedKeys.map(key => {
    const info = state.trackedCycles.get(key);
    state.trackedCycles.delete(key);
    return { ...info, key };
  });
  return closed;
}

function resetTracking(){
  state.trackedCycles = new Map();
  state.opportunityCounter = 0;
  els.closedStrip.innerHTML = '';
}

function render(cycles){
  if(cycles.length === 0){
    els.results.innerHTML = `<div class="empty">No cycles cleared your min-profit filter right now. Markets move fast — try lowering the filter or scanning again.</div>`;
    return;
  }
  const top = cycles.slice(0, 20);
  els.results.innerHTML = top.map((c, i) => {
    const [A,B,C] = c.path;
    const loopHtml = `
      <span class="node start">${coinIconHtml(A,16)}${A}</span>
      ${c.legs.map((leg, idx) => {
        const toCur = idx===0 ? B : idx===1 ? C : A;
        const actClass = leg.side === 'BUY' ? 'buy' : 'sell';
        const nodeClass = idx===2 ? 'node start' : 'node';
        return `<div class="leg">
            <span class="act ${actClass}">${leg.side}</span>
            <span class="arrow">→</span>
            <span class="pair">${leg.symbol}</span>
          </div>
          <span class="${nodeClass}">${coinIconHtml(toCur,16)}${toCur}</span>`;
      }).join('')}
    `;
    const profitClass = c.profitPct < 0 ? 'profit neg' : c.profitPct < 0.15 ? 'profit low' : 'profit';
    const exLabel = EXCHANGES[c.exchange] ? EXCHANGES[c.exchange].label : c.exchange;

    // Step-by-step walkthrough: "buy X with Y at <rate>" for BUY legs,
    // "sell X for Y at <rate>" for SELL legs — the rate is exactly the
    // conversion rate used in the profit math for that leg, so the numbers
    // here are the same ones a person would need to key into each exchange.
    const curs = [A,B,C,A];
    const stepsHtml = c.legs.map((leg, idx) => {
      const fromCur = curs[idx];
      const toCur = curs[idx+1];
      const rateStr = leg.rate.toFixed(5);
      const text = leg.side === 'BUY'
        ? `<span class="verb buy">buy</span> ${toCur} with ${fromCur} <span class="rate">at ${rateStr}</span>`
        : `<span class="verb sell">sell</span> ${fromCur} for ${toCur} <span class="rate">at ${rateStr}</span>`;
      return `<li>${text}</li>`;
    }).join('');
    const stepsPanel = `<div class="steps">
      <div class="steps-title">Execution path — <b>${fmtPct(c.profitPct)}</b> on ${exLabel}:</div>
      <ol>${stepsHtml}</ol>
    </div>`;

    const trackHtml = c.trackStatus
      ? `<span class="trackbadge ${c.trackStatus.toLowerCase()}" title="First seen ${c.firstSeen}">${c.trackStatus}</span>`
      : '';

    return `<div class="row" tabindex="0" role="button" aria-expanded="false">
      <div class="rank-wrap"><div class="rank ${i===0?'top1':''}">#${i+1}</div>${trackHtml}</div>
      <div class="loop">${loopHtml}<span class="exch ${c.exchange}">${exLabel}</span></div>
      <div class="result">
        <div class="${profitClass}">${fmtPct(c.profitPct)}</div>
        <div class="yield">100 ${A} → ${(100*c.mult).toFixed(4)} ${A}</div>
        <div class="expand-hint">Execution path <span class="chev">&#9662;</span></div>
      </div>
      ${stepsPanel}
    </div>`;
  }).join('');
}

function renderClosedStrip(closed){
  if(!closed.length) return;
  const now = new Date().toLocaleTimeString();
  const items = closed.map(c => `<div class="closed-item">#${c.number} <b>CLOSED</b> — opened ${c.firstSeen}, closed ${now}</div>`).join('');
  // Prepend so the newest closures sit on top; cap the strip so it can't grow forever across a long Live Scan session.
  els.closedStrip.innerHTML = items + els.closedStrip.innerHTML;
  const nodes = els.closedStrip.querySelectorAll('.closed-item');
  if(nodes.length > 8) for(let i = 8; i < nodes.length; i++) nodes[i].remove();
}

// Expand/collapse the execution-path detail on click (presentation only —
// no calculation happens here, it only toggles visibility of the already
// rendered .steps block for that row).
els.results.addEventListener('click', (e) => {
  const row = e.target.closest('.row');
  if(!row) return;
  const open = row.classList.toggle('row--open');
  row.setAttribute('aria-expanded', open ? 'true' : 'false');
});
els.results.addEventListener('keydown', (e) => {
  if(e.key !== 'Enter' && e.key !== ' ') return;
  const row = e.target.closest('.row');
  if(!row) return;
  e.preventDefault();
  const open = row.classList.toggle('row--open');
  row.setAttribute('aria-expanded', open ? 'true' : 'false');
});

els.fee.disabled = els.cliMode.checked; // reflect the checkbox's initial (checked-by-default) state on load
els.cliMode.addEventListener('change', () => {
  els.fee.disabled = els.cliMode.checked;
  showMessage(els.cliMode.checked
    ? `Theoretical mode is on — this uses one last-traded price for both the buy and sell leg (no bid/ask spread) and applies no fee, exactly like the CLI scanner. Real fills always cost more than this suggests; treat any positive % here as a ceiling, not a plan.`
    : '', els.cliMode.checked ? 'info' : '');
});

export async function runScan(){
  if(state.scanInFlight) return; // a manual click landed mid-tick of an active Live Scan — skip rather than overlap
  state.scanInFlight = true;
  els.scanBtn.disabled = true;
  els.scanBtn.classList.add('is-scanning');
  els.scanBtn.querySelector('.btn-label').textContent = 'Scanning Markets…';
  els.results.classList.add('is-loading');
  setStatus('', 'connecting…');
  showMessage('', '');
  try{
    const exchangeSel = els.exchange.value;
    const keys = exchangeSel === 'ALL' ? Object.keys(EXCHANGES) : [exchangeSel];
    const anchor = els.anchor.value;
    const cliMode = els.cliMode.checked;
    const feePct = cliMode ? 0 : (parseFloat(els.fee.value) || 0);
    const minProfit = parseFloat(els.minProfit.value);
    const minVolume = parseFloat(els.minVolume.value) || 0;

    let totalPairs = 0, totalChecked = 0;
    let allResults = [];
    const failed = [];

    for(const key of keys){
      try{
        const rawPairs = await EXCHANGES[key].load();
        state.pairsCache[key] = rawPairs; // full, unfiltered — used by Overview's market count and the Cross-Exchange tab
        updateExchangeBadge(key, 'up');
        // Fiat on/off-ramp pairs and anything under the volume floor are dropped
        // before the graph is built — same order as the CLI scanner's filtering.
        const pairs = filterTriPairs(rawPairs, minVolume);
        totalPairs += pairs.length;
        const adj = buildGraph(pairs, cliMode);
        const { results, checked } = findCycles(adj, anchor, feePct, key);
        totalChecked += checked;
        allResults = allResults.concat(results);
      }catch(exErr){
        console.error(key, exErr);
        failed.push(EXCHANGES[key].label);
        updateExchangeBadge(key, 'down');
      }
    }

    els.statPairs.textContent = totalPairs.toLocaleString();
    els.statCycles.textContent = totalChecked.toLocaleString();

    if(totalPairs === 0){
      throw new Error(failed.length ? `all selected exchanges failed (${failed.join(', ')})` : 'no markets cleared the fiat/volume filter — try lowering min 24h volume');
    }
    setStatus('live', failed.length ? `connected (${failed.join(', ')} failed)` : 'connected');

    const ranked = allResults
      .filter(r => isFinite(r.profitPct))
      .sort((a,b) => b.profitPct - a.profitPct);

    const filtered = ranked.filter(r => r.profitPct >= minProfit);

    // Live Scan tracks whichever set is actually being displayed, so a
    // NEW badge always lines up with the row a person is looking at —
    // filtered opportunities when any clear the bar, otherwise the
    // closest-cycles fallback list.
    const shown = filtered.length > 0 ? filtered : ranked;
    if(state.isLive){
      const closed = updateTracking(shown);
      renderClosedStrip(closed);
    } else {
      for(const r of shown) r.trackStatus = null;
    }

    els.statHits.textContent = filtered.length;
    els.lastUpdate.textContent = 'Last update — ' + new Date().toLocaleTimeString();

    state.lastTri = {
      pairsLoaded: totalPairs,
      cyclesChecked: totalChecked,
      profitable: filtered.length,
      bestPct: ranked.length ? ranked[0].profitPct : null,
      bestExchange: ranked.length ? (EXCHANGES[ranked[0].exchange] ? EXCHANGES[ranked[0].exchange].label : ranked[0].exchange) : null,
      failed: failed.slice(),
    };
    renderOverview();

    const cliNotice = cliMode
      ? `Theoretical mode is on — matching the CLI scanner's math (one last-traded price for both legs, no fee). Real fills always cost more than this suggests. `
      : '';

    if(filtered.length > 0){
      render(filtered);
      const extra = failed.length ? `${failed.join(', ')} couldn't be reached this scan — results below are from the exchange(s) that responded.` : '';
      showMessage((cliNotice + extra).trim(), (cliNotice || extra) ? 'info' : '');
    } else if(ranked.length > 0){
      // Nothing cleared the bar — never leave the screen blank, show the closest cycles instead.
      render(ranked);
      showMessage(cliNotice + `No cycle cleared your ${minProfit.toFixed(2)}% filter after a ${(feePct*3).toFixed(2)}% round-trip fee across ${keys.length > 1 ? 'all connected books' : EXCHANGES[keys[0]].label} — that's a real read of current spreads, not a limitation of the scan. Showing the 20 closest cycles instead (best is ${fmtPct(ranked[0].profitPct)}); lower the filter, drop your fee assumption if you're on a maker/VIP tier, or try "All 5" to widen the search.`, 'info');
    } else {
      els.results.innerHTML = `<div class="empty">No 3-leg cycles found for this anchor after the fiat/volume filter. Try "All currencies", a different exchange, or a lower min 24h volume.</div>`;
      showMessage(cliNotice, cliNotice ? 'info' : '');
    }
  }catch(err){
    setStatus('err', 'error');
    console.error(err);
    showMessage(`Could not reach the exchange API(s) from the browser (${err.message}). This is usually a CORS or network restriction in this environment rather than an issue with the logic — the same code works when hosted normally or run through a CORS-enabled proxy.`, 'error');
  }finally{
    state.scanInFlight = false;
    els.scanBtn.disabled = state.isLive; // stays disabled while Live Scan owns the loop; Stop Live Scan re-enables it
    els.scanBtn.classList.remove('is-scanning');
    els.scanBtn.querySelector('.btn-label').textContent = 'Scan Markets';
    els.results.classList.remove('is-loading');
  }
}

export function startLiveScan(){
  state.isLive = true;
  resetTracking();
  els.liveBtn.classList.add('on');
  els.liveBtn.querySelector('.btn-label').textContent = 'Stop Live Scan';
  els.scanBtn.disabled = true;
  // Exchange/anchor stay fixed for the session, same as the CLI scanner
  // picking one exchange up front — fee/min-profit/min-volume can still be
  // tuned live since they only reshape which already-tracked cycles clear the bar.
  els.exchange.disabled = true;
  els.anchor.disabled = true;
  const intervalMs = Math.max(5, parseFloat(els.scanInterval.value) || 20) * 1000;
  runScan(); // scan immediately, then settle into the interval
  state.liveTimer = setInterval(runScan, intervalMs);
}

export function stopLiveScan(){
  state.isLive = false;
  if(state.liveTimer){ clearInterval(state.liveTimer); state.liveTimer = null; }
  els.liveBtn.classList.remove('on');
  els.liveBtn.querySelector('.btn-label').textContent = 'Start Live Scan';
  els.scanBtn.disabled = false;
  els.exchange.disabled = false;
  els.anchor.disabled = false;
  // Leave the last-rendered rows and closed strip in place rather than
  // clearing them — stopping should freeze the picture, not blank it.
}
