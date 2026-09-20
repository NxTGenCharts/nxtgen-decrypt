// =============================================================
// quant/regime.js — the 9-state market regime engine for NxTGen Quant
// Futures.
//
// This is deliberately separate from js/futures/regime.js (8 states, used
// by every other strategy and by the shared no-trade gate). Nothing there
// is changed. Higher timeframes (1H + 4H) decide the trend/range read; the
// entry timeframe decides the volatility state. The result drives WHICH
// setups may fire, how much extra confidence is demanded, and how much
// risk is scaled — that is the "adapts to the regime" behaviour:
//
//   trend            -> pullbacks (A) and breakout/retest (B); with-trend sweeps (C)
//   range            -> sweep reversals (C) and range extremes (D); B only on expansion
//   high volatility  -> A/B/C only, +5 required confidence, risk x0.6, no mean reversion
//   low vol / squeeze-> "no trade" unless a breakout-retest (B) is developing
//   expansion        -> B only
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
  // Range-bound behaviour overrides the EMA read: price sitting at the LOW of a range naturally has
  // EMA20 < EMA50 and price below both, which would look "bearish" — but low efficiency + low ADX + a
  // flat slow EMA is what actually defines a range, and that's what range setups need to see.
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
  // Expansion = a squeeze that resolved: ATR sat well below its normal-to-active level (p75) 6-20 bars ago,
  // Bollinger width has widened >=25% since, and price closed outside the prior 20-bar range on above-average volume.
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

  const isTrend = t.bias !== 0;
  const allowed = { A: false, B: false, C: false, D: false };
  let confBoost = 0, riskMult = 1;

  if(volState === 'normal'){
    if(isTrend){ allowed.A = true; allowed.B = true; allowed.C = true; }
    else { allowed.C = true; allowed.D = true; }
  } else if(volState === 'high'){
    // Hostile to mean reversion; trade only what the trend supports, pickier and smaller.
    // Sweeps (C) stay eligible: a stop-run is itself a volatility spike, so banning C here would ban it exactly when it happens.
    if(isTrend){ allowed.A = true; allowed.B = true; allowed.C = true; } else { allowed.B = true; allowed.C = true; }
    confBoost = 5; riskMult = 0.6;
    notes.push(`Volatility high (ATR ${(feat.atrPctile * 100).toFixed(0)}th percentile) — confidence requirement +5, risk x0.6, no range fades (D)`);
  } else if(volState === 'expansion'){
    allowed.B = true;
    notes.push('Volatility expansion after a squeeze — only breakout+retest is eligible');
  } else {
    // low / compression: "no trade" unless an expansion setup is developing (B needs a real breakout)
    allowed.B = true;
    notes.push(`${volState === 'compression' ? 'Compression (squeeze)' : 'Low volatility'} — dead/choppy tape: only a developing breakout+retest is eligible`);
  }

  return {
    label, trendLabel: t.label, bias: t.bias, trendStrength: t.strength,
    volState, allowed, confBoost, riskMult, notes,
  };
}
