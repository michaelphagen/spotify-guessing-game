/**
 * Spotify sign-in for the static site: Authorization Code with PKCE, entirely
 * in the browser (no client secret, no backend), so it works on GitHub Pages.
 *
 *   1. beginSignIn(): make a random code verifier, store it (localStorage) with
 *      a random `state`, and send the browser to accounts.spotify.com/authorize
 *      with the verifier's SHA-256 challenge. `state` also carries the page's
 *      room query parameters (?room=, ?host=, ?api=, ?transport=) so a game in
 *      progress is picked up again after the round trip.
 *   2. Spotify redirects back to the page itself (redirect URI = origin +
 *      path, e.g. https://michaelphagen.github.io/spotify-guessing-game/) with
 *      ?code=...&state=.... consumeRedirect() strips those from the address bar
 *      at once (putting the carried parameters back), before anything else on
 *      the page reads location.search.
 *   3. completeSignIn() swaps the code (plus the verifier) for tokens at
 *      accounts.spotify.com/api/token. Tokens live in localStorage and are
 *      refreshed with the refresh token shortly before they expire.
 *
 * Shared by the browser (window.SpotifyAuth) and the Node tests: all I/O
 * (fetch, storage, crypto, clock) is injected.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SpotifyAuth = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var AUTHORIZE_URL = 'https://accounts.spotify.com/authorize';
  var TOKEN_URL = 'https://accounts.spotify.com/api/token';
  var SCOPES = [
    'streaming', 'user-read-email', 'user-read-private',
    'user-modify-playback-state', 'user-read-playback-state',
    'playlist-read-private', 'playlist-read-collaborative',
  ];
  // Query parameters of the page that survive the trip to Spotify and back.
  var CARRIED_PARAMS = ['room', 'host', 'api', 'transport'];
  // What each carried parameter may look like (anything else is dropped).
  var CARRIED_VALUES = {
    room: /^[A-Za-z0-9 -]{1,16}$/,
    host: /^[A-Za-z0-9 -]{1,16}$/,
    transport: /^(local|peer)$/i,
    api: /^(none|static|off|https?:\/\/[^\s<>"'`]{1,300})$/i,
  };
  var VERIFIER_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
  var KEY_TOKENS = 'gts:sp:tokens';
  var KEY_PENDING = 'gts:sp:pending';
  var KEY_CLIENT_ID = 'gts:sp:client-id';
  var PENDING_MAX_AGE_MS = 30 * 60 * 1000;
  var REFRESH_EARLY_MS = 60 * 1000; // refresh a minute before the token expires
  var CLIENT_ID_RE = /^[0-9a-f]{32}$/i;

  function AuthError(code, message, status) {
    var e = new Error(message);
    e.name = 'AuthError';
    e.code = code; // 'signed-out' | 'no-client-id' | 'state' | 'denied' | 'token' | 'network'
    if (status) e.status = status;
    return e;
  }

  // ---------- Pure helpers ----------

  /** A random string of `length` characters from the PKCE verifier alphabet. */
  function randomString(length, getRandomValues) {
    var bytes = new Uint8Array(length);
    getRandomValues(bytes);
    var out = '';
    // 66 characters: reject bytes >= 198 (3 * 66) so every character is equally likely.
    for (var i = 0; i < length; i++) {
      var b = bytes[i];
      while (b >= 198) { var one = new Uint8Array(1); getRandomValues(one); b = one[0]; }
      out += VERIFIER_CHARS[b % VERIFIER_CHARS.length];
    }
    return out;
  }

  function base64url(bytes) {
    var bin = '';
    var arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    for (var i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
    var b64 = typeof btoa === 'function' ? btoa(bin) : Buffer.from(bin, 'binary').toString('base64');
    return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function utf8(s) {
    if (typeof TextEncoder === 'function') return new TextEncoder().encode(s);
    var bin = unescape(encodeURIComponent(s));
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function fromBase64url(s) {
    var b64 = String(s).replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    var bin = typeof atob === 'function' ? atob(b64) : Buffer.from(b64, 'base64').toString('binary');
    try { return decodeURIComponent(escape(bin)); } catch (e) { return bin; }
  }

  /** PKCE S256 code challenge for a verifier: base64url(SHA-256(verifier)). */
  function codeChallenge(verifier, subtle) {
    return Promise.resolve(subtle.digest('SHA-256', utf8(verifier))).then(base64url);
  }

  /**
   * The redirect URI for a page: its origin and path, without query, hash or a
   * trailing index.html. Spotify compares it exactly with the one registered
   * in the app's dashboard, e.g. https://michaelphagen.github.io/spotify-guessing-game/
   */
  function redirectUri(loc) {
    var path = String(loc.pathname || '/').replace(/\/index\.html?$/i, '/');
    return String(loc.origin) + path;
  }

  function parseQuery(search) {
    var out = {};
    String(search || '').replace(/^\?/, '').split('&').forEach(function (pair) {
      if (!pair) return;
      var i = pair.indexOf('=');
      var k = i === -1 ? pair : pair.slice(0, i);
      var v = i === -1 ? '' : pair.slice(i + 1);
      try { k = decodeURIComponent(k.replace(/\+/g, ' ')); v = decodeURIComponent(v.replace(/\+/g, ' ')); } catch (e) { return; }
      if (!(k in out)) out[k] = v;
    });
    return out;
  }

  /** The room/backend parameters of a query string, as a '?a=b&c=d' string ('' if none). */
  function carriedParams(search) {
    var q = parseQuery(search);
    var parts = [];
    CARRIED_PARAMS.forEach(function (k) {
      if (q[k] != null && q[k] !== '' && CARRIED_VALUES[k].test(q[k])) parts.push(k + '=' + encodeURIComponent(q[k]));
    });
    return parts.length ? '?' + parts.join('&') : '';
  }

  /** OAuth `state`: a random nonce plus the carried query string, base64url JSON. */
  function encodeState(nonce, params) {
    return base64url(utf8(JSON.stringify({ n: nonce, q: params || '' })));
  }

  /** { nonce, params } from a state string, or null if it isn't one of ours. */
  function decodeState(state) {
    try {
      var o = JSON.parse(fromBase64url(state));
      if (!o || typeof o.n !== 'string' || !o.n) return null;
      var q = typeof o.q === 'string' && /^(\?[^#]*)?$/.test(o.q) ? o.q : '';
      // Only ever restore our own parameters, whatever the state says.
      return { nonce: o.n, params: carriedParams(q) };
    } catch (e) {
      return null;
    }
  }

  function buildAuthorizeUrl(o) {
    var q = [
      ['response_type', 'code'],
      ['client_id', o.clientId],
      ['scope', (o.scopes || SCOPES).join(' ')],
      ['code_challenge_method', 'S256'],
      ['code_challenge', o.challenge],
      ['redirect_uri', o.redirectUri],
      ['state', o.state],
    ];
    return AUTHORIZE_URL + '?' + q.map(function (p) { return p[0] + '=' + encodeURIComponent(p[1]); }).join('&');
  }

  /** { code, state, error } if the query string is Spotify's redirect back to us, else null. */
  function parseRedirect(search) {
    var q = parseQuery(search);
    if (!q.state || (!q.code && !q.error)) return null;
    return { code: q.code || '', state: q.state, error: q.error || '' };
  }

  function validClientId(id) {
    return typeof id === 'string' && CLIENT_ID_RE.test(id.trim());
  }

  /**
   * On page load, before anything reads location.search: if this is Spotify's
   * redirect back, remove code/state from the address bar (restoring the
   * parameters carried in `state`) and return what's needed to finish signing
   * in. Returns null otherwise.
   */
  function consumeRedirect(win) {
    var r = parseRedirect(win.location.search);
    if (!r) return null;
    var st = decodeState(r.state);
    r.params = st ? st.params : '';
    try { win.history.replaceState(null, '', win.location.pathname + r.params + (win.location.hash || '')); } catch (e) { /* ignore */ }
    return r;
  }

  // ---------- Token store / sign-in controller ----------

  /**
   * @param {object} deps
   * @param {Function} deps.fetch
   * @param {object} deps.storage      localStorage-like
   * @param {object} deps.crypto       { getRandomValues, subtle }
   * @param {object} deps.location     { origin, pathname, search }
   * @param {string} [deps.configClientId]  config.SPOTIFY_CLIENT_ID
   * @param {Function} [deps.now]
   */
  function create(deps) {
    var fetchImpl = deps.fetch;
    var storage = deps.storage;
    var cryptoImpl = deps.crypto;
    var now = deps.now || function () { return Date.now(); };
    var listeners = [];
    var refreshing = null;
    var generation = 0; // bumped by signOut(): a refresh that was on its way must not sign back in

    function sget(k) { try { var v = storage.getItem(k); return v ? JSON.parse(v) : null; } catch (e) { return null; } }
    function sset(k, v) { try { storage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage full or blocked */ } }
    function sdel(k) { try { storage.removeItem(k); } catch (e) { /* ignore */ } }

    function emit(ev) { listeners.slice().forEach(function (fn) { try { fn(ev); } catch (e) { /* ignore */ } }); }

    /** The Client ID pasted on the setup screen (an override), else config.SPOTIFY_CLIENT_ID. */
    function clientId() {
      var saved = sget(KEY_CLIENT_ID);
      if (validClientId(saved)) return saved.trim();
      return validClientId(deps.configClientId) ? deps.configClientId.trim() : '';
    }

    function setClientId(id) {
      id = String(id || '').trim();
      if (!id) { sdel(KEY_CLIENT_ID); return true; }
      if (!validClientId(id)) return false;
      sset(KEY_CLIENT_ID, id);
      return true;
    }

    function tokens() {
      var t = sget(KEY_TOKENS);
      return t && typeof t.accessToken === 'string' && t.accessToken ? t : null;
    }

    function saveTokens(body, prev) {
      var t = {
        accessToken: body.access_token,
        refreshToken: body.refresh_token || (prev && prev.refreshToken) || '',
        expiresAt: now() + (Number(body.expires_in) > 0 ? Number(body.expires_in) : 3600) * 1000,
        scope: body.scope || (prev && prev.scope) || '',
        clientId: (prev && prev.clientId) || body.clientId || clientId(),
      };
      sset(KEY_TOKENS, t);
      return t;
    }

    function tokenRequest(params) {
      var body = Object.keys(params).map(function (k) { return k + '=' + encodeURIComponent(params[k]); }).join('&');
      return Promise.resolve()
        .then(function () {
          return fetchImpl(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body });
        })
        .catch(function () { throw AuthError('network', 'Couldn’t reach Spotify to sign in. Check the internet connection.'); })
        .then(function (res) {
          return res.json().catch(function () { return {}; }).then(function (j) {
            if (!res.ok || !j.access_token) {
              var desc = j && (j.error_description || j.error) ? ' (' + (j.error_description || j.error) + ')' : '';
              throw AuthError('token', 'Spotify didn’t accept the sign-in' + desc + '.', res.status);
            }
            return j;
          });
        });
    }

    /** Start signing in: resolves to the authorize URL to send the browser to. */
    function beginSignIn(search) {
      var id = clientId();
      if (!id) return Promise.reject(AuthError('no-client-id', 'Paste your Spotify app’s Client ID first (see “Full songs with Spotify” in the README).'));
      if (!cryptoImpl || !cryptoImpl.subtle || !cryptoImpl.getRandomValues) {
        // crypto.subtle only exists on secure pages; Spotify also only accepts https or loopback redirects.
        return Promise.reject(AuthError('insecure', 'Signing in with Spotify needs a secure address: https://… (or http://127.0.0.1 on this computer).'));
      }
      var verifier = randomString(64, cryptoImpl.getRandomValues.bind(cryptoImpl));
      var nonce = randomString(24, cryptoImpl.getRandomValues.bind(cryptoImpl));
      var state = encodeState(nonce, carriedParams(search != null ? search : deps.location.search));
      var redirect = redirectUri(deps.location);
      return codeChallenge(verifier, cryptoImpl.subtle).then(function (challenge) {
        sset(KEY_PENDING, { verifier: verifier, nonce: nonce, redirectUri: redirect, clientId: id, createdAt: now() });
        return buildAuthorizeUrl({ clientId: id, redirectUri: redirect, challenge: challenge, state: state });
      });
    }

    /** Finish signing in with the { code, state, error } from consumeRedirect(). */
    function completeSignIn(r) {
      var pending = sget(KEY_PENDING);
      sdel(KEY_PENDING);
      if (r.error) {
        return Promise.reject(AuthError('denied', r.error === 'access_denied' ? 'Spotify sign-in was cancelled.' : 'Spotify sign-in failed (' + r.error + ').'));
      }
      var st = decodeState(r.state);
      if (!pending || !st || st.nonce !== pending.nonce || !(now() - pending.createdAt < PENDING_MAX_AGE_MS)) {
        return Promise.reject(AuthError('state', 'That Spotify sign-in link is out of date. Please sign in again.'));
      }
      return tokenRequest({
        grant_type: 'authorization_code',
        code: r.code,
        redirect_uri: pending.redirectUri,
        client_id: pending.clientId,
        code_verifier: pending.verifier,
      }).then(function (body) {
        var t = saveTokens(Object.assign({ clientId: pending.clientId }, body), null);
        emit({ type: 'signed-in' });
        return t;
      });
    }

    function refresh() {
      if (refreshing) return refreshing;
      var t = tokens();
      if (!t || !t.refreshToken) {
        return Promise.reject(AuthError('signed-out', 'Your Spotify sign-in has expired. Sign in again.'));
      }
      var gen = generation;
      var p = tokenRequest({ grant_type: 'refresh_token', refresh_token: t.refreshToken, client_id: t.clientId || clientId() })
        .then(function (body) {
          if (refreshing === p) refreshing = null;
          if (gen !== generation) throw AuthError('signed-out', 'Signed out of Spotify.');
          return saveTokens(body, t);
        }, function (err) {
          if (refreshing === p) refreshing = null;
          if (gen !== generation) throw AuthError('signed-out', 'Signed out of Spotify.');
          // A refused refresh token (400 invalid_grant / 401) signs out. A network
          // error or Spotify being down (5xx, 429) keeps the tokens: try again later.
          if (err.code === 'token' && (err.status === 400 || err.status === 401)) {
            sdel(KEY_TOKENS);
            emit({ type: 'signed-out', reason: 'expired' });
            throw AuthError('signed-out', 'Your Spotify sign-in has expired. Sign in again.');
          }
          if (err.code === 'token') throw AuthError('network', 'Spotify’s sign-in service isn’t answering right now. Try again in a moment.', err.status);
          throw err;
        });
      refreshing = p;
      return p;
    }

    /** A valid access token (refreshed when it expires within a minute). */
    function getAccessToken(opts) {
      var t = tokens();
      if (!t) return Promise.reject(AuthError('signed-out', 'Sign in with Spotify to play full songs.'));
      if (opts && opts.forceRefresh) return refresh().then(function (n) { return n.accessToken; });
      if (t.expiresAt - REFRESH_EARLY_MS > now()) return Promise.resolve(t.accessToken);
      return refresh().then(function (n) { return n.accessToken; });
    }

    function signOut() {
      generation++;
      refreshing = null;
      sdel(KEY_TOKENS);
      sdel(KEY_PENDING);
      emit({ type: 'signed-out', reason: 'user' });
    }

    return {
      clientId: clientId,
      hasConfigClientId: function () { return validClientId(deps.configClientId); },
      /** A Client ID pasted on the setup screen is in use (overriding the config one). */
      hasClientIdOverride: function () { return validClientId(sget(KEY_CLIENT_ID)); },
      setClientId: setClientId,
      isSignedIn: function () { return !!tokens(); },
      tokens: tokens,
      beginSignIn: beginSignIn,
      completeSignIn: completeSignIn,
      getAccessToken: getAccessToken,
      refresh: refresh,
      signOut: signOut,
      redirectUri: function () { return redirectUri(deps.location); },
      onChange: function (fn) { listeners.push(fn); },
    };
  }

  return {
    AUTHORIZE_URL: AUTHORIZE_URL,
    TOKEN_URL: TOKEN_URL,
    SCOPES: SCOPES,
    CARRIED_PARAMS: CARRIED_PARAMS,
    VERIFIER_CHARS: VERIFIER_CHARS,
    KEYS: { tokens: KEY_TOKENS, pending: KEY_PENDING, clientId: KEY_CLIENT_ID },
    AuthError: AuthError,
    randomString: randomString,
    base64url: base64url,
    codeChallenge: codeChallenge,
    redirectUri: redirectUri,
    carriedParams: carriedParams,
    encodeState: encodeState,
    decodeState: decodeState,
    buildAuthorizeUrl: buildAuthorizeUrl,
    parseRedirect: parseRedirect,
    consumeRedirect: consumeRedirect,
    validClientId: validClientId,
    create: create,
  };
});
