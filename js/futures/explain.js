// =============================================================
// explain.js — builds the human-readable "AI explanation" for a
// trade decision purely from the fields the engine already
// computed (setup reasons, regime, costs, confidence, R:R). It
// never invents a reason that isn't backed by a real field.
// =============================================================

export function buildExplanation(decision){
  const { symbol, direction, confidence, setup, regime, reasons, netTargetPct, totalCostPct, riskRewardRatio, status, rejectReasons } = decision;
  const lines = [];
  lines.push(`${direction} ${symbol} — Confidence ${confidence}/100.`);
  lines.push('');
  lines.push('Reasons:');
  lines.push(`Regime: ${regime}.`);
  (reasons || []).forEach(r => lines.push(r + '.'));
  lines.push(`Expected net reward/risk ${riskRewardRatio.toFixed(2)}.`);
  lines.push(`Estimated all-in trading cost ${totalCostPct.toFixed(2)}%.`);
  lines.push('');
  if(status === 'APPROVED'){
    lines.push(`Setup: ${setup}. Trade approved.`);
  } else {
    lines.push('Trade rejected:');
    (rejectReasons || []).forEach(r => lines.push('- ' + r));
  }
  return lines.join('\n');
}
