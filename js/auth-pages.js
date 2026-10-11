// =============================================================
// auth-pages.js — behaviour for /login/, /register/, /forgot-password/, /reset-password/ and /verify-email/.
// One module, one page per <body data-auth-page="…">. All account work goes through js/account.js (Supabase Auth); nothing here
// touches a password except to hand it to that module, and every piece of dynamic text is set with textContent (never HTML).
// =============================================================
import {
  initAccount, accountsAvailable, accountsProblem, isSignedIn, signIn, signUp, signOut, resendVerification, resetPassword,
  setNewPassword, oauthAvailable, startOAuth, finishOAuth, checkAccess,
} from './account.js';
import { safeNext, validEmail, passwordIssues, passwordStrength, parseAuthHash, linkExpired, MIN_PASSWORD } from './auth-utils.js';

const $ = (id) => document.getElementById(id);
const page = document.body.dataset.authPage;
const params = new URLSearchParams(location.search);
const COOLDOWN_S = 60;

// ---------- small UI helpers ----------
let wakingShown = false;
function showAlert(kind, text, action){
  const el = $('authAlert'); if(!el) return;
  el.className = 'auth-alert' + (kind ? ' is-' + kind : '');
  el.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  el.textContent = text;
  if(action){
    const b = document.createElement('button'); b.type = 'button'; b.className = 'link'; b.textContent = action.label;
    b.addEventListener('click', action.run); el.appendChild(b);
  }
  el.hidden = false;
}
function hideAlert(){ const el = $('authAlert'); if(el){ el.hidden = true; el.textContent = ''; } wakingShown = false; }

function fieldError(input, text){
  const err = $(input.id + 'Err');
  if(err) err.textContent = text || '';
  if(text){ input.setAttribute('aria-invalid', 'true'); } else { input.removeAttribute('aria-invalid'); }
}
function clearErrors(form){ form.querySelectorAll('input').forEach(i => fieldError(i, '')); }
function focusFirstInvalid(form){ const bad = form.querySelector('[aria-invalid="true"]'); if(bad) bad.focus(); }

function setBusy(btn, busy, busyLabel){
  if(!btn) return;
  if(busy){ btn.dataset.label = btn.textContent; btn.disabled = true; btn.setAttribute('aria-busy', 'true'); btn.textContent = ''; const s = document.createElement('span'); s.className = 'spin'; s.setAttribute('aria-hidden', 'true'); btn.append(s, document.createTextNode(busyLabel || 'Working…')); }
  else { btn.disabled = false; btn.removeAttribute('aria-busy'); btn.textContent = btn.dataset.label || btn.textContent; }
}
function showState(id){
  document.querySelectorAll('.auth-state').forEach(n => { n.hidden = n.id !== id; });
  const form = $('authForm'); if(form) form.hidden = true;
  const sub = $('authSub'); if(sub) sub.hidden = true;
  hideAlert();
  const t = $(id) && $(id).querySelector('[data-focus]'); if(t) t.focus();
}
// "Resend in 42s" countdown on a button; the real rate limits are Supabase's — this just stops accidental hammering.
function cooldown(btn, seconds = COOLDOWN_S){
  const label = btn.dataset.label || btn.textContent; btn.dataset.label = label;
  let left = seconds; btn.disabled = true;
  const tick = () => { if(left <= 0){ btn.disabled = false; btn.textContent = label; return; } btn.textContent = `${label} (${left}s)`; left--; setTimeout(tick, 1000); };
  tick();
}

function wirePasswordToggles(){
  document.querySelectorAll('[data-pw-toggle]').forEach(btn => {
    const input = $(btn.dataset.pwToggle); if(!input) return;
    btn.addEventListener('click', () => {
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      btn.textContent = show ? 'HIDE' : 'SHOW';
      btn.setAttribute('aria-pressed', String(show));
      btn.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
    });
  });
}
function wireStrength(input, emailInput){
  const meter = $('pwMeter'), label = $('pwStrength'); if(!input || !meter) return;
  let last = '';
  input.addEventListener('input', () => {
    const { score, label: text } = passwordStrength(input.value);
    meter.dataset.score = String(input.value ? score : 0);
    const msg = input.value ? text : '';
    if(msg !== last){ label.textContent = msg ? `Strength: ${msg}` : ''; last = msg; }
    if(input.getAttribute('aria-invalid')) fieldError(input, '');
  });
}

