// =============================================================
// scoring.js — weighted multi-factor scoring. Every factor is
// scored 0-100 independently, then combined via configurable
// weights into one overall confidence score. Not every factor has
// to agree (see DEFAULT_WEIGHTS) — this is a weighted model, not
// a unanimous-vote gate.
// =============================================================
import { ema, atr, rsi, closes, clamp } from './indicators.js';
import { REGIMES } from './regime.js';

export const DEFAULT_WEIGHTS = {
  trend: 15,
  structure: 15,
  momentum: 10,
  volume: 10,
  volatility: 10,
  orderFlow: 10,
  supportResistance: 10,
  htfConfirmation: 10,
  liquidityExecution: 5,
  marketRegime: 5,
};

function trendScore(snap, setupSignal){
  const c1h = closes(snap.h1);
  const ema20 = ema(c1h, 20), ema50 = ema(c1h, Math.min(50, c1h.length - 1));
  if(!ema20 || !ema50) return 50;
  const spread = Math.abs((ema20 - ema50) / ema50) * 100;
  let s = clamp(50 + spread * 30, 30, 95);
  if(setupSignal.type === 'Trend Continuation') s = clamp(s + 8, 0, 98);
  return Math.round(s);
}

function structureScore(setupSignal){
  // Setups that are explicitly structure-based (breakout/retest, sweep) score higher here.
  const base = { 'Trend Continuation': 65, 'Breakout + Retest': 82, 'Range Reversal': 70, 'Liquidity Sweep Reversal': 80 };
  return base[setupSignal.type] || 55;
}

function momentumScore(snap, direction){
  const rsiVal = rsi(snap.m15, 14);
  if(rsiVal === null) return 50;
  if(direction === 'LONG') return Math.round(clamp(40 + (rsiVal - 40) * 1.1, 20, 92));
  return Math.round(clamp(40 + (60 - rsiVal) * 1.1, 20, 92));
}

function volumeScore(setupSignal){
  const m = /([0-9.]+)x average/i.exec((setupSignal.reasons || []).join(' '));
  if(!m) return 55;
  const ratio = parseFloat(m[1]);
  return Math.round(clamp(40 + (ratio - 1) * 35, 25, 95));
}

function volatilityScore(regime){
  if(regime.regime === REGIMES.CHAOTIC) return 10;
  if(regime.regime === REGIMES.HIGH_VOL) return 35;
  if(regime.regime === REGIMES.LOW_VOL) return 55;
  return 75; // trending or range with normal vol is the sweet spot
}

function orderFlowScore(snap){
  // No real order-book feed yet (mock data has no depth-of-book); use
  // spread tightness as the best available proxy for order-flow quality
  // until Phase 2 wires a live book. Flagged clearly so this isn't
  // mistaken for a real imbalance read.
  const s = clamp(90 - snap.meta.spreadPct * 2500, 20, 90);
  return Math.round(s);
}

function supportResistanceScore(setupSignal){
  if(setupSignal.type === 'Range Reversal' || setupSignal.type === 'Liquidity Sweep Reversal') return 85;
  if(setupSignal.type === 'Breakout + Retest') return 75;
  return 55;
}

function htfConfirmationScore(regime, direction){
  const bull = regime.regime === REGIMES.STRONG_BULL || regime.regime === REGIMES.WEAK_BULL;
  const bear = regime.regime === REGIMES.STRONG_BEAR || regime.regime === REGIMES.WEAK_BEAR;
  if((direction === 'LONG' && bull) || (direction === 'SHORT' && bear)) return regime.regime.startsWith('Strong') ? 92 : 74;
  if(regime.regime === REGIMES.RANGE) return 65; // reversal setups are HTF-neutral by design
  return 35; // countertrend against a trending HTF
}

function liquidityScore(snap){
  return Math.round(snap.meta.liquidityScore);
}

function marketRegimeScore(regime){
  if(regime.regime === REGIMES.CHAOTIC) return 5;
  if(regime.regime === REGIMES.HIGH_VOL) return 40;
  return 80;
}

export function computeFactorScores(snap, regime, setupSignal){
  return {
    trend: trendScore(snap, setupSignal),
    structure: structureScore(setupSignal),
    momentum: momentumScore(snap, setupSignal.direction),
    volume: volumeScore(setupSignal),
    volatility: volatilityScore(regime),
    orderFlow: orderFlowScore(snap),
    supportResistance: supportResistanceScore(setupSignal),
    htfConfirmation: htfConfirmationScore(regime, setupSignal.direction),
    liquidityExecution: liquidityScore(snap),
    marketRegime: marketRegimeScore(regime),
  };
}

export function weightedScore(factorScores, weights){
  const w = weights || DEFAULT_WEIGHTS;
  const totalWeight = Object.values(w).reduce((a, b) => a + b, 0) || 1;
  let sum = 0;
  for(const key of Object.keys(w)) sum += (factorScores[key] ?? 50) * w[key];
  return Math.round(sum / totalWeight);
}
