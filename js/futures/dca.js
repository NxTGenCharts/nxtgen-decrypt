// =============================================================
// dca.js — Trading Bots' DCA bot type.
//
// Classic base-order + safety-order-ladder DCA (the same shape Bybit's
// own DCA bot, 3commas, and most others use): one base order at market,
// then N pre-placed resting safety orders at growing price deviations
// below (LONG) or above (SHORT) the base entry, each optionally sized
// bigger than the last (volumeScale). Every fill (base or safety) grows
// the position and shifts its average entry, so the take-profit price
// is recalculated and re-set after each one — always TP off the CURRENT
// blended average, never the base order's own entry alone.
//
// This is a genuinely different lifecycle from grid.js's NxTGen Grid:
// a grid deployment cycles the SAME levels open/closed/re-armed
// indefinitely; a DCA deployment is one-shot per direction — it ends
// (all safety orders cancelled, position flat) the moment TP fills, a
// hard stop-loss fills, or the user manually closes it. There is
// deliberately no Paper/backtest path here yet — this only runs as a
// user-created Trading Bots deployment against real Live/Demo order
// placement (see futures-ui.js's manageDcaBotOrders), matching what was
// actually asked for; a synthetic-feed simulation can be added later
// the same way grid.js's stepGridSymbol was, without changing this
// plan-building math at all.
// =============================================================

export const DCA_STRATEGY = {
  id: 'dcaBot',
  type: 'DCA Bot',
  label: 'DCA Bot',
  description: 'Base order + a laddered set of safety orders that average down (or up, for Short) into one position, with a single take-profit off the blended average entry. User-created and user-sized per deployment — not an auto-scanning strategy like the other seven.',
};

export const DCA_DEFAULTS = {
  baseOrderUsd: 50,        // opened at market the moment the bot is created
  safetyOrderUsd: 50,      // USD size of the FIRST safety order; each subsequent one scales by volumeScale
  maxSafetyOrders: 5,      // 0-10
  priceDeviationPct: 1.5,  // % move from the base entry that triggers the FIRST safety order
  stepScale: 1.05,         // each subsequent safety order's OWN deviation (from the prior one) grows by this factor
  volumeScale: 1.5,        // each subsequent safety order's size grows by this factor
  takeProfitPct: 1.2,      // % above (LONG) / below (SHORT) the blended average entry
  stopLossPct: null,       // optional hard stop, % below (LONG) / above (SHORT) the average — null = no hard stop, just the safety ladder running out
  leverage: 3,
};

// -------------------------------------------------------------
// Builds the full order ladder up front, off an anchor price (the
// current market price at bot-creation time — the base order's INTENDED
// price; its real fill price, once known, is what TP/avg math actually
// uses from then on, this is only for laying out where the resting
// safety orders go). Returns null on invalid input rather than throwing
// — same convention as buildGridPlan/buildManualGridPlan.
// -------------------------------------------------------------
export function buildDcaPlan({ symbol, direction, anchorPrice, cfg }){
  const c = { ...DCA_DEFAULTS, ...cfg };
  if(!(anchorPrice > 0) || !(c.baseOrderUsd > 0) || c.maxSafetyOrders < 0 || !(c.leverage > 0)){
    return null;
  }
  const sign = direction === 'LONG' ? -1 : 1; // safety orders sit BELOW anchor for Long, ABOVE for Short
  const safetyLevels = [];
  let cumulativeDeviationPct = 0;
  let stepDeviationPct = c.priceDeviationPct;
  let sizeUsd = c.safetyOrderUsd;
  for(let i = 0; i < c.maxSafetyOrders; i++){
    cumulativeDeviationPct += stepDeviationPct;
    const price = anchorPrice * (1 + (sign * cumulativeDeviationPct) / 100);
    safetyLevels.push({ index: i, deviationPct: cumulativeDeviationPct, price, sizeUsd });
    stepDeviationPct *= c.stepScale;
    sizeUsd *= c.volumeScale;
  }
  const totalInvestmentUsd = c.baseOrderUsd + safetyLevels.reduce((a, l) => a + l.sizeUsd, 0);
  return {
    symbol, direction, leverage: c.leverage,
    baseOrderUsd: c.baseOrderUsd, safetyLevels, totalInvestmentUsd,
    takeProfitPct: c.takeProfitPct, stopLossPct: c.stopLossPct,
    anchorPrice,
  };
}

// -------------------------------------------------------------
// Recomputes TP (and, if configured, the hard stop) off a CURRENT
// average entry + total position size — called after the base order
// fills and again after every safety order fill, since each one shifts
// the average. Returns absolute prices, not percentages, ready to send
// straight to setBybitDcaTakeProfit/setBinanceDcaTakeProfit.
// -------------------------------------------------------------
export function computeDcaExitPrices({ direction, avgEntryPrice, takeProfitPct, stopLossPct }){
  const tpSign = direction === 'LONG' ? 1 : -1;
  const takeProfitPrice = avgEntryPrice * (1 + (tpSign * takeProfitPct) / 100);
  const stopLossPrice = stopLossPct != null ? avgEntryPrice * (1 - (tpSign * stopLossPct) / 100) : null;
  return { takeProfitPrice, stopLossPrice };
}
