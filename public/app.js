/*
 * Guess the Song: browser controller (screens, audio, persistence).
 * Three ways to use a device: pass-the-phone (one device, the original game),
 * room host (this device is the "TV": it plays the audio and runs the game;
 * see lib/room.js) and room player (a phone that answers; no audio).
 */
(function () {
  'use strict';

  var G = window.GameLogic;
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
  var MAX_PLAYERS = 12;
  var Room = window.Room;
  var Transport = window.Transport;
  // ?transport=local: rooms between tabs of this browser (BroadcastChannel) instead of PeerJS.
  var TRANSPORT_KIND = Transport.kindFromSearch(window.location.search);

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

  /**
   * Plays a [start, end) segment of an audio URL and stops precisely at `end`.
   * Stopping uses three mechanisms: a requestAnimationFrame poll (tight, ~16ms),
   * the media `timeupdate` event, and a setTimeout safety net (background tabs).
   */
  function ClipPlayer(hooks) {
    this.hooks = hooks;
    this.audio = new Audio();
    this.audio.preload = 'auto';
    this.segEnd = 0;
    this.playing = false;
    this.raf = 0;
    this.safety = 0;
    this.token = 0;
    var self = this;
    this.audio.addEventListener('timeupdate', function () { self._check(); });
    this.audio.addEventListener('playing', function () {
      if (self.priming) return;
      self.hooks.onState('playing');
      self._armSafety();
    });
    this.audio.addEventListener('waiting', function () { if (self.playing) self.hooks.onState('loading'); });
    this.audio.addEventListener('ended', function () { if (self.playing) self.stop(); });
    this.audio.addEventListener('error', function () {
      if (!self.audio.getAttribute('src')) return;
      self.stop();
      self.hooks.onError('This song’s preview could not be loaded.');
    });
  }
  ClipPlayer.prototype.load = function (url) {
    this.stop();
    this.audio.src = url;
    this.audio.load();
  };
  ClipPlayer.prototype.unload = function () {
    this.stop();
    this.audio.removeAttribute('src');
    this.audio.load();
  };
  /**
   * Room host: the audio is started by messages from phones, outside any tap
   * on this device. Play the element once, muted, inside a real tap (e.g.
   * "Start game") so browsers that need a gesture per element (iOS) allow it.
   */
  ClipPlayer.prototype.prime = function () {
    var self = this;
    var a = this.audio;
    if (this.primed || this.playing || !a.getAttribute('src')) return;
    this.primed = true;
    this.priming = true;
    a.muted = true;
    var done = function () {
      if (!self.priming) return;
      self.priming = false;
      if (!self.playing && !a.paused) a.pause();
      try { if (!self.playing && a.readyState >= 1) a.currentTime = 0; } catch (e) { /* ignore */ }
      a.muted = false;
    };
    var p;
    try { p = a.play(); } catch (e) { p = null; }
    if (p && p.then) p.then(done, done); else done();
  };
  /**
   * Play [start, end) seconds. With `offsetFn`, start/end are relative to the
   * clip's start offset, which is only final once the preview's duration is
   * known (see clipOffset); if the metadata hasn't loaded yet, the segment is
   * placed when it arrives, so every play of a song uses the same offset.
   */
  ClipPlayer.prototype.play = function (start, end, offsetFn) {
    var self = this;
    var a = this.audio;
    if (this.priming) { this.priming = false; a.muted = false; }
    this.stop();
    var token = ++this.token;
    var place = function () {
      var off = offsetFn ? offsetFn() : 0;
      self.segStart = start + off;
      self.segEnd = end + off;
    };
    place();
    this.playing = true;
    this.hooks.onState('loading');
    if (a.readyState >= 1) {
      try { a.currentTime = this.segStart; } catch (e) { /* ignore */ }
    } else if (this.segStart > 0 || offsetFn) {
      a.addEventListener('loadedmetadata', function onMeta() {
        a.removeEventListener('loadedmetadata', onMeta);
        if (token !== self.token || !self.playing) return;
        place();
        try { a.currentTime = self.segStart; } catch (e) { /* ignore */ }
        self._armSafety();
      });
    }
    // play() is called synchronously inside the click handler (required on iOS).
    var p = a.play();
    if (p && p.catch) {
      p.catch(function (err) {
        if (token !== self.token) return;
        self.stop();
        if (err && err.name === 'AbortError') return;
        self.hooks.onError(err && err.name === 'NotAllowedError'
          ? 'Your browser blocked audio playback. Tap play again.'
          : 'This song’s preview could not be played.');
      });
    }
    var loop = function () {
      if (token !== self.token || !self.playing) return;
      self._check();
      self.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  };
  ClipPlayer.prototype._armSafety = function () {
    var self = this;
    clearTimeout(this.safety);
    if (!this.playing) return;
    var remaining = Math.max(0, this.segEnd - this.audio.currentTime);
    var token = this.token;
    // The media clock can lag wall time slightly, so when the timer fires we
    // re-check the position and re-arm instead of cutting the clip short.
    this.safety = setTimeout(function () {
      if (token !== self.token || !self.playing) return;
      if (self.audio.currentTime >= self.segEnd - 0.005 || self.audio.ended) self.stop();
      else self._armSafety();
    }, Math.max(20, remaining * 1000 + 20));
  };
  ClipPlayer.prototype._check = function () {
    if (!this.playing) return;
    var t = this.audio.currentTime;
    if (t >= this.segEnd) {
      this.stop();
      return;
    }
    this.hooks.onProgress(t);
  };
  ClipPlayer.prototype.stop = function () {
    var wasPlaying = this.playing;
    this.playing = false;
    this.token++;
    cancelAnimationFrame(this.raf);
    clearTimeout(this.safety);
    var a = this.audio;
    if (!a.paused) a.pause();
    if (wasPlaying) {
      this.hooks.onProgress(Math.min(this.segEnd, a.currentTime || 0));
      try { if (a.readyState >= 1) a.currentTime = 0; } catch (e) { /* ignore */ }
      this.hooks.onState('stopped');
    }
  };

  // ---------- App state ----------

  var game = null;
  var turnUi = { heard: 0, playedOnce: false, audioError: false };

  /**
   * Where the current song's clip actually starts, in seconds into the preview.
   * Fitted to the preview's real duration once it is known (see
   * GameLogic.clampClipStart); until then the stored offset is used as-is.
   */
  function clipOffset() {
    if (!game || !game.current) return 0;
    return G.clampClipStart(game.current.clipStart, player.audio.duration);
  }

  var player = new ClipPlayer({
    onProgress: function (t) {
      // Result-screen preview: a phone's Next can stop it after the next turn began.
      if (!game || game.phase !== 'round' || resultMode === 'listen') return;
      renderProgress(t - clipOffset());
      if (player.playing) reportPlayback('playing');
    },
    onState: function (s) {
      var listening = resultMode === 'listen'; // onPlayerState clears it on 'stopped'
      onPlayerState(s);
      if (!listening) reportPlayback(s);
    },
    onError: function (msg) {
      if (!game || game.phase !== 'round') { toast(msg); return; }
      turnUi.audioError = true;
      var blocked = /blocked/.test(msg);
      showNotice(blocked && hosting ? 'This browser blocked the sound. Tap play on this screen once to allow it.'
        : msg + ' You can skip it (no points) or reveal the answer.');
      $('skip-btn').hidden = false;
      reportPlayback(blocked ? 'blocked' : 'error', blocked ? 'The host’s browser blocked the sound. Ask the host to tap play on their screen.' : msg);
    },
  });
  var resultMode = null; // 'listen' when the result-screen preview is playing

  function saveGame() {
    if (hosting) { store.set(STORE_ROOM, hosting.room); return; }
    if (game) store.set(STORE_GAME, game);
    else store.remove(STORE_GAME);
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
    };
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
    showScreen('setup');
  }

  /**
   * Load the songs for a setup and work out which are fresh. Shows the loading
   * screen; on failure returns to setup with an error and resolves to null.
   */
  async function loadSongs(setup, excludeUsed) {
    setupError('');
    if (!setup.url) { setupError('Paste a Spotify playlist, album or track link to start.'); $('url-input').focus(); return null; }
    store.set(STORE_SETUP, setup);
    $('loading-text').textContent = tracksSource.isExample(setup.url)
      ? 'Loading the example playlist…'
      : tracksSource.mode() === 'static'
      ? 'Loading songs from Spotify through a public proxy…'
      : 'Loading songs from Spotify…';
    showScreen('loading');

    var data;
    try {
      data = await tracksSource.loadTracks(setup.url);
    } catch (err) {
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
    if (data.skipped) notes.push(data.skipped + ' song' + (data.skipped === 1 ? '' : 's') + ' without a preview were skipped.');
    if (used.length) notes.push('Skipping ' + (data.tracks.length - fresh.length) + ' song(s) you already heard.');
    return {
      mode: mode,
      tracks: data.tracks,
      used: used,
      notes: notes,
      source: { type: data.source.type, name: data.source.name, image: data.source.image, key: key },
    };
  }

  async function startFromSetup(setup, excludeUsed) {
    var songs = await loadSongs(setup, excludeUsed);
    if (!songs) return;
    game = G.createGame({
      players: setup.players,
      mode: songs.mode,
      rounds: setup.rounds,
      clipStartMode: setup.clipStart === 'random' ? 'random' : 'beginning',
      tracks: songs.tracks,
      usedIds: songs.used,
      source: songs.source,
      sourceUrl: setup.url,
    });
    game.notes = songs.notes;
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
      heard: cur.extended ? G.CLIP_SHORT : roomTurn ? roomTurn.heard : 0,
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

    renderExtendState();
    renderProgress(turnUi.heard);
    onPlayerState('stopped');
    player.load(track.previewUrl);
  }

  function renderExtendState() {
    var cur = game.current;
    $('seg-long').classList.toggle('locked', !cur.extended);
    $('extend-btn').disabled = cur.extended || !turnUi.playedOnce;
    $('extend-btn').hidden = cur.extended;
    $('worth').textContent = '';
    $('worth').appendChild(document.createTextNode('Worth '));
    $('worth').appendChild(el('strong', { text: String(cur.extended ? G.POINTS.extended : G.POINTS.short) }));
    $('worth').appendChild(document.createTextNode(' points'));
    $('play-btn').setAttribute('aria-label', cur.extended ? 'Play the first 15 seconds' : 'Play the first 5 seconds');
  }

  function renderProgress(t) {
    if (!game || !game.current) return;
    var cur = game.current;
    turnUi.heard = Math.max(turnUi.heard, Math.min(t, cur.extended ? G.CLIP_LONG : G.CLIP_SHORT));
    var shown = player.playing ? t : turnUi.heard;
    var short = Math.min(shown, G.CLIP_SHORT) / G.CLIP_SHORT;
    var long = Math.max(0, Math.min(shown, G.CLIP_LONG) - G.CLIP_SHORT) / (G.CLIP_LONG - G.CLIP_SHORT);
    $('fill-short').style.width = (short * 100).toFixed(2) + '%';
    $('fill-long').style.width = (long * 100).toFixed(2) + '%';
    $('clip-time').textContent = Math.min(shown, G.CLIP_LONG).toFixed(1) + 's';
  }

  function onPlayerState(s) {
    var btn = $('play-btn');
    if (resultMode === 'listen') {
      $('listen-btn').textContent = s === 'stopped' ? 'Listen to the preview' : 'Stop';
      if (s === 'stopped') resultMode = null;
      return;
    }
    if (!game || game.phase !== 'round') return;
    btn.classList.toggle('playing', s === 'playing' || s === 'loading');
    btn.classList.toggle('loading', s === 'loading');
    var cur = game.current;
    var status = $('clip-status');
    var playingExtension = cur.extended && Math.round(player.segStart - clipOffset()) > 0;
    if (s === 'loading') status.textContent = 'Loading…';
    else if (s === 'playing') status.textContent = playingExtension ? 'Playing seconds 5–15' : 'Playing…';
    else {
      if (turnUi.heard > 0) turnUi.playedOnce = true;
      status.textContent = !turnUi.playedOnce
        ? 'Tap play to hear 5 seconds'
        : cur.extended ? 'Tap play to hear all 15 seconds again' : 'Tap play to hear it again';
      renderExtendState();
      renderProgress(turnUi.heard);
    }
  }

  // After a load/play error the media element must be reloaded before it can play again.
  function reloadAfterError() {
    if (!turnUi.audioError) return;
    turnUi.audioError = false;
    showNotice('');
    player.load(currentTrack().previewUrl);
  }

  function onPlayClick() {
    if (hosting) {
      // Host fallback (or a player on this device): the same actions a phone sends.
      if (player.playing) { hostAct('stop'); return; }
      reloadAfterError();
      hostAct('play');
      return;
    }
    if (player.playing) { player.stop(); return; }
    var cur = game.current;
    reloadAfterError();
    turnUi.heard = 0;
    player.play(0, cur.extended ? G.CLIP_LONG : G.CLIP_SHORT, clipOffset);
  }

  function onExtendClick() {
    var cur = game.current;
    if (cur.extended || cur.answered) return;
    if (hosting) { hostAct('extend'); return; }
    cur.extended = true;
    saveGame();
    renderExtendState();
    reloadAfterError();
    turnUi.heard = G.CLIP_SHORT;
    player.play(G.CLIP_SHORT, G.CLIP_LONG, clipOffset);
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
    var title = { correct: 'Correct! +' + cur.points, wrong: 'Not quite', revealed: 'Answer revealed', skipped: 'Song skipped' }[cur.outcome];
    $('verdict-title').textContent = title;
    var sub = '';
    if (cur.outcome === 'correct') sub = name + (cur.extended ? ' got it with the extra 10 seconds.' : ' got it in 5 seconds!');
    else if (cur.outcome === 'wrong') sub = cur.guess ? name + ' guessed “' + cur.guess + '”. No points.' : 'No points this time.';
    else sub = 'No points this time.';
    $('verdict-sub').textContent = sub;

    $('reveal-title').textContent = track.title;
    $('reveal-artist').textContent = track.artist;
    $('spotify-link').href = 'https://open.spotify.com/track/' + encodeURIComponent(track.id);
    setCover(track);

    $('listen-btn').hidden = false;
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
    $('listen-btn').textContent = 'Stop';
    var d = player.audio.duration;
    player.play(0, isFinite(d) && d > 0 ? d : 30);
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

  function transportOptions() {
    var cfg = window.GTS_CONFIG || {};
    return { peerOptions: cfg.PEERJS || undefined };
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
      settings: { mode: songs.mode, rounds: setup.rounds, clipStart: setup.clipStart, sourceUrl: setup.url },
      source: songs.source,
      tracks: songs.tracks,
      usedIds: songs.used,
      notes: songs.notes,
    });
    store.remove(STORE_GAME);
    openRoom(room, true);
  }

  /** Start hosting `room` (new, or restored after a reload). */
  function openRoom(room, fresh) {
    closeRoom();
    leaveRoom();
    hosting = { room: room, ctl: null, transport: null, status: 'connecting', error: null, attempts: 0, fresh: fresh };
    game = room.game;
    saveGame();
    connectHost();
    showHostScreen();
    keepAwake(true);
  }

  function connectHost() {
    var h = hosting;
    if (!h) return;
    if (h.transport) { try { h.transport.close(); } catch (e) { /* ignore */ } }
    var t = Transport.create(TRANSPORT_KIND, transportOptions());
    h.transport = t;
    h.status = h.attempts ? 'retrying' : 'connecting';
    h.ctl = Room.createHost({
      room: h.room,
      transport: t,
      hooks: { onEffect: onRoomEffect, onChange: onRoomChange },
    });
    t.onError(function (err) {
      if (hosting !== h || h.transport !== t) return;
      toast(err.code === 'signaling-unreachable'
        ? 'Lost the PeerJS signaling server. Players already in the room can keep playing; new players can’t join until it’s back.'
        : err.message, 6000);
    });
    renderHostConn();
    t.host(h.room.code).then(function () {
      if (hosting !== h || h.transport !== t) { t.close(); return; }
      h.status = 'open';
      h.error = null;
      h.attempts = 0;
      renderHostConn();
      h.ctl.broadcast();
    }, function (err) {
      if (hosting !== h || h.transport !== t) return;
      if (err.code === 'room-taken') {
        if (!h.room.game && !h.room.players.some(function (p) { return !p.local; }) && h.attempts < 5) {
          // A brand-new room: just pick another code.
          h.attempts++;
          h.room.code = Room.generateCode();
          saveGame();
          showHostScreen();
          connectHost();
          return;
        }
        // Restoring after a reload: the old page's registration can linger briefly.
        if (h.attempts < 8) {
          h.attempts++;
          h.status = 'retrying';
          renderHostConn();
          setTimeout(function () { if (hosting === h && h.transport === t) connectHost(); }, 2500);
          return;
        }
      }
      h.status = 'error';
      h.error = err;
      renderHostConn();
    });
  }

  /** Stop hosting. Players are told the room closed (unless the page is just reloading). */
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
    banner('');
    keepAwake(false);
  }

  function renderHostConn() {
    var h = hosting;
    if (!h) return;
    var msg = '';
    var bad = false;
    var peerNote = TRANSPORT_KIND === 'local' ? ' (same-browser test mode)' : '';
    if (h.status === 'connecting') msg = 'Opening room ' + h.room.code + peerNote + '…';
    else if (h.status === 'retrying') msg = 'Reopening room ' + h.room.code + '… Players will reconnect automatically.';
    else if (h.status === 'error') { msg = (h.error && h.error.message ? h.error.message : 'Couldn’t open the room.') + ' Tap “Try again”.'; bad = true; }
    // Lobby: inline notice with a retry button. In game: the banner.
    var lc = $('lobby-conn');
    lc.textContent = '';
    if (msg) {
      lc.appendChild(document.createTextNode(msg + ' '));
      if (h.status === 'error') lc.appendChild(el('button', { type: 'button', class: 'btn-link', id: 'host-retry', text: 'Try again', onclick: function () { h.attempts = 0; connectHost(); } }));
    }
    lc.hidden = !msg;
    lc.classList.toggle('bad', bad);
    if (h.room.game) {
      banner(msg, bad);
      if (h.status === 'error') {
        var b = $('conn-banner');
        b.appendChild(document.createTextNode(' '));
        b.appendChild(el('button', { type: 'button', class: 'btn-link', text: 'Try again', onclick: function () { h.attempts = 0; connectHost(); } }));
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
      (s.clipStart === 'random' ? 'random spot' : 'from the beginning');
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
      turnUi.heard = effect.extend ? G.CLIP_SHORT : 0;
      player.play(effect.from, effect.to, clipOffset);
    } else if (effect.type === 'stop' || effect.type === 'answered' || effect.type === 'over' || effect.type === 'next') {
      player.stop();
    }
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
      pos: playing ? Math.max(0, (player.audio.currentTime || 0) - off) : turnUi.heard,
      from: playing ? player.segStart - off : 0,
      to: playing ? player.segEnd - off : 0,
      message: msg || '',
    });
  }

  // Screen wake lock: a sleeping host (or phone) drops out of the room.
  var wakeLock = null;
  var wantAwake = false;
  function keepAwake(on) {
    wantAwake = on;
    if (!on) {
      if (wakeLock) { try { wakeLock.release(); } catch (e) { /* ignore */ } }
      wakeLock = null;
      return;
    }
    if (wakeLock || !navigator.wakeLock || document.visibilityState !== 'visible') return;
    navigator.wakeLock.request('screen').then(function (lock) {
      wakeLock = lock;
      lock.addEventListener('release', function () { wakeLock = null; });
      if (!wantAwake) keepAwake(false);
    }, function () { /* not allowed; fine */ });
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

  function goToJoin(code, error) {
    closeRoom();
    leaveRoom();
    player.unload();
    game = null;
    showScreen('join');
    $('join-code').value = code || currentUrlRoom() || '';
    if (!$('join-name').value) $('join-name').value = local.get(LOCAL_NAME) || '';
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
    joinRoom(code, name);
  }

  function joinRoom(code, name) {
    closeRoom();
    leaveRoom();
    game = null;
    local.set(LOCAL_NAME, name);
    store.set(STORE_JOIN, { code: code, name: name });
    setUrlRoom(code);
    var j = { code: code, name: name, ctl: null, view: null, playback: null, status: 'connecting', detail: null, optionsKey: '', pending: false };
    joined = j;
    j.ctl = Room.createPlayer({
      code: code,
      name: name,
      token: local.get(tokenKey(code, name)),
      makeTransport: function () { return Transport.create(TRANSPORT_KIND, transportOptions()); },
      hooks: {
        onStatus: function (s, d) { if (joined !== j) return; j.status = s; j.detail = d; renderPlayer(); },
        onState: function (v) {
          if (joined !== j) return;
          j.view = v;
          j.playback = v.playback;
          j.playbackAt = now();
          j.pending = false;
          renderPlayer();
        },
        onPlayback: function (pb) { if (joined !== j) return; j.playback = pb; j.playbackAt = now(); renderPlayerPlayback(); },
        onError: function (err) { if (joined !== j) return; j.pending = false; toast(err.message); renderPlayer(); },
        onToken: function (t) { local.set(tokenKey(code, name), t); },
      },
    });
    j.ctl.start();
    keepAwake(true);
    renderPlayer();
  }

  /** Leave the room this tab plays in (if any). */
  function leaveRoom() {
    if (!joined) return;
    var j = joined;
    joined = null;
    j.ctl.leave();
    store.remove(STORE_JOIN);
    setUrlRoom('');
    cancelAnimationFrame(pbRaf);
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
    if (j.status === 'connecting' || !j.view) {
      banner('');
      showWait({ meta: 'Room ' + j.code, title: 'Joining…', sub: TRANSPORT_KIND === 'local' ? 'Same-browser test mode.' : 'Connecting to the host’s device.', spinner: true });
      return;
    }
    banner('');
    var v = j.view;
    if (j.status === 'reconnecting') {
      // Usually the host reloading: the game continues when it's back.
      showWait({
        meta: 'Room ' + j.code,
        title: 'Host disconnected',
        sub: 'Reconnecting… If the host’s page comes back, the game continues where it left off.',
        spinner: true,
        actions: true,
        retry: false,
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
      });
    } else if (screen === 'waiting') {
      var t = v.turn;
      showWait({
        meta: turnMeta(t),
        title: 'It’s ' + t.playerName + '’s turn',
        sub: t.playerLocal ? t.playerName + ' is playing on the host’s device.'
          : t.playerOnline ? 'Listen along! The music plays on the host’s device.'
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

  function showWait(o) {
    showScreen('pwait');
    $('pw-meta').textContent = o.meta || '';
    $('pw-title').textContent = o.title || '';
    $('pw-sub').textContent = o.sub || '';
    $('pw-spinner').hidden = !o.spinner;
    $('pw-clip').hidden = !o.clip;
    $('pw-actions').hidden = !o.actions;
    $('pw-retry').hidden = o.retry === false;
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
      ? 'Tap play: the song plays on the host’s device. Guess on this phone.' : '';
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
    $('pt-seg-long').classList.toggle('locked', !t.extended);
    $('pt-extend').hidden = t.extended;
    $('pt-extend').disabled = t.extended || !t.playedOnce || busy || j.pending;
    $('pt-worth').textContent = '';
    $('pt-worth').appendChild(document.createTextNode('Worth '));
    $('pt-worth').appendChild(el('strong', { text: String(t.worth) }));
    $('pt-worth').appendChild(document.createTextNode(' points'));
    $('pt-play').disabled = j.pending;
    $('pt-play').setAttribute('aria-label', busy ? 'Stop the song on the host’s device'
      : t.extended ? 'Play the first 15 seconds on the host’s device' : 'Play the first 5 seconds on the host’s device');
    $('pt-reveal').disabled = j.pending;
    $('pt-choice').querySelectorAll('.option').forEach(function (b) { b.disabled = j.pending; });
    $('pt-free').querySelectorAll('input, button').forEach(function (x) { x.disabled = j.pending; });
  }

  // Clip progress on the phone: the host sends status changes and a position
  // a few times a second; in between, the bar advances on the phone's clock.
  var pbRaf = 0;
  function renderPlayerPlayback() {
    cancelAnimationFrame(pbRaf);
    var j = joined;
    if (!j || !j.view || !j.view.turn) return;
    var mine = currentScreen === 'pturn';
    if (!mine && currentScreen !== 'pwait') return;
    var t = j.view.turn;
    var pb = j.playback || { status: 'idle', pos: 0, heard: 0 };
    var busy = pb.status === 'playing' || pb.status === 'loading';
    var cap = t.extended ? G.CLIP_LONG : G.CLIP_SHORT;
    var pre = mine ? 'pt-' : 'pw-';
    var shown = busy ? pb.pos : pb.heard || 0;
    if (pb.status === 'playing' && j.playbackAt) {
      shown = Math.min(pb.to || cap, pb.pos + (now() - j.playbackAt) / 1000);
    }
    var short = Math.min(shown, G.CLIP_SHORT) / G.CLIP_SHORT;
    var long = Math.max(0, Math.min(shown, G.CLIP_LONG) - G.CLIP_SHORT) / (G.CLIP_LONG - G.CLIP_SHORT);
    $(pre + 'fill-short').style.width = (short * 100).toFixed(2) + '%';
    $(pre + 'fill-long').style.width = (long * 100).toFixed(2) + '%';
    $(pre + 'seg-long').classList.toggle('locked', !t.extended);
    $(pre + 'time').textContent = Math.min(shown, G.CLIP_LONG).toFixed(1) + 's';
    var extPart = pb.from >= G.CLIP_SHORT - 0.01;
    var status = pb.status === 'loading' ? 'Loading on the host…'
      : pb.status === 'playing' ? (extPart ? 'Playing seconds 5–15' : 'Playing on the host…')
      : pb.status === 'blocked' || pb.status === 'error' ? (pb.message || 'The song couldn’t be played.')
      : !t.playedOnce ? (mine ? 'Tap play to hear 5 seconds' : 'Waiting for the song…')
      : mine ? (t.extended ? 'Tap play to hear all 15 seconds again' : 'Clip finished. Tap play to hear it again')
      : 'Clip finished';
    $(pre + 'status').textContent = status;
    if (mine) {
      var btn = $('pt-play');
      btn.classList.toggle('playing', busy);
      btn.classList.toggle('loading', pb.status === 'loading');
      renderPlayerTurnControls();
    }
    if (pb.status === 'playing') pbRaf = requestAnimationFrame(renderPlayerPlayback);
  }

  function onPlayerPlayClick() {
    var j = joined;
    if (!j || j.pending) return;
    var pb = j.playback || {};
    var busy = pb.status === 'playing' || pb.status === 'loading';
    if (!j.ctl.act(busy ? 'stop' : 'play')) toast('Not connected to the host right now.');
  }

  function onPlayerExtendClick() {
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
      correct: 'Correct! +' + r.points,
      wrong: 'Not quite',
      revealed: 'Answer revealed',
      skipped: 'Song skipped',
    }[r.outcome];
    var sub;
    if (r.outcome === 'correct') sub = who + (r.extended ? ' got it with the extra 10 seconds.' : ' got it in 5 seconds!');
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
   * After a reload: a hosted room is reopened with the same code (players
   * reconnect on their own), a player tab rejoins its room, otherwise a
   * pass-the-phone game continues.
   */
  function restoreRoom() {
    var urlRoom = currentUrlRoom();
    var saved = store.get(STORE_ROOM);
    if (saved && saved.version === Room.PROTOCOL && saved.code && saved.players && (!urlRoom || urlRoom === saved.code)) {
      // Connections didn't survive the reload: everyone with a phone must rejoin.
      saved.players.forEach(function (p) { if (!p.local) { p.online = false; p.peerId = null; } });
      saved.playback = { status: 'idle', pos: 0, heard: saved.turn ? saved.turn.heard : 0, from: 0, to: 0, extended: false, message: '' };
      openRoom(saved, false);
      return true;
    }
    if (urlRoom) {
      var j = store.get(STORE_JOIN);
      if (j && j.code === urlRoom && Room.cleanName(j.name)) joinRoom(urlRoom, Room.cleanName(j.name));
      else goToJoin(urlRoom);
      return true;
    }
    return false;
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
      var exclude = !$('exclude-wrap').hidden && $('exclude-used').checked;
      startFromSetup(readSetup(), exclude);
    });
    $('add-player-btn').addEventListener('click', addPlayer);
    $('example-btn').addEventListener('click', function () {
      $('url-input').value = EXAMPLE_URL;
      refreshExcludeHint();
    });
    $('url-input').addEventListener('input', refreshExcludeHint);
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
    $('pt-play').addEventListener('click', onPlayerPlayClick);
    $('pt-extend').addEventListener('click', onPlayerExtendClick);
    $('pt-free').addEventListener('submit', onPlayerFreeSubmit);
    $('pt-reveal').addEventListener('click', onPlayerRevealClick);
    $('pw-retry').addEventListener('click', function () {
      if (!joined) return;
      joined.ctl.retry();
    });
    $('pw-setup').addEventListener('click', function (e) { e.preventDefault(); goToSetup(); });
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
      if (!e.persisted) return; // back/forward cache: reconnect
      if (hosting) { hosting.attempts = 0; connectHost(); }
      if (joined) joined.ctl.retry();
    });
    document.addEventListener('visibilitychange', function () { if (wantAwake) keepAwake(true); });
    document.addEventListener('keydown', function (e) {
      if (!game || game.phase !== 'round') return;
      if (e.target && /input|textarea|select/i.test(e.target.tagName)) return;
      if (e.key === ' ' || e.key === 'k') { e.preventDefault(); onPlayClick(); }
    });

    if (!restoreRoom() && !restore()) goToSetup();
  }

  init();
})();
