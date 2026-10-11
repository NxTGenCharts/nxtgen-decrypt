// =============================================================
// bots.js — mounts the server-side Trading Bots on the Express app.
//
//   GET  /api/bots/status        (view)  vault state, which keys are saved, every bot, daily counters
//   GET  /api/bots/trades        (view)  closed-trade records the server booked (?since=<ms>)
//   POST /api/bots/keys          (admin) save/replace the SHARED key for one exchange+mode (verified first)
//   POST /api/bots/keys/delete   (admin) remove it (refused while a bot is still running on it)
//   POST /api/bots               (admin) hand a freshly-built bot to the server to deploy + manage
//   POST /api/bots/:id/stop | /pause | /resume | /rename | /delete   (admin)
//
// Auth is the same WORKER_TOKEN / WORKER_VIEW_TOKEN as /api/worker/* (fails closed when unset).
// Everything is POST/GET only so the server's existing CORS rules need no change.
// =============================================================
import express from 'express';
import { openBotStore } from './botVault.js';
import { createBotEngine, BOT_EXCHANGES, httpErr } from './botEngine.js';
import { requireRole } from './worker.js';

const PROXY_TIMEOUT_MS = 30_000;
const STORAGE_HINT = 'If you use Supabase, BOT_SUPABASE_KEY must be the SECRET key (sb_secret_… / service_role), not the public one — the public key can read but not write.';

