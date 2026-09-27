/**
 * Full-song playback through Spotify Connect.
 *
 * The host picks an output device from GET /me/player/devices: the Spotify
 * app on a phone or computer, a speaker, or this browser itself. The browser
 * becomes a device through Spotify's Web Playback SDK
 * (https://sdk.scdn.co/spotify-player.js), which is only loaded once someone
 * has signed in. The SDK needs Premium and a browser with Widevine DRM; iOS
 * Safari isn't supported, and there the phone's Spotify app is the device to
 * pick instead. SDK failures are reported, never thrown.
 *
 * Playing: PUT /me/player/play?device_id=... { uris: [uri], position_ms }.
 * Pausing: the SDK's player.pause() when this browser is the device (~50 ms),
 * otherwise PUT /me/player/pause. Positions: the SDK's getCurrentState()
 * locally, otherwise GET /me/player (progress_ms).
 *
 * Shared by the browser (window.SpotifyPlayer) and the Node tests.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SpotifyPlayer = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var SDK_URL = 'https://sdk.scdn.co/spotify-player.js';
  var PLAYER_NAME = 'Guess the Song';
  var KEY_DEVICE = 'gts:sp:device';
  var SDK_TIMEOUT_MS = 15000;
  var LOCAL_START_TIMEOUT_MS = 4000;

  /**
   * Load the Web Playback SDK script once. Resolves to window.Spotify, or
   * rejects (blocked, offline, timed out).
   */
  function loadSdk(win, doc, timeoutMs) {
    if (win.Spotify && win.Spotify.Player) return Promise.resolve(win.Spotify);
    if (win.__gtsSdkPromise) return win.__gtsSdkPromise;
    win.__gtsSdkPromise = new Promise(function (resolve, reject) {
      var timer = setTimeout(function () { reject(new Error('The Spotify player script took too long to load.')); }, timeoutMs || SDK_TIMEOUT_MS);
      var prev = win.onSpotifyWebPlaybackSDKReady;
      win.onSpotifyWebPlaybackSDKReady = function () {
        clearTimeout(timer);
        if (typeof prev === 'function') { try { prev(); } catch (e) { /* ignore */ } }
        if (win.Spotify && win.Spotify.Player) resolve(win.Spotify);
        else reject(new Error('The Spotify player script didn’t start.'));
      };
      var s = doc.createElement('script');
      s.src = SDK_URL;
      s.async = true;
      s.onerror = function () { clearTimeout(timer); reject(new Error('Couldn’t load the Spotify player script.')); };
      doc.head.appendChild(s);
    });
    win.__gtsSdkPromise.catch(function () { win.__gtsSdkPromise = null; });
    return win.__gtsSdkPromise;
  }

  /** A friendly device label. */
  function deviceLabel(d) {
    if (d.local) return PLAYER_NAME + ' (this browser)';
    var type = d.type ? String(d.type).toLowerCase() : '';
    return d.name + (type && type !== 'unknown' ? ' · ' + type : '') + (d.isActive ? ' (active)' : '');
  }

  /**
   * @param {object} deps
   * @param {object} deps.api        SpotifyApi.create(...)
   * @param {object} deps.auth       SpotifyAuth.create(...)
   * @param {object} [deps.storage]  localStorage-like, for the chosen device
   * @param {Function} [deps.loadSdk] () => Promise<Spotify namespace>
   * @param {Function} [deps.now]
   * @param {object} [deps.timers]   { setTimeout, clearTimeout }
   */
  function create(deps) {
    var api = deps.api;
    var auth = deps.auth;
    var storage = deps.storage || null;
    var now = deps.now || function () { return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now(); };
    var timers = deps.timers || { setTimeout: function (f, ms) { return setTimeout(f, ms); }, clearTimeout: function (id) { clearTimeout(id); } };
    var sdk = { status: 'idle', player: null, deviceId: null, error: '' }; // idle|loading|ready|failed
    var sdkPromise = null;
    var stateListeners = [];
    var statusListeners = [];

    function sget() { try { var v = storage && storage.getItem(KEY_DEVICE); return v ? JSON.parse(v) : null; } catch (e) { return null; } }
    function sset(v) { try { if (storage) { if (v) storage.setItem(KEY_DEVICE, JSON.stringify(v)); else storage.removeItem(KEY_DEVICE); } } catch (e) { /* ignore */ } }

    var selected = sget(); // { id, name, local }

    function setSdk(status, error) {
      sdk.status = status;
      sdk.error = error || '';
      statusListeners.slice().forEach(function (fn) { try { fn(sdk.status, sdk.error); } catch (e) { /* ignore */ } });
    }

    /**
     * Register this browser as a Connect device. Resolves to its device id, or
     * null when the SDK can't run here (the reason is in sdkInfo().error).
     */
    function connectSdk() {
      if (sdkPromise) return sdkPromise;
      if (!deps.loadSdk) { setSdk('failed', 'This browser can’t play Spotify itself.'); return Promise.resolve(null); }
      setSdk('loading');
      sdkPromise = Promise.resolve()
        .then(function () { return deps.loadSdk(); })
        .then(function (Spotify) {
          return new Promise(function (resolve) {
            var settled = false;
            var done = function (id, err) {
              if (settled) return;
              settled = true;
              if (id) { sdk.deviceId = id; setSdk('ready'); } else setSdk('failed', err || 'The Spotify player couldn’t start in this browser.');
              resolve(id || null);
            };
            var player = new Spotify.Player({
              name: PLAYER_NAME,
              volume: 0.9,
              getOAuthToken: function (cb) {
                auth.getAccessToken().then(cb, function () { cb(''); });
              },
            });
            sdk.player = player;
            player.addListener('ready', function (e) { sdk.deviceId = e.device_id; if (!settled) done(e.device_id); else setSdk('ready'); });
            player.addListener('not_ready', function () { setSdk('failed', 'This browser’s Spotify player went offline.'); });
            player.addListener('initialization_error', function (e) {
              done(null, 'This browser can’t play Spotify itself' + (e && e.message ? ' (' + e.message + ')' : '') + '. Pick your phone’s Spotify app instead.');
            });
            player.addListener('authentication_error', function () { done(null, 'Spotify didn’t accept the sign-in for in-browser playback.'); });
            player.addListener('account_error', function () { done(null, 'In-browser playback needs Spotify Premium.'); });
            player.addListener('playback_error', function () { /* reported through play() */ });
            player.addListener('player_state_changed', function (st) {
              stateListeners.slice().forEach(function (fn) { try { fn(st); } catch (e) { /* ignore */ } });
            });
            var t = timers.setTimeout(function () { done(null, 'The Spotify player didn’t become ready in this browser.'); }, SDK_TIMEOUT_MS);
            Promise.resolve(player.connect()).then(function (ok) {
              if (!ok) { timers.clearTimeout(t); done(null, 'The Spotify player couldn’t connect in this browser.'); }
            }, function () { timers.clearTimeout(t); done(null, 'The Spotify player couldn’t connect in this browser.'); });
          });
        }, function (err) {
          setSdk('failed', (err && err.message) || 'Couldn’t load the Spotify player.');
          return null;
        });
      return sdkPromise;
    }

    /** Devices from Spotify, with this browser (when its SDK player is ready) first. */
    function listDevices() {
      return api.devices().then(function (raw) {
        var list = raw.filter(function (d) { return d && d.id; }).map(function (d) {
          return { id: d.id, name: String(d.name || 'Device'), type: d.type || '', isActive: !!d.is_active, restricted: !!d.is_restricted, local: !!(sdk.deviceId && d.id === sdk.deviceId) };
        });
        if (sdk.deviceId && !list.some(function (d) { return d.local; })) {
          list.unshift({ id: sdk.deviceId, name: PLAYER_NAME, type: 'Computer', isActive: false, restricted: false, local: true });
        }
        list.sort(function (a, b) { return (b.local ? 1 : 0) - (a.local ? 1 : 0); });
        list.forEach(function (d) { d.label = deviceLabel(d); });
        // This browser's device id changes every visit: keep "this browser" selected.
        if (selected && selected.local && sdk.deviceId && selected.id !== sdk.deviceId) selectDevice({ id: sdk.deviceId, name: PLAYER_NAME, local: true });
        return list;
      });
    }

    function selectDevice(d) {
      selected = d && d.id ? { id: d.id, name: d.name || '', local: !!d.local } : null;
      sset(selected);
      return selected;
    }

    function deviceId() {
      if (!selected) return null;
      if (selected.local) return sdk.deviceId || null;
      return selected.id;
    }

    function isLocal() {
      return !!(selected && selected.local && sdk.player && sdk.deviceId);
    }

    /** Local SDK state as { positionMs, paused, at, uri }, or null. */
    function localState() {
      return Promise.resolve(sdk.player.getCurrentState()).then(function (st) {
        if (!st) return null;
        var cur = st.track_window && st.track_window.current_track;
        return { positionMs: Number(st.position) || 0, paused: !!st.paused, at: now(), uri: cur ? cur.uri : '' };
      });
    }

    /**
     * Wait until the in-browser player really plays `uri` (the REST call only
     * says the command was accepted). Resolves to its state, or null on timeout.
     */
    function waitLocalStart(uri) {
      return new Promise(function (resolve) {
        var done = false;
        var finish = function (st) {
          if (done) return;
          done = true;
          timers.clearTimeout(timeout);
          var i = stateListeners.indexOf(onState);
          if (i !== -1) stateListeners.splice(i, 1);
          resolve(st);
        };
        var onState = function (st) {
          var cur = st && st.track_window && st.track_window.current_track;
          if (st && !st.paused && (!uri || !cur || cur.uri === uri || (cur.linked_from && cur.linked_from.uri === uri))) {
            finish({ positionMs: Number(st.position) || 0, paused: false, at: now(), uri: cur ? cur.uri : '' });
          }
        };
        var timeout = timers.setTimeout(function () { finish(null); }, LOCAL_START_TIMEOUT_MS);
        stateListeners.push(onState);
      });
    }

    /**
     * Start `uri` at `positionMs` on the selected device. Resolves once the
     * play command was accepted (REST) or the in-browser player is playing,
     * to { at, positionMs?, requestMs }.
     */
    function play(uri, positionMs) {
      var id = deviceId();
      if (!id) {
        var e = new Error(selected && selected.local ? 'This browser’s Spotify player isn’t ready yet. Wait a moment, or pick another device under “Plays on”.' : 'Pick a Spotify device under “Plays on” first.');
        e.code = 'no-device';
        return Promise.reject(e);
      }
      var local = isLocal();
      var started = local ? waitLocalStart(uri) : null;
      var t0 = now();
      return api.play(id, uri, positionMs).then(function () {
        var t1 = now();
        var info = { at: t1, requestMs: t1 - t0, local: local };
        if (!started) return info;
        return started.then(function (st) {
          if (st) { info.at = st.at; info.positionMs = st.positionMs; }
          return info;
        });
      });
    }

    function pause() {
      if (isLocal()) {
        return Promise.resolve(sdk.player.pause()).catch(function () { return api.pause(deviceId()); });
      }
      return api.pause(deviceId());
    }

    /** { positionMs, paused, at } of the selected device, or null if unknown. */
    function position() {
      if (isLocal()) return localState().catch(function () { return null; });
      var t0 = now();
      return api.playerState().then(function (st) {
        if (!st || st.progress_ms == null) return null;
        // The position was taken about half-way through the request.
        return { positionMs: Number(st.progress_ms) || 0, paused: !st.is_playing, at: (t0 + now()) / 2, uri: st.item ? st.item.uri : '' };
      }, function () { return null; });
    }

    /** Inside a tap: lets the in-browser player make sound later (mobile autoplay rules). */
    function activate() {
      if (sdk.player && sdk.player.activateElement) { try { sdk.player.activateElement(); } catch (e) { /* ignore */ } }
    }

    function disconnect() {
      if (sdk.player) { try { sdk.player.disconnect(); } catch (e) { /* ignore */ } }
      sdk.player = null;
      sdk.deviceId = null;
      sdkPromise = null;
      setSdk('idle');
    }

    return {
      connectSdk: connectSdk,
      sdkInfo: function () { return { status: sdk.status, deviceId: sdk.deviceId, error: sdk.error }; },
      onSdkStatus: function (fn) { statusListeners.push(fn); },
      listDevices: listDevices,
      selectDevice: selectDevice,
      selectedDevice: function () { return selected; },
      deviceId: deviceId,
      isLocal: isLocal,
      play: play,
      pause: pause,
      position: position,
      activate: activate,
      disconnect: disconnect,
    };
  }

  return { SDK_URL: SDK_URL, PLAYER_NAME: PLAYER_NAME, KEY_DEVICE: KEY_DEVICE, loadSdk: loadSdk, deviceLabel: deviceLabel, create: create };
});
