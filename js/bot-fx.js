// =============================================================
// bot-fx.js — the "Starting your robot" / "Stopping the bot" animations.
//
//   openBotFx({ kind, title, subtitle })   full-screen overlay: robot face + spinning arc
//   botToast(message, type)                slide-down toast ("Robot has been successfully started")
//   confirmStopSheet({ detail })           bottom sheet: "Close all orders at market price" → Cancel / Confirm
//
// Pure UI — no trading logic lives here. Styles are injected once, so there is no CSS file to ship.
// To match your brand, change --nxfx-accent below (or define --accent in your own CSS).
// =============================================================

const STYLE_ID = 'nxfxStyles';

const CSS = `
:root{ --nxfx-accent: var(--accent, #8b5cf6); }

/* ---------- overlay ---------- */
.nxfx-overlay{ position:fixed; inset:0; z-index:10000; display:flex; align-items:center; justify-content:center;
  background:rgba(8,9,12,.78); -webkit-backdrop-filter:blur(2px); backdrop-filter:blur(2px);
  opacity:0; transition:opacity .2s ease; }
.nxfx-overlay.is-in{ opacity:1; }
.nxfx-card{ display:flex; flex-direction:column; align-items:center; text-align:center; padding:24px; max-width:320px;
  transform:scale(.94); transition:transform .24s cubic-bezier(.2,.9,.3,1.2); }
.nxfx-overlay.is-in .nxfx-card{ transform:scale(1); }
.nxfx-icon{ position:relative; width:104px; height:104px; margin-bottom:18px; }
.nxfx-ring{ position:absolute; inset:0; width:100%; height:100%; overflow:visible; }
.nxfx-ring circle{ fill:none; stroke-width:5; stroke-linecap:round; }
.nxfx-ring .track{ stroke:rgba(255,255,255,.07); }
.nxfx-ring .arc{ stroke:var(--nxfx-accent); stroke-dasharray:72 205; transform-origin:50px 50px;
  animation:nxfx-spin 1.05s linear infinite; transition:stroke .25s ease, stroke-dasharray .35s ease; }
.nxfx-robot{ position:absolute; left:50%; top:50%; width:58px; height:58px; margin:-29px 0 0 -29px; color:#fff;
  animation:nxfx-bob 1.8s ease-in-out infinite alternate; transition:opacity .22s ease, transform .22s ease; }
.nxfx-robot .eye{ fill:currentColor; transform-box:fill-box; transform-origin:center; }
.nxfx-robot .bulb{ fill:var(--nxfx-accent); }
.nxfx-check{ position:absolute; left:50%; top:50%; width:46px; height:46px; margin:-23px 0 0 -23px; opacity:0;
  transform:scale(.7); transition:opacity .22s ease, transform .3s cubic-bezier(.2,.9,.3,1.4); }
.nxfx-check path{ fill:none; stroke:var(--green,#2ebd85); stroke-width:6; stroke-linecap:round; stroke-linejoin:round;
  stroke-dasharray:44; stroke-dashoffset:44; }
.nxfx-title{ font-size:17px; font-weight:700; color:var(--ink,#fff); margin-bottom:6px; }
.nxfx-sub{ font-size:12.5px; line-height:1.5; color:var(--dim,#9aa0ac); min-height:1.5em; }
.nxfx-sub::after{ content:''; display:inline-block; width:1.4em; text-align:left; animation:nxfx-dots 1.4s steps(4,end) infinite; }

/* start: eyes blink, antenna light pings */
.is-start .nxfx-robot .eye{ animation:nxfx-blink 2.6s infinite; }
.is-start .nxfx-robot .bulb{ animation:nxfx-ping 1s ease-in-out infinite alternate; }
/* stop: eyes close and the robot settles ("powering down") */
.is-stop .nxfx-robot{ animation-duration:2.6s; }
.is-stop .nxfx-robot .eye{ animation:nxfx-sleep .55s .35s ease-in forwards; }
.is-stop .nxfx-robot .bulb{ animation:nxfx-fade 1.4s .5s ease-out forwards; }
.is-stop .nxfx-ring .arc{ stroke:var(--amber,#f0b429); }

/* finished */
.is-done .nxfx-ring .arc{ animation:none; stroke:var(--green,#2ebd85); stroke-dasharray:276 0; }
.is-done .nxfx-robot{ opacity:0; transform:scale(.6); animation:none; }
.is-done .nxfx-check{ opacity:1; transform:scale(1); }
.is-done .nxfx-check path{ animation:nxfx-draw .35s .12s ease-out forwards; }
.is-done .nxfx-sub::after{ animation:none; }

@keyframes nxfx-spin{ to{ transform:rotate(360deg); } }
@keyframes nxfx-bob{ from{ transform:translateY(-2px); } to{ transform:translateY(2px); } }
@keyframes nxfx-blink{ 0%,90%,100%{ transform:scaleY(1); } 94%{ transform:scaleY(.1); } }
@keyframes nxfx-sleep{ to{ transform:scaleY(.12); } }
@keyframes nxfx-ping{ from{ opacity:.35; } to{ opacity:1; } }
@keyframes nxfx-fade{ to{ opacity:.15; } }
@keyframes nxfx-draw{ to{ stroke-dashoffset:0; } }
@keyframes nxfx-dots{ 0%{ content:''; } 25%{ content:'.'; } 50%{ content:'..'; } 75%{ content:'...'; } }

/* ---------- toast ---------- */
.nxfx-toasts{ position:fixed; top:12px; left:0; right:0; z-index:10002; display:flex; flex-direction:column; align-items:center;
  gap:8px; padding:0 12px; pointer-events:none; }
.nxfx-toast{ display:flex; align-items:center; gap:10px; width:100%; max-width:420px; box-sizing:border-box; padding:11px 14px;
  background:var(--panel2,#1d2028); color:var(--ink,#fff); border:1px solid var(--line,#2a2e38); border-radius:10px;
  font-size:13px; box-shadow:0 8px 28px rgba(0,0,0,.45); pointer-events:auto;
  opacity:0; transform:translateY(-14px); transition:opacity .25s ease, transform .3s cubic-bezier(.2,.9,.3,1.2); }
.nxfx-toast.is-in{ opacity:1; transform:translateY(0); }
.nxfx-toast .dot{ flex:0 0 20px; width:20px; height:20px; border-radius:50%; display:flex; align-items:center; justify-content:center;
  font-size:12px; font-weight:700; color:#0b0c10; background:var(--green,#2ebd85); }
.nxfx-toast[data-type="error"] .dot{ background:var(--red,#f6465d); color:#fff; }
.nxfx-toast[data-type="info"] .dot{ background:var(--nxfx-accent); color:#fff; }

/* ---------- stop confirm sheet ---------- */
.nxfx-scrim{ position:fixed; inset:0; z-index:10001; background:rgba(0,0,0,.55); opacity:0; transition:opacity .22s ease; }
.nxfx-scrim.is-in{ opacity:1; }
.nxfx-sheet{ position:fixed; left:0; right:0; bottom:0; margin:0 auto; z-index:10001; width:100%; max-width:480px; box-sizing:border-box;
  padding:18px 16px calc(16px + env(safe-area-inset-bottom,0px)); background:var(--panel,#15171c); color:var(--ink,#fff);
  border:1px solid var(--line,#2a2e38); border-bottom:0; border-radius:16px 16px 0 0; outline:none;
  transform:translateY(100%); transition:transform .28s cubic-bezier(.2,.9,.3,1); }
.nxfx-sheet.is-in{ transform:translateY(0); }
.nxfx-sheet h3{ margin:0 0 14px; font-size:16px; font-weight:700; }
.nxfx-opt{ display:flex; align-items:center; gap:12px; margin-bottom:16px; }
.nxfx-radio{ flex:0 0 18px; width:18px; height:18px; border-radius:50%; box-sizing:border-box; border:2px solid var(--nxfx-accent);
  display:flex; align-items:center; justify-content:center; }
.nxfx-radio::after{ content:''; width:8px; height:8px; border-radius:50%; background:var(--nxfx-accent); }
.nxfx-opt b{ display:block; font-size:13.5px; font-weight:600; }
.nxfx-opt div span{ display:block; font-size:12px; color:var(--dim,#9aa0ac); margin-top:2px; }
.nxfx-btns{ display:flex; gap:10px; }
.nxfx-btns button{ flex:1; padding:12px 10px; border-radius:10px; font-size:14px; font-weight:600; cursor:pointer; border:1px solid var(--line,#2a2e38); }
.nxfx-btns .cancel{ background:transparent; color:var(--nxfx-accent); }
.nxfx-btns .confirm{ background:var(--nxfx-accent); color:#fff; border-color:var(--nxfx-accent); }

@media (prefers-reduced-motion: reduce){
  .nxfx-card, .nxfx-toast, .nxfx-sheet{ transition:none; }
  .nxfx-robot, .nxfx-robot .eye, .nxfx-robot .bulb{ animation:none !important; }
  .nxfx-ring .arc{ animation-duration:2.4s; }
}
`;

