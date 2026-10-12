// =============================================================
// bots.js — mounts the server-side Trading Bots on the Express app.
//
// Two ways in (see auth.js):
//   * an ACCOUNT session (Authorization: Bearer <Supabase JWT>) — each account gets its own store + engine, so bots, trades and
//     exchange keys are private to it and the same on every device the user signs in from;
//   * the original shared WORKER_TOKEN — still works, against the original single-owner store, until an account claims it.
//
//   GET  /api/bots/status        (view)  vault state, which keys are saved, every bot, daily counters
//   GET  /api/bots/trades        (view)  closed-trade records the server booked (?since=<ms>)
//   POST /api/bots/keys          (admin) save/replace the SHARED key for one exchange+mode (verified first)
//   POST /api/bots/keys/delete   (admin) remove it (refused while a bot is still running on it)
//   POST /api/bots               (admin) hand a freshly-built bot to the server to deploy + manage
//   POST /api/bots/:id/stop | /pause | /resume | /rename | /delete   (admin)
//
//   GET  /api/account/me         (account) who am I, and is there pre-account data I can claim
//   GET  /api/account/keys       (account) which exchange keys are saved on my account (masked — never the secret)
//   POST /api/account/keys/test  (account) re-check one saved key with a READ-ONLY balance call (never places an order)
//   POST /api/account/delete     (account) delete my account: refused while a bot is running; then erases my keys, bots, trades and login
//   POST /api/account/claim-legacy (account + WORKER_TOKEN) move the pre-account bots, trades and keys into my account
//
// Auth is the same WORKER_TOKEN / WORKER_VIEW_TOKEN as /api/worker/* (fails closed when unset).
// Everything is POST/GET only so the server's existing CORS rules need no change.
// =============================================================
import express from 'express';
import { openBotStore, listStoredUsers } from './botVault.js';
import { createAuth } from './auth.js';
import { createBotEngine, BOT_EXCHANGES, KEY_EXCHANGES, httpErr } from './botEngine.js';
import { requireRole } from './worker.js';

const PROXY_TIMEOUT_MS = 30_000;
const STORAGE_HINT = 'If you use Supabase, BOT_SUPABASE_KEY must be the SECRET key (sb_secret_… / service_role), not the public one — the public key can read but not write.';

