'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { webcrypto } = require('node:crypto');
const Auth = require('../public/lib/spotify-auth.js');

const CLIENT_ID = '0123456789abcdef0123456789abcdef';
const PAGES = { origin: 'https://michaelphagen.github.io', pathname: '/spotify-guessing-game/', search: '' };

function memoryStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    dump: () => Object.fromEntries(m),
  };
}

function tokenResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function make({ fetch, now, location = PAGES, configClientId = CLIENT_ID, storage = memoryStorage() } = {}) {
  const calls = [];
  const clock = { t: 1_000_000 };
  const auth = Auth.create({
    fetch: async (url, init) => { calls.push({ url, init }); return fetch(url, init); },
    storage,
    crypto: webcrypto,
    location,
    configClientId,
    now: now || (() => clock.t),
  });
  return { auth, calls, storage, clock };
}

test('PKCE verifier: 64 characters from the RFC 7636 alphabet, different every time', () => {
  const a = Auth.randomString(64, (b) => webcrypto.getRandomValues(b));
  const b = Auth.randomString(64, (x) => webcrypto.getRandomValues(x));
  assert.equal(a.length, 64);
  assert.match(a, /^[A-Za-z0-9\-._~]{43,128}$/);
  assert.notEqual(a, b);
  // Every character of the alphabet is reachable (no modulo bias cut-off bug).
  const many = Auth.randomString(4000, (x) => webcrypto.getRandomValues(x));
  assert.equal(new Set(many).size, Auth.VERIFIER_CHARS.length);
});

