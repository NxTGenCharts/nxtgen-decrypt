// =============================================================
// costs.js — turns a gross price target into a realistic net
// target by subtracting entry+exit fees, spread, slippage, and
// any funding expected to accrue over the holding period. Every
// number here is a percentage of notional unless labeled otherwise.
// =============================================================

export const DEFAULT_FEE_CONFIG = {
  binance: { makerPct: 0.02, takerPct: 0.05 },
  bybit:   { makerPct: 0.02, takerPct: 0.055 },
  // MEXC Futures' own published base-tier rate: 0.000% maker / 0.020% taker.
  // https://www.mexc.com/learn/article/17827791510370
  mexc:    { makerPct: 0.00, takerPct: 0.02 },
  // Gate.io Futures' published regular-user rate: 0.01% maker / 0.05% taker.
  gateio:  { makerPct: 0.01, takerPct: 0.05 },
  // Bitget USDT-M Futures' own published standard-tier rate: 0.02% maker /
  // 0.06% taker. https://www.bitget.com/support/articles/12560603817155
  // (Previously missing here entirely, which silently fell back to
  // Binance's 0.05% taker for every Bitget cost estimate — close, but not
  // Bitget's real, slightly higher, rate.)
  bitget:  { makerPct: 0.02, takerPct: 0.06 },
};

export const DEFAULT_MIN_NET_PROFIT_PCT = 0.30;
export const PREFERRED_MIN_NET_PROFIT_PCT = 0.50;
export const FUNDING_INTERVAL_HOURS = 8;

// Decide MAKER vs TAKER vs NO_TRADE for the entry: prefer maker
// (limit) fills when the setup allows waiting for one without missing
// the move; fall back to taker when the market is moving fast enough
// that waiting risks losing the edge entirely.
export function decideExecution({ setupType, volExpansionRatio }){
  const fastMover = (volExpansionRatio || 1) > 1.8 || setupType === 'Liquidity Sweep Reversal';
  if(fastMover) return 'TAKER';
  return 'MAKER';
}

export function estimateCosts({
  exchange, execution, grossTargetPct, spreadPct, slippagePct,
  fundingRatePct, holdMinutes, feeConfig,
}){
  const fees = (feeConfig || DEFAULT_FEE_CONFIG)[exchange] || DEFAULT_FEE_CONFIG.binance;
  const entryFeePct = execution === 'MAKER' ? fees.makerPct : fees.takerPct;
  const exitFeePct = fees.takerPct; // exits (SL/TP) conservatively assumed taker unless stated otherwise
  const spreadCostPct = spreadPct;
  const slippageCostPct = slippagePct;

  const fundingPeriods = Math.max(0, holdMinutes) / (FUNDING_INTERVAL_HOURS * 60);
  const fundingCostPct = Math.abs(fundingRatePct) * fundingPeriods;

  const totalCostPct = entryFeePct + exitFeePct + spreadCostPct + slippageCostPct + fundingCostPct;
  const netTargetPct = grossTargetPct - totalCostPct;

  return {
    entryFeePct, exitFeePct, spreadCostPct, slippageCostPct, fundingCostPct,
    totalCostPct, grossTargetPct, netTargetPct,
  };
}

// =============================================================
// Fixed partial take-profit structure, used everywhere a trade's exits
// get built (Paper mode's managePositions in engine.js, and the real
// order legs placed for Live/Demo — see futures-ui.js/server.js):
//   TP1 @ 1.0R  — closes 30% of the position
//   TP2 @ 1.5R  — closes another 30%
//   TP3 @ 2.25R — closes the remaining 40%
// "R" is always THIS trade's own initial stop-loss distance
// (stopDistancePct, computed the same way it always was — this module
// never touches how the stop itself is calculated), never a flat %, so
// every trade's exits scale to its own risk. Fractions sum to 1.0.
// =============================================================
export const TP_LEVELS = [
  { id: 'tp1', rMultiple: 1.0, closeFraction: 0.30 },
  { id: 'tp2', rMultiple: 1.5, closeFraction: 0.30 },
  { id: 'tp3', rMultiple: 2.25, closeFraction: 0.40 },
];

// Extra headroom above the exact fee-break-even point so a "profitable"
// exit is a genuine, comfortable net profit rather than a knife-edge
// zero that a fraction of a tick could flip negative.
const FEE_SAFETY_MARGIN = 1.05;

// The round-trip % move a price move must clear for ANY slice of the
// position to be a genuine net profit once fees + spread + slippage are
// paid. This is fraction-independent — fees/spread/slippage are all %
// of price move, so the threshold a price has to clear is the same
// whether 30% or 100% of the position is closing there.
export function minProfitableMovePct({ entryFeePct, exitFeePct, spreadPct, slippagePct }){
  return (entryFeePct || 0) + (exitFeePct || 0) + (spreadPct || 0) + (slippagePct || 0);
}

// Builds the 3 TP price levels from the stop distance (1R). TP1 is
// bumped out past its raw 1.0R distance whenever that distance alone
// wouldn't clear real round-trip costs with the safety margin above —
// this is what guarantees requirement #3 (TP1 must never be a level
// where closing 30% nets a loss after fees). TP2/TP3 are then kept
// strictly beyond whatever TP1 ended up at (preserving increasing
// levels) rather than left sitting at their own un-bumped 1.5R/2.25R,
// which could otherwise land behind a bumped TP1 on a very tight stop.
export function buildTpLevels({ entry, direction, stopDistancePct, entryFeePct, exitFeePct, spreadPct, slippagePct }){
  const sign = direction === 'LONG' ? 1 : -1;
  const minTp1Pct = minProfitableMovePct({ entryFeePct, exitFeePct, spreadPct, slippagePct }) * FEE_SAFETY_MARGIN;

  let prevPct = 0;
  return TP_LEVELS.map((lvl, i) => {
    let pct = stopDistancePct * lvl.rMultiple;
    if(i === 0) pct = Math.max(pct, minTp1Pct);
    else pct = Math.max(pct, prevPct + stopDistancePct * 0.1); // stay strictly increasing even after a TP1 bump
    prevPct = pct;
    return { ...lvl, pct, price: entry * (1 + sign * pct / 100) };
  });
}

// Fee-adjusted breakeven for the 40% left after TP2 (requirement #6/#7):
// the price at which closing what remains nets to (at worst) a genuine
// small non-loss after ITS OWN round-trip fees/slippage — not the raw
// entry price, which would still be a net loss once fees are paid.
export function feeAdjustedBreakevenPrice({ entry, direction, entryFeePct, exitFeePct, spreadPct, slippagePct }){
  const sign = direction === 'LONG' ? 1 : -1;
  const pct = minProfitableMovePct({ entryFeePct, exitFeePct, spreadPct, slippagePct }) * FEE_SAFETY_MARGIN;
  return entry * (1 + sign * pct / 100);
}
