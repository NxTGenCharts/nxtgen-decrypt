// =============================================================
// Backup & Transfer — move this app's saved data between devices
// (e.g. phone -> PC) with an export file and an import button.
//
// What "site data" means here: this app keeps everything in the
// browser's localStorage under keys starting "nxtgen_" (trade logs,
// paper/backtest history, Trading Bots and their trades, strategy
// settings, balances, live positions it tracks). It does not use
// cookies or IndexedDB.
//
// Safety rules baked in:
// - API keys / secrets / passphrases / the server access token are
//   NOT exported unless you tick the box, and then ONLY inside a file
//   encrypted with a passphrase (AES-GCM, key from PBKDF2-SHA256).
// - Import only ever writes "nxtgen_*" keys, nothing else.
// - Bots that were Active in the backup are imported as PAUSED, so the
//   phone and the PC can never both manage the same live grid at once.
// =============================================================

const PREFIX = 'nxtgen_';
const FORMAT = 'nxtgen-backup';
const VERSION = 1;
const PBKDF2_ITERATIONS = 250000;
const MAX_FILE_BYTES = 25 * 1024 * 1024;

const K_AUTOTRADE = 'nxtgen_autotrade_v1';       // JSON: { exchangeCreds, exchangeMode, balances, autotrade }
const K_AI = 'nxtgen_ai_signal_v1';              // JSON: { provider, apiKey, enabled }
const K_WORKER_TOKEN = 'nxtgen_server_worker_token_v1'; // plain string token
const K_WORKER_DASH = 'nxtgen_worker_dash_v1';   // JSON that may hold { token }
const K_BOTS = 'nxtgen_futures_trading_bots_v1'; // JSON array of bots

// Friendly names + how to count "things" in a key, for the pre-import summary.
const SUMMARY_KEYS = [
  { key: 'nxtgen_futures_trade_log_v1', label: 'Live/Demo trade history entries', count: 'array' },
  { key: 'nxtgen_futures_paper_trade_log_v1', label: 'Paper trades', count: 'array' },
  { key: 'nxtgen_grid_paper_trade_log_v1', label: 'Grid paper trades', count: 'array' },
  { key: K_BOTS, label: 'Trading Bots (active, stopped and closed)', count: 'array' },
];

// ---------- small helpers ----------
const enc = new TextEncoder();
const dec = new TextDecoder();

function toB64(bytes){
  let s = '';
  const chunk = 0x8000;
  for(let i = 0; i < bytes.length; i += chunk) s += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  return btoa(s);
}
function fromB64(b64){
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for(let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function safeParse(s){ try{ return JSON.parse(s); }catch(e){ return null; } }

async function deriveKey(passphrase, salt, iterations){
  const base = await crypto.subtle.importKey('raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
  );
}

// ---------- export ----------
// Returns { [key]: string } of every nxtgen_* key, with secrets removed unless includeSecrets.
export function collectItems(storage, includeSecrets){
  const items = {};
  for(let i = 0; i < storage.length; i++){
    const k = storage.key(i);
    if(!k || !k.startsWith(PREFIX)) continue;
    const raw = storage.getItem(k);
    if(raw == null) continue;
    const v = sanitizeForExport(k, raw, includeSecrets);
    if(v != null) items[k] = v;
  }
  return items;
}

function sanitizeForExport(key, raw, includeSecrets){
  if(includeSecrets) return raw;
  if(key === K_WORKER_TOKEN) return null;
  if(key === K_AUTOTRADE){
    const o = safeParse(raw);
    if(!o || typeof o !== 'object') return null;
    delete o.exchangeCreds;
    return JSON.stringify(o);
  }
  if(key === K_AI){
    const o = safeParse(raw);
    if(!o || typeof o !== 'object') return null;
    delete o.apiKey;
    o.enabled = false;
    return JSON.stringify(o);
  }
  if(key === K_WORKER_DASH){
    const o = safeParse(raw);
    if(o && typeof o === 'object'){ delete o.token; return JSON.stringify(o); }
    return null;
  }
  return raw;
}

export async function buildBackupFile(storage, { includeSecrets = false, passphrase = '' } = {}){
  if(includeSecrets && passphrase.length < 8){
    throw new Error('A passphrase of at least 8 characters is required when API keys are included.');
  }
  const payload = {
    createdAt: new Date().toISOString(),
    includesSecrets: !!includeSecrets,
    items: collectItems(storage, includeSecrets),
  };
  if(!Object.keys(payload.items).length) throw new Error('There is no saved app data on this device to export yet.');
  if(!passphrase){
    return { format: FORMAT, version: VERSION, encrypted: false, ...payload };
  }
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt, PBKDF2_ITERATIONS);
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(payload))));
  return {
    format: FORMAT, version: VERSION, encrypted: true,
    createdAt: payload.createdAt, includesSecrets: payload.includesSecrets,
    kdf: { name: 'PBKDF2-SHA256', iterations: PBKDF2_ITERATIONS, salt: toB64(salt) },
    iv: toB64(iv), data: toB64(cipher),
  };
}

