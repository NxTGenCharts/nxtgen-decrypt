// =============================================================
// autotrade.js — "Connect Exchanges", per-exchange Balances, and
// the Autotrade engine for the Triangular tab only.
//
// IMPORTANT — what this actually does:
// This module does NOT place real orders or move funds on any exchange.
// On Connect, it makes exactly one read-only signed request straight from
// the browser to Binance/Bybit's own account endpoint, to confirm the
// key/secret pair is real and to read the balance — nothing more. That
// single verify call is a reasonable thing to do client-side (it can only
// read your account, and the exchange itself is the one confirming it).
// Live order placement is a different story: browser JS has no safe way to
// sign a continuous stream of trading requests without the secret key
// sitting exposed in devtools/network traffic the whole session, so that
// part stays a simulation. Real auto-execution belongs behind a server you
// control that holds the keys and signs requests — this file is the
// decision engine you'd point at that server.
//
// What it DOES do:
// - Lets you connect an exchange: format-checks the key, then verifies it
//   against the exchange (Binance/Bybit) and pulls your balance. Bitget
//   can't be verified in-browser (needs a passphrase this app doesn't
//   collect) and is saved as unverified.
// - Keeps saved keys across Disconnect — only "Remove" deletes them — with
//   a SHOW/HIDE toggle to reveal a saved key or secret on demand.
// - Watches the selected exchange's live order books for triangular
//   cycles, same math as the Triangular tab, and — when Autotrade is
//   ON — paper-trades (simulates) the single highest-profit cycle that
//   clears your profit floor, compounding a running "today" balance
//   until your daily target is hit, then stops and shows the summary.
// =============================================================
import { els, state, DEFAULT_VERIFY_PROXY_URL } from './state.js';
import { EXCHANGES, filterTriPairs } from './exchanges.js';
import { buildGraph, findCycles } from './triangular.js';
import { fmtPct, coinIconHtml } from './utils.js';

const LS_KEY = 'nxtgen_autotrade_v1';
const MIN_PROFIT_FLOOR = 0.8; // hard floor — autotrade never fires below this, regardless of the field value

function todayKey(){
  return new Date().toDateString();
}

function money(n){
  return '$' + (n < 0 ? '-' : '') + Math.abs(n).toLocaleString(undefined, { minimumFractionDigits:2, maximumFractionDigits:2 });
}

// ---------------- Web Crypto HMAC signing (client-side, for the Verify step only) ----------------
async function hmacSha256Hex(secret, message){
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name:'HMAC', hash:'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2,'0')).join('');
}

class VerifyRejected extends Error {}

// Base URLs per network. IMPORTANT: "testnet" and "demo" are separate
// environments on both exchanges, each with its own keys — a Demo Trading
// key will be rejected against the testnet base URL (and vice versa), which
// shows up as a plain 401 that looks like "bad key" but isn't. Demo mirrors
// live market data/prices (what the CLI bot's "Demo" auto-trade mode uses);
// testnet is an independent, reset-on-a-schedule sandbox. See:
//   Binance: https://developers.binance.com/docs/binance-spot-api-docs/demo-mode/general-info
//   Bybit:   https://bybit-exchange.github.io/docs/v5/demo
const BINANCE_BASE = { live:'https://api.binance.com', testnet:'https://testnet.binance.vision', demo:'https://demo-api.binance.com' };
const BYBIT_BASE = { live:'https://api.bybit.com', testnet:'https://api-testnet.bybit.com', demo:'https://api-demo.bybit.com' };

// Read-only account/balance checks — no orders, no withdrawals. Uses the
// exchange's own signed endpoint, so it's the only way to actually confirm
// a key/secret pair is real (format checks alone can't do that). If the
// browser can't reach the endpoint at all (many exchanges don't allow
// authenticated calls from a browser origin), this throws a network error
// rather than a rejection, and the caller treats that as "unverified", not
// "invalid" — the key might be fine, we just couldn't confirm it here.
async function verifyBinance(mode, apiKey, secretKey){
  const base = BINANCE_BASE[mode] || BINANCE_BASE.live;
  const qs = `timestamp=${Date.now()}&recvWindow=5000`;
  const signature = await hmacSha256Hex(secretKey, qs);
  const res = await fetch(`${base}/api/v3/account?${qs}&signature=${signature}`, { headers:{ 'X-MBX-APIKEY': apiKey } });
  const data = await res.json().catch(() => null);
  if(!res.ok || (data && typeof data.code === 'number' && data.code < 0)){
    throw new VerifyRejected(data && data.msg ? data.msg : `HTTP ${res.status}`);
  }
  const usdt = (data.balances || []).find(b => b.asset === 'USDT');
  return { balance: usdt ? parseFloat(usdt.free) + parseFloat(usdt.locked) : null };
}

