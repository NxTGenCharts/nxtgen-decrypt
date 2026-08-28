// =============================================================
// cross-exchange.js — cross-exchange price comparison engine
// and rendering for the Cross-Exchange tab. Calculation logic
// is unchanged from the original monolithic file.
// =============================================================
import { els, state } from './state.js';
import { EXCHANGES, loadBitgetCoinInfo, tradeUrl } from './exchanges.js';
import { coinIconHtml, fmtPct, fmtPrice } from './utils.js';
import { setStatus, showXMessage, updateExchangeBadge, renderOverview } from './ui.js';

// Ticker symbols reused by unrelated projects on different exchanges — the
// same three/four-letter symbol does NOT mean the same coin. Confirmed:
// "AI" is Sleepless AI on one exchange and Gensyn (an unrelated project) on
// another. Plain spot ticker endpoints don't expose a contract address or
// chain ID to auto-detect this kind of collision, so rather than risk
// silently pairing two different assets as a fake arbitrage opportunity,
// any symbol in this list is dropped from cross-exchange matching entirely.
// It's still scanned normally within a single exchange (e.g. Triangular
// Arbitrage), where "AI" unambiguously means whatever that one exchange
// lists under that ticker — the ambiguity only exists when comparing
// across exchanges. Add to this list as more collisions are found.
export const AMBIGUOUS_CROSS_EXCHANGE_TICKERS = new Set(['AI']);

export function findCrossExchangeOpportunities(pairsByExchange, feePct){
  const feeMult = 1 - (feePct/100);
  // key "BASE|QUOTE" -> [{exchange, bid, ask, symbol, bidQty, askQty, quoteVolume24h}, ...]
  const byAsset = new Map();
  let excludedAmbiguousCount = 0;
  for(const [exchange, pairs] of Object.entries(pairsByExchange)){
    for(const p of pairs){
      if(AMBIGUOUS_CROSS_EXCHANGE_TICKERS.has(p.base)){
        excludedAmbiguousCount++;
        continue;
      }
      const key = p.base + '|' + p.quote;
      if(!byAsset.has(key)) byAsset.set(key, []);
      byAsset.get(key).push({
        exchange, bid:p.bid, ask:p.ask, symbol:p.symbol,
        bidQty:p.bidQty || 0, askQty:p.askQty || 0, quoteVolume24h:p.quoteVolume24h || 0,
      });
    }
  }

  const opportunities = [];
  for(const [key, entries] of byAsset.entries()){
    const exchangeCount = new Set(entries.map(e => e.exchange)).size;
    if(exchangeCount < 2) continue;

    const buyEntry = entries.reduce((min, e) => e.ask < min.ask ? e : min, entries[0]);
    const sellEntry = entries.reduce((max, e) => e.bid > max.bid ? e : max, entries[0]);
    if(buyEntry.exchange === sellEntry.exchange) continue; // not a cross-exchange gap

    const [base, quote] = key.split('|');
    const rawMult = sellEntry.bid / buyEntry.ask;
    const netMult = rawMult * feeMult * feeMult; // one taker fee on each leg
    const profitPct = (netMult - 1) * 100;
    if(!isFinite(profitPct)) continue;

    opportunities.push({ base, quote, buyEntry, sellEntry, profitPct, netMult });
  }
  return { opportunities, excludedAmbiguousCount };
}

function opportunityKey(o){
  return `${o.base}|${o.quote}|${o.buyEntry.exchange}|${o.sellEntry.exchange}`;
}

function trackWindow(opps){
  const now = Date.now();
  const seenKeys = new Set();
  for(const o of opps){
    const k = opportunityKey(o);
    seenKeys.add(k);
    if(!state.xFirstSeen.has(k)) state.xFirstSeen.set(k, now);
    o.firstSeen = state.xFirstSeen.get(k);
  }
  // Forget gaps that closed, so if they reopen later the window resets.
  for(const k of Array.from(state.xFirstSeen.keys())){
    if(!seenKeys.has(k)) state.xFirstSeen.delete(k);
  }
}

function windowPill(o){
  const ageMs = Date.now() - (o.firstSeen || Date.now());
  const ageSec = Math.floor(ageMs / 1000);
  if(ageSec < 90) return { label:'just opened', cls:'win-fresh' };
  const mins = Math.floor(ageSec / 60);
  if(mins < 60) return { label:`${mins}m open`, cls:'win-aged' };
  const hrs = Math.floor(mins / 60);
  return { label:`${hrs}h open`, cls:'win-aged' };
}

