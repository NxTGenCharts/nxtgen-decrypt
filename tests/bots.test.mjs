// =============================================================
// Server-side Trading Bots — regression tests.   Run:  node tests/bots.test.mjs
// (Node 22+; no dependencies, no network, no browser.)
//
// What this proves: the bot engine places, manages, books and survives a restart ON ITS OWN —
// nothing here calls a browser or a UI function. It runs against a small simulated Bybit
// (below) behind the same /api/futures/* paths the real server exposes.
// What it does NOT prove: that the real Bybit/Binance endpoints behave like this simulator.
// Test on Demo with a small amount first.
// =============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openBotStore } from '../server/botVault.js';
import { createBotEngine } from '../server/botEngine.js';
import { buildManualGridPlan } from '../js/futures/grid.js';

const VAULT_KEY = 'k'.repeat(40);
const KEYS = { apiKey: 'AKIA-TEST-API-KEY-1234', secretKey: 'super-secret-signing-key-xyz', passphrase: '' };
const quiet = { warn(){}, error(){}, info(){} };

// ---------------- simulated exchange ----------------
function candles(price, n = 40){
  return Array.from({ length: n }, (_, i) => ({ t: Date.now() - (n - i) * 300_000, o: price, h: price * 1.001, l: price * 0.999, c: price, v: 1000 }));
}
function makeExchange(startPrice){
  const ex = { price: startPrice, orders: new Map(), long: null, short: null, rows: [], seq: 1, tagPrice: {}, calls: [], fills: new Map(), dca: { size: 0, avg: 0, tp: null, sl: null, dir: null }, closedDca: null };
  const id = () => String(ex.seq++);
  ex.snapshot = () => ({ price: ex.price, m5: candles(ex.price), m15: candles(ex.price), h1: candles(ex.price), meta: { fundingRatePct: 0.01, spreadPct: 0.02 } });
  ex.step = (price) => { // move the market and fill whatever it crosses
    ex.price = price;
    for(const o of [...ex.orders.values()]){
      if(o.kind === 'entry' && ((o.direction === 'LONG' && price <= o.price) || (o.direction === 'SHORT' && price >= o.price))){
        ex.orders.delete(o.id); ex.fills.set(o.id, Date.now());
        ex[o.direction.toLowerCase()] = { size: (ex[o.direction.toLowerCase()]?.size || 0) + o.qty, avg: o.price };
      } else if(o.kind === 'close' && ((o.direction === 'LONG' && price >= o.price) || (o.direction === 'SHORT' && price <= o.price))){
        ex.orders.delete(o.id);
        const pnl = (o.direction === 'LONG' ? o.price - o.entry : o.entry - o.price) * o.qty - 0.05;
        ex.rows.push({ orderId: o.id, side: o.direction === 'LONG' ? 'Sell' : 'Buy', closedPnl: pnl, createdTime: Date.now(), avgEntryPrice: o.entry, avgExitPrice: o.price, qty: o.qty, feesUsd: -0.05 });
        const k = o.direction.toLowerCase(); if(ex[k]) ex[k].size = Math.max(0, ex[k].size - o.qty);
      }
    }
    // DCA position take-profit
    if(ex.dca.size > 0 && ex.dca.tp != null){
      const hit = ex.dca.dir === 'LONG' ? price >= ex.dca.tp : price <= ex.dca.tp;
      if(hit){
        const pnl = (ex.dca.dir === 'LONG' ? ex.dca.tp - ex.dca.avg : ex.dca.avg - ex.dca.tp) * ex.dca.size;
        ex.closedDca = { closedPnl: pnl, grossPnl: pnl + 0.1, feesUsd: -0.1, avgEntryPrice: ex.dca.avg, avgExitPrice: ex.dca.tp, pnlSource: 'exchange' };
        ex.dca.size = 0;
      }
    }
  };
  ex.call = async (p, b) => {
    ex.calls.push(p);
    switch(p){
      case '/api/futures/grid/ensure-mode': return { ok: true, hedgeModeReady: true };
      case '/api/futures/grid/place-level': { const o = { id: id(), kind: 'entry', direction: b.direction, price: b.price, qty: b.qty }; ex.tagPrice[b.orderLinkTag] = b.price; ex.orders.set(o.id, o); return { ok: true, orderId: o.id }; }
      case '/api/futures/grid/place-close': { const o = { id: id(), kind: 'close', direction: b.direction, price: b.price, qty: b.qty, entry: ex.tagPrice[b.orderLinkTag] ?? b.price }; ex.orders.set(o.id, o); return { ok: true, orderId: o.id }; }
      case '/api/futures/grid/set-side-stop': return { ok: true };
      case '/api/futures/grid/orders': return { ok: true, list: [...ex.orders.values()].map(o => ({ orderId: o.id })) };
      case '/api/futures/grid/positions': return { ok: true, long: { size: ex.long?.size || 0, unrealisedPnl: 0 }, short: { size: ex.short?.size || 0, unrealisedPnl: 0 } };
      case '/api/futures/grid/closed-pnl': return { ok: true, list: ex.rows };
      case '/api/futures/grid/fill-times': return { ok: true, list: [...ex.fills].map(([orderId, filledAtMs]) => ({ orderId, filledAtMs })) };
      case '/api/futures/grid/flatten': ex.orders.clear(); ex.long = ex.short = null; return { ok: true };
      case '/api/futures/available-margin': return { ok: true, available: 100000 };
      case '/api/futures/balance': return { ok: true, balance: 10000 };
      case '/api/futures/dca/place': {
        if(b.orderType === 'MARKET'){ ex.dca = { size: b.qty, avg: ex.price, tp: null, sl: null, dir: b.direction }; return { ok: true, orderId: id() }; }
        const o = { id: id(), kind: 'so', direction: b.direction, price: b.price, qty: b.qty }; ex.orders.set(o.id, o); return { ok: true, orderId: o.id };
      }
      case '/api/futures/dca/set-tp': ex.dca.tp = b.takeProfitPrice; ex.dca.sl = b.stopLossPrice; return { ok: true, tpAlgoId: 'tp1', slAlgoId: 'sl1' };
      case '/api/futures/dca/orders': return { ok: true, list: [...ex.orders.values()].map(o => ({ orderId: o.id })) };
      case '/api/futures/dca/flatten': ex.orders.clear(); ex.dca.size = 0; return { ok: true };
      case '/api/futures/position':
        if(ex.dca.size > 0) return { ok: true, open: true, position: { avgPrice: ex.dca.avg, size: ex.dca.size, unrealisedPnl: 0 } };
        return { ok: true, open: false, closed: ex.closedDca };
      default: return { ok: false, message: `sim: unhandled ${p}` };
    }
  };
  return ex;
}

