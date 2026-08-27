// =============================================================
// costs.js — turns a gross price target into a realistic net
// target by subtracting entry+exit fees, spread, slippage, and
// any funding expected to accrue over the holding period. Every
// number here is a percentage of notional unless labeled otherwise.
// =============================================================

export const DEFAULT_FEE_CONFIG = {
  binance: { makerPct: 0.02, takerPct: 0.05 },
  bybit:   { makerPct: 0.02, takerPct: 0.055 },
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
