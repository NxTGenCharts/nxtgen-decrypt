// =============================================================
// quant/signal.js — the NxTGen HTF OrderFlow Signal Engine.
//
//   snapshot -> features (5M + 30M/1H/4H context, HTF zones, PSAR/EMA/AO)
//            -> market regime filter -> setup detector (setups.js, every
//               mandatory condition in the spec) -> structure+ATR stop
//            -> RR target (with opposing-structure clearance check)
//            -> 9-factor 0-100 confluence score -> minimum-score gate
//            -> signal
//
// Deterministic and testable end to end: same snapshot in, same signal
// out. No network, no LLM, no randomness in the detection itself. (If the
// platform's optional AI second-opinion is enabled — see js/ai-signal.js —
// it runs AFTER this, only ever able to veto an already-approved signal;
// this strategy's rows flow through that same layer exactly like every
// other strategy's do, unchanged, since AI Smartness is a Live/Demo
// platform feature, not something each strategy wires up separately.)
//
// The result is shaped like every other detector's signal
// ({type, direction, rawConfidence, reasons, meta, vetoes?}) so it flows
// through engine.js's existing ensemble/cost/risk/no-trade pipeline.
// =============================================================
import { QUANT_TYPE, HARD_LIMITS, effectiveMinConfidence } from './config.js';
import { buildFeatures, clamp, nearestZone } from './features.js';
import { classifyQuantRegime } from './regime.js';
import { SETUP_DETECTORS } from './setups.js';
import { qlog, qlogOnce } from './log.js';

const RR_TIERS = [2, 2.5, 3];
const MAX_STOP_ATR = 4.0; // wider than this = the structure is too far away = poor entry
const lastRegimeBySymbol = new Map();

function fmtP(x){ return x >= 100 ? x.toFixed(2) : x >= 1 ? x.toFixed(4) : x.toPrecision(5); }

function fundingRead(f, s, qcfg){
  if(!qcfg.useFunding || f.fundingRatePct == null) return { available: false, adj: 0, crowded: false, text: null };
  const dirFunding = s * f.fundingRatePct;
  let adj = 0;
  if(dirFunding >= 0.06) adj = -6; else if(dirFunding >= 0.03) adj = -3; else if(dirFunding <= -0.02) adj = 2;
  return {
    available: true, adj, crowded: dirFunding >= 0.03,
    text: `Funding ${f.fundingRatePct.toFixed(4)}%/8h ${dirFunding >= 0.03 ? '(crowded on this side — penalized)' : dirFunding <= -0.02 ? '(paid to hold — small bonus)' : '(neutral)'}`,
  };
}

// Structure-based stop: the far edge of the validated HTF zone/order block, plus an ATR safety buffer
// (spec: SL buffer 0.1-0.25 x 5M ATR). Rejects if the structural distance is noise-tight or unreasonably far.
function buildStop(f, cand, s, entry, qcfg){
  const buffer = qcfg.slBufferAtr * f.atr;
  const stopPrice = s === 1 ? cand.zone.bottom - buffer : cand.zone.top + buffer;
  const dist = s * (entry - stopPrice);
  if(!(dist > 0)) return { ok: false, reason: 'stop distance could not be computed' };
  const distAtr = dist / f.atr;
  if(distAtr < qcfg.minStopAtr) return { ok: false, reason: `stop only ${fmtP(distAtr)} ATR away (min ${qcfg.minStopAtr}) — too tight, likely noise` };
  if(distAtr > MAX_STOP_ATR) return { ok: false, reason: `stop would be ${distAtr.toFixed(2)} ATR away (cap ${MAX_STOP_ATR}) — structure too far, poor entry` };
  return { ok: true, dist, distAtr, price: stopPrice, basis: `${cand.zone.type} zone ${s === 1 ? 'low' : 'high'} - ${qcfg.slBufferAtr} ATR buffer` };
}

