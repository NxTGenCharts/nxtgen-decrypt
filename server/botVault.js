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
// Env:
//   BOT_VAULT_KEY   >= 32 random characters. LOSE IT and the saved keys are unreadable
//                   (you just re-sync them from the browser); CHANGE IT and the same.
//   BOT_DATA_DIR    where bots.json lives. On Render this MUST be a persistent disk
//                   mount (e.g. /var/data) — the default container disk is wiped on
//                   every deploy and restart.
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

export function openBotStore({ dir, vaultKey, log = console, writeDelayMs = 1500 } = {}){
  const key = String(vaultKey || '').trim();
  const enabled = key.length >= MIN_VAULT_KEY_LEN;
  const dataDir = path.resolve(dir || path.join(process.cwd(), 'data'));
  const file = path.join(dataDir, 'bots.json');
  const reason = enabled ? null
    : (key.length === 0 ? 'BOT_VAULT_KEY is not set on the server.'
      : `BOT_VAULT_KEY is only ${key.length} characters — it must be at least ${MIN_VAULT_KEY_LEN}.`);

  const state = freshState();
  const creds = new Map();       // id -> { enc, last4, fp, updatedAt }
  const plain = new Map();       // id -> decrypted cred, memory only
  let aesKey = null;
  let timer = null, dirty = false, writing = false;

  if(enabled) aesKey = crypto.scryptSync(key, 'nxtgen-bot-vault-v1', 32);

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
  function load(){
    try{
      fs.mkdirSync(dataDir, { recursive: true });
      if(!fs.existsSync(file)) return;
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      if(raw && raw.state) Object.assign(state, freshState(), raw.state);
      if(raw && raw.creds && enabled){
        for(const [id, rec] of Object.entries(raw.creds)){
          try{ plain.set(id, decrypt(rec.enc)); creds.set(id, rec); }
          catch(e){ log.warn && log.warn(`[bots] could not decrypt saved key ${id} (wrong BOT_VAULT_KEY?) — re-sync it from the browser.`); }
        }
      }
    }catch(e){
      log.error && log.error(`[bots] could not read ${file}: ${e.message}`);
      // never overwrite a file we failed to parse — keep it as a backup
      try{ fs.copyFileSync(file, `${file}.corrupt-${Date.now()}`); }catch(_){ /* best effort */ }
    }
  }

  // ---------- save (debounced, atomic) ----------
  function flushSync(){
    if(!dirty) return;
    try{
      fs.mkdirSync(dataDir, { recursive: true });
      const out = { v: FILE_VERSION, savedAt: Date.now(), state, creds: Object.fromEntries(creds) };
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(out), { mode: 0o600 });
      fs.renameSync(tmp, file);
      dirty = false;
    }catch(e){
      log.error && log.error(`[bots] could not write ${file}: ${e.message}`);
    }
  }
  function touch(){
    dirty = true;
    if(timer) return;
    timer = setTimeout(() => { timer = null; flushSync(); }, writeDelayMs);
    if(timer.unref) timer.unref();
  }
  if(state.trades.length > MAX_TRADES) state.trades.length = MAX_TRADES;

  load();

  return {
    enabled, reason, dataDir, file, state,
    touch, flush: flushSync,

    // ---- shared API keys ----
    setCred(exchange, mode, { apiKey, secretKey, passphrase }){
      if(!enabled) throw new Error(reason);
      if(!apiKey || !secretKey) throw new Error('apiKey and secretKey are required.');
      const id = credId(exchange, mode);
      const cred = { apiKey: String(apiKey), secretKey: String(secretKey), passphrase: passphrase ? String(passphrase) : '' };
      plain.set(id, cred);
      creds.set(id, { enc: encrypt(cred), last4: cred.apiKey.slice(-4), fp: fingerprint(cred.apiKey), updatedAt: Date.now() });
      dirty = true; flushSync(); // keys are written immediately, not debounced
    },
    getCred(exchange, mode){ return plain.get(credId(exchange, mode)) || null; },
    deleteCred(exchange, mode){
      const id = credId(exchange, mode);
      plain.delete(id);
      const had = creds.delete(id);
      if(had){ dirty = true; flushSync(); }
      return had;
    },
    listCreds(){
      return [...creds.entries()].map(([id, r]) => {
        const [exchange, mode] = id.split(':');
        return { exchange, mode, last4: r.last4, fp: r.fp, updatedAt: r.updatedAt };
      });
    },
    fingerprint,

    close(){ if(timer){ clearTimeout(timer); timer = null; } flushSync(); },
  };
}
