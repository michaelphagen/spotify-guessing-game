/*
 * Guess the Song: browser controller (screens, audio, persistence).
 * Three ways to use a device: pass-the-phone (one device, the original game),
 * room host (this device is the "TV": it plays the audio and runs the game;
 * see lib/room.js) and room player (a phone that answers; no audio).
 */
(function () {
  'use strict';

  var G = window.GameLogic;
  // Coming back from Spotify's sign-in page (?code=&state=): take those out of
  // the address bar and put back the room parameters carried in `state`,
  // before anything below reads location.search.
  var spRedirect = null;
  try { spRedirect = window.SpotifyAuth.consumeRedirect(window); } catch (e) { spRedirect = null; }
  var sessionStore = null;
  try { sessionStore = window.sessionStorage; } catch (e) { /* storage blocked */ }
  // Loads song lists from the Node backend, or (on static hosts such as GitHub
  // Pages) from Spotify's embed page through public CORS proxies. See config.js.
  var tracksSource = window.TrackSource.create({
    config: window.GTS_CONFIG || {},
    fetch: window.fetch.bind(window),
    SpotifyUrl: window.SpotifyUrl,
    EmbedParser: window.EmbedParser,
    search: window.location.search,
    storage: sessionStore,
  });
  // The example playlist's songs are bundled with the game (data/example-playlist.json).
  var EXAMPLE_URL = tracksSource.exampleUrl();
  var STORE_GAME = 'gts:game';
  var STORE_SETUP = 'gts:setup';
  var STORE_USED = 'gts:used';
  var STORE_ROOM = 'gts:room'; // the hosted room (sessionStorage), incl. its game
  var STORE_JOIN = 'gts:join'; // { code, name } of the room this tab plays in (sessionStorage)
  var LOCAL_NAME = 'gts:name'; // last name used to join (localStorage)
  var LOCAL_TOKEN = 'gts:token:'; // + CODE + ':' + name -> player token (localStorage)
  // Resumable rooms (localStorage, 12 hours): survive closing the tab, or the
  // browser evicting it. Cleared when the room is closed on purpose.
  var LOCAL_ROOM = 'gts:saved-room:'; // + CODE -> Room.savedRoomEntry (the hosted room, tracks included)
  var LOCAL_JOIN = 'gts:saved-join'; // Room.savedJoinEntry: the room this device plays in
  // Tells this tab's saved room apart from another tab's (see the 'storage' listener).
  var TAB_ID = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  var MAX_PLAYERS = 12;
  var Room = window.Room;
  var Transport = window.Transport;
  // ?transport=local: rooms between tabs of this browser (BroadcastChannel) instead of PeerJS.
  var TRANSPORT_KIND = Transport.kindFromSearch(window.location.search);
  // ?debug=1..3: PeerJS log level (and the "Connection details" panel starts open).
  var DEBUG_LEVEL = (function () {
    var m = /[?&]debug(?:=(\d))?(?:&|#|$)/.exec(window.location.search);
    return m ? Math.max(1, Math.min(3, parseInt(m[1] || '1', 10) || 1)) : 0;
  })();
  // ?ice=relay: connect through TURN relays only (testing a relay, or a network that needs one).
  var ICE_RELAY = /[?&]ice=relay(?:&|#|$)/i.test(window.location.search);
  var LOCAL_SOUND_ON = 'gts:sound-on'; // "Sound plays on": 'all' | 'host'

  /**
   * One clock for room sync on every device: milliseconds since the epoch, but
   * monotonic (performance.now()), so it doesn't jump when the system clock is
   * adjusted. Phones measure their offset to the host's with ping/pong.
   */
  var perfBase = window.performance && performance.now && performance.timeOrigin ? performance.timeOrigin : null;
  function clockNow() { return perfBase != null ? perfBase + performance.now() : Date.now(); }

  // Clip lengths: the first clip, and the extension unlocked by "play next ...
  // seconds" (0: none). They are chosen on the setup screen and stored in the
  // game (game.clip, fitted to 30-second previews when those play), which is
  // the single source of truth: everything in this file reads them through
  // clip() (in seconds via clipFirst() / clipExtend() / clipTotal()). A phone
  // in a room reads them from the host's snapshot (view.clip).
  function clip() {
    if (joined) return G.normalizeClip(joined.view && joined.view.clip);
    if (game) return G.clipOf(game);
    if (hosting) return Room.roomClip(hosting.room);
    return G.normalizeClip(null);
  }
  function clipFirst() { return clip().firstMs / 1000; }
  function clipExtend() { return clip().extendMs / 1000; }
  function clipTotal() { var c = clip(); return (c.firstMs + c.extendMs) / 1000; }
  function secs(n) { return String(Math.round(n * 10) / 10); }
  function secondsText(n) { return secs(n) + ' second' + (Number(secs(n)) === 1 ? '' : 's'); }

  /**
   * Put clip lengths into the text under `root`: elements marked
   * data-clip="first" | "extend" | "total" get the number of seconds,
   * "first-s" | "extend-s" | "total-s" the same with "second(s)", and
   * data-clip-extend-only elements are hidden when there is no extra time.
   */
  function fillClipText(root, c) {
    if (!root) return;
    var v = { first: c.firstMs / 1000, extend: c.extendMs / 1000, total: (c.firstMs + c.extendMs) / 1000 };
    root.querySelectorAll('[data-clip]').forEach(function (node) {
      var k = node.getAttribute('data-clip');
      var unit = /-s$/.test(k);
      var n = v[k.replace(/-s$/, '')];
      if (n == null) return;
      node.textContent = unit ? secondsText(n) : secs(n);
    });
    root.querySelectorAll('[data-clip-extend-only]').forEach(function (node) { node.hidden = !c.extendMs; });
  }

  /** The progress bar's two parts in proportion to the clip lengths; no second part without extra time. */
  function renderClipSplit(prefix, c) {
    var short = $(prefix + 'seg-short');
    var long = $(prefix + 'seg-long');
    if (short) short.style.flexGrow = String(c.firstMs);
    if (long) {
      long.style.flexGrow = String(c.extendMs || 0);
      long.hidden = !c.extendMs;
    }
  }

  /** "5 s clip + 10 s extra" (lobby, setup). */
  function clipSummary(c) {
    return secs(c.firstMs / 1000) + ' s clip' + (c.extendMs ? ' + ' + secs(c.extendMs / 1000) + ' s extra' : ', no extra time');
  }

  // ---------- Spotify sign-in and full-song playback (host only) ----------

  var localStore = null;
  try { localStore = window.localStorage; } catch (e) { /* storage blocked */ }
  var nullStore = { getItem: function () { return null; }, setItem: function () {}, removeItem: function () {} };
  var LOCAL_SOUND = 'gts:sound'; // 'preview' | 'spotify'
  var spAuth = window.SpotifyAuth.create({
    fetch: window.fetch.bind(window),
    storage: localStore || nullStore,
    crypto: window.crypto,
    location: window.location,
    configClientId: (window.GTS_CONFIG || {}).SPOTIFY_CLIENT_ID || '',
  });
  var spApi = window.SpotifyApi.create({ auth: spAuth, fetch: window.fetch.bind(window) });
  var spCtl = window.SpotifyPlayer.create({
    api: spApi,
    auth: spAuth,
    storage: localStore,
    loadSdk: function () { return window.SpotifyPlayer.loadSdk(window, document); },
  });

  // ---------- Small helpers ----------

  function $(id) { return document.getElementById(id); }

  /** Create an element; children may be strings (as text nodes, never HTML). */
  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === 'class') node.className = attrs[k];
        else if (k === 'text') node.textContent = attrs[k];
        else if (k.indexOf('on') === 0) node.addEventListener(k.slice(2), attrs[k]);
        else node.setAttribute(k, attrs[k]);
      });
    }
    (children || []).forEach(function (c) {
      if (c == null) return;
      node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return node;
  }

  var store = {
    get: function (key) {
      try { var v = window.sessionStorage.getItem(key); return v ? JSON.parse(v) : null; } catch (e) { return null; }
    },
    set: function (key, value) {
      try { window.sessionStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* storage unavailable */ }
    },
    remove: function (key) {
      try { window.sessionStorage.removeItem(key); } catch (e) { /* ignore */ }
    },
  };

  // localStorage survives closing the tab: used for the player's name and room tokens.
  var local = {
    get: function (key) { try { return window.localStorage.getItem(key); } catch (e) { return null; } },
    set: function (key, value) { try { window.localStorage.setItem(key, value); } catch (e) { /* ignore */ } },
    remove: function (key) { try { window.localStorage.removeItem(key); } catch (e) { /* ignore */ } },
    getJSON: function (key) { try { var v = window.localStorage.getItem(key); return v ? JSON.parse(v) : null; } catch (e) { return null; } },
    setJSON: function (key, value) {
      try { window.localStorage.setItem(key, JSON.stringify(value)); return true; } catch (e) { return false; }
    },
    keys: function (prefix) {
      var out = [];
      try {
        for (var i = 0; i < window.localStorage.length; i++) {
          var k = window.localStorage.key(i);
          if (k && k.indexOf(prefix) === 0) out.push(k);
        }
      } catch (e) { /* ignore */ }
      return out;
    },
  };

  var toastTimer = null;
  function toast(msg, ms) {
    var t = $('toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, ms || 3500);
  }

  var currentScreen = null;
  function showScreen(name) {
    document.querySelectorAll('.screen').forEach(function (s) {
      s.hidden = s.getAttribute('data-screen') !== name;
    });
    var inGame = name === 'round' || name === 'result';
    var playerInGame = !!joined && !!joined.view && joined.status !== 'failed' && name !== 'join';
    $('scoreboard').hidden = !(inGame || name === 'over' || playerInGame);
    $('end-game-btn').hidden = !inGame || !!joined;
    $('leave-room-btn').hidden = !joined || name === 'join';
    if (name !== currentScreen) window.scrollTo(0, 0);
    currentScreen = name;
    renderRoomChip();
    renderNetStatus();
    // Rooms: "Connection details" on the join, lobby, host and player screens.
    $('diag').hidden = !(hosting || joined || name === 'join');
    if (!$('diag').hidden && $('diag').open) refreshDiag();
  }

  // ---------- Connection details (diagnostics panel) ----------

  function fmtTime(t) { return t ? new Date(t).toISOString().slice(11, 23) + ' UTC' : '–'; }
  function fmtErr(e) { return e && e.code ? e.code + (e.message ? ' — ' + e.message : '') + (e.at ? ' (' + fmtTime(e.at) + ')' : '') : 'none'; }
  function fmtPair(p) {
    if (TRANSPORT_KIND === 'local') return 'n/a (same browser)';
    if (!p) return 'not selected yet';
    return p.local + ' ↔ ' + p.remote + (p.protocol ? ' over ' + p.protocol : '') + (p.relayProtocol ? ' (relay via ' + p.relayProtocol + ')' : '') +
      (p.rttMs != null ? ', ' + p.rttMs + ' ms round trip' : '');
  }

  /** The panel's text: transport, signaling, ids, last error, data channel, ICE, candidate pair, TURN, retries, times. */
  function diagText() {
    var lines = [];
    var add = function (k, v) { lines.push(k + ': ' + (v == null || v === '' ? '–' : v)); };
    var cfg = transportOptions();
    var h = hosting;
    var j = joined;
    var t = h ? h.transport : j ? j.ctl.transport() : null;
    var info = j ? j.ctl.info() : null;
    var d = null;
    try { d = h ? (t && t.diag ? t.diag() : null) : info ? info.transport : null; } catch (e) { d = null; }
    add('Time', new Date().toISOString());
    add('Transport', TRANSPORT_KIND === 'local' ? 'local (BroadcastChannel, tabs of this browser)' : 'peer (PeerJS / WebRTC)');
    add('Role', h ? 'host of room ' + h.room.code : j ? 'player "' + j.name + '" in room ' + j.code : 'not in a room');
    if (h) add('Room status', h.status + ' · signaling ' + (h.net || '–') + ' · pill ' + (hostNetState() || '–'));
    if (j) add('Player status', j.status + (j.detail && j.detail.code ? ' (' + j.detail.code + ')' : ''));
    add('Signaling', d ? d.signaling + (d.server ? ' (' + d.server + ')' : '') : TRANSPORT_KIND === 'local' ? 'BroadcastChannel' : 'not started');
    add('Own peer id', d && d.peerId);
    add('Host peer id', d && d.hostPeerId ? d.hostPeerId : j ? Room.peerIdFor(j.code) : h ? Room.peerIdFor(h.room.code) : null);
    add('Last error', fmtErr(h ? h.lastError || (h.netError ? { code: h.netError.code, message: h.netError.message } : null) || (d && d.lastError) : info ? info.lastError || (d && d.lastError) : null));
    var ice = cfg.iceServers || [];
    add('TURN configured', TRANSPORT_KIND === 'local' ? 'n/a' : (Transport.hasTurn(ice) ? 'yes' : 'no') + ' (' + ice.length + ' ICE server entries; policy ' +
      (d && d.policy ? d.policy : cfg.iceTransportPolicy) + ')');
    if (h) {
      add('Retries', 'room open attempts ' + (h.attempts || 0) + ', ICE failures of joining phones ' + (d && d.iceFailures || 0));
      add('Times', 'opened ' + fmtTime(h.openedAt) + (h.connectingSince ? ', connecting since ' + fmtTime(h.connectingSince) : ''));
      var byPeer = {};
      h.room.players.forEach(function (p) { if (p.peerId) byPeer[p.peerId] = p; });
      add('Sound', (Room.soundEverywhere(h.room) ? 'every device' : 'host only') + ' · ' + h.room.settings.engine);
      var conns = d && d.conns ? d.conns : [];
      if (!conns.length) add('Phones', 'none connected');
      conns.forEach(function (c) {
        var p = byPeer[c.peer];
        add('Phone ' + (p ? p.name : c.peer) + (c.pending ? ' (joining)' : ''),
          'data channel ' + c.dataChannel + ', ICE ' + c.ice + ', path ' + fmtPair(diagPairs[c.peer]) +
          (p ? ', clock offset ' + (p.clockOffset != null ? p.clockOffset + ' ms' : '?') + ', rtt ' + (p.rtt != null ? p.rtt + ' ms' : '?') + (p.spotifyReady ? ', Spotify ready' : '') : ''));
      });
    } else if (j) {
      var c0 = d && d.conns && d.conns[0];
      add('Data channel', c0 ? c0.dataChannel : '–');
      add('ICE connection', c0 ? c0.ice + (c0.pc ? ' (peer connection ' + c0.pc + ')' : '') : '–');
      add('Candidate pair', fmtPair(diagPairs.host));
      add('Retries', 'attempts ' + info.attempts + ', ICE failures ' + info.iceFailures + (info.relay ? ', next/current attempt relay-only' : ''));
      add('Times', 'join started ' + fmtTime(info.joinStartedAt) + ', last attempt ' + fmtTime(info.lastAttemptAt) + ', connected ' + fmtTime(info.connectedAt));
      add('Clock', info.clock ? 'offset to host ' + info.clock.offset + ' ms, round trip ' + info.clock.rtt + ' ms' : 'not measured yet');
      add('Sound', phoneSoundMode() + (previewEngine.unlocked ? ', unlocked' : ', not unlocked yet') + (j.soundBlocked ? ', BLOCKED' : '') +
        (phoneSoundMode() === 'spotify' ? ', Spotify ' + (phoneSpotifyReady() ? 'ready' : 'not ready') : ''));
    }
    add('Browser', navigator.userAgent);
    return lines.join('\n');
  }

  var diagPairs = {};
  var diagTimer = null;
  var diagBusy = false;
  /** Refresh the panel (and the selected candidate pairs, from getStats) while it's open. */
  function refreshDiag() {
    clearTimeout(diagTimer);
    diagTimer = null;
    var box = $('diag');
    if (box.hidden || !box.open) return;
    try { $('diag-text').textContent = diagText(); } catch (e) { $('diag-text').textContent = 'Couldn’t read the connection details: ' + e.message; }
    var t = hosting ? hosting.transport : joined ? joined.ctl.transport() : null;
    if (t && t.candidates && !diagBusy) {
      diagBusy = true;
      t.candidates().then(function (pairs) { diagPairs = pairs || {}; }, function () { /* keep the last */ })
        .then(function () { diagBusy = false; });
    }
    diagTimer = setTimeout(refreshDiag, 1000);
  }

  function onDiagCopy() {
    var text = diagText();
    var done = function () { toast('Connection details copied.'); };
    var fallback = function () {
      var r = document.createRange();
      r.selectNodeContents($('diag-text'));
      var s = window.getSelection();
      s.removeAllRanges();
      s.addRange(r);
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      if (ok) done(); else toast('Couldn’t copy. Select the text and copy it by hand.');
    };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, fallback);
    else fallback();
  }

  /** "Room ABCD" in the header while hosting a started game or playing in a room. */
  function renderRoomChip() {
    var code = hosting && hosting.room.game && currentScreen !== 'lobby' ? hosting.room.code
      : joined && currentScreen !== 'join' ? joined.code : '';
    $('room-chip').hidden = !code;
    $('room-chip-code').textContent = code;
  }

  function banner(msg, bad) {
    var b = $('conn-banner');
    b.textContent = msg || '';
    b.hidden = !msg;
    b.classList.toggle('bad', !!bad);
  }

  // ---------- Used-song tracking across games in this browser session ----------

  function sourceKey(source) {
    return source ? source.type + ':' + (source.id || source.name) : '';
  }
  function getUsed(key) {
    var all = store.get(STORE_USED) || {};
    return Array.isArray(all[key]) ? all[key] : [];
  }
  function setUsed(key, ids) {
    var all = store.get(STORE_USED) || {};
    all[key] = ids;
    store.set(STORE_USED, all);
  }

  // ---------- Clip player ----------

  // Two engines behind one interface (lib/clip-engine.js): 30-second previews
  // in an <audio> element, or full songs through Spotify Connect. `player`
  // forwards to whichever the current game uses (host only; phones never play).
  var previewEngine = window.ClipEngine.createPreviewEngine({
    createAudio: function () { return new Audio(); },
    raf: function (f) { return requestAnimationFrame(f); },
    caf: function (id) { cancelAnimationFrame(id); },
  });
  var spotifyEngine = window.ClipEngine.createSpotifyEngine({
    controller: spCtl,
    resolveTrack: function (t) { return spApi.getTrack(t.id).then(function (n) { return n || t; }); },
  });
  var player = window.ClipEngine.createSwitch(previewEngine);

  // ---------- App state ----------

  var game = null;
  var turnUi = { heard: 0, playedOnce: false, audioError: false };

  /**
   * Where the current song's clip starts, in ms into the audio, given the
   * audio's duration (NaN while unknown).
   * Previews: the stored offset (0 to 30 s minus the whole clip), fitted to the preview's real length
   * (GameLogic.clampClipStart). Full songs: "from the beginning" is 0 ms of the
   * song; "random spot" is picked once per turn from the whole song
   * (ClipEngine.randomFullStartMs) as soon as its duration is known, and kept
   * in game.current.fullStart (seconds) so every play of the song uses it.
   */
  function clipOffsetMs(durationMs) {
    if (!game || !game.current) return 0;
    var cur = game.current;
    if (player.kind === 'spotify') {
      if (game.clipStartMode !== 'random') return 0;
      if (cur.fullStart == null && durationMs > 0) {
        cur.fullStart = window.ClipEngine.randomFullStartMs(durationMs, clipTotal() * 1000) / 1000;
        saveGame();
      }
      return (cur.fullStart || 0) * 1000;
    }
    var d = durationMs / 1000;
    var total = clipTotal();
    var off = G.clampClipStart(cur.clipStart, d, total);
    // A full-song start (from an earlier Spotify turn) doesn't fit a preview.
    if (!(isFinite(d) && d > 0)) off = Math.min(off, G.maxClipStart(total));
    return off * 1000;
  }
  /** The current clip's offset in seconds (for clip-relative progress). */
  function clipOffset() {
    // A clip played on every device: the offset it was sent with.
    if (turnUi.syncOffMs != null) return turnUi.syncOffMs / 1000;
    return clipOffsetMs(player.durationMs()) / 1000;
  }

  // `player` events drive the host / pass-the-phone screens. A phone in a room
  // plays through the engines directly (see "Sound on this phone" below).
  player.onProgress(function (ms) {
    // Result-screen playback: a phone's Next can stop it after the next turn began.
    if (joined || !game || game.phase !== 'round' || resultMode === 'listen') return;
    renderProgress(ms / 1000 - clipOffset());
    if (player.playing) reportPlayback('playing');
  });
  player.onState(function (s) {
    if (joined) return;
    var listening = resultMode === 'listen'; // onPlayerState clears it on 'stopped'
    onPlayerState(s);
    if (!listening) reportPlayback(s);
  });
  player.onError(function (msg, err) {
    if (joined) return;
    var code = err && err.code;
    if (code === 'premium') { fallbackToPreviews(msg); return; }
    if (code === 'blocked' && hosting && lastSync && soundEverywhere() && game && game.phase === 'round') {
      // The phones play the clip anyway; this screen keeps the clip's time (and
      // unlocks "play next") without sound until someone taps it.
      startGhost(lastSync);
      showNotice('This screen’s browser blocked the sound; the phones still play it. Tap play here to hear it on this device too.');
      return;
    }
    if (code === 'signed-out') {
      // The banner (with "Sign in again") says it; the phones hear why nothing plays.
      showAuthBanner();
      reportPlayback('error', 'The host’s Spotify sign-in has expired. Ask the host to sign in again.');
      return;
    }
    if (!game || game.phase !== 'round') { toast(msg, 6000); return; }
    turnUi.audioError = true;
    var blocked = code === 'blocked';
    showNotice(blocked && hosting ? 'This browser blocked the sound. Tap play on this screen once to allow it.'
      : code === 'no-device' || code === 'rate' ? msg
      : msg + ' You can skip it (no points) or reveal the answer.');
    $('skip-btn').hidden = false;
    reportPlayback(blocked ? 'blocked' : 'error', blocked ? 'The host’s browser blocked the sound. Ask the host to tap play on their screen.' : msg);
  });
  var resultMode = null; // 'listen' when the result-screen preview is playing

  function saveGame() {
    if (hosting) { store.set(STORE_ROOM, hosting.room); persistHostRoom(); return; }
    if (game) store.set(STORE_GAME, game);
    else store.remove(STORE_GAME);
  }

  // ---------- Sound: previews or full songs via Spotify ----------

  var LOCAL_SP_NAME = 'gts:sp:name';
  var spDevices = [];
  var spDevicesLoading = false;

  function soundPref() { return local.get(LOCAL_SOUND) === 'spotify' ? 'spotify' : 'preview'; }
  function setSoundPref(v) { local.set(LOCAL_SOUND, v === 'spotify' ? 'spotify' : 'preview'); }

  /** The engine of the game on this device: the hosted room's, or the pass-the-phone game's. */
  function currentEngineName() {
    if (hosting) return hosting.room.settings.engine === 'spotify' ? 'spotify' : 'preview';
    return game && game.engine === 'spotify' ? 'spotify' : 'preview';
  }

  /** Point `player` at the current game's engine; start Spotify's side when needed. */
  function syncEngine() {
    var name = currentEngineName();
    player.use(name === 'spotify' ? spotifyEngine : previewEngine);
    $('round-device').hidden = name !== 'spotify' || !!joined;
    if (name === 'spotify') ensureSpotifyReady();
  }

  function listenLabel() { return player.kind === 'spotify' ? 'Play the song' : 'Listen to the preview'; }

  var spReadyStarted = false;
  /** Signed in: register this browser as a device (Web Playback SDK) and list devices. */
  function ensureSpotifyReady() {
    if (!spAuth.isSignedIn()) {
      if (currentEngineName() === 'spotify' && game) showAuthBanner();
      return;
    }
    if (spReadyStarted) return;
    spReadyStarted = true;
    if (!local.get(LOCAL_SP_NAME)) {
      spApi.me().then(function (me) {
        if (me && (me.display_name || me.id)) { local.set(LOCAL_SP_NAME, me.display_name || me.id); renderSound(); }
      }, function () { /* the name is cosmetic */ });
    }
    spCtl.connectSdk().then(function () { refreshDevices(); });
    refreshDevices();
  }

  function soundStatus(msg, kind) {
    var p = $('sp-status');
    p.textContent = msg || '';
    p.hidden = !msg;
    p.className = 'hint sp-status' + (kind ? ' ' + kind : '');
  }

  function renderSound() {
    var pref = soundPref();
    var r = document.querySelector('input[name="engine"][value="' + pref + '"]');
    if (r) r.checked = true;
    $('sp-panel').hidden = pref !== 'spotify';
    var signed = spAuth.isSignedIn();
    $('sp-signed-out').hidden = signed;
    $('sp-signed-in').hidden = !signed;
    // With a default app in config.js the Client ID field is tucked away behind
    // "Use a different Spotify app"; a pasted Client ID overrides the default.
    var hasDefault = spAuth.hasConfigClientId();
    var override = spAuth.hasClientIdOverride();
    var showField = !hasDefault || override || clientFieldOpen;
    $('sp-client-wrap').hidden = !showField;
    $('sp-client-toggle').hidden = showField;
    $('sp-client-default').hidden = !(hasDefault && override);
    if (document.activeElement !== $('sp-client-id')) $('sp-client-id').value = override ? spAuth.clientId() : '';
    $('sp-redirect').textContent = spAuth.redirectUri();
    $('sp-name').textContent = local.get(LOCAL_SP_NAME) || 'your Spotify account';
    renderDevices();
  }

  function refreshDevices() {
    if (!spAuth.isSignedIn()) return Promise.resolve([]);
    spDevicesLoading = true;
    renderDevices();
    return spCtl.listDevices().then(function (list) {
      spDevicesLoading = false;
      spDevices = list;
      var sel = spCtl.selectedDevice();
      if (!sel && list.length) {
        // Nothing chosen yet: this browser, else the device already playing, else the first.
        var pick = list.filter(function (d) { return d.local; })[0] || list.filter(function (d) { return d.isActive; })[0] || list[0];
        spCtl.selectDevice(pick);
        rememberRoomDevice();
      }
      renderDevices();
      return list;
    }, function (err) {
      spDevicesLoading = false;
      renderDevices();
      if (err && err.code === 'signed-out') { renderSound(); if (game && currentEngineName() === 'spotify') showAuthBanner(); }
      soundStatus(err && err.message ? err.message : 'Couldn’t list your Spotify devices.', 'bad');
      return [];
    });
  }

  function renderDevices() {
    var selId = spCtl.deviceId();
    var sel = spCtl.selectedDevice();
    ['sp-device', 'round-device-select', 'p-sp-device'].forEach(function (id) {
      var box = $(id);
      box.textContent = '';
      var list = spDevices.slice();
      if (sel && selId && !list.some(function (d) { return d.id === selId; })) {
        list.push({ id: selId, label: (sel.local ? window.SpotifyPlayer.PLAYER_NAME + ' (this browser)' : sel.name) + ' (not available right now)' });
      }
      if (!list.length) box.appendChild(el('option', { value: '', text: spDevicesLoading ? 'Looking for devices…' : 'No devices found' }));
      list.forEach(function (d) { box.appendChild(el('option', { value: d.id, text: d.label })); });
      if (!selId && list.length) box.insertBefore(el('option', { value: '', text: 'Pick a device…' }), box.firstChild);
      box.value = selId && list.some(function (d) { return d.id === selId; }) ? selId : '';
    });
    var info = spCtl.sdkInfo();
    var hint = info.status === 'loading' ? 'Starting the player in this browser…'
      : info.status === 'failed' ? info.error + ' Open Spotify on your phone or computer, then Refresh and pick it.'
      : !spDevices.length && !spDevicesLoading ? 'Open Spotify on your phone, computer or speaker, then tap Refresh.'
      : 'The songs play on this device. Players can also sign in on their phones to hear full songs there.';
    $('sp-device-hint').textContent = hint;
    // A phone in a room: tell the host whether it can play full songs now.
    if (joined) reportSpotifyReady();
  }

  function onDevicePicked(e) {
    var id = e.target.value;
    var d = spDevices.filter(function (x) { return x.id === id; })[0];
    if (!d) return;
    if (player.playing && player.kind === 'spotify') player.stop();
    spCtl.selectDevice(d);
    rememberRoomDevice();
    renderDevices();
    soundStatus('');
  }

  /** The hosted room keeps its device choice, so a resumed room plays on the same device. */
  function rememberRoomDevice() {
    if (!hosting) return;
    hosting.room.settings.device = spCtl.selectedDevice();
    saveGame();
  }

  var clientFieldOpen = false;
  function onClientIdSave() {
    var v = $('sp-client-id').value.trim();
    if (!spAuth.setClientId(v)) { soundStatus('That doesn’t look like a Client ID (32 letters and digits from your Spotify app’s settings).', 'bad'); return false; }
    soundStatus(v ? 'Client ID saved in this browser.' : '', v ? 'ok' : '');
    return true;
  }

  /** Send the browser to Spotify's sign-in page; it comes back to this page (and game). */
  function signIn() {
    if (window.location.hostname === 'localhost') {
      var alt = window.location.href.replace('//localhost', '//127.0.0.1');
      soundStatus('Spotify doesn’t accept “localhost” addresses. Open ' + alt + ' instead (and register http://127.0.0.1:<port>/ as a Redirect URI).', 'bad');
      toast('Open the game at 127.0.0.1 instead of localhost to sign in.', 6000);
      return;
    }
    var typed = $('sp-client-id').value.trim();
    if (!$('sp-client-wrap').hidden && typed && typed !== spAuth.clientId() && !onClientIdSave()) return;
    spAuth.beginSignIn(window.location.search).then(function (url) {
      window.location.assign(url);
    }, function (err) {
      soundStatus(err && err.message ? err.message : 'Couldn’t start signing in.', 'bad');
      toast(err && err.message ? err.message : 'Couldn’t start signing in.', 6000);
    });
  }

  function signOut() {
    if (player.playing && player.kind === 'spotify') player.stop();
    spCtl.disconnect();
    spAuth.signOut();
    local.remove(LOCAL_SP_NAME);
    spDevices = [];
    spReadyStarted = false;
    if (joined) reportSpotifyReady(); // the host stops sending this phone the song's URI
    soundStatus('Signed out of Spotify.');
    renderSound();
  }

  /** Spotify redirected back here with ?code=: finish signing in. */
  function finishSignIn(r) {
    spAuth.completeSignIn(r).then(function () {
      if (!joined) setSoundPref('spotify'); // a phone signed in to hear full songs; its own setup keeps its choice
      hideAuthBanner();
      toast('Signed in to Spotify.');
      if (currentScreen === 'setup') renderSound();
      ensureSpotifyReady();
    }, function (err) {
      toast(err && err.message ? err.message : 'Spotify sign-in failed.', 6000);
      if (currentScreen === 'setup') { renderSound(); soundStatus(err && err.message ? err.message : 'Spotify sign-in failed.', 'bad'); }
    });
  }

  function showAuthBanner(msg) {
    $('auth-banner-text').textContent = msg || 'Your Spotify sign-in has expired, so full songs can’t play. The game is saved.';
    $('auth-banner').hidden = false;
  }
  function hideAuthBanner() { $('auth-banner').hidden = true; }

  var testEngine = null;
  /** "Test sound": a second and a half of music on the chosen device. */
  function onTestSound() {
    spCtl.activate(); // inside the tap: lets this browser's player make sound
    if (!spCtl.deviceId()) { soundStatus('Pick a device first. If yours isn’t listed, open Spotify on it and tap Refresh.', 'bad'); return; }
    if (!testEngine) {
      testEngine = window.ClipEngine.createSpotifyEngine({ controller: spCtl });
      testEngine.onEnded(function () {
        $('sp-test').disabled = false;
        var d = spCtl.selectedDevice();
        soundStatus('Sound works on ' + (d && d.local ? 'this browser' : d ? d.name : 'that device') + '.', 'ok');
      });
      testEngine.onError(function (msg, err) {
        $('sp-test').disabled = false;
        if (err && err.code === 'premium') {
          soundStatus('Full-song playback needs Spotify Premium. Use Previews instead.', 'bad');
          return;
        }
        soundStatus(msg, 'bad');
      });
    }
    $('sp-test').disabled = true;
    soundStatus('Playing a moment of music…');
    tracksSource.loadExampleSnapshot().then(function (data) {
      var t = data && data.tracks && data.tracks[0];
      var id = t ? t.id : '4uLU6hMCjMI75M1A2tKUQC';
      testEngine.load({ id: id, uri: 'spotify:track:' + id });
      testEngine.playSegment(30000, 31500);
    });
  }

  /**
   * Spotify said Premium is required (or the host chose to): continue this
   * game with 30-second previews. Songs loaded from the Web API have no
   * preview URL, so the previews are looked up from the public embed page
   * and songs without one are taken out of the queue.
   */
  var fallingBack = false;
  function fallbackToPreviews(msg) {
    setSoundPref('preview');
    if (hosting) hosting.room.settings.engine = 'preview';
    else if (game) game.engine = 'preview';
    player.use(previewEngine);
    $('round-device').hidden = true;
    // A 30-second preview may be too short for the chosen clip: shorten the extra time.
    var fit = game ? G.fitClipToPreview(game.clip) : null;
    if (fit && fit.clamped) {
      game.clip = { firstMs: fit.firstMs, extendMs: fit.extendMs };
      game.clipClamped = true;
      msg += ' ' + Room.previewFitNote(game.clip);
      if (currentScreen === 'round' && game.current) { renderClipLabels(); renderExtendState(); renderProgress(turnUi.heard); }
      if (hosting && hosting.ctl) hosting.ctl.broadcast();
    }
    saveGame();
    if (!game || fallingBack) { toast(msg, 8000); return; }
    var g = game;
    var inRound = function () { return game === g && g.phase === 'round' && g.current && !g.current.answered && currentScreen === 'round'; };
    if (inRound()) showNotice(msg + ' Loading the previews…');
    else toast(msg, 8000);
    var missing = g.tracks.some(function (t) { return !t.previewUrl; });
    fallingBack = true;
    var lookup = missing && g.sourceUrl ? tracksSource.loadTracks(g.sourceUrl) : Promise.resolve(null);
    lookup.catch(function () { return null; }).then(function (data) {
      fallingBack = false;
      if (game !== g) return;
      var byId = {};
      if (data && data.tracks) data.tracks.forEach(function (t) { if (t.previewUrl) byId[t.id] = t.previewUrl; });
      var lists = [g.tracks].concat(hosting && hosting.room.tracks !== g.tracks ? [hosting.room.tracks] : []);
      lists.forEach(function (list) { list.forEach(function (t) { if (!t.previewUrl && byId[t.id]) t.previewUrl = byId[t.id]; }); });
      var playable = {};
      g.tracks.forEach(function (t) { if (t.previewUrl) playable[t.id] = true; });
      var before = g.queue.length;
      g.queue = g.queue.filter(function (id) { return playable[id]; });
      saveGame();
      if (hosting) { hosting.ctl.broadcast(); hosting.ctl.preload(); }
      var dropped = before - g.queue.length;
      var extra = dropped ? ' ' + dropped + ' song' + (dropped === 1 ? '' : 's') + ' without a preview were taken out.' : '';
      if (inRound()) {
        var tr = currentTrack();
        player.load(tr);
        turnUi.audioError = false;
        if (!tr.previewUrl) {
          showNotice(msg + extra + ' This song has no preview: skip it (no points) or reveal the answer.');
          $('skip-btn').hidden = false;
        } else showNotice(msg + extra);
      } else if (currentScreen === 'result') {
        player.load(currentTrack());
        $('listen-btn').textContent = listenLabel();
        $('listen-btn').hidden = !currentTrack().previewUrl;
      }
    });
  }

  // ---------- Setup screen ----------

  function renderPlayerInputs(names) {
    var list = $('player-list');
    list.textContent = '';
    names.forEach(function (name, i) { list.appendChild(playerRow(name, i)); });
    updatePlayerRows();
  }

  function playerRow(name, i) {
    var input = el('input', {
      type: 'text', maxlength: '24', 'aria-label': 'Player ' + (i + 1) + ' name',
      placeholder: 'Player ' + (i + 1), autocomplete: 'off', autocapitalize: 'words',
    });
    input.value = name || '';
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); addPlayer(); }
    });
    var remove = el('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Remove player', text: '×' });
    remove.addEventListener('click', function () {
      var li = remove.closest('li');
      li.parentNode.removeChild(li);
      updatePlayerRows();
    });
    return el('li', null, [el('span', { class: 'num', text: String(i + 1) }), input, remove]);
  }

  function updatePlayerRows() {
    var rows = $('player-list').querySelectorAll('li');
    rows.forEach(function (li, i) {
      li.querySelector('.num').textContent = String(i + 1);
      var input = li.querySelector('input');
      input.placeholder = 'Player ' + (i + 1);
      input.setAttribute('aria-label', 'Player ' + (i + 1) + ' name');
      li.querySelector('.icon-btn').disabled = rows.length <= 1;
    });
    $('add-player-btn').disabled = rows.length >= MAX_PLAYERS;
  }

  function addPlayer() {
    var list = $('player-list');
    if (list.children.length >= MAX_PLAYERS) return;
    var row = playerRow('', list.children.length);
    list.appendChild(row);
    updatePlayerRows();
    row.querySelector('input').focus();
  }

  function readPlayers() {
    var names = [];
    $('player-list').querySelectorAll('input').forEach(function (input, i) {
      var n = input.value.replace(/\s+/g, ' ').trim();
      names.push(n || 'Player ' + (i + 1));
    });
    // Make duplicate names distinguishable.
    var counts = {};
    return names.map(function (n) {
      counts[n] = (counts[n] || 0) + 1;
      return counts[n] > 1 ? n + ' (' + counts[n] + ')' : n;
    });
  }

  function readSetup() {
    var modeInput = document.querySelector('input[name="mode"]:checked');
    var clipStartInput = document.querySelector('input[name="clip-start"]:checked');
    return {
      url: $('url-input').value.trim(),
      players: readPlayers(),
      rawPlayers: Array.prototype.map.call($('player-list').querySelectorAll('input'), function (i) { return i.value; }),
      mode: modeInput ? modeInput.value : 'choice',
      rounds: parseInt($('rounds-select').value, 10) || 0,
      clipStart: clipStartInput ? clipStartInput.value : 'beginning',
      clip: readClipSetting(),
      engine: soundPref(),
      soundOn: soundOnPref(),
    };
  }

  /** "Sound plays on" (rooms): 'all' (every player's device, the default) or 'host'. */
  function soundOnPref() {
    var r = document.querySelector('input[name="sound-on"]:checked');
    if (r) return r.value === 'host' ? 'host' : 'all';
    return local.get(LOCAL_SOUND_ON) === 'host' ? 'host' : 'all';
  }

  /** The clip lengths chosen on the setup screen ({ firstMs, extendMs }). */
  function readClipSetting() {
    var first = parseFloat($('clip-first').value);
    var extra = parseFloat($('clip-extra').value);
    return G.normalizeClip({ firstMs: first * 1000, extendMs: extra * 1000 });
  }

  /**
   * Setup screen texts that depend on the clip lengths (heading, hints, rules),
   * and a note when a 30-second preview can't hold the whole clip.
   */
  function renderClipSetting() {
    var c = readClipSetting();
    var preview = soundPref() !== 'spotify';
    var fit = G.fitClipToPreview(c);
    fillClipText($('screen-setup'), preview ? fit : c);
    var note = $('clip-fit-note');
    note.textContent = preview && fit.clamped
      ? 'Previews are only ' + G.PREVIEW_SECONDS + ' seconds long, so the extra time will be ' +
        (fit.extendMs ? secondsText(fit.extendMs / 1000) : 'off') + ' (full songs keep ' + secondsText(c.extendMs / 1000) + ').'
      : '';
    note.hidden = !note.textContent;
  }

  function applySetup(s) {
    $('url-input').value = s.url || '';
    renderPlayerInputs(s.rawPlayers && s.rawPlayers.length ? s.rawPlayers : ['', '']);
    var m = document.querySelector('input[name="mode"][value="' + (s.mode === 'free' ? 'free' : 'choice') + '"]');
    if (m) m.checked = true;
    var sel = $('rounds-select');
    if (s.rounds != null && sel.querySelector('option[value="' + s.rounds + '"]')) sel.value = String(s.rounds);
    var c = document.querySelector('input[name="clip-start"][value="' + (s.clipStart === 'random' ? 'random' : 'beginning') + '"]');
    if (c) c.checked = true;
    var so = s.soundOn === 'host' || s.soundOn === 'all' ? s.soundOn : local.get(LOCAL_SOUND_ON) === 'host' ? 'host' : 'all';
    var sr = document.querySelector('input[name="sound-on"][value="' + so + '"]');
    if (sr) sr.checked = true;
    // Clip lengths (a setup saved before they existed: 5 s, then 10 s more).
    var cl = G.normalizeClip(s.clip);
    [['clip-first', cl.firstMs, G.DEFAULT_CLIP.firstMs], ['clip-extra', cl.extendMs, G.DEFAULT_CLIP.extendMs]].forEach(function (x) {
      var box = $(x[0]);
      var v = String(x[1] / 1000);
      box.value = box.querySelector('option[value="' + v + '"]') ? v : String(x[2] / 1000);
    });
    renderClipSetting();
  }

  function setupError(msg) {
    var e = $('setup-error');
    e.textContent = msg || '';
    e.hidden = !msg;
  }

  // Show the "skip used songs" checkbox when this link was already played this session.
  function refreshExcludeHint() {
    var key = normalizeUrlKey($('url-input').value);
    var used = key ? getUsed(key) : [];
    $('exclude-wrap').hidden = !used.length;
    $('used-count').textContent = String(used.length);
    refreshExampleNote();
  }

  // Name the example playlist under the link field while it is selected.
  var exampleName = '';
  var exampleNameTried = false;
  function refreshExampleNote() {
    var note = $('example-note');
    var on = tracksSource.isExample($('url-input').value);
    note.hidden = !on;
    if (!on) return;
    note.textContent = exampleName
      ? 'Example: “' + exampleName + '” (songs saved with the game).'
      : 'Example playlist (songs saved with the game).';
    if (!exampleName && !exampleNameTried) {
      exampleNameTried = true;
      tracksSource.loadExampleSnapshot().then(function (data) {
        if (data && data.source && data.source.name) {
          exampleName = data.source.name;
          refreshExampleNote();
        }
      }, function () { /* the note stays generic */ });
    }
  }
  function normalizeUrlKey(u) {
    var m = /(playlist|album|track)[/:]([A-Za-z0-9]{10,40})/.exec(u || '');
    return m ? m[1] + ':' + m[2] : '';
  }

  function goToSetup() {
    closeRoom();
    leaveRoom();
    player.unload();
    game = null;
    saveGame();
    applySetup(store.get(STORE_SETUP) || {});
    refreshExcludeHint();
    setupError('');
    hideAuthBanner();
    showScreen('setup');
    renderSound();
    if (soundPref() === 'spotify') ensureSpotifyReady();
    try { renderResumeOffers(); } catch (e) { $('resume-box').hidden = true; if (window.console) console.error(e); }
  }

  /**
   * Load the songs for a setup and work out which are fresh. Shows the loading
   * screen; on failure returns to setup with an error and resolves to null.
   */
  async function loadSongs(setup, excludeUsed) {
    setupError('');
    if (!setup.url) { setupError('Paste a Spotify playlist, album or track link to start.'); $('url-input').focus(); return null; }
    var spotify = setup.engine === 'spotify';
    if (spotify && !spAuth.isSignedIn()) {
      goToSetup();
      setupError('Sign in with Spotify under Sound to play full songs, or choose Previews.');
      return null;
    }
    if (spotify && !spCtl.deviceId()) {
      goToSetup();
      setupError('Pick where the songs should play under Sound (“Play on”). If your device isn’t listed, open Spotify on it and tap Refresh.');
      return null;
    }
    store.set(STORE_SETUP, setup);
    $('loading-text').textContent = spotify ? 'Loading songs from Spotify…' : tracksSource.isExample(setup.url)
      ? 'Loading the example playlist…'
      : tracksSource.mode() === 'static'
      ? 'Loading songs from Spotify through a public proxy…'
      : 'Loading songs from Spotify…';
    showScreen('loading');

    var data;
    try {
      data = spotify ? await loadSpotifyTracks(setup.url) : await tracksSource.loadTracks(setup.url);
    } catch (err) {
      if (err && err.code === 'signed-out') { goToSetup(); renderSound(); setupError(err.message); return null; }
      if (err && err.attempts && window.console) console.warn('Static mode: every CORS proxy failed.', err.attempts);
      // goToSetup() refills the form: "Play again" (or a restored game) may not have filled it.
      goToSetup();
      setupError(err && err.message ? err.message : 'Couldn’t load that link. Try again.');
      return null;
    }

    var key = normalizeUrlKey(setup.url) || sourceKey(data.source);
    var used = excludeUsed ? getUsed(key) : [];
    if (!excludeUsed) setUsed(key, []);
    var fresh = data.tracks.filter(function (t) { return used.indexOf(t.id) === -1; });
    if (!fresh.length) {
      goToSetup();
      setupError('You have already heard every song from this link in this session. Untick “Skip songs already played” to start over, or try another playlist.');
      return null;
    }

    var notes = [];
    var mode = setup.mode;
    var distinct = G.distinctTitleCount(data.tracks);
    if (mode === 'choice' && distinct < 2) {
      mode = 'free';
      notes.push('Only one song is available, so multiple choice is off. Type your answer instead.');
    } else if (mode === 'choice' && distinct < 4) {
      notes.push('This link has only ' + distinct + ' different songs, so each question has ' + distinct + ' options.');
    }
    if (data.note) notes.push(data.note);
    if (data.skipped) {
      notes.push(data.skipped + ' song' + (data.skipped === 1 ? '' : 's') +
        (data.via === 'spotify' ? ' that can’t be played (local files or unavailable here) were skipped.' : ' without a preview were skipped.'));
    }
    if (used.length) notes.push('Skipping ' + (data.tracks.length - fresh.length) + ' song(s) you already heard.');
    return {
      mode: mode,
      engine: spotify ? 'spotify' : 'preview',
      tracks: data.tracks,
      used: used,
      notes: notes,
      source: { type: data.source.type, name: data.source.name, image: data.source.image, key: key },
    };
  }

  /**
   * Full songs: every song of the link from the Web API (no 100-song cap).
   * Spotify only shows the songs of playlists the signed-in user owns or
   * collaborates on; for other playlists the public embed page (or the
   * bundled example) is used as before, up to about 100 songs.
   */
  async function loadSpotifyTracks(url) {
    var ref = window.SpotifyUrl.parseSpotifyInput(url);
    try {
      return await spApi.loadTracks(ref);
    } catch (err) {
      if (!err || err.code !== 'playlist-not-owned') throw err;
      var data = await tracksSource.loadTracks(url);
      return Object.assign({}, data, {
        tracks: data.tracks.map(function (t) { return Object.assign({ uri: 'spotify:track:' + t.id }, t); }),
        note: err.message + ' Using the songs on its public page instead' + (data.tracks.length >= 95 ? ' (the first ~100).' : '.'),
      });
    }
  }

  async function startFromSetup(setup, excludeUsed) {
    var songs = await loadSongs(setup, excludeUsed);
    if (!songs) return;
    // Previews are 30 seconds: the extra time is shortened so the whole clip fits.
    var fit = songs.engine === 'spotify' ? Object.assign(G.normalizeClip(setup.clip), { clamped: false }) : G.fitClipToPreview(setup.clip);
    game = G.createGame({
      players: setup.players,
      mode: songs.mode,
      rounds: setup.rounds,
      clipStartMode: setup.clipStart === 'random' ? 'random' : 'beginning',
      clip: fit,
      tracks: songs.tracks,
      usedIds: songs.used,
      source: songs.source,
      sourceUrl: setup.url,
    });
    if (fit.clamped) {
      game.clipClamped = true;
      songs.notes.push(Room.previewFitNote(game.clip));
    }
    game.notes = songs.notes;
    game.engine = songs.engine;
    var key = songs.source.key;
    G.startTurn(game);
    setUsed(key, game.usedIds);
    saveGame();
    enterRound();
  }

  // ---------- Scoreboard ----------

  var lastScores = {};
  /** Host / pass-the-phone scoreboard from the game (room players may be offline). */
  function renderScoreboard() {
    if (!game) { drawScoreboard([], -1); return; }
    var roomPlayers = hosting ? hosting.room.players : null;
    drawScoreboard(game.players.map(function (p, i) {
      return { name: p.name, score: p.score, offline: !!(roomPlayers && roomPlayers[i] && !roomPlayers[i].online) };
    }), game.phase === 'over' ? -1 : G.currentPlayerIndex(game));
  }

  function drawScoreboard(players, active) {
    var sb = $('scoreboard');
    sb.textContent = '';
    players.forEach(function (p, i) {
      var chip = el('div', { class: 'score-chip' + (i === active ? ' active' : '') + (p.offline ? ' offline' : ''), title: p.name }, [
        el('span', { class: 'name', text: p.name }),
        el('span', { class: 'pts', text: String(p.score) }),
      ]);
      if (i === active) chip.setAttribute('aria-current', 'true');
      if (lastScores[i] != null && lastScores[i] !== p.score) chip.classList.add('bump');
      lastScores[i] = p.score;
      sb.appendChild(chip);
    });
    var activeChip = sb.querySelector('.active');
    if (activeChip && activeChip.scrollIntoView) activeChip.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  // ---------- Round screen ----------

  function showNotice(msg) {
    var n = $('notice');
    n.textContent = msg || '';
    n.hidden = !msg;
  }

  function currentTrack() {
    return game && game.current ? G.trackById(game, game.current.trackId) : null;
  }

  function enterRound() {
    var cur = game.current;
    var track = currentTrack();
    var roomTurn = hosting ? hosting.room.turn : null;
    turnUi = {
      heard: cur.extended ? clipFirst() : roomTurn ? roomTurn.heard : 0,
      playedOnce: cur.extended || !!(roomTurn && roomTurn.playedOnce),
      audioError: false,
    };
    showScreen('round');
    renderScoreboard();

    var pIndex = G.currentPlayerIndex(game);
    $('turn-player').textContent = game.players[pIndex].name;
    var meta = game.rounds
      ? 'Round ' + G.roundNumber(game) + ' of ' + game.rounds
      : 'Round ' + G.roundNumber(game);
    var available = game.turn + 1 + game.queue.length;
    meta += ' · Song ' + (game.turn + 1) + ' of ' + (game.totalTurns ? Math.min(game.totalTurns, available) : available);
    $('turn-meta').textContent = meta;

    showNotice(game.notes && game.notes.length ? game.notes.join(' ') : '');
    game.notes = [];
    $('skip-btn').hidden = true;

    // Answer area. Options contain titles only; nothing marks which one is right.
    var choice = $('answer-choice');
    choice.textContent = '';
    if (cur.options) {
      cur.options.forEach(function (o) {
        var b = el('button', { type: 'button', class: 'option', 'data-option': o.id }, [
          el('span', { class: 'o-title', text: o.title }),
          el('span', { class: 'o-artist', text: o.artist }),
        ]);
        b.addEventListener('click', function () { submit('guess', o.id); });
        choice.appendChild(b);
      });
    }
    choice.hidden = !cur.options;
    $('answer-free').hidden = !!cur.options;
    $('free-input').value = '';
    renderRoomTurn();

    renderClipLabels();
    renderExtendState();
    renderProgress(turnUi.heard);
    onPlayerState('stopped');
    syncEngine();
    player.load(track);
  }

  /** Round screen labels and progress split for this game's clip lengths. */
  function renderClipLabels() {
    var c = clip();
    fillClipText($('screen-round'), c);
    renderClipSplit('', c);
  }

  function renderExtendState() {
    var cur = game.current;
    var c = clip();
    $('seg-long').classList.toggle('locked', !cur.extended);
    $('extend-btn').disabled = cur.extended || !turnUi.playedOnce || !c.extendMs;
    $('extend-btn').hidden = cur.extended || !c.extendMs; // no extra time in this game: no button
    $('worth').textContent = '';
    $('worth').appendChild(document.createTextNode('Worth '));
    $('worth').appendChild(el('strong', { text: String(cur.extended ? G.POINTS.extended : G.POINTS.short) }));
    $('worth').appendChild(document.createTextNode(' points'));
    $('play-btn').setAttribute('aria-label', 'Play the first ' + secondsText(cur.extended ? clipTotal() : clipFirst()));
  }

  function renderProgress(t) {
    if (!game || !game.current) return;
    var cur = game.current;
    turnUi.heard = Math.max(turnUi.heard, Math.min(t, cur.extended ? clipTotal() : clipFirst()));
    var shown = player.playing ? t : turnUi.heard;
    var short = Math.min(shown, clipFirst()) / clipFirst();
    var long = clipExtend() ? Math.max(0, Math.min(shown, clipTotal()) - clipFirst()) / clipExtend() : 0;
    $('fill-short').style.width = (short * 100).toFixed(2) + '%';
    $('fill-long').style.width = (long * 100).toFixed(2) + '%';
    $('clip-time').textContent = Math.min(shown, clipTotal()).toFixed(1) + 's';
  }

  function onPlayerState(s) {
    var btn = $('play-btn');
    if (resultMode === 'listen') {
      $('listen-btn').textContent = s === 'stopped' ? listenLabel() : player.kind === 'spotify' ? 'Pause' : 'Stop';
      if (s === 'stopped') resultMode = null;
      return;
    }
    if (!game || game.phase !== 'round') return;
    btn.classList.toggle('playing', s === 'playing' || s === 'loading');
    btn.classList.toggle('loading', s === 'loading');
    var cur = game.current;
    var status = $('clip-status');
    var playingExtension = cur.extended && Math.round(player.segStartMs / 1000 - clipOffset()) > 0;
    if (s === 'loading') status.textContent = 'Loading…';
    else if (s === 'playing') status.textContent = playingExtension ? 'Playing seconds ' + secs(clipFirst()) + '–' + secs(clipTotal()) : 'Playing…';
    else {
      if (turnUi.heard > 0) turnUi.playedOnce = true;
      status.textContent = !turnUi.playedOnce
        ? 'Tap play to hear ' + secondsText(clipFirst())
        : cur.extended ? 'Tap play to hear all ' + secs(clipTotal()) + ' seconds again' : 'Tap play to hear it again';
      renderExtendState();
      renderProgress(turnUi.heard);
    }
  }

  // After a load/play error the media element must be reloaded before it can play again.
  function reloadAfterError() {
    if (!turnUi.audioError) return;
    turnUi.audioError = false;
    showNotice('');
    player.load(currentTrack());
  }

  function onPlayClick() {
    if (hosting) {
      // Host fallback (or a player on this device): the same actions a phone sends.
      if (ghost) { resumeHostSound(); return; }
      if (player.playing) { hostAct('stop'); return; }
      reloadAfterError();
      hostAct('play');
      return;
    }
    if (player.playing) { player.stop(); return; }
    var cur = game.current;
    reloadAfterError();
    turnUi.heard = 0;
    var c = clip();
    player.playSegment(0, cur.extended ? c.firstMs + c.extendMs : c.firstMs, clipOffsetMs);
  }

  function onExtendClick() {
    var cur = game.current;
    if (cur.extended || cur.answered) return;
    var c = clip();
    if (!c.extendMs) return; // no extra time in this game
    if (hosting) { hostAct('extend'); return; }
    cur.extended = true;
    saveGame();
    renderExtendState();
    reloadAfterError();
    turnUi.heard = clipFirst();
    player.playSegment(c.firstMs, c.firstMs + c.extendMs, clipOffsetMs);
  }

  function submit(kind, value) {
    if (!game || !game.current || game.current.answered) return;
    if (kind === 'guess' && !game.current.options && !String(value || '').trim()) {
      $('free-input').focus();
      toast('Type a song title first (or reveal the answer).');
      return;
    }
    if (hosting) {
      if (kind === 'guess') hostAct(answerAction(value));
      else hostAct(kind); // 'reveal' | 'skip'
      return;
    }
    player.stop();
    G.answer(game, kind, value);
    saveGame();
    enterResult();
  }

  function answerAction(value) {
    return game.current.options ? { type: 'answer', optionId: value } : { type: 'answer', text: value };
  }

  // ---------- Result screen ----------

  function enterResult() {
    var cur = game.current;
    var track = currentTrack();
    showScreen('result');
    renderScoreboard();

    var v = $('verdict');
    v.className = 'verdict ' + cur.outcome;
    var name = game.players[G.currentPlayerIndex(game)].name;
    var title = { correct: (cur.match === 'close' ? 'Close enough! +' : 'Correct! +') + cur.points, wrong: 'Not quite', revealed: 'Answer revealed', skipped: 'Song skipped' }[cur.outcome];
    $('verdict-title').textContent = title;
    var sub = '';
    if (cur.outcome === 'correct') sub = name + (cur.extended ? ' got it with the extra ' + secs(clipExtend()) + ' seconds.' : ' got it in ' + secondsText(clipFirst()) + '!');
    else if (cur.outcome === 'wrong') sub = cur.guess ? name + ' guessed “' + cur.guess + '”. No points.' : 'No points this time.';
    else sub = 'No points this time.';
    $('verdict-sub').textContent = sub;

    $('reveal-title').textContent = track.title;
    $('reveal-artist').textContent = track.artist;
    $('spotify-link').href = 'https://open.spotify.com/track/' + encodeURIComponent(track.id);
    setCover(track);

    syncEngine();
    $('listen-btn').textContent = listenLabel();
    $('listen-btn').hidden = player.kind === 'preview' && !track.previewUrl;
    $('next-btn').hidden = false;
    $('next-btn').disabled = false;
    $('result-wait').hidden = true;
    var last = G.isOver(Object.assign({}, game, { turn: game.turn + 1 }));
    $('next-btn').textContent = last
      ? 'See final standings'
      : 'Next: ' + game.players[(game.turn + 1) % game.players.length].name + '’s turn';
    $('next-btn').focus({ preventScroll: true });
  }

  var coverReq = 0;
  function setCover(track) {
    var box = $('cover');
    box.textContent = '♫';
    var req = ++coverReq;
    var put = function (src) {
      if (req !== coverReq || !src) return;
      var img = el('img', { alt: 'Cover art for ' + track.title, src: src, referrerpolicy: 'no-referrer' });
      img.addEventListener('error', function () { box.textContent = '♫'; });
      box.textContent = '';
      box.appendChild(img);
    };
    if (track.image) { put(track.image); return; }
    // Playlist embeds have no per-track art: look it up now that the answer is shown.
    // Falls back to the playlist cover (or the note icon) if the lookup fails.
    tracksSource.coverUrl(track.id).then(function (image) {
      if (image) {
        track.image = image;
        saveGame();
        if (hosting) hosting.ctl.broadcast(); // players' result screens show the cover too
        put(image);
      } else if (game && game.source && game.source.image) put(game.source.image);
    });
  }

  function onListenClick() {
    if (resultMode === 'listen' && player.playing) { player.stop(); return; }
    resultMode = 'listen';
    $('listen-btn').textContent = player.kind === 'spotify' ? 'Pause' : 'Stop';
    var d = player.durationMs();
    // The whole preview, or the whole song (its length comes from Spotify if unknown).
    player.playSegment(0, d > 0 ? d : player.kind === 'spotify' ? 3600000 : 30000);
  }

  function onNextClick() {
    if (resultMode === 'listen') player.stop();
    resultMode = null;
    if (joined) { joined.ctl.act('next'); $('next-btn').disabled = true; return; }
    if (hosting) { hostAct('next'); return; }
    G.nextTurn(game);
    setUsed(game.source.key, game.usedIds);
    saveGame();
    if (game.phase === 'over') enterGameOver();
    else enterRound();
  }

  // ---------- Game over ----------

  function enterGameOver() {
    player.unload();
    game.phase = 'over';
    saveGame();
    showScreen('over');
    renderScoreboard();
    var st = G.standings(game);
    var list = $('standings');
    list.textContent = '';
    var tie = st.length > 1 && st[0].score === st[1].score;
    st.forEach(function (p) {
      list.appendChild(el('li', { class: p.rank === 1 ? 'first' : '' }, [
        el('span', { class: 'rank', text: String(p.rank) }),
        el('div', { class: 'who' }, [
          el('div', { class: 'n', text: p.name }),
          el('div', { class: 'd', text: p.correct + ' correct' }),
        ]),
        el('span', { class: 'total', text: String(p.score) }),
      ]));
    });
    if (game.players.length === 1) $('over-title').textContent = 'You scored ' + st[0].score + '!';
    else if (tie) $('over-title').textContent = 'It’s a tie!';
    else $('over-title').textContent = st[0].name + ' wins!';

    var songs = game.history.length;
    var ranOut = game.queue.length === 0;
    var left = game.queue.length; // usedIds can include ids no longer in this playlist
    $('over-sub').textContent = songs + ' song' + (songs === 1 ? '' : 's') + ' played from “' + game.source.name + '”.' +
      (ranOut ? ' You’ve heard every available song.' : ' ' + left + ' unheard song' + (left === 1 ? '' : 's') + ' left.');
    $('again-exclude').checked = !ranOut;
    $('again-exclude-wrap').hidden = false;
    $('over-player').hidden = true;
    $('again-btn').parentNode.hidden = false;
    $('again-btn').textContent = hosting ? 'Play again with the same players' : 'Play again with this playlist';
    $('new-btn').textContent = hosting ? 'Close the room' : 'New playlist / players';
  }

  function onAgainClick() {
    if (hosting) { roomPlayAgain(); return; }
    var setup = store.get(STORE_SETUP) || readSetup();
    var exclude = $('again-exclude').checked;
    startFromSetup(setup, exclude);
  }

  // =====================================================================
  // Multiplayer rooms: host ("TV") side
  // =====================================================================

  var hosting = null; // { room, ctl, transport, status: 'connecting'|'open'|'retrying'|'error', error, attempts }
  var joined = null; // player side, see below

  /**
   * Options for Transport.create: PeerServer settings and ICE servers from
   * PEERJS in config.js. o.relay (a phone retrying after ICE failed) or
   * ?ice=relay: TURN relays only.
   */
  function transportOptions(o) {
    var cfg = (window.GTS_CONFIG || {}).PEERJS || {};
    var server = {};
    ['host', 'port', 'path', 'key', 'secure', 'pingInterval', 'config'].forEach(function (k) { if (cfg[k] != null) server[k] = cfg[k]; });
    return {
      peerOptions: server,
      iceServers: cfg.iceServers || (cfg.config && cfg.config.iceServers) || null,
      iceTransportPolicy: ICE_RELAY || (o && o.relay) ? 'relay' : cfg.iceTransportPolicy || 'all',
      iceCandidatePoolSize: cfg.iceCandidatePoolSize,
      debug: DEBUG_LEVEL,
    };
  }

  function roomLink(code) {
    return Room.joinLink(window.location.origin + window.location.pathname, code, TRANSPORT_KIND);
  }

  function hostAct(action) {
    if (!hosting) return;
    var res = hosting.ctl.act(typeof action === 'string' ? { type: action } : action);
    if (!res.ok) toast(res.message);
  }

  async function hostFromSetup(setup, excludeUsed) {
    var songs = await loadSongs(setup, excludeUsed);
    if (!songs) return;
    var room = Room.createRoom({
      code: Room.generateCode(),
      settings: {
        mode: songs.mode, rounds: setup.rounds, clipStart: setup.clipStart, clip: setup.clip, sourceUrl: setup.url,
        engine: songs.engine, device: songs.engine === 'spotify' ? spCtl.selectedDevice() : null,
        soundOn: setup.soundOn,
      },
      source: songs.source,
      tracks: songs.tracks,
      usedIds: songs.used,
      notes: songs.notes,
    });
    store.remove(STORE_GAME);
    openRoom(room, true);
  }

  /** Start hosting `room` (new, restored after a reload, or resumed from localStorage). */
  function openRoom(room, fresh) {
    closeRoom();
    leaveRoom();
    hosting = {
      room: room, ctl: null, transport: null, status: 'connecting', error: null, attempts: 0, fresh: fresh,
      net: 'idle', netError: null, claimedAt: Date.now(),
    };
    game = room.game;
    setHostUrl(room.code);
    saveGame();
    connectHost();
    showHostScreen();
    keepAwake(true);
  }

  /** The saved copy of the hosted room (localStorage), for "Resume room" after the tab is gone. */
  function persistHostRoom() {
    var h = hosting;
    if (!h) return;
    var key = LOCAL_ROOM + h.room.code;
    // A finished game isn't worth resuming: "End game" / the last song clears it.
    if (h.room.game && h.room.game.phase === 'over') { local.remove(key); return; }
    local.setJSON(key, Room.savedRoomEntry(h.room, { now: Date.now(), transport: TRANSPORT_KIND, owner: TAB_ID, claimedAt: h.claimedAt }));
  }

  /** Reopen a saved room (same code): phones with their token get their slots back. */
  function resumeRoom(room) {
    store.remove(STORE_GAME);
    // Full songs: play on the device this room used (this browser's player gets a new id each visit).
    if (room.settings && room.settings.device && room.settings.engine === 'spotify') spCtl.selectDevice(room.settings.device);
    openRoom(room, false);
  }

  /** ?host=CODE while hosting: if the browser reloads an evicted tab, the room is resumed. */
  function setHostUrl(code) {
    try {
      var url = window.location.pathname + '?host=' + encodeURIComponent(code) + (TRANSPORT_KIND === 'local' ? '&transport=local' : '');
      window.history.replaceState(null, '', url);
    } catch (e) { /* ignore */ }
  }

  function currentUrlHost() {
    var m = /[?&]host=([^&#]*)/.exec(window.location.search);
    if (!m) return '';
    try { return Room.normalizeCode(decodeURIComponent(m[1])); } catch (e) { return ''; }
  }

  function connectHost() {
    var h = hosting;
    if (!h) return;
    if (h.transport) { try { h.transport.close(); } catch (e) { /* ignore */ } }
    var t = Transport.create(TRANSPORT_KIND, transportOptions());
    h.transport = t;
    h.status = h.attempts ? 'retrying' : 'connecting';
    h.net = 'idle';
    h.netError = null;
    // The signaling server should answer within seconds: say so on screen after 10 s.
    if (!h.connectingSince) h.connectingSince = Date.now();
    clearTimeout(h.slowTimer);
    h.slowTimer = setTimeout(function () { if (hosting === h) renderHostConn(); }, 10000 - Math.min(9000, Date.now() - h.connectingSince));
    h.ctl = Room.createHost({
      room: h.room,
      transport: t,
      clock: clockNow,
      hooks: { onEffect: onRoomEffect, onChange: onRoomChange },
    });
    // Signaling status after the room opened: the transport reconnects on its own.
    if (t.onStatus) {
      t.onStatus(function (st) {
        if (hosting !== h || h.transport !== t) return;
        h.net = st;
        if (st === 'connected') h.netError = null;
        renderHostConn();
      });
    }
    t.onError(function (err) {
      if (hosting !== h || h.transport !== t) return;
      if (err.code === 'room-taken') { h.netError = err; renderHostConn(); return; }
      h.lastError = { code: err.code, message: err.message, at: Date.now() };
      toast(err.message, 6000);
    });
    renderHostConn();
    t.host(h.room.code).then(function () {
      if (hosting !== h || h.transport !== t) { t.close(); return; }
      h.status = 'open';
      h.error = null;
      h.attempts = 0;
      h.connectingSince = 0;
      h.openedAt = Date.now();
      clearTimeout(h.slowTimer);
      renderHostConn();
      h.ctl.broadcast();
    }, function (err) {
      if (hosting !== h || h.transport !== t) return;
      if (err.code === 'room-taken') {
        if (!h.room.game && !h.room.players.some(function (p) { return !p.local; }) && h.attempts < 5 && h.fresh) {
          // A brand-new room: just pick another code.
          h.attempts++;
          local.remove(LOCAL_ROOM + h.room.code);
          h.room.code = Room.generateCode();
          setHostUrl(h.room.code);
          saveGame();
          showHostScreen();
          connectHost();
          return;
        }
        // Reopening after a reload or resume: the signaling server can hold the
        // old page's registration for a while. Keep trying for about 30 seconds.
        if (h.attempts < 12) {
          h.attempts++;
          h.status = 'retrying';
          renderHostConn();
          setTimeout(function () { if (hosting === h && h.transport === t) connectHost(); }, 2500);
          return;
        }
        err = Transport.transportError('room-taken', 'Room ' + h.room.code + ' is still open somewhere else (another tab or device?). Close it there, or wait a minute.');
      } else if (err.code === 'signaling-unreachable' && h.attempts < 3 && navigator.onLine !== false) {
        h.attempts++;
        h.status = 'retrying';
        renderHostConn();
        setTimeout(function () { if (hosting === h && h.transport === t) connectHost(); }, 3000);
        return;
      }
      h.status = 'error';
      h.error = err;
      h.lastError = { code: err.code, message: err.message, at: Date.now() };
      h.connectingSince = 0;
      clearTimeout(h.slowTimer);
      renderHostConn();
    });
  }

  /**
   * Stop hosting on purpose ("Close the room", back to setup, joining another
   * room): players are told, and the saved room is forgotten. A reload or a
   * closed tab doesn't come through here, so the room can be resumed.
   */
  function closeRoom() {
    if (!hosting) return;
    var h = hosting;
    hosting = null;
    h.room.players.forEach(function (p) {
      if (p.peerId && p.online) {
        try { h.transport.send(p.peerId, Room.message('error', { code: 'closed', message: 'The host closed the room.' })); } catch (e) { /* ignore */ }
      }
    });
    // Give the goodbye messages a moment to leave before the connections close.
    var t = h.transport;
    setTimeout(function () { try { t.close(); } catch (e) { /* ignore */ } }, 300);
    store.remove(STORE_ROOM);
    local.remove(LOCAL_ROOM + h.room.code);
    if (currentUrlHost()) setUrlRoom('');
    banner('');
    renderNetStatus();
    keepAwake(false);
  }

  /** Another tab resumed this room: it is the host now. Stop quietly (no "closed" to players). */
  function yieldRoom() {
    var h = hosting;
    if (!h) return;
    hosting = null;
    try { h.transport.close(); } catch (e) { /* ignore */ }
    store.remove(STORE_ROOM);
    player.unload();
    game = null;
    setUrlRoom('');
    keepAwake(false);
    goToSetup();
    toast('Room ' + h.room.code + ' is now hosted in another tab.', 6000);
  }

  /** 'connecting' | 'connected' | 'reconnecting' | 'offline' for the host's status pill. */
  function hostNetState() {
    var h = hosting;
    if (!h) return null;
    if (navigator.onLine === false || h.status === 'error') return 'offline';
    // Not registered with the signaling server after 10 s: nobody can join (still retrying).
    if ((h.status === 'connecting' || h.status === 'retrying') && h.connectingSince && Date.now() - h.connectingSince >= 10000) return 'offline';
    if (h.status === 'connecting') return 'connecting';
    if (h.status === 'retrying') return 'reconnecting';
    if (h.net === 'offline' || h.netError) return 'offline';
    if (h.net === 'reconnecting') return 'reconnecting';
    return 'connected';
  }

  var NET_LABELS = { connecting: 'Connecting…', connected: 'Connected', reconnecting: 'Reconnecting…', offline: 'Offline' };
  function renderNetStatus() {
    var st = hostNetState();
    var pill = $('net-status');
    pill.hidden = !st;
    if (!st) return;
    pill.className = 'net-status ' + st;
    $('net-status-text').textContent = NET_LABELS[st];
    pill.title = st === 'connected' ? 'Players can join and play.'
      : st === 'offline' ? 'New players can’t join right now.'
      : 'Getting the room back online. Players reconnect on their own.';
  }

  function renderHostConn() {
    var h = hosting;
    renderNetStatus();
    if (!h) return;
    var msg = '';
    var bad = false;
    var retry = null;
    var peerNote = TRANSPORT_KIND === 'local' ? ' (same-browser test mode)' : '';
    var net = hostNetState();
    var slow = (h.status === 'connecting' || h.status === 'retrying') && h.connectingSince && Date.now() - h.connectingSince >= 10000;
    if (slow) {
      // Nobody can join until the room is registered with the signaling server.
      msg = 'Still can’t reach the signaling server (' + (TRANSPORT_KIND === 'local' ? 'same-browser test mode' : '0.peerjs.com') +
        ') after ' + Math.round((Date.now() - h.connectingSince) / 1000) + ' seconds, so players can’t join yet. Check this device’s internet connection. Still trying…';
      bad = true;
      retry = function () { h.attempts = 0; h.connectingSince = Date.now(); connectHost(); };
    } else if (h.status === 'connecting') msg = 'Opening room ' + h.room.code + peerNote + '…';
    else if (h.status === 'retrying') msg = 'Reopening room ' + h.room.code + '… Players will reconnect automatically.';
    else if (h.status === 'error') {
      msg = (h.error && h.error.message ? h.error.message : 'Couldn’t open the room.') + ' Tap “Try again”.';
      bad = true;
      retry = function () { h.attempts = 0; connectHost(); };
    } else if (navigator.onLine === false) {
      msg = 'This device is offline. The room comes back when the internet does; players reconnect on their own.';
      bad = true;
    } else if (net === 'offline') {
      msg = (h.netError && h.netError.message ? h.netError.message : 'Lost the connection to the signaling server.') + ' New players can’t join.';
      bad = true;
      retry = function () { h.netError = null; if (h.transport.wake) h.transport.wake({}); renderHostConn(); };
    } else if (net === 'reconnecting') {
      msg = 'Reconnecting to the signaling server… Players already here can keep playing; new players can join once it’s back.';
    }
    // Lobby: inline notice with a retry button. In game: the banner.
    var lc = $('lobby-conn');
    lc.textContent = '';
    if (msg) {
      lc.appendChild(document.createTextNode(msg + ' '));
      if (retry) lc.appendChild(el('button', { type: 'button', class: 'btn-link', id: 'host-retry', text: 'Try again', onclick: retry }));
    }
    lc.hidden = !msg;
    lc.classList.toggle('bad', bad);
    if (h.room.game) {
      banner(msg, bad);
      if (retry) {
        var b = $('conn-banner');
        b.appendChild(document.createTextNode(' '));
        b.appendChild(el('button', { type: 'button', class: 'btn-link', text: 'Try again', onclick: retry }));
      }
    } else banner('');
  }

  function showHostScreen() {
    var room = hosting.room;
    game = room.game;
    if (!game) { enterLobby(); return; }
    if (game.phase === 'over') { enterGameOver(); return; }
    if (game.phase === 'result' && game.current && game.current.answered) { enterResult(); return; }
    if (!game.current) { hosting.ctl.act('end'); enterGameOver(); return; }
    enterRound();
  }

  // ---------- Lobby ----------

  function enterLobby() {
    var room = hosting.room;
    showScreen('lobby');
    $('lobby-code').textContent = room.code;
    $('lobby-link').value = roomLink(room.code);
    var s = room.settings;
    // A single-track link's name is the answer: don't show it on the "TV".
    var srcName = !room.source ? 'Songs' : room.source.type === 'track' ? 'A single song' : room.source.name;
    $('lobby-source').textContent = '“' + srcName + '” · ' + room.tracks.length + ' songs · ' +
      (s.mode === 'free' ? 'Free answer' : 'Multiple choice') + ' · ' +
      (s.rounds ? s.rounds + ' round' + (s.rounds === 1 ? '' : 's') : 'until the songs run out') + ' · ' +
      (s.clipStart === 'random' ? 'random spot' : 'from the beginning') + ' · ' + clipSummary(Room.roomClip(room)) + ' · ' +
      (Room.soundEverywhere(room) ? (s.engine === 'spotify' ? 'sound on this device and on phones signed in to Spotify' : 'sound on every phone') : 'sound on this device only');
    lobbyError('');
    renderLobbyPlayers();
    renderHostConn();
  }

  function lobbyError(msg) {
    $('lobby-error').textContent = msg || '';
    $('lobby-error').hidden = !msg;
  }

  function renderLobbyPlayers() {
    var room = hosting.room;
    var list = $('lobby-players');
    list.textContent = '';
    room.players.forEach(function (p) {
      var remove = el('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Remove ' + p.name, text: '×' });
      remove.addEventListener('click', function () { hosting.ctl.removePlayer(p.id); });
      list.appendChild(el('li', null, [
        el('span', { class: 'dot' + (p.online ? '' : ' off'), title: p.online ? 'Connected' : 'Offline' }),
        el('span', { class: 'n', text: p.name }),
        el('span', { class: 'tag', text: p.local ? 'on this device' : p.online ? 'phone' : 'offline' }),
        remove,
      ]));
    });
    $('lobby-count').textContent = String(room.players.length);
    $('lobby-empty').hidden = room.players.length > 0;
    $('lobby-start').disabled = !Room.canStart(room);
    $('local-form').hidden = room.players.length >= Room.MAX_PLAYERS;
  }

  function onLobbyStart() {
    if (!hosting) return;
    var res = hosting.ctl.start();
    if (!res.ok) { lobbyError(res.message); return; }
    // This tap lets the browser play audio later, when phones press play.
    player.prime();
  }

  function roomPlayAgain() {
    var room = hosting.room;
    var key = room.source && room.source.key;
    var exclude = $('again-exclude').checked;
    var used = exclude && key ? getUsed(key) : [];
    if (!exclude && key) setUsed(key, []);
    var fresh = room.tracks.filter(function (t) { return used.indexOf(t.id) === -1; });
    if (!fresh.length) { toast('You’ve heard every song from this playlist. Untick “Don’t repeat songs” to play them again.', 5000); return; }
    var notes = used.length ? ['Skipping ' + (room.tracks.length - fresh.length) + ' song(s) you already heard.'] : [];
    var res = hosting.ctl.start({ usedIds: used, notes: notes });
    if (!res.ok) { toast(res.message); return; }
    player.prime();
  }

  function onCopyLink() {
    var input = $('lobby-link');
    var text = input.value;
    var done = function () { toast('Join link copied.'); };
    var fallback = function () {
      input.focus();
      input.select();
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      if (ok) done(); else toast('Couldn’t copy. Select the link and copy it by hand.');
    };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, fallback);
    else fallback();
  }

  // ---------- Game events from the room ----------

  /** Side effects on this device (audio) for an accepted action. */
  function onRoomEffect(effect) {
    if (effect.type === 'play') {
      reloadAfterError();
      if (effect.extend) renderExtendState();
      turnUi.heard = effect.extend ? clipFirst() : 0;
      if (soundEverywhere()) { startSyncedPlay(effect); return; }
      player.playSegment(effect.from * 1000, effect.to * 1000, clipOffsetMs);
    } else if (effect.type === 'stop' || effect.type === 'answered' || effect.type === 'over' || effect.type === 'next') {
      syncReq++;
      stopGhost();
      player.stop();
    }
  }

  // ---------- Sound on every device (host side) ----------

  /** Is the hosted room's clip played on every player's device? */
  function soundEverywhere() { return !!(hosting && Room.soundEverywhere(hosting.room)); }

  var syncReq = 0;
  var lastSync = null; // the last clip sent to every device (for the host's own catch-up)

  /**
   * How far ahead a clip is scheduled, so the `play` reaches every phone
   * before it starts: the slowest phone's round trip plus a margin (at least
   * 400 ms; full songs 900 ms, as Spotify itself needs time to start).
   */
  function syncLeadMs(engine) {
    var worst = 0;
    hosting.room.players.forEach(function (p) { if (p.online && !p.local && p.rtt > worst) worst = p.rtt; });
    var lead = Math.max(engine === 'spotify' ? 900 : 400, 250 + worst);
    return Math.min(lead, 2000);
  }

  /**
   * The clip in ms of the audio file ([startMs, endMs)) with its offset, the
   * same for every device. Full songs with a random start need the song's
   * length first (asked from Spotify when the track list didn't have it).
   */
  function syncSegment(effect) {
    var track = currentTrack();
    var cur = game.current;
    var spotify = player.kind === 'spotify';
    var ready = spotify && game.clipStartMode === 'random' && cur.fullStart == null && !(track.durationMs > 0) && spAuth.isSignedIn()
      ? spApi.getTrack(track.id).then(function (n) {
        if (n && n.durationMs > 0) track.durationMs = n.durationMs;
        if (n && n.uri && !track.uri) track.uri = n.uri;
      }, function () { /* 0 s offset then */ })
      : spotify ? Promise.resolve() : previewMetadata(2500);
    return ready.then(function () {
      var dur = spotify ? (track.durationMs > 0 ? track.durationMs : NaN) : previewEngine.durationMs();
      // Every play of a song uses the same offset (a short preview can move it once its length is known).
      var off = turnUi.syncOffMs != null ? turnUi.syncOffMs : clipOffsetMs(dur);
      var startMs = Math.round(effect.from * 1000 + off);
      var endMs = Math.round(effect.to * 1000 + off);
      if (dur > 0) endMs = Math.min(endMs, Math.floor(dur));
      return {
        engine: spotify ? 'spotify' : 'preview',
        startMs: startMs, endMs: endMs, from: effect.from, to: effect.to, extend: !!effect.extend, offMs: off,
        previewUrl: spotify ? null : track.previewUrl,
        uri: spotify ? track.uri || 'spotify:track:' + track.id : null,
        durationMs: track.durationMs > 0 ? track.durationMs : null,
      };
    });
  }

  /**
   * Resolves once the loaded preview's length is known (the random start is
   * fitted to it), or after `ms`.
   */
  function previewMetadata(ms) {
    if (previewEngine.durationMs() > 0 || !previewEngine.audio.getAttribute('src')) return Promise.resolve();
    return new Promise(function (resolve) {
      var a = previewEngine.audio;
      var done = function () { a.removeEventListener('loadedmetadata', done); a.removeEventListener('error', done); clearTimeout(t); resolve(); };
      var t = setTimeout(done, ms);
      a.addEventListener('loadedmetadata', done);
      a.addEventListener('error', done);
    });
  }

  /** Every device plays the clip: schedule it a moment ahead, tell the phones, play it here too. */
  function startSyncedPlay(effect) {
    var g = game;
    var cur = g.current;
    var req = ++syncReq;
    stopGhost();
    player.stop();
    syncSegment(effect).then(function (seg) {
      if (req !== syncReq || !hosting || game !== g || g.current !== cur || cur.answered) return;
      seg.startAt = clockNow() + syncLeadMs(seg.engine);
      lastSync = seg;
      turnUi.syncOffMs = seg.offMs;
      hosting.ctl.play(seg);
      player.playSynced(seg.startMs, seg.endMs, seg.startAt, clockNow);
    });
  }

  /**
   * The host's sound is blocked but the phones play: keep the clip's time on
   * this screen (progress, "stopped" at the end) so the game goes on.
   */
  var ghost = null;
  function startGhost(seg) {
    stopGhost();
    var g = game;
    var tick = function () {
      if (!hosting || game !== g || !g.current || g.phase !== 'round') { stopGhost(); return; }
      var pos = seg.from + (clockNow() - seg.startAt) / 1000;
      if (pos >= seg.to) {
        stopGhost();
        renderProgress(seg.to);
        turnUi.playedOnce = true;
        hosting.ctl.playback({ status: 'stopped', pos: seg.to, from: 0, to: 0 });
        onPlayerState('stopped');
        return;
      }
      pos = Math.max(seg.from, pos);
      renderProgress(pos);
      hosting.ctl.playback({ status: 'playing', pos: pos, from: seg.from, to: seg.to });
    };
    ghost = { seg: seg, timer: setInterval(tick, 200) };
    tick();
  }
  function stopGhost() {
    if (!ghost) return;
    clearInterval(ghost.timer);
    ghost = null;
  }

  /** "Tap play here to hear it": the tap allows sound; join the clip where the phones are. */
  function resumeHostSound() {
    var seg = ghost && ghost.seg;
    stopGhost();
    showNotice('');
    player.unlock();
    if (seg) player.playSynced(seg.startMs, seg.endMs, seg.startAt, clockNow);
  }

  /** The room changed: save it and update the host's screen. */
  function onRoomChange(reason, detail) {
    if (!hosting) return;
    var room = hosting.room;
    saveGame();
    var p = detail && detail.player;
    if (reason === 'join' && p) toast(p.name + (detail.reclaimed ? ' is back.' : ' joined.'));
    if (reason === 'leave' && p) toast(p.name + ' disconnected.');
    if (reason === 'join' || reason === 'leave' || reason === 'players') {
      if (!room.game) renderLobbyPlayers();
      else if (currentScreen === 'round' || currentScreen === 'result' || currentScreen === 'over') {
        renderScoreboard();
        if (currentScreen === 'round') renderRoomTurn();
      }
      return;
    }
    if (reason === 'start') {
      game = room.game;
      if (room.source && room.source.key) setUsed(room.source.key, room.usedIds);
      renderHostConn();
      if (game.phase === 'over') enterGameOver();
      else enterRound();
      return;
    }
    if (reason === 'extend') { renderExtendState(); return; }
    if (reason === 'answer' || reason === 'reveal' || reason === 'skip') { enterResult(); return; }
    if (reason === 'next' || reason === 'end') {
      if (room.source && room.source.key) setUsed(room.source.key, room.usedIds);
      if (game.phase === 'over') enterGameOver();
      else enterRound();
    }
  }

  /** Round screen details that depend on who is playing and whether they're online. */
  function renderRoomTurn() {
    var status = $('room-turn-status');
    if (!hosting || !game || !game.current) {
      status.hidden = true;
      $('reveal-btn').hidden = false;
      $('skip-btn').textContent = 'Skip this song';
      return;
    }
    var p = Room.currentPlayer(hosting.room);
    var remote = p && !p.local;
    status.hidden = false;
    status.classList.toggle('warn', !!(remote && !p.online));
    status.textContent = !p ? ''
      : p.local ? p.name + ' plays on this device.'
      : p.online ? p.name + ' answers on their phone. You can also play or skip from here.'
      : p.name + ' is offline. Wait for them to reconnect, or skip their turn.';
    // Remote player: the options are shown, but answering happens on the phone.
    $('answer-choice').querySelectorAll('.option').forEach(function (b) { b.disabled = !!remote; });
    $('answer-free').hidden = !!game.current.options || !!remote;
    $('reveal-btn').hidden = !!remote;
    $('skip-btn').textContent = remote ? 'Skip ' + p.name + '’s turn (0 pts)' : 'Skip this song';
    if (remote) $('skip-btn').hidden = false;
  }

  /** Tell the phones what the clip player is doing (they show the progress). */
  function reportPlayback(status, msg) {
    if (!hosting || !hosting.ctl || !game || game.phase !== 'round' || !game.current) return;
    var off = clipOffset();
    var playing = status === 'playing' || status === 'loading';
    hosting.ctl.playback({
      status: status,
      pos: playing ? Math.max(0, player.positionMs() / 1000 - off) : turnUi.heard,
      from: playing ? player.segStartMs / 1000 - off : 0,
      to: playing ? player.segEndMs / 1000 - off : 0,
      message: msg || '',
    });
  }

  /**
   * The page is visible / focused / online again. The browser released the
   * wake lock when the page was hidden: ask again. The host's transport checks
   * its signaling connection (and restarts keep-alive clocks if the page was
   * hidden); a player asks the host for a fresh state, or retries at once.
   */
  var hiddenAt = document.hidden ? Date.now() : 0;
  var lastWake = 0;
  function onWake(reason) {
    if (document.visibilityState === 'hidden') return;
    var t = Date.now();
    if (reason === 'focus' && t - lastWake < 2000) return; // focus follows visibilitychange
    lastWake = t;
    var resumed = reason === 'visible' || reason === 'pageshow' || !!hiddenAt;
    hiddenAt = 0;
    if (wantAwake) keepAwake(true);
    if (hosting) {
      var h = hosting;
      if (h.status === 'error' && (reason === 'visible' || reason === 'online')) { h.attempts = 0; connectHost(); }
      else if (h.status === 'open' && h.transport && h.transport.wake) h.transport.wake({ resumed: resumed });
      renderHostConn();
    }
    if (joined) joined.ctl.wake({ resumed: resumed });
  }

  // Screen wake lock: a sleeping host (or phone) drops out of the room.
  var wakeLock = null;
  var wakeLockPending = false;
  var wantAwake = false;
  function keepAwake(on) {
    wantAwake = on;
    if (!on) {
      if (wakeLock) { try { wakeLock.release(); } catch (e) { /* ignore */ } }
      wakeLock = null;
      return;
    }
    // One request at a time: visibilitychange, pageshow and online can fire together,
    // and a second lock would be orphaned (never released by keepAwake(false)).
    if (wakeLock || wakeLockPending || !navigator.wakeLock || document.visibilityState !== 'visible') return;
    wakeLockPending = true;
    navigator.wakeLock.request('screen').then(function (lock) {
      wakeLockPending = false;
      wakeLock = lock;
      lock.addEventListener('release', function () { if (wakeLock === lock) wakeLock = null; });
      if (!wantAwake) keepAwake(false);
    }, function () { wakeLockPending = false; /* not allowed; fine */ });
  }

  // =====================================================================
  // Multiplayer rooms: player (phone) side
  // =====================================================================

  function tokenKey(code, name) {
    return LOCAL_TOKEN + code + ':' + Room.cleanName(name).toLowerCase();
  }

  function currentUrlRoom() {
    var m = /[?&]room=([^&#]*)/.exec(window.location.search);
    if (!m) return '';
    try { return Room.normalizeCode(decodeURIComponent(m[1])); } catch (e) { return ''; }
  }

  function setUrlRoom(code) {
    try {
      var url = code ? roomLink(code)
        : window.location.pathname + (TRANSPORT_KIND === 'local' ? '?transport=local' : '');
      window.history.replaceState(null, '', url);
    } catch (e) { /* ignore */ }
  }

  function goToJoin(code, error, name) {
    closeRoom();
    leaveRoom();
    player.unload();
    game = null;
    showScreen('join');
    $('join-code').value = code || currentUrlRoom() || '';
    if (name != null) $('join-name').value = name;
    else if (!$('join-name').value) $('join-name').value = local.get(LOCAL_NAME) || '';
    joinError(error || '');
    ($('join-code').value ? $('join-name') : $('join-code')).focus();
  }

  function joinError(msg) {
    $('join-error').textContent = msg || '';
    $('join-error').hidden = !msg;
  }

  function onJoinSubmit(e) {
    e.preventDefault();
    var code = Room.normalizeCode($('join-code').value);
    var name = Room.cleanName($('join-name').value);
    if (!code) { joinError('Enter the 4-letter room code shown on the host’s screen.'); $('join-code').focus(); return; }
    if (!name) { joinError('Enter your name.'); $('join-name').focus(); return; }
    unlockAudio(); // inside the tap: clips started by the host later may make sound
    joinRoom(code, name);
  }

  /**
   * Join (or rejoin) a room. o.auto: rejoined without the form (a saved room),
   * so the "Not you?" link is offered; o.token: the saved player token.
   */
  function joinRoom(code, name, o) {
    o = o || {};
    closeRoom();
    leaveRoom();
    game = null;
    local.set(LOCAL_NAME, name);
    store.set(STORE_JOIN, { code: code, name: name });
    setUrlRoom(code);
    var token = local.get(tokenKey(code, name)) || o.token || null;
    var j = {
      code: code, name: name, token: token, auto: !!o.auto, ctl: null, view: null, playback: null, status: 'connecting', detail: null, optionsKey: '', pending: false, savedAt: 0,
      // Sound on this phone: the last `play` from the host, the clip playing here, the loaded preview.
      lastPlay: null, localPlay: null, loadedUrl: '', soundKey: '', soundBlocked: false, spDisabled: false,
    };
    joined = j;
    // Remembered in localStorage (saveJoin) only once the host has let us in:
    // a mistyped code must not be rejoined automatically for 12 hours.
    j.ctl = Room.createPlayer({
      code: code,
      name: name,
      token: token,
      clock: clockNow,
      pingCount: 5,
      // After a failed ICE negotiation the next attempt asks for TURN relays only.
      makeTransport: function (a) { return Transport.create(TRANSPORT_KIND, transportOptions(a)); },
      hooks: {
        onPlay: function (msg) { if (joined === j) onPhonePlay(msg); },
        onPreload: function (msg) { if (joined === j) onPhonePreload(msg); },
        onHalt: function () { if (joined === j) { stopPhoneAudio(); renderPlayerPlayback(); } },
        onStatus: function (s, d) {
          if (joined !== j) return;
          j.status = s;
          j.detail = d;
          // The room is gone for good: don't offer to rejoin it. Any other failure
          // (gave up waiting, replaced, ...): offer it on setup, but don't rejoin by itself.
          if (s === 'failed') {
            if (d && (d.code === 'closed' || d.code === 'removed')) forgetJoin(j);
            else markJoinLeft(j);
          }
          renderPlayer();
        },
        onState: function (v) {
          if (joined !== j) return;
          // A new turn (or no turn): whatever this phone was playing is over.
          var key = v.phase === 'round' && v.turn ? v.turn.song + ':' + v.turn.playerId : v.phase;
          if (key !== j.soundKey) { j.soundKey = key; j.lastPlay = null; stopPhoneAudio(); }
          j.view = v;
          j.playback = v.playback;
          j.playbackAt = now();
          j.pending = false;
          if (v.you && v.you.name && v.you.name !== j.name) j.name = v.you.name;
          if (Date.now() - j.savedAt > 60000) saveJoin(j); // "last played" for the 12-hour window
          renderPlayer();
        },
        onPlayback: function (pb) { if (joined !== j) return; j.playback = pb; j.playbackAt = now(); renderPlayerPlayback(); },
        onError: function (err) { if (joined !== j) return; j.pending = false; toast(err.message); renderPlayer(); },
        onToken: function (t) { local.set(tokenKey(code, name), t); j.token = t; saveJoin(j); },
      },
    });
    j.ctl.start();
    j.ctl.setInfo({ spotifyReady: phoneSpotifyReady() });
    keepAwake(true);
    renderPlayer();
  }

  // ---------- Sound on this phone ("Sound plays on: every player's device") ----------

  /** 'preview' | 'spotify' (full songs) | 'host' (only the host's device plays). */
  function phoneSoundMode() {
    var v = joined && joined.view;
    if (!v || !v.settings || v.settings.soundOn !== 'all') return 'host';
    return v.settings.fullSongs ? 'spotify' : 'preview';
  }

  /** Can this phone play full songs itself (signed in to Spotify, with a device picked)? */
  function phoneSpotifyReady() {
    return !!(spAuth.isSignedIn() && spCtl.deviceId() && !(joined && joined.spDisabled));
  }

  /** Tell the host whether to send this phone the song's URI (full songs). */
  function reportSpotifyReady() {
    if (!joined) return;
    joined.ctl.setInfo({ spotifyReady: phoneSpotifyReady() });
    renderPhoneSound();
  }

  /** Inside a tap: allow clips that the host starts later (no tap of their own) to make sound. */
  function unlockAudio() {
    try { previewEngine.unlock(); } catch (e) { /* ignore */ }
    try { spCtl.activate(); } catch (e) { /* ignore */ }
  }

  function phoneEngine(j) {
    return j && j.localPlay ? (j.localPlay.engine === 'spotify' ? spotifyEngine : previewEngine) : null;
  }

  function stopPhoneAudio() {
    var j = joined;
    if (j) j.localPlay = null;
    if (previewEngine.playing) previewEngine.stop();
    // Always: a full-song clip waiting for its start time (playSynced) isn't `playing` yet.
    spotifyEngine.stop();
  }

  /** The host started a turn: load the preview now, so it's ready when Play is tapped. */
  function onPhonePreload(msg) {
    var j = joined;
    if (!msg || msg.engine !== 'preview' || !msg.previewUrl || j.loadedUrl === msg.previewUrl || previewEngine.playing) return;
    previewEngine.load({ previewUrl: msg.previewUrl });
    j.loadedUrl = msg.previewUrl;
  }

  /**
   * The host started a clip on every device: play [startMs, endMs) here at the
   * host's startAt (converted with this phone's clock offset), or show that
   * the host's device plays it (full songs without Spotify on this phone).
   */
  function onPhonePlay(msg) {
    var j = joined;
    var ci = j.ctl.clockInfo();
    var off = ci ? ci.offset : msg.offset != null ? msg.offset : 0;
    var p = Object.assign({}, msg, { localAt: msg.startAt - off });
    // The same clip again (re-sent after a reconnect) while it still plays here: keep going.
    var cur = j.localPlay && j.localPlay.msg;
    if (cur && cur.seq === msg.seq && cur.startAt === msg.startAt && localBusy(j)) return;
    stopPhoneAudio();
    j.lastPlay = p;
    if (msg.engine === 'preview' && msg.previewUrl) {
      if (j.loadedUrl !== msg.previewUrl) { previewEngine.load({ previewUrl: msg.previewUrl }); j.loadedUrl = msg.previewUrl; }
      j.localPlay = { msg: p, engine: 'preview' };
      previewEngine.playSynced(p.startMs, p.endMs, p.localAt, clockNow);
    } else if (msg.engine === 'spotify' && msg.uri && phoneSpotifyReady()) {
      j.localPlay = { msg: p, engine: 'spotify' };
      spotifyEngine.load({ id: String(msg.uri).split(':').pop(), uri: msg.uri, durationMs: msg.durationMs || 0 });
      spotifyEngine.playSynced(p.startMs, p.endMs, p.localAt, clockNow);
    }
    renderPhoneSound();
    renderPlayerPlayback();
  }

  /** "Tap to enable sound": the tap allows audio; join the clip where the others are (if it's still on). */
  function onEnableSound() {
    var j = joined;
    if (!j) return;
    unlockAudio();
    j.soundBlocked = false;
    var p = j.lastPlay;
    if (p && j.localPlay && j.localPlay.msg === p && clockNow() < p.localAt + (p.endMs - p.startMs) - 100) {
      if (j.localPlay.engine === 'spotify') spotifyEngine.playSynced(p.startMs, p.endMs, p.localAt, clockNow);
      else previewEngine.playSynced(p.startMs, p.endMs, p.localAt, clockNow);
    }
    renderPhoneSound();
    renderPlayerPlayback();
  }

  // The phone's own engines (a phone never uses `player`).
  [previewEngine, spotifyEngine].forEach(function (eng) {
    eng.onState(function () { if (joined && joined.localPlay) renderPlayerPlayback(); });
    eng.onEnded(function () { if (joined) renderPlayerPlayback(); });
    eng.onError(function (msg, err) {
      var j = joined;
      if (!j || !j.localPlay) return;
      var code = err && err.code;
      if (code === 'blocked') j.soundBlocked = true;
      else if (code === 'premium') { j.spDisabled = true; reportSpotifyReady(); toast('Full songs need Spotify Premium. You’ll hear the host’s device instead.', 6000); }
      else if (code === 'signed-out') { reportSpotifyReady(); toast(msg, 6000); }
      else toast(msg, 5000);
      renderPhoneSound();
      renderPlayerPlayback();
    });
  });

  /**
   * The small sound bar on a phone in a room: "Tap to enable sound" when the
   * browser blocked it, and for full songs the Spotify sign-in / device on
   * this phone (or that the host's device plays it).
   */
  function renderPhoneSound() {
    var box = $('p-sound');
    var j = joined;
    var mode = phoneSoundMode();
    var show = !!(j && j.view && j.status !== 'failed' && j.view.phase !== 'over' && (currentScreen === 'pturn' || currentScreen === 'pwait')) && mode !== 'host';
    if (!show) { box.hidden = true; return; }
    var neverTapped = !!(navigator.userActivation && !navigator.userActivation.hasBeenActive);
    var enable = j.soundBlocked || (neverTapped && !previewEngine.unlocked);
    var text = enable ? 'The browser blocked the sound on this phone.' : '';
    var signin = false;
    var devices = false;
    if (mode === 'spotify') {
      if (!spAuth.isSignedIn()) { text = 'Sound is playing on the host’s device (sign in with Spotify to hear it here).'; signin = true; enable = false; }
      else if (j.spDisabled) { text = 'Full songs need Spotify Premium, so the sound plays on the host’s device.'; enable = false; }
      else { devices = true; text = spCtl.deviceId() ? 'Full songs play on this phone’s Spotify device:' : 'Pick where this phone plays the songs (open Spotify on it, then Refresh):'; }
    }
    if (mode === 'spotify' && spAuth.isSignedIn() && !spReadyStarted) ensureSpotifyReady(); // lists this phone's devices
    if (!text && !enable) { box.hidden = true; return; }
    box.hidden = false;
    $('p-sound-text').textContent = text;
    $('p-sound-enable').hidden = !enable;
    $('p-sp-signin').hidden = !signin;
    $('p-sp-devices').hidden = !devices;
  }

  /** Remember the room this device plays in (localStorage), for rejoining after the tab is gone. */
  function saveJoin(j, left) {
    j.savedAt = Date.now();
    local.setJSON(LOCAL_JOIN, Room.savedJoinEntry({ code: j.code, name: j.name, token: j.token, left: !!left }, { now: j.savedAt, transport: TRANSPORT_KIND }));
  }

  function markJoinLeft(j) {
    var saved = local.getJSON(LOCAL_JOIN);
    if (saved && saved.code === j.code && !saved.left) { saved.left = true; local.setJSON(LOCAL_JOIN, saved); }
    j.savedAt = 0; // "Try again" works: the next state saves it again
  }

  function forgetJoin(j) {
    var saved = local.getJSON(LOCAL_JOIN);
    if (saved && saved.code === j.code) local.remove(LOCAL_JOIN);
  }

  /** Leave the room this tab plays in (if any). The setup screen still offers "Rejoin". */
  function leaveRoom() {
    if (!joined) return;
    var j = joined;
    joined = null;
    j.ctl.leave();
    var saved = local.getJSON(LOCAL_JOIN);
    if (saved && saved.code === j.code && saved.name === j.name && !saved.left) saveJoin(j, true);
    store.remove(STORE_JOIN);
    setUrlRoom('');
    cancelAnimationFrame(pbRaf);
    stopPhoneAudio();
    $('p-sound').hidden = true;
    banner('');
    keepAwake(false);
  }

  function now() { return (window.performance && performance.now) ? performance.now() : Date.now(); }

  var FAIL_TITLES = {
    'room-not-found': 'Room not found',
    'host-left': 'The host left the game',
    closed: 'The host closed the room',
    removed: 'You were removed from the room',
    'signaling-unreachable': 'Can’t reach the signaling server',
    'ice-failed': 'Couldn’t connect to the host’s device',
    timeout: 'Couldn’t connect',
    'webrtc-unsupported': 'This browser can’t join rooms',
    version: 'Please reload',
    replaced: 'You joined from another tab',
  };
  // Errors that are best fixed on the join form (wrong code, name in use, ...).
  var FIX_ON_FORM = ['room-not-found', 'name-taken', 'bad-name', 'started', 'full'];

  function renderPlayer() {
    var j = joined;
    if (!j) return;
    if (j.status === 'failed') {
      var d = j.detail || {};
      if (FIX_ON_FORM.indexOf(d.code) !== -1 && !j.view) {
        var code = j.code;
        var msg = d.message || 'Couldn’t join.';
        leaveRoom();
        goToJoin(code, msg);
        return;
      }
      banner('');
      showWait({ title: FAIL_TITLES[d.code] || 'Disconnected', sub: d.message || '', spinner: false, actions: true });
      return;
    }
    if (j.status === 'waiting') {
      // Not in yet, and the host doesn't answer: usually its screen is off or the
      // game is in the background. Keep trying (Room.createPlayer, ~3 minutes).
      banner('');
      var own = d0(j).code === 'signaling-unreachable';
      // The host answered but no network path between the two devices worked:
      // not a sleeping host, so say what it really is.
      var ice = d0(j).code === 'ice-failed';
      var info = j.ctl.info();
      showWait({
        meta: 'Room ' + j.code + ' · ' + j.name,
        title: own ? 'Can’t reach the connection server' : ice ? 'Couldn’t connect to the host’s device' : 'Waiting for the host’s screen to come back…',
        sub: own ? 'Check this phone’s internet connection (Wi-Fi or mobile data). Still trying…'
          : ice ? (d0(j).message || Transport.MESSAGES['ice-failed']) + ' Still trying' + (info.relay ? ' (through a relay server this time)…' : '…')
          : 'Ask the host to open the game on their device and keep the screen on. You’ll join as soon as it’s back. (Wrong code? Leave and check it.)',
        spinner: true,
        actions: true,
        retry: false,
        leave: true,
        notYou: j.auto,
      });
      return;
    }
    if (j.status === 'connecting' || !j.view) {
      banner('');
      showWait({
        meta: 'Room ' + j.code + (j.auto ? ' · ' + j.name : ''),
        title: j.auto ? 'Rejoining…' : 'Joining…',
        sub: TRANSPORT_KIND === 'local' ? 'Same-browser test mode.' : 'Connecting to the host’s device.',
        spinner: true,
        notYou: j.auto,
      });
      return;
    }
    banner('');
    var v = j.view;
    if (j.status === 'reconnecting') {
      // The host's screen went off, its page reloaded, or a network blip: the
      // game continues where it left off when it's back. Retrying for as long as it takes.
      showWait({
        meta: 'Room ' + j.code,
        title: 'Reconnecting to the host…',
        sub: d0(j).code === 'ice-failed' ? (d0(j).message || Transport.MESSAGES['ice-failed']) + ' The game continues where it left off.'
          : 'If the host’s screen turned off or the game went to the background, ask them to open it again. The game continues where it left off.',
        spinner: true,
        actions: true,
        retry: false,
        leave: true,
      });
      return;
    }

    var screen = Room.playerScreen(v);
    // Song numbers restart with "play again": rebuild the answer area next turn.
    if (screen !== 'turn') j.optionsKey = '';
    var active = v.turn ? v.players.map(function (p) { return p.id; }).indexOf(v.turn.playerId) : -1;
    drawScoreboard(v.players.map(function (p) {
      return { name: p.name + (v.you && p.id === v.you.id ? ' (you)' : ''), score: p.score, offline: !p.online && !p.local };
    }), v.phase === 'over' ? -1 : active);

    if (screen === 'lobby') {
      var names = v.players.map(function (p) { return p.name; });
      showWait({
        meta: 'Room ' + v.code + (v.source ? ' · ' + v.source.name : ''),
        title: 'You’re in, ' + v.you.name + '!',
        sub: 'Waiting for the host to start the game. ' + names.length + ' player' + (names.length === 1 ? '' : 's') + ' here.',
        spinner: true,
        notYou: j.auto,
      });
    } else if (screen === 'waiting') {
      var t = v.turn;
      showWait({
        meta: turnMeta(t),
        title: 'It’s ' + t.playerName + '’s turn',
        sub: t.playerLocal ? t.playerName + ' is playing on the host’s device.'
          : t.playerOnline ? (phoneHears() ? 'Listen along! The clip plays on this phone too.' : 'Listen along! The music plays on the host’s device.')
          : t.playerName + ' is offline. The host can skip their turn.',
        spinner: false,
        clip: true,
      });
    } else if (screen === 'turn') {
      renderPlayerTurn(v);
    } else if (screen === 'result') {
      renderPlayerResult(v);
    } else if (screen === 'over') {
      renderPlayerOver(v);
    }
    renderPlayerPlayback();
  }

  function turnMeta(t) {
    return (t.rounds ? 'Round ' + t.round + ' of ' + t.rounds : 'Round ' + t.round) + ' · Song ' + t.song + ' of ' + t.songs;
  }

  function d0(j) { return j.detail || {}; }

  function showWait(o) {
    showScreen('pwait');
    $('pw-meta').textContent = o.meta || '';
    $('pw-title').textContent = o.title || '';
    $('pw-sub').textContent = o.sub || '';
    $('pw-spinner').hidden = !o.spinner;
    $('pw-clip').hidden = !o.clip;
    $('pw-actions').hidden = !o.actions;
    $('pw-retry').hidden = o.retry === false;
    $('pw-setup').textContent = o.leave ? 'Leave' : 'Back to setup';
    $('pw-notyou').hidden = !o.notYou;
  }

  function renderPlayerTurn(v) {
    var t = v.turn;
    var j = joined;
    showScreen('pturn');
    $('pt-meta').textContent = turnMeta(t);
    var key = t.song + ':' + t.playerId;
    if (j.optionsKey !== key) {
      // A new song: build the answer area once (keeps typed text across updates).
      j.optionsKey = key;
      var choice = $('pt-choice');
      choice.textContent = '';
      (t.options || []).forEach(function (o) {
        var b = el('button', { type: 'button', class: 'option', 'data-option': o.id }, [
          el('span', { class: 'o-title', text: o.title }),
          el('span', { class: 'o-artist', text: o.artist }),
        ]);
        b.addEventListener('click', function () {
          if (j.pending) return;
          if (j.ctl.act('answer', { optionId: o.id })) {
            j.pending = true;
            b.classList.add('chosen');
            renderPlayerTurnControls();
          }
        });
        choice.appendChild(b);
      });
      $('pt-free-input').value = '';
    }
    $('pt-choice').hidden = t.answerType !== 'choice';
    $('pt-free').hidden = t.answerType !== 'free';
    var notice = !t.playedOnce && (!j.playback || j.playback.status === 'idle')
      ? (phoneHears() ? 'Tap play: the song plays on every phone, this one included. Guess here.' : 'Tap play: the song plays on the host’s device. Guess on this phone.') : '';
    $('pt-notice').textContent = notice;
    $('pt-notice').hidden = !notice;
    renderPlayerTurnControls();
  }

  function renderPlayerTurnControls() {
    var j = joined;
    if (!j || !j.view || !j.view.turn) return;
    var t = j.view.turn;
    var pb = j.playback || {};
    var busy = pb.status === 'playing' || pb.status === 'loading';
    var c = clip();
    fillClipText($('screen-pturn'), c);
    renderClipSplit('pt-', c);
    $('pt-seg-long').classList.toggle('locked', !t.extended);
    $('pt-extend').hidden = t.extended || !c.extendMs; // no extra time in this game: no button
    $('pt-extend').disabled = t.extended || !t.playedOnce || busy || j.pending || !c.extendMs;
    $('pt-worth').textContent = '';
    $('pt-worth').appendChild(document.createTextNode('Worth '));
    $('pt-worth').appendChild(el('strong', { text: String(t.worth) }));
    $('pt-worth').appendChild(document.createTextNode(' points'));
    $('pt-play').disabled = j.pending;
    var where = phoneHears() ? ' on every device' : ' on the host’s device';
    $('pt-play').setAttribute('aria-label', busy || localBusy(j) ? 'Stop the song' + where
      : 'Play the first ' + secondsText(t.extended ? clipTotal() : clipFirst()) + where);
    $('pt-reveal').disabled = j.pending;
    $('pt-choice').querySelectorAll('.option').forEach(function (b) { b.disabled = j.pending; });
    $('pt-free').querySelectorAll('input, button').forEach(function (x) { x.disabled = j.pending; });
  }

  /** Does this phone play the clips itself (sound on every device, and it can)? */
  function phoneHears() {
    var m = phoneSoundMode();
    return m === 'preview' || (m === 'spotify' && phoneSpotifyReady());
  }

  /** Is this phone playing its own copy of the clip right now? */
  function localBusy(j) {
    var le = phoneEngine(j);
    return !!(le && le.playing);
  }

  // Clip progress on the phone: from its own player while it plays the clip
  // itself (sound on every device); otherwise the host sends status changes
  // and a position a few times a second, and in between the bar advances on
  // the phone's clock.
  var pbRaf = 0;
  function renderPlayerPlayback() {
    cancelAnimationFrame(pbRaf);
    renderPhoneSound();
    var j = joined;
    if (!j || !j.view || !j.view.turn) return;
    var mine = currentScreen === 'pturn';
    if (!mine && currentScreen !== 'pwait') return;
    var t = j.view.turn;
    var pb = j.playback || { status: 'idle', pos: 0, heard: 0 };
    var here = localBusy(j);
    var lp = here ? j.localPlay.msg : null;
    var busy = pb.status === 'playing' || pb.status === 'loading' || here;
    var cap = t.extended ? clipTotal() : clipFirst();
    var pre = mine ? 'pt-' : 'pw-';
    var shown = pb.status === 'playing' || pb.status === 'loading' ? pb.pos : pb.heard || 0;
    if (pb.status === 'playing' && j.playbackAt) {
      shown = Math.min(pb.to || cap, pb.pos + (now() - j.playbackAt) / 1000);
    }
    var hereStarting = false;
    if (here) {
      var le = phoneEngine(j);
      hereStarting = le.kind === 'preview' ? le.audio.paused : clockNow() < lp.localAt;
      shown = Math.max(lp.from, Math.min(lp.to, lp.from + (le.positionMs() - lp.startMs) / 1000));
    }
    var short = Math.min(shown, clipFirst()) / clipFirst();
    var long = clipExtend() ? Math.max(0, Math.min(shown, clipTotal()) - clipFirst()) / clipExtend() : 0;
    renderClipSplit(pre, clip());
    $(pre + 'fill-short').style.width = (short * 100).toFixed(2) + '%';
    $(pre + 'fill-long').style.width = (long * 100).toFixed(2) + '%';
    $(pre + 'seg-long').classList.toggle('locked', !t.extended);
    $(pre + 'time').textContent = Math.min(shown, clipTotal()).toFixed(1) + 's';
    var extPart = clipExtend() > 0 && (here ? lp.from : pb.from) >= clipFirst() - 0.01;
    var status = here ? (hereStarting ? 'Starting…' : extPart ? 'Playing seconds ' + secs(clipFirst()) + '–' + secs(clipTotal()) : 'Playing on this phone…')
      : pb.status === 'loading' ? 'Loading on the host…'
      : pb.status === 'playing' ? (extPart ? 'Playing seconds ' + secs(clipFirst()) + '–' + secs(clipTotal()) : 'Playing on the host…')
      : pb.status === 'blocked' || pb.status === 'error' ? (pb.message || 'The song couldn’t be played.')
      : !t.playedOnce ? (mine ? 'Tap play to hear ' + secondsText(clipFirst()) : 'Waiting for the song…')
      : mine ? (t.extended ? 'Tap play to hear all ' + secs(clipTotal()) + ' seconds again' : 'Clip finished. Tap play to hear it again')
      : 'Clip finished';
    $(pre + 'status').textContent = status;
    if (mine) {
      var btn = $('pt-play');
      btn.classList.toggle('playing', busy);
      btn.classList.toggle('loading', pb.status === 'loading' || hereStarting);
      renderPlayerTurnControls();
    }
    if (pb.status === 'playing' || here) pbRaf = requestAnimationFrame(renderPlayerPlayback);
  }

  function onPlayerPlayClick() {
    var j = joined;
    if (!j || j.pending) return;
    unlockAudio(); // this tap lets the clip the host sends back make sound here
    var pb = j.playback || {};
    var busy = pb.status === 'playing' || pb.status === 'loading' || localBusy(j);
    if (!j.ctl.act(busy ? 'stop' : 'play')) toast('Not connected to the host right now.');
  }

  function onPlayerExtendClick() {
    unlockAudio();
    if (joined && !joined.ctl.act('extend')) toast('Not connected to the host right now.');
  }

  function onPlayerFreeSubmit(e) {
    e.preventDefault();
    var j = joined;
    if (!j || j.pending) return;
    var text = $('pt-free-input').value.trim();
    if (!text) { $('pt-free-input').focus(); toast('Type a song title first (or reveal the answer).'); return; }
    if (j.ctl.act('answer', { text: text })) { j.pending = true; renderPlayerTurnControls(); }
    else toast('Not connected to the host right now.');
  }

  function onPlayerRevealClick() {
    var j = joined;
    if (!j || j.pending) return;
    if (j.ctl.act('reveal')) { j.pending = true; renderPlayerTurnControls(); }
    else toast('Not connected to the host right now.');
  }

  function renderPlayerResult(v) {
    var r = v.result;
    var t = v.turn;
    showScreen('result');
    var mine = t.yours;
    var who = mine ? 'You' : t.playerName;
    $('verdict').className = 'verdict ' + r.outcome;
    $('verdict-title').textContent = {
      correct: (r.match === 'close' ? 'Close enough! +' : 'Correct! +') + r.points,
      wrong: 'Not quite',
      revealed: 'Answer revealed',
      skipped: 'Song skipped',
    }[r.outcome];
    var sub;
    if (r.outcome === 'correct') sub = who + (r.extended ? ' got it with the extra ' + secs(clipExtend()) + ' seconds.' : ' got it in ' + secondsText(clipFirst()) + '!');
    else if (r.outcome === 'wrong') sub = r.guess ? who + ' guessed “' + r.guess + '”. No points.' : 'No points this time.';
    else sub = (mine ? '' : t.playerName + ': ') + 'No points this time.';
    $('verdict-sub').textContent = sub;
    $('reveal-title').textContent = r.track.title;
    $('reveal-artist').textContent = r.track.artist;
    $('spotify-link').href = 'https://open.spotify.com/track/' + encodeURIComponent(r.track.id);
    var box = $('cover');
    var img = box.querySelector('img');
    if (!r.track.image) box.textContent = '♫';
    else if (!img || img.getAttribute('src') !== r.track.image) {
      var node = el('img', { alt: 'Cover art for ' + r.track.title, src: r.track.image, referrerpolicy: 'no-referrer' });
      node.addEventListener('error', function () { box.textContent = '♫'; });
      box.textContent = '';
      box.appendChild(node);
    }
    $('listen-btn').hidden = true;
    $('next-btn').hidden = !mine;
    $('next-btn').disabled = false;
    $('next-btn').textContent = t.last ? 'See final standings' : 'Next: ' + t.nextPlayerName + '’s turn';
    $('result-wait').hidden = mine;
    $('result-wait').textContent = 'Waiting for ' + t.playerName + ' (or the host) to continue…';
  }

  function renderPlayerOver(v) {
    showScreen('over');
    var st = v.over.standings;
    var list = $('standings');
    list.textContent = '';
    st.forEach(function (p) {
      list.appendChild(el('li', { class: (p.rank === 1 ? 'first' : '') + (v.you && p.id === v.you.id ? ' you' : '') }, [
        el('span', { class: 'rank', text: String(p.rank) }),
        el('div', { class: 'who' }, [
          el('div', { class: 'n', text: p.name + (v.you && p.id === v.you.id ? ' (you)' : '') }),
          el('div', { class: 'd', text: p.correct + ' correct' }),
        ]),
        el('span', { class: 'total', text: String(p.score) }),
      ]));
    });
    var tie = st.length > 1 && st[0].score === st[1].score;
    $('over-title').textContent = st.length === 1 ? 'You scored ' + st[0].score + '!'
      : tie ? 'It’s a tie!'
      : v.you && st[0].id === v.you.id ? 'You win!' : st[0].name + ' wins!';
    $('over-sub').textContent = v.over.songsPlayed + ' song' + (v.over.songsPlayed === 1 ? '' : 's') + ' played' +
      (v.source ? ' from “' + v.source.name + '”.' : '.');
    $('again-btn').parentNode.hidden = true;
    $('over-player').hidden = false;
  }

  function onLeaveClick() {
    if (joined && joined.view && joined.view.phase !== 'over' && joined.view.phase !== 'lobby' &&
        !window.confirm('Leave the room? You can rejoin later with the same name.')) return;
    goToSetup();
  }

  // ---------- Restore after reload ----------

  /**
   * On load: a hosted room is reopened with the same code (players reconnect
   * on their own), a player rejoins its room, otherwise a pass-the-phone game
   * continues (restore()).
   *   1. sessionStorage says this tab was hosting (a reload).
   *   2. The URL says so (?host=CODE): the browser reloaded a tab it had evicted,
   *      which can lose sessionStorage; the room comes from localStorage.
   *   3. The player side: Room.rejoinDecision (?room=CODE, this tab's session,
   *      or a room this device played in during the last 12 hours).
   */
  function restoreRoom() {
    var urlRoom = currentUrlRoom();
    var urlHost = currentUrlHost();
    var sess = store.get(STORE_ROOM);
    var room = sess && (!urlRoom || urlRoom === sess.code) && (!urlHost || urlHost === sess.code) ? Room.restoreRoom(sess) : null;
    if (room) { resumeRoom(room); return true; }
    if (urlHost) {
      room = Room.restoreRoom(local.getJSON(LOCAL_ROOM + urlHost), { transport: TRANSPORT_KIND });
      if (room) { resumeRoom(room); return true; }
      setUrlRoom(''); // nothing to resume: show setup
      return false;
    }
    var d = Room.rejoinDecision({
      urlCode: urlRoom,
      sessionJoin: store.get(STORE_JOIN),
      savedJoin: local.getJSON(LOCAL_JOIN),
      transport: TRANSPORT_KIND,
      now: Date.now(),
    });
    if (d.action === 'rejoin') { joinRoom(d.code, d.name, { auto: d.source === 'saved', token: d.token }); return true; }
    if (d.action === 'form') { goToJoin(d.code, '', d.name || null); return true; }
    return false;
  }

  /** Setup screen: "Resume room ABCD" (hosted here) and "Rejoin room ABCD" (played here). */
  function renderResumeOffers() {
    var box = $('resume-box');
    box.textContent = '';
    var t = Date.now();
    var entries = [];
    local.keys(LOCAL_ROOM).forEach(function (k) {
      var e = local.getJSON(k);
      // Forget rooms past the 12-hour window.
      if (!e || !(t - e.savedAt < Room.RESUME_MAX_AGE_MS)) { local.remove(k); return; }
      entries.push(e);
    });
    var best = Room.pickResumableRoom(entries, { transport: TRANSPORT_KIND, now: t });
    if (best) {
      var r = best.room;
      var g = r.game;
      var what = !g ? 'in the lobby' : 'song ' + (g.turn + 1) + (g.totalTurns ? ' of ' + g.totalTurns : '');
      var names = r.players.map(function (p) { return p.name; });
      box.appendChild(el('div', { class: 'resume-item' }, [
        el('p', null, [
          'You were hosting room ',
          el('strong', { text: r.code }),
          ' (' + what + (names.length ? ', ' + names.join(', ') : '') + ') ' + ago(best.savedAt) + '.',
        ]),
        el('div', { class: 'resume-actions' }, [
          el('button', { type: 'button', class: 'btn btn-primary', id: 'resume-room-btn', text: 'Resume room ' + r.code, onclick: function () {
            var room = Room.restoreRoom(local.getJSON(LOCAL_ROOM + r.code), { transport: TRANSPORT_KIND });
            if (!room) { toast('That room can’t be resumed any more.'); renderResumeOffers(); return; }
            resumeRoom(room);
          } }),
          el('button', { type: 'button', class: 'btn-link', text: 'Forget it', onclick: function () {
            local.remove(LOCAL_ROOM + r.code);
            renderResumeOffers();
          } }),
        ]),
      ]));
    }
    var d = Room.rejoinDecision({ urlCode: '', sessionJoin: null, savedJoin: local.getJSON(LOCAL_JOIN), transport: TRANSPORT_KIND, now: t });
    var offer = d.action === 'rejoin' ? { code: d.code, name: d.name, token: d.token } : d.offer;
    if (offer) {
      box.appendChild(el('div', { class: 'resume-item' }, [
        el('p', null, ['You played in room ', el('strong', { text: offer.code }), ' as ' + offer.name + '.']),
        el('div', { class: 'resume-actions' }, [
          el('button', { type: 'button', class: 'btn btn-primary', id: 'rejoin-room-btn', text: 'Rejoin room ' + offer.code, onclick: function () {
            joinRoom(offer.code, offer.name, { token: offer.token });
          } }),
          el('button', { type: 'button', class: 'btn-link', text: 'Forget it', onclick: function () {
            local.remove(LOCAL_JOIN);
            renderResumeOffers();
          } }),
        ]),
      ]));
    }
    box.hidden = !box.children.length;
  }

  function ago(ts) {
    var min = Math.max(0, Math.round((Date.now() - ts) / 60000));
    if (min < 1) return 'just now';
    if (min < 60) return min + ' min ago';
    var h = Math.round(min / 60);
    return h + ' hour' + (h === 1 ? '' : 's') + ' ago';
  }

  function restore() {
    var saved = store.get(STORE_GAME);
    if (!saved || saved.version !== 1 || !saved.tracks || !saved.players) return false;
    game = saved;
    if (game.phase === 'over') { enterGameOver(); return true; }
    if (!game.current) { G.startTurn(game); saveGame(); }
    if (game.phase === 'over') { enterGameOver(); return true; }
    if (game.phase === 'result' && game.current.answered) enterResult();
    else enterRound();
    return true;
  }

  // ---------- Wire up ----------

  function init() {
    $('setup-form').addEventListener('submit', function (e) {
      e.preventDefault();
      if (soundPref() === 'spotify') spCtl.activate(); // inside the tap (in-browser player)
      var exclude = !$('exclude-wrap').hidden && $('exclude-used').checked;
      startFromSetup(readSetup(), exclude);
    });
    $('add-player-btn').addEventListener('click', addPlayer);
    $('example-btn').addEventListener('click', function () {
      $('url-input').value = EXAMPLE_URL;
      refreshExcludeHint();
    });
    $('url-input').addEventListener('input', refreshExcludeHint);
    $('clip-first').addEventListener('change', renderClipSetting);
    $('clip-extra').addEventListener('change', renderClipSetting);
    // Sound: previews or full songs via Spotify.
    document.querySelectorAll('input[name="sound-on"]').forEach(function (r) {
      r.addEventListener('change', function () { if (r.checked) local.set(LOCAL_SOUND_ON, r.value === 'host' ? 'host' : 'all'); });
    });
    document.querySelectorAll('input[name="engine"]').forEach(function (r) {
      r.addEventListener('change', function () {
        if (!r.checked) return;
        setSoundPref(r.value);
        soundStatus('');
        renderSound();
        renderClipSetting();
        if (r.value === 'spotify') ensureSpotifyReady();
      });
    });
    $('sp-client-save').addEventListener('click', function () { if (onClientIdSave()) renderSound(); });
    $('sp-client-toggle').addEventListener('click', function () { clientFieldOpen = true; renderSound(); $('sp-client-id').focus(); });
    $('sp-client-default').addEventListener('click', function () {
      spAuth.setClientId('');
      clientFieldOpen = false;
      soundStatus('Using this site’s Spotify app.');
      renderSound();
    });
    $('sp-client-id').addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); onClientIdSave(); } });
    $('sp-signin').addEventListener('click', signIn);
    $('sp-signout').addEventListener('click', signOut);
    $('sp-refresh').addEventListener('click', function () { soundStatus(''); refreshDevices(); });
    $('round-device-refresh').addEventListener('click', function () { refreshDevices(); });
    $('sp-device').addEventListener('change', onDevicePicked);
    $('round-device-select').addEventListener('change', onDevicePicked);
    $('sp-test').addEventListener('click', onTestSound);
    $('auth-banner-signin').addEventListener('click', signIn);
    spCtl.onSdkStatus(function () { renderDevices(); });
    spAuth.onChange(function (ev) {
      if (ev.type === 'signed-out' && ev.reason === 'expired') {
        spReadyStarted = false;
        if (game && currentEngineName() === 'spotify') showAuthBanner();
      }
      if (currentScreen === 'setup') renderSound();
    });
    $('play-btn').addEventListener('click', onPlayClick);
    $('extend-btn').addEventListener('click', onExtendClick);
    $('answer-free').addEventListener('submit', function (e) {
      e.preventDefault();
      submit('guess', $('free-input').value);
    });
    $('reveal-btn').addEventListener('click', function () { submit('reveal'); });
    $('skip-btn').addEventListener('click', function () { submit('skip'); });
    $('next-btn').addEventListener('click', onNextClick);
    $('listen-btn').addEventListener('click', onListenClick);
    $('again-btn').addEventListener('click', onAgainClick);
    $('new-btn').addEventListener('click', function () {
      if (hosting && hosting.room.players.some(function (p) { return p.online && !p.local; }) &&
          !window.confirm('Close the room? Players will be disconnected.')) return;
      goToSetup();
    });
    $('end-game-btn').addEventListener('click', function () {
      if (!game) return;
      if (!window.confirm('End the game now and show the standings?')) return;
      if (hosting) { hostAct('end'); return; }
      player.stop();
      if (game.current && !game.current.answered) {
        // The current song was heard but not answered; it stays marked as used.
        game.current = null;
      }
      enterGameOver();
    });
    // Rooms: setup buttons, join form, lobby, player screens.
    $('host-btn').addEventListener('click', function () {
      if (soundPref() === 'spotify') spCtl.activate();
      var exclude = !$('exclude-wrap').hidden && $('exclude-used').checked;
      hostFromSetup(readSetup(), exclude);
    });
    $('join-btn').addEventListener('click', function () { goToJoin(''); });
    $('join-form').addEventListener('submit', onJoinSubmit);
    $('join-code').addEventListener('input', function () {
      var c = $('join-code');
      var v = c.value.toUpperCase().replace(/[^A-Z]/g, '');
      if (v !== c.value) c.value = v;
    });
    $('join-back').addEventListener('click', goToSetup);
    $('copy-link-btn').addEventListener('click', onCopyLink);
    $('lobby-link').addEventListener('focus', function () { this.select(); });
    $('local-form').addEventListener('submit', function (e) {
      e.preventDefault();
      if (!hosting) return;
      var res = hosting.ctl.addLocalPlayer($('local-name').value);
      if (!res.ok) { lobbyError(res.message); return; }
      lobbyError('');
      $('local-name').value = '';
    });
    $('lobby-start').addEventListener('click', onLobbyStart);
    $('lobby-close').addEventListener('click', function () {
      if (hosting && hosting.room.players.some(function (p) { return p.online && !p.local; }) &&
          !window.confirm('Close the room? Players will be disconnected.')) return;
      goToSetup();
    });
    // Sound on the phones: "Tap to enable sound", full songs via Spotify on this phone.
    $('p-sound-enable').addEventListener('click', onEnableSound);
    $('p-sp-signin').addEventListener('click', signIn);
    $('p-sp-device').addEventListener('change', onDevicePicked);
    $('p-sp-refresh').addEventListener('click', function () { if (!spReadyStarted) ensureSpotifyReady(); else refreshDevices(); });
    // Any tap on a phone in a room allows its sound (clips arrive later without a tap).
    ['click', 'keydown'].forEach(function (type) {
      document.addEventListener(type, function () { if (joined && !previewEngine.unlocked && !previewEngine.playing) unlockAudio(); }, true);
    });
    $('diag').addEventListener('toggle', refreshDiag);
    $('diag-copy').addEventListener('click', onDiagCopy);
    if (DEBUG_LEVEL) $('diag').open = true;
    $('pt-play').addEventListener('click', onPlayerPlayClick);
    $('pt-extend').addEventListener('click', onPlayerExtendClick);
    $('pt-free').addEventListener('submit', onPlayerFreeSubmit);
    $('pt-reveal').addEventListener('click', onPlayerRevealClick);
    $('pw-retry').addEventListener('click', function () {
      if (!joined) return;
      joined.ctl.retry();
    });
    $('pw-setup').addEventListener('click', function (e) { e.preventDefault(); goToSetup(); });
    $('pw-notyou').addEventListener('click', function () {
      if (!joined) return;
      var code = joined.code;
      goToJoin(code, '', ''); // leaves the room (the saved one is kept, marked "left")
      $('join-name').focus();
    });
    $('leave-room-btn').addEventListener('click', onLeaveClick);
    $('over-leave-btn').addEventListener('click', goToSetup);

    window.addEventListener('pagehide', function () {
      player.stop();
      // Close connections now so the others notice at once. The saved room /
      // join info stays, so a reload reconnects.
      if (hosting && hosting.transport) hosting.transport.close();
      if (joined) joined.ctl.leave();
    });
    window.addEventListener('pageshow', function (e) {
      if (!e.persisted) { onWake('pageshow'); return; }
      // Back/forward cache: pagehide closed the connections, start over.
      if (hosting) { hosting.attempts = 0; connectHost(); }
      if (joined) joined.ctl.retry();
    });
    // Mobile browsers freeze background tabs and drop their connections. Coming
    // back (or getting the network back), check and reconnect at once.
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') onWake('visible');
      else hiddenAt = Date.now();
    });
    window.addEventListener('focus', function () { onWake('focus'); });
    window.addEventListener('online', function () { onWake('online'); });
    window.addEventListener('offline', function () { renderHostConn(); });
    // Another tab resumed the room this tab hosts: the newer one wins.
    window.addEventListener('storage', function (e) {
      if (!hosting || !e.key || e.key !== LOCAL_ROOM + hosting.room.code || !e.newValue) return;
      var other;
      try { other = JSON.parse(e.newValue); } catch (x) { return; }
      if (other && other.owner && other.owner !== TAB_ID && other.claimedAt > hosting.claimedAt) yieldRoom();
    });
    document.addEventListener('keydown', function (e) {
      if (!game || game.phase !== 'round') return;
      if (e.target && /input|textarea|select/i.test(e.target.tagName)) return;
      if (e.key === ' ' || e.key === 'k') { e.preventDefault(); onPlayClick(); }
    });

    var restored = false;
    try { restored = restoreRoom() || restore(); } catch (e) { if (window.console) console.error(e); }
    if (!restored) goToSetup();
    if (spRedirect) finishSignIn(spRedirect);
  }

  init();
})();
