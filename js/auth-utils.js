// =============================================================
// auth-utils.js — small pure helpers for the sign-in pages. No DOM, no network, so they can be unit-tested in Node
// (tests/auth-utils.test.mjs). Anything security-relevant on the client side lives here:
//   * safeNext()      — open-redirect protection for the post-login destination
//   * password rules  — client-side feedback only; the real enforcement is the Supabase project's password policy
//   * parseAuthHash() — reads the short-lived tokens/errors Supabase puts in the URL fragment of email links
// =============================================================

export const DEFAULT_DESTINATION = '/overview/';

// Only these app areas may be a post-login destination. Anything else (other sites, auth pages, odd paths) falls back to
// the Overview dashboard. Keep in step with the pages that carry <script src="/js/auth-gate.js">.
export const APP_PATHS = ['/overview/', '/triangular-arbitrage/', '/cross-arbitrage/', '/autotrade-futures/', '/utilities-tools/', '/api-keys/'];

// Returns a same-origin app path (with its query/hash) that is safe to redirect to, or DEFAULT_DESTINATION.
// `origin` is passed in so this stays testable outside a browser.
export function safeNext(raw, origin = 'https://nxtgendecrypt.site'){
  try{
    if(typeof raw !== 'string' || !raw || raw.length > 512) return DEFAULT_DESTINATION;
    if(/[\u0000-\u001f\u007f\\]/.test(raw)) return DEFAULT_DESTINATION;       // control characters and backslashes (browsers treat "\" like "/")
    if(!raw.startsWith('/') || raw.startsWith('//')) return DEFAULT_DESTINATION; // must be a single-slash, same-origin path
    const u = new URL(raw, origin);
    if(u.origin !== new URL(origin).origin) return DEFAULT_DESTINATION;
    const path = u.pathname.endsWith('/') ? u.pathname : u.pathname + '/';
    if(!APP_PATHS.includes(path)) return DEFAULT_DESTINATION;
    return u.pathname + u.search + u.hash;
  }catch(e){ return DEFAULT_DESTINATION; }
}

// ---------- validation ----------
export const validEmail = (v) => typeof v === 'string' && v.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v.trim());

export const MIN_PASSWORD = 10;
const COMMON = new Set(['password', 'password1', 'password12', 'password123', 'passw0rd123', '1234567890', '12345678910', 'qwertyuiop', 'qwerty12345', 'qwerty123456', 'iloveyou123', 'letmein1234', 'welcome1234', 'admin12345', 'abc1234567', 'bitcoin1234', 'crypto12345', 'trading1234', 'nxtgendecrypt']);

// Hard requirements (a password must satisfy all of these to be submitted at sign-up / reset).
export function passwordIssues(pw, email = ''){
  const issues = [];
  const p = String(pw || '');
  if(p.length < MIN_PASSWORD) issues.push(`Use at least ${MIN_PASSWORD} characters.`);
  if(!/[a-z]/i.test(p) || !/\d/.test(p)) issues.push('Include both letters and numbers.');
  const local = String(email).split('@')[0].toLowerCase();
  if(p && local.length >= 4 && p.toLowerCase().includes(local)) issues.push('Do not include your email name in the password.');
  if(COMMON.has(p.toLowerCase())) issues.push('That password is too common.');
  if(p.length > 0 && /^(.)\1+$/.test(p)) issues.push('Do not repeat a single character.');
  return issues;
}

// 0–4 score for the strength meter. Advisory only.
export function passwordStrength(pw){
  const p = String(pw || '');
  if(!p) return { score: 0, label: '' };
  let s = 0;
  if(p.length >= MIN_PASSWORD) s++;
  if(p.length >= 14) s++;
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter(r => r.test(p)).length;
  if(classes >= 3) s++;
  if(classes === 4 && p.length >= 12) s++;
  if(COMMON.has(p.toLowerCase()) || /^(.)\1+$/.test(p) || /^(?:0123456789|abcdefghij|qwertyuiop)/i.test(p)) s = Math.min(s, 1);
  if(p.length < MIN_PASSWORD) s = Math.min(s, 1);
  const label = ['', 'Weak', 'Fair', 'Good', 'Strong'][Math.max(1, s)];
  return { score: Math.max(1, s), label };
}

// ---------- email-link fragments ----------
// Supabase puts what it needs in the URL fragment, e.g. #access_token=…&refresh_token=…&type=recovery
// or, on failure, #error=access_denied&error_code=otp_expired&error_description=…
export function parseAuthHash(hash){
  const h = String(hash || '').replace(/^#/, '');
  if(!h || !h.includes('=')) return null;
  const q = new URLSearchParams(h);
  const out = {
    type: q.get('type') || '',
    accessToken: q.get('access_token') || '',
    refreshToken: q.get('refresh_token') || '',
    expiresIn: Number(q.get('expires_in')) || 0,
    expiresAt: Number(q.get('expires_at')) || 0,
    error: q.get('error') || '',
    errorCode: q.get('error_code') || '',
    errorDescription: q.get('error_description') || '',
  };
  if(!out.type && !out.accessToken && !out.error) return null;
  return out;
}

// Link errors that mean "ask for a new one". Supabase uses otp_expired for both expired and already-used links.
export const linkExpired = (p) => !!p && (p.errorCode === 'otp_expired' || /expired|invalid|already been used/i.test(p.errorDescription || ''));