// ---- Liquidity: top-of-book depth + 24h volume on the thinner side of the trade ----
function liquidityPill(o, amount){
  const buyTopNotional = o.buyEntry.askQty * o.buyEntry.ask;
  const sellTopNotional = o.sellEntry.bidQty * o.sellEntry.bid;
  const topDepth = Math.min(buyTopNotional, sellTopNotional);
  const vol = Math.min(o.buyEntry.quoteVolume24h, o.sellEntry.quoteVolume24h);
  if(topDepth >= amount * 5 && vol >= 250000) return { label:'High liquidity', cls:'liq-high' };
  if(topDepth >= amount * 1.2 && vol >= 20000) return { label:'Medium liquidity', cls:'liq-medium' };
  return { label:'Low liquidity', cls:'liq-low' };
}

// ---- Deposit/Withdraw (D/W): is this specific coin depositable/withdrawable
// on this specific exchange? Only Bitget publishes per-chain withdraw/deposit
// status without authentication (Binance and Bybit only expose this to a
// signed, authenticated request), so this is Bitget-anchored: real
// true/false for Bitget legs, and `null` ("unverified") for Binance/Bybit
// legs rather than a guess. ----
function dwStatus(exchange, base){
  if(exchange !== 'bitget') return { deposit:null, withdraw:null };
  const info = state.coinNetworkCache.bitget ? state.coinNetworkCache.bitget.get(base) : null;
  if(!info) return { deposit:null, withdraw:null };
  return { deposit: info.rechargeable, withdraw: info.withdrawable };
}

function dwIcon(ok, letter, label, exLabel){
  if(ok === null) return `<span class="dw-ic dw-unknown" title="${label} on ${exLabel}: not publicly verifiable without an authenticated account">${letter}</span>`;
  return ok
    ? `<span class="dw-ic dw-yes" title="${label} on ${exLabel}: enabled">${letter}</span>`
    : `<span class="dw-ic dw-no" title="${label} on ${exLabel}: disabled">${letter}</span>`;
}

function dwIconsHtml(exchange, base, exLabel){
  const s = dwStatus(exchange, base);
  return `<span class="dw-pair">${dwIcon(s.deposit,'D','Deposit', exLabel)}${dwIcon(s.withdraw,'W','Withdraw', exLabel)}</span>`;
}

// For the "D/W confirmed only" advanced filter — true only when both the
// specific legs this trade needs (withdraw off the buy exchange, deposit
// onto the sell exchange) are confirmed enabled by Bitget's public data.
function isRouteConfirmedTransferable(o){
  const buyW = dwStatus(o.buyEntry.exchange, o.base).withdraw;
  const sellD = dwStatus(o.sellEntry.exchange, o.base).deposit;
  return buyW === true && sellD === true;
}

// ---- Execution cost breakdown (Spread / Fees / Est. Slippage / Gas / Net
// Profit) for the expandable detail panel. Slippage is a heuristic — trade
// size vs. top-of-book depth on the thinner side — since no public ticker
// endpoint exposes a real slippage figure to query; gas is a flat
// illustrative estimate, since actual on-chain cost depends on the specific
// network used to move the coin, which isn't known from spot ticker data
// alone. Neither is a guarantee — see the banners above the table. ----
const FLAT_GAS_ESTIMATE_USD = 0.50;
function estimateSlippagePct(o, amount){
  const buyTopNotional = o.buyEntry.askQty * o.buyEntry.ask;
  const sellTopNotional = o.sellEntry.bidQty * o.sellEntry.bid;
  const thinnest = Math.min(buyTopNotional, sellTopNotional);
  if(!thinnest) return 0.50; // no depth data at all — fall back to a conservative flat estimate
  const ratio = amount / thinnest;
  return Math.min(5, Math.max(0.05, ratio * 0.5));
}
function costBreakdown(o, amount, feePct){
  const spreadPct = (o.sellEntry.bid / o.buyEntry.ask - 1) * 100;
  const feesPct = feePct * 2;
  const slippagePct = estimateSlippagePct(o, amount);
  const gasPctOfAmount = amount > 0 ? (FLAT_GAS_ESTIMATE_USD / amount) * 100 : 0;
  const netPct = spreadPct - feesPct - slippagePct - gasPctOfAmount;
  const netUsd = amount * (netPct / 100);
  return { spreadPct, feesPct, slippagePct, gasUsd:FLAT_GAS_ESTIMATE_USD, netPct, netUsd };
}