function setup({ dir, price = 100 } = {}){
  const d = dir || fs.mkdtempSync(path.join(os.tmpdir(), 'nxbots-'));
  const store = openBotStore({ dir: d, vaultKey: VAULT_KEY, log: quiet, writeDelayMs: 5 });
  const ex = makeExchange(price);
  const engine = createBotEngine({ store, callProxy: ex.call, fetchSnapshot: async () => ex.snapshot(), log: quiet, cycleMs: 3_600_000 });
  return { dir: d, store, ex, engine };
}

function gridBot(over = {}){
  const plan = buildManualGridPlan({ symbol: 'ABCUSDT', direction: 'NEUTRAL', upper: 110, lower: 90, levelCount: 6, leverage: 5, investmentUsd: 600 });
  return { id: 'BOT-GRID-1700000000000-ab12', type: 'grid', exchange: 'bybit', mode: 'demo', symbol: 'ABCUSDT', direction: 'NEUTRAL', leverage: 5, investmentUsd: 600,
    config: { maxLossPct: 20, profitTargetPct: 10, levelCount: 6, leverage: 5 }, plan, ...over };
}
const dcaBot = (over = {}) => ({ id: 'BOT-DCA-1700000000001-cd34', type: 'dca', exchange: 'bybit', mode: 'demo', symbol: 'XYZUSDT', direction: 'LONG', leverage: 5,
  config: { baseOrderUsd: 50, safetyOrderUsd: 25, maxSafetyOrders: 3, priceDeviationPct: 2, stepScale: 1.2, volumeScale: 1.3, takeProfitPct: 3, stopLossPct: 10, leverage: 5 }, ...over });

