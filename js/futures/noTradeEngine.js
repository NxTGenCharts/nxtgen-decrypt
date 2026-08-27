// =============================================================
// noTradeEngine.js — actively looks for reasons NOT to trade. This
// runs after scoring/setup/risk have all produced their numbers,
// and is the final gate before a signal becomes an "APPROVED"
// opportunity. Any single reason is enough to reject.
// =============================================================
import { REGIMES } from './regime.js';
import { RISK_DEFAULTS } from './risk.js';

export function evaluateNoTradeFilters({
  snap, regime, confidence, minConfidence, netTargetPct, minNetProfitPct,
  riskRewardRatio, minRiskReward, liquidationSafety, dayState, btcShock, isAltcoin,
  fundingCostPct, grossTargetPct, nowMs,
}){
  const reasons = [];

  if(snap.meta.spreadPct > 0.08) reasons.push(`Spread too wide (${snap.meta.spreadPct.toFixed(3)}%)`);
  if(snap.meta.liquidityScore < 35) reasons.push(`Liquidity too low (score ${snap.meta.liquidityScore})`);
  if(regime.regime === REGIMES.CHAOTIC) reasons.push('Market regime is Chaotic/Uncertain');
  if(confidence < minConfidence) reasons.push(`Confidence ${confidence} below required ${minConfidence}`);
  if(netTargetPct < minNetProfitPct) reasons.push(`Expected net return ${netTargetPct.toFixed(2)}% below minimum ${minNetProfitPct}%`);
  if(riskRewardRatio < minRiskReward) reasons.push(`Risk/reward ${riskRewardRatio.toFixed(2)} below minimum ${minRiskReward}`);
  if(liquidationSafety && !liquidationSafety.safe) reasons.push('Liquidation price too close to stop-loss for chosen leverage');
  if(fundingCostPct > Math.abs(grossTargetPct) * 0.35) reasons.push(`Funding cost eats too much of the expected move`);
  if(isAltcoin && btcShock && btcShock.shocked) reasons.push(`BTC shock detected (${btcShock.movePct.toFixed(2)}% in the last hour) — altcoin entries paused`);

  if(dayState){
    if(dayState.dailyPnlPct <= -RISK_DEFAULTS.maxDailyLossPct) reasons.push('Daily drawdown limit reached — trading stopped for the day');
    if(dayState.consecutiveLosses >= RISK_DEFAULTS.maxConsecutiveLosses){
      const cooldownUntil = (dayState.lastLossAt || 0) + RISK_DEFAULTS.coolingOffMinutes * 60_000;
      if((nowMs ?? Date.now()) < cooldownUntil){
        reasons.push(`${dayState.consecutiveLosses} consecutive losses — cooling off for ${RISK_DEFAULTS.coolingOffMinutes}min`);
      }
    }
    if(dayState.openPositions >= RISK_DEFAULTS.maxSimultaneousPositions) reasons.push('Max simultaneous positions already open');
    if(dayState.openRiskPct >= RISK_DEFAULTS.maxPortfolioRiskPct) reasons.push('Max portfolio risk already committed');
  }

  return { allowed: reasons.length === 0, reasons };
}