// Nearest OPPOSING HTF zone or 1H/4H swing point ahead of entry, in R multiples of the stop distance —
// mirrors the spec's TP guidance ("Potential TP targets can also consider: Opposing HTF supply/demand,
// Previous swing high/low, HTF structure") and stops the target from being set past a wall that will likely
// reject price before it gets there.
function clearanceR(f, cand, s, entry, dist){
  const levels = [];
  const oppType = cand.zone.type === 'demand' ? 'supply' : 'demand';
  for(const z of f.zonesH1) if(z.type === oppType) levels.push(s === 1 ? z.bottom : z.top);
  for(const z of f.zonesH4) if(z.type === oppType) levels.push(s === 1 ? z.bottom : z.top);
  if(f.tfH1.lastSwingHigh != null && s === 1) levels.push(f.tfH1.lastSwingHigh);
  if(f.tfH1.lastSwingLow != null && s === -1) levels.push(f.tfH1.lastSwingLow);
  const ahead = levels.filter(p => s === 1 ? p > entry : p < entry).map(p => s * (p - entry));
  if(!ahead.length) return { r: 99, level: null };
  const nearest = Math.min(...ahead);
  return { r: nearest / dist, level: entry + s * nearest };
}

function scoreCandidate(f, cand, qcfg, ctx){
  const w = qcfg.weights;
  const factors = cand.q;
  let score = 0;
  for(const k of Object.keys(w)) score += (factors[k] ?? 0) * w[k];
  const fund = fundingRead(f, cand.s, qcfg);
  score = clamp(Math.round(score + fund.adj), 0, 100);
  return { score, factors, fund };
}

function pickRR(qcfg, sc, clearance){
  let rr = qcfg.rewardRisk;
  if(qcfg.adaptiveRR && sc.score >= 85){
    const opts = (qcfg.rewardRiskOptions || RR_TIERS).filter(v => v > rr).sort((a, b) => a - b);
    const next = opts[0];
    if(next && clearance.r >= next + 0.5) rr = next;
  }
  return Math.max(HARD_LIMITS.minRewardRisk, Math.min(4, rr));
}

