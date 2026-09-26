/* Guess the Song: browser controller (screens, audio, persistence). */
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
  var MAX_PLAYERS = 12;

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

  var toastTimer = null;
  function toast(msg, ms) {
    var t = $('toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, ms || 3500);
  }

  function showScreen(name) {
    document.querySelectorAll('.screen').forEach(function (s) {
      s.hidden = s.getAttribute('data-screen') !== name;
    });
    var inGame = name === 'round' || name === 'result';
    $('scoreboard').hidden = !(inGame || name === 'over');
    $('end-game-btn').hidden = !inGame;
    window.scrollTo(0, 0);
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
  ClipPlayer.prototype.play = function (start, end) {
    var self = this;
    var a = this.audio;
    this.stop();
    var token = ++this.token;
    this.segStart = start;
    this.segEnd = end;
    this.playing = true;
    this.hooks.onState('loading');
    if (a.readyState >= 1) {
      try { a.currentTime = start; } catch (e) { /* ignore */ }
    } else if (start > 0) {
      a.addEventListener('loadedmetadata', function onMeta() {
        a.removeEventListener('loadedmetadata', onMeta);
        if (token === self.token && self.playing) { try { a.currentTime = start; } catch (e) { /* ignore */ } }
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
    onProgress: function (t) { if (game && game.phase === 'round') renderProgress(t - clipOffset()); },
    onState: function (s) { onPlayerState(s); },
    onError: function (msg) {
      if (!game || game.phase !== 'round') { toast(msg); return; }
      turnUi.audioError = true;
      showNotice(msg + ' You can skip it (no points) or reveal the answer.');
      $('skip-btn').hidden = false;
    },
  });
  var resultMode = null; // 'listen' when the result-screen preview is playing

  function saveGame() {
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
    player.unload();
    game = null;
    saveGame();
    applySetup(store.get(STORE_SETUP) || {});
    refreshExcludeHint();
    setupError('');
    showScreen('setup');
  }

  async function startFromSetup(setup, excludeUsed) {
    setupError('');
    if (!setup.url) { setupError('Paste a Spotify playlist, album or track link to start.'); $('url-input').focus(); return; }
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
      return;
    }

    var key = normalizeUrlKey(setup.url) || sourceKey(data.source);
    var used = excludeUsed ? getUsed(key) : [];
    if (!excludeUsed) setUsed(key, []);
    var fresh = data.tracks.filter(function (t) { return used.indexOf(t.id) === -1; });
    if (!fresh.length) {
      goToSetup();
      setupError('You have already heard every song from this link in this session. Untick “Skip songs already played” to start over, or try another playlist.');
      return;
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

    game = G.createGame({
      players: setup.players,
      mode: mode,
      rounds: setup.rounds,
      clipStartMode: setup.clipStart === 'random' ? 'random' : 'beginning',
      tracks: data.tracks,
      usedIds: used,
      source: { type: data.source.type, name: data.source.name, image: data.source.image, key: key },
      sourceUrl: setup.url,
    });
    game.notes = notes;
    G.startTurn(game);
    setUsed(key, game.usedIds);
    saveGame();
    enterRound();
  }

  // ---------- Scoreboard ----------

  var lastScores = {};
  function renderScoreboard() {
    var sb = $('scoreboard');
    sb.textContent = '';
    if (!game) return;
    var active = game.phase === 'over' ? -1 : G.currentPlayerIndex(game);
    game.players.forEach(function (p, i) {
      var chip = el('div', { class: 'score-chip' + (i === active ? ' active' : ''), title: p.name }, [
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
    turnUi = { heard: cur.extended ? G.CLIP_SHORT : 0, playedOnce: cur.extended, audioError: false };
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
    if (player.playing) { player.stop(); return; }
    var cur = game.current;
    reloadAfterError();
    turnUi.heard = 0;
    var off = clipOffset();
    player.play(off, off + (cur.extended ? G.CLIP_LONG : G.CLIP_SHORT));
  }

  function onExtendClick() {
    var cur = game.current;
    if (cur.extended || cur.answered) return;
    cur.extended = true;
    saveGame();
    renderExtendState();
    reloadAfterError();
    turnUi.heard = G.CLIP_SHORT;
    var off = clipOffset();
    player.play(off + G.CLIP_SHORT, off + G.CLIP_LONG);
  }

  function submit(kind, value) {
    if (!game || !game.current || game.current.answered) return;
    if (kind === 'guess' && !game.current.options && !String(value || '').trim()) {
      $('free-input').focus();
      toast('Type a song title first (or reveal the answer).');
      return;
    }
    player.stop();
    G.answer(game, kind, value);
    saveGame();
    enterResult();
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
  }

  function onAgainClick() {
    var setup = store.get(STORE_SETUP) || readSetup();
    var exclude = $('again-exclude').checked;
    startFromSetup(setup, exclude);
  }

  // ---------- Restore after reload ----------

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
    $('new-btn').addEventListener('click', goToSetup);
    $('end-game-btn').addEventListener('click', function () {
      if (!game) return;
      if (!window.confirm('End the game now and show the standings?')) return;
      player.stop();
      if (game.current && !game.current.answered) {
        // The current song was heard but not answered; it stays marked as used.
        game.current = null;
      }
      enterGameOver();
    });
    window.addEventListener('pagehide', function () { player.stop(); });
    document.addEventListener('keydown', function (e) {
      if (!game || game.phase !== 'round') return;
      if (e.target && /input|textarea|select/i.test(e.target.tagName)) return;
      if (e.key === ' ' || e.key === 'k') { e.preventDefault(); onPlayClick(); }
    });

    if (!restore()) goToSetup();
  }

  init();
})();