// ---------- import ----------
export async function readBackupFile(text, passphrase = ''){
  if(text.length > MAX_FILE_BYTES) throw new Error('That file is too large to be a backup from this app.');
  const file = safeParse(text);
  if(!file || file.format !== FORMAT) throw new Error('This is not a NxTGen backup file.');
  if(file.version > VERSION) throw new Error('This backup was made by a newer version of the app. Update the app and try again.');
  let payload = file;
  if(file.encrypted){
    if(!passphrase) throw new Error('This backup is encrypted \u2014 enter its passphrase.');
    try{
      const key = await deriveKey(passphrase, fromB64(file.kdf.salt), file.kdf.iterations);
      const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(file.iv) }, key, fromB64(file.data));
      payload = safeParse(dec.decode(plain));
    }catch(e){
      throw new Error('Wrong passphrase, or the file is damaged.');
    }
    if(!payload) throw new Error('The backup could not be read.');
  }
  if(!payload.items || typeof payload.items !== 'object') throw new Error('The backup contains no data.');
  const items = {};
  for(const [k, v] of Object.entries(payload.items)){
    if(k.startsWith(PREFIX) && typeof v === 'string') items[k] = v; // only this app's keys, only strings
  }
  if(!Object.keys(items).length) throw new Error('The backup contains no data for this app.');
  return { createdAt: payload.createdAt || file.createdAt || null, includesSecrets: !!payload.includesSecrets, items };
}

export function summarize(backup){
  const lines = [];
  for(const s of SUMMARY_KEYS){
    const v = backup.items[s.key];
    if(v == null) continue;
    const arr = safeParse(v);
    if(Array.isArray(arr)) lines.push(`${arr.length} ${s.label}`);
  }
  return lines;
}

// Writes the backup into storage. Returns { written, skipped, pausedBots }.
export function applyBackup(storage, backup){
  let written = 0, pausedBots = 0;
  const skipped = [];
  for(const [key, raw] of Object.entries(backup.items)){
    let value = raw;

    if(key === K_AUTOTRADE){
      const incoming = safeParse(raw);
      if(!incoming || typeof incoming !== 'object'){ skipped.push(key); continue; }
      if(!incoming.exchangeCreds){
        // Backup has no keys: keep THIS device's connected exchanges (and which network each uses).
        const local = safeParse(storage.getItem(key) || 'null');
        if(local && local.exchangeCreds){
          incoming.exchangeCreds = local.exchangeCreds;
          if(local.exchangeMode) incoming.exchangeMode = local.exchangeMode;
        }
      }
      value = JSON.stringify(incoming);
    } else if(key === K_AI){
      const incoming = safeParse(raw);
      if(!incoming || typeof incoming !== 'object'){ skipped.push(key); continue; }
      if(!incoming.apiKey){ skipped.push(key); continue; } // keep this device's AI key/settings
    } else if(key === K_BOTS){
      const bots = safeParse(raw);
      if(!Array.isArray(bots)){ skipped.push(key); continue; }
      for(const b of bots){
        if(b && b.status === 'active' && !b.paused){
          b.paused = true;
          b.statusMessage = 'Imported from another device \u2014 paused. Resume only if the other device is no longer running this bot.';
          b.statusIsError = false;
          pausedBots++;
        }
      }
      value = JSON.stringify(bots);
    }

    try{ storage.setItem(key, value); written++; }
    catch(e){ skipped.push(key); }
  }
  return { written, skipped, pausedBots };
}