async function verifyBybit(mode, apiKey, secretKey){
  const base = BYBIT_BASE[mode] || BYBIT_BASE.live;
  const timestamp = String(Date.now());
  const recvWindow = '5000';
  const query = 'accountType=UNIFIED';
  const signature = await hmacSha256Hex(secretKey, timestamp + apiKey + recvWindow + query);
  const res = await fetch(`${base}/v5/account/wallet-balance?${query}`, {
    headers:{
      'X-BAPI-API-KEY': apiKey, 'X-BAPI-SIGN': signature, 'X-BAPI-SIGN-TYPE': '2',
      'X-BAPI-TIMESTAMP': timestamp, 'X-BAPI-RECV-WINDOW': recvWindow,
    }
  });
  const data = await res.json().catch(() => null);
  if(!res.ok || !data || data.retCode !== 0){
    throw new VerifyRejected(data && data.retMsg ? data.retMsg : `HTTP ${res.status}`);
  }
  const coins = data.result?.list?.[0]?.coin || [];
  const usdt = coins.find(c => c.coin === 'USDT');
  return { balance: usdt ? parseFloat(usdt.walletBalance) : null };
}

const VERIFIERS = { binance: verifyBinance, bybit: verifyBybit }; // Bitget needs a passphrase we don't collect — format-check only

// If a verify proxy is configured (see /server), route through it — it can
// actually complete the signed request, since CORS only blocks the
// browser-to-exchange hop, not server-to-exchange. Returns the same shape
// either way: { verified, rejected, balance, message }.
async function runVerification(key, mode, apiKey, secretKey){
  const proxyUrl = (state.verifyProxyUrl || '').trim().replace(/\/$/, '');
  if(proxyUrl){
    try{
      const res = await fetch(proxyUrl + '/api/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ exchange: key, mode, apiKey, secretKey }),
      });
      const data = await res.json().catch(() => null);
      if(!data) return { verified:false, rejected:false, balance:null, message:`Proxy returned an unreadable response (HTTP ${res.status}).` };
      return data;
    }catch(err){
      return { verified:false, rejected:false, balance:null, message:`Could not reach the verification proxy at ${proxyUrl} (${err.message}). Check the URL and that the server is running.` };
    }
  }

  // No proxy configured — try the exchange directly from the browser. For
  // Binance/Bybit this will almost always come back "couldn't reach" due
  // to CORS on their authenticated endpoints; that's expected, not a bug.
  const verifier = VERIFIERS[key];
  if(!verifier) return { verified:false, rejected:false, balance:null, message:'' }; // Bitget — no verifier at all
  try{
    const result = await verifier(mode, apiKey, secretKey);
    return { verified:true, rejected:false, balance:result.balance, message:`Confirmed with ${EXCHANGES[key].label}.` };
  }catch(err){
    if(err instanceof VerifyRejected) return { verified:false, rejected:true, balance:null, message:err.message };
    return { verified:false, rejected:false, balance:null, message:`Could not reach ${EXCHANGES[key].label} directly from this browser (likely CORS on their signed endpoints). Set a Verification proxy URL above for reliable checks — see /server.` };
  }
}

// Loose per-exchange format sanity check — catches empty/garbage input
// immediately. It cannot confirm a key is real; only runVerification() can.
function formatLooksValid(key, apiKey, secretKey){
  const clean = s => /^[A-Za-z0-9\-_]+$/.test(s);
  if(apiKey.length < 10 || secretKey.length < 10) return false;
  if(!clean(apiKey) || !clean(secretKey)) return false;
  return true;
}
function persist(){
  try{
    localStorage.setItem(LS_KEY, JSON.stringify({
      exchangeCreds: state.exchangeCreds,
      exchangeMode: state.exchangeMode,
      balances: state.balances,
      autotrade: { ...state.autotrade, timer: null },
    }));
  }catch(e){ /* storage unavailable — non-fatal, autotrade just won't survive a reload */ }
}

// A cred/balance slot from an older version of this app could be `null` or a
// flat object/number instead of today's shape. Coerce anything unexpected
// back into a safe shape rather than letting a stale localStorage value
// throw when we later index into .live/.testnet.
function coerceCredSlot(saved){
  if(saved && typeof saved === 'object' && ('live' in saved || 'testnet' in saved || 'demo' in saved)){
    return { live: normalizeCred(saved.live), testnet: normalizeCred(saved.testnet), demo: normalizeCred(saved.demo) };
  }
  if(saved && typeof saved === 'object' && saved.apiKey){
    // Old flat "{ apiKey, connectedAt }" shape — treat it as a live-network connection.
    return { live: normalizeCred(saved), testnet: null, demo: null };
  }
  return { live: null, testnet: null, demo: null };
}

function normalizeCred(c){
  if(!c || typeof c !== 'object' || !c.apiKey) return null;
  return {
    apiKey: c.apiKey,
    secretKey: c.secretKey || '',
    connectedAt: c.connectedAt || new Date().toLocaleString(),
    connected: c.connected !== false, // default true for old saves that had no such flag
    verified: c.verified || false,
    verifyNote: c.verifyNote || '',
  };
}