test('PKCE challenge: base64url SHA-256, matches the RFC 7636 example', async () => {
  const challenge = await Auth.codeChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk', webcrypto.subtle);
  assert.equal(challenge, 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  assert.match(challenge, /^[A-Za-z0-9_-]{43}$/, 'no padding, URL-safe');
});

test('redirect URI: origin + path, works under the GitHub Pages sub-path and locally', () => {
  assert.equal(Auth.redirectUri(PAGES), 'https://michaelphagen.github.io/spotify-guessing-game/');
  assert.equal(Auth.redirectUri({ origin: 'https://michaelphagen.github.io', pathname: '/spotify-guessing-game/index.html' }),
    'https://michaelphagen.github.io/spotify-guessing-game/');
  assert.equal(Auth.redirectUri({ origin: 'http://127.0.0.1:3000', pathname: '/' }), 'http://127.0.0.1:3000/');
});

test('state carries only the room/backend query parameters and round-trips', () => {
  assert.equal(Auth.carriedParams('?host=ABCD&transport=local&foo=1&code=x'), '?host=ABCD&transport=local');
  assert.equal(Auth.carriedParams('?room=WXYZ&api=https%3A%2F%2Fx.onrender.com'), '?room=WXYZ&api=https%3A%2F%2Fx.onrender.com');
  assert.equal(Auth.carriedParams(''), '');
  const state = Auth.encodeState('nonce123', '?room=WXYZ&transport=local');
  assert.match(state, /^[A-Za-z0-9_-]+$/, 'URL-safe');
  assert.deepEqual(Auth.decodeState(state), { nonce: 'nonce123', params: '?room=WXYZ&transport=local' });
  assert.equal(Auth.decodeState('not-base64-json'), null);
  // A forged state can't smuggle other parameters back into the address bar.
  const forged = Auth.encodeState('n', '?room=AB&code=evil&javascript=1');
  assert.deepEqual(Auth.decodeState(forged), { nonce: 'n', params: '?room=AB' });
});

test('beginSignIn: authorize URL with PKCE S256, scopes, redirect URI and state', async () => {
  const { auth, storage } = make({ fetch: async () => { throw new Error('no fetch expected'); } });
  const url = new URL(await auth.beginSignIn('?host=ABCD&transport=local'));
  assert.equal(url.origin + url.pathname, 'https://accounts.spotify.com/authorize');
  const p = url.searchParams;
  assert.equal(p.get('response_type'), 'code');
  assert.equal(p.get('client_id'), CLIENT_ID);
  assert.equal(p.get('code_challenge_method'), 'S256');
  assert.equal(p.get('redirect_uri'), 'https://michaelphagen.github.io/spotify-guessing-game/');
  assert.deepEqual(p.get('scope').split(' ').sort(), Auth.SCOPES.slice().sort());
  assert.ok(Auth.SCOPES.includes('streaming') && Auth.SCOPES.includes('user-modify-playback-state'));
  const pending = JSON.parse(storage.getItem(Auth.KEYS.pending));
  assert.equal(p.get('code_challenge'), await Auth.codeChallenge(pending.verifier, webcrypto.subtle));
  const st = Auth.decodeState(p.get('state'));
  assert.equal(st.nonce, pending.nonce);
  assert.equal(st.params, '?host=ABCD&transport=local');
});

test('beginSignIn without a Client ID asks for one; a pasted Client ID is validated and stored', async () => {
  const { auth, storage } = make({ fetch: async () => null, configClientId: '' });
  await assert.rejects(auth.beginSignIn(''), (e) => e.code === 'no-client-id');
  assert.equal(auth.setClientId('not an id'), false);
  assert.equal(auth.setClientId('  ' + CLIENT_ID.toUpperCase() + ' '), true);
  assert.equal(auth.clientId(), CLIENT_ID.toUpperCase());
  assert.ok(storage.getItem(Auth.KEYS.clientId));
  assert.match(await auth.beginSignIn(''), /client_id=0123456789ABCDEF/);
});

test('sign-in on an insecure page (no crypto.subtle) is refused with a clear message', async () => {
  const auth = Auth.create({ fetch: async () => null, storage: memoryStorage(), crypto: { getRandomValues: (b) => b }, location: PAGES, configClientId: CLIENT_ID });
  await assert.rejects(auth.beginSignIn(''), (e) => e.code === 'insecure' && /https/.test(e.message));
});

test('Client ID: config.js is the default, a pasted one overrides it, clearing it goes back', async () => {
  const { auth } = make({ fetch: async () => null, configClientId: 'a010d85057d64fdfabe0fb42155cacba' });
  assert.equal(auth.clientId(), 'a010d85057d64fdfabe0fb42155cacba');
  assert.equal(auth.hasConfigClientId(), true);
  assert.equal(auth.hasClientIdOverride(), false);
  assert.match(await auth.beginSignIn(''), /client_id=a010d85057d64fdfabe0fb42155cacba/);
  auth.setClientId(CLIENT_ID);
  assert.equal(auth.hasClientIdOverride(), true);
  assert.equal(auth.clientId(), CLIENT_ID);
  assert.match(await auth.beginSignIn(''), new RegExp('client_id=' + CLIENT_ID));
  auth.setClientId('');
  assert.equal(auth.clientId(), 'a010d85057d64fdfabe0fb42155cacba');
});

test('config.js ships the site’s Client ID and no client secret anywhere', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const cfg = fs.readFileSync(path.join(__dirname, '..', 'public', 'config.js'), 'utf8');
  assert.match(cfg, /SPOTIFY_CLIENT_ID: 'a010d85057d64fdfabe0fb42155cacba'/);
  for (const f of ['config.js', 'app.js', 'lib/spotify-auth.js', 'lib/spotify-api.js', 'lib/spotify-player.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8');
    assert.doesNotMatch(src, /client_secret\s*[:=]|SPOTIFY_CLIENT_SECRET/i, f);
  }
});

test('consumeRedirect: strips code/state from the address bar and restores the carried parameters', () => {
  const state = Auth.encodeState('abc', '?host=ABCD&transport=local');
  const replaced = [];
  const win = {
    location: { pathname: '/spotify-guessing-game/', search: '?code=AQB123&state=' + state, hash: '' },
    history: { replaceState: (a, b, url) => replaced.push(url) },
  };
  const r = Auth.consumeRedirect(win);
  assert.equal(r.code, 'AQB123');
  assert.equal(r.params, '?host=ABCD&transport=local');
  assert.deepEqual(replaced, ['/spotify-guessing-game/?host=ABCD&transport=local']);
  // A normal page load is left alone.
  assert.equal(Auth.consumeRedirect({ location: { search: '?room=ABCD' }, history: { replaceState: () => assert.fail() } }), null);
});

