// =============================================================
// sw.js — service worker for the NxTGen DeCrypt mobile web app.
//
// Goals: make the app installable, and make it open instantly (and at
// least show its shell) on a weak connection. It is deliberately NOT an
// offline trading tool: every request that leaves this origin — the
// market-data proxy, order placement, balance checks, exchange APIs —
// is never touched, never cached, never replayed. Only this site's own
// static files (HTML/CSS/JS/images) go through here.
//
// Strategy: network-first with a short timeout, falling back to the
// last good copy. That means a fresh GitHub Pages deploy is picked up
// on the very next load (no stale-app trap), while a slow or dead
// connection still opens the app from cache after ~3.5s.
// =============================================================
const VERSION = 'nxtgen-shell-v1';
const NETWORK_TIMEOUT_MS = 3500;
const PRECACHE = [
  "/js/futures/quant/config.js",
  "/js/futures/quant/features.js",
  "/js/futures/quant/log.js",
  "/js/futures/quant/regime.js",
  "/js/futures/quant/risk.js",
  "/js/futures/quant/setups.js",
  "/js/futures/quant/signal.js",
  "/js/futures/quant/stats.js",
  "/js/futures/quant/validation.js",
  "/js/quant-ui.js",
  "/",
  "/triangular-arbitrage/",
  "/cross-arbitrage/",
  "/autotrade-futures/",
  "/api-keys/",
  "/manifest.webmanifest",
  "/assets/logo.png",
  "/icon-192.png",
  "/icon-512.png",
  "/favicon.svg",
  "/css/components.css",
  "/css/futures.css",
  "/css/main.css",
  "/css/mobile-app.css",
  "/css/responsive.css",
  "/js/ai-signal.js",
  "/js/api.js",
  "/js/app.js",
  "/js/autotrade.js",
  "/js/backtest-ui.js",
  "/js/cross-exchange.js",
  "/js/exchanges.js",
  "/js/futures-ui.js",
  "/js/futures/backtest.js",
  "/js/futures/costs.js",
  "/js/futures/dca.js",
  "/js/futures/engine.js",
  "/js/futures/explain.js",
  "/js/futures/grid.js",
  "/js/futures/indicators.js",
  "/js/futures/mockMarket.js",
  "/js/futures/noTradeEngine.js",
  "/js/futures/rangeFilter.js",
  "/js/futures/regime.js",
  "/js/futures/risk.js",
  "/js/futures/scoring.js",
  "/js/futures/setups.js",
  "/js/mobile-shell.js",
  "/js/nav.js",
  "/js/state.js",
  "/js/triangular.js",
  "/js/ui.js",
  "/js/utils.js"
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    // allSettled: one missing file must not abort the whole install.
    await Promise.allSettled(PRECACHE.map((url) => cache.add(new Request(url, { cache: 'reload' }))));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

function networkFirst(request) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (res) => { if (!settled) { settled = true; resolve(res); } };

    const timer = setTimeout(async () => {
      const cached = await caches.match(request, { ignoreSearch: true });
      if (cached) done(cached); // else keep waiting on the network
    }, NETWORK_TIMEOUT_MS);

    fetch(request).then((res) => {
      clearTimeout(timer);
      if (res && res.ok) {
        const copy = res.clone();
        caches.open(VERSION).then((c) => c.put(request, copy)).catch(() => {});
      }
      done(res);
    }).catch(async () => {
      clearTimeout(timer);
      const cached = await caches.match(request, { ignoreSearch: true });
      done(cached || Response.error());
    });
  });
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // never intercept exchange / proxy / API traffic
  if (url.pathname === '/sw.js') return;
  event.respondWith(networkFirst(req));
});