// Waits for the account module to learn what the server supports. The server may be waking from a quiet period, so say so
// instead of sitting silent; give up after ~75 s.
async function boot(){
  const t = setTimeout(() => { wakingShown = true; showAlert('warn', 'Connecting to the NxTGen server… it can take up to a minute to wake after a quiet period.'); }, 6000);
  try{
    await Promise.race([initAccount(), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 75_000))]);
  }catch(e){ /* handled by the availability check below */ }
  finally{ clearTimeout(t); if(wakingShown) hideAlert(); }
}
// Returns true when sign-in can proceed; otherwise explains why and disables the form.
function checkAvailable(next){
  if(accountsAvailable()) return true;
  const form = $('authForm');
  if(accountsProblem() === 'disabled'){
    if(form) form.hidden = true;
    const sub = $('authSub'); if(sub) sub.hidden = true;
    showAlert('warn', 'Accounts are switched off on this server, so the terminal is open without signing in.');
    const link = $('openTerminal'); if(link){ link.href = next; link.hidden = false; }
  } else {
    form && form.querySelectorAll('input,button').forEach(el => { el.disabled = true; });
    showAlert('error', 'Could not reach the NxTGen server. Check your connection, then try again.', { label: 'Retry', run: () => location.reload() });
  }
  return false;
}

// ---------- pages ----------
const REASONS = {
  required: ['info', 'Sign in to open the terminal.'],
  expired: ['warn', 'Your session has expired. Please sign in again.'],
  signedout: ['ok', 'You have been signed out.'],
  verified: ['ok', 'Email confirmed. You can sign in now.'],
  reset: ['ok', 'Password updated. Sign in with your new password.'],
};

async function loginPage(){
  const next = safeNext(params.get('next'), location.origin);
  const form = $('authForm'), email = $('email'), pw = $('password'), btn = $('submitBtn');
  wirePasswordToggles();
  const reason = REASONS[params.get('reason')];
  if(reason) showAlert(reason[0] === 'info' ? '' : reason[0], reason[1]);

  const oauth = parseAuthHash(location.hash);                 // returning from Google?
  // Email links normally land on their own pages. If the project's redirect settings sent one here instead, pass it along.
  if(oauth && oauth.type === 'recovery') return location.replace('/reset-password/' + location.hash);
  if(oauth && (oauth.type === 'signup' || oauth.type === 'email')) return location.replace('/verify-email/' + location.hash);
  if(oauth) history.replaceState(null, '', location.pathname + location.search);   // tokens never stay in the address bar

  await boot();
  if(!checkAvailable(next)) return;
  if(oauthAvailable('google')){ $('googleBtn').hidden = false; $('orDivider').hidden = false; }

  const goOn = async () => {
    const access = await checkAccess();
    if(!access.ok && access.code === 'not_invited'){ await signOut(); showAlert('error', access.message || 'This server is invite-only and that email is not on its list.'); return false; }
    showAlert('ok', 'Signed in. Opening the terminal…');
    location.replace(next);
    return true;
  };

  if(oauth && (oauth.accessToken || oauth.error)){
    if(oauth.error){ showAlert('error', 'Google sign-in did not complete. Please try again or use your email and password.'); }
    else{
      try{ btn.disabled = true; await finishOAuth(oauth); await goOn(); return; }
      catch(e){ showAlert('error', e.message || 'Google sign-in did not complete.'); btn.disabled = false; }
    }
  } else if(isSignedIn()){ showAlert('ok', 'You are already signed in. Opening the terminal…'); location.replace(next); return; }

  let submitting = false;
  const googleBtn = $('googleBtn');
  if(googleBtn) googleBtn.addEventListener('click', () => { try{ startOAuth('google'); }catch(e){ showAlert('error', e.message); } });

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    if(submitting) return;
    clearErrors(form); if(!wakingShown) hideAlert();
    const em = email.value.trim(), pass = pw.value;
    if(!validEmail(em)) fieldError(email, 'Enter a valid email address.');
    if(!pass) fieldError(pw, 'Enter your password.');
    if(form.querySelector('[aria-invalid="true"]')){ showAlert('error', 'Check the highlighted fields.'); return focusFirstInvalid(form); }
    submitting = true; setBusy(btn, true, 'Signing in…');
    try{
      await signIn(em, pass, { remember: $('remember').checked });
      pw.value = '';
      if(!(await goOn())){ submitting = false; setBusy(btn, false); }
    }catch(e){
      submitting = false; setBusy(btn, false);
      pw.value = '';
      if(e.code === 'email_not_confirmed'){
        showAlert('warn', e.message, { label: 'Resend confirmation email', run: async () => { try{ await resendVerification(em); showAlert('ok', 'If that address is awaiting confirmation, a new link is on its way.'); }catch(err){ showAlert('error', err.message); } } });
      } else showAlert('error', e.message || 'Something went wrong. Please try again.');
      pw.focus();
    }
  });
}

