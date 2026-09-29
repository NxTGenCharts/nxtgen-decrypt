// =============================================================
// utils.js — formatting / helper functions.
// Pure functions only, no DOM state. Logic unchanged from the
// original monolithic file.
// =============================================================

import { DEFAULT_VERIFY_PROXY_URL } from './state.js';

// ---- Coin icons: try a well-known open icon set, fall back to a colored monogram ----
export function coinColor(sym){
  const s = sym || '?';
  let hash = 0;
  for(let i=0;i<s.length;i++){ hash = s.charCodeAt(i) + ((hash<<5)-hash); }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 52%, 40%)`;
}

// Icon sources, tried in order until one loads. The old single source (spothq's open icon set)
// only covers older, larger coins, so newer listings (ENA, BTW, ...) fell straight through to the
// letter. Binance's own logo CDN comes first because it has most listed tickers, then the app's own
// server (CoinGecko lookup, works for almost any coin), then CoinCap, then the open icon set. If none has the coin, the coloured letter is still the last resort.
const COIN_ICON_SOURCES = [
  (up, lo) => `https://bin.bnbstatic.com/static/assets/logos/${up}.png`,
  // Catch-all: the app's own server looks the ticker up on CoinGecko (cached) and redirects to the logo.
  (up, lo) => `${DEFAULT_VERIFY_PROXY_URL}/api/coin-icon/${up}`,
  (up, lo) => `https://assets.coincap.io/assets/icons/${lo}@2x.png`,
  (up, lo) => `https://cdn.jsdelivr.net/gh/spothq/cryptocurrency-icons@master/128/color/${lo}.png`,
];
// symbol -> resolved icon URL, or null once every source has failed. Without this the Trading Bots
// list (which re-renders every few seconds) would re-run the whole fallback chain and flicker.
const coinIconCache = new Map();

function coinIconCandidates(clean){
  // Perp tickers scale small coins with a prefix (1000PEPEUSDT -> PEPE); try the real ticker too.
  const names = [clean];
  const stripped = clean.replace(/^(1000000|100000|10000|1000|1m)(?=[a-z])/, '');
  if(stripped !== clean) names.push(stripped);
  const urls = [];
  for(const n of names) for(const src of COIN_ICON_SOURCES) urls.push(src(n.toUpperCase(), n));
  return urls;
}

if(typeof window !== 'undefined'){
  window.__coinIconNext = function(img){
    const list = (img.dataset.srcs || '').split('|').filter(Boolean);
    const next = (parseInt(img.dataset.i || '0', 10) || 0) + 1;
    if(next < list.length){ img.dataset.i = String(next); img.src = list[next]; return; }
    coinIconCache.set(img.dataset.coin, null);
    img.style.display = 'none';
    if(img.nextElementSibling) img.nextElementSibling.style.display = 'flex';
  };
  window.__coinIconLoaded = function(img){
    // Some CDNs answer 200 with a 1px placeholder for unknown coins - treat that as a miss.
    if(img.naturalWidth && img.naturalWidth < 8){ window.__coinIconNext(img); return; }
    coinIconCache.set(img.dataset.coin, img.currentSrc || img.src);
  };
}

export function coinIconHtml(sym, size){
  size = size || 20;
  const clean = (sym || '').toLowerCase().replace(/[^a-z0-9]/g,'');
  const letter = (sym || '?').charAt(0).toUpperCase();
  const color = coinColor(sym);
  const box = (inner) => `<span class="coin-icon" style="width:${size}px;height:${size}px;">${inner}</span>`;
  if(!clean || coinIconCache.get(clean) === null){
    return box(`<span class="coin-fallback" style="display:flex; background:${color};">${letter}</span>`);
  }
  const cached = coinIconCache.get(clean);
  const urls = cached ? [cached] : coinIconCandidates(clean);
  return box(
    `<img src="${urls[0]}" alt="" loading="lazy" referrerpolicy="no-referrer" data-coin="${clean}" data-i="0" data-srcs="${urls.join('|')}" `
    + `onload="window.__coinIconLoaded&&window.__coinIconLoaded(this)" onerror="window.__coinIconNext&&window.__coinIconNext(this)">`
    + `<span class="coin-fallback" style="display:none; background:${color};">${letter}</span>`
  );
}

export function fmtPct(x){
  const sign = x > 0 ? '+' : '';
  return sign + x.toFixed(3) + '%';
}

export function fmtPrice(x){
  if(x >= 1) return x.toFixed(4);
  const s = x.toFixed(10).replace(/0+$/, '');
  return s;
}

// Every results list in the app (Triangular, Cross-Exchange) is user-
// configurable via a "Results to show" selector but hard-capped at 50 —
// rendering an unbounded table gets slow and the extra rows past that
// point are rarely useful anyway. Pass the raw <select> value in; get
// back a safe integer to slice() with.
export const MIN_RESULTS_LIMIT = 5;
export const MAX_RESULTS_LIMIT = 50;
export function resultsLimitFrom(rawValue, fallback = 20){
  const n = parseInt(rawValue, 10);
  if(!Number.isFinite(n)) return fallback;
  return Math.min(MAX_RESULTS_LIMIT, Math.max(MIN_RESULTS_LIMIT, n));
}
