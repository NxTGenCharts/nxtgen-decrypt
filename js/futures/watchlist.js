// =============================================================
// watchlist.js — the ONE definition of "the watchlist" shared by Paper, Backtest and
// Live/Demo: the top WATCHLIST_TOP_N USDT perpetuals on the selected exchange ranked by
// 24h volume, after removing the platform's excluded pairs (excludedSymbols.js — the same
// list on every exchange). The ranking input is the exchange's own universe
// (server.js /api/futures/universe: [{ symbol, volume24hUsd, lastPrice }]).
// =============================================================
import { EXCLUDED_FUTURES_SYMBOLS } from './excludedSymbols.js';

export const WATCHLIST_TOP_N = 25;

// Never mutates its input (the caller's cached universe is reused across cycles).
// Returns { top: [{symbol, volume24hUsd, lastPrice?}], totalAvailable }.
export function rankTopByVolume(universe, n){
  const limit = Number.isFinite(n) ? n : WATCHLIST_TOP_N;
  const eligible = (Array.isArray(universe) ? universe : [])
    .filter(s => s && typeof s.symbol === 'string' && /USDT$/.test(s.symbol) && !EXCLUDED_FUTURES_SYMBOLS.has(s.symbol));
  eligible.sort((a, b) => (b.volume24hUsd || 0) - (a.volume24hUsd || 0));
  return { top: eligible.slice(0, limit), totalAvailable: eligible.length };
}
