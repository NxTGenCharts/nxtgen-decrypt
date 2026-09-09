// =============================================================
// noTradeEngine.js — actively looks for reasons NOT to trade. This
// runs after scoring/setup/risk have all produced their numbers,
// and is the final gate before a signal becomes an "APPROVED"
// opportunity. Any single reason is enough to reject.
// =============================================================
import { REGIMES } from './regime.js';
import { RISK_DEFAULTS, maxPortfolioRiskPct } from './risk.js';

export function evaluateNoTradeFilters({
  snap, regime, confidence, minConfidence, netTargetPct, minNetProfitPct,
  riskRewardRatio, minRiskReward, liquidationSafety, dayState, btcShock, isAltcoin,
  fundingCostPct, grossTargetPct, nowMs, riskPctPerTrade, feeToStopRatioPct,
}){
  const reasons = [];
  const portfolioCapPct = maxPortfolioRiskPct(riskPctPerTrade);

  if(snap.meta.spreadPct > 0.08) reasons.push(`Spread too wide (${snap.meta.spreadPct.toFixed(3)}%)`);
  if(snap.meta.liquidityScore < 35) reasons.push(`Liquidity too low (score ${snap.meta.liquidityScore})`);
  if(regime.regime === REGIMES.CHAOTIC) reasons.push('Market regime is Chaotic/Uncertain');
  if(confidence < minConfidence) reasons.push(`Confidence ${confidence} below required ${minConfidence}`);
  if(netTargetPct < minNetProfitPct) reasons.push(`Expected net return ${netTargetPct.toFixed(2)}% below minimum ${minNetProfitPct}%`);
  if(riskRewardRatio < minRiskReward) reasons.push(`Risk/reward ${riskRewardRatio.toFixed(2)} below minimum ${minRiskReward}`);
  if(liquidationSafety && !liquidationSafety.safe) reasons.push('Liquidation price too close to stop-loss for chosen leverage');
  if(fundingCostPct > Math.abs(grossTargetPct) * 0.35) reasons.push(`Funding cost eats too much of the expected move`);
  if(isAltcoin && btcShock && btcShock.shocked) reasons.push(`BTC shock detected (${btcShock.movePct.toFixed(2)}% in the last hour) — altcoin entries paused`);
  // A stop that's tight relative to real round-trip fees is the single
  // biggest cause of a strategy that looks fine gross but bleeds net —
  // see README-SCALP.md and the fee-vs-stop postmortem it links. Reject
  // outright rather than let net-of-fee math alone catch it (a thin
  // stop can still clear a modest net-profit floor on the win side while
  // making every LOSS disproportionately fee-heavy).
  if(feeToStopRatioPct != null && feeToStopRatioPct > 35) reasons.push(`Round-trip fees are ${feeToStopRatioPct.toFixed(0)}% of the stop distance (cap 35%) — too fee-heavy relative to risk`);

  if(dayState){
    if(dayState.dailyPnlPct <= -RISK_DEFAULTS.maxDailyLossPct) reasons.push('Daily drawdown limit reached — trading stopped for the day');
    if(dayState.consecutiveLosses >= RISK_DEFAULTS.maxConsecutiveLosses){
      const cooldownUntil = (dayState.lastLossAt || 0) + RISK_DEFAULTS.coolingOffMinutes * 60_000;
      if((nowMs ?? Date.now()) < cooldownUntil){
        reasons.push(`${dayState.consecutiveLosses} consecutive losses — cooling off for ${RISK_DEFAULTS.coolingOffMinutes}min`);
      }
    }
    if(dayState.openPositions >= RISK_DEFAULTS.maxSimultaneousPositions) reasons.push('Max simultaneous positions already open');
    // A count check alone ("fewer than N positions open") never stops a
    // SECOND entry on a symbol that's already open — if maxSimultaneousPositions
    // is 3 and only 1 is open, that count check passes regardless of
    // which symbol the new signal is on, including the one already open.
    // Real Live trading exposed exactly this: the same symbol scanned
    // and approved again a few cycles later, while still open, silently
    // doubling the real position size on the exchange (which nets same-
    // side fills into one bigger position) — the client only tracked the
    // second order's own qty, so its own display showed half of what was
    // really at risk. This is the actual fix, not just a rare edge case.
    if(dayState.positions && dayState.positions.some(p => p.symbol === snap.symbol)){
      reasons.push(`Already have an open position on ${snap.symbol} — not stacking a second one`);
    }
    if(dayState.openRiskPct >= portfolioCapPct) reasons.push(`Max portfolio risk (${portfolioCapPct}%) already committed`);
  }

  return { allowed: reasons.length === 0, reasons };
}