test('completeSignIn: exchanges the code with the verifier and stores the tokens', async () => {
  const { auth, calls, storage, clock } = make({
    fetch: async () => tokenResponse({ access_token: 'AT1', refresh_token: 'RT1', expires_in: 3600, scope: 'streaming' }),
  });
  const events = [];
  auth.onChange((e) => events.push(e.type));
  const url = new URL(await auth.beginSignIn('?room=ABCD'));
  const pending = JSON.parse(storage.getItem(Auth.KEYS.pending));
  await auth.completeSignIn({ code: 'CODE1', state: url.searchParams.get('state') });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://accounts.spotify.com/api/token');
  assert.equal(calls[0].init.method, 'POST');
  const body = new URLSearchParams(calls[0].init.body);
  assert.equal(body.get('grant_type'), 'authorization_code');
  assert.equal(body.get('code'), 'CODE1');
  assert.equal(body.get('code_verifier'), pending.verifier);
  assert.equal(body.get('client_id'), CLIENT_ID);
  assert.equal(body.get('redirect_uri'), 'https://michaelphagen.github.io/spotify-guessing-game/');
  assert.equal(body.get('client_secret'), null, 'no secret in the browser');
  assert.ok(auth.isSignedIn());
  const t = auth.tokens();
  assert.equal(t.accessToken, 'AT1');
  assert.equal(t.refreshToken, 'RT1');
  assert.equal(t.expiresAt, clock.t + 3600 * 1000);
  assert.equal(storage.getItem(Auth.KEYS.pending), null, 'the verifier is used once');
  assert.deepEqual(events, ['signed-in']);
});

test('completeSignIn rejects a state that does not match, and a cancelled sign-in', async () => {
  const { auth } = make({ fetch: async () => assert.fail('must not exchange') });
  await auth.beginSignIn('');
  await assert.rejects(auth.completeSignIn({ code: 'x', state: Auth.encodeState('other', '') }), (e) => e.code === 'state');
  await auth.beginSignIn('');
  await assert.rejects(auth.completeSignIn({ code: '', state: 'x', error: 'access_denied' }), (e) => e.code === 'denied' && /cancelled/.test(e.message));
});

test('getAccessToken: fresh token as-is; refreshed a minute before expiry; refresh tokens rotate', async () => {
  let n = 0;
  const { auth, calls, storage, clock } = make({
    fetch: async (url, init) => {
      const b = new URLSearchParams(init.body);
      if (b.get('grant_type') === 'authorization_code') return tokenResponse({ access_token: 'AT0', refresh_token: 'RT0', expires_in: 3600 });
      n++;
      return tokenResponse(n === 1 ? { access_token: 'AT1', refresh_token: 'RT1', expires_in: 3600 } : { access_token: 'AT2', expires_in: 3600 });
    },
  });
  const url = new URL(await auth.beginSignIn(''));
  await auth.completeSignIn({ code: 'c', state: url.searchParams.get('state') });
  assert.equal(await auth.getAccessToken(), 'AT0');
  clock.t += 3600 * 1000 - 30 * 1000; // 30 s left: refresh now
  // Two callers at once share one refresh request.
  const [a, b] = await Promise.all([auth.getAccessToken(), auth.getAccessToken()]);
  assert.equal(a, 'AT1');
  assert.equal(b, 'AT1');
  const refreshCalls = calls.filter((c) => /refresh_token/.test(c.init.body));
  assert.equal(refreshCalls.length, 1);
  const rb = new URLSearchParams(refreshCalls[0].init.body);
  assert.equal(rb.get('refresh_token'), 'RT0');
  assert.equal(rb.get('client_id'), CLIENT_ID);
  // Spotify may or may not send a new refresh token: the old one is kept if not.
  assert.equal(await auth.getAccessToken({ forceRefresh: true }), 'AT2');
  assert.equal(JSON.parse(storage.getItem(Auth.KEYS.tokens)).refreshToken, 'RT1');
});

