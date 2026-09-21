#!/usr/bin/env node
// =============================================================
// quant-sweep.mjs — honest parameter sweep for NxTGen Quant Futures, on REAL exchange history.
//
//   node tools/quant-sweep.mjs                       # 90 days, Binance top-25, quick grid (~30 configs)
//   node tools/quant-sweep.mjs --grid full           # 96-config factorial (slower)
//   node tools/quant-sweep.mjs --days 120 --top 30 --jobs 6
//   node tools/quant-sweep.mjs --synthetic           # self-test on fake candles (results are MEANINGLESS)
//
// What it does
//   1. Downloads 5m candles through YOUR proxy (default: the Render server the site already uses, endpoint
//      /api/backtest/klines — needs the fixed server.js deployed so >5 days come back) and caches them in tools/.cache.
//   2. Runs the app's REAL backtest engine (js/futures/backtest.js — same code the Backtest tab runs) once per
//      config, in parallel worker threads.
//   3. Splits every config's trades chronologically: TRAIN (first ~2/3 of the period) and TEST (last ~1/3).
//      Rank by TRAIN, then look at TEST: a config that only wins on the data it was picked on is overfit.
//
// Honest limits (printed again at the end): dozens of configs on ~100 trades will always crown a "winner"
// by luck. Only trust a config that (a) beats the baseline on TRAIN, (b) is still profitable on the untouched
// TEST slice with >= 15 trades there, and (c) keeps working when you re-run on a later, non-overlapping period.
// =============================================================
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { rankTopByVolume } from '../js/futures/watchlist.js';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const CACHE = path.join(__dir, '.cache');
fs.mkdirSync(CACHE, { recursive: true });

