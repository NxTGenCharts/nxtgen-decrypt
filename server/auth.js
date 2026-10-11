// =============================================================
// auth.js — user accounts (Supabase Auth) for the proxy.
//
//   * The browser signs up / signs in directly against Supabase Auth and receives a short-lived access token (a JWT).
//   * Every request to this server then carries it as `Authorization: Bearer <jwt>`. We don't trust the token's contents:
//     we ask Supabase "who is this?" (GET /auth/v1/user) and cache the answer for a minute, so a revoked session stops
//     working within ~60 s and no JWT secret ever has to be copied onto this server.
//   * GET /api/auth/config hands the browser the PUBLIC project URL + publishable (anon) key, so the static site needs
//     no build-time configuration. The anon key is public by design — it can do nothing without a signed-in user and
//     row-level security (the bot table has none open to it).
//
// "Server-held keys": exchange secrets never go back to a browser. After a key is saved to an account, every device
// refers to it by a placeholder apiKey of the form  srv:<exchange>:<mode>:<last4>.  The middleware below swaps that
// placeholder for the real credential — only if the request carries a valid session for the account that owns it — and
// only in memory, just before the existing route runs. The routes themselves are unchanged.
//
// Env:
//   BOT_SUPABASE_URL      (already used for the bot database)
//   SUPABASE_ANON_KEY     the project's publishable/anon key (Project Settings → API Keys). Enables accounts.
//   ACCOUNTS_REQUIRED     optional "true": refuse the old shared-token path entirely (see bots.js)
//   PROXY_REQUIRES_LOGIN  optional "true": every key-bearing POST (/api/verify, /balance, /order, /futures/*, …) needs a signed-in
//                         account session, so strangers cannot use this server as a free exchange-signing proxy. Off by default
//                         so the rollout cannot break anything; see gateProxy() below and the README.
//   AUTH_GOOGLE_ENABLED   optional "true": tells the sign-in pages to offer "Continue with Google". Only set it once the Google
//                         provider is enabled in Supabase (Authentication -> Providers) — it is not checked from here.
//   ALLOWED_EMAILS        optional invite list: comma-separated addresses and/or @domains. When set, only those emails get a
//                         vault and a bot engine on this server (anyone can still create a Supabase login — they just can't use this).
//                         When unset, any confirmed account can — see the README before leaving it open.
// =============================================================
import crypto from 'node:crypto';

const CACHE_MS = 60_000;
const NEGATIVE_CACHE_MS = 15_000;
const PLACEHOLDER_RE = /^srv:(bybit|binance):(live|demo):/;

