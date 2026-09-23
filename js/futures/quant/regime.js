// =============================================================
// quant/regime.js — the market-regime read for NxTGen HTF OrderFlow.
//
// This is deliberately separate from js/futures/regime.js (8 states, used
// by every other strategy and by the shared no-trade gate). Nothing there
// is changed. 1H + 4H decide the trend read; the 5M entry timeframe decides
// the volatility state.
//
// Unlike the old Quant Futures (four setups, each allowed in different
// regimes), HTF OrderFlow is ONE setup with its own hard trend-alignment
// gate already built into setups.js (Step 1/Step 2 of the spec: 4H and 1H
// must BOTH read the same direction, or it's NO TRADE regardless of regime).
// This module's job is narrower now — implement the spec's separate
// "MARKET REGIME FILTER": avoid low-quality conditions (extremely low
// volatility, chaotic whipsaw/chop, squeeze) even when the trend read is
// technically directional, and scale confidence/risk for high volatility.
// =============================================================

export const QREGIMES = {
  STRONG_BULL: 'Strong Bull Trend',
  WEAK_BULL: 'Weak Bull Trend',
  STRONG_BEAR: 'Strong Bear Trend',
  WEAK_BEAR: 'Weak Bear Trend',
  RANGE: 'Range',
  HIGH_VOL: 'High Volatility',
  LOW_VOL: 'Low Volatility',
  BREAKOUT: 'Breakout/Expansion',
  COMPRESSION: 'Compression',
};

function trendRead(feat){
  const h1 = feat.tfH1, h4 = feat.tfH4;
  const rangeLike = h1.er <= 0.28 && (h1.adx == null || h1.adx < 22) && Math.abs(h1.slopeAtr) < 0.6 && h4.strength < 0.5;
  if(rangeLike) return { label: QREGIMES.RANGE, bias: 0, strength: Math.max(h1.strength, h4.strength) * 0.5 };
  const bull = h1.dir === 1 && h4.dir >= 0 && h1.structure !== 'bear';
  const bear = h1.dir === -1 && h4.dir <= 0 && h1.structure !== 'bull';
  if(bull){
    const strong = h4.dir === 1 && h1.strength >= 0.55 && h4.strength >= 0.35;
    return { label: strong ? QREGIMES.STRONG_BULL : QREGIMES.WEAK_BULL, bias: 1, strength: (h1.strength * 0.6 + h4.strength * 0.4) };
  }
  if(bear){
    const strong = h4.dir === -1 && h1.strength >= 0.55 && h4.strength >= 0.35;
    return { label: strong ? QREGIMES.STRONG_BEAR : QREGIMES.WEAK_BEAR, bias: -1, strength: (h1.strength * 0.6 + h4.strength * 0.4) };
  }
  return { label: QREGIMES.RANGE, bias: 0, strength: Math.max(h1.strength, h4.strength) * 0.5 };
}

function volatilityRead(feat){
  const { atrPctile, atrRatio, atrP75, atrS, bbw, last, donHigh, donLow, vol, i } = feat;
  let preSqueeze = false;
  for(let k = i - 20; k <= i - 6; k++){
    if(atrS[k] != null && atrS[k] <= 0.7 * atrP75){ preSqueeze = true; break; }
  }
  const arr = bbw.arr, n = arr.length;
  const widened = n >= 6 && arr[n - 1] > arr[n - 6] * 1.25;
  const outside = last.c > donHigh || last.c < donLow;
  if(preSqueeze && widened && outside && vol.rel >= 1.3) return 'expansion';
  if(atrPctile >= 0.9 || atrRatio >= 1.8) return 'high';
  if(feat.atr <= 0.6 * atrP75 && bbw.pctile <= 0.35) return 'compression';
  if(atrPctile <= 0.08 || atrRatio <= 0.55) return 'low';
  return 'normal';
}

export function classifyQuantRegime(feat){
  const t = trendRead(feat);
  const volState = volatilityRead(feat);
  const notes = [];
  const h1 = feat.tfH1, h4 = feat.tfH4;
  notes.push(`4H ${h4.dir === 1 ? 'bullish' : h4.dir === -1 ? 'bearish' : 'neutral'} (${h4.structure} structure), 1H ${h1.dir === 1 ? 'bullish' : h1.dir === -1 ? 'bearish' : 'neutral'} (${h1.structure} structure${h1.adx != null ? `, ADX ${h1.adx.toFixed(0)}` : ''})`);

  let label;
  if(volState === 'expansion') label = QREGIMES.BREAKOUT;
  else if(volState === 'high') label = QREGIMES.HIGH_VOL;
  else if(volState === 'compression') label = QREGIMES.COMPRESSION;
  else if(volState === 'low') label = QREGIMES.LOW_VOL;
  else label = t.label;

  // Spec: "MARKET REGIME FILTER — avoid low-quality market conditions such as extremely low volatility,
  // chaotic whipsaw, conflicting HTF structure, excessive spread... If the market regime is unclear: NO TRADE."
  // Low/compression volatility = dead or coiled tape, not the "reaction off an HTF zone" this strategy needs;
  // trend must also be clear (t.bias !== 0) since a Range read already means 4H/1H don't clearly agree.
  let confBoost = 0, riskMult = 1;
  const allowed = { A: t.bias !== 0 && volState !== 'low' && volState !== 'compression' };
  if(volState === 'high'){
    confBoost = 5; riskMult = 0.6;
    notes.push(`Volatility high (ATR ${(feat.atrPctile * 100).toFixed(0)}th percentile) — confidence requirement +5, risk x0.6`);
  } else if(volState === 'expansion'){
    notes.push('Volatility expansion after a squeeze — location/order-block gate still applies in full');
  } else if(volState === 'low' || volState === 'compression'){
    notes.push(`${volState === 'compression' ? 'Compression (squeeze)' : 'Low volatility'} — dead/coiled tape: no trade`);
  } else if(t.bias === 0){
    notes.push('4H/1H structure not clearly aligned in a Range read — no trade');
  }

  return {
    label, trendLabel: t.label, bias: t.bias, trendStrength: t.strength,
    volState, allowed, confBoost, riskMult, notes,
  };
}