function renderCross(opps, amount, feePct){
  if(opps.length === 0){
    els.xResults.innerHTML = `<div class="empty">No cross-exchange gaps found right now. Try lowering the profit threshold.</div>`;
    return;
  }
  const top = opps.slice(0, 20);
  els.xResults.innerHTML = top.map((o, i) => {
    const label = o.quote === 'USDT' ? o.base : `${o.base}/${o.quote}`;
    const finalAmt = amount * o.netMult;
    const profitClass = o.profitPct < 0 ? 'profit neg' : o.profitPct < 0.15 ? 'profit low' : 'profit';
    const buyExLabel = EXCHANGES[o.buyEntry.exchange] ? EXCHANGES[o.buyEntry.exchange].label : o.buyEntry.exchange;
    const sellExLabel = EXCHANGES[o.sellEntry.exchange] ? EXCHANGES[o.sellEntry.exchange].label : o.sellEntry.exchange;
    const win = windowPill(o);
    const liq = liquidityPill(o, amount);
    const buyLink = tradeUrl(o.buyEntry.exchange, o.base, o.quote);
    const sellLink = tradeUrl(o.sellEntry.exchange, o.base, o.quote);
    const linkIcon = (url, exLabel, side) => url
      ? `<a class="xlink" href="${url}" target="_blank" rel="noopener noreferrer" title="Open ${exLabel} spot ${side} for ${label}">↗</a>`
      : '';

    const cost = costBreakdown(o, amount, feePct);

    // Execution-detail panel: purely a re-presentation of the same o.* values
    // already used for the row above (no new calculation happens here).
    const detailHtml = `<div class="xdetail">
      <div class="xdetail-col">
        <h4>Buy Leg</h4>
        <div class="xdetail-leg-ex">${buyExLabel} · BUY ${linkIcon(buyLink, buyExLabel, 'buy')}</div>
        <div class="xdetail-line"><span>Ask price</span><b>${fmtPrice(o.buyEntry.ask)}</b></div>
        <div class="xdetail-line"><span>Ask depth (top of book)</span><b>${o.buyEntry.askQty ? o.buyEntry.askQty.toFixed(4) : '–'}</b></div>
        <div class="xdetail-line"><span>24h volume</span><b>${o.buyEntry.quoteVolume24h ? o.buyEntry.quoteVolume24h.toLocaleString(undefined,{maximumFractionDigits:0}) : '–'} ${o.quote}</b></div>
        <div class="xdetail-line"><span>Deposit / Withdraw</span><b>${dwIconsHtml(o.buyEntry.exchange, o.base, buyExLabel)}</b></div>
      </div>
      <div class="xdetail-col">
        <h4>Sell Leg</h4>
        <div class="xdetail-leg-ex">${sellExLabel} · SELL ${linkIcon(sellLink, sellExLabel, 'sell')}</div>
        <div class="xdetail-line"><span>Bid price</span><b>${fmtPrice(o.sellEntry.bid)}</b></div>
        <div class="xdetail-line"><span>Bid depth (top of book)</span><b>${o.sellEntry.bidQty ? o.sellEntry.bidQty.toFixed(4) : '–'}</b></div>
        <div class="xdetail-line"><span>24h volume</span><b>${o.sellEntry.quoteVolume24h ? o.sellEntry.quoteVolume24h.toLocaleString(undefined,{maximumFractionDigits:0}) : '–'} ${o.quote}</b></div>
        <div class="xdetail-line"><span>Deposit / Withdraw</span><b>${dwIconsHtml(o.sellEntry.exchange, o.base, sellExLabel)}</b></div>
      </div>
      <div class="xdetail-col">
        <h4>Cost Breakdown</h4>
        <div class="xdetail-line"><span>Spread</span><b>${fmtPct(cost.spreadPct)}</b></div>
        <div class="xdetail-line"><span>Fees (${feePct.toFixed(2)}% × 2)</span><b style="color:var(--red)">-${cost.feesPct.toFixed(2)}%</b></div>
        <div class="xdetail-line"><span>Est. Slippage</span><b style="color:var(--red)">-${cost.slippagePct.toFixed(2)}%</b></div>
        <div class="xdetail-line"><span>Gas (flat est.)</span><b style="color:var(--red)">~$${cost.gasUsd.toFixed(2)}</b></div>
        <div class="xdetail-line total"><span>Net Profit</span><b class="mono-num" style="color:${cost.netPct<0?'var(--red)':'var(--green)'}">${fmtPct(cost.netPct)}</b></div>
        <div class="xdetail-line"><span>(on ${amount.toFixed(0)} ${o.quote} trade)</span><b class="mono-num" style="color:${cost.netUsd<0?'var(--red)':'var(--green)'}">${cost.netUsd>=0?'+':''}${cost.netUsd.toFixed(2)} ${o.quote}</b></div>
      </div>
    </div>`;

    return `<div class="xrow" tabindex="0" role="button" aria-expanded="false">
      <div class="rank ${i===0?'top1':''}">#${i+1}</div>
      <div class="xasset">${coinIconHtml(o.base,20)}<span>${label}</span></div>
      <div class="xside" data-label="Buy on">
        <span class="exch ${o.buyEntry.exchange}">${buyExLabel}</span>${linkIcon(buyLink, buyExLabel, 'buy')}
        <span class="price">ask ${fmtPrice(o.buyEntry.ask)}</span>
        ${dwIconsHtml(o.buyEntry.exchange, o.base, buyExLabel)}
      </div>
      <div class="xside" data-label="Sell on">
        <span class="exch ${o.sellEntry.exchange}">${sellExLabel}</span>${linkIcon(sellLink, sellExLabel, 'sell')}
        <span class="price">bid ${fmtPrice(o.sellEntry.bid)}</span>
        ${dwIconsHtml(o.sellEntry.exchange, o.base, sellExLabel)}
      </div>
      <div class="xfinal" data-label="Final amount">${finalAmt.toFixed(2)} ${o.quote}</div>
      <div class="xwindow"><span class="pill ${win.cls}">${win.label}</span></div>
      <div class="xliquidity"><span class="pill ${liq.cls}">${liq.label}</span></div>
      <div class="${profitClass} xprofit">${fmtPct(o.profitPct)}</div>
      ${detailHtml}
    </div>`;
  }).join('');
}