export function createAuth({ env = process.env, log = console } = {}){
  const url = String(env.BOT_SUPABASE_URL || '').trim().replace(/\/$/, '');
  const anonKey = String(env.SUPABASE_ANON_KEY || '').trim();
  const enabled = !!(url && anonKey);
  const allow = String(env.ALLOWED_EMAILS || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
  const invited = (email) => !allow.length || allow.some(a => a.startsWith('@') ? String(email).toLowerCase().endsWith(a) : String(email).toLowerCase() === a);
  const notInvited = () => Object.assign(new Error('This server is invite-only and that email is not on its list.'), { status: 403, code: 'not_invited' });
  const cache = new Map();           // sha256(token) -> { user, exp }
  let credResolver = null;           // (userId, exchange, mode) -> cred | null   (registered by bots.js)

  const bearer = (req) => {
    const m = /^Bearer\s+(.+)$/i.exec(String(req.get('authorization') || ''));
    const t = m ? m[1].trim() : '';
    return /^eyJ[\w-]+\.[\w-]+\.[\w-]*$/.test(t) ? t : '';   // looks like a JWT; anything else is the legacy shared token
  };

  async function verifyToken(token){
    const id = crypto.createHash('sha256').update(token).digest('hex');
    const hit = cache.get(id);
    if(hit && hit.exp > Date.now()) return hit.user;
    const res = await fetch(`${url}/auth/v1/user`, { headers: { apikey: anonKey, Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) });
    // Remember a rejection briefly, so a flood of requests with a bad token costs one lookup, not one per request.
    if(res.status === 401 || res.status === 403){ cache.set(id, { user: null, exp: Date.now() + NEGATIVE_CACHE_MS }); return null; }
    if(!res.ok) throw new Error(`auth service ${res.status}`);
    const u = await res.json();
    if(!u || !u.id) return null;
    // an unconfirmed email must not get a vault — Supabase only sets this once the address is verified
    if(!u.email_confirmed_at && !u.confirmed_at) return null;
    if(!invited(u.email)) throw notInvited();
    const user = { id: String(u.id).toLowerCase(), email: u.email || '' };
    cache.set(id, { user, exp: Date.now() + CACHE_MS });
    if(cache.size > 2000) for(const k of cache.keys()){ cache.delete(k); if(cache.size < 1000) break; }
    return user;
  }

  // Resolves the signed-in user for a request, or null. Throws only when the auth service itself is unreachable.
  async function userFromReq(req){
    if(!enabled) return null;
    const t = bearer(req);
    return t ? verifyToken(t) : null;
  }

  // Express middleware: 401 unless a valid account session is present. Sets req.user.
  const requireUser = (req, res, next) => {
    if(!enabled) return res.status(503).json({ ok: false, code: 'accounts_disabled', message: 'Accounts are not enabled on this server (set SUPABASE_ANON_KEY).' });
    userFromReq(req).then((u) => {
      if(!u) return res.status(401).json({ ok: false, code: 'unauthorized', message: 'Please sign in again.' });
      req.user = u; next();
    }).catch((e) => e.code === 'not_invited'
      ? res.status(403).json({ ok: false, code: 'not_invited', message: e.message })
      : res.status(503).json({ ok: false, code: 'auth_unreachable', message: `Could not check your session (${e.message}). Try again.` }));
  };

  // Swaps a placeholder apiKey for the real credential. Mounted before the proxy routes.
  async function heldKeyMiddleware(req, res, next){
    const b = req.body;
    if(req.method !== 'POST' || !b || typeof b.apiKey !== 'string' || !b.apiKey.startsWith('srv:')) return next();
    if(req.path.startsWith('/api/bots') || req.path.startsWith('/api/account')) return next();   // those routes read the vault themselves
    const m = PLACEHOLDER_RE.exec(b.apiKey);
    if(!m) return res.status(400).json({ ok: false, rejected: false, message: 'Unrecognised saved-key reference.' });
    try{
      const user = await userFromReq(req);
      if(!user) return res.status(401).json({ ok: false, code: 'unauthorized', message: 'Sign in to use the API keys saved on your account.' });
      const [, exchange, mode] = m;
      if((b.exchange && b.exchange !== exchange) || (b.mode && b.mode !== mode)) return res.status(400).json({ ok: false, rejected: false, message: 'That saved key is for a different exchange/network.' });
      const cred = credResolver ? await credResolver(user.id, exchange, mode) : null;
      if(!cred) return res.status(404).json({ ok: false, rejected: false, code: 'no_server_key', message: `No ${exchange} ${mode} key is saved on your account — add it under API Keys.` });
      b.apiKey = cred.apiKey; b.secretKey = cred.secretKey; b.passphrase = cred.passphrase || '';
      if(!b.exchange) b.exchange = exchange;
      if(!b.mode) b.mode = mode;
      next();
    }catch(e){ res.status(e.status || 503).json({ ok: false, code: e.code, message: e.status ? e.message : `Could not check your session (${e.message}).` }); }
  }

  const proxyGateOn = String(env.PROXY_REQUIRES_LOGIN || '') === 'true';
  function mountConfig(app){
    const google = String(env.AUTH_GOOGLE_ENABLED || '') === 'true';
    app.get('/api/auth/config', (req, res) => res.json(enabled ? { ok: true, enabled: true, url, anonKey, oauth: { google }, proxyGate: proxyGateOn } : { ok: true, enabled: false }));
  }

  // Opt-in (PROXY_REQUIRES_LOGIN=true). Without it these routes are stateless signing proxies that anyone can call with THEIR OWN
  // exchange keys — they can never reach another user's saved keys (the srv: placeholder path always needs the owner's session).
  // With it, the caller must also hold a valid account session. Skipped for: reads (market data), routes that run their own
  // access control (/api/bots, /api/account, /api/worker, /api/auth), CORS preflights (answered earlier), and this server's own
  // loopback calls from the bot engine / futures worker (they carry the per-boot internal key). Fails CLOSED when the flag is
  // on but accounts are not configured, rather than silently leaving the routes open.
  const OWN_AUTH = ['/api/bots', '/api/account', '/api/worker', '/api/auth'];
  function gateProxy({ isInternal } = {}){
    return (req, res, next) => {
      if(!proxyGateOn || req.method !== 'POST' || !String(req.path).startsWith('/api/')) return next();
      if(OWN_AUTH.some(p => req.path === p || req.path.startsWith(p + '/'))) return next();
      if(isInternal && isInternal(req)) return next();
      return requireUser(req, res, next);
    };
  }

  if(enabled && !allow.length) log.warn && log.warn('[accounts] ALLOWED_EMAILS is not set — anyone who signs up can store exchange keys and run bots on this server. Set it to keep this invite-only.');
  if(proxyGateOn && !enabled) log.warn && log.warn('[accounts] PROXY_REQUIRES_LOGIN is on but accounts are not configured — key-bearing routes will answer 503 until SUPABASE_ANON_KEY is set.');
  if(!enabled) log.info && log.info('[accounts] OFF — set BOT_SUPABASE_URL and SUPABASE_ANON_KEY to enable sign-in. The shared WORKER_TOKEN still works.');
  return { enabled, proxyGateOn, userFromReq, requireUser, heldKeyMiddleware, gateProxy, mountConfig, hasBearer: (req) => !!bearer(req), setCredResolver(fn){ credResolver = fn; } };
}