async function registerPage(){
  const form = $('authForm'), email = $('email'), pw = $('password'), confirm = $('confirm'), terms = $('terms'), btn = $('submitBtn');
  wirePasswordToggles(); wireStrength(pw, email);
  await boot();
  if(!checkAvailable('/overview/')) return;
  if(oauthAvailable('google')){ $('googleBtn').hidden = false; $('orDivider').hidden = false; $('googleBtn').addEventListener('click', () => { try{ startOAuth('google'); }catch(e){ showAlert('error', e.message); } }); }

  const pending = (em) => {
    $('sentTo').textContent = em;
    showState('stateSent');
    const resend = $('resendBtn'); cooldown(resend);
    resend.onclick = async () => {
      resend.disabled = true;
      try{ await resendVerification(em); showAlert('ok', 'If that address is awaiting confirmation, a new link is on its way.'); }
      catch(e){ showAlert('error', e.message); }
      cooldown(resend);
    };
  };

  let submitting = false;
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    if(submitting) return;
    clearErrors(form); hideAlert();
    const em = email.value.trim();
    if(!validEmail(em)) fieldError(email, 'Enter a valid email address.');
    const issues = passwordIssues(pw.value, em); if(issues.length) fieldError(pw, issues[0]);
    if(!confirm.value) fieldError(confirm, 'Re-enter your password.'); else if(confirm.value !== pw.value) fieldError(confirm, 'Passwords do not match.');
    if(!terms.checked) fieldError(terms, 'Please accept the Terms of Service and Privacy Policy to continue.');
    if(form.querySelector('[aria-invalid="true"]')){ showAlert('error', 'Check the highlighted fields.'); return focusFirstInvalid(form); }
    submitting = true; setBusy(btn, true, 'Creating account…');
    try{
      const r = await signUp(em, pw.value);
      pw.value = ''; confirm.value = '';
      if(r.signedIn){ const a = await checkAccess(); if(!a.ok && a.code === 'not_invited'){ await signOut(); showAlert('error', a.message); submitting = false; setBusy(btn, false); return; } location.replace('/overview/'); return; }
      pending(em);
    }catch(e){
      submitting = false; setBusy(btn, false);
      if(e.code === 'user_already_exists'){ pending(em); return; }      // same screen as a brand-new address: don't reveal which it is
      showAlert('error', e.message || 'Could not create the account. Please try again.');
    }
  });
}

async function forgotPage(){
  const form = $('authForm'), email = $('email'), btn = $('submitBtn');
  await boot();
  if(!checkAvailable('/overview/')) return;
  let submitting = false;
  const sent = (em) => {
    $('sentTo').textContent = em; showState('stateSent');
    const again = $('againBtn'); cooldown(again);
    again.onclick = async () => { again.disabled = true; try{ await resetPassword(em); showAlert('ok', 'If an account exists for that address, another link is on its way.'); }catch(e){ showAlert('error', e.message); } cooldown(again); };
  };
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    if(submitting) return;
    clearErrors(form); hideAlert();
    const em = email.value.trim();
    if(!validEmail(em)){ fieldError(email, 'Enter a valid email address.'); return email.focus(); }
    submitting = true; setBusy(btn, true, 'Sending…');
    try{ await resetPassword(em); sent(em); }
    catch(e){ submitting = false; setBusy(btn, false); showAlert('error', e.message || 'Could not send the reset email. Please try again.'); }
  });
}

