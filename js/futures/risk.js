// =============================================================
// risk.js — position sizing derived from equity/entry/stop (never a
// fixed dollar amount), liquidation-distance safety checks, and the
// daily risk-control counters (max daily loss, consecutive losses).
// =============================================================

export const RISK_DEFAULTS = {
  riskPctPerTrade: 1.0,        // default risk per trade, as a % of simulation equity
  maxRiskPctPerTrade: 2.0,
  maxSimultaneousPositions: 3,
  maxPortfolioRiskPct: 3.0,    // scales with riskPctPerTrade so 3 positions at the default 1% still fit
  defaultLeverage: 2,
  maxLeverage: 3,
  maintenanceMarginRate: 0.5,  // % — rough cross-margin estimate for liquidation distance
  maxDailyLossPct: 2.0,
  maxConsecutiveLosses: 3,
  coolingOffMinutes: 60,
};

// Position size from account equity + stop distance — NOT a fixed dollar amount.
export function positionSize({ equity, riskPct, entryPrice, stopPrice, leverage }){
  const stopDistancePct = Math.abs((entryPrice - stopPrice) / entryPrice);
  if(stopDistancePct <= 0) return null;
  const riskAmountUsd = equity * (riskPct / 100);
  const notionalUsd = riskAmountUsd / stopDistancePct;
  const qty = notionalUsd / entryPrice;
  const marginRequiredUsd = notionalUsd / Math.max(1, leverage);
  return { riskAmountUsd, notionalUsd, qty, marginRequiredUsd, stopDistancePct: stopDistancePct * 100 };
}

// Rough liquidation price for an isolated-style position at given leverage.
export function estimateLiquidationPrice({ entryPrice, leverage, side, maintenanceMarginRate }){
  const mmr = (maintenanceMarginRate ?? RISK_DEFAULTS.maintenanceMarginRate) / 100;
  const initialMarginRate = 1 / leverage;
  const distance = entryPrice * (initialMarginRate - mmr);
  return side === 'LONG' ? entryPrice - distance : entryPrice + distance;
}

// Reject the trade if the liquidation price sits too close to (or beyond)
// the stop-loss / invalidation level — the stop must always be hit first.
export function checkLiquidationSafety({ entryPrice, stopPrice, side, leverage, maintenanceMarginRate }){
  const liqPrice = estimateLiquidationPrice({ entryPrice, leverage, side, maintenanceMarginRate });
  const stopDist = Math.abs(entryPrice - stopPrice);
  const liqDist = Math.abs(entryPrice - liqPrice);
  const bufferRatio = stopDist > 0 ? liqDist / stopDist : 0;
  // Require the liquidation price to be meaningfully farther away than the stop.
  const safe = (side === 'LONG' ? liqPrice < stopPrice : liqPrice > stopPrice) && bufferRatio >= 1.5;
  return { safe, liqPrice, bufferRatio };
}

// Daily risk-control gate: consecutive losses, daily loss cap, cooling-off window.
export function checkDailyRiskControls(dayState){
  const reasons = [];
  if(dayState.dailyPnlPct <= -RISK_DEFAULTS.maxDailyLossPct){
    reasons.push(`Daily loss limit reached (${dayState.dailyPnlPct.toFixed(2)}% <= -${RISK_DEFAULTS.maxDailyLossPct}%) — trading stopped for the day`);
  }
  if(dayState.consecutiveLosses >= RISK_DEFAULTS.maxConsecutiveLosses){
    const cooldownUntil = dayState.lastLossAt ? dayState.lastLossAt + RISK_DEFAULTS.coolingOffMinutes * 60_000 : 0;
    if(Date.now() < cooldownUntil){
      reasons.push(`${dayState.consecutiveLosses} consecutive losses — cooling off until ${new Date(cooldownUntil).toLocaleTimeString()}`);
    }
  }
  if(dayState.openPositions >= RISK_DEFAULTS.maxSimultaneousPositions){
    reasons.push(`Max simultaneous positions (${RISK_DEFAULTS.maxSimultaneousPositions}) already open`);
  }
  if(dayState.openRiskPct >= RISK_DEFAULTS.maxPortfolioRiskPct){
    reasons.push(`Max portfolio risk (${RISK_DEFAULTS.maxPortfolioRiskPct}%) already committed`);
  }
  return { allowed: reasons.length === 0, reasons };
}
