/*
 * Where the game gets its song lists and cover art from.
 *
 * Server mode: the Node backend answers GET api/tracks and api/cover (paths are
 * relative, so the game also works under a sub-path like /RepoName/).
 * Static mode: with no backend (GitHub Pages and other static hosts), the
 * Spotify embed page is fetched through public CORS proxies and parsed in the
 * browser with the same parser the server uses. Cover art comes from Spotify's
 * oEmbed endpoint, which allows cross-origin requests.
 * Example playlist: its track list is bundled with the game as a JSON snapshot
 * (config EXAMPLE_URL / EXAMPLE_SNAPSHOT, made by `npm run snapshot`) and is
 * served from there in either mode, falling back to the live playlist.
 *
 * Shared by the browser (window.TrackSource) and the Node tests. All I/O goes
 * through injected dependencies.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TrackSource = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var CACHE_TTL_MS = 10 * 60 * 1000;
  var STORE_NO_BACKEND = 'gts:no-backend';
  var STORE_PROXY = 'gts:proxy';
  var DEFAULT_EXAMPLE_URL = 'https://open.spotify.com/playlist/6i2Qd6OpeRBAzxfscNXeWp';
  var DEFAULT_EXAMPLE_SNAPSHOT = 'data/example-playlist.json';

  /**
   * Resolve the backend base URL. Returns 'none' (static mode only), '' (same
   * origin) or an absolute base ending in '/'.
   * Precedence: ?api= query parameter, then config.API_BASE, then same origin.
   */
  function resolveApiBase(configured, search) {
    var fromQuery = null;
    var m = /[?&]api=([^&#]*)/.exec(search || '');
    if (m) {
      try { fromQuery = decodeURIComponent(m[1].replace(/\+/g, ' ')).trim(); } catch (e) { fromQuery = null; }
    }
    var candidates = [fromQuery, configured];
    for (var i = 0; i < candidates.length; i++) {
      var v = candidates[i];
      if (v == null || v === '') continue;
      v = String(v).trim();
      if (/^(none|static|off)$/i.test(v)) return 'none';
      if (/^https?:\/\/[^\s/?#]+/i.test(v)) return v.replace(/[?#].*$/, '').replace(/\/*$/, '/');
    }
    return '';
  }

  function fillTemplate(template, target) {
    return template.split('{url}').join(encodeURIComponent(target)).split('{raw}').join(target);
  }

  function isHttpsUrl(v) {
    return typeof v === 'string' && /^https:\/\/[^\s]+$/i.test(v);
  }

  /**
   * Check a bundled snapshot ({ source, tracks, snapshotAt }) against the
   * { type, id } it should hold. Returns { source, tracks, skipped, snapshotAt }
   * with only well-formed, de-duplicated tracks, or null if it doesn't fit.
   */
  function validateSnapshot(data, ref, SpotifyUrl) {
    if (!data || typeof data !== 'object' || !data.source || !Array.isArray(data.tracks)) return null;
    var src = data.source;
    var srcRef;
    try { srcRef = SpotifyUrl.parseSpotifyInput(String(src.url || '')); } catch (e) { return null; }
    if (!ref || srcRef.type !== ref.type || srcRef.id !== ref.id) return null;
    var seen = {};
    var tracks = [];
    data.tracks.forEach(function (t) {
      if (!t || typeof t !== 'object') return;
      if (typeof t.id !== 'string' || !t.id || seen[t.id]) return;
      if (typeof t.title !== 'string' || !t.title || !isHttpsUrl(t.previewUrl)) return;
      seen[t.id] = true;
      tracks.push({
        id: t.id,
        title: t.title,
        artist: typeof t.artist === 'string' ? t.artist : '',
        previewUrl: t.previewUrl,
        image: isHttpsUrl(t.image) ? t.image : null,
      });
    });
    if (!tracks.length) return null;
    return {
      source: {
        type: srcRef.type,
        name: typeof src.name === 'string' && src.name ? src.name : 'Example ' + srcRef.type,
        image: isHttpsUrl(src.image) ? src.image : null,
        url: 'https://open.spotify.com/' + srcRef.type + '/' + srcRef.id,
      },
      tracks: tracks,
      skipped: 0,
      snapshotAt: typeof data.snapshotAt === 'string' ? data.snapshotAt : null,
    };
  }

  function typeWord(ref) {
    return ref && ref.type ? ref.type : 'link';
  }

  /**
   * @param {object} deps
   * @param {object} deps.config          window.GTS_CONFIG
   * @param {Function} deps.fetch         fetch implementation
   * @param {object} deps.SpotifyUrl      public/lib/spotify-url.js
   * @param {object} deps.EmbedParser     public/lib/embed-parser.js
   * @param {string} [deps.search]        location.search (for ?api=)
   * @param {object} [deps.storage]       sessionStorage-like (getItem/setItem); optional
   */
  function create(deps) {
    var config = deps.config || {};
    var fetchImpl = deps.fetch;
    var SpotifyUrl = deps.SpotifyUrl;
    var EmbedParser = deps.EmbedParser;
    var storage = deps.storage || null;
    var base = resolveApiBase(config.API_BASE, deps.search);
    var proxies = Array.isArray(config.CORS_PROXIES) ? config.CORS_PROXIES.filter(function (p) { return p && p.url; }) : [];
    var timeoutMs = Number(config.PROXY_TIMEOUT_MS) > 0 ? Number(config.PROXY_TIMEOUT_MS) : 12000;
    var cache = new Map();
    var exampleUrl = typeof config.EXAMPLE_URL === 'string' && config.EXAMPLE_URL ? config.EXAMPLE_URL : DEFAULT_EXAMPLE_URL;
    var exampleSnapshot = typeof config.EXAMPLE_SNAPSHOT === 'string' ? config.EXAMPLE_SNAPSHOT : DEFAULT_EXAMPLE_SNAPSHOT;
    var exampleRef = null;
    try { exampleRef = SpotifyUrl.parseSpotifyInput(exampleUrl); } catch (e) { exampleRef = null; }
    var snapshotPromise = null;

    function sget(key) { try { return storage ? storage.getItem(key) : null; } catch (e) { return null; } }
    function sset(key, v) { try { if (storage) storage.setItem(key, v); } catch (e) { /* ignore */ } }

    // 'yes' | 'no' | 'unknown'. A same-origin "no" is remembered for the session.
    var backend = base === 'none' ? 'no' : base === '' && sget(STORE_NO_BACKEND) === '1' ? 'no' : 'unknown';

    function markNoBackend() {
      backend = 'no';
      if (base === '') sset(STORE_NO_BACKEND, '1');
    }

    /**
     * Call the backend. Resolves to { res, body } when a backend answered with
     * JSON, or null when there is no usable backend (static host 404 page,
     * network error), in which case the caller falls back to static mode.
     */
    function callBackend(path) {
      if (backend === 'no') return Promise.resolve(null);
      return Promise.resolve()
        .then(function () { return fetchImpl(base + path, { headers: { Accept: 'application/json' } }); })
        .then(function (res) {
          var ct = (res.headers && res.headers.get && res.headers.get('content-type')) || '';
          if (!/json/i.test(ct)) {
            // A static host answers api/... with its HTML 404 page: no backend here.
            markNoBackend();
            return null;
          }
          backend = 'yes';
          return res.json().catch(function () { return {}; }).then(function (body) { return { res: res, body: body }; });
        }, function () {
          // Network error (backend down, blocked by CORS, file://). Use static
          // mode for this request, but try the backend again next time.
          return null;
        });
    }

    /** Fetch `target` through one proxy; resolves to { ok, status, html }. */
    function fetchViaProxy(proxy, target) {
      return new Promise(function (resolve, reject) {
        var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
        // One timer covers connecting and reading the body, and also works for
        // fetch implementations that ignore the abort signal.
        var timer = setTimeout(function () {
          if (ctrl) ctrl.abort();
          reject(new Error('timed out'));
        }, timeoutMs);
        var init = { headers: Object.assign({}, proxy.headers || {}) };
        if (ctrl) init.signal = ctrl.signal;
        Promise.resolve()
          .then(function () { return fetchImpl(fillTemplate(proxy.url, target), init); })
          .then(function (res) {
            return res.text().then(function (text) {
              var html = text;
              if (proxy.format === 'allorigins-json') {
                var j = JSON.parse(text);
                html = j && typeof j.contents === 'string' ? j.contents : '';
              }
              return { ok: res.ok, status: res.status, html: html };
            });
          })
          .then(function (v) { clearTimeout(timer); resolve(v); }, function (e) { clearTimeout(timer); reject(e); });
      });
    }

    function orderedProxies() {
      var last = sget(STORE_PROXY);
      var list = proxies.slice();
      var i = list.findIndex(function (p) { return p.name && p.name === last; });
      if (i > 0) list.unshift(list.splice(i, 1)[0]);
      return list;
    }

    function emptyMessage(result) {
      return result.skipped
        ? 'Found ' + result.skipped + ' track(s), but none of them have an audio preview available. Try another playlist.'
        : 'No tracks were found at that link.';
    }

    /** Static mode: embed page via CORS proxies, parsed in the browser. */
    function loadStatic(input, backendUnreachable) {
      var ref;
      try {
        ref = SpotifyUrl.parseSpotifyInput(String(input || ''));
      } catch (err) {
        return Promise.reject(new Error(err && err.message ? err.message : 'That does not look like a Spotify link.'));
      }
      var key = ref.type + ':' + ref.id;
      var hit = cache.get(key);
      if (hit && Date.now() < hit.expires) return Promise.resolve(hit.value);

      var target = EmbedParser.embedUrl(ref);
      var list = orderedProxies();
      var attempts = [];

      function attempt(i) {
        if (i >= list.length) {
          var msg = 'Couldn’t load that ' + typeWord(ref) + '. Public proxies are rate limited; try again or run the server locally.';
          if (backendUnreachable) msg = 'Couldn’t reach the game server, and the public proxies failed too. ' + msg;
          var e = new Error(msg);
          e.attempts = attempts;
          throw e;
        }
        var proxy = list[i];
        return fetchViaProxy(proxy, target).then(function (r) {
          // Parse whenever the page data is there, even on a non-2xx status:
          // Spotify's own "not found" page is a valid answer.
          if (!/__NEXT_DATA__/.test(r.html)) throw new Error('HTTP ' + r.status + ' without embed data');
          var parsed;
          try {
            parsed = EmbedParser.parseEmbedHtml(r.html, ref.type);
          } catch (err) {
            // Spotify itself said "not found": no point asking another proxy.
            if (err && err.code === 'not_found') err.definitive = true;
            throw err;
          }
          sset(STORE_PROXY, proxy.name || '');
          return parsed;
        }).catch(function (err) {
          if (err && err.definitive) {
            throw new Error(err.message || 'Spotify could not find that link.');
          }
          attempts.push((proxy.name || proxy.url) + ': ' + (err && err.name === 'AbortError' ? 'timed out' : (err && err.message) || 'failed'));
          return attempt(i + 1);
        });
      }

      return attempt(0).then(function (parsed) {
        if (!parsed.tracks.length) throw new Error(emptyMessage(parsed));
        var value = { source: parsed.source, tracks: parsed.tracks, skipped: parsed.skipped, via: 'proxy' };
        cache.set(key, { value: value, expires: Date.now() + CACHE_TTL_MS });
        return value;
      });
    }

    /** { type, id } when `input` is the example playlist (and a snapshot is configured), else null. */
    function exampleRefFor(input) {
      if (!exampleRef || !exampleSnapshot) return null;
      var ref;
      try { ref = SpotifyUrl.parseSpotifyInput(String(input || '')); } catch (e) { return null; }
      return ref.type === exampleRef.type && ref.id === exampleRef.id ? ref : null;
    }

    /**
     * The bundled example snapshot (a relative path, so it works under a
     * sub-path). Resolves to the track list, or null when it can't be used;
     * a failed load is retried on the next call.
     */
    function loadSnapshot(ref) {
      if (!snapshotPromise) {
        snapshotPromise = Promise.resolve()
          .then(function () { return fetchImpl(exampleSnapshot, { headers: { Accept: 'application/json' } }); })
          .then(function (res) { return res.ok ? res.json() : null; })
          .then(function (data) { return validateSnapshot(data, ref, SpotifyUrl); })
          .catch(function () { return null; })
          .then(function (value) {
            if (!value) snapshotPromise = null;
            return value;
          });
      }
      return snapshotPromise.then(function (value) {
        return value ? Object.assign({}, value, { via: 'snapshot' }) : null;
      });
    }

    /**
     * Load { source, tracks, skipped, via } for a Spotify link. Rejects with an
     * Error whose message is safe to show to the player. The example playlist
     * comes from its bundled snapshot when that loads (via: 'snapshot').
     */
    function loadTracks(input) {
      var ref = exampleRefFor(input);
      if (!ref) return loadLive(input);
      return loadSnapshot(ref).then(function (snap) { return snap || loadLive(input); });
    }

    function loadLive(input) {
      return callBackend('api/tracks?url=' + encodeURIComponent(String(input || ''))).then(function (r) {
        // A backend was configured explicitly (API_BASE or ?api=) but didn't answer.
        if (!r) return loadStatic(input, base !== '' && base !== 'none');
        if (!r.res.ok) throw new Error((r.body && r.body.error) || 'Could not load that link (HTTP ' + r.res.status + ').');
        var body = r.body || {};
        if (!body.source || !Array.isArray(body.tracks)) throw new Error('The game server sent an unexpected response.');
        body.via = 'server';
        return body;
      });
    }

    function oembedCover(trackId) {
      var url = 'https://open.spotify.com/oembed?url=' + encodeURIComponent('https://open.spotify.com/track/' + trackId);
      return fetchImpl(url)
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (j) {
          return j && typeof j.thumbnail_url === 'string' && /^https:\/\//.test(j.thumbnail_url) ? j.thumbnail_url : null;
        });
    }

    /** Resolve a cover image URL for a track id, or null. Never rejects. */
    function coverUrl(trackId) {
      if (!/^[A-Za-z0-9]{10,40}$/.test(String(trackId || ''))) return Promise.resolve(null);
      return callBackend('api/cover?id=' + encodeURIComponent(trackId))
        .then(function (r) {
          if (r) return r.res.ok && r.body && typeof r.body.image === 'string' ? r.body.image : null;
          return oembedCover(trackId);
        })
        .catch(function () { return null; });
    }

    return {
      loadTracks: loadTracks,
      coverUrl: coverUrl,
      exampleUrl: function () { return exampleUrl; },
      isExample: function (input) { return !!exampleRefFor(input); },
      /** The example's bundled snapshot only (never Spotify); resolves to null if unavailable. */
      loadExampleSnapshot: function () { return exampleRef && exampleSnapshot ? loadSnapshot(exampleRef) : Promise.resolve(null); },
      mode: function () { return backend === 'yes' ? 'server' : backend === 'no' ? 'static' : 'unknown'; },
      apiBase: function () { return base; },
    };
  }

  return { create: create, resolveApiBase: resolveApiBase, fillTemplate: fillTemplate, validateSnapshot: validateSnapshot };
});