export function detectQuantFutures(snap, baseRegime, qcfg, ctx){
  ctx = ctx || {};
  const symbol = snap.symbol;
  const veto = (msg, extra) => ({ type: QUANT_TYPE, direction: null, rawConfidence: 0, reasons: [], vetoes: [msg], meta: { quant: true, ...(extra || {}) } });

  const f = buildFeatures(snap, qcfg, ctx);
  if(!f.ok) return f.quiet ? null : veto(`HTF OrderFlow: ${f.reason}`);

  const reg = classifyQuantRegime(f);
  if(ctx.log){
    const prevLabel = lastRegimeBySymbol.get(symbol);
    if(prevLabel !== reg.label){ lastRegimeBySymbol.set(symbol, reg.label); qlog(`${symbol} market regime detected: ${reg.label} (${reg.notes[0]})`); }
  }

  if(!qcfg.setups.A || !reg.allowed.A){
    if(ctx.log) qlogOnce(`${symbol}|regime|${f.last.t}`, `${symbol} no trade — market regime filter (${reg.label})`);
    return veto(`HTF OrderFlow: ${reg.notes[reg.notes.length - 1] || `market regime (${reg.label}) not tradeable`}`, { regime: reg.label, stage: 'no_setup' });
  }

  const minConf = effectiveMinConfidence(qcfg) + reg.confBoost;
  const dirs = [];
  if(qcfg.allowLong) dirs.push('LONG');
  if(qcfg.allowShort) dirs.push('SHORT');
  if(!dirs.length) return veto('HTF OrderFlow: both Long and Short are disabled in its settings');

  const entryFillFor = (s) => {
    const slipPct = clamp(f.spreadPct * 0.6, 0.005, 0.05) * (reg.volState === 'high' ? 1.5 : 1);
    return { entry: snap.price * (1 + s * (f.spreadPct / 2 + slipPct) / 100), slipPct };
  };

  const failing = [];
  const passing = [];
  for(const dir of dirs){
    const s = dir === 'LONG' ? 1 : -1;
    const cand = SETUP_DETECTORS.A(f, reg, dir, qcfg);
    if(!cand.ok){ failing.push({ reason: cand.reason, stage: 'no_setup' }); continue; }
    if(ctx.log) qlogOnce(`${symbol}|${dir}|${f.last.t}|det`, `${symbol} HTF OrderFlow candidate detected (${dir})`);

    const { entry, slipPct } = entryFillFor(s);
    const st = buildStop(f, cand, s, entry, qcfg);
    if(!st.ok){ failing.push({ cand, reason: `HTF OrderFlow ${dir}: ${st.reason}`, stage: 'stop' }); continue; }

    const distPct = (st.dist / entry) * 100;
    const costR = (ctx.costPct != null ? ctx.costPct : 0.15) / distPct;
    if(costR > qcfg.maxCostR){
      failing.push({ cand, reason: `HTF OrderFlow ${dir}: costs are ${costR.toFixed(2)}R (stop only ${distPct.toFixed(2)}% away; max ${qcfg.maxCostR}R)`, stage: 'cost' });
      continue;
    }

    const trade = { entry, slipPct, dist: st.dist, distAtr: st.distAtr, stopPrice: st.price, stopBasis: st.basis };
    const sc = scoreCandidate(f, cand, qcfg, ctx);
    trade.clearance = clearanceR(f, cand, s, entry, st.dist);
    trade.rr = pickRR(qcfg, sc, trade.clearance);
    // If an opposing HTF zone/swing sits closer than the target, cap the target just short of it rather than
    // rejecting outright — but never accept less than the platform's real 1:2 floor (spec: TP can consider
    // "Opposing HTF supply/demand... Previous swing high/low").
    if(trade.clearance.r < trade.rr && trade.clearance.r >= HARD_LIMITS.minRewardRisk){
      trade.rr = Math.max(HARD_LIMITS.minRewardRisk, trade.clearance.r - 0.15);
    } else if(trade.clearance.r < HARD_LIMITS.minRewardRisk){
      failing.push({ cand, reason: `HTF OrderFlow ${dir}: opposing structure at ${trade.clearance.r.toFixed(2)}R blocks any ${HARD_LIMITS.minRewardRisk}R+ target`, stage: 'clearance' });
      continue;
    }

    if(sc.score < minConf){
      failing.push({ cand, reason: `HTF OrderFlow ${dir}: confluence score ${sc.score} below required ${minConf}${reg.confBoost ? ` (includes +${reg.confBoost} for ${reg.label})` : ''}`, stage: 'score' });
      continue;
    }
    passing.push({ cand, dir, s, trade, sc });
  }

  if(!passing.length){
    const msgs = [`Regime: ${reg.label}`];
    if(failing.length) msgs.push(failing[0].reason);
    if(ctx.log && failing.length) qlogOnce(`${symbol}|${f.last.t}|rej`, `${symbol} ${failing[0].reason}`);
    const order = ['score', 'clearance', 'cost', 'stop', 'no_setup'];
    const stage = failing.length ? order.find(k => failing.some(x => x.stage === k)) || 'no_setup' : 'no_setup';
    return veto(msgs.join(' — '), { regime: reg.label, stage, setup: 'A' });
  }

  passing.sort((a, b) => b.sc.score - a.sc.score);
  const best = passing[0];
  const { cand, dir, s, trade, sc } = best;
  const targetPrice = trade.entry + s * trade.rr * trade.dist;

  const reasons = [
    ...cand.evidence.filter(l => l.startsWith('[+]')).map(l => l.slice(4)),
  ];
  if(sc.fund.text) reasons.push(sc.fund.text);
  reasons.push(`Volatility acceptable (${reg.volState}); spread ${f.spreadPct.toFixed(3)}%, liquidity ${Math.round(f.liquidityScore)}/100`);

  if(ctx.log){
    const key = `${symbol}|${dir}|${f.last.t}`;
    qlogOnce(`${key}|sig`, `${symbol} confidence = ${sc.score}`);
    qlogOnce(`${key}|htf`, `${symbol} 4H+1H alignment = TRUE, HTF order-block confluence = ${cand.confluenceCount}/3 timeframes`);
    qlogOnce(`${key}|rr`, `${symbol} RR = ${trade.rr.toFixed(2)} (clearance ${trade.clearance.r >= 99 ? 'clear' : trade.clearance.r.toFixed(2) + 'R'})`);
    qlogOnce(`${key}|gen`, `${symbol} ${dir} signal generated (HTF OrderFlow, ${cand.confluenceCount}/3 TF confluence)`);
  }

  return {
    type: QUANT_TYPE, direction: dir, rawConfidence: sc.score, reasons,
    meta: {
      quant: true, setup: 'A', setupName: 'HTF OrderFlow', entryTf: f.entryTf,
      score: sc.score, factors: sc.factors, weights: qcfg.weights,
      confluenceCount: cand.confluenceCount, breakoutRetest: cand.breakoutRetest,
      zone: { type: cand.zone.type, top: cand.zone.top, bottom: cand.zone.bottom, strength: cand.zone.strength },
      regime: { label: reg.label, trendLabel: reg.trendLabel, bias: reg.bias, volState: reg.volState, notes: reg.notes, riskMult: reg.riskMult, confBoost: reg.confBoost },
      stopPrice: trade.stopPrice, stopBasis: trade.stopBasis, stopDistPct: (trade.dist / trade.entry) * 100, stopDistAtr: trade.distAtr,
      entryFill: trade.entry, slipPct: trade.slipPct, rewardRisk: trade.rr, targetPrice,
      clearanceR: trade.clearance.r, clearanceLevel: trade.clearance.level,
      atr: f.atr, atrPct: f.atrPct, atrPctile: f.atrPctile, spreadPct: f.spreadPct, liquidityScore: f.liquidityScore,
      fundingRatePct: f.fundingRatePct, fundingAdj: sc.fund.adj,
      candleTime: f.last.t, minConfidenceUsed: minConf, holdMinutes: qcfg.maxHoldMinutes['5m'],
      evidence: cand.evidence,
    },
  };
}

