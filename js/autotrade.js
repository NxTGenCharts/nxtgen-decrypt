// =============================================================
// autotrade.js — "Connect Exchanges", per-exchange Balances, and
// the Autotrade engine for the Triangular tab only.
//
// IMPORTANT — what this actually does:
// Connect verifies a key/secret(/passphrase) pair and reads its balance
// via a signed request — either straight from the browser (works for
// exchanges whose account endpoints allow it) or through the verify proxy
// in /server (needed for exchanges that reject cross-origin signed
// requests — see runVerification below for which path actually runs).
// Autotrade itself defaults to simulation: it watches live order books for
// triangular cycles and paper-trades the best one, compounding a running
// "today" balance. Separately, "Real order execution" (see the Arm/Place
// Real Orders controls) can be explicitly armed to have the SAME cycles
// place actual signed orders through /server's /api/order — that's real
// money movement once armed, not a simulation; see server/server.js and
// server/README.md for how that signing actually happens and why it has
// to be server-side rather than in this browser file.
//
// What it DOES do:
// - Lets you connect an exchange: format-checks the key (and passphrase,
//   for Bitget), then verifies it against the exchange and pulls your
//   balance — all five exchanges now verify for real.
// - Keeps saved keys across Disconnect — only "Remove" deletes them — with
//   a SHOW/HIDE toggle to reveal a saved key, secret, or passphrase on demand.
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

// No longer used by any exchange — Bitget (the only one that ever needed
// this) now has real verification via the proxy, see verifyBitget in
// server.js. Left in place, empty, as the mechanism for a future exchange
// that can't be verified at all rather than ripping out every .has() guard.
const NO_VERIFY_EXCHANGES = new Set([]);

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

// Gate.io's v4 API signs with SHA-512 (both the body hash and the HMAC
// itself), unlike everyone else here on SHA-256 — see gate.ioSign below.
async function sha512Hex(message){
  const enc = new TextEncoder();
  const digest = await crypto.subtle.digest('SHA-512', enc.encode(message));
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2,'0')).join('');
}
async function hmacSha512Hex(secret, message){
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name:'HMAC', hash:'SHA-512' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2,'0')).join('');
}

class VerifyRejected extends Error {}

// Base URLs per network. "demo" is Binance/Bybit's separate Demo Trading
// environment — a distinct set of keys from a normal Live account, created
// from each exchange's own Demo Trading UI, that mirrors real market prices
// but trades demo funds only. See:
//   Binance: https://developers.binance.com/docs/binance-spot-api-docs/demo-mode/general-info
//   Bybit:   https://bybit-exchange.github.io/docs/v5/demo
const BINANCE_BASE = { live:'https://api.binance.com', demo:'https://demo-api.binance.com' };
const BYBIT_BASE = { live:'https://api.bybit.com', demo:'https://api-demo.bybit.com' };
const MEXC_BASE = { live:'https://api.mexc.com' };     // no public Demo Trading environment
const GATEIO_BASE = { live:'https://api.gateio.ws' };  // no public Demo Trading environment

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

// MEXC's Spot v3 account endpoint is signed exactly like Binance's
// (query-string HMAC-SHA256, key in a header) — the only difference is the
// header name, X-MEXC-APIKEY instead of X-MBX-APIKEY.
async function verifyMexc(mode, apiKey, secretKey){
  const base = MEXC_BASE.live;
  const qs = `timestamp=${Date.now()}&recvWindow=5000`;
  const signature = await hmacSha256Hex(secretKey, qs);
  const res = await fetch(`${base}/api/v3/account?${qs}&signature=${signature}`, { headers:{ 'X-MEXC-APIKEY': apiKey } });
  const data = await res.json().catch(() => null);
  if(!res.ok || (data && typeof data.code === 'number' && data.code < 0)){
    throw new VerifyRejected(data && data.msg ? data.msg : `HTTP ${res.status}`);
  }
  const usdt = (data.balances || []).find(b => b.asset === 'USDT');
  return { balance: usdt ? parseFloat(usdt.free) + parseFloat(usdt.locked) : null };
}

// Gate.io v4 signing: SHA-512 hash of the body, then an HMAC-SHA512 over
// METHOD\nPATH\nQUERY\nBODY_HASH\nTIMESTAMP, sent as KEY/Timestamp/SIGN
// headers. See https://www.gate.io/docs/developers/apiv4/en/#authentication
async function gateioSignedGet(path, query, apiKey, secretKey){
  const base = GATEIO_BASE.live;
  const timestamp = String(Math.floor(Date.now() / 1000));
  const bodyHash = await sha512Hex('');
  const signString = `GET\n${path}\n${query}\n${bodyHash}\n${timestamp}`;
  const sign = await hmacSha512Hex(secretKey, signString);
  const res = await fetch(`${base}${path}${query ? '?' + query : ''}`, {
    headers:{ KEY: apiKey, Timestamp: timestamp, SIGN: sign, Accept: 'application/json' },
  });
  const data = await res.json().catch(() => null);
  if(!res.ok){
    throw new VerifyRejected(data && data.message ? data.message : `HTTP ${res.status}`);
  }
  return data;
}
async function verifyGateio(mode, apiKey, secretKey){
  const accounts = await gateioSignedGet('/api/v4/spot/accounts', '', apiKey, secretKey);
  const usdt = Array.isArray(accounts) ? accounts.find(a => a.currency === 'USDT') : null;
  return { balance: usdt ? parseFloat(usdt.available) + parseFloat(usdt.locked || 0) : null };
}

const VERIFIERS = { binance: verifyBinance, bybit: verifyBybit, mexc: verifyMexc, gateio: verifyGateio };
// Bitget has no entry here — it needs a passphrase and a different (base64
// HMAC-SHA256) signing scheme, and this local map only exists as a
// best-effort fallback for when no proxy is configured, which almost never
// happens (DEFAULT_VERIFY_PROXY_URL is always set by default). Not worth
// duplicating client-side for a path that's already CORS-doomed for every
// other exchange here too; Bitget verification always goes through the proxy.

