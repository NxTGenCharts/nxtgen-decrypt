// =============================================================
// quant/signal.js — the Quant Signal Engine.
//
//   snapshot -> features -> regime -> setups (A-D) -> stop -> target
//            -> 8-factor 0-100 score -> confluence gates -> signal
//
// Deterministic and testable end to end: same snapshot in, same signal
// out. No network, no LLM, no randomness. (If the platform's optional AI
// second-opinion is enabled it runs AFTER this, only ever able to veto an
// already-approved signal — see futures-ui.js.)
//
// The result is shaped like every other detector's signal
// ({type, direction, rawConfidence, reasons, meta, vetoes?}) so it flows
// through engine.js's existing ensemble/cost/risk/no-trade pipeline.
// =============================================================
import { QUANT_TYPE, SELECTIVITY, HARD_LIMITS, effectiveMinConfidence } from './config.js';
import { buildFeatures, clamp, mean } from './features.js';
import { classifyQuantRegime } from './regime.js';
import { SETUP_DETECTORS } from './setups.js';
import { swingHighPoints, swingLowPoints } from '../indicators.js';
import { qlog, qlogOnce } from './log.js';

const RR_TIERS = [2, 2.5, 3, 4];
const STOP_BUFFER_ATR = { A: 0.2, B: 0.0, C: 0.15, D: 0.25 }; // B's anchor already carries its own buffer
const MIN_STOP_ATR = 1.2;   // never tighter than 1.2 ATR — inside normal noise
const MAX_STOP_ATR = 3.0;   // wider than this = the structure is too far away = poor entry
const MAX_STOP_ATR_REVERSAL = 3.5; // a sweep reversal is entered AFTER its confirming candle, so the sweep extreme is inherently farther
const lastRegimeBySymbol = new Map();

function fmtP(x){ return x >= 100 ? x.toFixed(2) : x >= 1 ? x.toFixed(4) : x.toPrecision(5); }

// Nearest level that stands between entry and target, in R multiples.
function clearanceR(f, cand, s, entry, dist){
  const levels = [];
  const reversal = cand.setup === 'C' || cand.setup === 'D';
  const h1Sw = s === 1 ? swingHighPoints(f.h1, 0, f.h1.length - 1, 2, 2) : swingLowPoints(f.h1, 0, f.h1.length - 1, 2, 2);
  h1Sw.forEach(p => levels.push(p.price));
  if(f.tfH4.n){ const v = s === 1 ? f.tfH4.lastSwingHigh : f.tfH4.lastSwingLow; if(v != null) levels.push(v); }
  if(reversal){
    // Entry-timeframe walls use 4/4 fractals: the 2/2 fractals used for setup detection are minor noise
    // (a wick in the current decline is not a real barrier to a reversal target).
    const major = s === 1 ? swingHighPoints(f.E, 0, f.i - 4, 4, 4) : swingLowPoints(f.E, 0, f.i - 4, 4, 4);
    major.forEach(p => levels.push(p.price));
  }
  if(cand.capPrice != null) levels.push(cand.capPrice);
  const ahead = levels.filter(p => s === 1 ? p > entry : p < entry).map(p => s * (p - entry));
  if(!ahead.length) return { r: 99, level: null };
  const nearest = Math.min(...ahead);
  return { r: nearest / dist, level: entry + s * nearest };
}