// Expand/collapse the execution-detail panel on click (presentation only).
// Clicks on the "open exchange" link should just open the link, not also
// toggle the row.
els.xResults.addEventListener('click', (e) => {
  if(e.target.closest('.xlink')) return;
  const row = e.target.closest('.xrow');
  if(!row || row.classList.contains('head')) return;
  const open = row.classList.toggle('xrow--open');
  row.setAttribute('aria-expanded', open ? 'true' : 'false');
});
els.xResults.addEventListener('keydown', (e) => {
  if(e.key !== 'Enter' && e.key !== ' ') return;
  const row = e.target.closest('.xrow');
  if(!row || row.classList.contains('head')) return;
  e.preventDefault();
  const open = row.classList.toggle('xrow--open');
  row.setAttribute('aria-expanded', open ? 'true' : 'false');
});

// ---- Advanced filters: a display-only narrowing layer on top of whatever
// the last scan already found. Re-applying these never re-fetches from the
// exchanges — it just re-filters/re-renders state.lastXScan.displaySet, so
// toggling a checkbox is instant. ----
function currentFilterSelections(){
  return {
    minLiquidity: els.xFilterLiquidity ? els.xFilterLiquidity.value : 'any',   // 'any' | 'medium' | 'high'
    window: els.xFilterWindow ? els.xFilterWindow.value : 'any',                // 'any' | 'fresh' | 'aged'
    quote: els.xFilterQuote ? els.xFilterQuote.value : 'any',                   // 'any' | 'usdt'
    dwVerifiedOnly: els.xFilterDwVerified ? els.xFilterDwVerified.checked : false,
    exchanges: {
      bitget: els.xFilterExBitget ? els.xFilterExBitget.checked : true,
      binance: els.xFilterExBinance ? els.xFilterExBinance.checked : true,
      bybit: els.xFilterExBybit ? els.xFilterExBybit.checked : true,
      mexc: els.xFilterExMexc ? els.xFilterExMexc.checked : true,
      gateio: els.xFilterExGateio ? els.xFilterExGateio.checked : true,
    },
  };
}