export function attachBots(app, { baseUrl, internalKey, env = process.env, log = console, startEngine = true } = {}){
  // Where bots are saved. Render's free plan wipes its disk on every restart/spin-down, so on Render WITHOUT a database or
  // a mounted disk path we refuse to run bots rather than let them be forgotten while their orders sit on the exchange.
  const remote = env.BOT_SUPABASE_URL && env.BOT_SUPABASE_KEY ? { url: env.BOT_SUPABASE_URL, key: env.BOT_SUPABASE_KEY } : null;
  const ephemeral = !remote && !env.BOT_DATA_DIR && String(env.RENDER || '') === 'true';
  const disabledReason = ephemeral
    ? 'This Render service has no persistent storage for the bots: its disk is erased on every restart. Set BOT_SUPABASE_URL + BOT_SUPABASE_KEY (free database) or add a paid disk and set BOT_DATA_DIR.'
    : null;
  const store = openBotStore({ dir: env.BOT_DATA_DIR, vaultKey: env.BOT_VAULT_KEY, remote, disabledReason, log });
  const internalHeaders = { 'Content-Type': 'application/json', 'x-nxtgen-internal': internalKey || '' };

  // The engine calls this server's own /api/futures/* routes — exactly what the browser calls — in-process over loopback.
  async function callProxy(path, body){
    const res = await fetch(baseUrl + path, { method: 'POST', headers: internalHeaders, body: JSON.stringify(body), signal: AbortSignal.timeout(PROXY_TIMEOUT_MS) });
    const data = await res.json().catch(() => null);
    if(!data) throw new Error('Proxy returned an unreadable response.');
    return data;
  }
  async function fetchSnapshot(exchange, symbol, timeframe){
    const url = `${baseUrl}/api/futures/snapshot?exchange=${encodeURIComponent(exchange)}&symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(timeframe || '5m')}`;
    const res = await fetch(url, { headers: { 'x-nxtgen-internal': internalKey || '' }, signal: AbortSignal.timeout(PROXY_TIMEOUT_MS) });
    const data = await res.json().catch(() => null);
    if(!data || !data.ok) throw new Error((data && data.message) || 'Snapshot fetch failed.');
    return data.snapshot;
  }

  const engine = createBotEngine({ store, callProxy, fetchSnapshot, log });
  if(!store.enabled) log.warn && log.warn(`[bots] server-side bots are OFF: ${store.reason}`);
  if(startEngine){
    // start once the saved bots are loaded (immediate for a disk, after the first successful read for the database)
    store.ready.then(() => { if(store.enabled) engine.start(); else log.warn && log.warn(`[bots] not starting the engine: ${store.reason}`); });
  } else log.info && log.info('[bots] engine created but not started');

  const bigJson = express.json({ limit: '512kb' });
  const guard = (req, res, next) => (store.enabled) ? next()
    : res.status(503).json({ ok: false, code: 'vault_disabled', message: `Server-side bots are not enabled: ${store.reason} Fix this on the server (see server/README.md), then redeploy.` });
  const wrap = (fn) => async (req, res) => {
    try{ res.json({ ok: true, ...(await fn(req)) }); }
    catch(err){
      const status = err.status || 500;
      if(status >= 500) log.error && log.error('[bots]', err.message);
      res.status(status).json({ ok: false, message: err.message || 'Internal error.' });
    }
  };
  const credSummary = () => store.listCreds();
  const botView = (b) => b; // bots never contain secrets (keys live only in the vault)

  app.get('/api/bots/status', requireRole('view'), (req, res) => {
    const snap = engine.snapshot();
    res.json({
      ok: true, enabled: store.enabled, loading: store.loading, reason: store.reason, role: req.workerRole, serverTime: Date.now(),
      exchanges: BOT_EXCHANGES, creds: credSummary(), bots: snap.bots.map(botView), day: snap.day,
      storage: store.persistence, storageHealth: store.health,
    });
  });

  app.get('/api/bots/trades', requireRole('view'), (req, res) => {
    const since = Number(req.query.since) || 0;
    const list = store.state.trades.filter(t => (t.closedAtMs || 0) > since).slice(0, 1000);
    res.json({ ok: true, trades: list });
  });

  app.post('/api/bots/keys', requireRole('admin'), guard, bigJson, wrap(async (req) => {
    const { exchange, mode, apiKey, secretKey, passphrase } = req.body || {};
    if(!BOT_EXCHANGES.includes(exchange)) throw httpErr(400, 'Trading Bots support Bybit or Binance.');
    if(mode !== 'live' && mode !== 'demo') throw httpErr(400, 'Mode must be live or demo.');
    if(!apiKey || !secretKey) throw httpErr(400, 'apiKey and secretKey are required.');
    // Verify with the exchange before storing anything — the same check the API Keys tab does.
    const v = await callProxy('/api/verify', { exchange, mode, apiKey, secretKey, passphrase });
    if(v.rejected) throw httpErr(400, v.message || 'The exchange rejected this key.');
    if(!v.verified) throw httpErr(502, v.message || 'Could not reach the exchange to verify this key — try again.');
    await store.setCred(exchange, mode, { apiKey, secretKey, passphrase });
    // The key is held in memory either way; if it could not be written to storage, say so NOW instead of letting the page
    // report "saved" and then lose it (and every bot) at the next restart.
    if(store.health.failing) throw httpErr(503, `The key reached the server but could not be saved to its ${store.persistence} (${store.health.lastSaveError}). It will be forgotten when the server restarts. ${STORAGE_HINT}`);
    return { creds: credSummary() };
  }));

  app.post('/api/bots/keys/delete', requireRole('admin'), guard, bigJson, wrap(async (req) => {
    const { exchange, mode } = req.body || {};
    const busy = store.state.tradingBots.some(b => b.exchange === exchange && b.mode === mode && (b.status === 'active' || b.status === 'deploying'));
    if(busy) throw httpErr(409, `A bot is still running on ${exchange} ${mode} — stop it first, or it would be left unmanaged.`);
    store.deleteCred(exchange, mode);
    return { creds: credSummary() };
  }));

  app.post('/api/bots', requireRole('admin'), guard, bigJson, wrap(async (req) => {
    // Never take a bot we could not remember: after a restart it would still be trading on the exchange with nothing managing it.
    const w = await store.verifyWrite();
    if(!w.ok) throw httpErr(503, `The server can't save bots right now (${w.message}), so it won't take this one — it would be forgotten on the next restart while its orders sat on the exchange. ${STORAGE_HINT}`);
    const bot = engine.handoff(req.body && req.body.bot, req.body && req.body.limits);
    return { bot: botView(bot) };
  }));

  const botAction = (name, fn) => app.post(`/api/bots/:id/${name}`, requireRole('admin'), guard, bigJson, wrap(async (req) => fn(req)));
  botAction('stop', async (req) => { await engine.stopBot(req.params.id); return { bot: botView(engine.getBot(req.params.id)) }; });
  botAction('pause', async (req) => ({ bot: botView(await engine.pauseBot(req.params.id)) }));
  botAction('resume', async (req) => ({ bot: botView(await engine.resumeBot(req.params.id)) }));
  botAction('rename', async (req) => ({ bot: botView(engine.renameBot(req.params.id, req.body && req.body.nickname)) }));
  botAction('delete', async (req) => { engine.removeBot(req.params.id); return {}; });

  const shutdown = () => { try{ engine.shutdown(); }catch(_){ /* exiting anyway */ } };
  // Flush bots + trades to disk on a deploy/stop signal. A listener disables Node's default exit, so exit explicitly.
  process.once('SIGTERM', () => { shutdown(); process.exit(0); });
  process.once('SIGINT', () => { shutdown(); process.exit(0); });
  return { engine, store, shutdown };
}
