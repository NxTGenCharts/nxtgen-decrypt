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

const USER_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUserId = (s) => USER_ID_RE.test(String(s || ''));

// Which accounts have saved data. Used at boot so every user's bots resume without anyone having to sign in first.
export async function listStoredUsers({ dir, remote, log = console } = {}){
  const ids = new Set();
  try{
    if(remote && remote.url && remote.key){
      const h = { apikey: remote.key }; if(/^eyJ/.test(remote.key)) h.Authorization = `Bearer ${remote.key}`;
      const res = await fetch(`${String(remote.url).replace(/\/$/, '')}/rest/v1/${REMOTE_TABLE}?select=k&k=like.u:*:state`, { headers: h, signal: AbortSignal.timeout(15_000) });
      if(!res.ok) throw new Error(`database ${res.status}`);
      for(const r of await res.json()){ const m = /^u:([^:]+):state$/.exec(r.k || ''); if(m && isUserId(m[1])) ids.add(m[1].toLowerCase()); }
    } else {
      const d = path.join(path.resolve(dir || path.join(process.cwd(), 'data')), 'users');
      if(fs.existsSync(d)) for(const f of fs.readdirSync(d)){ const m = /^(.+)\.json$/.exec(f); if(m && isUserId(m[1])) ids.add(m[1].toLowerCase()); }
    }
  }catch(e){ log.error && log.error(`[accounts] could not list saved accounts: ${e.message}`); throw e; }
  return [...ids];
}

// userId: when set, everything this store saves is namespaced to that account (rows "u:<id>:state|creds|trades", or
// users/<id>.json on disk) and its exchange keys are encrypted with a key derived from BOT_VAULT_KEY AND the user id, so one
// account's data can never be read through another account's store. With no userId it is the original single-owner store.
export function openBotStore({ dir, vaultKey, remote, disabledReason, log = console, writeDelayMs, retryMs = 5_000, userId } = {}){
  if(userId != null && !isUserId(userId)) throw new Error('Invalid user id.');
  const uid = userId ? String(userId).toLowerCase() : null;
  const ns = uid ? `u:${uid}:` : '';
  const key = String(vaultKey || '').trim();
  const enabled = key.length >= MIN_VAULT_KEY_LEN;
  const dataDir = path.resolve(dir || path.join(process.cwd(), 'data'));
  const file = uid ? path.join(dataDir, 'users', `${uid}.json`) : path.join(dataDir, 'bots.json');
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

  if(on) aesKey = crypto.scryptSync(key, uid ? `nxtgen-bot-vault-v1:${uid}` : 'nxtgen-bot-vault-v1', 32);

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
      fs.mkdirSync(path.dirname(file), { recursive: true });
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
        const rows = await rest('GET', uid ? `?select=k,v&k=like.${encodeURIComponent(`u:${uid}:*`)}` : '?select=k,v&k=in.(state,trades,creds)');
        const by = Object.fromEntries((rows || []).map(r => [String(r.k).slice(ns.length), r.v]));
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
      fs.mkdirSync(path.dirname(file), { recursive: true });
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
    const rows = [{ k: ns + 'state', v: { ...state, trades: [] } }];
    if(wasCreds) rows.push({ k: ns + 'creds', v: Object.fromEntries(creds) });
    if(sig !== lastTradeSig) rows.push({ k: ns + 'trades', v: state.trades.slice(0, REMOTE_MAX_TRADES) });
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
          await rest('POST', '?on_conflict=k', [{ k: ns + 'health', v: { at: Date.now() }, updated_at: new Date().toISOString() }], { Prefer: 'resolution=merge-duplicates,return=minimal' });
        } else {
          fs.mkdirSync(path.dirname(file), { recursive: true }); fs.accessSync(path.dirname(file), fs.constants.W_OK);
        }
        return { ok: true };
      }catch(e){ lastSaveError = e.message; return { ok: false, message: e.message }; }
    },
    persistence: useRemote ? 'database' : 'disk',
    userId: uid, dataDir, file, state, ready: readyP,
    touch, flush: flushNow, flushNow,

    // ---- shared API keys ----
    setCred(exchange, mode, { apiKey, secretKey, passphrase }, { verifiedAt } = {}){
      if(!on) throw new Error(reason);
      if(!apiKey || !secretKey) throw new Error('apiKey and secretKey are required.');
      const id = credId(exchange, mode);
      const cred = { apiKey: String(apiKey), secretKey: String(secretKey), passphrase: passphrase ? String(passphrase) : '' };
      plain.set(id, cred);
      creds.set(id, { enc: encrypt(cred), last4: cred.apiKey.slice(-4), fp: fingerprint(cred.apiKey), updatedAt: Date.now(), verifiedAt: verifiedAt || null, hasPassphrase: !!cred.passphrase });
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
        return { exchange, mode, last4: r.last4, fp: r.fp, updatedAt: r.updatedAt, verifiedAt: r.verifiedAt || null, hasPassphrase: !!r.hasPassphrase };
      });
    },
    // Records that the exchange itself last confirmed this key at `at` (a successful read-only check). Never touches the secret.
    markVerified(exchange, mode, at = Date.now()){
      const id = credId(exchange, mode), r = creds.get(id);
      if(!r) return false;
      r.verifiedAt = at; dirty = true; dirtyCreds = true; flushNow();
      return true;
    },
    // Account deletion: forget everything this store holds for the account — keys in memory, then the rows/file on storage.
    // Only meaningful for a per-account store (never the shared single-owner one).
    async destroy(){
      if(!uid) throw new Error('Refusing to destroy the shared store.');
      if(timer){ clearTimeout(timer); timer = null; }
      plain.clear(); creds.clear(); dirty = false; dirtyCreds = false; ready = false;
      if(useRemote){
        await rest('DELETE', `?k=like.${encodeURIComponent(`u:${uid}:*`)}`, null, { Prefer: 'return=minimal' });
      } else {
        for(const f of [file, `${file}.tmp`]){ try{ fs.rmSync(f, { force: true }); }catch(e){ throw new Error(`could not remove ${path.basename(f)}: ${e.message}`); } }
      }
    },
    fingerprint,

    close(){ if(timer){ clearTimeout(timer); timer = null; } return flushNow(); },
  };
}