// Human-readable, auditable explanation in the format the spec asks for
// (spec's own "SIGNAL EXPLANATION" example: 4H Trend / 1H Trend / zones /
// EMA / PSAR / AO / Confluence / RR, one checked line per condition).
export function buildQuantExplanation(row){
  const m = row.quantMeta;
  if(!m) return null;
  const lines = [];
  lines.push(`${row.symbol} — ${row.direction}`);
  lines.push('');
  lines.push(`Confidence: ${row.confidence}%   (required >= ${m.minConfidenceUsed})`);
  lines.push(`Setup: ${m.setupName} (${m.entryTf} entry, HTF 4H/1H/30M)`);
  lines.push(`Market Regime: ${m.regime.label}${m.regime.label !== m.regime.trendLabel ? ` (underlying: ${m.regime.trendLabel})` : ''}`);
  lines.push(`HTF order-block confluence: ${m.confluenceCount}/3 timeframes${m.breakoutRetest ? ' (displacement -> BOS -> retest)' : ''}`);
  lines.push('');
  lines.push('Reasons:');
  for(const l of (m.evidence || [])) lines.push(l);
  for(const r of row.reasons.slice(1)) lines.push(`[+] ${r}`);
  lines.push(`[+] Risk/Reward = 1:${m.rewardRisk.toFixed(2)}`);
  lines.push('');
  lines.push('Score breakdown (weight x factor):');
  const names = { h4: '4H trend alignment', h1: '1H trend alignment', m30: '30M structure', supplyDemand: 'HTF Supply/Demand quality', orderBlock: 'HTF Order Block quality', emaAlign: '5M EMA50/100 alignment', psar: '5M PSAR crossover', ao: '5M AO confirmation', proximity: 'Entry-zone proximity' };
  for(const k of Object.keys(names)) lines.push(`  ${names[k].padEnd(26)} ${((m.weights[k] || 0) * (m.factors[k] || 0)).toFixed(1).padStart(5)} / ${(m.weights[k] || 0).toFixed(0)}`);
  if(m.fundingAdj) lines.push(`  ${'Funding adjustment'.padEnd(26)} ${m.fundingAdj > 0 ? '+' : ''}${m.fundingAdj}`);
  lines.push(`  Confluence score: ${m.score}/100`);
  lines.push('');
  lines.push(`Entry:        ${fmtP(row.entry)}`);
  lines.push(`Stop:         ${fmtP(row.stop)}  (${m.stopDistPct.toFixed(2)}% / ${m.stopDistAtr.toFixed(2)} ATR, basis: ${m.stopBasis})`);
  lines.push(`Take Profit:  ${fmtP(row.tp1)}`);
  lines.push(`Risk:         ${row.riskPctUsed != null ? row.riskPctUsed.toFixed(2) + '%' : '—'} of equity${row.sizing ? ` ($${row.sizing.riskAmountUsd.toFixed(2)})` : ''}`);
  lines.push(`Expected RR:  1:${m.rewardRisk.toFixed(2)}`);
  if(row.status !== 'APPROVED') lines.push('', `REJECTED: ${row.rejectReasons.join('; ')}`);
  return lines.join('\n');
}