// Stop = max(structural invalidation, ATR floor, recent swing), capped so a
// far-away structure rejects the trade instead of producing a bloated stop.
function buildStop(f, cand, s, entry){
  const buffer = (STOP_BUFFER_ATR[cand.setup] || 0.2) * f.atr;
  const structStop = s === 1 ? cand.anchor - buffer : cand.anchor + buffer;
  const structDist = s * (entry - structStop);
  const atrDist = MIN_STOP_ATR * f.atr;
  // Most recent confirmed swing beyond price within ~20 bars (the "recent swing high/low" input).
  const sw = (s === 1 ? f.swingLows : f.swingHighs).filter(p => p.index >= f.i - 20 && (s === 1 ? p.price < entry : p.price > entry)).slice(-1)[0];
  const swingDist = sw ? s * (entry - (s === 1 ? sw.price - 0.1 * f.atr : sw.price + 0.1 * f.atr)) : 0;
  const cap = (cand.setup === 'C' ? MAX_STOP_ATR_REVERSAL : MAX_STOP_ATR) * f.atr;
  const swingUsable = sw && swingDist <= cap ? swingDist : 0;
  const dist = Math.max(structDist, atrDist, swingUsable);
  const basis = dist === structDist ? cand.anchorBasis : (dist === swingUsable && swingUsable > 0) ? 'recent swing' : `${MIN_STOP_ATR} ATR floor`;
  if(!(dist > 0)) return { ok: false, reason: 'stop distance could not be computed' };
  if(dist > cap) return { ok: false, reason: `stop would be ${(dist / f.atr).toFixed(2)} ATR away (cap ${cap / f.atr}) — structure too far, poor entry` };
  return { ok: true, dist, distAtr: dist / f.atr, price: entry - s * dist, basis };
}

// Required clearance in R: continuation setups need 1.25R of air vs 1H/4H walls (they may break through);
// reversal setups need the target itself to sit before the next opposing level (+0.25R margin).
function requiredClearanceR(cand, rr){
  return cand.clearanceMode === 'beyondTarget' ? Math.max(cand.minClearanceR, rr + 0.25) : cand.minClearanceR;
}

function fundingRead(f, s, qcfg){
  if(!qcfg.useFunding || f.fundingRatePct == null) return { available: false, adj: 0, crowded: false, text: null };
  const dirFunding = s * f.fundingRatePct; // >0 means the trade side is paying
  let adj = 0;
  if(dirFunding >= 0.06) adj = -6; else if(dirFunding >= 0.03) adj = -3; else if(dirFunding <= -0.02) adj = 2;
  return {
    available: true, adj, crowded: dirFunding >= 0.03,
    text: `Funding ${f.fundingRatePct.toFixed(4)}%/8h ${dirFunding >= 0.03 ? '(crowded on this side — penalized)' : dirFunding <= -0.02 ? '(paid to hold — small bonus)' : '(neutral)'}`,
  };
}

function scoreCandidate(f, reg, cand, s, trade, qcfg, ctx){
  const w = qcfg.weights;
  const { tfE, tfMid, tfH1, tfH4 } = f;
  const alignQ = (spreadAtr) => (clamp(s * spreadAtr / 1.2, -1, 1) + 1) / 2;
  const dirQ = (t) => (t.dir === s ? 0.6 + 0.4 * t.strength : t.dir === 0 ? 0.35 : 0);
  const eQ = alignQ(tfE.spreadAtr);
  const mQ = alignQ((tfMid || tfH1).spreadAtr);
  const h1Q = dirQ(tfH1), h4Q = dirQ(tfH4);
  const trend = clamp(0.4 * eQ + 0.25 * mQ + 0.35 * h1Q, 0, 1);

  const htfStruct = tfH1.structure === (s === 1 ? 'bull' : 'bear') ? 1 : tfH1.structure === 'mixed' ? 0.5 : 0;
  const structure = clamp(0.75 * cand.q.structure + 0.25 * htfStruct, 0, 1);
  const momentum = clamp(cand.q.momentum, 0, 1);
  const spreadQ = clamp(1 - f.spreadPct / qcfg.maxSpreadPct, 0, 1);
  const volume = clamp(0.6 * cand.q.volume + 0.25 * (f.liquidityScore / 100) + 0.15 * spreadQ, 0, 1);
  const volatility = reg.volState === 'normal' ? 0.75 + 0.25 * (1 - clamp(Math.abs(f.atrPctile - 0.5) * 2, 0, 1))
    : reg.volState === 'expansion' ? 0.85 : reg.volState === 'high' ? 0.5 : 0.4;
  const htf = clamp(0.5 * h4Q + 0.5 * h1Q, 0, 1);
  const stopSanity = 1 - clamp(Math.abs(trade.distAtr - 1.8) / 1.5, 0, 1);
  const entry = clamp(0.7 * cand.q.entry + 0.3 * stopSanity, 0, 1);

  const minClr = requiredClearanceR(cand, trade.rr);
  const need = Math.max(minClr, trade.rr);
  const roomQ = trade.clearance.r >= 99 ? 1 : clamp((trade.clearance.r - minClr) / Math.max(0.5, need + 1 - minClr), 0, 1);
  const cost = ctx.costPct != null ? ctx.costPct : 0.15;
  const distPct = (trade.dist / trade.entry) * 100;
  const netRR = (trade.rr * distPct - cost) / (distPct + cost);
  const netRRQ = clamp((netRR - 1.2) / Math.max(0.3, trade.rr - 1.2), 0, 1);
  const rr = clamp(0.6 * roomQ + 0.4 * netRRQ, 0, 1);

  const factors = { trend, structure, momentum, volume, volatility, htf, entry, rr };
  let score = 0;
  for(const k of Object.keys(w)) score += (factors[k] ?? 0) * w[k];
  const fund = fundingRead(f, s, qcfg);
  score = clamp(Math.round(score + fund.adj), 0, 100);
  return { score, factors, fund, netRR, roomQ };
}