test('a refused refresh signs out (event), a network error keeps the tokens', async () => {
  let mode = 'network';
  const { auth, clock } = make({
    fetch: async (url, init) => {
      const b = new URLSearchParams(init.body);
      if (b.get('grant_type') === 'authorization_code') return tokenResponse({ access_token: 'AT0', refresh_token: 'RT0', expires_in: 3600 });
      if (mode === 'network') throw new TypeError('Failed to fetch');
      return tokenResponse({ error: 'invalid_grant', error_description: 'Refresh token revoked' }, 400);
    },
  });
  const events = [];
  auth.onChange((e) => events.push(e.type + ':' + (e.reason || '')));
  const url = new URL(await auth.beginSignIn(''));
  await auth.completeSignIn({ code: 'c', state: url.searchParams.get('state') });
  clock.t += 3600 * 1000;
  await assert.rejects(auth.getAccessToken(), (e) => e.code === 'network');
  assert.ok(auth.isSignedIn(), 'still signed in after a network blip');
  mode = 'refused';
  await assert.rejects(auth.getAccessToken(), (e) => e.code === 'signed-out');
  assert.equal(auth.isSignedIn(), false);
  assert.deepEqual(events, ['signed-in:', 'signed-out:expired']);
  await assert.rejects(auth.getAccessToken(), (e) => e.code === 'signed-out');
});

test('signOut forgets the tokens', async () => {
  const { auth } = make({ fetch: async () => tokenResponse({ access_token: 'AT0', refresh_token: 'RT0', expires_in: 3600 }) });
  const url = new URL(await auth.beginSignIn(''));
  await auth.completeSignIn({ code: 'c', state: url.searchParams.get('state') });
  auth.signOut();
  assert.equal(auth.isSignedIn(), false);
  assert.equal(auth.tokens(), null);
});

test('refresh: Spotify down (5xx) keeps the sign-in; signing out while a refresh is on its way stays signed out', async () => {
  let mode = 'down';
  let release;
  const { auth, clock } = make({
    fetch: async (url, init) => {
      const b = new URLSearchParams(init.body);
      if (b.get('grant_type') === 'authorization_code') return tokenResponse({ access_token: 'AT0', refresh_token: 'RT0', expires_in: 3600 });
      if (mode === 'down') return tokenResponse({ error: 'server_error' }, 503);
      await new Promise((r) => { release = r; });
      return tokenResponse({ access_token: 'AT1', refresh_token: 'RT1', expires_in: 3600 });
    },
  });
  const url = new URL(await auth.beginSignIn(''));
  await auth.completeSignIn({ code: 'c', state: url.searchParams.get('state') });
  clock.t += 3600 * 1000;
  await assert.rejects(auth.getAccessToken(), (e) => e.code === 'network');
  assert.ok(auth.isSignedIn(), 'a 503 is not a revoked refresh token');
  mode = 'slow';
  const pending = auth.getAccessToken();
  await new Promise((r) => setImmediate(r));
  auth.signOut();
  release();
  await assert.rejects(pending, (e) => e.code === 'signed-out');
  assert.equal(auth.isSignedIn(), false, 'the late refresh answer must not sign back in');
});

test('state: carried parameter values are checked too', () => {
  assert.equal(Auth.carriedParams('?room=WXYZ&api=javascript%3Aalert(1)&transport=evil'), '?room=WXYZ');
  assert.equal(Auth.carriedParams('?host=AB%26code%3Dx&api=none'), '?api=none');
  const forged = Auth.encodeState('n', '?room=%3Cscript%3E&api=http%3A%2F%2F127.0.0.1%3A3000');
  assert.deepEqual(Auth.decodeState(forged), { nonce: 'n', params: '?api=http%3A%2F%2F127.0.0.1%3A3000' });
});
