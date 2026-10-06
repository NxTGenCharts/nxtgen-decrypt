// =============================================================
// server-clock.js — "Server time" readout in the header status cluster.
//
// The time is the SERVER's clock (read from the HTTP Date header of a tiny
// same-origin HEAD request, so a wrong device clock can't skew it), but it is
// DISPLAYED in the visitor's own timezone (Intl default = the browser's zone),
// with the zone abbreviation next to it. Re-syncs every 5 minutes and whenever
// the tab becomes visible again; if the server can't be reached it falls back
// to the device clock and says so in the tooltip rather than showing nothing.
//
// Imported on every page via app.js; a harmless no-op on any page without a
// .status-cluster header block. HEAD requests aren't intercepted by sw.js
// (it only handles GET), so this always hits the network.
// =============================================================
const RESYNC_MS = 5 * 60 * 1000;
const SYNC_URL = '/favicon.svg';

export function initServerClock(){
  const cluster = document.querySelector('.status-cluster');
  if(!cluster || document.getElementById('serverClock')) return;

  const el = document.createElement('span');
  el.id = 'serverClock';
  el.className = 'server-clock';
  el.setAttribute('role', 'timer');
  el.innerHTML = '<span class="sc-label">Server time</span> <b class="sc-time">--:--:--</b> <span class="sc-zone"></span>';
  const anchor = document.getElementById('lastUpdate');
  if(anchor && anchor.parentNode === cluster) cluster.insertBefore(el, anchor); else cluster.appendChild(el);

  const timeEl = el.querySelector('.sc-time');
  const zoneEl = el.querySelector('.sc-zone');
  const tz = (() => { try{ return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; }catch{ return ''; } })();
  const fmtTime = new Intl.DateTimeFormat(undefined, { hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:false });
  const fmtZone = new Intl.DateTimeFormat(undefined, { timeZoneName:'short' });
  const fmtFull = new Intl.DateTimeFormat(undefined, { dateStyle:'full', timeStyle:'long' });

  let offsetMs = 0;       // server clock minus device clock
  let synced = false;     // true once a server Date header has been read
  let lastSyncAt = 0;

  const zoneLabel = (d) => {
    const part = fmtZone.formatToParts(d).find(p => p.type === 'timeZoneName');
    return part ? part.value : '';
  };

  function paint(){
    const now = new Date(Date.now() + offsetMs);
    timeEl.textContent = fmtTime.format(now);
    zoneEl.textContent = zoneLabel(now);
    const skew = Math.round(offsetMs / 100) / 10;
    el.title = [
      fmtFull.format(now),
      tz ? `Your timezone: ${tz}` : '',
      `UTC: ${now.toISOString().replace('T', ' ').slice(0, 19)}`,
      synced ? `Server clock is ${skew >= 0 ? '+' : ''}${skew}s vs this device` : 'Server unreachable \u2014 showing this device\u2019s clock',
    ].filter(Boolean).join('\n');
    el.dataset.state = synced ? 'synced' : 'local';
  }

  async function sync(){
    const t0 = Date.now();
    try{
      const res = await fetch(`${SYNC_URL}?_t=${t0}`, { method:'HEAD', cache:'no-store' });
      const t1 = Date.now();
      const hdr = res.headers.get('date');
      const serverMs = hdr ? Date.parse(hdr) : NaN;
      if(!Number.isFinite(serverMs)) throw new Error('no Date header');
      // Date has 1s resolution (floored) -> +500ms is the unbiased estimate;
      // compare against the request midpoint to cancel out network latency.
      offsetMs = (serverMs + 500) - (t0 + t1) / 2;
      synced = true;
      lastSyncAt = Date.now();
    }catch{
      synced = false;
      offsetMs = 0;
    }
    paint();
  }

  // Tick on the second boundary so the digits flip together with the real clock.
  (function tick(){
    paint();
    setTimeout(tick, 1000 - ((Date.now() + offsetMs) % 1000) + 5);
  })();

  sync();
  setInterval(sync, RESYNC_MS);
  document.addEventListener('visibilitychange', () => {
    if(!document.hidden && Date.now() - lastSyncAt > 30000) sync();
  });
}
