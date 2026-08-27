// =============================================================
// regime.js — classifies current market state into one of the 8
// regimes the spec calls for, with a 0-100 confidence. Pure
// function of candle data; no side effects.
// =============================================================
import { ema, atr, closes, pctChange, clamp } from './indicators.js';

export const REGIMES = {
  STRONG_BULL: 'Strong Bull Trend',
  WEAK_BULL: 'Weak Bull Trend',
  STRONG_BEAR: 'Strong Bear Trend',
  WEAK_BEAR: 'Weak Bear Trend',
  RANGE: 'Range',
  HIGH_VOL: 'High Volatility',
  LOW_VOL: 'Low Volatility',
  CHAOTIC: 'Chaotic / Uncertain',
};

// classifyRegime uses H1 for direction/strength and M15 for the
// volatility read (ATR relative to its own recent history), since
// intraday scalp risk sizing cares about the finer timeframe's chop.
export function classifyRegime(h1Candles, m15Candles){
  if(h1Candles.length < 30 || m15Candles.length < 30){
    return { regime: REGIMES.CHAOTIC, label: REGIMES.CHAOTIC, confidence: 30, notes: ['Insufficient history'] };
  }

  const c1h = closes(h1Candles);
  const ema20 = ema(c1h, 20);
  const ema50 = ema(c1h, 50 <= c1h.length ? 50 : Math.floor(c1h.length / 2));
  const last = c1h[c1h.length - 1];
  const trendPct = pctChange(ema50, ema20); // EMA20 vs EMA50 spread = trend strength proxy
  const slopePct = pctChange(c1h[c1h.length - 8] || c1h[0], last); // ~8h price change

  const atr15 = atr(m15Candles, 14);
  const atrSeries15 = [];
  for(let i = 20; i <= m15Candles.length; i++) {
    const a = atr(m15Candles.slice(0, i), 14);
    if(a) atrSeries15.push(a);
  }
  const avgAtr = atrSeries15.length ? atrSeries15.reduce((a,b)=>a+b,0) / atrSeries15.length : atr15;
  const volRatio = avgAtr ? atr15 / avgAtr : 1; // >1 = choppier than usual right now

  const notes = [];
  let regime, confidence;

  // Chaotic: volatility spiking hard with no clean directional read.
  if(volRatio > 1.9 && Math.abs(trendPct) < 0.4){
    regime = REGIMES.CHAOTIC;
    confidence = clamp(55 + (volRatio - 1.9) * 15, 55, 90);
    notes.push(`ATR ${volRatio.toFixed(2)}x normal with no clear direction`);
  } else if(volRatio > 1.6){
    regime = REGIMES.HIGH_VOL;
    confidence = clamp(55 + (volRatio - 1.6) * 20, 55, 92);
    notes.push(`M15 ATR running ${volRatio.toFixed(2)}x its recent average`);
  } else if(volRatio < 0.55){
    regime = REGIMES.LOW_VOL;
    confidence = clamp(55 + (0.55 - volRatio) * 60, 55, 92);
    notes.push(`M15 ATR compressed to ${volRatio.toFixed(2)}x its recent average`);
  } else if(Math.abs(trendPct) < 0.15 && Math.abs(slopePct) < 0.6){
    regime = REGIMES.RANGE;
    confidence = clamp(60 + (0.6 - Math.abs(slopePct)) * 30, 55, 90);
    notes.push(`8h move only ${slopePct.toFixed(2)}%, EMA20/50 nearly flat`);
  } else if(trendPct >= 0.15){
    const strong = trendPct > 0.6 && slopePct > 1.2;
    regime = strong ? REGIMES.STRONG_BULL : REGIMES.WEAK_BULL;
    confidence = clamp(55 + Math.min(35, Math.abs(trendPct) * 25), 55, 92);
    notes.push(`EMA20 ${trendPct.toFixed(2)}% above EMA50, 8h move ${slopePct.toFixed(2)}%`);
  } else {
    const strong = trendPct < -0.6 && slopePct < -1.2;
    regime = strong ? REGIMES.STRONG_BEAR : REGIMES.WEAK_BEAR;
    confidence = clamp(55 + Math.min(35, Math.abs(trendPct) * 25), 55, 92);
    notes.push(`EMA20 ${trendPct.toFixed(2)}% below EMA50, 8h move ${slopePct.toFixed(2)}%`);
  }

  return { regime, label: regime, confidence: Math.round(confidence), volRatio, trendPct, slopePct, notes };
}