// ---------------- args ----------------
const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf('--' + n); if(i < 0) return d; const v = argv[i + 1]; return (v == null || v.startsWith('--')) ? true : v; };
const A = {
  days: +flag('days', 90), exchange: String(flag('exchange', 'binance')), top: +flag('top', 25),
  proxy: String(flag('proxy', 'https://nxtgen-decrypt-2.onrender.com')).replace(/\/$/, ''),
  symbols: flag('symbols', null), split: +flag('split', 0.67), jobs: +flag('jobs', Math.max(1, Math.min(8, os.cpus().length - 1))),
  grid: String(flag('grid', 'quick')), synthetic: !!flag('synthetic', false), refresh: !!flag('refresh', false),
  risk: +flag('risk', 1), lev: +flag('lev', 5), maker: +flag('maker', 0.02), taker: +flag('taker', 0.05), spread: +flag('spread', 0.04),
  minTrain: +flag('min-train', 15),
};
const DAY = 86_400_000;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------------- data ----------------
async function post(pathname, body){
  const r = await fetch(A.proxy + pathname, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return r.json();
}
async function fetchSymbol(symbol, startMs, endMs){
  const file = path.join(CACHE, `${A.exchange}_${symbol.replace(/[^\w]/g, '_')}_${A.days}d_${endMs}.json`);
  if(!A.refresh && fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  let last = null;
  for(let attempt = 0; attempt < 4; attempt++){
    try{
      const d = await post('/api/backtest/klines', { exchange: A.exchange, symbol, interval: '5m', startMs, endMs });
      if(d.ok){ fs.writeFileSync(file, JSON.stringify(d.candles)); return d.candles; }
      if(d.notListed) return [];
      last = new Error(d.message || 'fetch failed');
    }catch(e){ last = e; }
    await sleep(3000 * (attempt + 1));
  }
  throw last;
}
function synthetic(n, nsym){
  const rng = (seed) => () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const end = Math.floor(Date.now() / DAY) * DAY, t0 = end - n * 300000, out = {};
  for(let s = 0; s <= nsym; s++){
    const r = rng(1000 + s); let p = 1 + s, drift = 0, vol = 0.004; const arr = [];
    for(let i = 0; i < n; i++){
      if(i % 400 === 0){ drift = (r() - 0.5) * 0.0006; vol = 0.002 + r() * 0.004; }
      const o = p, c = o * (1 + drift + vol * (r() + r() + r() - 1.5) * 1.6);
      arr.push({ t: t0 + i * 300000, o, h: Math.max(o, c) * (1 + r() * vol * 0.6), l: Math.min(o, c) * (1 - r() * vol * 0.6), c, v: 1000 * (0.5 + r()) * (1 + Math.abs(c / o - 1) / vol) }); p = c;
    }
    out[s === nsym ? 'BTCUSDT' : `SYN${s}USDT`] = arr;
  }
  return out;
}

async function buildDataset(){
  const endMs = Math.floor(Date.now() / DAY) * DAY;           // start of today (UTC): stable cache key for the whole day
  const startMs = endMs - A.days * DAY;
  let candles = {};
  if(A.synthetic){
    console.log('!! SYNTHETIC MODE: fake random-walk candles. Numbers below say NOTHING about real markets — this only tests the tool.');
    candles = synthetic(A.days * 288, Math.min(A.top, 8));
  }else{
    let names;
    if(A.symbols && A.symbols !== true) names = String(A.symbols).split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
    else{
      const u = await post('/api/futures/universe', { exchange: A.exchange });
      if(!u.ok) throw new Error('Universe fetch failed: ' + (u.message || 'unknown'));
      names = rankTopByVolume(u.symbols, A.top).top.map(s => s.symbol);
    }
    const list = Array.from(new Set([...names, 'BTCUSDT']));
    console.log(`Downloading ${A.days}d of 5m candles for ${list.length} symbols via ${A.proxy} (cached in tools/.cache)…`);
    for(let i = 0; i < list.length; i++){
      process.stdout.write(`  ${String(i + 1).padStart(2)}/${list.length} ${list[i].padEnd(14)}`);
      try{
        const c = await fetchSymbol(list[i], startMs, endMs);
        if(c.length){ candles[list[i]] = c; console.log(`${c.length} bars (~${((c[c.length - 1].t - c[0].t) / DAY).toFixed(1)}d)`); }
        else console.log('not available (skipped)');
      }catch(e){ console.log('FAILED: ' + e.message); }
    }
  }
  const symbols = Object.keys(candles).filter(s => s !== 'BTCUSDT');
  if(!symbols.length) throw new Error('No candle data downloaded.');
  const best = Math.max(...symbols.map(s => candles[s].length));
  const gotDays = best / 288;
  if(!A.synthetic && gotDays < A.days * 0.85) throw new Error(`Only ${gotDays.toFixed(1)}d of ${A.days}d came back — the proxy is still running the OLD server.js (5-day cap). Deploy the fixed server.js and re-run (use --refresh).`);
  const allT = symbols.flatMap(s => [candles[s][0].t, candles[s][candles[s].length - 1].t]);
  const dsPath = path.join(CACHE, `dataset_${A.exchange}_${A.days}d_${A.synthetic ? 'syn' : endMs}.json`);
  const settings = { exchange: A.exchange, riskPct: A.risk, leverage: A.lev, makerPct: A.maker, takerPct: A.taker, spreadPct: A.spread, fundingRatePct: 0, startingEquity: 10000, maxDailyLossPct: 15, dailyProfitTargetPct: 10 };
  fs.writeFileSync(dsPath, JSON.stringify({ candles, symbols, settings }));
  return { dsPath, symbols, t0: Math.min(...allT), t1: Math.max(...allT), settings };
}

// ---------------- configs ----------------
const BASE_OLD = { entryTimeframe: '15m', selectivity: 'off', minConfidence: 70, rewardRisk: 1.5, maxCostR: 1, minStopAtr: 1.2, trendFilter: 'any', setups: { A: true, B: false, C: false, D: false } };
function configs(){
  const B = (over) => ({ ...BASE_OLD, maxCostR: 0.18, ...over });   // "B" = new shipped default + overrides
  const list = [
    ['BASELINE (before the fix: no cost filter)', { ...BASE_OLD }],
    ['new default (cost filter 0.18R)', B({})],
  ];
  if(A.grid === 'full'){
    for(const selectivity of ['off', 'high']) for(const trendFilter of ['any', 'strong']) for(const maxCostR of [0.12, 0.18, 0.25, 1])
      for(const rewardRisk of [1.3, 1.5, 2]) for(const minStopAtr of [1.2, 1.6])
        list.push([`sel=${selectivity} trend=${trendFilter} cost<=${maxCostR} RR=${rewardRisk} stop>=${minStopAtr}ATR`, { ...BASE_OLD, selectivity, trendFilter, maxCostR, rewardRisk, minStopAtr }]);
    return list;
  }
  list.push(
    ['cost<=0.12R', B({ maxCostR: 0.12 })], ['cost<=0.25R', B({ maxCostR: 0.25 })],
    ['strong trend only', B({ trendFilter: 'strong' })], ['High selectivity', B({ selectivity: 'high' })],
    ['minConf 75', B({ minConfidence: 75 })], ['minConf 80', B({ minConfidence: 80 })],
    ['RR 1.3', B({ rewardRisk: 1.3 })], ['RR 1.75', B({ rewardRisk: 1.75 })], ['RR 2.0', B({ rewardRisk: 2 })],
    ['stop floor 1.5 ATR', B({ minStopAtr: 1.5 })], ['stop floor 1.8 ATR', B({ minStopAtr: 1.8 })],
    ['setups A+B', B({ setups: { A: true, B: true, C: false, D: false } })], ['setups A+C', B({ setups: { A: true, B: false, C: true, D: false } })],
    ['setups A+B+C', B({ setups: { A: true, B: true, C: true, D: false } })], ['setups A+B+C+D', B({ setups: { A: true, B: true, C: true, D: true } })],
    ['strong + High selectivity', B({ trendFilter: 'strong', selectivity: 'high' })],
    ['strong + stop 1.5', B({ trendFilter: 'strong', minStopAtr: 1.5 })],
    ['strong + cost<=0.12', B({ trendFilter: 'strong', maxCostR: 0.12 })],
    ['strong + stop 1.5 + RR 1.3', B({ trendFilter: 'strong', minStopAtr: 1.5, rewardRisk: 1.3 })],
    ['High + stop 1.5 + cost<=0.12', B({ selectivity: 'high', minStopAtr: 1.5, maxCostR: 0.12 })],
    ['5m entries (3x slower)', B({ entryTimeframe: '5m' })],
  );
  return list;
}

// ---------------- stats ----------------
function stats(trades){
  const n = trades.length;
  if(!n) return { n: 0 };
  const wins = trades.filter(t => t.netUsd > 0), losses = trades.filter(t => t.netUsd <= 0);
  const gw = wins.reduce((a, t) => a + t.netUsd, 0), gl = -losses.reduce((a, t) => a + t.netUsd, 0);
  const Rs = trades.map(t => t.R).filter(x => Number.isFinite(x));
  const avgR = Rs.length ? Rs.reduce((a, b) => a + b, 0) / Rs.length : null;
  const wr = wins.length / n;
  const aw = wins.length ? wins.reduce((a, t) => a + t.R, 0) / wins.length : 0, al = losses.length ? -losses.reduce((a, t) => a + t.R, 0) / losses.length : 0;
  return {
    n, wr, ci: 1.96 * Math.sqrt(wr * (1 - wr) / n), pf: gl > 0 ? gw / gl : (gw > 0 ? Infinity : 0), net: gw - gl, avgR,
    beWr: aw + al > 0 ? al / (aw + al) : null, longs: trades.filter(t => t.dir === 'LONG').length,
  };
}
const f1 = x => x == null ? '  -  ' : (x * 100).toFixed(1) + '%';
const f2 = x => x == null ? ' - ' : (Number.isFinite(x) ? x.toFixed(2) : '∞');
const usd = x => x == null ? '-' : (x >= 0 ? '+' : '-') + '$' + Math.abs(x).toFixed(0);

// ---------------- run ----------------
const ds = await buildDataset();
const cut = ds.t0 + (ds.t1 - ds.t0) * A.split;
const cfgs = configs();
console.log(`\n${ds.symbols.length} symbols · ${((ds.t1 - ds.t0) / DAY).toFixed(0)} days · ${cfgs.length} configs · ${A.jobs} workers`);
console.log(`TRAIN = before ${new Date(cut).toISOString().slice(0, 10)}   TEST = from ${new Date(cut).toISOString().slice(0, 10)} on (never used to rank)\n`);

const results = [];
await new Promise((resolve) => {
  let next = 0, done = 0;
  const startWorker = () => {
    const w = new Worker(path.join(__dir, 'quant-sweep-worker.mjs'), { workerData: { datasetPath: ds.dsPath } });
    const feed = () => { if(next < cfgs.length){ const i = next++; w.postMessage({ id: i, name: cfgs[i][0], over: cfgs[i][1] }); } else w.terminate(); };
    w.on('message', (m) => {
      done++;
      if(!m.ok){ console.log(`  ! ${m.name}: ${m.error.split('\n')[0]}`); }
      else{
        const tr = m.trades.filter(t => t.openedAtMs < cut), te = m.trades.filter(t => t.openedAtMs >= cut);
        results.push({ name: m.name, over: cfgs[m.id][1], all: stats(m.trades), train: stats(tr), test: stats(te), trades: m.trades.length });
        process.stdout.write(`\r  ${done}/${cfgs.length} done`);
      }
      if(done === cfgs.length) resolve(); else feed();
    });
    w.on('error', (e) => { console.log('\nworker error: ' + e.message); done++; if(done === cfgs.length) resolve(); });
    feed();
  };
  for(let k = 0; k < Math.min(A.jobs, cfgs.length); k++) startWorker();
});
console.log('\n');

// ---------------- report ----------------
const rank = results.slice().sort((a, b) => (b.train.n >= A.minTrain ? b.train.avgR : -9) - (a.train.n >= A.minTrain ? a.train.avgR : -9));
const cell = (s) => s.n ? `${String(s.n).padStart(3)}  ${f1(s.wr).padStart(6)}±${(s.ci * 100).toFixed(0).padStart(2)}  ${f2(s.avgR).padStart(5)}R  PF ${f2(s.pf).padStart(4)}  ${usd(s.net).padStart(7)}` : '  0';
console.log('config'.padEnd(46) + ' | ' + 'TRAIN  n   win%±ci  expect   PF       net'.padEnd(46) + ' | ' + 'TEST   n   win%±ci  expect   PF       net');
console.log('-'.repeat(146));
for(const r of rank) console.log(r.name.slice(0, 45).padEnd(46) + ' | ' + cell(r.train).padEnd(46) + ' | ' + cell(r.test));
const base = results.find(r => r.name.startsWith('BASELINE'));
const robust = rank.filter(r => r.train.n >= A.minTrain && r.test.n >= 10 && r.train.avgR > 0 && r.test.avgR > 0 && !r.name.startsWith('BASELINE'));
console.log('\n' + '='.repeat(60));
if(base) console.log(`Baseline (old behaviour): ${base.all.n} trades, win ${f1(base.all.wr)}, expectancy ${f2(base.all.avgR)}R, break-even win rate ~${f1(base.all.beWr)}`);
if(robust.length){
  console.log(`\nConfigs profitable on BOTH train and the untouched test slice (${robust.length}):`);
  for(const r of robust.slice(0, 5)) console.log(`  • ${r.name}\n    train ${r.train.n} trades ${f2(r.train.avgR)}R · test ${r.test.n} trades ${f2(r.test.avgR)}R · overall win ${f1(r.all.wr)} (break-even ~${f1(r.all.beWr)})\n    settings: ${JSON.stringify(r.over)}`);
}else console.log('\nNo config was profitable on both train and test with enough trades. That is a real result: on this period no tested variant showed a reliable edge.');
console.log(`
How to read this
  • expect = average R per trade AFTER fees/slippage. Positive is what matters; win% alone is not (at 1:1.5 the win rate must clear ~${f1(base && base.all.beWr != null ? base.all.beWr : 0.44)} just to break even).
  • ±ci = 95% uncertainty on the win rate from the sample size. A "60% win rate" from 25 trades is 60% ± 19.
  • With ${cfgs.length} configs tried on the same data, the top row is partly luck. Trust only rows that also hold on TEST, and re-run on a later period (node tools/quant-sweep.mjs --refresh) before changing live settings.
  • Fewer than ~30 trades in a column = anecdote, not evidence.`);
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const outFile = path.join(__dir, `sweep-results-${stamp}.json`);
fs.writeFileSync(outFile, JSON.stringify({ args: A, split: cut, results }, null, 2));
console.log(`\nSaved ${path.relative(process.cwd(), outFile)} — send this file (and the console output) back to review.`);