async function resetPage(){
  const form = $('authForm'), pw = $('password'), confirm = $('confirm'), btn = $('submitBtn');
  wirePasswordToggles(); wireStrength(pw);
  // The recovery token arrives in the URL fragment. Read it once, keep it only in memory, and take it out of the address bar.
  const link = parseAuthHash(location.hash);
  history.replaceState(null, '', location.pathname);
  let token = '';
  if(link && link.error){ return showState(linkExpired(link) ? 'stateExpired' : 'stateInvalid'); }
  if(link && link.type === 'recovery' && link.accessToken) token = link.accessToken;
  if(!token) return showState('stateInvalid');
  await boot();
  if(!checkAvailable('/overview/')) return;

  let submitting = false;
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    if(submitting) return;
    clearErrors(form); hideAlert();
    const issues = passwordIssues(pw.value); if(issues.length) fieldError(pw, issues[0]);
    if(!confirm.value) fieldError(confirm, 'Re-enter your new password.'); else if(confirm.value !== pw.value) fieldError(confirm, 'Passwords do not match.');
    if(form.querySelector('[aria-invalid="true"]')){ showAlert('error', 'Check the highlighted fields.'); return focusFirstInvalid(form); }
    submitting = true; setBusy(btn, true, 'Updating…');
    try{
      const r = await setNewPassword(token, pw.value);
      token = ''; pw.value = ''; confirm.value = '';
      $('allSignedOut').textContent = r.allSignedOut ? 'You have been signed out everywhere, so every device will ask for the new password.' : 'Sign in with your new password. If you think someone else had access, also sign out of other devices from a signed-in session.';
      showState('stateDone');
    }catch(e){
      submitting = false; setBusy(btn, false);
      if(e.status === 401 || e.status === 403) return showState('stateExpired');
      showAlert('error', e.message || 'Could not update the password. Please try again.');
    }
  });
}

async function verifyPage(){
  const link = parseAuthHash(location.hash);
  history.replaceState(null, '', location.pathname);        // the link's tokens are never used or kept: confirming does not log anyone in
  if(link && link.error){ showState('statePending'); showAlert('warn', linkExpired(link) ? 'This confirmation link has expired or was already used. Enter your email to get a new one.' : 'This confirmation link is not valid. Enter your email to get a new one.'); }
  else if(link && (link.type === 'signup' || link.type === 'email' || link.accessToken)){ showState('stateVerified'); return; }
  else { showState('statePending'); }

  const resend = $('resendBtn'), email = $('email');
  await boot();
  const form = $('resendForm');
  if(!form) return;
  let busy = false;
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    if(busy) return;
    fieldError(email, '');
    const em = email.value.trim();
    if(!validEmail(em)){ fieldError(email, 'Enter a valid email address.'); return email.focus(); }
    if(!accountsAvailable()){ return showAlert('error', 'Could not reach the NxTGen server. Try again in a moment.'); }
    busy = true; setBusy(resend, true, 'Sending…');
    try{ await resendVerification(em); showAlert('ok', 'If that address is awaiting confirmation, a new link is on its way.'); setBusy(resend, false); cooldown(resend); }
    catch(e){ setBusy(resend, false); showAlert('error', e.message || 'Could not send the email.'); }
    busy = false;
  });
}

// ---------- start ----------
const year = $('year'); if(year) year.textContent = String(new Date().getFullYear());
const pages = { login: loginPage, register: registerPage, forgot: forgotPage, reset: resetPage, verify: verifyPage };
if(pages[page]) pages[page]().catch((e) => { console.error('[auth] page failed:', e && e.message); showAlert('error', 'Something went wrong loading this page. Please refresh and try again.'); });
