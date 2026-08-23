// =============================================================
// autotrade.js — "Connect Exchanges", per-exchange Balances, and
// the Autotrade engine for the Triangular tab only.
//
// IMPORTANT — what this actually does:
// This module does NOT place real orders on any exchange. It cannot:
// browser JS has no safe way to sign authenticated exchange requests
// without exposing your secret key to anyone who opens devtools, so
// wiring a secret key straight to live order placement from a static
// front-end would be a security problem, not just a feature. Real
// auto-execution belongs behind a server you control that holds the
// keys and signs requests — this file is the decision engine you'd
// point at that server.
//
// What it DOES do:
// - Lets you "connect" an exchange (API key + secret stored only in
//   this browser's localStorage, never transmitted anywhere).
// - Lets you record today's balance per exchange (manual entry, since
//   reading a real balance also requires an authenticated/signed call).
// - Watches the selected exchange's live order books for triangular
//   cycles, same math as the Triangular tab, and — when Autotrade is
//   ON — paper-trades (simulates) the single highest-profit cycle that
//   clears your profit floor, compounding a running "today" balance
//   until your daily target is hit, then stops and shows the summary.
// =============================================================
import { els, state } from './state.js';
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

// ---------------- persistence (localStorage only — nothing leaves the browser) ----------------
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
// flat object/number instead of today's { live, testnet } shape. Coerce
// anything unexpected back into a safe shape rather than letting a stale
// localStorage value throw when we later index into .live/.testnet.
function coerceCredSlot(saved){
  if(saved && typeof saved === 'object' && ('live' in saved || 'testnet' in saved)){
    return { live: saved.live || null, testnet: saved.testnet || null };
  }
  if(saved && typeof saved === 'object' && saved.apiKey){
    // Old flat "{ apiKey, connectedAt }" shape — treat it as a live-network connection.
    return { live: saved, testnet: null };
  }
  return { live: null, testnet: null };
}

function coerceBalanceSlot(saved, supportsTestnet){
  if(saved && typeof saved === 'object' && ('live' in saved || 'testnet' in saved)){
    return supportsTestnet ? { live: saved.live ?? null, testnet: saved.testnet ?? null } : { live: saved.live ?? null };
  }
  if(typeof saved === 'number'){
    // Old flat number shape — treat it as the live-network balance.
    return supportsTestnet ? { live: saved, testnet: null } : { live: saved };
  }
  return supportsTestnet ? { live: null, testnet: null } : { live: null };
}

function restore(){
  try{
    const raw = localStorage.getItem(LS_KEY);
    if(!raw) return;
    const saved = JSON.parse(raw);
    if(saved.exchangeCreds){
      for(const key of Object.keys(EXCHANGES)){
        state.exchangeCreds[key] = coerceCredSlot(saved.exchangeCreds[key]);
      }
    }
    if(saved.exchangeMode){
      for(const key of Object.keys(EXCHANGES)){
        const m = saved.exchangeMode[key];
        state.exchangeMode[key] = (m === 'testnet' && EXCHANGES[key].testnetSupported) ? 'testnet' : 'live';
      }
    }
    if(saved.balances){
      for(const key of Object.keys(EXCHANGES)){
        state.balances[key] = coerceBalanceSlot(saved.balances[key], EXCHANGES[key].testnetSupported);
      }
    }
    if(saved.autotrade) Object.assign(state.autotrade, saved.autotrade, { timer:null, running:false });
    if(!EXCHANGES[state.autotrade.exchange]) state.autotrade.exchange = 'bitget';
    if(state.autotrade.mode !== 'testnet') state.autotrade.mode = 'live';
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
    const connected = !!cred;
    const modeToggle = supportsTestnet ? `
      <div class="mode-toggle" role="group" aria-label="${label} network">
        <button type="button" class="mode-btn ${mode==='live'?'active':''}" data-mode="live">Live</button>
        <button type="button" class="mode-btn ${mode==='testnet'?'active':''}" data-mode="testnet">Testnet</button>
      </div>` : `<div class="mode-toggle mode-toggle--disabled" title="Bitget has no public spot testnet"><span class="mode-btn active">Live only</span></div>`;
    return `<div class="connect-row" data-exchange="${key}" data-mode="${mode}">
      <div class="connect-label">${label}${mode==='testnet' ? ' <span class="pill" style="margin-left:6px;color:var(--amber);border-color:var(--amber-dim);">TESTNET</span>' : ''}</div>
      ${modeToggle}
      <input class="ck-key" type="text" placeholder="Enter ${mode === 'testnet' ? 'testnet ' : ''}API key" value="${connected ? maskKey(cred.apiKey) : ''}" ${connected ? 'disabled' : ''}>
      <input class="ck-secret" type="password" placeholder="Enter ${mode === 'testnet' ? 'testnet ' : ''}secret key" value="${connected ? '••••••••••••' : ''}" ${connected ? 'disabled' : ''}>
      <button class="primary ${connected ? 'ghost' : ''} connect-btn" data-action="${connected ? 'disconnect' : 'connect'}">
        ${connected ? 'Disconnect' : 'Connect'}
      </button>
      <span class="xbadge" data-state="${connected ? 'up' : 'idle'}"><span class="xbadge-dot"></span>${connected ? 'CONNECTED' : 'NOT CONNECTED'}</span>
    </div>`;
  }).join('');
}