function coerceBalanceSlot(saved, supportsTestnet){
  if(saved && typeof saved === 'object' && ('live' in saved || 'testnet' in saved || 'demo' in saved)){
    return supportsTestnet
      ? { live: saved.live ?? null, testnet: saved.testnet ?? null, demo: saved.demo ?? null }
      : { live: saved.live ?? null };
  }
  if(typeof saved === 'number'){
    // Old flat number shape — treat it as the live-network balance.
    return supportsTestnet ? { live: saved, testnet: null, demo: null } : { live: saved };
  }
  return supportsTestnet ? { live: null, testnet: null, demo: null } : { live: null };
}

function restore(){
  try{
    const raw = localStorage.getItem(LS_KEY);
    if(!raw) return;
    const saved = JSON.parse(raw);
    // verifyProxyUrl is intentionally NOT restored from localStorage — it's
    // a fixed, non-editable site default (see DEFAULT_VERIFY_PROXY_URL in
    // state.js), not a per-user setting. Older saves may still contain a
    // stale value; ignore it so a device that previously had a blank/custom
    // value doesn't lose working verification.
    if(saved.exchangeCreds){
      for(const key of Object.keys(EXCHANGES)){
        state.exchangeCreds[key] = coerceCredSlot(saved.exchangeCreds[key]);
      }
    }
    if(saved.exchangeMode){
      for(const key of Object.keys(EXCHANGES)){
        const m = saved.exchangeMode[key];
        const sandboxOk = EXCHANGES[key].testnetSupported && (m === 'testnet' || m === 'demo');
        state.exchangeMode[key] = sandboxOk ? m : 'live';
      }
    }
    if(saved.balances){
      for(const key of Object.keys(EXCHANGES)){
        state.balances[key] = coerceBalanceSlot(saved.balances[key], EXCHANGES[key].testnetSupported);
      }
    }
    if(saved.autotrade) Object.assign(state.autotrade, saved.autotrade, { timer:null, running:false });
    if(!EXCHANGES[state.autotrade.exchange]) state.autotrade.exchange = 'bitget';
    const atSandboxOk = EXCHANGES[state.autotrade.exchange].testnetSupported && (state.autotrade.mode === 'testnet' || state.autotrade.mode === 'demo');
    if(!atSandboxOk) state.autotrade.mode = 'live';
  }catch(e){ /* ignore corrupt/blocked storage — safe defaults from state.js are already in place */ }
}

function showAtMessage(html, type){
  if(!els.atMessages) return;
  els.atMessages.innerHTML = html ? `<div class="msg ${type||'info'}">${html}</div>` : '';
}

// ---------------- Connect Exchanges ----------------
function renderConnectRows(){
  els.connectRows.innerHTML = Object.keys(EXCHANGES).map(key => {
    const label = EXCHANGES[key].label;
    const supportsTestnet = EXCHANGES[key].testnetSupported;
    const mode = supportsTestnet ? (state.exchangeMode[key] || 'live') : 'live';
    const cred = (state.exchangeCreds[key] || {})[mode] || null;
    const stored = !!cred;               // a key/secret is saved for this slot
    const connected = stored && cred.connected;
    const modeToggle = supportsTestnet ? `
      <div class="mode-toggle" role="group" aria-label="${label} network">
        <button type="button" class="mode-btn ${mode==='live'?'active':''}" data-mode="live">Live</button>
        <button type="button" class="mode-btn ${mode==='testnet'?'active':''}" data-mode="testnet">Testnet</button>
        <button type="button" class="mode-btn ${mode==='demo'?'active':''}" data-mode="demo">Demo</button>
      </div>` : `<div class="mode-toggle mode-toggle--disabled" title="Bitget has no public spot testnet or demo environment"><span class="mode-btn active">Live only</span></div>`;

    let statusPill = '';
    if(stored){
      if(cred.verified) statusPill = `<span class="pill tr-yes" title="${cred.verifyNote||''}">VERIFIED</span>`;
      else statusPill = `<span class="pill" style="color:var(--amber);border-color:var(--amber-dim);" title="${cred.verifyNote||'Could not confirm with the exchange from this browser.'}">UNVERIFIED</span>`;
    }

    const modePillHtml = mode==='testnet'
      ? ' <span class="pill" style="margin-left:6px;color:var(--amber);border-color:var(--amber-dim);">TESTNET</span>'
      : mode==='demo'
        ? ' <span class="pill" style="margin-left:6px;color:var(--amber);border-color:var(--amber-dim);">DEMO</span>'
        : '';
    const placeholderPrefix = mode === 'testnet' ? 'testnet ' : mode === 'demo' ? 'demo ' : '';

    return `<div class="connect-row" data-exchange="${key}" data-mode="${mode}">
      <div class="connect-label">${label}${modePillHtml}${statusPill ? ' '+statusPill : ''}</div>
      ${modeToggle}
      <div class="kv-field">
        <input class="ck-key" type="${stored ? 'password' : 'text'}" placeholder="Enter ${placeholderPrefix}API key" value="${stored ? cred.apiKey : ''}" ${stored ? 'disabled' : ''}>
        ${stored ? `<button type="button" class="reveal-btn" data-field="key" title="Show/hide">SHOW</button>` : ''}
      </div>
      <div class="kv-field">
        <input class="ck-secret" type="password" placeholder="Enter ${placeholderPrefix}secret key" value="${stored ? cred.secretKey : ''}" ${stored ? 'disabled' : ''}>
        ${stored ? `<button type="button" class="reveal-btn" data-field="secret" title="Show/hide">SHOW</button>` : ''}
      </div>
      ${stored ? `
        <div class="connect-actions">
          <button class="primary ghost connect-btn" data-action="${connected ? 'disconnect' : 'reconnect'}">${connected ? 'Disconnect' : 'Reconnect'}</button>
          ${key !== 'bitget' && !cred.verified ? `<button class="primary ghost retry-verify-btn" data-action="retry-verify" title="Re-run the balance/key check against ${label} now">Retry Verification</button>` : ''}
          <button class="primary ghost remove-btn" data-action="remove" title="Permanently remove this saved key">Remove</button>
        </div>
      ` : `
        <div class="connect-actions">
          <button class="primary connect-btn" data-action="connect">Connect</button>
        </div>
      `}
      <span class="xbadge" data-state="${connected ? 'up' : 'idle'}"><span class="xbadge-dot"></span>${connected ? 'CONNECTED' : (stored ? 'DISCONNECTED' : 'NOT CONNECTED')}</span>
    </div>`;
  }).join('');
}

