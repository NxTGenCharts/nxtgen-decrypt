// =============================================================
// quant/log.js — the [QUANT] log channel.
//
// The codebase has no central log service (Paper uses the scanner table +
// explanation pane; Live uses a single status label), so this is a small,
// scoped one: an in-memory ring buffer + console output + optional
// subscribers (the Quant panel's log viewer subscribes). It is OFF for
// Backtest (thousands of bars would drown it) — callers opt in via
// cfg.quant.log.
//
// qlogOnce() de-duplicates: Live re-evaluates the same closed candle every
// ~8s cycle, and without this the same "setup detected" line would repeat
// dozens of times for one signal.
// =============================================================
const MAX_LINES = 400;
const buffer = [];
const listeners = new Set();
const seen = new Map(); // dedupe key -> timestamp
const SEEN_MAX = 600;

let consoleEnabled = true;
export function setQuantConsole(on){ consoleEnabled = !!on; }

export function qlog(msg, level){
  const entry = { t: Date.now(), level: level || 'info', line: `[QUANT] ${msg}` };
  buffer.push(entry);
  if(buffer.length > MAX_LINES) buffer.shift();
  if(consoleEnabled && typeof console !== 'undefined'){
    (level === 'error' ? console.error : level === 'warn' ? console.warn : console.info)(entry.line);
  }
  listeners.forEach(fn => { try{ fn(entry); }catch(e){ /* a bad subscriber must never break trading */ } });
}

export function qlogOnce(key, msg, level){
  if(seen.has(key)) return false;
  seen.set(key, Date.now());
  if(seen.size > SEEN_MAX){
    const oldest = seen.keys().next().value;
    seen.delete(oldest);
  }
  qlog(msg, level);
  return true;
}

export function getQuantLog(){ return buffer.slice(); }
export function clearQuantLog(){ buffer.length = 0; seen.clear(); listeners.forEach(fn => { try{ fn(null); }catch(e){} }); }
export function onQuantLog(fn){ listeners.add(fn); return () => listeners.delete(fn); }
