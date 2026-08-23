// =============================================================
// cross-exchange.js — cross-exchange price comparison engine
// and rendering for the Cross-Exchange tab. Calculation logic
// is unchanged from the original monolithic file.
// =============================================================
import { els, state } from './state.js';
import { EXCHANGES, loadBitgetCoinInfo } from './exchanges.js';
import { coinIconHtml, fmtPct, fmtPrice } from './utils.js';
import { setStatus, showXMessage, updateExchangeBadge, renderOverview } from './ui.js';

export function findCrossExchangeOpportunities(pairsByExchange, feePct){
  const feeMult = 1 - (feePct/100);
  // key "BASE|QUOTE" -> [{exchange, bid, ask, symbol, bidQty, askQty, quoteVolume24h}, ...]
  const byAsset = new Map();
  for(const [exchange, pairs] of Object.entries(pairsByExchange)){
    for(const p of pairs){
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
  return opportunities;
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

// ---- Transfer: is moving the coin between these two specific exchanges realistic? ----
// Only Bitget publishes per-chain withdraw/deposit status without authentication, so this
// is Bitget-anchored: if Bitget is one leg and has withdrawals/deposits disabled for the
// coin, that's a hard "not transferable". Otherwise, if Bitget isn't in the pair at all
// (Binance <-> Bybit), we don't have a public data source to confirm either way.
function transferPill(o){
  const info = state.coinNetworkCache.bitget ? state.coinNetworkCache.bitget.get(o.base) : null;
  const buyIsBitget = o.buyEntry.exchange === 'bitget';
  const sellIsBitget = o.sellEntry.exchange === 'bitget';

  if(!buyIsBitget && !sellIsBitget){
    return { label:'Unverified', cls:'tr-unknown' };
  }
  if(!info){
    return { label:'Unverified', cls:'tr-unknown' };
  }
  if(buyIsBitget && !info.withdrawable) return { label:'Not transferable', cls:'tr-no' };
  if(sellIsBitget && !info.rechargeable) return { label:'Not transferable', cls:'tr-no' };
  return { label:'Transferable', cls:'tr-yes' };
}

function renderCross(opps, amount){
  if(opps.length === 0){
    els.xResults.innerHTML = `<div class="empty">No cross-exchange gaps found right now. Try lowering the profit threshold.</div>`;
    return;
  }
  trackWindow(opps);
  const top = opps.slice(0, 20);
  els.xResults.innerHTML = top.map((o, i) => {
    const label = o.quote === 'USDT' ? o.base : `${o.base}/${o.quote}`;
    const finalAmt = amount * o.netMult;
    const profitClass = o.profitPct < 0 ? 'profit neg' : o.profitPct < 0.15 ? 'profit low' : 'profit';
    const buyExLabel = EXCHANGES[o.buyEntry.exchange] ? EXCHANGES[o.buyEntry.exchange].label : o.buyEntry.exchange;
    const sellExLabel = EXCHANGES[o.sellEntry.exchange] ? EXCHANGES[o.sellEntry.exchange].label : o.sellEntry.exchange;
    const win = windowPill(o);
    const liq = liquidityPill(o, amount);
    const tr = transferPill(o);

    // Execution-detail panel: purely a re-presentation of the same o.* values
    // already used for the row above (no new calculation happens here).
    const feesTaken = amount - finalAmt;
    const detailHtml = `<div class="xdetail">
      <div class="xdetail-col">
        <h4>Buy Leg</h4>
        <div class="xdetail-leg-ex">${buyExLabel} · BUY</div>
        <div class="xdetail-line"><span>Ask price</span><b>${fmtPrice(o.buyEntry.ask)}</b></div>
        <div class="xdetail-line"><span>Ask depth (top of book)</span><b>${o.buyEntry.askQty ? o.buyEntry.askQty.toFixed(4) : '–'}</b></div>
        <div class="xdetail-line"><span>24h volume</span><b>${o.buyEntry.quoteVolume24h ? o.buyEntry.quoteVolume24h.toLocaleString(undefined,{maximumFractionDigits:0}) : '–'} ${o.quote}</b></div>
      </div>
      <div class="xdetail-col">
        <h4>Sell Leg</h4>
        <div class="xdetail-leg-ex">${sellExLabel} · SELL</div>
        <div class="xdetail-line"><span>Bid price</span><b>${fmtPrice(o.sellEntry.bid)}</b></div>
        <div class="xdetail-line"><span>Bid depth (top of book)</span><b>${o.sellEntry.bidQty ? o.sellEntry.bidQty.toFixed(4) : '–'}</b></div>
        <div class="xdetail-line"><span>24h volume</span><b>${o.sellEntry.quoteVolume24h ? o.sellEntry.quoteVolume24h.toLocaleString(undefined,{maximumFractionDigits:0}) : '–'} ${o.quote}</b></div>
      </div>
      <div class="xdetail-col">
        <h4>Calculation</h4>
        <div class="xdetail-line"><span>Starting amount</span><b>${amount.toFixed(2)} ${o.quote}</b></div>
        <div class="xdetail-line"><span>Fees taken (2 legs)</span><b>${feesTaken.toFixed(4)} ${o.quote}</b></div>
        <div class="xdetail-line total"><span>Estimated final amount</span><b>${finalAmt.toFixed(4)} ${o.quote}</b></div>
        <div class="xdetail-line"><span>Net profit</span><b class="${o.profitPct<0?'':'mono-num'}" style="color:${o.profitPct<0?'var(--red)':'var(--green)'}">${fmtPct(o.profitPct)}</b></div>
      </div>
    </div>`;

    return `<div class="xrow" tabindex="0" role="button" aria-expanded="false">
      <div class="rank ${i===0?'top1':''}">#${i+1}</div>
      <div class="xasset">${coinIconHtml(o.base,20)}<span>${label}</span></div>
      <div class="xside" data-label="Buy on">
        <span class="exch ${o.buyEntry.exchange}">${buyExLabel}</span>
        <span class="price">ask ${fmtPrice(o.buyEntry.ask)}</span>
      </div>
      <div class="xside" data-label="Sell on">
        <span class="exch ${o.sellEntry.exchange}">${sellExLabel}</span>
        <span class="price">bid ${fmtPrice(o.sellEntry.bid)}</span>
      </div>
      <div class="xfinal" data-label="Final amount">${finalAmt.toFixed(2)} ${o.quote}</div>
      <div class="xwindow"><span class="pill ${win.cls}">${win.label}</span></div>
      <div class="xliquidity"><span class="pill ${liq.cls}">${liq.label}</span></div>
      <div class="xtransfer"><span class="pill ${tr.cls}">${tr.label}</span></div>
      <div class="${profitClass} xprofit">${fmtPct(o.profitPct)}</div>
      ${detailHtml}
    </div>`;
  }).join('');
}

// Expand/collapse the execution-detail panel on click (presentation only).
els.xResults.addEventListener('click', (e) => {
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

export async function runXScan(){
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

    // Reuse cached pairs when we already have all three; otherwise fetch fresh.
    const needFetch = keys.some(k => !state.pairsCache[k] || state.pairsCache[k].length === 0);
    if(needFetch){
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
    }

    // Fetch Bitget's public coin/network directory once per session — powers the
    // "Transfer" column. Non-fatal if it fails; those rows just show "Unverified".
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

    const opportunities = findCrossExchangeOpportunities(pairsByExchange, feePct);
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

    if(filtered.length > 0){
      renderCross(filtered, amount);
      showXMessage(failed.length ? `${failed.join(', ')} couldn't be reached this scan — comparison below uses whichever exchanges responded.` : '', failed.length ? 'info' : '');
    } else if(ranked.length > 0){
      renderCross(ranked, amount);
      showXMessage(`No asset cleared your ${minProfit.toFixed(2)}% threshold after a ${(feePct*2).toFixed(2)}% round-trip fee (one taker fee per leg) — showing the closest gaps instead (best is ${fmtPct(ranked[0].profitPct)}). Remember the pre-funded-balance caveat above before treating any of these as capturable.`, 'info');
    } else {
      els.xResults.innerHTML = `<div class="empty">No shared assets found across the responding exchanges.</div>`;
      showXMessage('', '');
    }
  }catch(err){
    setStatus('err', 'error');
    console.error(err);
    showXMessage(`Could not reach the exchange API(s) from the browser (${err.message}). This is usually a CORS or network restriction in this environment rather than an issue with the logic.`, 'error');
  }finally{
    els.xScanBtn.disabled = false;
    els.xScanBtn.classList.remove('is-scanning');
    els.xScanBtn.querySelector('.btn-label').textContent = 'Scan Markets';
    els.xResults.classList.remove('is-loading');
  }
}