// ---------------- vault ----------------
test('API keys are encrypted at rest, restored after a restart, and never written in plain text', () => {
  const { dir, store } = setup();
  store.setCred('bybit', 'demo', KEYS);
  const onDisk = fs.readFileSync(path.join(dir, 'bots.json'), 'utf8');
  assert.ok(!onDisk.includes(KEYS.secretKey) && !onDisk.includes(KEYS.apiKey), 'plain key found on disk');
  const again = openBotStore({ dir, vaultKey: VAULT_KEY, log: quiet });
  assert.deepEqual(again.getCred('bybit', 'demo'), KEYS);
  assert.equal(again.listCreds()[0].last4, '1234');
  const wrong = openBotStore({ dir, vaultKey: 'x'.repeat(40), log: quiet });
  assert.equal(wrong.getCred('bybit', 'demo'), null, 'a wrong BOT_VAULT_KEY must not read the keys');
  assert.equal(fs.statSync(path.join(dir, 'bots.json')).mode & 0o077, 0, 'file should be owner-only');
});

test('without a 32+ character BOT_VAULT_KEY the vault is disabled and refuses to store keys', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'nxbots-'));
  for(const k of ['', 'short']){
    const s = openBotStore({ dir: d, vaultKey: k, log: quiet });
    assert.equal(s.enabled, false);
    assert.throws(() => s.setCred('bybit', 'demo', KEYS));
  }
});

// ---------------- grid ----------------
test('a grid bot deploys, fills, takes profit and re-arms with no browser involved', async () => {
  const { store, ex, engine } = setup({ price: 100 });
  store.setCred('bybit', 'demo', KEYS);
  const bot = engine.handoff(gridBot());
  await engine.deploying.get(bot.id);
  assert.equal(bot.status, 'active', bot.statusMessage);
  assert.ok(bot.runtime.levels.length >= 3, 'levels should be resting');
  const resting = ex.orders.size;
  assert.equal(resting, bot.runtime.levels.length);

  // price drops through the lowest long levels -> entries fill
  ex.step(92);
  await engine.runCycle();
  const open = bot.runtime.levels.filter(l => l.status === 'PENDING_CLOSE');
  assert.ok(open.length >= 1, 'a filled entry should get its take-profit order placed');

  // price recovers -> take-profits fill -> the cycle is booked and the level re-arms
  ex.step(106);
  await engine.runCycle();
  assert.ok(store.state.trades.length >= 1, 'a closed cycle should be booked');
  assert.ok(bot.realizedUsd > 0, `realized should be positive, got ${bot.realizedUsd}`);
  assert.equal(store.state.trades[0].setupType, 'Trading Bot: Grid');
  assert.equal(store.state.trades[0].pnlSource, 'exchange');
  assert.ok(bot.runtime.lastTickAtMs > 0);
});

test('bots survive a server restart: state is reloaded and management simply continues', async () => {
  const a = setup({ price: 100 });
  a.store.setCred('bybit', 'demo', KEYS);
  const bot = a.engine.handoff(gridBot());
  await a.engine.deploying.get(bot.id);
  a.ex.step(92); await a.engine.runCycle();
  const levelsBefore = JSON.stringify(bot.runtime.levels);
  a.store.close(); // process exits

  const store2 = openBotStore({ dir: a.dir, vaultKey: VAULT_KEY, log: quiet, writeDelayMs: 5 });
  const engine2 = createBotEngine({ store: store2, callProxy: a.ex.call, fetchSnapshot: async () => a.ex.snapshot(), log: quiet, cycleMs: 3_600_000 });
  engine2.start(); engine2.shutdown();
  const revived = store2.state.tradingBots[0];
  assert.equal(revived.status, 'active');
  assert.equal(JSON.stringify(revived.runtime.levels), levelsBefore);
  assert.ok(store2.getCred('bybit', 'demo'), 'keys come back too');
  a.ex.step(106); await engine2.runCycle();
  assert.ok(revived.realizedUsd > 0, 'the revived bot keeps trading');
});

test('a bot caught mid-deployment by a restart is flagged, not silently resumed', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'nxbots-'));
  const s1 = openBotStore({ dir: d, vaultKey: VAULT_KEY, log: quiet, writeDelayMs: 5 });
  s1.state.tradingBots.push({ id: 'BOT-GRID-1-aaaa', type: 'grid', status: 'deploying', runtime: {} });
  s1.touch(); s1.close();
  const s2 = openBotStore({ dir: d, vaultKey: VAULT_KEY, log: quiet });
  const e2 = createBotEngine({ store: s2, callProxy: async () => ({ ok: false }), fetchSnapshot: async () => null, log: quiet, cycleMs: 3_600_000 });
  e2.start(); e2.shutdown();
  assert.equal(s2.state.tradingBots[0].status, 'error');
  assert.match(s2.state.tradingBots[0].statusMessage, /restarted while this bot was deploying/);
});