function passesAdvancedFilters(o, f, amount){
  if(f.quote === 'usdt' && o.quote !== 'USDT') return false;
  if(!f.exchanges[o.buyEntry.exchange] || !f.exchanges[o.sellEntry.exchange]) return false;
  if(f.minLiquidity !== 'any'){
    const liq = liquidityPill(o, amount);
    if(f.minLiquidity === 'high' && liq.cls !== 'liq-high') return false;
    if(f.minLiquidity === 'medium' && liq.cls === 'liq-low') return false;
  }
  if(f.window !== 'any'){
    const win = windowPill(o);
    if(f.window === 'fresh' && win.cls !== 'win-fresh') return false;
    if(f.window === 'aged' && win.cls !== 'win-aged') return false;
  }
  if(f.dwVerifiedOnly && !isRouteConfirmedTransferable(o)) return false;
  return true;
}

export function applyAdvancedFiltersAndRender(){
  if(!state.lastXScan) return;
  const { displaySet, amount, feePct } = state.lastXScan;
  const f = currentFilterSelections();
  const narrowed = displaySet.filter(o => passesAdvancedFilters(o, f, amount));

  if(els.xFiltersSummary){
    els.xFiltersSummary.textContent = narrowed.length === displaySet.length
      ? ''
      : `Advanced filters: showing ${narrowed.length} of ${displaySet.length} opportunities.`;
  }
  if(narrowed.length === 0){
    els.xResults.innerHTML = displaySet.length > 0
      ? `<div class="empty">No opportunities match your advanced filters. Try relaxing them.</div>`
      : `<div class="empty">No cross-exchange gaps found right now. Try lowering the profit threshold.</div>`;
    return;
  }
  renderCross(narrowed, amount, feePct);
}

function initXFilters(){
  if(!els.xFiltersToggleBtn || !els.xFiltersPanel) return;
  els.xFiltersToggleBtn.addEventListener('click', () => {
    const open = els.xFiltersPanel.hasAttribute('hidden') ? true : false;
    if(open){ els.xFiltersPanel.removeAttribute('hidden'); } else { els.xFiltersPanel.setAttribute('hidden',''); }
    els.xFiltersToggleBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    els.xFiltersToggleBtn.textContent = open ? 'Advanced Filters ▴' : 'Advanced Filters ▾';
  });
  const controls = [els.xFilterLiquidity, els.xFilterWindow, els.xFilterQuote, els.xFilterDwVerified, els.xFilterExBitget, els.xFilterExBinance, els.xFilterExBybit];
  controls.forEach(el => { if(el) el.addEventListener('change', applyAdvancedFiltersAndRender); });
}
initXFilters();

