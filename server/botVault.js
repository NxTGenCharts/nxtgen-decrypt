// =============================================================
// botVault.js — durable storage for the server-side Trading Bots.
//
//   1. the bots themselves, their trade records and the cross-bot daily counters
//      (one JSON file, written atomically: tmp file + rename)
//   2. the SHARED exchange API keys, one entry per exchange+mode. These are the same
//      keys you verify on the API Keys tab — the browser pushes them here once, and
//      every server-side bot on that exchange/mode uses them. They are encrypted at
//      rest (AES-256-GCM) with a key derived from BOT_VAULT_KEY and decrypted only in
//      memory, only when a bot actually needs to sign a request.
//
// Fails closed: without a BOT_VAULT_KEY of >= 32 characters the vault is disabled and
// no key is ever written to disk.
//
// Where it is saved (pick ONE):
//   * BOT_SUPABASE_URL + BOT_SUPABASE_KEY  a free Supabase project (a plain key/value table, written over
//                   HTTPS). This is how it works on Render's FREE plan, whose own disk is erased on every
//                   restart/spin-down. The server's memory is just a cache; the database is the truth.
//   * BOT_DATA_DIR  a folder on a PERSISTENT disk (Render paid disk, a VPS...). bots.json lives there.
//   With neither, the default folder is only safe on a machine whose disk survives restarts — on Render
//   (env RENDER=true) that would be silently ephemeral, so server bots stay OFF and say why.
//
// Env:
//   BOT_VAULT_KEY   >= 32 random characters. LOSE IT and the saved keys are unreadable
//                   (you just re-sync them from the browser); CHANGE IT and the same.
// =============================================================
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const MIN_VAULT_KEY_LEN = 32;
const FILE_VERSION = 1;
const MAX_TRADES = 3000;

function freshState(){
  return {
    tradingBots: [],
    trades: [],
    tbDayKey: null,
    tbDayAnchorInvestmentUsd: 0,
    tbDayRealizedUsd: 0,
    tbDailyHalted: false,
    tbDailyHaltMessage: null,
    tbDailyProfitTargetPct: 20,
    tbDailyMaxLossPct: 10,
  };
}

const credId = (exchange, mode) => `${String(exchange).toLowerCase()}:${String(mode).toLowerCase()}`;

const REMOTE_TABLE = 'nxtgen_bots_kv';
const REMOTE_MAX_TRADES = 500;   // the browser keeps the long history; the server only needs recent ones to survive a restart
const REMOTE_WRITE_DELAY_MS = 20_000;