// The proxy field is a locked, read-only display — not user-editable (see
// DEFAULT_VERIFY_PROXY_URL in state.js). No change listener needed.
function maskProxyUrl(url){
  // Show just enough to confirm something real is configured, without
  // spelling out the whole host — e.g. "https://nxtgen-decrypt.onrender.com"
  // becomes "https://nxtgen-decrypt.onren…". Purely cosmetic (this is a
  // public URL, not a secret); the full value is still what's actually used.
  const shown = 28;
  return url.length > shown ? url.slice(0, shown) + '…' : url;
}

els.connectRows.addEventListener('click', async (e) => {
  const revealBtn = e.target.closest('.reveal-btn');
  if(revealBtn){
    const row = e.target.closest('.connect-row');
    const input = row.querySelector(revealBtn.dataset.field === 'key' ? '.ck-key' : '.ck-secret');
    const showing = input.type === 'text';
    input.type = showing ? 'password' : 'text';
    revealBtn.textContent = showing ? 'SHOW' : 'HIDE';
    return;
  }

  const modeBtn = e.target.closest('.mode-btn[data-mode]');
  if(modeBtn){
    const row = e.target.closest('.connect-row');
    const key = row.dataset.exchange;
    if(!EXCHANGES[key].testnetSupported) return; // Bitget: nothing to switch
    state.exchangeMode[key] = modeBtn.dataset.mode;
    persist();
    renderConnectRows();
    renderBalances();
    return;
  }

  const retryBtn = e.target.closest('.retry-verify-btn');
  if(retryBtn){
    const row = e.target.closest('.connect-row');
    const key = row.dataset.exchange;
    const mode = row.dataset.mode;
    const cred = state.exchangeCreds[key][mode];
    if(!cred){ return; } // shouldn't happen — button only renders when a cred is stored
    retryBtn.disabled = true;
    retryBtn.textContent = 'Verifying…';
    const netLabel = mode === 'testnet' ? 'testnet' : mode === 'demo' ? 'demo' : 'live';
    const usingProxy = !!(state.verifyProxyUrl || '').trim();
    const result = await runVerification(key, mode, cred.apiKey, cred.secretKey);
    if(result.rejected){
      cred.verified = false;
      cred.verifyNote = result.message;
      showAtMessage(`${EXCHANGES[key].label} rejected that ${netLabel} key: ${result.message}. Double-check the key, secret, and that it has the right permissions/IP allow-list, then try again.`, 'error');
    } else {
      cred.verified = result.verified;
      cred.verifyNote = result.verified
        ? `Confirmed with ${EXCHANGES[key].label}${usingProxy ? ' via the verification proxy' : ''}.`
        : result.message;
      if(result.verified){
        if(result.balance != null){
          state.balances[key][mode] = result.balance;
          showAtMessage(`${EXCHANGES[key].label} (${netLabel}) key verified and balance pulled: ${money(result.balance)} USDT.`, 'info');
        } else {
          showAtMessage(`${EXCHANGES[key].label} (${netLabel}) key verified.`, 'info');
        }
      } else {
        showAtMessage(`Still UNVERIFIED: ${result.message}`, 'error');
      }
    }
    persist();
    renderConnectRows();
    renderBalances();
    return;
  }

  const removeBtn = e.target.closest('.remove-btn');
  if(removeBtn){
    const row = e.target.closest('.connect-row');
    const key = row.dataset.exchange;
    const mode = row.dataset.mode;
    state.exchangeCreds[key][mode] = null;
    persist();
    renderConnectRows();
    renderBalances();
    renderExchangeOptions();
    showAtMessage(`${EXCHANGES[key].label} (${mode}) key removed.`, 'info');
    return;
  }

  const btn = e.target.closest('.connect-btn');
  if(!btn) return;
  const row = e.target.closest('.connect-row');
  const key = row.dataset.exchange;
  const mode = row.dataset.mode;
  const action = btn.dataset.action;

  if(action === 'disconnect'){
    state.exchangeCreds[key][mode].connected = false;
    persist();
    renderConnectRows();
    renderBalances();
    showAtMessage(`${EXCHANGES[key].label} (${mode}) disconnected. Your key is still saved — hit Reconnect to use it again, or Remove to delete it.`, 'info');
    return;
  }
  if(action === 'reconnect'){
    state.exchangeCreds[key][mode].connected = true;
    persist();
    renderConnectRows();
    renderBalances();
    showAtMessage(`${EXCHANGES[key].label} (${mode}) reconnected.`, 'info');
    return;
  }

  // action === 'connect' — brand new key entry
  const apiKey = row.querySelector('.ck-key').value.trim();
  const secretKey = row.querySelector('.ck-secret').value.trim();
  if(!apiKey || !secretKey){
    showAtMessage('Enter both an API key and a secret key before connecting.', 'error');
    return;
  }
  if(!formatLooksValid(key, apiKey, secretKey)){
    showAtMessage(`That doesn't look like a valid ${EXCHANGES[key].label} key/secret pair (wrong length or characters) — double-check it and try again.`, 'error');
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Verifying…';
  const netLabel = mode === 'testnet' ? 'testnet' : mode === 'demo' ? 'demo' : 'live';
  const usingProxy = !!(state.verifyProxyUrl || '').trim();

  const cred = { apiKey, secretKey, connectedAt: new Date().toLocaleString(), connected: true, verified: false, verifyNote: '' };

  if(key === 'bitget'){
    cred.verifyNote = 'Bitget verification needs a passphrase this app doesn\'t collect — format looks valid, but this hasn\'t been confirmed against the exchange.';
    state.exchangeCreds[key][mode] = cred;
    showAtMessage(`${EXCHANGES[key].label} key saved (format looks valid). It can't be verified — even the proxy doesn't collect the third Bitget field (passphrase) — so it's marked UNVERIFIED.`, 'info');
  } else {
    const result = await runVerification(key, mode, apiKey, secretKey);
    if(result.rejected){
      // The exchange itself rejected the key/secret — don't save it as connected.
      showAtMessage(`${EXCHANGES[key].label} rejected that ${netLabel} key: ${result.message}. Double-check the key, secret, and that it has the right permissions/IP allow-list, then try again.`, 'error');
      renderConnectRows();
      return;
    }
    cred.verified = result.verified;
    cred.verifyNote = result.verified
      ? `Confirmed with ${EXCHANGES[key].label}${usingProxy ? ' via your verification proxy' : ''}.`
      : result.message;
    state.exchangeCreds[key][mode] = cred;
    if(result.verified){
      if(result.balance != null){
        state.balances[key][mode] = result.balance;
        showAtMessage(`${EXCHANGES[key].label} (${netLabel}) key verified and balance pulled: ${money(result.balance)} USDT. Autotrade below still simulates trades — this only confirms the key works and reads your balance.`, 'info');
      } else {
        showAtMessage(`${EXCHANGES[key].label} (${netLabel}) key verified.`, 'info');
      }
    } else {
      showAtMessage(`Saved the ${EXCHANGES[key].label} (${netLabel}) key as UNVERIFIED: ${result.message}`, 'error');
    }
  }

  persist();
  renderConnectRows();
  renderBalances();
  renderExchangeOptions();
});

// ---------------- Balances ----------------
function renderBalances(){
  els.balanceRows.innerHTML = Object.keys(EXCHANGES).map(key => {
    const label = EXCHANGES[key].label;
    const mode = EXCHANGES[key].testnetSupported ? (state.exchangeMode[key] || 'live') : 'live';
    const bal = (state.balances[key] || {})[mode];
    const isAtExchange = state.autotrade.exchange === key && state.autotrade.mode === mode;
    const modeTag = mode === 'testnet'
      ? ' <span class="pill" style="color:var(--amber);border-color:var(--amber-dim);">TESTNET</span>'
      : mode === 'demo'
        ? ' <span class="pill" style="color:var(--amber);border-color:var(--amber-dim);">DEMO</span>'
        : '';
    return `<div class="balance-row" data-exchange="${key}">
      <div class="connect-label">${label}${modeTag}${isAtExchange ? ' <span class="pill tr-yes" style="margin-left:6px;">AUTOTRADE</span>' : ''}</div>
      <input class="bal-input" type="number" min="0" step="0.01" placeholder="Enter balance (USDT)" value="${bal !== null && bal !== undefined ? bal : ''}">
      <button class="primary ghost bal-save-btn">Save Balance</button>
      <div class="balance-shown">${bal !== null && bal !== undefined ? money(bal) : '—'}</div>
    </div>`;
  }).join('');
}

els.balanceRows.addEventListener('click', (e) => {
  const btn = e.target.closest('.bal-save-btn');
  if(!btn) return;
  const row = e.target.closest('.balance-row');
  const key = row.dataset.exchange;
  const mode = state.exchangeMode[key];
  const val = parseFloat(row.querySelector('.bal-input').value);
  if(!isFinite(val) || val < 0){
    showAtMessage('Enter a valid balance amount first.', 'error');
    return;
  }
  state.balances[key][mode] = val;
  persist();
  renderBalances();
  showAtMessage(`${EXCHANGES[key].label} (${mode}) balance saved: ${money(val)}. This is a manual entry — reading a live balance requires an authenticated call this front-end intentionally does not make.`, 'info');
});

// ---------------- Autotrade config UI ----------------
function renderExchangeOptions(){
  if(els.atExchange.options.length === 0 || els.atExchange.dataset.built !== '1'){
    els.atExchange.innerHTML = Object.keys(EXCHANGES).map(k => `<option value="${k}">${EXCHANGES[k].label}</option>`).join('');
    els.atExchange.dataset.built = '1';
  }
  els.atExchange.value = state.autotrade.exchange;
  syncAtModeToggle();
}

function syncAtModeToggle(){
  const key = els.atExchange.value;
  const supportsTestnet = EXCHANGES[key].testnetSupported;
  els.atModeRow.style.display = supportsTestnet ? '' : 'none';
  if(!supportsTestnet) state.autotrade.mode = 'live';
  els.atModeLive.classList.toggle('active', state.autotrade.mode === 'live');
  els.atModeTestnet.classList.toggle('active', state.autotrade.mode === 'testnet');
  els.atModeDemo.classList.toggle('active', state.autotrade.mode === 'demo');
}

els.atModeLive.addEventListener('click', () => { state.autotrade.mode = 'live'; syncAtModeToggle(); renderBalances(); });
els.atModeTestnet.addEventListener('click', () => {
  if(!EXCHANGES[els.atExchange.value].testnetSupported) return;
  state.autotrade.mode = 'testnet'; syncAtModeToggle(); renderBalances();
});
els.atModeDemo.addEventListener('click', () => {
  if(!EXCHANGES[els.atExchange.value].testnetSupported) return;
  state.autotrade.mode = 'demo'; syncAtModeToggle(); renderBalances();
});

function ensureDay(){
  const today = todayKey();
  if(state.autotrade.dateKey !== today){
    // New day: roll current balance into the new starting balance, reset counters.
    const rollFrom = state.autotrade.currentBalance || state.autotrade.startingBalance || parseFloat(els.atStartBalance.value) || 0;
    state.autotrade.dateKey = today;
    state.autotrade.startingBalance = rollFrom;
    state.autotrade.currentBalance = rollFrom;
    state.autotrade.dayProfitPct = 0;
    state.autotrade.dayProfitAmt = 0;
    state.autotrade.targetReached = false;
    state.autotrade.cycles = [];
    persist();
  }
}

function renderAutotradeStatus(){
  const at = state.autotrade;
  els.atStatDay.textContent = at.dateKey || '—';
  els.atStatBalance.textContent = money(at.currentBalance || 0);
  els.atStatProfitPct.textContent = fmtPct(at.dayProfitPct || 0);
  els.atStatProfitAmt.textContent = money(at.dayProfitAmt || 0);
  els.atStatCycles.textContent = String(at.cycles.length);

  const target = parseFloat(els.atDailyTarget.value) || 11;
  const pct = Math.max(0, Math.min(100, (at.dayProfitPct / target) * 100));
  els.atProgressBar.style.width = pct.toFixed(1) + '%';
  els.atProgressBar.classList.toggle('done', at.targetReached);
  els.atProgressLabel.textContent = `${fmtPct(at.dayProfitPct || 0)} of ${target}% daily target${at.targetReached ? ' — reached' : ''}${at.mode === 'testnet' ? ' · TESTNET' : ''}${at.mode === 'demo' ? ' · DEMO' : ''}`;

  els.atToggleBtn.classList.toggle('on', at.enabled && at.running);
  els.atToggleBtn.querySelector('.btn-label').textContent = at.enabled
    ? (at.targetReached ? 'Target Reached — Stopped' : 'Stop Autotrade')
    : (at.targetReached ? 'Start Autotrade (new day)' : 'Start Autotrade');

  renderCycleLog();
  renderBalances(); // keep the AUTOTRADE badge on the right exchange row
}

function renderCycleLog(){
  const cycles = state.autotrade.cycles;
  if(cycles.length === 0){
    els.atCycleLog.innerHTML = `<div class="empty">No cycles executed yet today. Autotrade fires on the single highest-profit triangular cycle above your floor, each time it scans.</div>`;
    return;
  }
  els.atCycleLog.innerHTML = cycles.slice().reverse().map((c, idx) => {
    const n = cycles.length - idx;
    const [A,B,C] = c.path;
    return `<div class="cycle-log-row">
      <div class="cycle-log-n">#${n}</div>
      <div class="cycle-log-path">${coinIconHtml(A,14)}${A} → ${coinIconHtml(B,14)}${B} → ${coinIconHtml(C,14)}${C} → ${A}</div>
      <div class="cycle-log-pct">${fmtPct(c.profitPct)}</div>
      <div class="cycle-log-amt">${money(c.profitAmt)}</div>
      <div class="cycle-log-bal">${money(c.balanceAfter)}</div>
      <div class="cycle-log-time">${c.time}</div>
    </div>`;
  }).join('');
}

// ---------------- The engine ----------------
async function tick(){
  const at = state.autotrade;
  if(!at.enabled || at.targetReached) return;
  ensureDay();

  const key = at.exchange;
  const usesFakeOrderBooks = at.mode === 'testnet' && EXCHANGES[key].testnetSupported;
  const anchor = els.atAnchor.value;
  const feePct = parseFloat(els.atFee.value) || 0;
  const minVolume = parseFloat(els.atMinVolume.value) || 0;
  const configuredFloor = parseFloat(els.atMinProfit.value);
  const minProfitPct = Math.max(MIN_PROFIT_FLOOR, isFinite(configuredFloor) ? configuredFloor : MIN_PROFIT_FLOOR);
  const dailyTarget = parseFloat(els.atDailyTarget.value) || 11;
  const netLabel = at.mode === 'testnet' ? ' (testnet)' : at.mode === 'demo' ? ' (demo)' : '';

  try{
    // Demo mode mirrors live market data/prices (only the account & order
    // endpoints differ — see BINANCE_BASE/BYBIT_BASE above), so opportunity
    // scanning always reads real order books except in Testnet mode, which
    // is genuinely a separate, thinner fake order book.
    const rawPairs = await EXCHANGES[key].load(usesFakeOrderBooks);
    if(!usesFakeOrderBooks) state.pairsCache[key] = rawPairs; // Overview's market count reflects live data only
    const pairs = filterTriPairs(rawPairs, minVolume);
    const adj = buildGraph(pairs, false); // realistic bid/ask + fee — never the theoretical mode for real decisions
    const { results } = findCycles(adj, anchor, feePct, key);
    const ranked = results.filter(r => isFinite(r.profitPct)).sort((a,b) => b.profitPct - a.profitPct);
    const best = ranked[0];

    if(best && best.profitPct >= minProfitPct){
      executeCycle(best, dailyTarget);
    } else {
      showAtMessage(best
        ? `Watching ${EXCHANGES[key].label}${netLabel}… best cycle right now is ${fmtPct(best.profitPct)}, below your ${minProfitPct.toFixed(2)}% floor. No trade this pass.`
        : `Watching ${EXCHANGES[key].label}${netLabel}… no complete cycle found this pass.`, 'info');
    }
  }catch(err){
    console.error(err);
    showAtMessage(`Couldn't reach ${EXCHANGES[key].label}${netLabel} this pass (${err.message}). Will retry on the next interval.`, 'error');
  }
  renderAutotradeStatus();
  persist();
}

function executeCycle(cycle, dailyTarget){
  const at = state.autotrade;
  const bal = at.currentBalance;
  const profitAmt = bal * (cycle.profitPct / 100);
  const balanceAfter = bal + profitAmt;
  at.currentBalance = balanceAfter;
  at.dayProfitAmt = balanceAfter - at.startingBalance;
  at.dayProfitPct = at.startingBalance > 0 ? (at.dayProfitAmt / at.startingBalance) * 100 : 0;
  at.cycles.push({
    path: cycle.path,
    profitPct: cycle.profitPct,
    profitAmt,
    balanceAfter,
    time: new Date().toLocaleTimeString(),
  });

  if(at.dayProfitPct >= dailyTarget){
    at.targetReached = true;
    stopAutotrade();
    showAtMessage(`🎯 Daily target of ${dailyTarget}% reached after ${at.cycles.length} cycle${at.cycles.length===1?'':'s'} — Autotrade stopped for the day. Started at ${money(at.startingBalance)}, ended at ${money(at.currentBalance)} (+${fmtPct(at.dayProfitPct)}). See the cycle summary below.`, 'info');
  } else {
    showAtMessage(`Executed cycle #${at.cycles.length}: ${cycle.path.join(' → ')} → ${cycle.path[0]} at ${fmtPct(cycle.profitPct)} (${money(profitAmt)}). Running total: ${fmtPct(at.dayProfitPct)} of ${dailyTarget}% target.`, 'info');
  }
}

function startAutotrade(){
  const at = state.autotrade;
  const key = els.atExchange.value;
  const mode = EXCHANGES[key].testnetSupported ? state.autotrade.mode : 'live';
  const startBal = parseFloat(els.atStartBalance.value);
  if(!isFinite(startBal) || startBal <= 0){
    showAtMessage('Enter a starting balance for the day before starting Autotrade.', 'error');
    return;
  }
  at.exchange = key;
  at.mode = mode;
  at.dateKey = todayKey();
  at.startingBalance = startBal;
  at.currentBalance = startBal;
  at.dayProfitPct = 0;
  at.dayProfitAmt = 0;
  at.targetReached = false;
  at.cycles = [];
  at.enabled = true;
  at.running = true;

  const intervalMs = Math.max(5, parseFloat(els.atInterval.value) || 15) * 1000;
  tick();
  at.timer = setInterval(tick, intervalMs);

  els.atExchange.disabled = true;
  els.atStartBalance.disabled = true;
  els.atAnchor.disabled = true;
  els.atModeLive.disabled = true;
  els.atModeTestnet.disabled = true;
  els.atModeDemo.disabled = true;

  const netLabel = mode === 'testnet' ? ' (testnet)' : mode === 'demo' ? ' (demo)' : '';
  showAtMessage(`Autotrade started on ${EXCHANGES[key].label}${netLabel} — Triangular only, Spot only. Will only act on cycles ≥ ${Math.max(MIN_PROFIT_FLOOR, parseFloat(els.atMinProfit.value)||MIN_PROFIT_FLOOR).toFixed(2)}%, and stops automatically at +${els.atDailyTarget.value}% for the day.`, 'info');
  persist();
  renderAutotradeStatus();
}

function stopAutotrade(){
  const at = state.autotrade;
  at.enabled = false;
  at.running = false;
  if(at.timer){ clearInterval(at.timer); at.timer = null; }
  els.atExchange.disabled = false;
  els.atStartBalance.disabled = false;
  els.atAnchor.disabled = false;
  els.atModeLive.disabled = false;
  els.atModeTestnet.disabled = false;
  els.atModeDemo.disabled = false;
  persist();
  renderAutotradeStatus();
}

els.atToggleBtn.addEventListener('click', () => {
  state.autotrade.enabled ? stopAutotrade() : startAutotrade();
});

els.atExchange.addEventListener('change', () => {
  state.autotrade.exchange = els.atExchange.value;
  syncAtModeToggle();
  renderBalances();
});

export function initAutotrade(){
  try{
    restore();
    els.atProxyUrl.value = maskProxyUrl(state.verifyProxyUrl || DEFAULT_VERIFY_PROXY_URL);
    els.atProxyUrl.setAttribute('readonly', 'readonly');
    els.atProxyUrl.title = 'Managed automatically — verification is pre-configured for every device, no setup needed.';
    renderExchangeOptions();
    renderConnectRows();
    renderBalances();
    ensureDay();
    const modeForStart = EXCHANGES[state.autotrade.exchange].testnetSupported ? state.autotrade.mode : 'live';
    const savedBal = state.balances[state.autotrade.exchange][modeForStart];
    if(savedBal != null && !els.atStartBalance.value){
      els.atStartBalance.value = state.autotrade.startingBalance || savedBal || '';
    }
    renderAutotradeStatus();
    // If Autotrade was left ON from a previous session (page refresh), resume it.
    if(state.autotrade.enabled && !state.autotrade.targetReached){
      const intervalMs = Math.max(5, parseFloat(els.atInterval.value) || 15) * 1000;
      state.autotrade.running = true;
      els.atExchange.disabled = true;
      els.atStartBalance.disabled = true;
      els.atAnchor.disabled = true;
      els.atModeLive.disabled = true;
      els.atModeTestnet.disabled = true;
      els.atModeDemo.disabled = true;
      tick();
      state.autotrade.timer = setInterval(tick, intervalMs);
    }
  }catch(err){
    // Never let a bad stored value blank the whole panel silently — clear the
    // corrupt local data, fall back to defaults, and still render the panel.
    console.error('initAutotrade failed, resetting local Autotrade data:', err);
    try{ localStorage.removeItem(LS_KEY); }catch(e){}
    renderExchangeOptions();
    renderConnectRows();
    renderBalances();
    renderAutotradeStatus();
    showAtMessage('Saved Autotrade/Balances data from an older version could not be read, so it was reset to defaults. Please reconnect exchanges and re-enter balances.', 'error');
  }
}