export async function runXScan(){
  const startedAt = Date.now();
  const MIN_VISIBLE_MS = 450; // floor so the spinner/dimmed-rows feedback is always perceptible,
                               // even when every exchange responds in a handful of milliseconds —
                               // otherwise a fast scan looks identical to nothing happening at all.
  els.xScanBtn.disabled = true;
  els.xScanBtn.classList.add('is-scanning');
  els.xScanBtn.querySelector('.btn-label').textContent = 'Scanning Markets…';
  els.xResults.classList.add('is-loading');
  setStatus('', 'connecting…');
  showXMessage('', '');
  try{
    const keys = Object.keys(EXCHANGES);
    const amount = parseFloat(els.xAmount.value) || 100;
    const feePct = parseFloat(els.xFee.value) || 0;
    const minProfit = parseFloat(els.xMinProfit.value);
    const failed = [];

    // Every explicit "Scan Markets" click always fetches fresh order-book
    // data from all three exchanges — this used to reuse whatever was
    // already cached in state.pairsCache (e.g. from Overview loading it
    // first), which meant every scan after the first was just recomputing
    // from stale, unchanged prices almost instantly: no network activity,
    // no visible progress, and no actual new data. The button is a request
    // for a fresh read, so it should always be one.
    for(const key of keys){
      try{
        state.pairsCache[key] = await EXCHANGES[key].load();
        updateExchangeBadge(key, 'up');
      }catch(exErr){
        console.error(key, exErr);
        failed.push(EXCHANGES[key].label);
        updateExchangeBadge(key, 'down');
      }
    }

    // Fetch Bitget's public coin/network directory once per session — powers the
    // D/W badges on Bitget legs. Non-fatal if it fails; those rows just show "?" (unverified).
    if(!state.coinNetworkCache.bitget){
      try{
        state.coinNetworkCache.bitget = await loadBitgetCoinInfo();
      }catch(netErr){
        console.error('bitget coin info', netErr);
      }
    }

    const pairsByExchange = {};
    let loadedCount = 0;
    for(const key of keys){
      if(state.pairsCache[key] && state.pairsCache[key].length){
        pairsByExchange[key] = state.pairsCache[key];
        loadedCount++;
      }
    }
    if(loadedCount < 2){
      throw new Error(failed.length ? `not enough exchanges responded (${failed.join(', ')} failed)` : 'need at least 2 exchanges of data');
    }
    setStatus('live', failed.length ? `connected (${failed.join(', ')} failed)` : 'connected');

    const { opportunities, excludedAmbiguousCount } = findCrossExchangeOpportunities(pairsByExchange, feePct);
    const ranked = opportunities.sort((a,b) => b.profitPct - a.profitPct);
    const filtered = ranked.filter(o => o.profitPct >= minProfit);

    els.xStatAssets.textContent = ranked.length.toLocaleString();
    els.lastUpdate.textContent = 'Last update — ' + new Date().toLocaleTimeString();

    const showSet = filtered.length > 0 ? filtered : ranked;
    let avgPct = null;
    if(showSet.length > 0){
      els.xStatBest.textContent = fmtPct(showSet[0].profitPct);
      avgPct = showSet.slice(0,20).reduce((s,o) => s+o.profitPct, 0) / Math.min(20, showSet.length);
      els.xStatAvg.textContent = fmtPct(avgPct);
    } else {
      els.xStatBest.textContent = '–';
      els.xStatAvg.textContent = '–';
    }

    state.lastX = {
      assetsCompared: ranked.length,
      bestPct: showSet.length > 0 ? showSet[0].profitPct : null,
      avgPct: avgPct,
      profitable: filtered.length,
      failed: failed.slice(),
    };
    renderOverview();

    const ambiguousNote = excludedAmbiguousCount > 0
      ? ` (excluded ${[...AMBIGUOUS_CROSS_EXCHANGE_TICKERS].join(', ')} — this ticker belongs to unrelated projects on different exchanges, so it's dropped from cross-exchange matching to avoid a false gap)`
      : '';

    if(filtered.length > 0){
      trackWindow(filtered);
      state.lastXScan = { displaySet: filtered, amount, feePct };
      showXMessage((failed.length ? `${failed.join(', ')} couldn't be reached this scan — comparison below uses whichever exchanges responded.` : '') + ambiguousNote, (failed.length || excludedAmbiguousCount) ? 'info' : '');
      applyAdvancedFiltersAndRender();
    } else if(ranked.length > 0){
      trackWindow(ranked);
      state.lastXScan = { displaySet: ranked, amount, feePct };
      showXMessage(`No asset cleared your ${minProfit.toFixed(2)}% threshold after a ${(feePct*2).toFixed(2)}% round-trip fee (one taker fee per leg) — showing the closest gaps instead (best is ${fmtPct(ranked[0].profitPct)}). Remember this assumes pre-funded balances on both exchanges before treating any of these as capturable.${ambiguousNote}`, 'info');
      applyAdvancedFiltersAndRender();
    } else {
      state.lastXScan = null;
      els.xResults.innerHTML = `<div class="empty">No shared assets found across the responding exchanges.</div>`;
      showXMessage(ambiguousNote ? ambiguousNote.replace(/^\s*\(/, '(') : '', ambiguousNote ? 'info' : '');
    }
  }catch(err){
    setStatus('err', 'error');
    console.error(err);
    showXMessage(`Could not reach the exchange API(s) from the browser (${err.message}). This is usually a CORS or network restriction in this environment rather than an issue with the logic.`, 'error');
  }finally{
    const elapsed = Date.now() - startedAt;
    if(elapsed < MIN_VISIBLE_MS) await new Promise(r => setTimeout(r, MIN_VISIBLE_MS - elapsed));
    els.xScanBtn.disabled = false;
    els.xScanBtn.classList.remove('is-scanning');
    els.xScanBtn.querySelector('.btn-label').textContent = 'Scan Markets';
    els.xResults.classList.remove('is-loading');
  }
}
