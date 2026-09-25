// =============================================================
// ai-signal.js — optional, experimental "second opinion" layer for the AI
// Futures Engine's Live/Demo trading, using a model provider key the user
// supplies themselves (ChatGPT/OpenAI, Claude/Anthropic, Gemini/Google, or
// Grok/xAI). Lives in the API Keys tab, entirely separate from exchange
// credentials (see autotrade.js) — this file owns its own localStorage
// key and its own small render/persist cycle.
//
// IMPORTANT DESIGN CONSTRAINT, enforced by how this module is called (see
// futures-ui.js): this can only ever make the bot MORE conservative. It is
// consulted once, after js/futures/engine.js has already run every
// existing scoring/risk/no-trade check and produced an APPROVED row —
// never before, never on a row the core engine rejected. A "reject" verdict
// here cancels that one order; an "approve" verdict (or the check failing/
// timing out) just lets the engine's own decision stand. It never sees or
// touches position sizing, leverage, or any risk control on this page.
// =============================================================
import { els, state } from './state.js';

const LS_KEY = 'nxtgen_ai_signal_v1';

const PROVIDER_LABELS = {
  openai: 'ChatGPT (OpenAI)',
  anthropic: 'Claude (Anthropic)',
  google: 'Gemini (Google)',
  xai: 'Grok (xAI)',
};

function persist(){
  try{
    localStorage.setItem(LS_KEY, JSON.stringify({
      provider: state.aiSignal.provider,
      apiKey: state.aiSignal.apiKey,
      enabled: state.aiSignal.enabled,
    }));
  }catch(e){ /* storage unavailable — non-fatal, this just won't survive a reload */ }
}

function restore(){
  try{
    const raw = localStorage.getItem(LS_KEY);
    if(!raw) return;
    const saved = JSON.parse(raw);
    if(saved && typeof saved === 'object'){
      if(PROVIDER_LABELS[saved.provider]) state.aiSignal.provider = saved.provider;
      state.aiSignal.apiKey = typeof saved.apiKey === 'string' && saved.apiKey ? saved.apiKey : null;
      state.aiSignal.enabled = !!saved.enabled && !!state.aiSignal.apiKey; // can't be enabled with no key saved
    }
  }catch(e){ /* ignore corrupt/blocked storage */ }
}

function callProxy(path, body){
  const proxyUrl = (state.verifyProxyUrl || '').trim().replace(/\/$/, '');
  if(!proxyUrl) return Promise.reject(new Error('No verification proxy configured.'));
  return fetch(proxyUrl + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }).then(res => res.json().catch(() => null)).then(data => {
    if(!data) throw new Error('Proxy returned an unreadable response.');
    return data;
  });
}

function renderStatus(){
  if(!els.aiStatusNote) return;
  const { provider, apiKey, enabled, lastVerdict } = state.aiSignal;
  const label = PROVIDER_LABELS[provider] || provider;
  let html;
  if(!apiKey){
    html = 'No AI provider key saved yet.';
  } else {
    html = `${label} key saved${enabled ? ' — <b style="color:var(--green)">active</b>, will double-check every approved Live/Demo signal' : ' — currently <b>not</b> checking signals (toggle below to enable)'}.`;
    if(lastVerdict){
      const when = new Date(lastVerdict.at).toLocaleTimeString();
      if(!lastVerdict.ok){
        html += `<br>Last check (${when}, ${lastVerdict.symbol||''}) failed: ${lastVerdict.message||'unknown error'} — the engine's own decision was used instead.`;
      } else {
        html += `<br>Last check (${when}, ${lastVerdict.symbol||''}): ${lastVerdict.approve ? 'approved' : 'rejected'}${lastVerdict.confidence!=null ? ` (confidence ${lastVerdict.confidence})` : ''} — "${lastVerdict.reason||''}"`;
      }
    }
  }
  els.aiStatusNote.innerHTML = html;
}

function renderForm(){
  if(els.aiProviderSelect) els.aiProviderSelect.value = state.aiSignal.provider;
  if(els.aiEnabledToggle) els.aiEnabledToggle.checked = state.aiSignal.enabled;
  if(els.aiApiKeyInput && state.aiSignal.apiKey){
    els.aiApiKeyInput.value = state.aiSignal.apiKey;
    els.aiApiKeyInput.type = 'password';
    if(els.aiKeyRevealBtn) els.aiKeyRevealBtn.textContent = 'SHOW';
  }
  renderStatus();
}