export function attachBots(app, { baseUrl, internalKey, env = process.env, log = console, startEngine = true, auth = createAuth({ env, log }) } = {}){
  // Where bots are saved. Render's free plan wipes its disk on every restart/spin-down, so on Render WITHOUT a database or
  // a mounted disk path we refuse to run bots rather than let them be forgotten while their orders sit on the exchange.
  const remote = env.BOT_SUPABASE_URL && env.BOT_SUPABASE_KEY ? { url: env.BOT_SUPABASE_URL, key: env.BOT_SUPABASE_KEY } : null;
  const ephemeral = !remote && !env.BOT_DATA_DIR && String(env.RENDER || '') === 'true';
  const disabledReason = ephemeral
    ? 'This Render service has no persistent storage for the bots: its disk is erased on every restart. Set BOT_SUPABASE_URL + BOT_SUPABASE_KEY (free database) or add a paid disk and set BOT_DATA_DIR.'
    : null;
  const MAX_USERS = Math.max(1, Number(env.BOT_MAX_USERS) || 25);   // every account runs its own 8-second engine loop — keep a small server honest
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

  const makeStore = (userId) => openBotStore({ dir: env.BOT_DATA_DIR, vaultKey: env.BOT_VAULT_KEY, remote, disabledReason, log, userId });
  const makeEngine = (store) => createBotEngine({ store, callProxy, fetchSnapshot, log });
  const startWhenReady = (ctx) => { if(startEngine) ctx.store.ready.then(() => { if(ctx.store.enabled) ctx.engine.start(); else log.warn && log.warn(`[bots] not starting the engine: ${ctx.store.reason}`); }); };

  // ---- the original single-owner store (the shared-token path). Kept running so nothing stops while accounts are rolled out.
  const legacy = { store: makeStore(null) };
  legacy.engine = makeEngine(legacy.store);
  const store = legacy.store, engine = legacy.engine;   // returned for callers/tests that only know the single-owner shape
  if(!store.enabled) log.warn && log.warn(`[bots] server-side bots are OFF: ${store.reason}`);
  if(startEngine) startWhenReady(legacy); else log.info && log.info('[bots] engine created but not started');
  const legacyClaimed = () => !!legacy.store.state.claimedBy;

  // ---- account stores: one {store, engine} per signed-in user, created on first use and at boot for everyone with saved data
  const users = new Map();   // userId -> Promise<ctx>
  function userCtx(userId){
    if(!users.has(userId)){
      if(users.size >= MAX_USERS) throw httpErr(503, `This server is at its limit of ${MAX_USERS} accounts. Ask the owner to raise BOT_MAX_USERS (and check the plan's CPU).`);
      const p = (async () => {
        const st = makeStore(userId);
        const ctx = { userId, store: st, engine: makeEngine(st) };
        await st.ready;
        startWhenReady(ctx);
        return ctx;
      })();
      p.catch(() => users.delete(userId));
      users.set(userId, p);
    }
    return users.get(userId);
  }
  // Resume every account's bots after a restart without waiting for anyone to sign in.
  if(auth.enabled && startEngine){
    (async () => {
      for(let attempt = 0; ; attempt++){
        try{ for(const id of await listStoredUsers({ dir: env.BOT_DATA_DIR, remote, log })) await userCtx(id).catch(e => log.error && log.error(`[accounts] ${id}: ${e.message}`)); return; }
        catch(_){ await new Promise(r => setTimeout(r, Math.min(60_000, 5_000 * (attempt + 1)))); }
      }
    })();
  }
  // auth.js asks for the real credential behind a "srv:<exchange>:<mode>" placeholder
  auth.setCredResolver(async (userId, exchange, mode) => { const c = await userCtx(userId); return c.store.enabled ? c.store.getCred(exchange, mode) : null; });

  const bigJson = express.json({ limit: '512kb' });

  // Who is calling, and whose store do they get?  Account session first; otherwise the original shared token.
  const access = (min) => async (req, res, next) => {
    try{
      if(auth.enabled && auth.hasBearer(req)){
        const user = await auth.userFromReq(req);
        if(!user) return res.status(401).json({ ok: false, code: 'unauthorized', message: 'Please sign in again.' });
        req.user = user; req.workerRole = 'admin'; req.ctx = await userCtx(user.id);
        return next();
      }
      if(legacyClaimed() || (auth.enabled && String(env.ACCOUNTS_REQUIRED || '') === 'true')){
        return res.status(401).json({ ok: false, code: 'use_account', message: 'This server now uses accounts — sign in instead of using the shared access token.' });
      }
      return requireRole(min)(req, res, () => { req.ctx = legacy; next(); });
    }catch(e){ res.status(e.status || 503).json({ ok: false, code: e.code, message: e.message || 'Could not check your session.' }); }
  };
  const guard = (req, res, next) => (req.ctx.store.enabled) ? next()
    : res.status(503).json({ ok: false, code: 'vault_disabled', message: `Server-side bots are not enabled: ${req.ctx.store.reason} Fix this on the server (see server/README.md), then redeploy.` });
  const wrap = (fn) => async (req, res) => {
    try{ res.json({ ok: true, ...(await fn(req)) }); }
    catch(err){
      const status = err.status || 500;
      if(status >= 500) log.error && log.error('[bots]', err.message);
      res.status(status).json({ ok: false, message: err.message || 'Internal error.' });
    }
  };
  const credSummary = (ctx) => ctx.store.listCreds();
  const botView = (b) => b; // bots never contain secrets (keys live only in the vault)

  app.get('/api/bots/status', access('view'), (req, res) => {
    const { store, engine } = req.ctx;
    const snap = engine.snapshot();
    res.json({
      ok: true, enabled: store.enabled, loading: store.loading, reason: store.reason, role: req.workerRole, serverTime: Date.now(),
      account: req.user ? { id: req.user.id, email: req.user.email } : null,
      exchanges: BOT_EXCHANGES, creds: credSummary(req.ctx), bots: snap.bots.map(botView), day: snap.day,
      storage: store.persistence, storageHealth: store.health,
    });
  });

  app.get('/api/bots/trades', access('view'), (req, res) => {
    const since = Number(req.query.since) || 0;
    const list = req.ctx.store.state.trades.filter(t => (t.closedAtMs || 0) > since).slice(0, 1000);
    res.json({ ok: true, trades: list });
  });

  app.post('/api/bots/keys', access('admin'), guard, bigJson, wrap(async (req) => {
    const { store } = req.ctx;
    const { exchange, mode, apiKey, secretKey, passphrase } = req.body || {};
    if(!KEY_EXCHANGES.includes(exchange)) throw httpErr(400, 'That exchange is not supported.');
    if(mode !== 'live' && mode !== 'demo') throw httpErr(400, 'Mode must be live or demo.');
    if(!apiKey || !secretKey) throw httpErr(400, 'apiKey and secretKey are required.');
    if(exchange === 'bitget' && !passphrase) throw httpErr(400, 'Bitget also needs the API passphrase.');
    if(String(apiKey).startsWith('srv:')) throw httpErr(400, 'That key is already saved on your account.');
    // Verify with the exchange before storing anything — the same read-only check the API Keys tab always did.
    const v = await callProxy('/api/verify', { exchange, mode, apiKey, secretKey, passphrase });
    if(v.rejected) throw httpErr(400, v.message || 'The exchange rejected this key.');
    if(!v.verified) throw httpErr(502, v.message || 'Could not reach the exchange to verify this key — try again.');
    await store.setCred(exchange, mode, { apiKey, secretKey, passphrase }, { verifiedAt: Date.now() });
    // The key is held in memory either way; if it could not be written to storage, say so NOW instead of letting the page
    // report "saved" and then lose it (and every bot) at the next restart.
    if(store.health.failing) throw httpErr(503, `The key reached the server but could not be saved to its ${store.persistence} (${store.health.lastSaveError}). It will be forgotten when the server restarts. ${STORAGE_HINT}`);
    return { creds: credSummary(req.ctx), balance: v.balance != null ? v.balance : null };
  }));

  app.post('/api/bots/keys/delete', access('admin'), guard, bigJson, wrap(async (req) => {
    const { store } = req.ctx;
    const { exchange, mode } = req.body || {};
    const busy = store.state.tradingBots.some(b => b.exchange === exchange && b.mode === mode && (b.status === 'active' || b.status === 'deploying'));
    if(busy) throw httpErr(409, `A bot is still running on ${exchange} ${mode} — stop it first, or it would be left unmanaged.`);
    store.deleteCred(exchange, mode);
    return { creds: credSummary(req.ctx) };
  }));

  app.post('/api/bots', access('admin'), guard, bigJson, wrap(async (req) => {
    // Never take a bot we could not remember: after a restart it would still be trading on the exchange with nothing managing it.
    const w = await req.ctx.store.verifyWrite();
    if(!w.ok) throw httpErr(503, `The server can't save bots right now (${w.message}), so it won't take this one — it would be forgotten on the next restart while its orders sat on the exchange. ${STORAGE_HINT}`);
    const bot = req.ctx.engine.handoff(req.body && req.body.bot, req.body && req.body.limits);
    return { bot: botView(bot) };
  }));

  const botAction = (name, fn) => app.post(`/api/bots/:id/${name}`, access('admin'), guard, bigJson, wrap(async (req) => fn(req)));
  botAction('stop', async (req) => { await req.ctx.engine.stopBot(req.params.id); return { bot: botView(req.ctx.engine.getBot(req.params.id)) }; });
  botAction('pause', async (req) => ({ bot: botView(await req.ctx.engine.pauseBot(req.params.id)) }));
  botAction('resume', async (req) => ({ bot: botView(await req.ctx.engine.resumeBot(req.params.id)) }));
  botAction('rename', async (req) => ({ bot: botView(req.ctx.engine.renameBot(req.params.id, req.body && req.body.nickname)) }));
  botAction('delete', async (req) => { req.ctx.engine.removeBot(req.params.id); return {}; });

  // ---------------- account routes ----------------
  const legacyHasData = () => !legacyClaimed() && legacy.store.enabled && (legacy.store.state.tradingBots.length > 0 || legacy.store.listCreds().length > 0 || legacy.store.state.trades.length > 0);
  const deploying = (ctx) => !!(ctx.engine.deploying && ctx.engine.deploying.size);
  const accountCtx = async (req, res, next) => { try{ req.ctx = await userCtx(req.user.id); next(); }catch(e){ res.status(e.status || 503).json({ ok: false, message: e.message }); } };

  app.get('/api/account/me', auth.requireUser, accountCtx, (req, res) => {
    const { store } = req.ctx;
    res.json({ ok: true, user: req.user, serverMode: { enabled: store.enabled, loading: store.loading, reason: store.reason }, legacyAvailable: legacyHasData() });
  });

  // Masked list only: exchange, mode, last 4 characters, fingerprint. The secret never leaves the server.
  app.get('/api/account/keys', auth.requireUser, accountCtx, (req, res) => {
    const { store } = req.ctx;
    res.json({ ok: true, enabled: store.enabled, loading: store.loading, reason: store.reason, creds: credSummary(req.ctx) });
  });

  // Re-checks one saved key against its exchange. This is the same READ-ONLY balance request /api/verify always made — it can never
  // place or cancel an order. Only the owner's own session reaches their own vault (accountCtx), so there is no id to tamper with.
  const lastTest = new Map();   // `${userId}:${exchange}:${mode}` -> ms, so a stuck "Test" button cannot hammer the exchange
  app.post('/api/account/keys/test', auth.requireUser, accountCtx, guard, bigJson, wrap(async (req) => {
    const { store } = req.ctx;
    const { exchange, mode } = req.body || {};
    if(!KEY_EXCHANGES.includes(exchange) || (mode !== 'live' && mode !== 'demo')) throw httpErr(400, 'Choose an exchange and a network (live or demo).');
    const cred = store.getCred(exchange, mode);
    if(!cred) throw httpErr(404, `No ${exchange} ${mode} key is saved on your account.`);
    const k = `${req.user.id}:${exchange}:${mode}`, now = Date.now();
    if(now - (lastTest.get(k) || 0) < 3_000) throw httpErr(429, 'Please wait a few seconds before testing this connection again.');
    lastTest.set(k, now); if(lastTest.size > 500) lastTest.clear();
    const v = await callProxy('/api/verify', { exchange, mode, apiKey: cred.apiKey, secretKey: cred.secretKey, passphrase: cred.passphrase || '' });
    if(v.verified) store.markVerified(exchange, mode, now);
    return {
      verified: !!v.verified, rejected: !!v.rejected, balance: v.verified && v.balance != null ? v.balance : null,
      // A short, safe diagnostic: what the exchange said about the key — never any credential material.
      message: v.verified ? 'The exchange confirmed this key.' : (String(v.message || (v.rejected ? 'The exchange rejected this key.' : 'Could not reach the exchange.')).slice(0, 240)),
      checkedAt: now, creds: credSummary(req.ctx),
    };
  }));

  // Account deletion. POLICY (the engine has no "close everything and walk away" for a whole account, and silently flattening a
  // user's positions in the same click as deleting the login would be a trading decision they did not make):
  //   1. refused while any bot is running or still deploying — the user stops it first, through the normal Stop, which cancels its
  //      orders and closes its position and books the result;
  //   2. the user must type their own email;
  //   3. only then: the engine is stopped, every saved key + bot + trade row is erased, and the login itself is removed.
  // Order matters: stored data is erased BEFORE the login, so a failure leaves a working account to retry from, never an orphan.
  const adminKey = String(env.SUPABASE_SERVICE_KEY || env.BOT_SUPABASE_KEY || '').trim();
  const supaUrl = String(env.BOT_SUPABASE_URL || '').trim().replace(/\/$/, '');
  const running = (ctx) => ctx.store.state.tradingBots.filter(b => b.status === 'deploying' || (b.status === 'active' && !b.paused));
  app.post('/api/account/delete', auth.requireUser, accountCtx, bigJson, wrap(async (req) => {
    const ctx = req.ctx, { store } = ctx;
    const typed = String((req.body && req.body.confirmEmail) || '').trim().toLowerCase();
    if(!typed || typed !== String(req.user.email || '').toLowerCase()) throw httpErr(400, 'Type your account email exactly to confirm.');
    if(!store.enabled) throw httpErr(503, `Your stored data can't be reached right now (${store.reason || 'storage unavailable'}), so nothing was deleted. Try again shortly.`);
    if(deploying(ctx) || running(ctx).length){
      const n = running(ctx).length;
      throw httpErr(409, `${n} bot${n === 1 ? ' is' : 's are'} still running. Stop ${n === 1 ? 'it' : 'them'} first (Utilities & Tools → Trading Bots → Stop) so the orders are cancelled and positions closed, then delete your account.`);
    }
    ctx.engine.shutdown();
    users.delete(req.user.id);
    try{ await store.destroy(); }
    catch(e){
      users.set(req.user.id, Promise.resolve(ctx));   // nothing was removed: keep serving the account as before
      throw httpErr(502, `Could not erase your stored data (${e.message}). Nothing was deleted.`);
    }
    let loginRemoved = false, note = '';
    if(supaUrl && adminKey){
      try{
        const r = await fetch(`${supaUrl}/auth/v1/admin/users/${encodeURIComponent(req.user.id)}`, { method: 'DELETE', headers: { apikey: adminKey, ...(/^eyJ/.test(adminKey) ? { Authorization: `Bearer ${adminKey}` } : {}) }, signal: AbortSignal.timeout(15_000) });
        loginRemoved = r.ok || r.status === 404;
        if(!loginRemoved) note = `The login service refused to remove the sign-in (${r.status}).`;
      }catch(e){ note = `Could not reach the login service (${e.message}).`; }
    } else note = 'This server has no admin key for the login service, so the sign-in itself was not removed.';
    if(auth.forget) auth.forget(req.user.id);
    return { deleted: true, dataErased: true, loginRemoved, note };
  }));

  // Moves the pre-account bots, trades and keys into the signed-in account. Needs BOTH a valid session and the old
  // WORKER_TOKEN, so only the person who owns the server can adopt that data. The bots keep their orders on the exchange;
  // the account's engine simply takes over managing them exactly as it would after a restart. Nothing is deleted from
  // the legacy store until the copy is confirmed saved.
  app.post('/api/account/claim-legacy', auth.requireUser, accountCtx, requireRole('admin'), guard, bigJson, wrap(async (req) => {
    if(legacyClaimed()) throw httpErr(409, 'The earlier data has already been claimed by an account.');
    if(!legacy.store.enabled) throw httpErr(503, `The earlier bot store isn't readable: ${legacy.store.reason}`);
    const ctx = req.ctx;
    legacy.engine.shutdown(); ctx.engine.shutdown();                       // nobody manages anything while it moves
    const L = legacy.store.state, U = ctx.store.state;
    try{
      const have = new Set(U.tradingBots.map(b => b.id)), haveT = new Set(U.trades.map(t => t.id));
      let nBots = 0, nTrades = 0, nKeys = 0;
      for(const b of L.tradingBots) if(!have.has(b.id)){ U.tradingBots.push(JSON.parse(JSON.stringify(b))); nBots++; }
      for(const t of L.trades) if(!haveT.has(t.id)){ U.trades.push(JSON.parse(JSON.stringify(t))); nTrades++; }
      U.trades.sort((a, b) => (b.closedAtMs || 0) - (a.closedAtMs || 0));
      for(const k of ['tbDayKey', 'tbDayAnchorInvestmentUsd', 'tbDayRealizedUsd', 'tbDailyHalted', 'tbDailyHaltMessage', 'tbDailyProfitTargetPct', 'tbDailyMaxLossPct']) if(U.tradingBots.length === nBots) U[k] = L[k];
      for(const c of legacy.store.listCreds()){
        if(ctx.store.getCred(c.exchange, c.mode)) continue;               // never overwrite a key the account already saved
        const plain = legacy.store.getCred(c.exchange, c.mode); if(plain){ await ctx.store.setCred(c.exchange, c.mode, plain); nKeys++; }
      }
      ctx.store.touch(); await ctx.store.flushNow();
      if(ctx.store.health.failing) throw httpErr(503, `Could not save the moved data to your account (${ctx.store.health.lastSaveError}). Nothing was changed. ${STORAGE_HINT}`);
      // copy confirmed saved — now retire the legacy copy
      for(const c of legacy.store.listCreds()) legacy.store.deleteCred(c.exchange, c.mode);
      L.tradingBots = []; L.trades = []; L.claimedBy = req.user.id; L.claimedAt = Date.now();
      legacy.store.touch(); await legacy.store.flushNow();
      ctx.engine = makeEngine(ctx.store); if(startEngine) ctx.engine.start();
      return { moved: { bots: nBots, trades: nTrades, keys: nKeys }, creds: credSummary(ctx) };
    }catch(e){
      if(startEngine){ legacy.engine.start(); ctx.engine.start(); }      // roll back to "everything keeps running as before"
      throw e;
    }
  }));

  const shutdown = () => { try{ legacy.engine.shutdown(); }catch(_){ /* exiting anyway */ } users.forEach(p => p.then(c => { try{ c.engine.shutdown(); }catch(_){ /* exiting anyway */ } }).catch(() => {})); };
  // Flush bots + trades to disk on a deploy/stop signal. A listener disables Node's default exit, so exit explicitly.
  process.once('SIGTERM', () => { shutdown(); setTimeout(() => process.exit(0), 1500).unref?.(); });
  process.once('SIGINT', () => { shutdown(); setTimeout(() => process.exit(0), 1500).unref?.(); });
  return { engine, store, shutdown, userCtx, legacy, auth };
}