// If a verify proxy is configured (see /server), route through it — it can
// actually complete the signed request, since CORS only blocks the
// browser-to-exchange hop, not server-to-exchange. Returns the same shape
// either way: { verified, rejected, balance, message }.
async function runVerification(key, mode, apiKey, secretKey, passphrase){
  const proxyUrl = (state.verifyProxyUrl || '').trim().replace(/\/$/, '');
  if(proxyUrl){
    try{
      const res = await fetch(proxyUrl + '/api/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ exchange: key, mode, apiKey, secretKey, passphrase }),
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
  if(!verifier) return { verified:false, rejected:false, balance:null, message:'' }; // Bitget — no local fallback verifier, see above
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
function formatLooksValid(key, apiKey, secretKey, passphrase){
  const clean = s => /^[A-Za-z0-9\-_]+$/.test(s);
  if(apiKey.length < 10 || secretKey.length < 10) return false;
  if(!clean(apiKey) || !clean(secretKey)) return false;
  // Passphrase is user-chosen at key-creation time, so no character-class
  // check — just require something non-trivial was actually entered.
  if(EXCHANGES[key].needsPassphrase && (!passphrase || passphrase.trim().length < 6)) return false;
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
// throw when we later index into .live/.demo. Also absorbs old saves that
// still have a `demo` slot mismatch —
// that data is simply dropped, since there's no equivalent to migrate it to.
function coerceCredSlot(saved){
  if(saved && typeof saved === 'object' && ('live' in saved || 'demo' in saved)){
    return { live: normalizeCred(saved.live), demo: normalizeCred(saved.demo) };
  }
  if(saved && typeof saved === 'object' && saved.apiKey){
    // Old flat "{ apiKey, connectedAt }" shape — treat it as a live-network connection.
    return { live: normalizeCred(saved), demo: null };
  }
  return { live: null, demo: null };
}

function normalizeCred(c){
  if(!c || typeof c !== 'object' || !c.apiKey) return null;
  return {
    apiKey: c.apiKey,
    secretKey: c.secretKey || '',
    passphrase: c.passphrase || '', // only meaningful for exchanges where EXCHANGES[key].needsPassphrase is true (currently just Bitget)
    connectedAt: c.connectedAt || new Date().toLocaleString(),
    connected: c.connected !== false, // default true for old saves that had no such flag
    verified: c.verified || false,
    verifyNote: c.verifyNote || '',
  };
}

function coerceBalanceSlot(saved, supportsDemo){
  if(saved && typeof saved === 'object' && ('live' in saved || 'demo' in saved)){
    return supportsDemo
      ? { live: saved.live ?? null, demo: saved.demo ?? null }
      : { live: saved.live ?? null };
  }
  if(typeof saved === 'number'){
    // Old flat number shape — treat it as the live-network balance.
    return supportsDemo ? { live: saved, demo: null } : { live: saved };
  }
  return supportsDemo ? { live: null, demo: null } : { live: null };
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
        const demoOk = EXCHANGES[key].demoSupported && m === 'demo';
        state.exchangeMode[key] = demoOk ? m : 'live';
      }
    }
    if(saved.balances){
      for(const key of Object.keys(EXCHANGES)){
        state.balances[key] = coerceBalanceSlot(saved.balances[key], EXCHANGES[key].demoSupported);
      }
    }
    if(saved.autotrade) Object.assign(state.autotrade, saved.autotrade, { timer:null, running:false, liveExecution:false });
    // liveExecution is NEVER restored as true from storage — see the field
    // comment in state.js. It must be re-armed explicitly every session.
    if(!EXCHANGES[state.autotrade.exchange]) state.autotrade.exchange = 'bitget';
    const atDemoOk = EXCHANGES[state.autotrade.exchange].demoSupported && state.autotrade.mode === 'demo';
    if(!atDemoOk) state.autotrade.mode = 'live';
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
    const supportsDemo = EXCHANGES[key].demoSupported;
    const mode = supportsDemo ? (state.exchangeMode[key] || 'live') : 'live';
    const cred = (state.exchangeCreds[key] || {})[mode] || null;
    const stored = !!cred;               // a key/secret is saved for this slot
    const connected = stored && cred.connected;
    const modeToggle = supportsDemo ? `
      <div class="mode-toggle" role="group" aria-label="${label} network">
        <button type="button" class="mode-btn ${mode==='live'?'active':''}" data-mode="live">Live</button>
        <button type="button" class="mode-btn ${mode==='demo'?'active':''}" data-mode="demo">Demo</button>
      </div>` : `<div class="mode-toggle mode-toggle--disabled" title="${label} has no public Demo Trading environment"><span class="mode-btn active">Live only</span></div>`;

    let statusPill = '';
    if(stored){
      if(cred.verified) statusPill = `<span class="pill tr-yes" title="${cred.verifyNote||''}">VERIFIED</span>`;
      else statusPill = `<span class="pill" style="color:var(--amber);border-color:var(--amber-dim);" title="${cred.verifyNote||'Could not confirm with the exchange from this browser.'}">UNVERIFIED</span>`;
    }

    const modePillHtml = mode==='demo'
      ? ' <span class="pill" style="margin-left:6px;color:var(--amber);border-color:var(--amber-dim);">DEMO</span>'
      : '';
    const placeholderPrefix = mode === 'demo' ? 'demo ' : '';
    const needsPass = !!EXCHANGES[key].needsPassphrase;

    return `<div class="connect-row${needsPass ? ' connect-row--passphrase' : ''}" data-exchange="${key}" data-mode="${mode}">
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
      ${needsPass ? `
      <div class="kv-field">
        <input class="ck-passphrase" type="password" placeholder="Enter ${placeholderPrefix}passphrase" value="${stored ? cred.passphrase : ''}" ${stored ? 'disabled' : ''}>
        ${stored ? `<button type="button" class="reveal-btn" data-field="passphrase" title="Show/hide">SHOW</button>` : ''}
      </div>` : ''}
      ${stored ? `
        <div class="connect-actions">
          <button class="primary ghost connect-btn" data-action="${connected ? 'disconnect' : 'reconnect'}">${connected ? 'Disconnect' : 'Reconnect'}</button>
          ${!NO_VERIFY_EXCHANGES.has(key) ? `<button class="primary ghost retry-verify-btn" data-action="retry-verify" title="Re-check this key against ${label} right now and pull the latest balance">Refresh Balance</button>` : ''}
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

// Re-checks an already-saved key against the exchange and refreshes its
// verified flag + balance. Used by both "Refresh Balance" (on-demand, any
// state) and "Reconnect" (which used to just flip a flag without actually
// checking anything — see the earlier bug where a stale balance survived a
// disconnect/reconnect cycle). Returns true on a successful verified read.
async function reverifyStoredCred(key, mode, { silent = false } = {}){
  const cred = state.exchangeCreds[key][mode];
  if(!cred || NO_VERIFY_EXCHANGES.has(key)) return false;
  const netLabel = mode === 'demo' ? 'demo' : 'live';
  const usingProxy = !!(state.verifyProxyUrl || '').trim();
  const result = await runVerification(key, mode, cred.apiKey, cred.secretKey, cred.passphrase);
  if(result.rejected){
    cred.verified = false;
    cred.verifyNote = result.message;
    if(!silent) showAtMessage(`${EXCHANGES[key].label} rejected that ${netLabel} key: ${result.message}. Double-check the key, secret, and that it has the right permissions/IP allow-list, then try again.`, 'error');
    return false;
  }
  cred.verified = result.verified;
  cred.verifyNote = result.verified
    ? `Confirmed with ${EXCHANGES[key].label}${usingProxy ? ' via the verification proxy' : ''}.`
    : result.message;
  if(result.verified){
    if(result.balance != null) state.balances[key][mode] = result.balance;
    if(!silent){
      showAtMessage(result.balance != null
        ? `${EXCHANGES[key].label} (${netLabel}) key verified and balance refreshed: ${money(result.balance)} USDT.`
        : `${EXCHANGES[key].label} (${netLabel}) key verified.`, 'info');
    }
    return true;
  }
  if(!silent) showAtMessage(`Still UNVERIFIED: ${result.message}`, 'error');
  return false;
}

// Refreshes every connected, saved Binance/Bybit credential's balance in the
// background. Called once on page load and on a recurring timer, so the
// numbers shown don't just freeze at whatever they were the moment you
// first connected — see the earlier issue where a balance change on the
// exchange (deposit, withdrawal, a real trade) never showed up here until
// you happened to click something that re-verified.
let balanceRefreshInFlight = false;
async function refreshAllConnectedBalances(){
  if(balanceRefreshInFlight) return; // don't overlap if one run is still in progress
  balanceRefreshInFlight = true;
  try{
    for(const key of Object.keys(EXCHANGES)){
      if(NO_VERIFY_EXCHANGES.has(key)) continue;
      for(const mode of ['live', 'demo']){
        const cred = state.exchangeCreds[key]?.[mode];
        if(cred && cred.connected){
          await reverifyStoredCred(key, mode, { silent: true });
        }
      }
    }
    persist();
    renderConnectRows();
    renderBalances();
  } finally {
    balanceRefreshInFlight = false;
  }
}
const BALANCE_REFRESH_INTERVAL_MS = 90 * 1000; // matches a "reasonably fresh without hammering the proxy" cadence

els.connectRows.addEventListener('click', async (e) => {
  const revealBtn = e.target.closest('.reveal-btn');
  if(revealBtn){
    const row = e.target.closest('.connect-row');
    const fieldClass = revealBtn.dataset.field === 'key' ? '.ck-key' : revealBtn.dataset.field === 'passphrase' ? '.ck-passphrase' : '.ck-secret';
    const input = row.querySelector(fieldClass);
    const showing = input.type === 'text';
    input.type = showing ? 'password' : 'text';
    revealBtn.textContent = showing ? 'SHOW' : 'HIDE';
    return;
  }

  const modeBtn = e.target.closest('.mode-btn[data-mode]');
  if(modeBtn){
    const row = e.target.closest('.connect-row');
    const key = row.dataset.exchange;
    if(!EXCHANGES[key].demoSupported) return; // Bitget: nothing to switch
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
    if(!state.exchangeCreds[key][mode]){ return; } // shouldn't happen — button only renders when a cred is stored
    retryBtn.disabled = true;
    retryBtn.textContent = 'Refreshing…';
    await reverifyStoredCred(key, mode);
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
    if(NO_VERIFY_EXCHANGES.has(key)){
      persist();
      renderConnectRows();
      renderBalances();
      showAtMessage(`${EXCHANGES[key].label} (${mode}) reconnected.`, 'info');
      return;
    }
    btn.disabled = true;
    btn.textContent = 'Reconnecting…';
    await reverifyStoredCred(key, mode); // this is the actual fix — reconnect now re-checks the exchange
                                          // instead of just flipping the connected flag and leaving the
                                          // old balance/verified state exactly as it was before.
    persist();
    renderConnectRows();
    renderBalances();
    return;
  }

  // action === 'connect' — brand new key entry
  const apiKey = row.querySelector('.ck-key').value.trim();
  const secretKey = row.querySelector('.ck-secret').value.trim();
  const needsPass = !!EXCHANGES[key].needsPassphrase;
  const passphrase = needsPass ? row.querySelector('.ck-passphrase').value.trim() : '';
  if(!apiKey || !secretKey || (needsPass && !passphrase)){
    showAtMessage(needsPass
      ? `Enter an API key, secret key, and passphrase before connecting.`
      : 'Enter both an API key and a secret key before connecting.', 'error');
    return;
  }
  if(!formatLooksValid(key, apiKey, secretKey, passphrase)){
    showAtMessage(`That doesn't look like a valid ${EXCHANGES[key].label} key${needsPass ? '/secret/passphrase' : '/secret'} combination (wrong length or characters) — double-check it and try again.`, 'error');
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Verifying…';
  const netLabel = mode === 'demo' ? 'demo' : 'live';
  const usingProxy = !!(state.verifyProxyUrl || '').trim();

  const cred = { apiKey, secretKey, passphrase, connectedAt: new Date().toLocaleString(), connected: true, verified: false, verifyNote: '' };

  {
    const result = await runVerification(key, mode, apiKey, secretKey, passphrase);
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
    const mode = EXCHANGES[key].demoSupported ? (state.exchangeMode[key] || 'live') : 'live';
    const bal = (state.balances[key] || {})[mode];
    const isAtExchange = state.autotrade.exchange === key && state.autotrade.mode === mode;
    const modeTag = mode === 'demo'
      ? ' <span class="pill" style="color:var(--amber);border-color:var(--amber-dim);">DEMO</span>'
      : '';
    return `<div class="balance-row" data-exchange="${key}">
      <div class="connect-label">${label}${modeTag}${isAtExchange ? ' <span class="pill tr-yes" style="margin-left:6px;">AUTOTRADE</span>' : ''}</div>
      <input class="bal-input" type="number" min="0" step="0.01" placeholder="Enter balance (USDT)" value="${bal !== null && bal !== undefined ? bal : ''}">
      <button class="primary ghost bal-save-btn">Save Balance</button>
      <div class="balance-shown">${bal !== null && bal !== undefined ? money(bal) : '—'}</div>
    </div>`;
  }).join('');
  syncStartBalanceField();
}

// Keeps "Today's starting balance" locked to whatever the real connected
// balance is for the currently-selected Autotrade exchange/mode — it used
// to be a free-typed number completely disconnected from your actual
// account, which is exactly why Autotrade could only ever be a local
// simulation: there was no link between what you typed and what the
// exchange actually reported. This doesn't make Autotrade place real
// orders (see the "Simulated only" note in the UI) — it just makes sure
// the *simulation's* starting point can't drift from reality by accident.
function syncStartBalanceField(){
  const key = state.autotrade.exchange;
  const mode = EXCHANGES[key].demoSupported ? state.autotrade.mode : 'live';
  const bal = state.balances[key]?.[mode];
  els.atStartBalance.value = bal != null ? bal : '';
  els.atStartBalance.setAttribute('readonly', 'readonly');
  els.atStartBalance.title = bal != null
    ? `Locked to ${EXCHANGES[key].label}'s actual ${mode} balance — connect/refresh that account to change this.`
    : `No balance found for ${EXCHANGES[key].label} (${mode}) yet — connect that account or click Refresh Balance on the row above first.`;
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
  const supportsDemo = EXCHANGES[key].demoSupported;
  els.atModeRow.style.display = supportsDemo ? '' : 'none';
  if(!supportsDemo) state.autotrade.mode = 'live';
  els.atModeLive.classList.toggle('active', state.autotrade.mode === 'live');
  els.atModeDemo.classList.toggle('active', state.autotrade.mode === 'demo');
  syncStartBalanceField();
  disarmLiveExecution(); // switching account/network invalidates any prior arm — never carry it over silently
}

els.atModeLive.addEventListener('click', () => { state.autotrade.mode = 'live'; syncAtModeToggle(); renderBalances(); });
els.atModeDemo.addEventListener('click', () => {
  if(!EXCHANGES[els.atExchange.value].demoSupported) return;
  state.autotrade.mode = 'demo'; syncAtModeToggle(); renderBalances();
});

// Test mode + Real execution together is only meaningful/safe in Demo:
// it means "place a real order on the exchange's demo account even when
// it's not profitable" — which is exactly how you'd verify the whole real
// order pipeline (signing, fills, balance updates) actually works before
// ever pointing it at a genuinely profitable Live opportunity. In Live
// mode there is no legitimate reason to deliberately force a real loss,
// so the exclusion stays absolute there.
function currentAtMode(){
  const key = els.atExchange.value;
  return EXCHANGES[key].demoSupported ? state.autotrade.mode : 'live';
}

els.atTestMode.addEventListener('change', () => {
  state.autotrade.testMode = els.atTestMode.checked;
  if(state.autotrade.testMode && state.autotrade.liveExecution && currentAtMode() !== 'demo'){
    state.autotrade.liveExecution = false;
    disarmLiveExecution();
  }
  persist();
});

const ARM_PHRASE = 'PLACE REAL ORDERS';

function disarmLiveExecution(){
  state.autotrade.liveExecution = false;
  els.atLiveExecution.checked = false;
  els.atArmRow.style.display = 'none';
  els.atArmPhrase.value = '';
}

els.atLiveExecution.addEventListener('change', () => {
  if(!els.atLiveExecution.checked){
    disarmLiveExecution();
    persist();
    return;
  }
  if(state.autotrade.testMode && currentAtMode() !== 'live'){
    showAtMessage('Test mode stays on — in Demo, Real order execution + Test mode together will place real demo orders regardless of profitability, so you can verify the pipeline works.', 'info');
  } else if(state.autotrade.testMode){
    // Live mode: the exclusion is absolute — never force a real live loss on purpose.
    els.atTestMode.checked = false;
    state.autotrade.testMode = false;
    showAtMessage('Test mode was turned off — it cannot be combined with Real order execution in Live mode.', 'error');
  }
  // Checking the box only reveals the arm step — it does NOT arm anything
  // by itself. state.autotrade.liveExecution stays false until the exact
  // phrase is typed and Arm is clicked below.
  els.atLiveExecution.checked = false;
  els.atArmRow.style.display = 'flex';
  els.atArmPhrase.focus();
});

els.atArmBtn.addEventListener('click', () => {
  const key = els.atExchange.value;
  const mode = currentAtMode();
  const cred = state.exchangeCreds[key]?.[mode];
  if(els.atArmPhrase.value.trim() !== ARM_PHRASE){
    showAtMessage(`Type exactly "${ARM_PHRASE}" to arm real order execution.`, 'error');
    return;
  }
  if(NO_VERIFY_EXCHANGES.has(key) || !cred || !cred.verified){
    showAtMessage(`Real order execution needs a VERIFIED connected key for ${EXCHANGES[key].label} (${mode}) — connect/verify it above first.`, 'error');
    return;
  }
  if(state.autotrade.testMode && mode !== 'demo'){
    showAtMessage('Cannot arm: Test mode + Real order execution together is only allowed in Demo mode. Switch to Demo, or turn Test mode off first.', 'error');
    return;
  }
  state.autotrade.liveExecution = true;
  els.atLiveExecution.checked = true;
  els.atArmRow.style.display = 'none';
  els.atArmPhrase.value = '';
  persist();
  showAtMessage(`Real order execution ARMED for ${EXCHANGES[key].label} (${mode}). The next qualifying cycle will place real orders. Uncheck the box above at any time to disarm immediately.`, 'error');
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
  const dayProfitSign = at.dayProfitPct > 0 ? 'pos' : (at.dayProfitPct < 0 ? 'neg' : 'zero');
  els.atStatProfitPct.dataset.sign = dayProfitSign;
  els.atStatProfitAmt.dataset.sign = dayProfitSign;

  const target = parseFloat(els.atDailyTarget.value) || 11;
  const pct = Math.max(0, Math.min(100, (at.dayProfitPct / target) * 100));
  els.atProgressBar.style.width = pct.toFixed(1) + '%';
  els.atProgressBar.classList.toggle('done', at.targetReached);
  els.atProgressLabel.textContent = `${fmtPct(at.dayProfitPct || 0)} of ${target}% daily target${at.targetReached ? ' — reached' : ''}${at.mode === 'demo' ? ' · DEMO' : ''}`;

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
    const badge = c.real
      ? (c.unwound
          ? ' <span class="pill" style="color:var(--red);border-color:var(--red-line);" title="A later leg failed and this position was unwound back to the anchor with real orders.">UNWOUND</span>'
          : c.forcedTest
            ? ' <span class="pill" style="color:var(--red);border-color:var(--red-line);" title="A real order was placed on the exchange regardless of profitability, to verify the execution pipeline.">REAL TEST</span>'
            : ' <span class="pill tr-yes" title="Real signed orders were placed on the exchange for all three legs.">REAL</span>')
      : (c.testMode ? ' <span class="pill" style="color:var(--red);border-color:var(--red-line);">TEST</span>' : '');
    const balCell = c.balanceAfter != null ? money(c.balanceAfter) : '<span title="Real cycles don\'t compute a local balance — see the refreshed CURRENT BALANCE above instead.">—</span>';
    const sign = c.profitPct > 0 ? 'pos' : (c.profitPct < 0 ? 'neg' : 'zero');
    return `<div class="cycle-log-row"${(c.testMode || c.real) ? ' style="outline:1px solid var(--red-line);"' : ''}>
      <div class="cycle-log-n">#${n}${badge}</div>
      <div class="cycle-log-path">${coinIconHtml(A,14)}${A} → ${coinIconHtml(B,14)}${B} → ${coinIconHtml(C,14)}${C} → ${A}</div>
      <div class="cycle-log-pct" data-sign="${sign}">${fmtPct(c.profitPct)}</div>
      <div class="cycle-log-amt" data-sign="${sign}">${money(c.profitAmt)}</div>
      <div class="cycle-log-bal">${balCell}</div>
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
  const anchor = els.atAnchor.value;
  const feePct = parseFloat(els.atFee.value) || 0;
  const minVolume = parseFloat(els.atMinVolume.value) || 0;
  const configuredFloor = parseFloat(els.atMinProfit.value);
  const minProfitPct = Math.max(MIN_PROFIT_FLOOR, isFinite(configuredFloor) ? configuredFloor : MIN_PROFIT_FLOOR);
  const dailyTarget = parseFloat(els.atDailyTarget.value) || 11;
  const netLabel = at.mode === 'demo' ? ' (demo)' : '';

  try{
    // Demo mode mirrors live market data/prices (only the account & order
    // endpoints differ — see BINANCE_BASE/BYBIT_BASE in server.js), so
    // scanning always reads real live order books regardless of mode.
    const rawPairs = await EXCHANGES[key].load();
    state.pairsCache[key] = rawPairs;
    const pairs = filterTriPairs(rawPairs, minVolume);
    const adj = buildGraph(pairs, false); // realistic bid/ask + fee — never the theoretical mode for real decisions
    const { results } = findCycles(adj, anchor, feePct, key);
    const ranked = results.filter(r => isFinite(r.profitPct)).sort((a,b) => b.profitPct - a.profitPct);

    // Anti-repeat: a scanner that keeps returning the exact same loop tick
    // after tick, seconds apart, almost always means one thin/stale-quoted
    // pair is structurally "winning" the ranking rather than the market
    // genuinely re-offering the same edge — see the RLUSD run in the
    // TODAY'S CYCLE SUMMARY log. After 2 consecutive fires on the same
    // canonicalKey, drop it for one tick and let the next-best distinct
    // cycle through instead, so autotrade actually diversifies across
    // opportunities rather than hammering one book every interval.
    const REPEAT_LIMIT = 2;
    let best = ranked[0];
    if(best && at.lastCanonicalKey === best.canonicalKey && at.lastCanonicalStreak >= REPEAT_LIMIT){
      const alt = ranked.find(r => r.canonicalKey !== best.canonicalKey);
      if(alt) best = alt;
    }
    const testMode = !!at.testMode;
    const liveExecution = !!at.liveExecution;
    const forcedRealDemoTest = testMode && liveExecution && at.mode === 'demo';

    if(testMode && liveExecution && at.mode !== 'demo'){
      // Should be unreachable outside Demo — the UI enforces this — but a
      // real bot must never act on this combination if it somehow occurs
      // anywhere else, since it would mean deliberately placing a real
      // losing order in Live.
      showAtMessage('Autotrade stopped: Test mode and Real order execution were both on outside Demo mode, which should never happen. No order was placed.', 'error');
      stopAutotrade();
    } else if(liveExecution && best && (forcedRealDemoTest || best.profitPct >= minProfitPct)){
      // forcedRealDemoTest is the one place Real execution is allowed to
      // ignore the profit floor — Demo-only, and only because you
      // explicitly armed both at once specifically to verify the real
      // order pipeline (signing, fills, balance updates) works before
      // ever pointing it at a genuinely profitable Live opportunity.
      await executeCycleReal(best, dailyTarget, forcedRealDemoTest);
    } else if(best && (testMode || best.profitPct >= minProfitPct)){
      executeCycle(best, dailyTarget, testMode);
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

// ---------------- Real order execution ----------------
// Places actual signed MARKET orders for all three legs of a cycle via the
// proxy's /api/order endpoint, sizing each leg from the REAL fill of the
// previous one — never the scanned estimate, since slippage between the
// scan and the fill is exactly what a real bot has to live with. See the
// long comment on server.js's ORDER EXECUTION block for the exact
// Binance/Bybit response-shape difference this depends on.
async function placeOrderViaProxy(key, mode, cred, { symbol, side, amountKind, amount }){
  const proxyUrl = (state.verifyProxyUrl || '').trim().replace(/\/$/, '');
  if(!proxyUrl) throw new Error('No verification proxy configured — real order execution requires one (see /server).');
  const res = await fetch(`${proxyUrl}/api/order`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ exchange: key, mode, apiKey: cred.apiKey, secretKey: cred.secretKey, passphrase: cred.passphrase, symbol, side, amountKind, amount }),
  });
  const data = await res.json().catch(() => null);
  if(!data) throw new Error(`No response from proxy (HTTP ${res.status}).`);
  if(!data.ok) throw new Error(data.message || 'Order failed for an unknown reason.');
  return data; // { ok:true, orderId, filledBaseQty, filledQuoteQty, avgPrice }
}

// Ground truth for what's actually sitting in the account for one asset —
// used to size every leg after the first, and every unwind step. A prior
// order's reported fill (filledBaseQty/filledQuoteQty) is the GROSS traded
// amount; the exchange's trading fee comes out of the asset you just
// received, so the wallet ends up holding slightly less than that. Trying
// to spend/sell the gross figure on the next leg is exactly what produced
// "Insufficient balance" during unwind. Returns null (rather than
// throwing) on failure so callers can fall back to the computed amount —
// a fee-inflated amount that gets rejected is recoverable (the leg just
// fails and unwind kicks in); silently halting the whole cycle on a
// transient balance-check failure is worse.
async function fetchAssetBalance(key, mode, cred, asset){
  const proxyUrl = (state.verifyProxyUrl || '').trim().replace(/\/$/, '');
  if(!proxyUrl) return null;
  try{
    const res = await fetch(`${proxyUrl}/api/balance`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ exchange: key, mode, apiKey: cred.apiKey, secretKey: cred.secretKey, passphrase: cred.passphrase, asset }),
    });
    const data = await res.json().catch(() => null);
    if(!data || !data.ok || typeof data.balance !== 'number') return null;
    return data.balance;
  }catch(err){
    return null;
  }
}

// The exact reverse of a graph edge: if the edge spent `from` (quote) to
// buy `to` (base) — a BUY — the reverse sells that same `to` back for
// `from` — a SELL on the identical symbol, and vice versa. Used to walk
// backward through legs that already executed when a later leg fails —
// see executeCycleReal below for why this has to be a loop, not a single
// reversal: failing on leg 3 of A→B→C→A means you're two hops from the
// anchor (C→B, then B→A), not one.
function reverseLeg(leg, heldAmount){
  return leg.side === 'BUY'
    ? { symbol: leg.symbol, side: 'SELL', amountKind: 'base', amount: heldAmount }
    : { symbol: leg.symbol, side: 'BUY', amountKind: 'quote', amount: heldAmount };
}

async function executeCycleReal(cycle, dailyTarget, forcedTest){
  trackRepeat(cycle);
  const at = state.autotrade;
  const key = at.exchange;
  const mode = at.mode;
  const cred = state.exchangeCreds[key]?.[mode];
  if(!cred || !cred.verified){
    showAtMessage(`Real execution skipped: ${EXCHANGES[key].label} (${mode}) isn't a VERIFIED connected key. Connect/verify it above first.`, 'error');
    return;
  }
  const startBal = state.balances[key]?.[mode];
  if(startBal == null){
    showAtMessage(`Real execution skipped: no known balance for ${EXCHANGES[key].label} (${mode}).`, 'error');
    return;
  }
  if(forcedTest){
    showAtMessage(`⚠ FORCED REAL TEST — placing real ${EXCHANGES[key].label} demo orders for a cycle at ${fmtPct(cycle.profitPct)}, ignoring the profit floor on purpose, to verify the execution pipeline. This is a real demo trade, expected to likely lose a small amount.`, 'error');
  }

  const spendPct = Math.min(100, Math.max(1, parseFloat(els.atSpendPct.value) || 99));
  const spendAmount = startBal * (spendPct / 100);

  const legResults = [];
  let heldAmount = spendAmount;
  let heldCurrency = cycle.path[0];
  let failedAtLeg = -1;
  let failMessage = '';

  for(let i = 0; i < cycle.legs.length; i++){
    const leg = cycle.legs[i];
    const amountKind = leg.side === 'BUY' ? 'quote' : 'base';
    try{
      const result = await placeOrderViaProxy(key, mode, cred, { symbol: leg.symbol, side: leg.side, amountKind, amount: heldAmount });
      legResults.push({ leg, result });
      const reportedAmount = leg.side === 'BUY' ? result.filledBaseQty : result.filledQuoteQty;
      heldCurrency = leg.to;
      // Ground-truth check before the NEXT leg spends this — the reported
      // fill is gross, before whatever fee the exchange took out of
      // heldCurrency itself. Skip this after the last leg; nothing spends
      // it further.
      if(i < cycle.legs.length - 1){
        const actual = await fetchAssetBalance(key, mode, cred, heldCurrency);
        heldAmount = actual != null ? Math.min(reportedAmount, actual) : reportedAmount;
      } else {
        heldAmount = reportedAmount;
      }
    }catch(err){
      failedAtLeg = i;
      failMessage = err.message;
      break;
    }
  }

  if(failedAtLeg === -1){
    // All three legs filled. reportedAmount from the last leg is gross —
    // before that leg's own trading fee comes out of the anchor currency
    // it just landed in — and unlike every leg before it, there's nothing
    // further to spend it on, so there was never a ground-truth check to
    // catch that. The fix isn't to re-read "current anchor balance" the
    // way intermediate legs do, though: by now that balance also includes
    // whatever was sitting idle before this cycle (unspent capital, prior
    // cycles' proceeds), not just this cycle's result. What actually
    // isolates this cycle's real, fee-inclusive P&L is the CHANGE in
    // anchor-currency balance across the whole cycle — startBal (already
    // read before leg 1) versus one fresh read right now. That's the same
    // measurement the daily total below is grounded in, so the two always
    // agree instead of the daily number quietly drifting further negative
    // than the sum of the rows above it.
    const endAnchorBal = await fetchAssetBalance(key, mode, cred, cycle.path[0]);
    const profitAmt = endAnchorBal != null ? (endAnchorBal - startBal) : (heldAmount - spendAmount);
    const profitPct = spendAmount > 0 ? (profitAmt / spendAmount) * 100 : 0;
    at.cycles.push({
      path: cycle.path, profitPct, profitAmt, balanceAfter: null,
      time: new Date().toLocaleTimeString(), real: true, forcedTest: !!forcedTest,
      orders: legResults.map(r => ({ symbol: r.leg.symbol, side: r.leg.side, orderId: r.result.orderId, filledBaseQty: r.result.filledBaseQty, filledQuoteQty: r.result.filledQuoteQty, avgPrice: r.result.avgPrice })),
    });
    showAtMessage(`✅ REAL${forcedTest ? ' (forced test)' : ''} cycle executed on ${EXCHANGES[key].label} (${mode}): ${cycle.path.join(' → ')} → ${cycle.path[0]} at ${fmtPct(profitPct)} (${money(profitAmt)}). Refreshing balance…`, 'info');
  } else if(failedAtLeg === 0){
    // Leg 1 never executed — nothing was spent, nothing to unwind.
    showAtMessage(`⛔ REAL execution stopped before leg 1 on ${EXCHANGES[key].label} (${mode}): ${failMessage}. No funds were moved.`, 'error');
  } else {
    // A later leg failed. Walk BACKWARD through every leg that DID
    // execute, reversing each one in turn — failing on leg 3 of a
    // A→B→C→A cycle leaves you holding C, which is two hops from the
    // anchor (C→B, then B→A), not one; a single reversal would silently
    // strand you on B. Stop and alert immediately if a reversal itself
    // fails, rather than guessing at a further route.
    showAtMessage(`⚠ REAL execution failed at leg ${failedAtLeg + 1} on ${EXCHANGES[key].label} (${mode}): ${failMessage}. Holding ${heldCurrency} — attempting to unwind back to ${cycle.path[0]}…`, 'error');
    const unwindOrders = [];
    let unwindOk = true;
    for(let i = failedAtLeg - 1; i >= 0; i--){
      const leg = cycle.legs[i];
      try{
        // Same ground-truth check as the forward loop, and the actual fix
        // for the failure in this screenshot: heldAmount coming out of the
        // failed leg (or the previous unwind hop) is gross, before fees.
        // Querying the real wallet balance for heldCurrency first is what
        // stops the unwind sell from being rejected as "Insufficient
        // balance" for an amount the account never actually held.
        const actual = await fetchAssetBalance(key, mode, cred, heldCurrency);
        const sellAmount = actual != null ? Math.min(heldAmount, actual) : heldAmount;
        const unwind = reverseLeg(leg, sellAmount);
        const unwindResult = await placeOrderViaProxy(key, mode, cred, unwind);
        unwindOrders.push({ symbol: unwind.symbol, side: unwind.side, orderId: unwindResult.orderId, unwind: true });
        heldAmount = unwind.side === 'BUY' ? unwindResult.filledBaseQty : unwindResult.filledQuoteQty;
        heldCurrency = cycle.path[i]; // reversing leg i always lands back on the currency that leg started from
      }catch(unwindErr){
        unwindOk = false;
        showAtMessage(`🛑 UNWIND FAILED partway through, on ${EXCHANGES[key].label} (${mode}): ${unwindErr.message}. You are currently holding ${heldCurrency} on this account, NOT back at ${cycle.path[0]} — check the exchange directly and resolve this manually before doing anything else.`, 'error');
        stopAutotrade();
        break;
      }
    }
    if(unwindOk){
      // Same fix as the successful-cycle branch above: measure the real
      // change in anchor-currency balance across the whole attempt rather
      // than trusting the last unwind leg's gross reported fill.
      const endAnchorBal = await fetchAssetBalance(key, mode, cred, cycle.path[0]);
      const profitAmt = endAnchorBal != null ? (endAnchorBal - startBal) : (heldAmount - spendAmount); // almost always a loss — this is a failed cycle, not a profitable one
      const profitPct = spendAmount > 0 ? (profitAmt / spendAmount) * 100 : 0;
      at.cycles.push({
        path: cycle.path, profitPct, profitAmt, balanceAfter: null,
        time: new Date().toLocaleTimeString(), real: true, unwound: true,
        orders: [...legResults.map(r => ({ symbol: r.leg.symbol, side: r.leg.side, orderId: r.result.orderId })), ...unwindOrders],
      });
      showAtMessage(`↩ Unwound successfully back to ${cycle.path[0]} on ${EXCHANGES[key].label} (${mode}) after the leg ${failedAtLeg + 1} failure — net ${fmtPct(profitPct)} (${money(profitAmt)}) on this attempt. This was a real loss-limiting trade, not a profitable cycle.`, 'error');
    }
  }

  // Either way, the tracked balance/profit numbers only mean anything if
  // they reflect what the exchange actually reports now — never re-derive
  // them purely from the leg math above for a real cycle; fees, slippage,
  // and dust all show up in the real balance and nowhere else.
  await reverifyStoredCred(key, mode, { silent: true });
  const newBal = state.balances[key]?.[mode];
  if(newBal != null){
    at.currentBalance = newBal;
    at.dayProfitAmt = newBal - at.startingBalance;
    at.dayProfitPct = at.startingBalance > 0 ? (at.dayProfitAmt / at.startingBalance) * 100 : 0;
    if(at.dayProfitPct >= dailyTarget){
      at.targetReached = true;
      stopAutotrade();
      showAtMessage(`🎯 Daily target of ${dailyTarget}% reached — Autotrade stopped for the day. Started at ${money(at.startingBalance)}, now at ${money(at.currentBalance)} (${fmtPct(at.dayProfitPct)}).`, 'info');
    }
  }
}

function trackRepeat(cycle){
  const at = state.autotrade;
  if(at.lastCanonicalKey === cycle.canonicalKey){
    at.lastCanonicalStreak++;
  } else {
    at.lastCanonicalKey = cycle.canonicalKey;
    at.lastCanonicalStreak = 1;
  }
}

function executeCycle(cycle, dailyTarget, testMode){
  trackRepeat(cycle);
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
    testMode: !!testMode,
  });

  if(!testMode && at.dayProfitPct >= dailyTarget){
    at.targetReached = true;
    stopAutotrade();
    showAtMessage(`🎯 Daily target of ${dailyTarget}% reached after ${at.cycles.length} cycle${at.cycles.length===1?'':'s'} — Autotrade stopped for the day. Started at ${money(at.startingBalance)}, ended at ${money(at.currentBalance)} (+${fmtPct(at.dayProfitPct)}). See the cycle summary below.`, 'info');
  } else if(testMode){
    showAtMessage(`⚠ TEST MODE — executed cycle #${at.cycles.length} regardless of profitability: ${cycle.path.join(' → ')} → ${cycle.path[0]} at ${fmtPct(cycle.profitPct)} (${money(profitAmt)}). This trade ignored the profit floor on purpose. Running total: ${fmtPct(at.dayProfitPct)}.`, 'error');
  } else {
    showAtMessage(`Executed cycle #${at.cycles.length}: ${cycle.path.join(' → ')} → ${cycle.path[0]} at ${fmtPct(cycle.profitPct)} (${money(profitAmt)}). Running total: ${fmtPct(at.dayProfitPct)} of ${dailyTarget}% target.`, 'info');
  }
}

function startAutotrade(){
  const at = state.autotrade;
  const key = els.atExchange.value;
  const mode = EXCHANGES[key].demoSupported ? state.autotrade.mode : 'live';
  const startBal = state.balances[key]?.[mode];
  if(startBal == null || !isFinite(startBal) || startBal <= 0){
    showAtMessage(`No balance found for ${EXCHANGES[key].label} (${mode}). Connect that account (or click Refresh Balance on its row) above before starting Autotrade.`, 'error');
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
  at.lastCanonicalKey = null;
  at.lastCanonicalStreak = 0;
  at.enabled = true;
  at.running = true;
  at.testMode = !!els.atTestMode.checked;

  const intervalMs = Math.max(5, parseFloat(els.atInterval.value) || 15) * 1000;
  tick();
  at.timer = setInterval(tick, intervalMs);

  els.atExchange.disabled = true;
  els.atStartBalance.disabled = true;
  els.atAnchor.disabled = true;
  els.atModeLive.disabled = true;
  els.atModeDemo.disabled = true;

  const netLabel = mode === 'demo' ? ' (demo)' : '';
  const floorNote = at.testMode
    ? `⚠ TEST MODE is ON — it will execute the best cycle every scan regardless of profitability, including losses, to exercise the trade/log/balance path. It will NOT stop at the daily target automatically; use Stop Autotrade when you're done testing.`
    : `Will only act on cycles ≥ ${Math.max(MIN_PROFIT_FLOOR, parseFloat(els.atMinProfit.value)||MIN_PROFIT_FLOOR).toFixed(2)}%, and stops automatically at +${els.atDailyTarget.value}% for the day.`;
  showAtMessage(`Autotrade started on ${EXCHANGES[key].label}${netLabel} — Triangular only, Spot only. ${floorNote}`, at.testMode ? 'error' : 'info');
  persist();
  renderAutotradeStatus();
}

function stopAutotrade(){
  const at = state.autotrade;
  at.enabled = false;
  at.running = false;
  if(at.timer){ clearInterval(at.timer); at.timer = null; }
  disarmLiveExecution(); // require an explicit re-arm before Real order execution can run again
  els.atExchange.disabled = false;
  els.atStartBalance.disabled = false;
  els.atAnchor.disabled = false;
  els.atModeLive.disabled = false;
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
    els.atTestMode.checked = !!state.autotrade.testMode;
    els.atLiveExecution.checked = false; // always starts unarmed — see restore()
    els.atArmRow.style.display = 'none';
    syncStartBalanceField();
    renderAutotradeStatus();
    // If Autotrade was left ON from a previous session (page refresh), resume it.
    if(state.autotrade.enabled && !state.autotrade.targetReached){
      const intervalMs = Math.max(5, parseFloat(els.atInterval.value) || 15) * 1000;
      state.autotrade.running = true;
      els.atExchange.disabled = true;
      els.atStartBalance.disabled = true;
      els.atAnchor.disabled = true;
      els.atModeLive.disabled = true;
      els.atModeDemo.disabled = true;
      tick();
      state.autotrade.timer = setInterval(tick, intervalMs);
    }
    // Kick off a background refresh of every connected key's balance right
    // away (so a stale number from last session doesn't just sit there),
    // then keep it fresh on a recurring timer for as long as this tab is
    // open — this runs independently of whether Autotrade itself is
    // started, since the Balances panel is useful on its own.
    refreshAllConnectedBalances();
    setInterval(refreshAllConnectedBalances, BALANCE_REFRESH_INTERVAL_MS);
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