function showTransientStatus(html){
  if(!els.aiStatusNote) return;
  els.aiStatusNote.innerHTML = html;
}

export function initAiSignal(){
  restore();
  renderForm();

  if(els.aiKeyRevealBtn) els.aiKeyRevealBtn.addEventListener('click', () => {
    const showing = els.aiApiKeyInput.type === 'text';
    els.aiApiKeyInput.type = showing ? 'password' : 'text';
    els.aiKeyRevealBtn.textContent = showing ? 'SHOW' : 'HIDE';
  });

  if(els.aiProviderSelect) els.aiProviderSelect.addEventListener('change', () => {
    state.aiSignal.provider = els.aiProviderSelect.value;
    persist();
    renderStatus();
  });

  if(els.aiSaveBtn) els.aiSaveBtn.addEventListener('click', () => {
    const key = (els.aiApiKeyInput.value || '').trim();
    if(!key){ showTransientStatus('Enter an API key before saving.'); return; }
    state.aiSignal.apiKey = key;
    state.aiSignal.provider = els.aiProviderSelect.value;
    persist();
    renderForm();
    showTransientStatus(`${PROVIDER_LABELS[state.aiSignal.provider]} key saved. Use Test Connection to confirm it works, then the toggle below to start using it.`);
  });

  if(els.aiRemoveBtn) els.aiRemoveBtn.addEventListener('click', () => {
    state.aiSignal.apiKey = null;
    state.aiSignal.enabled = false;
    state.aiSignal.lastVerdict = null;
    if(els.aiApiKeyInput) els.aiApiKeyInput.value = '';
    persist();
    renderForm();
  });

  if(els.aiEnabledToggle) els.aiEnabledToggle.addEventListener('change', () => {
    if(els.aiEnabledToggle.checked && !state.aiSignal.apiKey){
      els.aiEnabledToggle.checked = false;
      showTransientStatus('Save an API key first.');
      return;
    }
    state.aiSignal.enabled = els.aiEnabledToggle.checked;
    persist();
    renderStatus();
  });

  if(els.aiTestBtn) els.aiTestBtn.addEventListener('click', async () => {
    const key = (els.aiApiKeyInput.value || '').trim() || state.aiSignal.apiKey;
    const provider = els.aiProviderSelect.value;
    if(!key){ showTransientStatus('Enter an API key first.'); return; }
    showTransientStatus(`Testing ${PROVIDER_LABELS[provider]}…`);
    try{
      const result = await callProxy('/api/ai/confirm', {
        provider, apiKey: key,
        signal: {
          symbol: 'BTCUSDT', exchange: 'test', direction: 'LONG', setup: 'connection test',
          regime: 'n/a', confidence: 50, entry: 0, stop: 0, tp1: 0,
          riskRewardRatio: 1, expectedNetPct: 0, liquidityScore: 50,
          reasons: ['This is only a connection test — ignore the trade details and just confirm you can respond with the required JSON shape.'],
        },
      });
      if(result.ok) showTransientStatus(`${PROVIDER_LABELS[provider]} responded successfully: "${result.reason||'(no reason given)'}"`);
      else showTransientStatus(`${PROVIDER_LABELS[provider]} test failed: ${result.message||'unknown error'}`);
    }catch(err){
      showTransientStatus(`Could not reach the proxy: ${err.message}`);
    }
  });
}

// Called from futures-ui.js on an already-APPROVED Live/Demo row, right
// before an order is placed. Returns { ok, approve, confidence, reason }
// on a successful check, or { ok:false, message } if the check itself
// failed (network error, bad key, timeout, unparseable response, etc) —
// callers treat ok:false as "couldn't get a second opinion, proceed on the
// engine's own approval alone" rather than as a rejection.
export async function getAiConfirmation(signalPayload){
  const { provider, apiKey, enabled } = state.aiSignal;
  if(!enabled || !apiKey) return null; // feature not in use — caller should skip calling this at all when it can, this is a defensive fallback
  let result;
  try{
    result = await callProxy('/api/ai/confirm', { provider, apiKey, signal: signalPayload });
  }catch(err){
    result = { ok:false, message: err.message };
  }
  state.aiSignal.lastVerdict = {
    ok: !!result.ok, approve: result.approve, confidence: result.confidence, reason: result.reason,
    message: result.message, provider, symbol: signalPayload.symbol, at: Date.now(),
  };
  renderStatus();
  return result;
}
