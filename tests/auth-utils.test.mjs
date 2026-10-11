// Pure sign-in helpers: open-redirect protection, password rules, email-link fragments.   Run: node tests/auth-utils.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { safeNext, validEmail, passwordIssues, passwordStrength, parseAuthHash, linkExpired, DEFAULT_DESTINATION } from '../js/auth-utils.js';

const ORIGIN = 'https://nxtgendecrypt.site';

test('safeNext keeps real dashboard destinations (with query and hash)', () => {
  assert.equal(safeNext('/overview/', ORIGIN), '/overview/');
  assert.equal(safeNext('/utilities-tools/#trading-bots', ORIGIN), '/utilities-tools/#trading-bots');
  assert.equal(safeNext('/api-keys/?x=1', ORIGIN), '/api-keys/?x=1');
  assert.equal(safeNext('/autotrade-futures', ORIGIN), '/autotrade-futures');          // no trailing slash still resolves to an app path
});

test('safeNext rejects every open-redirect shape and falls back to the Overview', () => {
  const evil = [
    'https://evil.example/overview/', 'http://evil.example', '//evil.example/overview/', '///evil.example', '/\\evil.example',
    '\\\\evil.example', '/overview/\r\nSet-Cookie: x=1', 'javascript:alert(1)', 'data:text/html,hi', ' /overview/', '\t//evil.example',
    '/%2f%2fevil.example', '/../../etc/passwd', '/login/', '/register/', '/privacy/', '', null, undefined, 42, {}, 'overview', '/overview/' + 'a'.repeat(600),
  ];
  for(const e of evil){
    const out = safeNext(e, ORIGIN);
    // whatever comes back must be a same-origin app path — never anything attacker-controlled
    assert.ok(out === DEFAULT_DESTINATION || (typeof e === 'string' && /^\/(overview|api-keys|utilities-tools)\/?/.test(out) && !out.includes('evil')), `unsafe result for ${JSON.stringify(e)}: ${out}`);
    assert.ok(out.startsWith('/') && !out.startsWith('//'), `bad shape for ${JSON.stringify(e)}: ${out}`);
  }
  assert.equal(safeNext('https://evil.example/overview/', ORIGIN), DEFAULT_DESTINATION);
  assert.equal(safeNext('//evil.example/overview/', ORIGIN), DEFAULT_DESTINATION);
  assert.equal(safeNext('/login/', ORIGIN), DEFAULT_DESTINATION);            // never bounce back into the sign-in pages
  assert.equal(safeNext('/%2f%2fevil.example', ORIGIN), DEFAULT_DESTINATION);
});

test('validEmail', () => {
  for(const ok of ['a@b.co', 'first.last+tag@sub.example.io']) assert.equal(validEmail(ok), true, ok);
  for(const bad of ['', 'a', 'a@b', 'a@b.c', '@x.io', 'a b@x.io', 'a@x .io', null, undefined, 'a@b.co'.padEnd(300, 'x')]) assert.equal(validEmail(bad), false, String(bad));
});

test('passwordIssues enforces length, letters+numbers, common/own-email passwords', () => {
  assert.deepEqual(passwordIssues('Tr1ckyHorse-77x', 'me@x.io'), []);
  assert.match(passwordIssues('short1')[0], /at least 10/);
  assert.ok(passwordIssues('abcdefghijkl').some(m => /letters and numbers/.test(m)));
  assert.ok(passwordIssues('1234567890123').some(m => /letters and numbers/.test(m)));
  assert.deepEqual(passwordIssues('Password123'), ['That password is too common.']);
  assert.deepEqual(passwordIssues('password1234x'), []);                           // not on the short common list, meets the rules
  assert.ok(passwordIssues('nxtgendecrypt').some(m => /common|letters/.test(m)));
  assert.ok(passwordIssues('alexander2026!', 'alexander@x.io').some(m => /email name/.test(m)));
  assert.ok(passwordIssues('aaaaaaaaaaaa').some(m => /repeat a single character/.test(m)));
  assert.ok(passwordIssues('').length > 0);
});

test('passwordStrength is advisory, monotone enough, and caps short/common passwords', () => {
  assert.equal(passwordStrength('').score, 0);
  assert.equal(passwordStrength('abc1').score, 1);
  assert.equal(passwordStrength('password123').label, 'Weak');
  assert.ok(passwordStrength('Tr1ckyHorse-77xQ!').score >= 3);
  assert.equal(passwordStrength('Tr1ckyHorse-77xQ!z').label, 'Strong');
  assert.ok(passwordStrength('Tr1ckyHorse-77xQ!z').score > passwordStrength('abcdefgh12').score);
});

test('parseAuthHash reads Supabase email-link fragments and ignores everything else', () => {
  const rec = parseAuthHash('#access_token=eyJ.a.b&expires_in=3600&refresh_token=r1&token_type=bearer&type=recovery');
  assert.equal(rec.type, 'recovery'); assert.equal(rec.accessToken, 'eyJ.a.b'); assert.equal(rec.expiresIn, 3600);
  const err = parseAuthHash('#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired');
  assert.equal(err.errorCode, 'otp_expired'); assert.equal(linkExpired(err), true);
  assert.equal(parseAuthHash(''), null); assert.equal(parseAuthHash('#top'), null); assert.equal(parseAuthHash('#section=2'), null); assert.equal(parseAuthHash(undefined), null);
  assert.equal(linkExpired(null), false);
});
