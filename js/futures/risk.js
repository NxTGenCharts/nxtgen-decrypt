// =============================================================
// risk.js — position sizing derived from equity/entry/stop (never a
// fixed dollar amount), liquidation-distance safety checks, and the
// daily risk-control counters (max daily loss, consecutive losses).
// =============================================================

export const RISK_DEFAULTS = {
  riskPctPerTrade: 1.0,        // default risk per trade, as a % of equity — STRICT: this is the max $ lost on
                                // a losing trade (position size is derived backwards from this + the stop
                                // distance, never a fixed dollar amount), adjustable via the "Risk per trade
                                // (%)" field up to maxRiskPctPerTrade below.
  maxRiskPctPerTrade: 50.0,    // user-adjustable ceiling — the "Risk per trade (%)" field accepts 1-50% of
                                // whichever exchange's futures-account equity is selected, so the user can
                                // size as conservatively or aggressively as they choose. positionSize() below
                                // is unchanged either way: size is always derived from equity x riskPct and
                                // the stop distance, never a fixed dollar amount, and is still capped by real
                                // available margin (see maxNotionalByMargin).
  maxSimultaneousPositions: 3,
  defaultLeverage: 5,
  maxLeverage: 10,
  maintenanceMarginRate: 0.5,  // % — rough cross-margin estimate for liquidation distance
  maxDailyLossPct: 2.0,
  maxConsecutiveLosses: 3,
  coolingOffMinutes: 60,
  // Every trade is now constructed so its take-profit sits at least this
  // multiple of its stop-loss distance away (see engine.js's
  // enforceRewardRiskFloor) — a 1% loss targets a 1.2% (=1% x 1.2) gain.
  // At this ratio the strategy is profitable at any win rate above
  // ~45.5% (1/(1+1.2)), instead of needing a high win rate to offset
  // small wins against large losses. Adjustable via the "Min risk/reward"
  // field, which now drives BOTH the approval floor and the actual
  // target construction for every setup — previously the scalp setups
  // built deliberately small targets against wide stops and only the
  // trend/breakout setup honored this field at all.
  riskRewardRatio: 1.2,
};

// Total risk allowed open across all simultaneous positions at once. This
// is derived from whatever "Risk per trade (%)" is actually set to,
// rather than a fixed number — a fixed 3% cap (sized for the old 1%
// default x 3 positions) would silently block trading altogether once a
// user raised risk-per-trade past ~1%, since a single position's risk
// could already exceed the fixed cap on its own. Always leaves room for
// maxSimultaneousPositions positions at the user's chosen per-trade risk.
export function maxPortfolioRiskPct(riskPctPerTrade){
  return (riskPctPerTrade || RISK_DEFAULTS.riskPctPerTrade) * RISK_DEFAULTS.maxSimultaneousPositions;
}

// Position size from account equity + stop distance — NOT a fixed dollar amount.
export function positionSize({ equity, riskPct, entryPrice, stopPrice, leverage, maxMarginUtilizationPct }){
  const stopDistancePct = Math.abs((entryPrice - stopPrice) / entryPrice);
  if(stopDistancePct <= 0) return null;
  const riskAmountUsd = equity * (riskPct / 100);
  const riskBasedNotionalUsd = riskAmountUsd / stopDistancePct;

  // A real exchange caps notional by available margin, not just by how
  // much you're willing to lose on the trade — you cannot actually open a
  // position whose required margin (notional / leverage) exceeds what the
  // account has. A tight stop otherwise produces a number that's
  // "correct" in pure risk-% terms but not achievable in practice: e.g. a
  // 0.15% stop at 1% risk on $10,000 equity implies $66,667 of notional,
  // which needs $33,333 of margin at 2x leverage — more than triple the
  // whole account. Every real exchange would reject that outright as
  // insufficient margin. Cap notional at what leverage x equity can
  // actually support (with a utilization buffer so one position doesn't
  // try to consume literally all available margin, leaving room for the
  // other simultaneous positions this engine allows), and let the ACTUAL
  // dollar amount at risk fall below the nominal target on trades where
  // the stop is this tight — that's what a real leveraged account does
  // too, not something to paper over by pretending the bigger, unaffordable
  // position was actually opened. This also directly fixes fees/funding
  // looking disproportionately large relative to the stated risk: both are
  // charged on notional, and notional was the thing inflating unchecked.
  const utilization = maxMarginUtilizationPct ?? 0.9;
  const maxNotionalByMargin = equity * leverage * utilization;
  const notionalUsd = Math.min(riskBasedNotionalUsd, maxNotionalByMargin);
  const marginCapped = notionalUsd < riskBasedNotionalUsd;

  const qty = notionalUsd / entryPrice;
  const marginRequiredUsd = notionalUsd / Math.max(1, leverage);
  // The dollar amount actually at risk given the (possibly capped)
  // notional — this is what feeds the daily risk-control gate below, not
  // the nominal target, since the nominal figure may not reflect a
  // position that could actually be opened.
  const actualRiskUsd = notionalUsd * stopDistancePct;
  return {
    riskAmountUsd: actualRiskUsd, nominalRiskAmountUsd: riskAmountUsd,
    notionalUsd, qty, marginRequiredUsd, marginCapped,
    stopDistancePct: stopDistancePct * 100,
  };
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
export function checkDailyRiskControls(dayState, riskPctPerTrade){
  const reasons = [];
  const portfolioCapPct = maxPortfolioRiskPct(riskPctPerTrade);
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
  if(dayState.openRiskPct >= portfolioCapPct){
    reasons.push(`Max portfolio risk (${portfolioCapPct}%) already committed`);
  }
  return { allowed: reasons.length === 0, reasons };
}
