// =============================================================
// excludedSymbols.js — the ONE list of futures pairs this platform never
// trades, for ANY strategy (Nova, NxTGen Scalp, Grid, ...), in every
// mode: Paper, Backtest and Live/Demo. Kept in its own dependency-free
// module so engine.js, backtest.js and the UI can
// all import it without circular imports. engine.js re-exports it under the
// same name it always had (EXCLUDED_FUTURES_SYMBOLS), so existing imports
// keep working.
//
// BTC/ETH/SOL/LTC/DOGE/BNB: the fee-to-stop math makes short-timeframe entries
// on them almost never viable at taker fees. CLUSDT is a TradFi-underlying
// contract. To change the list, edit it HERE — nothing else hard-codes it.
// =============================================================
export const EXCLUDED_FUTURES_SYMBOLS = new Set(['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'LTCUSDT', 'DOGEUSDT', 'BNBUSDT', 'CLUSDT']);