// Confluence: how many independent categories agree, plus discrete confirmations.
function confluence(f, reg, cand, s, trade, sc){
  const F = sc.factors;
  const categories = {
    trend: F.trend >= 0.6, structure: F.structure >= 0.6, momentum: F.momentum >= 0.55,
    volume: F.volume >= 0.55, htf: F.htf >= 0.6, quality: (F.entry + F.rr) / 2 >= 0.6,
  };
  const rsiAgree = s === 1 ? f.rsi > 50 || f.rsi > f.rsiPrev : f.rsi < 50 || f.rsi < f.rsiPrev;
  const macdAgree = s === 1 ? f.macdHist > f.macdPrev : f.macdHist < f.macdPrev;
  const confirmations = [
    { key: 'h4', ok: f.tfH4.dir === s, text: `4H ${s === 1 ? 'bullish' : 'bearish'} structure` },
    { key: 'h1', ok: f.tfH1.dir === s && f.tfH1.strength >= 0.4, text: `1H trend aligned` },
    { key: 'entryTrend', ok: s * f.tfE.spreadAtr > 0.3, text: `${f.entryTf} EMA21/55 aligned` },
    { key: 'volume', ok: !!cand.flags.volumeConfirm, text: 'Volume confirmation' },
    { key: 'momentum', ok: !!cand.flags.momentumConfirm && rsiAgree && macdAgree, text: 'Momentum confirmation (RSI + MACD)' },
    { key: 'room', ok: trade.clearance.r >= trade.rr, text: `Clear path to ${trade.rr}R target` },
  ];
  if(sc.fund.available) confirmations.push({ key: 'funding', ok: !sc.fund.crowded, text: 'Funding not crowded against the trade' });
  return {
    categories, categoriesPassed: Object.values(categories).filter(Boolean).length,
    confirmations, confirmationsPassed: confirmations.filter(c => c.ok).length,
  };
}

function pickRR(qcfg, sc, trade){
  let rr = qcfg.rewardRisk;
  if(qcfg.adaptiveRR && sc.score >= 85){
    const next = RR_TIERS.find(t => t > rr);
    if(next && trade.clearance.r >= next + 0.5) rr = next;
  }
  // Was hardcoded to Math.max(2, ...) — silently re-forced every trade to at least
  // 1:2 regardless of qcfg.rewardRisk, which would have quietly undone the shipped
  // 1:1.5 profile above. Floors on the real config ceiling instead.
  return Math.max(HARD_LIMITS.minRewardRisk, Math.min(4, rr));
}