function maskKey(k){
  if(!k) return '';
  if(k.length <= 8) return '•'.repeat(k.length);
  return k.slice(0,4) + '…' + k.slice(-4);
}

els.connectRows.addEventListener('click', (e) => {
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
  const btn = e.target.closest('.connect-btn');
  if(!btn) return;
  const row = e.target.closest('.connect-row');
  const key = row.dataset.exchange;
  const mode = state.exchangeMode[key];
  const action = btn.dataset.action;
  if(action === 'connect'){
    const apiKey = row.querySelector('.ck-key').value.trim();
    const secretKey = row.querySelector('.ck-secret').value.trim();
    if(!apiKey || !secretKey){
      showAtMessage('Enter both an API key and a secret key before connecting.', 'error');
      return;
    }
    // Stored locally only, never sent anywhere — see the notice under Connect Exchanges.
    state.exchangeCreds[key][mode] = { apiKey, secretKeyMasked: true, connectedAt: new Date().toLocaleString() };
    const netLabel = mode === 'testnet' ? 'testnet' : 'live';
    showAtMessage(`${EXCHANGES[key].label} (${netLabel}) connected. Keys are stored only in this browser (localStorage) and are not used to place any trade — Autotrade below runs as a simulation against ${EXCHANGES[key].label}'s ${netLabel} public order book.`, 'info');
  } else {
    state.exchangeCreds[key][mode] = null;
    showAtMessage(`${EXCHANGES[key].label} (${mode}) disconnected.`, 'info');
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
    const modeTag = mode === 'testnet' ? ' <span class="pill" style="color:var(--amber);border-color:var(--amber-dim);">TESTNET</span>' : '';
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
}

els.atModeLive.addEventListener('click', () => { state.autotrade.mode = 'live'; syncAtModeToggle(); renderBalances(); });
els.atModeTestnet.addEventListener('click', () => {
  if(!EXCHANGES[els.atExchange.value].testnetSupported) return;
  state.autotrade.mode = 'testnet'; syncAtModeToggle(); renderBalances();
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
  els.atProgressLabel.textContent = `${fmtPct(at.dayProfitPct || 0)} of ${target}% daily target${at.targetReached ? ' — reached' : ''}${at.mode === 'testnet' ? ' · TESTNET' : ''}`;

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
  const testnet = at.mode === 'testnet' && EXCHANGES[key].testnetSupported;
  const anchor = els.atAnchor.value;
  const feePct = parseFloat(els.atFee.value) || 0;
  const minVolume = parseFloat(els.atMinVolume.value) || 0;
  const configuredFloor = parseFloat(els.atMinProfit.value);
  const minProfitPct = Math.max(MIN_PROFIT_FLOOR, isFinite(configuredFloor) ? configuredFloor : MIN_PROFIT_FLOOR);
  const dailyTarget = parseFloat(els.atDailyTarget.value) || 11;
  const netLabel = testnet ? ' (testnet)' : '';

  try{
    const rawPairs = await EXCHANGES[key].load(testnet);
    if(!testnet) state.pairsCache[key] = rawPairs; // Overview's market count reflects live data only
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

  const netLabel = mode === 'testnet' ? ' (testnet)' : '';
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