function ensureStyles(){
  if(document.getElementById(STYLE_ID)) return;
  const s = document.createElement('style');
  s.id = STYLE_ID; s.textContent = CSS;
  document.head.appendChild(s);
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const raf2 = (fn) => requestAnimationFrame(() => requestAnimationFrame(fn)); // let the browser paint the "from" state first

const ROBOT_SVG = `
<svg class="nxfx-robot" viewBox="0 0 64 64" aria-hidden="true" focusable="false">
  <line x1="32" y1="17" x2="32" y2="10" stroke="currentColor" stroke-width="3" stroke-linecap="round"/>
  <circle class="bulb" cx="32" cy="7.5" r="3.4"/>
  <rect x="9" y="17" width="46" height="35" rx="11" fill="none" stroke="currentColor" stroke-width="3.4"/>
  <rect x="3" y="30" width="4" height="10" rx="2" fill="currentColor"/>
  <rect x="57" y="30" width="4" height="10" rx="2" fill="currentColor"/>
  <ellipse class="eye" cx="23.5" cy="34" rx="3.6" ry="4.4"/>
  <ellipse class="eye" cx="40.5" cy="34" rx="3.6" ry="4.4"/>
</svg>`;

// ---------- overlay ----------
// kind: 'start' | 'stop'.   delayMs: don't show at all if the work finishes faster than this (no flash on instant validation errors).
// minMs: once shown, stay up at least this long so the animation never just blinks past.
// Returns { setSub(text), done(ok) } — done() resolves after the overlay is fully gone.
export function openBotFx({ kind = 'start', title = '', subtitle = '', delayMs = 160, minMs = 1500 } = {}){
  ensureStyles();
  let root = null, shownAt = 0, finished = false, showTimer = null, subText = subtitle;

  function show(){
    root = document.createElement('div');
    root.className = `nxfx-overlay is-${kind === 'stop' ? 'stop' : 'start'}`;
    root.setAttribute('role', 'alertdialog');
    root.setAttribute('aria-live', 'polite');
    root.setAttribute('aria-busy', 'true');
    root.innerHTML = `
      <div class="nxfx-card">
        <div class="nxfx-icon">
          <svg class="nxfx-ring" viewBox="0 0 100 100" aria-hidden="true"><circle class="track" cx="50" cy="50" r="44"/><circle class="arc" cx="50" cy="50" r="44"/></svg>
          ${ROBOT_SVG}
          <svg class="nxfx-check" viewBox="0 0 48 48" aria-hidden="true"><path d="M11 25 L20 34 L37 14"/></svg>
        </div>
        <div class="nxfx-title"></div>
        <div class="nxfx-sub"></div>
      </div>`;
    root.querySelector('.nxfx-title').textContent = title;
    root.querySelector('.nxfx-sub').textContent = subText;
    root.setAttribute('aria-label', title);
    document.body.appendChild(root);
    shownAt = Date.now();
    raf2(() => root && root.classList.add('is-in'));
  }

  if(delayMs > 0) showTimer = setTimeout(show, delayMs); else show();

  return {
    setSub(text){
      subText = text;
      const el = root && root.querySelector('.nxfx-sub');
      if(el) el.textContent = text;
    },
    async done(ok = true){
      if(finished) return; finished = true;
      if(showTimer){ clearTimeout(showTimer); showTimer = null; }
      if(!root) return;                                   // never became visible
      const wait = ok ? shownAt + minMs - Date.now() : 0;   // on failure get out of the way immediately
      if(wait > 0) await sleep(wait);
      root.setAttribute('aria-busy', 'false');
      if(ok){ root.classList.add('is-done'); await sleep(750); }   // spinner turns into a green tick
      root.classList.remove('is-in');
      await sleep(220);
      root.remove(); root = null;
    },
  };
}

// ---------- toast ----------
// type: 'success' | 'error' | 'info'
export function botToast(message, type = 'success'){
  ensureStyles();
  let host = document.querySelector('.nxfx-toasts');
  if(!host){ host = document.createElement('div'); host.className = 'nxfx-toasts'; document.body.appendChild(host); }
  const t = document.createElement('div');
  t.className = 'nxfx-toast'; t.dataset.type = type; t.setAttribute('role', type === 'error' ? 'alert' : 'status');
  const dot = document.createElement('span'); dot.className = 'dot'; dot.textContent = type === 'error' ? '!' : (type === 'info' ? 'i' : '\u2713');
  const txt = document.createElement('span'); txt.textContent = message;
  t.append(dot, txt);
  host.appendChild(t);
  raf2(() => t.classList.add('is-in'));
  const hideAfter = type === 'error' ? 5200 : 3200;
  setTimeout(() => { t.classList.remove('is-in'); setTimeout(() => { t.remove(); if(!host.childElementCount) host.remove(); }, 320); }, hideAfter);
}

// ---------- stop confirmation sheet ----------
// Resolves true on Confirm, false on Cancel / backdrop / Escape.
export function confirmStopSheet({ title = 'Stop bot', option = 'Close all orders at market price', detail = '' } = {}){
  ensureStyles();
  return new Promise((resolve) => {
    const scrim = document.createElement('div'); scrim.className = 'nxfx-scrim';
    const sheet = document.createElement('div'); sheet.className = 'nxfx-sheet';
    sheet.setAttribute('role', 'dialog'); sheet.setAttribute('aria-modal', 'true'); sheet.setAttribute('aria-label', title); sheet.tabIndex = -1;
    sheet.innerHTML = `
      <h3></h3>
      <div class="nxfx-opt"><span class="nxfx-radio" aria-hidden="true"></span><div><b></b><span></span></div></div>
      <div class="nxfx-btns"><button type="button" class="cancel">Cancel</button><button type="button" class="confirm">Confirm</button></div>`;
    sheet.querySelector('h3').textContent = title;
    sheet.querySelector('.nxfx-opt b').textContent = option;
    const d = sheet.querySelector('.nxfx-opt div span'); d.textContent = detail; if(!detail) d.remove();
    document.body.append(scrim, sheet);
    raf2(() => { scrim.classList.add('is-in'); sheet.classList.add('is-in'); });
    const cancelBtn = sheet.querySelector('.cancel');
    cancelBtn.focus({ preventScroll: true });

    let closed = false;
    function close(result){
      if(closed) return; closed = true;
      document.removeEventListener('keydown', onKey, true);
      scrim.classList.remove('is-in'); sheet.classList.remove('is-in');
      setTimeout(() => { scrim.remove(); sheet.remove(); }, 260);
      resolve(result);
    }
    function onKey(e){ if(e.key === 'Escape'){ e.preventDefault(); close(false); } }
    document.addEventListener('keydown', onKey, true);
    scrim.addEventListener('click', () => close(false));
    cancelBtn.addEventListener('click', () => close(false));
    sheet.querySelector('.confirm').addEventListener('click', () => close(true));
  });
}