export function detectQuantFutures(snap, baseRegime, qcfg, ctx){
  ctx = ctx || {};
  const symbol = snap.symbol;
  const veto = (msg, extra) => ({ type: QUANT_TYPE, direction: null, rawConfidence: 0, reasons: [], vetoes: [msg], meta: { quant: true, ...(extra || {}) } });

  const f = buildFeatures(snap, qcfg, ctx);
  if(!f.ok) return f.quiet ? null : veto(`Quant Futures: ${f.reason}`);

  const lastRangeAtr = (f.last.h - f.last.l) / f.atr;

  const reg = classifyQuantRegime(f);
  if(ctx.log){
    const prevLabel = lastRegimeBySymbol.get(symbol);
    if(prevLabel !== reg.label){ lastRegimeBySymbol.set(symbol, reg.label); qlog(`${symbol} market regime detected: ${reg.label} (${reg.notes[0]})`); }
  }

  const minConf = effectiveMinConfidence(qcfg) + reg.confBoost;
  const tier = SELECTIVITY[qcfg.selectivity] || SELECTIVITY.off;
  const rejections = [];
  const passing = [];   // met every gate
  const failing = [];   // real candidates that failed score/confluence/stop/target gates

  const dirs = [];
  if(qcfg.allowLong) dirs.push('LONG');
  if(qcfg.allowShort) dirs.push('SHORT');
  if(!dirs.length) return veto('Quant Futures: both Long and Short are disabled in its settings');

  const entryFillFor = (s) => {
    const slipPct = clamp(f.spreadPct * 0.6, 0.005, 0.05) * (reg.volState === 'high' ? 1.5 : 1);
    return { entry: snap.price * (1 + s * (f.spreadPct / 2 + slipPct) / 100), slipPct };
  };

  for(const setupId of ['A', 'B', 'C', 'D']){
    if(!qcfg.setups[setupId]) continue;
    if(!reg.allowed[setupId]){ rejections.push(`${setupId}: not permitted in the ${reg.label} regime`); continue; }
    for(const dir of dirs){
      const cand = SETUP_DETECTORS[setupId](f, reg, dir);
      if(!cand.ok){ rejections.push(cand.reason); continue; }
      if(ctx.log) qlogOnce(`${symbol}|${setupId}|${dir}|${f.last.t}|det`, `${symbol} setup detected: ${cand.name} (${dir}) on ${f.entryTf}`);
      // Excessive candle expansion: a bar this large has usually already paid out the move. Not applied to the
      // liquidity-sweep reversal (C), whose confirming candle is legitimately large — its stop-distance cap and
      // entry-quality score already penalize chasing.
      if(setupId !== 'C' && lastRangeAtr > 2.8){
        failing.push({ cand, dir, reason: `${cand.name} ${dir}: excessive candle expansion (${lastRangeAtr.toFixed(2)} ATR) — not chasing`, score: 0 });
        continue;
      }

      const s = dir === 'LONG' ? 1 : -1;
      const { entry, slipPct } = entryFillFor(s);
      const st = buildStop(f, cand, s, entry);
      if(!st.ok){ failing.push({ cand, dir, reason: `${cand.name} ${dir}: ${st.reason}`, score: 0 }); continue; }
      const trade = { entry, slipPct, dist: st.dist, distAtr: st.distAtr, stopPrice: st.price, stopBasis: st.basis, rr: qcfg.rewardRisk };
      trade.clearance = clearanceR(f, cand, s, entry, st.dist);
      const needClr = requiredClearanceR(cand, qcfg.rewardRisk);
      if(trade.clearance.r < needClr){
        failing.push({ cand, dir, reason: `${cand.name} ${dir}: target blocked — opposing level at ${trade.clearance.r.toFixed(2)}R (needs ≥ ${needClr.toFixed(2)}R)`, score: 0 });
        continue;
      }
      let sc = scoreCandidate(f, reg, cand, s, trade, qcfg, ctx);
      trade.rr = pickRR(qcfg, sc, trade);
      if(trade.rr !== qcfg.rewardRisk) sc = scoreCandidate(f, reg, cand, s, trade, qcfg, ctx);
      if(trade.clearance.r < trade.rr * 0.8 && trade.rr > qcfg.rewardRisk){ trade.rr = qcfg.rewardRisk; sc = scoreCandidate(f, reg, cand, s, trade, qcfg, ctx); }
      const cf = confluence(f, reg, cand, s, trade, sc);
      const applicable = cf.confirmations.length;
      const needConf = Math.min(tier.minConfirmations, applicable);

      const why = [];
      if(sc.score < minConf) why.push(`score ${sc.score} below required ${minConf}${reg.confBoost ? ` (includes +${reg.confBoost} for ${reg.label})` : ''}`);
      if(cf.categoriesPassed < tier.minCategories) why.push(`only ${cf.categoriesPassed}/6 confluence categories agree (need ${tier.minCategories})`);
      if(cf.confirmationsPassed < needConf) why.push(`only ${cf.confirmationsPassed}/${applicable} confirmations (need ${needConf})`);
      const rec = { cand, dir, s, trade, sc, cf, reason: null };
      if(why.length){ rec.reason = `${cand.name} ${dir}: ${why.join('; ')}`; rec.score = sc.score; failing.push(rec); continue; }
      passing.push(rec);
    }
  }

  if(!passing.length){
    const bestFail = failing.slice().sort((a, b) => (b.score || 0) - (a.score || 0))[0];
    const msgs = [`Quant regime: ${reg.label}`];
    if(bestFail) msgs.push(bestFail.reason);
    else msgs.push(...rejections.slice(0, 3));
    if(ctx.log && bestFail) qlogOnce(`${symbol}|${bestFail.cand.setup}|${bestFail.dir || ''}|${f.last.t}|rej`, `${symbol} ${bestFail.reason}`);
    return veto(msgs.join(' — '), { regime: reg.label, rejections });
  }

  passing.sort((a, b) => b.sc.score - a.sc.score);
  const best = passing[0];
  const { cand, dir, s, trade, sc, cf } = best;
  const targetPrice = trade.entry + s * trade.rr * trade.dist;

  const reasons = [
    ...(reg.notes.slice(0, 1)),
    ...cand.evidence,
  ];
  if(sc.fund.text) reasons.push(sc.fund.text);
  reasons.push(`Volatility acceptable (${reg.volState}, ATR ${(f.atrPctile * 100).toFixed(0)}th percentile); spread ${f.spreadPct.toFixed(3)}%, liquidity ${Math.round(f.liquidityScore)}/100`);

  if(ctx.log){
    const key = `${symbol}|${cand.setup}|${dir}|${f.last.t}`;
    qlogOnce(`${key}|sig`, `${symbol} confidence = ${sc.score}`);
    qlogOnce(`${key}|htf`, `${symbol} higher timeframe alignment = ${f.tfH4.dir === s && f.tfH1.dir === s ? 'TRUE' : (reg.bias === s ? 'PARTIAL' : 'FALSE')}`);
    qlogOnce(`${key}|vol`, `${symbol} volatility filter = ${reg.volState === 'high' ? 'PASS (high — size reduced)' : 'PASS'}`);
    qlogOnce(`${key}|liq`, `${symbol} liquidity filter = ${f.liquidityScore >= 35 && f.spreadPct <= qcfg.maxSpreadPct ? 'PASS' : 'FAIL'}`);
    qlogOnce(`${key}|rr`, `${symbol} RR = ${trade.rr.toFixed(2)} (clearance ${trade.clearance.r >= 99 ? 'clear' : trade.clearance.r.toFixed(2) + 'R'}, net-of-costs ${sc.netRR.toFixed(2)})`);
    qlogOnce(`${key}|gen`, `${symbol} ${dir} signal generated (${cand.name})`);
  }

  return {
    type: QUANT_TYPE, direction: dir, rawConfidence: sc.score, reasons,
    meta: {
      quant: true, setup: cand.setup, setupName: cand.name, entryTf: f.entryTf,
      score: sc.score, factors: sc.factors, weights: qcfg.weights,
      categories: cf.categories, categoriesPassed: cf.categoriesPassed,
      confirmations: cf.confirmations, confirmationsPassed: cf.confirmationsPassed,
      regime: { label: reg.label, trendLabel: reg.trendLabel, bias: reg.bias, volState: reg.volState, notes: reg.notes, riskMult: reg.riskMult, confBoost: reg.confBoost },
      stopPrice: trade.stopPrice, stopBasis: trade.stopBasis, stopDistPct: (trade.dist / trade.entry) * 100, stopDistAtr: trade.distAtr,
      entryFill: trade.entry, slipPct: trade.slipPct, rewardRisk: trade.rr, targetPrice,
      clearanceR: trade.clearance.r, clearanceLevel: trade.clearance.level, netRR: sc.netRR,
      atr: f.atr, atrPct: f.atrPct, atrPctile: f.atrPctile, spreadPct: f.spreadPct, liquidityScore: f.liquidityScore,
      fundingRatePct: f.fundingRatePct, fundingAdj: sc.fund.adj,
      candleTime: f.last.t, minConfidenceUsed: minConf, holdMinutes: qcfg.maxHoldMinutes[f.entryTf],
      rejectedAlternatives: passing.slice(1).map(p => `${p.cand.name} ${p.dir} (${p.sc.score})`),
    },
  };
}

