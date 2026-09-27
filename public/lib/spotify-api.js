/**
 * Spotify Web API calls for the "Full songs via Spotify" sound option: loading
 * a playlist's, album's or track's songs, and the Connect player endpoints.
 *
 * Every request carries the signed-in user's token (lib/spotify-auth.js).
 *   401  the token was refreshed and the request retried once;
 *   429  the request waits for Retry-After and is retried (up to twice);
 *   403 / 404 on the player: mapped to "Premium required" / "no active device".
 * Errors are SpotifyApiError { code, status, message (safe to show) }.
 *
 * Endpoints as of Spotify's February 2026 Web API changes: playlist contents
 * come from GET /playlists/{id}/items (items[].item), and for apps in
 * Development Mode only for playlists the signed-in user owns or collaborates
 * on. Other playlists answer 403: loadTracks() then rejects with code
 * 'playlist-not-owned' and the game falls back to the public embed page.
 *
 * Shared by the browser (window.SpotifyApi) and the Node tests (fetch and the
 * sleep function are injected).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SpotifyApi = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var API_BASE = 'https://api.spotify.com/v1';
  var PAGE_LIMIT = 50;
  var MAX_PAGES = 200; // 10,000 songs: Spotify's playlist size limit
  var MAX_RETRY_AFTER_S = 30;

  function SpotifyApiError(code, message, status, extra) {
    var e = new Error(message);
    e.name = 'SpotifyApiError';
    e.code = code;
    e.status = status || 0;
    if (extra) Object.keys(extra).forEach(function (k) { e[k] = extra[k]; });
    return e;
  }

  var MESSAGES = {
    premium: 'Full-song playback needs Spotify Premium. Switching to 30-second previews.',
    'no-device': 'No active Spotify device. Open Spotify on the device you picked (or pick another one under “Plays on”) and tap play again.',
    'signed-out': 'Your Spotify sign-in has expired. Sign in again.',
    rate: 'Spotify is rate limiting requests. Wait a moment and try again.',
    network: 'Couldn’t reach Spotify. Check the internet connection.',
    restricted: 'That Spotify device can’t be controlled from here. Pick another device.',
  };

  /** Map a failed response to an error code. */
  function classify(status, body, path) {
    var err = body && body.error;
    var msg = err && typeof err === 'object' ? String(err.message || '') : String(err || '');
    var reason = err && typeof err === 'object' ? String(err.reason || '') : '';
    var player = /^\/me\/player/.test(path || '');
    if (status === 401) return 'unauthorized';
    if (status === 429) return 'rate';
    if (status === 403) {
      if (reason === 'PREMIUM_REQUIRED' || /premium/i.test(msg)) return 'premium';
      if (player && /restrict/i.test(msg + reason)) return 'restricted';
      return 'forbidden';
    }
    if (status === 404) {
      if (player || reason === 'NO_ACTIVE_DEVICE' || /device/i.test(msg)) return 'no-device';
      return 'not-found';
    }
    if (status >= 500) return 'server';
    return 'http';
  }

  /** Pick a ~300px image from a Spotify images array. */
  function pickImage(images) {
    if (!Array.isArray(images)) return null;
    var imgs = images.filter(function (i) { return i && typeof i.url === 'string' && /^https:\/\//.test(i.url); })
      .map(function (i) { return { url: i.url, size: i.width || i.height || 0 }; });
    if (!imgs.length) return null;
    var big = imgs.filter(function (i) { return i.size >= 300; }).sort(function (a, b) { return a.size - b.size; });
    if (big.length) return big[0].url;
    return imgs.sort(function (a, b) { return b.size - a.size; })[0].url;
  }

  function clean(s) {
    return String(s == null ? '' : s).replace(/[  -​ ]/g, ' ').replace(/\s+/g, ' ').trim();
  }

  /**
   * A Web API track object as a game track, or null if it can't be played
   * (local files, podcasts, unavailable in the user's market, malformed).
   * { id, title, artist, image, uri, durationMs, previewUrl }
   */
  function normalizeTrack(t, fallbackImage) {
    if (!t || typeof t !== 'object') return null;
    if (t.type && t.type !== 'track') return null;
    if (t.is_local || t.is_playable === false) return null;
    var id = typeof t.id === 'string' && /^[A-Za-z0-9]{10,40}$/.test(t.id) ? t.id : null;
    var title = clean(t.name);
    if (!id || !title) return null;
    var artists = Array.isArray(t.artists) ? t.artists.map(function (a) { return a && a.name ? clean(a.name) : ''; }).filter(Boolean) : [];
    return {
      id: id,
      title: title,
      artist: artists.join(', '),
      image: pickImage(t.album && t.album.images) || fallbackImage || null,
      uri: typeof t.uri === 'string' && /^spotify:track:/.test(t.uri) ? t.uri : 'spotify:track:' + id,
      durationMs: Number(t.duration_ms) > 0 ? Math.round(Number(t.duration_ms)) : null,
      previewUrl: typeof t.preview_url === 'string' && /^https:\/\//.test(t.preview_url) ? t.preview_url : null,
    };
  }

  /** De-duplicate and normalise raw track objects: { tracks, skipped }. */
  function collectTracks(raw, fallbackImage) {
    var seen = {};
    var tracks = [];
    var skipped = 0;
    raw.forEach(function (t) {
      var n = normalizeTrack(t, fallbackImage);
      if (!n) { if (t) skipped++; return; }
      if (seen[n.id]) return;
      seen[n.id] = true;
      tracks.push(n);
    });
    return { tracks: tracks, skipped: skipped };
  }

  /**
   * @param {object} deps
   * @param {object} deps.auth      { getAccessToken({forceRefresh}) }
   * @param {Function} deps.fetch
   * @param {Function} [deps.sleep] ms => Promise (Retry-After waits)
   */
  function create(deps) {
    var auth = deps.auth;
    var fetchImpl = deps.fetch;
    var sleep = deps.sleep || function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

    function url(path, query) {
      // The token only ever goes to the Web API: an absolute URL (a paging
      // object's `next`) must be on api.spotify.com/v1 too.
      if (/^[a-z][a-z0-9+.-]*:/i.test(path) && path.indexOf(API_BASE + '/') !== 0) return null;
      var u = /^https:\/\//.test(path) ? path : API_BASE + path;
      if (query) {
        var parts = Object.keys(query).filter(function (k) { return query[k] != null && query[k] !== ''; })
          .map(function (k) { return k + '=' + encodeURIComponent(query[k]); });
        if (parts.length) u += (u.indexOf('?') === -1 ? '?' : '&') + parts.join('&');
      }
      return u;
    }

    /**
     * Call the Web API. Resolves to the parsed JSON body (or null for 202/204).
     * @param {string} method
     * @param {string} path    '/me/player/play' or an absolute `next` URL
     * @param {object} [o]     { query, body }
     */
    function request(method, path, o) {
      o = o || {};
      var target = url(path, o.query);
      if (!target) return Promise.reject(SpotifyApiError('http', 'Spotify sent a link outside its Web API.'));
      var apiPath = target.replace(API_BASE, '').replace(/\?.*$/, '');
      var rateRetries = 0;
      var authRetried = false;

      function attempt(forceRefresh) {
        return auth.getAccessToken({ forceRefresh: forceRefresh }).then(function (token) {
          var init = { method: method, headers: { Authorization: 'Bearer ' + token } };
          if (o.body !== undefined) {
            init.headers['Content-Type'] = 'application/json';
            init.body = JSON.stringify(o.body);
          }
          return Promise.resolve()
            .then(function () { return fetchImpl(target, init); })
            .catch(function () { throw SpotifyApiError('network', MESSAGES.network); });
        }, function (err) {
          // Couldn't refresh the token for now (offline, Spotify down): not a sign-out.
          if (err && err.code === 'network') throw SpotifyApiError('network', err.message || MESSAGES.network);
          throw SpotifyApiError('signed-out', (err && err.message) || MESSAGES['signed-out'], 401);
        }).then(function (res) {
          if (res.status === 204 || res.status === 202) return null;
          return res.text().then(function (text) {
            var body = null;
            if (text) { try { body = JSON.parse(text); } catch (e) { body = null; } }
            if (res.ok) return body;
            var code = classify(res.status, body, apiPath);
            if (code === 'unauthorized' && !authRetried) {
              authRetried = true;
              return attempt(true);
            }
            if (code === 'rate') {
              var raw = res.headers && res.headers.get ? res.headers.get('Retry-After') : null;
              var ra = raw == null || String(raw).trim() === '' ? NaN : Number(raw);
              var wait = isFinite(ra) && ra >= 0 ? ra : 1;
              if (rateRetries < 2 && wait <= MAX_RETRY_AFTER_S) {
                rateRetries++;
                return sleep(wait * 1000).then(function () { return attempt(false); });
              }
              throw SpotifyApiError('rate', MESSAGES.rate, 429, { retryAfter: wait });
            }
            if (code === 'unauthorized') throw SpotifyApiError('signed-out', MESSAGES['signed-out'], 401);
            var detail = body && body.error && body.error.message ? String(body.error.message) : '';
            throw SpotifyApiError(code, MESSAGES[code] || ('Spotify answered ' + res.status + (detail ? ': ' + detail : '') + '.'), res.status, { detail: detail });
          });
        });
      }
      return attempt(false);
    }

    /** Every page of a paging object: follows `next` until the end. */
    function allPages(first, pick) {
      var out = [];
      var pages = 0;
      function take(page) {
        if (!page || !Array.isArray(page.items)) return out;
        page.items.forEach(function (it) { out.push(pick ? pick(it) : it); });
        pages++;
        if (page.next && pages < MAX_PAGES) return request('GET', page.next).then(take);
        return out;
      }
      return Promise.resolve(first).then(take);
    }

    function playlistItem(it) {
      if (!it || it.is_local) return it && it.is_local ? { is_local: true } : null;
      return it.item || it.track || null; // `track` is the pre-2026 name
    }

    /**
     * Songs for a parsed link { type, id }: { source, tracks, skipped, via: 'spotify' }.
     * Playlists aren't capped at 100 songs here (pages of 50 are followed).
     */
    function loadTracks(ref) {
      if (ref.type === 'track') {
        return request('GET', '/tracks/' + encodeURIComponent(ref.id), { query: { market: 'from_token' } }).then(function (t) {
          var c = collectTracks([t], null);
          var img = c.tracks[0] ? c.tracks[0].image : null;
          return { source: { type: 'track', name: c.tracks[0] ? c.tracks[0].title : 'Spotify track', image: img }, tracks: c.tracks, skipped: c.skipped, via: 'spotify' };
        });
      }
      if (ref.type === 'album') {
        return request('GET', '/albums/' + encodeURIComponent(ref.id), { query: { market: 'from_token' } }).then(function (album) {
          var image = pickImage(album && album.images);
          return allPages(album && album.tracks).then(function (raw) {
            var c = collectTracks(raw, image);
            return { source: { type: 'album', name: clean(album.name) || 'Spotify album', image: image }, tracks: c.tracks, skipped: c.skipped, via: 'spotify' };
          });
        });
      }
      var meta;
      return request('GET', '/playlists/' + encodeURIComponent(ref.id), { query: { fields: 'name,images' } })
        .then(function (m) {
          meta = m || {};
          return request('GET', '/playlists/' + encodeURIComponent(ref.id) + '/items', {
            query: { limit: PAGE_LIMIT, offset: 0, market: 'from_token', additional_types: 'track' },
          });
        })
        .then(function (first) { return allPages(first, playlistItem); })
        .then(function (raw) {
          var c = collectTracks(raw, null);
          return { source: { type: 'playlist', name: clean(meta.name) || 'Spotify playlist', image: pickImage(meta.images) }, tracks: c.tracks, skipped: c.skipped, via: 'spotify' };
        }, function (err) {
          // Development Mode apps may only read playlists the user owns or collaborates on.
          if (err && (err.code === 'forbidden' || err.code === 'not-found')) {
            throw SpotifyApiError('playlist-not-owned',
              'Spotify only lets this app read the full song list of playlists you own or collaborate on.', err.status);
          }
          throw err;
        });
    }

    return {
      request: request,
      loadTracks: loadTracks,
      me: function () { return request('GET', '/me'); },
      getTrack: function (id) {
        return request('GET', '/tracks/' + encodeURIComponent(id), { query: { market: 'from_token' } }).then(function (t) { return normalizeTrack(t, null); });
      },
      devices: function () {
        return request('GET', '/me/player/devices').then(function (b) { return (b && Array.isArray(b.devices)) ? b.devices : []; });
      },
      /** GET /me/player: null when nothing is playing anywhere. */
      playerState: function () { return request('GET', '/me/player'); },
      play: function (deviceId, uri, positionMs) {
        return request('PUT', '/me/player/play', {
          query: { device_id: deviceId || '' },
          body: { uris: [uri], position_ms: Math.max(0, Math.round(positionMs || 0)) },
        });
      },
      pause: function (deviceId) {
        return request('PUT', '/me/player/pause', { query: { device_id: deviceId || '' } });
      },
    };
  }

  return {
    API_BASE: API_BASE,
    MESSAGES: MESSAGES,
    SpotifyApiError: SpotifyApiError,
    classify: classify,
    pickImage: pickImage,
    normalizeTrack: normalizeTrack,
    collectTracks: collectTracks,
    create: create,
  };
});