// ---------- UI wiring (only runs on a page that has the Backup & Transfer block) ----------
function initUi(){
  const $ = (id) => document.getElementById(id);
  const exportBtn = $('bkExportBtn');
  if(!exportBtn) return;
  const shareBtn = $('bkShareBtn'), includeBox = $('bkIncludeSecrets'), exportPass = $('bkExportPass');
  const exportStatus = $('bkExportStatus'), fileInput = $('bkImportFile'), importBtn = $('bkImportBtn');
  const importPass = $('bkImportPass'), importStatus = $('bkImportStatus');

  const say = (el, msg, isErr) => { el.textContent = msg; el.style.color = isErr ? 'var(--red)' : 'var(--dim)'; };
  const stamp = () => { const d = new Date(), p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`; };

  async function makeFile(){
    const obj = await buildBackupFile(localStorage, { includeSecrets: includeBox.checked, passphrase: exportPass.value });
    const name = `nxtgen-backup-${stamp()}${obj.encrypted ? '-encrypted' : ''}.json`;
    return new File([JSON.stringify(obj)], name, { type: 'application/json' });
  }

  includeBox.addEventListener('change', () => {
    exportPass.placeholder = includeBox.checked ? 'Passphrase (required, 8+ characters)' : 'Passphrase (optional)';
  });

  exportBtn.addEventListener('click', async () => {
    say(exportStatus, 'Preparing\u2026');
    try{
      const file = await makeFile();
      const url = URL.createObjectURL(file);
      const a = document.createElement('a');
      a.href = url; a.download = file.name; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      say(exportStatus, `Saved ${file.name}. ${includeBox.checked ? 'It contains your API keys, encrypted with your passphrase \u2014 keep the passphrase safe.' : 'API keys were not included.'}`);
    }catch(e){ say(exportStatus, e.message, true); }
  });

  if(shareBtn){
    const probe = new File(['{}'], 'x.json', { type: 'application/json' });
    if(navigator.canShare && navigator.canShare({ files: [probe] })){
      shareBtn.hidden = false;
      shareBtn.addEventListener('click', async () => {
        say(exportStatus, 'Preparing\u2026');
        try{
          const file = await makeFile();
          await navigator.share({ files: [file], title: 'NxTGen backup' });
          say(exportStatus, 'Shared.');
        }catch(e){ if(e && e.name !== 'AbortError') say(exportStatus, e.message, true); else say(exportStatus, ''); }
      });
    }
  }

  importBtn.addEventListener('click', async () => {
    const f = fileInput.files && fileInput.files[0];
    if(!f){ say(importStatus, 'Choose a backup file first.', true); return; }
    say(importStatus, 'Reading\u2026');
    try{
      const backup = await readBackupFile(await f.text(), importPass.value);
      const lines = summarize(backup);
      const when = backup.createdAt ? new Date(backup.createdAt).toLocaleString() : 'unknown time';
      const msg = `Import backup from ${when}?\n\n` +
        (lines.length ? lines.map(l => `\u2022 ${l}`).join('\n') + '\n\n' : '') +
        `This REPLACES the matching data on this device (trade history, logs, bots, settings).\n` +
        (backup.includesSecrets ? 'The backup includes API keys \u2014 they will replace the ones saved here.\n' : 'API keys on this device are kept as they are.\n') +
        `Bots that were active are imported as paused.`;
      if(!window.confirm(msg)){ say(importStatus, 'Import cancelled.'); return; }
      const res = applyBackup(localStorage, backup);
      say(importStatus, `Imported ${res.written} items${res.pausedBots ? `, ${res.pausedBots} active bot(s) set to paused` : ''}. Reloading\u2026`);
      setTimeout(() => location.reload(), 1200);
    }catch(e){ say(importStatus, e.message, true); }
  });
}

if(typeof document !== 'undefined') initUi();