// Human-readable, auditable explanation in the format the spec asks for.
export function buildQuantExplanation(row){
  const m = row.quantMeta;
  if(!m) return null;
  // '[+] ' / '[-] ' line prefixes are turned into check / cross icons by
  // explanationHtml() in futures-ui.js (plain text stays readable anywhere else).
  const chk = (ok, t) => `${ok ? '[+]' : '[-]'} ${t}`;
  const s = row.direction === 'LONG' ? 1 : -1;
  const lines = [];
  lines.push(`${row.symbol} — ${row.direction}`);
  lines.push('');
  lines.push(`Confidence: ${row.confidence}%   (required ≥ ${m.minConfidenceUsed})`);
  lines.push(`Setup: ${m.setupName} (${m.entryTf})`);
  lines.push(`Market Regime: ${m.regime.label}${m.regime.label !== m.regime.trendLabel ? ` (underlying: ${m.regime.trendLabel})` : ''}`);
  lines.push('');
  lines.push('Reasons:');
  for(const c of m.confirmations) lines.push(chk(c.ok, c.text));
  for(const r of row.reasons.slice(1)) lines.push(`[+] ${r}`);
  lines.push(chk(true, `Risk/Reward = 1:${m.rewardRisk.toFixed(2)} (net of estimated costs 1:${m.netRR.toFixed(2)})`));
  lines.push('');
  lines.push('Score breakdown (weight × factor):');
  const names = { trend: 'Trend alignment', structure: 'Market structure', momentum: 'Momentum', volume: 'Volume/liquidity', volatility: 'Volatility regime', htf: 'Higher-TF alignment', entry: 'Entry quality', rr: 'RR quality' };
  for(const k of Object.keys(names)) lines.push(`  ${names[k].padEnd(22)} ${(m.weights[k] * m.factors[k]).toFixed(1).padStart(5)} / ${m.weights[k].toFixed(0)}`);
  if(m.fundingAdj) lines.push(`  ${'Funding adjustment'.padEnd(22)} ${m.fundingAdj > 0 ? '+' : ''}${m.fundingAdj}`);
  lines.push(`  Confluence: ${m.categoriesPassed}/6 categories, ${m.confirmationsPassed}/${m.confirmations.length} confirmations`);
  lines.push('');
  lines.push(`Entry:        ${fmtP(row.entry)}`);
  lines.push(`Stop:         ${fmtP(row.stop)}  (${m.stopDistPct.toFixed(2)}% / ${m.stopDistAtr.toFixed(2)} ATR, basis: ${m.stopBasis})`);
  lines.push(`Take Profit:  ${fmtP(row.tp1)}`);
  lines.push(`Risk:         ${row.riskPctUsed != null ? row.riskPctUsed.toFixed(2) + '%' : '—'} of equity${row.sizing ? ` ($${row.sizing.riskAmountUsd.toFixed(2)})` : ''}`);
  lines.push(`Expected RR:  1:${m.rewardRisk.toFixed(2)}`);
  if(row.status !== 'APPROVED') lines.push('', `REJECTED: ${row.rejectReasons.join('; ')}`);
  return lines.join('\n');
}
