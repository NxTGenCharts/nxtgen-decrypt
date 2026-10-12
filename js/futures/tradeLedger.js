// =============================================================
// tradeLedger.js — one definition of "is this bot trade already in the log?",
// shared by the browser (js/futures-ui.js) and the server (server/botEngine.js)
// so both sides book a closed trade EXACTLY ONCE.
//
// Why this exists: a bot's close can be noticed by more than one code path
// (the management cycle, a Stop / Pause / daily-limit flatten, "Add missing closes",
// the server mirror landing in the browser). Before this, each path appended its own
// row and added its P&L to the bot and to the daily counters, so the same trade could
// show twice in the Trade Log and be counted twice against the Daily Max Loss.
//
// Only Trading Bot rows (they carry `gridId` = the bot's id) are ever treated as
// duplicates. Paper / Live-engine / Grid-engine rows are left strictly alone.
// Pure functions, no DOM, no storage — safe to import anywhere.
// =============================================================

const FINGERPRINT_WINDOW_MS = 120_000;   // same bot + same net inside 2 min, and no order id to tell them apart
const NET_EPSILON = 1e-4;

const hasId = (v) => v !== undefined && v !== null && v !== '';

// True when `a` and `b` describe the same closed trade of the same bot.
export function sameBotTrade(a, b){
  if(!a || !b || !hasId(a.gridId) || a.gridId !== b.gridId) return false;
  if(hasId(a.id) && hasId(b.id) && a.id === b.id) return true;
  // 1) Exchange order ids are the strongest identity: one closing order = one trade.
  if(hasId(a.closeOrderId) && hasId(b.closeOrderId)) return String(a.closeOrderId) === String(b.closeOrderId);
  // 2) No order id on one/both rows (a forced flatten, a floating-P&L estimate, a DCA close):
  //    same bot, same level, same net, a moment apart = the same event seen twice.
  if(hasId(a.closeOrderId) !== hasId(b.closeOrderId) && a.pnlSource === 'exchange' && b.pnlSource === 'exchange') return false;
  if((a.gridLevel ?? null) !== (b.gridLevel ?? null)) return false;
  const na = Number(a.netUsd), nb = Number(b.netUsd);
  if(!Number.isFinite(na) || !Number.isFinite(nb) || Math.abs(na - nb) > NET_EPSILON) return false;
  return Math.abs((Number(a.closedAtMs) || 0) - (Number(b.closedAtMs) || 0)) <= FINGERPRINT_WINDOW_MS;
}

// Is `record` already represented in `log`?  Only bot rows can be duplicates.
export function isDuplicateBotTrade(log, record){
  if(!record || !hasId(record.gridId) || !Array.isArray(log)) return false;
  for(const t of log) if(sameBotTrade(t, record)) return true;
  return false;
}

// Collapses duplicates in an existing log (oldest row kept). Returns what was removed so
// callers can take it back out of the day counters / bot totals if they want to.
export function dedupeBotTrades(log){
  const kept = [], removed = [];
  const seenByBot = new Map();                       // gridId -> kept rows of that bot
  const ordered = [...log].sort((x, y) => (x.closedAtMs || 0) - (y.closedAtMs || 0));
  const dropIds = new Set();
  for(const t of ordered){
    if(!hasId(t.gridId)) continue;
    const mine = seenByBot.get(t.gridId) || [];
    if(mine.some(k => sameBotTrade(k, t))){ removed.push(t); dropIds.add(t); continue; }
    mine.push(t); seenByBot.set(t.gridId, mine);
  }
  for(const t of log) if(!dropIds.has(t)) kept.push(t);   // preserves the log's original (newest-first) order
  return { kept, removed };
}

// Fee helpers so every export/summary reads fees the same way. Exchanges report fees
// with either sign; a fee is always a cost. Returns null when the row genuinely has none.
export function feeOf(t){
  return t && t.feesUsd != null && Number.isFinite(Number(t.feesUsd)) ? Math.abs(Number(t.feesUsd)) : null;
}
