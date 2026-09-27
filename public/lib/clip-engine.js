/**
 * Clip engines: one interface for playing a [start, end) segment of a song,
 * so the game drives the 30-second preview player and Spotify full-song
 * playback the same way.
 *
 *   engine.load(track)                      prepare a song ({ previewUrl } or { uri, durationMs })
 *   engine.playSegment(startMs, endMs, offsetFn)
 *                                           play [start, end); with offsetFn(durationMs) -> ms the
 *                                           segment is shifted by the song's clip start, placed once
 *                                           the duration is known
 *   engine.stop() / unload() / prime()      prime(): call inside a tap so later playback is allowed
 *   engine.playing, segStartMs, segEndMs    (segment in ms of the song, offset included)
 *   engine.positionMs(), durationMs()       (NaN when unknown)
 *   engine.onProgress(fn(ms)), onState(fn('loading'|'playing'|'stopped')),
 *   engine.onEnded(fn(info)), onError(fn(message, err))
 *
 * createPreviewEngine: an <audio> element playing a preview MP3; it stops at
 *   exactly `end` (requestAnimationFrame poll, `timeupdate`, setTimeout net).
 * createSpotifyEngine: Spotify Connect through lib/spotify-player.js. The
 *   pause is scheduled from the moment the play request resolves; with a
 *   remote device (REST, 200-600 ms per request) half the play request's
 *   round trip is taken off as the pause's own latency, and the position is
 *   re-read once (GET /me/player) after ~1.2 s to correct for the device's
 *   start-up delay. With this browser as the device, the SDK's local state is
 *   polled every 100 ms and the local pause takes ~50 ms. After pausing, the
 *   real position is read back and reported (onProgress, onEnded info).
 *
 * Shared by the browser (window.ClipEngine) and the Node tests.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ClipEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // A random start leaves the whole clip (first part + extension) plus this much song after it.
  var RANDOM_START_MARGIN_MS = 5000;
  var DEFAULT_CLIP_TOTAL_MS = 15000;

  /**
   * "Random spot" for a full song: a whole second in
   * [0, duration - (clipTotalMs + 5 s)], so the whole clip (first part plus
   * the extension, e.g. 5 s + 10 s) always fits before the end. 0 for short
   * or unknown songs.
   * @param {number} durationMs
   * @param {number} [clipTotalMs]  first clip + extension (default 15000)
   * @param {Function} [rng]
   */
  function randomFullStartMs(durationMs, clipTotalMs, rng) {
    if (typeof clipTotalMs === 'function') { rng = clipTotalMs; clipTotalMs = null; }
    rng = rng || Math.random;
    var total = Number(clipTotalMs) > 0 ? Number(clipTotalMs) : DEFAULT_CLIP_TOTAL_MS;
    var d = Number(durationMs);
    if (!isFinite(d) || d <= 0) return 0;
    var maxS = Math.floor((d - total - RANDOM_START_MARGIN_MS) / 1000);
    if (maxS <= 0) return 0;
    return Math.min(maxS, Math.floor(rng() * (maxS + 1))) * 1000;
  }

  function noop() {}

  function emitter() {
    var ls = { progress: [], state: [], ended: [], error: [] };
    return {
      fire: function (name) {
        var args = Array.prototype.slice.call(arguments, 1);
        ls[name].slice().forEach(function (fn) { fn.apply(null, args); });
      },
      bind: function (target) {
        target.onProgress = function (fn) { ls.progress.push(fn); return target; };
        target.onState = function (fn) { ls.state.push(fn); return target; };
        target.onEnded = function (fn) { ls.ended.push(fn); return target; };
        target.onError = function (fn) { ls.error.push(fn); return target; };
      },
    };
  }

  // ---------- Preview engine (<audio>) ----------

  /**
   * @param {object} deps
   * @param {Function} deps.createAudio   () => HTMLAudioElement
   * @param {Function} [deps.raf] / [deps.caf]  requestAnimationFrame / cancelAnimationFrame
   */
  function createPreviewEngine(deps) {
    var raf = deps.raf || function (f) { return setTimeout(f, 16); };
    var caf = deps.caf || function (id) { clearTimeout(id); };
    var ev = emitter();
    var e = { kind: 'preview', playing: false, segStartMs: 0, segEndMs: 0, primed: false, priming: false };
    ev.bind(e);
    var a = deps.createAudio();
    a.preload = 'auto';
    e.audio = a;
    var segStart = 0; // seconds
    var segEnd = 0;
    var rafId = 0;
    var safety = 0;
    var token = 0;

    function setSeg(s, en) { segStart = s; segEnd = en; e.segStartMs = s * 1000; e.segEndMs = en * 1000; }

    a.addEventListener('timeupdate', function () { check(); });
    a.addEventListener('playing', function () {
      if (e.priming) return;
      ev.fire('state', 'playing');
      armSafety();
    });
    a.addEventListener('waiting', function () { if (e.playing) ev.fire('state', 'loading'); });
    a.addEventListener('ended', function () { if (e.playing) { e.stop(); ev.fire('ended', { actualMs: (a.currentTime || 0) * 1000, requestedMs: e.segEndMs }); } });
    a.addEventListener('error', function () {
      if (!a.getAttribute('src')) return;
      e.stop();
      ev.fire('error', 'This song’s preview could not be loaded.', { code: 'preview' });
    });

    e.load = function (track) {
      e.stop();
      var url = track && typeof track === 'object' ? track.previewUrl : track;
      if (!url) {
        a.removeAttribute('src');
        a.load();
        return;
      }
      a.src = url;
      a.load();
    };
    e.unload = function () {
      e.stop();
      a.removeAttribute('src');
      a.load();
    };
    e.durationMs = function () { var d = a.duration; return isFinite(d) && d > 0 ? d * 1000 : NaN; };
    e.positionMs = function () { return (a.currentTime || 0) * 1000; };

    /**
     * Room host: audio is started by messages from phones, outside any tap on
     * this device. Play the element once, muted, inside a real tap (e.g.
     * "Start game") so browsers that need a gesture per element (iOS) allow it.
     */
    e.prime = function () {
      if (e.primed || e.playing || !a.getAttribute('src')) return;
      e.primed = true;
      e.priming = true;
      a.muted = true;
      var done = function () {
        if (!e.priming) return;
        e.priming = false;
        if (!e.playing && !a.paused) a.pause();
        try { if (!e.playing && a.readyState >= 1) a.currentTime = 0; } catch (x) { /* ignore */ }
        a.muted = false;
      };
      var p;
      try { p = a.play(); } catch (x) { p = null; }
      if (p && p.then) p.then(done, done); else done();
    };

    /**
     * Play [startMs, endMs). With `offsetFn`, the segment is shifted by the
     * clip's start offset, which is only final once the preview's duration is
     * known; if the metadata hasn't loaded yet, the segment is placed when it
     * arrives, so every play of a song uses the same offset.
     */
    e.playSegment = function (startMs, endMs, offsetFn) {
      if (e.priming) { e.priming = false; a.muted = false; }
      e.stop();
      var my = ++token;
      var place = function () {
        var off = offsetFn ? (offsetFn(e.durationMs()) || 0) / 1000 : 0;
        setSeg(startMs / 1000 + off, endMs / 1000 + off);
      };
      place();
      e.playing = true;
      ev.fire('state', 'loading');
      if (a.readyState >= 1) {
        try { a.currentTime = segStart; } catch (x) { /* ignore */ }
      } else if (segStart > 0 || offsetFn) {
        a.addEventListener('loadedmetadata', function onMeta() {
          a.removeEventListener('loadedmetadata', onMeta);
          if (my !== token || !e.playing) return;
          place();
          try { a.currentTime = segStart; } catch (x) { /* ignore */ }
          armSafety();
        });
      }
      // play() is called synchronously inside the click handler (required on iOS).
      var p = a.play();
      if (p && p.catch) {
        p.catch(function (err) {
          if (my !== token) return;
          e.stop();
          if (err && err.name === 'AbortError') return;
          var blocked = err && err.name === 'NotAllowedError';
          ev.fire('error', blocked ? 'Your browser blocked audio playback. Tap play again.' : 'This song’s preview could not be played.', { code: blocked ? 'blocked' : 'preview' });
        });
      }
      var loop = function () {
        if (my !== token || !e.playing) return;
        check();
        rafId = raf(loop);
      };
      rafId = raf(loop);
    };

    function armSafety() {
      clearTimeout(safety);
      if (!e.playing) return;
      var remaining = Math.max(0, segEnd - a.currentTime);
      var my = token;
      // The media clock can lag wall time slightly, so when the timer fires we
      // re-check the position and re-arm instead of cutting the clip short.
      safety = setTimeout(function () {
        if (my !== token || !e.playing) return;
        if (a.currentTime >= segEnd - 0.005 || a.ended) end();
        else armSafety();
      }, Math.max(20, remaining * 1000 + 20));
    }

    function end() {
      var t = a.currentTime || 0;
      e.stop();
      ev.fire('ended', { actualMs: t * 1000, requestedMs: segEnd * 1000 });
    }

    function check() {
      if (!e.playing) return;
      var t = a.currentTime;
      if (t >= segEnd) { end(); return; }
      ev.fire('progress', t * 1000);
    }

    e.stop = function () {
      var wasPlaying = e.playing;
      e.playing = false;
      token++;
      caf(rafId);
      clearTimeout(safety);
      if (!a.paused) a.pause();
      if (wasPlaying) {
        ev.fire('progress', Math.min(segEnd, a.currentTime || 0) * 1000);
        try { if (a.readyState >= 1) a.currentTime = 0; } catch (x) { /* ignore */ }
        ev.fire('state', 'stopped');
      }
    };

    return e;
  }

  // ---------- Spotify engine (Connect / Web Playback SDK) ----------

  /**
   * @param {object} deps
   * @param {object} deps.controller   SpotifyPlayer.create(...): play(uri, ms), pause(), position(), activate()
   * @param {Function} [deps.resolveTrack]  track => Promise<track with uri and durationMs>
   * @param {Function} [deps.now]           ms clock
   * @param {object} [deps.timers]          { setTimeout, clearTimeout }
   * @param {number} [deps.tickMs]          progress / local poll interval (100)
   * @param {number} [deps.resyncAfterMs]   REST: re-read the position this long after starting (1200)
   * @param {number} [deps.maxLeadMs]       REST: at most this much is taken off for the pause's latency (250)
   * @param {number} [deps.driftMs]         REST: re-plan the pause when the device is off by more (80)
   */
  function createSpotifyEngine(deps) {
    var ctl = deps.controller;
    var now = deps.now || function () { return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now(); };
    var timers = deps.timers || { setTimeout: function (f, ms) { return setTimeout(f, ms); }, clearTimeout: function (id) { clearTimeout(id); } };
    var tickMs = deps.tickMs || 100;
    var resyncAfterMs = deps.resyncAfterMs == null ? 1200 : deps.resyncAfterMs;
    var maxLeadMs = deps.maxLeadMs == null ? 250 : deps.maxLeadMs;
    var driftMs = deps.driftMs == null ? 80 : deps.driftMs;
    var LOCAL_EPS_MS = 30;

    var ev = emitter();
    var e = { kind: 'spotify', playing: false, segStartMs: 0, segEndMs: 0, track: null, lastEnd: null, lastStart: null };
    ev.bind(e);
    var token = 0;
    var running = false; // the song is audibly playing (the play request resolved)
    var local = false;
    var base = { pos: 0, at: 0 };
    var lead = 0;
    var lastPos = 0;
    var endTimer = null;
    var tickTimer = null;
    var resyncTimer = null;
    // The last pause command. A play waits for it, so the two can't reach the
    // device in the wrong order (and leave the new clip paused).
    var pausing = Promise.resolve();

    function pauseDevice() {
      // Called synchronously: the pause goes to the device that is playing now,
      // even if another device is picked right after stop().
      var p;
      try { p = ctl.pause(); } catch (x) { p = null; }
      pausing = Promise.resolve(p).catch(noop);
      return pausing;
    }

    /** The last pause, but no longer than ~1.5 s (a stuck request mustn't block playing). */
    function waitForPause() {
      return new Promise(function (resolve) {
        var t = timers.setTimeout(resolve, 1500);
        pausing.then(function () { timers.clearTimeout(t); resolve(); });
      });
    }

    function clearTimers() {
      [endTimer, tickTimer, resyncTimer].forEach(function (t) { if (t != null) timers.clearTimeout(t); });
      endTimer = tickTimer = resyncTimer = null;
    }

    function estimate() { return running ? base.pos + (now() - base.at) : lastPos; }

    e.positionMs = function () { return estimate(); };
    e.durationMs = function () { return e.track && e.track.durationMs > 0 ? e.track.durationMs : NaN; };
    e.load = function (track) { e.stop(); e.track = track || null; lastPos = 0; };
    e.unload = function () { e.stop(); e.track = null; };
    e.prime = function () { if (ctl.activate) ctl.activate(); };

    function armEnd(my) {
      if (endTimer != null) timers.clearTimeout(endTimer);
      var remaining = e.segEndMs - estimate() - lead;
      endTimer = timers.setTimeout(function () { endTimer = null; finish(my); }, Math.max(0, remaining));
    }

    function tick(my) {
      tickTimer = timers.setTimeout(function () {
        tickTimer = null;
        if (my !== token || !running) return;
        ev.fire('progress', Math.min(estimate(), e.segEndMs));
        if (local) {
          Promise.resolve(ctl.position()).then(function (st) {
            if (my !== token || !running || !st || st.paused) return;
            base = { pos: st.positionMs, at: st.at };
            if (st.positionMs >= e.segEndMs - LOCAL_EPS_MS) finish(my);
            else armEnd(my);
          }, noop);
        }
        tick(my);
      }, tickMs);
    }

    function resync(my) {
      resyncTimer = timers.setTimeout(function () {
        resyncTimer = null;
        if (my !== token || !running) return;
        Promise.resolve(ctl.position()).then(function (st) {
          if (my !== token || !running || !st || st.paused) return;
          if (st.uri && e.track && e.track.uri && st.uri !== e.track.uri) return;
          var theirs = st.positionMs + (now() - st.at);
          if (Math.abs(theirs - estimate()) > driftMs) {
            base = { pos: st.positionMs, at: st.at };
            armEnd(my);
          }
        }, noop);
      }, resyncAfterMs);
    }

    /** The segment's end: pause, read the real position back, report it. */
    function finish(my) {
      if (my !== token || !running) return;
      var est = estimate();
      running = false;
      clearTimers();
      var pausedAt = now();
      pauseDevice()
        .then(function () { return ctl.position(); })
        .catch(function () { return null; })
        .then(function (st) {
          if (my !== token) return;
          var actual = st && isFinite(st.positionMs) ? st.positionMs : Math.min(est, e.segEndMs);
          lastPos = actual;
          e.lastEnd = { requestedMs: e.segEndMs, estimateMs: est, actualMs: actual, pauseCalledAt: pausedAt, measured: !!st };
          ev.fire('progress', actual);
          e.playing = false;
          token++;
          ev.fire('state', 'stopped');
          ev.fire('ended', e.lastEnd);
        });
    }

    e.playSegment = function (startMs, endMs, offsetFn) {
      e.stop();
      var my = ++token;
      var track = e.track;
      e.playing = true;
      running = false;
      ev.fire('state', 'loading');
      var needs = track && (!track.uri || (offsetFn && !(track.durationMs > 0)) || (endMs > 60000 && !(track.durationMs > 0)));
      Promise.resolve()
        .then(function () {
          if (!track) throw Object.assign(new Error('No song is loaded.'), { code: 'no-track' });
          return needs && deps.resolveTrack ? deps.resolveTrack(track) : track;
        })
        .then(function (t) {
          if (my !== token) return null;
          if (t && t !== track) {
            if (!track.uri && t.uri) track.uri = t.uri;
            if (!(track.durationMs > 0) && t.durationMs > 0) track.durationMs = t.durationMs;
          }
          if (!track.uri) track.uri = 'spotify:track:' + track.id;
          var dur = e.durationMs();
          var off = offsetFn ? (offsetFn(dur) || 0) : 0;
          var s = Math.max(0, startMs + off);
          var en = endMs + off;
          if (dur > 0) { en = Math.min(en, dur); s = Math.min(s, Math.max(0, dur - 1000)); }
          e.segStartMs = s;
          e.segEndMs = en;
          return waitForPause().then(function () {
            if (my !== token) return null;
            return Promise.resolve(ctl.play(track.uri, s)).then(function (info) {
              if (my !== token) {
                // Stopped while the play request was on its way: silence it again,
                // unless a newer clip is already starting (its play replaces this one).
                if (!e.playing) pauseDevice();
                return;
              }
              info = info || {};
              local = !!info.local;
              running = true;
              base = { pos: info.positionMs != null ? info.positionMs : s, at: info.at != null ? info.at : now() };
              lead = local ? 0 : Math.max(0, Math.min(maxLeadMs, (info.requestMs || 0) / 2));
              e.lastStart = { requestedMs: s, at: base.at, requestMs: info.requestMs || 0, local: local };
              ev.fire('state', 'playing');
              ev.fire('progress', estimate());
              armEnd(my);
              tick(my);
              if (!local && resyncAfterMs > 0 && e.segEndMs - s > resyncAfterMs + 1000) resync(my);
            });
          });
        })
        .catch(function (err) {
          if (my !== token) return;
          running = false;
          e.playing = false;
          token++;
          clearTimers();
          ev.fire('state', 'stopped');
          ev.fire('error', (err && err.message) || 'Spotify couldn’t play this song.', err || {});
        });
    };

    e.stop = function () {
      var was = e.playing;
      var wasRunning = running;
      var pos = estimate();
      token++;
      clearTimers();
      running = false;
      if (!was) return;
      e.playing = false;
      if (wasRunning) {
        lastPos = pos;
        pauseDevice();
        ev.fire('progress', Math.min(pos, e.segEndMs));
      }
      ev.fire('state', 'stopped');
    };

    return e;
  }

  // ---------- One player, two engines ----------

  /**
   * A player object for the app that forwards to the active engine and only
   * passes on the active engine's events. use(engine) switches (stopping the old one).
   */
  function createSwitch(initial) {
    var ev = emitter();
    var active = initial;
    var wired = [];
    var sw = {};
    ev.bind(sw);

    function wire(engine) {
      if (wired.indexOf(engine) !== -1) return;
      wired.push(engine);
      engine.onProgress(function (ms) { if (engine === active) ev.fire('progress', ms); });
      engine.onState(function (s) { if (engine === active) ev.fire('state', s); });
      engine.onEnded(function (info) { if (engine === active) ev.fire('ended', info); });
      engine.onError(function (msg, err) { if (engine === active) ev.fire('error', msg, err); });
    }
    wire(initial);

    sw.use = function (engine) {
      if (!engine || engine === active) return;
      active.stop();
      active = engine;
      wire(engine);
    };
    sw.engine = function () { return active; };
    ['load', 'unload', 'prime', 'playSegment', 'stop', 'positionMs', 'durationMs'].forEach(function (m) {
      sw[m] = function () { return active[m].apply(active, arguments); };
    });
    ['playing', 'segStartMs', 'segEndMs', 'kind'].forEach(function (p) {
      Object.defineProperty(sw, p, { get: function () { return active[p]; }, enumerable: true });
    });
    return sw;
  }

  return {
    RANDOM_START_MARGIN_MS: RANDOM_START_MARGIN_MS,
    DEFAULT_CLIP_TOTAL_MS: DEFAULT_CLIP_TOTAL_MS,
    randomFullStartMs: randomFullStartMs,
    createPreviewEngine: createPreviewEngine,
    createSpotifyEngine: createSpotifyEngine,
    createSwitch: createSwitch,
  };
});