test('stop flattens the exchange and marks the bot stopped', async () => {
  const { store, ex, engine } = setup({ price: 100 });
  store.setCred('bybit', 'demo', KEYS);
  const bot = engine.handoff(gridBot());
  await engine.deploying.get(bot.id);
  await engine.stopBot(bot.id);
  assert.equal(bot.status, 'stopped');
  assert.ok(bot.stoppedAtMs > 0);
  assert.equal(ex.orders.size, 0, 'every resting order cancelled');
});

test('pause flattens and parks; resume redeploys fresh', async () => {
  const { store, ex, engine } = setup({ price: 100 });
  store.setCred('bybit', 'demo', KEYS);
  const bot = engine.handoff(gridBot());
  await engine.deploying.get(bot.id);
  await engine.pauseBot(bot.id);
  assert.equal(bot.paused, true);
  assert.equal(ex.orders.size, 0);
  const before = ex.calls.length;
  await engine.runCycle();
  assert.equal(ex.calls.length, before, 'a paused bot is not managed');
  await engine.resumeBot(bot.id);
  assert.equal(bot.paused, false);
  assert.equal(bot.status, 'active', bot.statusMessage);
  assert.ok(ex.orders.size > 0);
});

// ---------------- DCA ----------------
test('a DCA bot opens, sets its take-profit, and books the close by itself', async () => {
  const { store, ex, engine } = setup({ price: 50 });
  store.setCred('bybit', 'demo', KEYS);
  const bot = engine.handoff(dcaBot());
  await engine.deploying.get(bot.id);
  assert.equal(bot.status, 'active', bot.statusMessage);
  assert.ok(ex.dca.tp > 50, 'take-profit set above entry for a LONG');
  assert.equal(bot.runtime.safetyOrders.length, 3);
  await engine.runCycle();
  assert.equal(bot.status, 'active');

  ex.step(ex.dca.tp + 0.01);
  await engine.runCycle();
  assert.equal(bot.status, 'closed');
  assert.ok(bot.realizedUsd > 0);
  const t = store.state.trades[0];
  assert.equal(t.setupType, 'Trading Bot: DCA');
  assert.ok(t.feesUsd > 0, 'fees are stored as a positive cost');
});

// ---------------- safety / validation ----------------
test('hand-off refuses bad input, missing keys, duplicates and a halted day', async () => {
  const { store, engine } = setup();
  assert.throws(() => engine.handoff(gridBot()), /no saved bybit demo API key/);
  store.setCred('bybit', 'demo', KEYS);
  assert.throws(() => engine.handoff({ ...gridBot(), plan: { levels: [1] } }), /plan is missing or invalid/);
  assert.throws(() => engine.handoff({ ...gridBot(), exchange: 'mexc' }), /Bybit or Binance/);
  assert.throws(() => engine.handoff({ ...gridBot(), id: 'x' }), /Bad bot id/);
  assert.throws(() => engine.handoff({ ...dcaBot(), config: {} }), /base order/);
  const ok = engine.handoff(gridBot());
  await engine.deploying.get(ok.id);
  assert.throws(() => engine.handoff(gridBot({ id: 'BOT-GRID-1700000000009-zz99' })), /already has a running bot/);
  store.state.tbDailyHalted = true; store.state.tbDailyHaltMessage = 'test halt';
  assert.throws(() => engine.handoff(dcaBot()), /Paused for today/);
});

test('delete is refused while a bot runs, allowed once stopped; trade history is kept', async () => {
  const { store, ex, engine } = setup({ price: 100 });
  store.setCred('bybit', 'demo', KEYS);
  const bot = engine.handoff(gridBot());
  await engine.deploying.get(bot.id);
  assert.throws(() => engine.removeBot(bot.id), /Stop this bot/);
  ex.step(92); await engine.runCycle(); ex.step(106); await engine.runCycle();
  const trades = store.state.trades.length;
  await engine.stopBot(bot.id);
  engine.removeBot(bot.id);
  assert.equal(store.state.tradingBots.length, 0);
  assert.equal(store.state.trades.length, trades);
});
