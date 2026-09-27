// =============================================================
// utils.js — formatting / helper functions.
// Pure functions only, no DOM state. Logic unchanged from the
// original monolithic file.
// =============================================================

// ---- Coin icons: try a well-known open icon set, fall back to a colored monogram ----
export function coinColor(sym){
  const s = sym || '?';
  let hash = 0;
  for(let i=0;i<s.length;i++){ hash = s.charCodeAt(i) + ((hash<<5)-hash); }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 52%, 40%)`;
}

export function coinIconHtml(sym, size){
  size = size || 20;
  const clean = (sym || '').toLowerCase().replace(/[^a-z0-9]/g,'');
  const letter = (sym || '?').charAt(0).toUpperCase();
  const color = coinColor(sym);
  const url = `https://cdn.jsdelivr.net/gh/spothq/cryptocurrency-icons@master/32/color/${clean}.png`;
  return `<span class="coin-icon" style="width:${size}px;height:${size}px;">`
    + `<img src="${url}" alt="" loading="lazy" onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';">`
    + `<span class="coin-fallback" style="display:none; background:${color};">${letter}</span>`
    + `</span>`;
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
