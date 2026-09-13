// =============================================================
// noTradeEngine.js — actively looks for reasons NOT to trade. This
// runs after scoring/setup/risk have all produced their numbers,
// and is the final gate before a signal becomes an "APPROVED"
// opportunity. Any single reason is enough to reject.
// =============================================================
import { REGIMES } from './regime.js';
import { RISK_DEFAULTS, maxPortfolioRiskPct } from './risk.js';

// How long a symbol stays off-limits after ANY close on it (TP, SL,
// time-stop, or a manual close done directly on the exchange) — per an
// explicit request: closing out of a pair shouldn't let the bot
// immediately re-enter that SAME pair on the next qualifying signal,
// while every other pair stays tradeable right away. dayState's own
// cooldownUntilBySymbol map (set by closeTrade in engine.js for Paper,
// and by runLiveCycle's close-detection in futures-ui.js for Live/Demo)
// is what this checks against.
export const SYMBOL_COOLDOWN_MINUTES = 30;

export function evaluateNoTradeFilters({
  snap, regime, confidence, minConfidence, netTargetPct, minNetProfitPct,
  riskRewardRatio, minRiskReward, liquidationSafety, dayState, btcShock, isAltcoin,
  fundingCostPct, grossTargetPct, nowMs, riskPctPerTrade, feeToStopRatioPct,
}){
  const reasons = [];
  const portfolioCapPct = maxPortfolioRiskPct(riskPctPerTrade);
  const now = nowMs ?? Date.now();

  const cooldownUntil = dayState && dayState.cooldownUntilBySymbol && dayState.cooldownUntilBySymbol[snap.symbol];
  if(cooldownUntil && now < cooldownUntil){
    const remainingMin = Math.ceil((cooldownUntil - now) / 60_000);
    reasons.push(`${snap.symbol} closed recently — ${remainingMin}min left of its ${SYMBOL_COOLDOWN_MINUTES}min cooldown before re-entry`);
  }

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
  // making every LOSS disproportionately fee-heavy). Cap tightened
  // 35% -> 25% after a real measured run (6 single-strategy 30-day/5m
  // backtests) showed every strategy still losing money to fees even
  // with the stop floors just raised in engine.js's buildLevels — fee $
  // per trade is proportional to (fee% / stopDistancePct) x riskAmount
  // (see risk.js positionSize's notional math), so this ratio isn't just
  // a loss-side sanity check, it's a direct cap on how much of every
  // dollar risked can be eaten by fees before a trade is even taken.
  if(feeToStopRatioPct != null && feeToStopRatioPct > 25) reasons.push(`Round-trip fees are ${feeToStopRatioPct.toFixed(0)}% of the stop distance (cap 25%) — too fee-heavy relative to risk`);

  if(dayState){
    // dayState.maxDailyLossPct is a per-session, user-set override (see
    // js/futures-ui.js's initLiveMaxDailyLossInput, capped at 50%) —
    // falls back to the fixed RISK_DEFAULTS value for Paper mode dayState
    // objects, which don't set it.
    const maxDailyLossPct = dayState.maxDailyLossPct != null ? dayState.maxDailyLossPct : RISK_DEFAULTS.maxDailyLossPct;
    if(dayState.dailyPnlPct <= -maxDailyLossPct) reasons.push(`Daily drawdown limit reached (-${maxDailyLossPct}%) — trading stopped for the day`);
    // Symmetric to the loss cap above, per an explicit request: stop for
    // the day once a genuine profit target is banked, not just once a
    // loss limit is hit. Resets the same way the loss cap does — at the
    // next Reset Session / new day, not by any manual re-arm ritual.
    // dayState.dailyProfitTargetPct is a per-session, user-set override
    // (see js/futures-ui.js's initLiveDailyProfitTargetInput, capped at
    // 50%) — falls back to the fixed RISK_DEFAULTS value for Paper mode
    // dayState objects, which don't set it.
    const profitTargetPct = dayState.dailyProfitTargetPct != null ? dayState.dailyProfitTargetPct : RISK_DEFAULTS.dailyProfitTargetPct;
    if(dayState.dailyPnlPct >= profitTargetPct) reasons.push(`Daily profit target (+${profitTargetPct}%) reached — trading stopped for the day`);
    // NOTE: there is deliberately no "N consecutive losses → cool off /
    // stop" filter here anymore. This bot is meant to run continuously —
    // 24/7 — and only stop when the user clicks Stop Live/Demo Trading
    // (or the daily loss/profit limits just above are hit); a losing
    // streak on its own should never pause or halt it. See
    // js/futures-ui.js's checkAdaptiveCircuitBreaker for the equivalent
    // removal on the Live/Demo side (it still tightens confidence after
    // losses — pickier, not stopped) and RISK_DEFAULTS.maxConsecutiveLosses/
    // coolingOffMinutes (risk.js), which are now unused by this function
    // and kept only for anything else that might still reference them.
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