export function openBotStore({ dir, vaultKey, remote, disabledReason, log = console, writeDelayMs, retryMs = 5_000 } = {}){
  const key = String(vaultKey || '').trim();
  const enabled = key.length >= MIN_VAULT_KEY_LEN;
  const dataDir = path.resolve(dir || path.join(process.cwd(), 'data'));
  const file = path.join(dataDir, 'bots.json');
  const useRemote = !!(remote && remote.url && remote.key);
  const keyReason = key.length === 0 ? 'BOT_VAULT_KEY is not set on the server.'
    : (key.length < MIN_VAULT_KEY_LEN ? `BOT_VAULT_KEY is only ${key.length} characters — it must be at least ${MIN_VAULT_KEY_LEN}.` : null);
  const on = enabled && !disabledReason;
  const reason = disabledReason || keyReason;
  const delay = writeDelayMs != null ? writeDelayMs : (useRemote ? REMOTE_WRITE_DELAY_MS : 1500);

  const state = freshState();
  const creds = new Map();       // id -> { enc, last4, fp, updatedAt }
  const plain = new Map();       // id -> decrypted cred, memory only
  let aesKey = null;
  let timer = null, dirty = false;
  let dirtyCreds = false, lastTradeSig = '', ready = false, saving = null, saveFailures = 0;
  let lastSaveAt = null, lastSaveError = null;   // surfaced by /api/bots/status so a store that can't save is visible, not silent

  if(on) aesKey = crypto.scryptSync(key, 'nxtgen-bot-vault-v1', 32);

  // ---------- crypto ----------
  function encrypt(obj){
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', aesKey, iv);
    const data = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
    return { iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: data.toString('base64') };
  }
  function decrypt(enc){
    const d = crypto.createDecipheriv('aes-256-gcm', aesKey, Buffer.from(enc.iv, 'base64'));
    d.setAuthTag(Buffer.from(enc.tag, 'base64'));
    return JSON.parse(Buffer.concat([d.update(Buffer.from(enc.data, 'base64')), d.final()]).toString('utf8'));
  }
  const fingerprint = (apiKey) => crypto.createHash('sha256').update(String(apiKey)).digest('hex').slice(0, 12);

  // ---------- load ----------
  function applyLoaded(raw){
    if(raw && raw.state) Object.assign(state, freshState(), raw.state);
    if(raw && raw.creds && on){
      for(const [id, rec] of Object.entries(raw.creds)){
        try{ plain.set(id, decrypt(rec.enc)); creds.set(id, rec); }
        catch(e){ log.warn && log.warn(`[bots] could not decrypt saved key ${id} (wrong BOT_VAULT_KEY?) — re-sync it from the browser.`); }
      }
    }
  }
  function loadFile(){
    try{
      fs.mkdirSync(dataDir, { recursive: true });
      if(!fs.existsSync(file)) return;
      applyLoaded(JSON.parse(fs.readFileSync(file, 'utf8')));
    }catch(e){
      log.error && log.error(`[bots] could not read ${file}: ${e.message}`);
      // never overwrite a file we failed to parse — keep it as a backup
      try{ fs.copyFileSync(file, `${file}.corrupt-${Date.now()}`); }catch(_){ /* best effort */ }
    }
  }

  // ---------- remote (Supabase REST: one key/value table, no extra dependencies) ----------
  async function rest(method, query, body, headers){
    const h = { apikey: remote.key, 'Content-Type': 'application/json', ...(headers || {}) };
    if(/^eyJ/.test(remote.key)) h.Authorization = `Bearer ${remote.key}`; // legacy JWT keys; the newer secret keys go in apikey only
    const res = await fetch(`${String(remote.url).replace(/\/$/, '')}/rest/v1/${REMOTE_TABLE}${query}`, { method, headers: h, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15_000) });
    if(!res.ok) throw new Error(`database ${res.status}: ${(await res.text().catch(() => '')).slice(0, 160)}`);
    return res.status === 204 ? null : res.json().catch(() => null);
  }
  async function loadRemote(){
    for(let attempt = 0; ; attempt++){
      try{
        const rows = await rest('GET', '?select=k,v');
        const by = Object.fromEntries((rows || []).map(r => [r.k, r.v]));
        applyLoaded({ state: { ...(by.state || {}), trades: by.trades || [] }, creds: by.creds || {} });
        lastTradeSig = tradeSig();
        loadError = null;
        if(attempt) log.info && log.info('[bots] the bot database is reachable again — resuming.');
        return;
      }catch(e){
        // Starting empty here would let the engine overwrite good saved data with nothing, so stay OFF and keep retrying.
        loadError = `Could not read the bot database (${e.message}). Check BOT_SUPABASE_URL / BOT_SUPABASE_KEY and that the table exists.`;
        if(attempt === 0) log.error && log.error(`[bots] ${loadError}`);
        await new Promise(r => setTimeout(r, Math.min(60_000, retryMs * (attempt + 1))));
      }
    }
  }
  let loadError = null;
  const tradeSig = () => `${state.trades.length}:${state.trades[0] ? state.trades[0].id : ''}`;
  // ---------- save ----------
  // File mode: debounced atomic write. Remote mode: the same debounce (longer), plus flushNow() for the moments that
  // must not be lost to a restart (a bot handed over, an order placed, a fill booked, a key saved).
  function flushSync(){
    if(useRemote || !dirty) return;
    try{
      fs.mkdirSync(dataDir, { recursive: true });
      const out = { v: FILE_VERSION, savedAt: Date.now(), state, creds: Object.fromEntries(creds) };
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(out), { mode: 0o600 });
      fs.renameSync(tmp, file);
      dirty = false; lastSaveAt = Date.now(); lastSaveError = null; saveFailures = 0;
    }catch(e){
      saveFailures++; lastSaveError = e.message;
      log.error && log.error(`[bots] could not write ${file}: ${e.message}`);
    }
  }
  async function saveRemote(){
    if(!dirty && !dirtyCreds) return;
    const wasCreds = dirtyCreds, sig = tradeSig();
    const rows = [{ k: 'state', v: { ...state, trades: [] } }];
    if(wasCreds) rows.push({ k: 'creds', v: Object.fromEntries(creds) });
    if(sig !== lastTradeSig) rows.push({ k: 'trades', v: state.trades.slice(0, REMOTE_MAX_TRADES) });
    dirty = false; dirtyCreds = false;
    try{
      await rest('POST', '?on_conflict=k', rows.map(r => ({ ...r, updated_at: new Date().toISOString() })), { Prefer: 'resolution=merge-duplicates,return=minimal' });
      if(sig !== lastTradeSig) lastTradeSig = sig;
      saveFailures = 0; lastSaveAt = Date.now(); lastSaveError = null;
    }catch(e){
      dirty = true; if(wasCreds) dirtyCreds = true; saveFailures++; lastSaveError = e.message;     // keep it dirty: the next flush retries
      if(saveFailures === 1 || saveFailures % 10 === 0) log.error && log.error(`[bots] could not save to the database (attempt ${saveFailures}): ${e.message}`);
    }
  }
  function flushNow(){
    if(!useRemote){ flushSync(); return Promise.resolve(); }
    if(!ready) return Promise.resolve();
    saving = (saving || Promise.resolve()).then(saveRemote).finally(() => { /* chained so writes never overlap */ });
    return saving;
  }
  function touch(){
    dirty = true;
    if(timer) return;
    timer = setTimeout(() => { timer = null; flushNow(); }, delay);
    if(timer.unref) timer.unref();
  }
  if(state.trades.length > MAX_TRADES) state.trades.length = MAX_TRADES;

  // File mode loads synchronously (state is usable the moment this returns). Remote mode retries until the database answers.
  let readyP;
  if(useRemote) readyP = loadRemote().then(() => { ready = true; });
  else { loadFile(); ready = true; readyP = Promise.resolve(); }

  return {
    // Not "enabled" until the saved bots + keys have been read. Before this, a request that arrived during a cold start
    // (Render wakes the service on the first page load) saw an EMPTY store reported as healthy — the page then believed
    // the server had no bots and forgot its own.
    get enabled(){ return on && !loadError && ready; },
    get loading(){ return on && !loadError && !ready; },
    get reason(){ return loadError || reason || (on && !ready ? 'The server is still loading your saved bots — try again in a few seconds.' : null); },
    get health(){ return { persistence: useRemote ? 'database' : 'disk', lastSaveAt, lastSaveError, saveFailures, failing: saveFailures > 0 }; },
    // Proves a write can actually land RIGHT NOW. A database key that can read but not write (the public key instead of
    // the secret one) looks perfectly healthy until the first restart wipes everything — so check before taking a bot.
    async verifyWrite(){
      if(!on) return { ok: false, message: reason };
      try{
        if(useRemote){
          await rest('POST', '?on_conflict=k', [{ k: 'health', v: { at: Date.now() }, updated_at: new Date().toISOString() }], { Prefer: 'resolution=merge-duplicates,return=minimal' });
        } else {
          fs.mkdirSync(dataDir, { recursive: true }); fs.accessSync(dataDir, fs.constants.W_OK);
        }
        return { ok: true };
      }catch(e){ lastSaveError = e.message; return { ok: false, message: e.message }; }
    },
    persistence: useRemote ? 'database' : 'disk',
    dataDir, file, state, ready: readyP,
    touch, flush: flushNow, flushNow,

    // ---- shared API keys ----
    setCred(exchange, mode, { apiKey, secretKey, passphrase }){
      if(!on) throw new Error(reason);
      if(!apiKey || !secretKey) throw new Error('apiKey and secretKey are required.');
      const id = credId(exchange, mode);
      const cred = { apiKey: String(apiKey), secretKey: String(secretKey), passphrase: passphrase ? String(passphrase) : '' };
      plain.set(id, cred);
      creds.set(id, { enc: encrypt(cred), last4: cred.apiKey.slice(-4), fp: fingerprint(cred.apiKey), updatedAt: Date.now() });
      dirty = true; dirtyCreds = true; flushNow(); // keys are written immediately, not debounced
      return saving || Promise.resolve();
    },
    getCred(exchange, mode){ return plain.get(credId(exchange, mode)) || null; },
    deleteCred(exchange, mode){
      const id = credId(exchange, mode);
      plain.delete(id);
      const had = creds.delete(id);
      if(had){ dirty = true; dirtyCreds = true; flushNow(); }
      return had;
    },
    listCreds(){
      return [...creds.entries()].map(([id, r]) => {
        const [exchange, mode] = id.split(':');
        return { exchange, mode, last4: r.last4, fp: r.fp, updatedAt: r.updatedAt };
      });
    },
    fingerprint,

    close(){ if(timer){ clearTimeout(timer); timer = null; } return flushNow(); },
  };
}
