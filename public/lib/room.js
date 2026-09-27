/*
 * Multiplayer rooms: the protocol and the game rules around it. No DOM, no
 * networking: the host and player controllers talk through an injected
 * transport (public/lib/transport.js), so everything here runs in Node tests.
 *
 * Host-authoritative: the host device owns the room (players, scores, the
 * GameLogic game), validates every action against whose turn it is, and sends
 * each player a sanitized snapshot. The current song's title, artist, cover and
 * preview URL are only included once the turn is resolved (answered, revealed
 * or skipped). Multiple-choice options are sent to the player whose turn it is.
 *
 * Messages (every message carries v: PROTOCOL):
 *   player -> host  hello {name, token, clockOffset?, rtt?, spotifyReady?}
 *                   play | stop | extend | answer {optionId | text} | reveal | next
 *                   sync {clockOffset?, rtt?, spotifyReady?}
 *                                        "send me the current state again" (e.g. the
 *                                        phone's tab was in the background); answered
 *                                        with `state`, or error not-joined. Also how a
 *                                        phone reports its clock offset and whether it
 *                                        can play full songs itself (spotifyReady).
 *                   ping {t0}            clock sync (allowed before hello)
 *   host -> player  state {state}      the sanitized snapshot for that player
 *                   playback {playback} clip status/progress of the host's own player
 *                   pong {t0, ht}      ht: the host's clock when the ping arrived
 *                   error {code, message}
 *   "Sound plays on: every player's device" (settings.soundOn 'all') only:
 *                   preload {engine, previewUrl?}   at the start of a turn: the song's
 *                                        30-second preview URL (preview engine), so phones
 *                                        can load it before Play is tapped
 *                   play {seq, engine, startMs, endMs, from, to, extend, startAt, offset,
 *                         previewUrl? | uri?, durationMs?, hostOnly}
 *                                        play [startMs, endMs) of the song (ms of the audio
 *                                        file) at host time startAt (a phone's local time =
 *                                        startAt - its clock offset); from/to: the same
 *                                        segment in clip seconds. uri only to phones that
 *                                        reported spotifyReady (full songs); hostOnly: this
 *                                        phone can't play it (the host's device does)
 *                   halt {seq}           stop the clip (Stop, an answer, the next turn)
 * The preview URL (a hash on Spotify's CDN) says nothing about the song, so it
 * is sent in `preload` and `play` only; snapshots still never carry the current
 * song's title, artist, cover, preview URL or URI before it is resolved.
 *
 * Shared by the browser (window.Room) and the Node tests.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('../game-logic.js'));
  else root.Room = factory(root.GameLogic);
})(typeof self !== 'undefined' ? self : this, function (G) {
  'use strict';

  var PROTOCOL = 1;
  // No I, L or O: they are easy to confuse with 1 and 0 when read off a screen.
  var CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ';
  var CODE_LENGTH = 4;
  var PEER_PREFIX = 'gts-room-';
  var MAX_PLAYERS = 12;
  var MAX_NAME = 24;
  var MAX_GUESS = 200;
  var PLAYER_ACTIONS = ['play', 'stop', 'extend', 'answer', 'reveal', 'next'];
  var HOST_ACTIONS = PLAYER_ACTIONS.concat(['skip', 'end']);
  // Errors after which a player should not keep retrying.
  var FATAL_ERRORS = ['version', 'name-taken', 'started', 'full', 'bad-name', 'removed', 'closed', 'replaced'];

  // ---------- Codes, names, links ----------

  function generateCode(rng, length) {
    rng = rng || Math.random;
    var out = '';
    for (var i = 0; i < (length || CODE_LENGTH); i++) out += CODE_ALPHABET[Math.floor(rng() * CODE_ALPHABET.length)];
    return out;
  }

  /** Uppercase and strip spaces/dashes. Returns '' unless it is a valid code. */
  function normalizeCode(input) {
    var s = String(input || '').toUpperCase().replace(/[\s-]+/g, '');
    if (s.length < 4 || s.length > 5) return '';
    for (var i = 0; i < s.length; i++) if (CODE_ALPHABET.indexOf(s[i]) === -1) return '';
    return s;
  }

  function peerIdFor(code) {
    return PEER_PREFIX + code;
  }

  /** `<base>?room=CODE`, keeping ?transport= (dev mode) if the host uses it. */
  function joinLink(base, code, transportKind) {
    var url = String(base || '').replace(/[?#].*$/, '') + '?room=' + encodeURIComponent(code);
    if (transportKind && transportKind !== 'peer') url += '&transport=' + encodeURIComponent(transportKind);
    return url;
  }

  function cleanName(name) {
    // Only strings (or numbers): anything else from a peer is no name at all.
    if (typeof name !== 'string' && typeof name !== 'number') name = '';
    return String(name).replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME);
  }

  function sameName(a, b) {
    return cleanName(a).toLowerCase() === cleanName(b).toLowerCase();
  }

  function generateToken(rng) {
    rng = rng || Math.random;
    var chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    var out = '';
    for (var i = 0; i < 20; i++) out += chars[Math.floor(rng() * chars.length)];
    return out;
  }

  function message(type, body) {
    var m = { v: PROTOCOL, type: type };
    if (body) Object.keys(body).forEach(function (k) { m[k] = body[k]; });
    return m;
  }

  function errorMessage(code, text) {
    return message('error', { code: code, message: text });
  }

  function fail(code, text) {
    return { ok: false, code: code, message: text };
  }

  // ---------- Room state (host side) ----------

  /**
   * @param {object} cfg
   * @param {string} cfg.code
   * @param {object} cfg.settings   { mode, rounds, clipStart, clip: { firstMs, extendMs }, sourceUrl, engine, device }
   * @param {object} cfg.source     { type, name, image, key }
   * @param {Array}  cfg.tracks
   * @param {string[]} [cfg.usedIds]
   * @param {string[]} [cfg.notes]
   */
  function createRoom(cfg) {
    return {
      version: PROTOCOL,
      code: cfg.code,
      settings: {
        mode: cfg.settings && cfg.settings.mode === 'free' ? 'free' : 'choice',
        rounds: cfg.settings && cfg.settings.rounds > 0 ? Math.floor(cfg.settings.rounds) : 0,
        clipStart: cfg.settings && cfg.settings.clipStart === 'random' ? 'random' : 'beginning',
        // Clip lengths as chosen on the host's setup screen (the game may fit
        // them to 30-second previews, see roomClip).
        clip: G.normalizeClip(cfg.settings && cfg.settings.clip),
        sourceUrl: (cfg.settings && cfg.settings.sourceUrl) || '',
        // Sound: 'preview' (30-second previews) or 'spotify' (full songs via
        // Spotify Connect; phones only see settings.fullSongs), and the host's
        // Spotify output device { id, name, local } (never sent to phones).
        engine: cfg.settings && cfg.settings.engine === 'spotify' ? 'spotify' : 'preview',
        device: cfg.settings && cfg.settings.device && cfg.settings.device.id
          ? { id: String(cfg.settings.device.id), name: String(cfg.settings.device.name || ''), local: !!cfg.settings.device.local }
          : null,
        // "Sound plays on": 'all' (every player's device, the default) or 'host' (the host device only).
        soundOn: normalizeSoundOn(cfg.settings && cfg.settings.soundOn),
      },
      source: cfg.source || null,
      tracks: cfg.tracks || [],
      usedIds: (cfg.usedIds || []).slice(),
      notes: (cfg.notes || []).slice(),
      players: [], // { id, name, token, peerId, online, local }
      nextId: 1,
      game: null,
      turn: { playedOnce: false, heard: 0 },
      playback: idlePlayback(),
    };
  }

  function normalizeSoundOn(v) {
    return v === 'host' ? 'host' : 'all';
  }

  /** Is the clip played on every player's device (not only the host's)? */
  function soundEverywhere(room) {
    return !!(room && room.settings && normalizeSoundOn(room.settings.soundOn) === 'all');
  }

  function idlePlayback() {
    return { status: 'idle', pos: 0, heard: 0, from: 0, to: 0, extended: false, message: '' };
  }

  /**
   * The clip lengths in use: the game's, or (in the lobby) the host's settings
   * as the next game will use them. With previews (30 s) the extension is
   * shortened so the whole clip fits (G.fitClipToPreview).
   * @returns {{ firstMs, extendMs, clamped: boolean }}
   */
  function roomClip(room) {
    if (room.game) return Object.assign(G.clipOf(room.game), { clamped: !!room.game.clipClamped });
    var c = G.normalizeClip(room.settings && room.settings.clip);
    if (room.settings && room.settings.engine === 'spotify') return Object.assign(c, { clamped: false });
    return G.fitClipToPreview(c);
  }

  function phaseOf(room) {
    return room.game ? room.game.phase : 'lobby';
  }

  function playerById(room, id) {
    for (var i = 0; i < room.players.length; i++) if (room.players[i].id === id) return room.players[i];
    return null;
  }

  function playerByPeer(room, peerId) {
    if (!peerId) return null;
    for (var i = 0; i < room.players.length; i++) if (room.players[i].peerId === peerId) return room.players[i];
    return null;
  }

  /** The player whose turn it is (or whose turn just ended, on the result screen). */
  function currentPlayer(room) {
    var g = room.game;
    if (!g || g.phase === 'over' || !g.current) return null;
    return room.players[G.currentPlayerIndex(g)] || null;
  }

  function newPlayer(room, name, extra) {
    var p = {
      id: 'p' + room.nextId++,
      name: name,
      token: extra.token || null,
      peerId: extra.peerId || null,
      online: true,
      local: !!extra.local,
      // Reported by the phone (hello / sync): can it play full songs itself, and its clock.
      spotifyReady: false,
      clockOffset: null,
      rtt: null,
    };
    room.players.push(p);
    return p;
  }

  /** hello / sync: what a phone says about itself. */
  function notePlayerInfo(p, msg) {
    if (!p || !msg) return;
    var off = Number(msg.clockOffset);
    if (msg.clockOffset != null && isFinite(off) && Math.abs(off) < 1e13) p.clockOffset = Math.round(off);
    var rtt = Number(msg.rtt);
    if (msg.rtt != null && isFinite(rtt) && rtt >= 0 && rtt < 60000) p.rtt = Math.round(rtt);
    if (typeof msg.spotifyReady === 'boolean') p.spotifyReady = msg.spotifyReady;
  }

  /**
   * A remote player says hello. Reclaims a slot by token, or by name when the
   * named player is offline; otherwise adds a new player (lobby only).
   * @returns {{ok: true, player, reclaimed: boolean} | {ok: false, code, message}}
   */
  function join(room, req, rng) {
    var name = cleanName(req.name);
    var token = typeof req.token === 'string' && req.token ? req.token : null;
    // A repeated hello on the same connection is the same player, never a new one.
    var same = playerByPeer(room, req.peerId);
    if (same) return { ok: true, player: same, reclaimed: true };
    var p = null;
    if (token) {
      p = room.players.filter(function (x) { return !x.local && x.token === token; })[0] || null;
    }
    if (!p && name) {
      var byName = room.players.filter(function (x) { return sameName(x.name, name); })[0];
      if (byName && byName.local) return fail('name-taken', 'Someone on the host’s device is already called ' + byName.name + '. Pick another name.');
      if (byName && byName.online && byName.peerId !== req.peerId) {
        return fail('name-taken', byName.name + ' is already in this room. Pick another name.');
      }
      if (byName) p = byName;
    }
    if (p) {
      // With the token, a newer tab/device takes over from an older one that still looks online.
      var replaced = p.online && p.peerId && p.peerId !== req.peerId ? p.peerId : null;
      p.peerId = req.peerId;
      p.online = true;
      if (!p.token) p.token = generateToken(rng);
      return { ok: true, player: p, reclaimed: true, replacedPeer: replaced };
    }
    if (!name) return fail('bad-name', 'Enter your name to join.');
    if (room.game) return fail('started', 'This game has already started. Only players who were in it can rejoin (with the same name).');
    if (room.players.length >= MAX_PLAYERS) return fail('full', 'This room is full (' + MAX_PLAYERS + ' players).');
    return { ok: true, player: newPlayer(room, name, { peerId: req.peerId, token: generateToken(rng) }), reclaimed: false };
  }

  /** A player on the host's own device (no phone). Lobby only. */
  function addLocalPlayer(room, rawName) {
    var name = cleanName(rawName);
    if (!name) return fail('bad-name', 'Enter a name.');
    if (room.game) return fail('started', 'The game has already started.');
    if (room.players.length >= MAX_PLAYERS) return fail('full', 'This room is full (' + MAX_PLAYERS + ' players).');
    if (room.players.some(function (x) { return sameName(x.name, name); })) return fail('name-taken', name + ' is already in this room.');
    return { ok: true, player: newPlayer(room, name, { local: true }) };
  }

  /** Remove a player from the lobby (before the game starts). */
  function removePlayer(room, playerId) {
    if (room.game) return null;
    var p = playerById(room, playerId);
    if (p) room.players.splice(room.players.indexOf(p), 1);
    return p;
  }

  /** A connection closed: keep the player (and score), mark them offline. */
  function leave(room, peerId) {
    var p = playerByPeer(room, peerId);
    if (!p) return null;
    p.peerId = null;
    p.online = false;
    return p;
  }

  function canStart(room) {
    return !room.game && room.players.length >= 1 && room.tracks.length > 0;
  }

  function resetTurn(room) {
    room.turn = { playedOnce: false, heard: 0 };
    room.playback = idlePlayback();
  }

  /**
   * Start (or restart, for "play again") the game with the room's players.
   * @param {object} [opts] { tracks, usedIds, source, notes } to replace the room's; rng
   */
  function startGame(room, opts) {
    opts = opts || {};
    if (opts.tracks) room.tracks = opts.tracks;
    if (opts.usedIds) room.usedIds = opts.usedIds.slice();
    if (opts.source) room.source = opts.source;
    if (opts.notes) room.notes = opts.notes.slice();
    if (!room.players.length) return fail('no-players', 'Wait for at least one player to join.');
    var mode = room.settings.mode;
    if (mode === 'choice' && G.distinctTitleCount(room.tracks) < 2) mode = 'free';
    room.settings.clip = G.normalizeClip(room.settings.clip);
    var clip = room.settings.engine === 'spotify' ? room.settings.clip : G.fitClipToPreview(room.settings.clip);
    room.game = G.createGame({
      players: room.players.map(function (p) { return p.name; }),
      mode: mode,
      rounds: room.settings.rounds,
      clipStartMode: room.settings.clipStart,
      clip: clip,
      tracks: room.tracks,
      usedIds: room.usedIds,
      source: room.source,
      sourceUrl: room.settings.sourceUrl,
      rng: opts.rng,
    });
    room.game.notes = room.notes.slice();
    if (clip.clamped) {
      room.game.clipClamped = true;
      room.game.notes.push(previewFitNote(room.game.clip));
    }
    room.notes = [];
    resetTurn(room);
    G.startTurn(room.game, opts.rng);
    if (room.game.phase === 'over') room.game.current = null;
    room.usedIds = room.game.usedIds.slice();
    return { ok: true, game: room.game };
  }

  /** "Previews are 30 seconds long, so the extra time is 10 seconds." */
  function previewFitNote(clip) {
    var ext = clip.extendMs / 1000;
    return 'Previews are ' + G.PREVIEW_SECONDS + ' seconds long, so the extra time is ' +
      (ext > 0 ? ext + ' second' + (ext === 1 ? '' : 's') : 'off') + '.';
  }

  function secondsText(ms) {
    var n = Math.round(ms / 100) / 10;
    return n + ' second' + (n === 1 ? '' : 's');
  }

  /**
   * Clip-relative segment (seconds) for play/extend, from the game's clip
   * lengths ({ firstMs, extendMs }, default 5 s + 10 s). null for 'extend'
   * when the game has no extra time.
   */
  function clipSegment(cur, kind, clip) {
    var c = G.normalizeClip(clip);
    var first = c.firstMs / 1000;
    var total = (c.firstMs + c.extendMs) / 1000;
    if (kind === 'extend') return c.extendMs > 0 ? { from: first, to: total } : null;
    return { from: 0, to: cur && cur.extended ? total : first };
  }

  /**
   * Validate and apply an action for `actor` (a player id, or 'host').
   * The host may act for whoever's turn it is (fallback when a phone is
   * unresponsive, or a player on the host device). Players may only act on
   * their own turn.
   * @returns {{ok: true, effect: object|null} | {ok: false, code, message}}
   *   effect.type: 'play' {from, to} | 'stop' | 'answered' | 'next' | 'over'
   */
  function applyAction(room, actor, action, rng) {
    var type = action && action.type;
    var isHost = actor === 'host';
    if ((isHost ? HOST_ACTIONS : PLAYER_ACTIONS).indexOf(type) === -1) return fail('bad-action', 'Unknown action.');
    var g = room.game;
    if (!g) return fail('not-started', 'The game hasn’t started yet.');
    if (g.phase === 'over') return fail('game-over', 'The game is over.');
    var p = currentPlayer(room);
    if (!isHost && (!p || p.id !== actor)) {
      return fail('not-your-turn', p ? 'It’s ' + p.name + '’s turn.' : 'It’s not your turn.');
    }
    var cur = g.current;

    if (type === 'end') {
      if (cur && !cur.answered) g.current = null; // heard but unanswered: stays marked as used
      g.phase = 'over';
      return { ok: true, effect: { type: 'over' } };
    }
    if (type === 'next') {
      if (g.phase !== 'result') return fail('not-now', 'Answer first.');
      G.nextTurn(g, rng);
      room.usedIds = g.usedIds.slice();
      resetTurn(room);
      return { ok: true, effect: { type: g.phase === 'over' ? 'over' : 'next' } };
    }

    if (g.phase !== 'round' || !cur || cur.answered) return fail('not-now', 'This song has already been answered.');
    if (type === 'play') {
      var seg = clipSegment(cur, 'play', g.clip);
      return { ok: true, effect: { type: 'play', from: seg.from, to: seg.to } };
    }
    if (type === 'stop') return { ok: true, effect: { type: 'stop' } };
    if (type === 'extend') {
      var clip = G.clipOf(g);
      if (!clip.extendMs) return fail('no-extension', 'There’s no extra time in this game.');
      if (cur.extended) return fail('not-now', 'The extra ' + secondsText(clip.extendMs) + ' are already unlocked.');
      if (!room.turn.playedOnce) return fail('not-now', 'Play the first ' + secondsText(clip.firstMs) + ' first.');
      cur.extended = true;
      var ext = clipSegment(cur, 'extend', clip);
      return { ok: true, effect: { type: 'play', from: ext.from, to: ext.to, extend: true } };
    }
    if (type === 'answer') {
      var value;
      if (cur.options) {
        value = action.optionId;
        if (!cur.options.some(function (o) { return o.id === value; })) return fail('bad-answer', 'Pick one of the options.');
      } else {
        value = typeof action.text === 'string' ? action.text.trim().slice(0, MAX_GUESS) : '';
        if (!value) return fail('bad-answer', 'Type a song title first (or reveal the answer).');
      }
      G.answer(g, 'guess', value);
      return { ok: true, effect: { type: 'answered' } };
    }
    if (type === 'reveal') {
      G.answer(g, 'reveal');
      return { ok: true, effect: { type: 'answered' } };
    }
    if (type === 'skip') {
      G.answer(g, 'skip');
      return { ok: true, effect: { type: 'answered' } };
    }
    return fail('bad-action', 'Unknown action.');
  }

  /**
   * Record the host's clip player status. `pos` is clip-relative seconds.
   * status: 'loading' | 'playing' | 'stopped' | 'error' | 'blocked' | 'idle'
   */
  function notePlayback(room, pb) {
    var cur = room.game && room.game.current;
    var cap = clipSegment(cur, 'play', room.game && room.game.clip).to;
    var pos = Math.max(0, Math.min(Number(pb.pos) || 0, cap));
    if (pb.status === 'playing' || pb.status === 'stopped') room.turn.heard = Math.max(room.turn.heard, pos);
    if (pb.status === 'stopped' && room.turn.heard > 0) room.turn.playedOnce = true;
    room.playback = {
      status: pb.status,
      pos: pos,
      heard: room.turn.heard,
      from: Number(pb.from) || 0,
      to: Number(pb.to) || 0,
      extended: !!(cur && cur.extended),
      message: pb.message ? String(pb.message) : '',
    };
    return room.playback;
  }

  function songCounts(g) {
    var available = g.turn + 1 + g.queue.length;
    return { song: g.turn + 1, songs: g.totalTurns ? Math.min(g.totalTurns, available) : available };
  }

  /**
   * The snapshot one player receives. Never contains the current track (id,
   * title, artist, cover, preview URL) until the turn is resolved; the
   * multiple-choice options (titles only, no correctness flag) go to the
   * player whose turn it is.
   */
  function playerView(room, playerId) {
    var g = room.game;
    var you = playerById(room, playerId);
    var phase = phaseOf(room);
    var view = {
      v: PROTOCOL,
      code: room.code,
      phase: phase,
      you: you ? { id: you.id, name: you.name, token: you.token } : null,
      players: room.players.map(function (p, i) {
        var gp = g && g.players[i];
        return { id: p.id, name: p.name, online: !!p.online, local: !!p.local, score: gp ? gp.score : 0, correct: gp ? gp.correct : 0 };
      }),
      settings: {
        mode: g ? g.mode : room.settings.mode,
        rounds: room.settings.rounds || null,
        clipStart: room.settings.clipStart,
        // Where the sound plays and with what (the Spotify device stays on the host).
        soundOn: normalizeSoundOn(room.settings.soundOn),
        fullSongs: room.settings.engine === 'spotify',
      },
      // Clip lengths (the host's settings are authoritative): labels and the progress split.
      clip: (function (c) { return { firstMs: c.firstMs, extendMs: c.extendMs }; })(roomClip(room)),
      // A single-track link's name is the song's title: keep it until the end.
      source: room.source ? { type: room.source.type, name: room.source.type === 'track' && phase !== 'over' ? 'a single song' : room.source.name } : null,
      turn: null,
      result: null,
      over: null,
      playback: null,
    };
    if (g && (phase === 'round' || phase === 'result') && g.current) {
      var cur = g.current;
      var p = currentPlayer(room);
      var mine = !!(you && p && you.id === p.id);
      var counts = songCounts(g);
      var last = G.isOver(Object.assign({}, g, { turn: g.turn + 1 }));
      view.turn = {
        playerId: p.id,
        playerName: p.name,
        playerOnline: !!p.online,
        playerLocal: !!p.local,
        yours: mine,
        round: G.roundNumber(g),
        rounds: g.rounds,
        song: counts.song,
        songs: counts.songs,
        answerType: cur.options ? 'choice' : 'free',
        options: mine && cur.options && !cur.answered
          ? cur.options.map(function (o) { return { id: o.id, title: o.title, artist: o.artist }; })
          : null,
        extended: !!cur.extended,
        playedOnce: !!room.turn.playedOnce,
        worth: cur.extended ? G.POINTS.extended : G.POINTS.short,
        clipStart: cur.clipStart || 0,
        answered: !!cur.answered,
        nextPlayerName: last ? null : g.players[(g.turn + 1) % g.players.length].name,
        last: last,
      };
      view.playback = Object.assign({}, room.playback);
      if (cur.answered) {
        var t = G.trackById(g, cur.trackId);
        view.result = {
          outcome: cur.outcome,
          match: cur.match || null, // 'exact' | 'close' | 'none' | null (free-answer matcher)
          points: cur.points,
          guess: cur.guess || '',
          extended: !!cur.extended,
          track: { id: t.id, title: t.title, artist: t.artist, image: t.image || (room.source && room.source.image) || null },
        };
      }
    }
    if (g && phase === 'over') {
      view.over = {
        standings: G.standings(g).map(function (s) {
          var rp = room.players[s.index];
          return { id: rp ? rp.id : null, name: s.name, score: s.score, correct: s.correct, rank: s.rank };
        }),
        songsPlayed: g.history.length,
        songsLeft: g.queue.length,
      };
    }
    return view;
  }

  // ---------- Sound on every device: clock sync, preload, play ----------

  /**
   * Clock offset from ping/pong samples {t0, ht, t1} (t0/t1: the phone's clock
   * when the ping left / the pong arrived; ht: the host's clock in between).
   * The host's time is about local + offset. Uses the samples with the
   * shortest round trips (the least queueing), averaged.
   * @returns {{offset, rtt, n}} or null without usable samples
   */
  function estimateClockOffset(samples) {
    var ok = (samples || []).filter(function (s) {
      return s && isFinite(s.t0) && isFinite(s.t1) && isFinite(s.ht) && s.t1 >= s.t0;
    }).map(function (s) { return { rtt: s.t1 - s.t0, offset: s.ht - (s.t0 + (s.t1 - s.t0) / 2) }; });
    if (!ok.length) return null;
    ok.sort(function (a, b) { return a.rtt - b.rtt; });
    var best = ok.filter(function (s, i) { return i < 3 && s.rtt <= ok[0].rtt + 20; });
    var sum = 0;
    best.forEach(function (s) { sum += s.offset; });
    return { offset: Math.round(sum / best.length), rtt: Math.round(ok[0].rtt), n: ok.length };
  }

  /**
   * `preload` for the current song (turn start), or null: only with sound on
   * every device, during an unanswered turn. Previews: the preview URL, which
   * doesn't reveal the song. Full songs: no URI (the URI is the track id).
   */
  function preloadMessageFor(room) {
    var g = room.game;
    if (!soundEverywhere(room) || !g || g.phase !== 'round' || !g.current || g.current.answered) return null;
    if (room.settings.engine === 'spotify') return message('preload', { engine: 'spotify' });
    var t = G.trackById(g, g.current.trackId);
    return t && t.previewUrl ? message('preload', { engine: 'preview', previewUrl: t.previewUrl }) : null;
  }

  /**
   * The `play` a phone gets for a clip the host starts, or null (sound on the
   * host only, a player on the host device). seg: { seq, engine, startMs, endMs,
   * from, to, extend, startAt, previewUrl, uri, durationMs }. The Spotify URI
   * only goes to phones that reported spotifyReady (signed in, with a device).
   */
  function playMessageFor(room, p, seg) {
    if (!p || p.local || !soundEverywhere(room) || !seg) return null;
    var engine = seg.engine === 'spotify' ? 'spotify' : 'preview';
    var num = function (x) { x = Number(x); return isFinite(x) ? x : 0; };
    var body = {
      seq: num(seg.seq),
      engine: engine,
      startMs: Math.max(0, Math.round(num(seg.startMs))),
      endMs: Math.max(0, Math.round(num(seg.endMs))),
      from: num(seg.from),
      to: num(seg.to),
      extend: !!seg.extend,
      startAt: num(seg.startAt),
      offset: p.clockOffset != null ? p.clockOffset : null,
    };
    if (engine === 'preview' && seg.previewUrl) body.previewUrl = String(seg.previewUrl);
    if (engine === 'spotify' && p.spotifyReady && seg.uri) {
      body.uri = String(seg.uri);
      if (num(seg.durationMs) > 0) body.durationMs = num(seg.durationMs);
    }
    body.hostOnly = engine === 'spotify' ? !body.uri : !body.previewUrl;
    return message('play', body);
  }

  /** Which screen a player's phone should show for a snapshot. */
  function playerScreen(view) {
    if (!view) return 'connecting';
    if (view.phase === 'lobby') return 'lobby';
    if (view.phase === 'over') return 'over';
    if (view.phase === 'result') return 'result';
    if (view.turn && view.turn.yours) return 'turn';
    return 'waiting';
  }

  // ---------- Host controller (room + transport) ----------

  /**
   * @param {object} opts
   * @param {object} opts.room
   * @param {object} opts.transport   see transport.js (send/onMessage/onPeerJoin/onPeerLeave)
   * @param {object} [opts.hooks]     onEffect(effect, actor), onChange(reason, detail)
   * @param {Function} [opts.rng]
   * @param {Function} [opts.now]
   * @param {Function} [opts.clock]   the host clock for clock sync and `play` startAt (default: now)
   * @param {number} [opts.playbackIntervalMs]  min gap between progress updates while playing
   */
  function createHost(opts) {
    var room = opts.room;
    var transport = opts.transport;
    var hooks = opts.hooks || {};
    var rng = opts.rng;
    var now = opts.now || function () { return Date.now(); };
    var clock = opts.clock || now;
    var interval = opts.playbackIntervalMs == null ? 250 : opts.playbackIntervalMs;
    var lastPlaybackSent = 0;
    var lastPlaybackStatus = null;
    var playSeq = 0;
    var lastSeg = null; // sound on every device: the clip playing now (for phones that (re)join mid-clip)

    function change(reason, detail) { if (hooks.onChange) hooks.onChange(reason, detail); }

    function sendTo(peerId, msg) {
      try { transport.send(peerId, msg); } catch (e) { /* the connection is going away */ }
    }

    function broadcastState() {
      room.players.forEach(function (p) {
        if (p.peerId && p.online) sendTo(p.peerId, message('state', { state: playerView(room, p.id) }));
      });
    }

    function broadcastPlayback() {
      room.players.forEach(function (p) {
        if (p.peerId && p.online) sendTo(p.peerId, message('playback', { playback: room.playback }));
      });
    }

    function phones() {
      return room.players.filter(function (p) { return p.peerId && p.online && !p.local; });
    }

    /** Sound on every device: the current song's `preload` to one phone, or to all. */
    function sendPreload(peerId) {
      var m = preloadMessageFor(room);
      if (!m) return;
      if (peerId) sendTo(peerId, m);
      else phones().forEach(function (p) { sendTo(p.peerId, m); });
    }

    function broadcastHalt() {
      lastSeg = null;
      if (!soundEverywhere(room)) return;
      phones().forEach(function (p) { sendTo(p.peerId, message('halt', { seq: playSeq })); });
    }

    function run(actor, action) {
      var res = applyAction(room, actor, action, rng);
      if (!res.ok) return res;
      var fx = res.effect && res.effect.type;
      // The phones stop their own copy of the clip (the end of a clip needs no message).
      if (fx === 'stop' || fx === 'answered' || fx === 'next' || fx === 'over') broadcastHalt();
      if (res.effect && hooks.onEffect) hooks.onEffect(res.effect, actor);
      broadcastState();
      if (fx === 'next') sendPreload();
      change(action.type, { actor: actor, effect: res.effect });
      return res;
    }

    transport.onMessage(function (peerId, msg) {
      if (!msg || typeof msg !== 'object') return;
      if (msg.v !== PROTOCOL) {
        sendTo(peerId, errorMessage('version', 'This page is out of date with the host’s. Reload both pages.'));
        return;
      }
      if (msg.type === 'ping') {
        // Clock sync: answered at once, before hello too.
        var t0 = Number(msg.t0);
        if (isFinite(t0)) sendTo(peerId, message('pong', { t0: t0, ht: clock() }));
        return;
      }
      if (msg.type === 'hello') {
        var j = join(room, { peerId: peerId, name: msg.name, token: msg.token }, rng);
        if (!j.ok) { sendTo(peerId, errorMessage(j.code, j.message)); return; }
        notePlayerInfo(j.player, msg);
        // An older tab still attached to this slot loses it.
        if (j.replacedPeer) sendTo(j.replacedPeer, errorMessage('replaced', j.player.name + ' joined from another tab or device.'));
        broadcastState();
        sendPreload(peerId);
        // A phone that (re)joins while a clip plays joins it where the others are.
        if (lastSeg && soundEverywhere(room) && clock() < Number(lastSeg.startAt) + (lastSeg.endMs - lastSeg.startMs)) {
          var pm = playMessageFor(room, j.player, lastSeg);
          if (pm) sendTo(peerId, pm);
        }
        change('join', { player: j.player, reclaimed: j.reclaimed });
        return;
      }
      var p = playerByPeer(room, peerId);
      if (!p) { sendTo(peerId, errorMessage('not-joined', 'Join the room first.')); return; }
      if (msg.type === 'sync') {
        notePlayerInfo(p, msg);
        sendTo(peerId, message('state', { state: playerView(room, p.id) }));
        change('info', { player: p });
        return;
      }
      var action = { type: msg.type, optionId: msg.optionId, text: msg.text };
      var res = run(p.id, action);
      if (!res.ok) sendTo(peerId, errorMessage(res.code, res.message));
    });

    transport.onPeerLeave(function (peerId) {
      var p = leave(room, peerId);
      if (!p) return;
      broadcastState();
      change('leave', { player: p });
    });

    if (transport.onPeerJoin) transport.onPeerJoin(function () { /* wait for hello */ });

    return {
      room: room,
      /** A button pressed on the host device. */
      act: function (action) { return run('host', typeof action === 'string' ? { type: action } : action); },
      start: function (startOpts) {
        var res = startGame(room, Object.assign({ rng: rng }, startOpts || {}));
        if (res.ok) { lastPlaybackStatus = null; broadcastState(); sendPreload(); change('start'); }
        return res;
      },
      /**
       * Sound on every device: the host starts a clip (after a `play` or `extend`
       * it accepted). seg: { engine, startMs, endMs, from, to, extend, startAt,
       * previewUrl, uri, durationMs } (see playMessageFor). Each phone gets its
       * own `play`. Returns the play's seq, or 0 (sound on the host only).
       */
      play: function (seg) {
        if (!soundEverywhere(room)) return 0;
        playSeq++;
        var s = Object.assign({}, seg, { seq: playSeq });
        lastSeg = s;
        phones().forEach(function (p) {
          var m = playMessageFor(room, p, s);
          if (m) sendTo(p.peerId, m);
        });
        return playSeq;
      },
      /** Re-send the current song's preload (e.g. after switching to previews). */
      preload: function () { sendPreload(); },
      halt: broadcastHalt,
      clock: clock,
      addLocalPlayer: function (name) {
        var res = addLocalPlayer(room, name);
        if (res.ok) { broadcastState(); change('players'); }
        return res;
      },
      removePlayer: function (id) {
        var p = removePlayer(room, id);
        if (p) {
          if (p.peerId) sendTo(p.peerId, errorMessage('removed', 'The host removed you from the room.'));
          broadcastState();
          change('players');
        }
        return p;
      },
      /** Called by the clip player; progress is throttled while playing. */
      playback: function (pb) {
        notePlayback(room, pb);
        var t = now();
        var statusChanged = pb.status !== lastPlaybackStatus;
        if (!statusChanged && pb.status === 'playing' && t - lastPlaybackSent < interval) return;
        lastPlaybackStatus = pb.status;
        lastPlaybackSent = t;
        broadcastPlayback();
        // Unlocking "play next 10 seconds" changes what the current player may do
        // (and should survive a host reload).
        if (statusChanged && pb.status === 'stopped') { broadcastState(); change('playback'); }
      },
      /** Re-send snapshots (after a cover image arrives, a restore, ...). */
      broadcast: broadcastState,
      viewFor: function (id) { return playerView(room, id); },
    };
  }

  // ---------- Player controller ----------

  /**
   * @param {object} opts
   * @param {Function} opts.makeTransport   () => transport (a fresh one per connection attempt)
   * @param {string} opts.code
   * @param {string} opts.name
   * @param {string} [opts.token]
   * @param {object} opts.hooks   onStatus(status, detail), onState(view), onPlayback(pb), onError(err), onToken(token),
   *                              onPlay(msg), onPreload(msg), onHalt(msg)   (sound on every device), onClock(clock)
   * @param {object} [opts.timers] { setTimeout, clearTimeout }
   * @param {Function} [opts.now]
   * @param {Function} [opts.clock]         this device's clock for clock sync (default: now)
   * @param {number} [opts.pingCount]       pings per clock-sync round (0: no clock sync; the app uses 5)
   * @param {number} [opts.pingGapMs]       gap between them (150)
   * @param {number} [opts.pingEveryMs]     a new round this often while connected (30000; 0 = only on connect)
   * @param {number} [opts.joinRetryMs]    gap between attempts while joining for the first time (4000)
   * @param {number} [opts.joinWaitMs]     how long to keep trying to join before failing (180000; 0 = one attempt)
   * @param {number} [opts.retryMs]        first delay before reconnecting after the host went away (1000),
   *                                       doubling up to...
   * @param {number} [opts.maxRetryMs]     ...this cap (10000)
   * @param {number} [opts.maxRetries]     reconnect attempts before giving up (default: never)
   * @param {number} [opts.replyTimeoutMs] wake(): no state this long after a `sync` = the connection is dead (6000)
   *
   * Status:
   *   'connecting'    the first attempt
   *   'waiting'       not joined yet and the host doesn't answer; retrying every joinRetryMs
   *                   for joinWaitMs. detail.code: 'signaling-unreachable' (this phone's own
   *                   network), 'ice-failed' (the host answered, but no connection path
   *                   between the two devices worked), or 'room-not-found' / 'timeout' /
   *                   'host-left' (the host's screen is off or the tab is in the
   *                   background, or a wrong code)
   *
   * makeTransport({relay}) gets relay: true after an attempt failed with
   * 'ice-failed' (try TURN relays only), alternating with false on further ICE
   * failures, so both paths keep being tried.
   *   'connected'
   *   'reconnecting'  was connected and lost the host (a reload, a background tab, Wi-Fi):
   *                   retrying with backoff, and at once on wake()
   *   'failed'        {code, message}: a fatal error ('closed' is the host closing the room),
   *                   or gave up (joinWaitMs / maxRetries)
   *   'left'          leave() was called
   */
  function createPlayer(opts) {
    var hooks = opts.hooks || {};
    // Wrapped: calling the browser's setTimeout as a method of another object throws.
    var timers = opts.timers || {
      setTimeout: function (fn, ms) { return setTimeout(fn, ms); },
      clearTimeout: function (id) { clearTimeout(id); },
    };
    var now = opts.now || function () { return Date.now(); };
    var joinRetryMs = opts.joinRetryMs == null ? 4000 : opts.joinRetryMs;
    var joinWaitMs = opts.joinWaitMs == null ? 180000 : opts.joinWaitMs;
    var retryMs = opts.retryMs == null ? 1000 : opts.retryMs;
    var maxRetryMs = opts.maxRetryMs == null ? 10000 : opts.maxRetryMs;
    var maxRetries = opts.maxRetries == null ? Infinity : opts.maxRetries;
    var replyTimeoutMs = opts.replyTimeoutMs == null ? 6000 : opts.replyTimeoutMs;
    var token = opts.token || null;
    var transport = null;
    var status = 'idle';
    var view = null;
    var everConnected = false;
    var retries = 0;
    var delay = 0;
    var retryTimer = null;
    var replyTimer = null;
    var attempt = 0;
    var inFlight = false; // transport.connect() hasn't settled yet
    var joinStarted = 0;
    var clock = opts.clock || now;
    var pingCount = opts.pingCount == null ? 0 : opts.pingCount;
    var pingGapMs = opts.pingGapMs == null ? 150 : opts.pingGapMs;
    var pingEveryMs = opts.pingEveryMs == null ? 30000 : opts.pingEveryMs;
    var samples = [];
    var clockEst = null; // { offset, rtt, n, at }
    var pingTimer = null;
    var pingRound = 0;
    var selfInfo = { spotifyReady: false };
    // Diagnostics.
    var attempts = 0;
    var lastError = null;
    var lastAttemptAt = 0;
    var connectedAt = 0;
    var lastDiag = null;
    var relay = false;
    var iceFailures = 0;

    function setStatus(s, detail) {
      status = s;
      if (detail && detail.code) lastError = { code: detail.code, message: detail.message || '', at: now() };
      if (hooks.onStatus) hooks.onStatus(s, detail || null);
    }

    function closeTransport() {
      if (transport) {
        try { if (transport.diag) lastDiag = transport.diag(); } catch (e) { /* ignore */ }
        try { transport.close(); } catch (e) { /* ignore */ }
      }
      transport = null;
      if (pingTimer != null) timers.clearTimeout(pingTimer);
      pingTimer = null;
    }

    /** What this phone tells the host about itself (hello / sync). */
    function infoBody(isHello) {
      var b = {};
      // hello: only what is known (a phone without Spotify says nothing about it).
      if (!isHello || selfInfo.spotifyReady) b.spotifyReady = !!selfInfo.spotifyReady;
      if (clockEst) { b.clockOffset = clockEst.offset; b.rtt = clockEst.rtt; }
      return b;
    }

    /** A clock-sync round: pingCount pings, then (if it changed) tell the host the offset. */
    function pingRoundStart(t, my) {
      if (pingTimer != null) timers.clearTimeout(pingTimer);
      var round = ++pingRound;
      var sent = 0;
      (function next() {
        pingTimer = null;
        if (my !== attempt || round !== pingRound || transport !== t) return;
        if (sent < pingCount) {
          sent++;
          try { t.send('host', message('ping', { t0: clock() })); } catch (e) { /* the leave handler retries */ }
          pingTimer = timers.setTimeout(next, pingGapMs);
          return;
        }
        // Give the last pong a moment, then settle.
        pingTimer = timers.setTimeout(function () {
          pingTimer = null;
          if (my !== attempt || round !== pingRound || transport !== t) return;
          var est = estimateClockOffset(samples.slice(-pingCount * 2));
          if (est) {
            var changed = !clockEst || Math.abs(est.offset - clockEst.offset) > 10 || !clockEst.sent;
            clockEst = Object.assign(est, { at: now(), sent: clockEst && !changed ? clockEst.sent : false });
            if (hooks.onClock) hooks.onClock(Object.assign({}, clockEst));
            if (changed && status === 'connected') {
              try { t.send('host', message('sync', infoBody(true))); clockEst.sent = true; } catch (e) { /* ignore */ }
            }
          }
          if (pingEveryMs > 0) pingTimer = timers.setTimeout(function () { pingRoundStart(t, my); }, pingEveryMs);
        }, Math.max(pingGapMs, 300));
      })();
    }

    function clearTimers() {
      if (retryTimer != null) timers.clearTimeout(retryTimer);
      if (replyTimer != null) timers.clearTimeout(replyTimer);
      retryTimer = null;
      replyTimer = null;
    }

    function stop(s, detail) {
      attempt++;
      inFlight = false;
      clearTimers();
      closeTransport();
      setStatus(s, detail);
    }

    /** The attempt failed or the host went away: try again later (or give up). */
    function scheduleRetry(err) {
      if (status === 'left' || status === 'failed') return;
      if (err && err.code === 'webrtc-unsupported') { stop('failed', err); return; }
      if (err && err.code === 'ice-failed') {
        // No path between the devices: try TURN relays only next (and alternate after that).
        iceFailures++;
        relay = !relay;
      }
      attempt++;
      inFlight = false;
      clearTimers();
      closeTransport();
      var wait;
      if (!everConnected) {
        if (now() - joinStarted >= joinWaitMs) {
          setStatus('failed', err || { code: 'timeout', message: 'Couldn’t reach the host.' });
          return;
        }
        wait = joinRetryMs;
        setStatus('waiting', err);
      } else {
        if (retries >= maxRetries) {
          setStatus('failed', { code: 'host-left', message: 'The host left the game.' });
          return;
        }
        retries++;
        delay = delay ? Math.min(delay * 2, maxRetryMs) : retryMs;
        wait = delay;
        setStatus('reconnecting', err);
      }
      retryTimer = timers.setTimeout(function () { retryTimer = null; connect(); }, wait);
    }

    function sendHello(t) {
      try { t.send('host', message('hello', Object.assign({ name: opts.name, token: token }, infoBody(true)))); } catch (e) { /* the leave handler retries */ }
    }

    function connect() {
      closeTransport();
      clearTimers();
      var my = ++attempt;
      attempts++;
      lastAttemptAt = now();
      var t;
      try { t = opts.makeTransport({ relay: relay }); } catch (e) {
        scheduleRetry({ code: (e && e.code) || 'transport', message: (e && e.message) || 'Couldn’t connect.' });
        return;
      }
      transport = t;
      inFlight = true;
      if (!everConnected && status !== 'waiting') setStatus('connecting');
      t.onMessage(function (from, msg) {
        if (my !== attempt || !msg || typeof msg !== 'object') return;
        if (msg.type === 'state' && msg.state) {
          if (replyTimer != null) { timers.clearTimeout(replyTimer); replyTimer = null; }
          view = msg.state;
          if (view.you && view.you.token && view.you.token !== token) {
            token = view.you.token;
            if (hooks.onToken) hooks.onToken(token);
          }
          everConnected = true;
          retries = 0;
          delay = 0;
          if (status !== 'connected') { connectedAt = now(); setStatus('connected'); }
          if (hooks.onState) hooks.onState(view);
        } else if (msg.type === 'playback' && msg.playback) {
          if (view) view.playback = msg.playback;
          if (hooks.onPlayback) hooks.onPlayback(msg.playback);
        } else if (msg.type === 'pong') {
          var t0 = Number(msg.t0);
          var ht = Number(msg.ht);
          if (isFinite(t0) && isFinite(ht)) {
            samples.push({ t0: t0, ht: ht, t1: clock() });
            if (samples.length > 40) samples.splice(0, samples.length - 40);
          }
        } else if (msg.type === 'play') {
          if (hooks.onPlay) hooks.onPlay(msg);
        } else if (msg.type === 'preload') {
          if (hooks.onPreload) hooks.onPreload(msg);
        } else if (msg.type === 'halt') {
          if (hooks.onHalt) hooks.onHalt(msg);
        } else if (msg.type === 'error') {
          var err = { code: msg.code || 'error', message: msg.message || 'Something went wrong.' };
          if (FATAL_ERRORS.indexOf(err.code) !== -1) stop('failed', err);
          // The host restarted or marked us offline while this connection lived on: say hello again.
          else if (err.code === 'not-joined') sendHello(t);
          else if (hooks.onError) hooks.onError(err);
        }
      });
      t.onPeerLeave(function () {
        if (my !== attempt) return;
        scheduleRetry({ code: 'host-left', message: 'Lost the connection to the host.' });
      });
      t.connect(opts.code).then(function () {
        if (my !== attempt) return;
        inFlight = false;
        sendHello(t);
        if (pingCount > 0) pingRoundStart(t, my);
      }, function (err) {
        if (my !== attempt) return;
        inFlight = false;
        scheduleRetry({ code: (err && err.code) || 'transport', message: (err && err.message) || 'Couldn’t connect.' });
      });
    }

    /** Ask the host for the current state; no answer in time means the connection is dead. */
    function requestSync() {
      var t = transport;
      var my = attempt;
      if (!t) return;
      try { t.send('host', message('sync', infoBody(true))); } catch (e) {
        scheduleRetry({ code: 'host-left', message: 'Lost the connection to the host.' });
        return;
      }
      if (!replyTimeoutMs) return;
      if (replyTimer != null) timers.clearTimeout(replyTimer);
      replyTimer = timers.setTimeout(function () {
        replyTimer = null;
        if (my !== attempt || status !== 'connected') return;
        scheduleRetry({ code: 'host-left', message: 'The host didn’t answer.' });
      }, replyTimeoutMs);
    }

    return {
      start: function () { retries = 0; delay = 0; joinStarted = now(); connect(); },
      /** Try again now (after 'failed', or to skip the wait). */
      retry: function () {
        retries = 0;
        delay = 0;
        clearTimers();
        if (!everConnected) joinStarted = now();
        setStatus(everConnected ? 'reconnecting' : 'connecting');
        connect();
      },
      /**
       * This page is visible / online again: `info.resumed` if it was hidden.
       * Connected: ask for a fresh state (and notice a dead connection).
       * Waiting to retry: retry now instead of after the backoff.
       */
      wake: function (info) {
        if (status === 'idle' || status === 'left' || status === 'failed') return;
        if (transport && transport.wake) { try { transport.wake(info || null); } catch (e) { /* ignore */ } }
        if (status === 'connected') {
          requestSync();
          // The clock may have jumped while the page slept.
          if (info && info.resumed && transport && pingCount > 0) pingRoundStart(transport, attempt);
          return;
        }
        if (retryTimer == null || inFlight) return; // an attempt is under way
        delay = 0;
        connect();
      },
      act: function (type, body) {
        if (!transport || status !== 'connected') return false;
        try { transport.send('host', message(type, body)); } catch (e) { return false; }
        return true;
      },
      leave: function () { stop('left'); },
      status: function () { return status; },
      view: function () { return view; },
      token: function () { return token; },
      /** Tell the host about this phone (spotifyReady); sent now if connected, else with the next hello. */
      setInfo: function (info) {
        var changed = false;
        if (info && typeof info.spotifyReady === 'boolean' && info.spotifyReady !== selfInfo.spotifyReady) {
          selfInfo.spotifyReady = info.spotifyReady;
          changed = true;
        }
        if (changed && transport && status === 'connected') {
          try { transport.send('host', message('sync', infoBody())); } catch (e) { /* ignore */ }
        }
        return changed;
      },
      /** The host's clock now, by this phone's estimate (null before the first clock sync). */
      hostNow: function () { return clockEst ? clock() + clockEst.offset : null; },
      clockInfo: function () { return clockEst ? { offset: clockEst.offset, rtt: clockEst.rtt, n: clockEst.n, at: clockEst.at } : null; },
      /** Diagnostics: attempts, last error, timestamps and the transport's connection details. */
      info: function () {
        var d = null;
        try { d = transport && transport.diag ? transport.diag() : lastDiag; } catch (e) { d = lastDiag; }
        return {
          status: status,
          attempts: attempts,
          lastError: lastError,
          joinStartedAt: joinStarted,
          lastAttemptAt: lastAttemptAt,
          connectedAt: connectedAt,
          relay: relay,
          iceFailures: iceFailures,
          clock: clockEst ? { offset: clockEst.offset, rtt: clockEst.rtt } : null,
          transport: d,
        };
      },
      /** The transport of the current attempt (for getStats), or null. */
      transport: function () { return transport; },
    };
  }

  // ---------- Saved rooms and rejoining (resume after a tab was closed or evicted) ----------

  var SAVE_VERSION = 1;
  var RESUME_MAX_AGE_MS = 12 * 60 * 60 * 1000;

  function isFresh(savedAt, o) {
    var t = o && o.now != null ? o.now : Date.now();
    var max = o && o.maxAgeMs != null ? o.maxAgeMs : RESUME_MAX_AGE_MS;
    var age = t - Number(savedAt);
    return age >= 0 && age < max; // NaN (no timestamp) is not fresh
  }

  /**
   * A hosted room as saved in localStorage (keyed by its code): the whole room,
   * including its game, players with their tokens and scores, used songs and
   * the track list, so resuming doesn't need to load the playlist again.
   * @param {object} meta { now, transport, owner (this tab's id), claimedAt }
   */
  function savedRoomEntry(room, meta) {
    meta = meta || {};
    return {
      kind: 'gts-room',
      v: SAVE_VERSION,
      savedAt: meta.now == null ? Date.now() : meta.now,
      transport: meta.transport || 'peer',
      owner: meta.owner || null,
      claimedAt: meta.claimedAt || 0,
      room: room,
    };
  }

  /** The room inside a saved entry, or a bare room (the sessionStorage copy); null if unusable. */
  function roomOf(saved, o) {
    if (!saved || typeof saved !== 'object') return null;
    var room = saved;
    if (saved.kind === 'gts-room') {
      if (saved.v !== SAVE_VERSION || !isFresh(saved.savedAt, o)) return null;
      if (o && o.transport && saved.transport !== o.transport) return null;
      room = saved.room;
    }
    if (!room || typeof room !== 'object' || room.version !== PROTOCOL || !normalizeCode(room.code)) return null;
    if (!Array.isArray(room.players) || !Array.isArray(room.tracks) || !room.tracks.length) return null;
    if (!room.settings || typeof room.settings !== 'object') return null;
    // Hand-edited or damaged storage must not break the page that reads it.
    if (!room.players.every(function (p) { return p && typeof p === 'object' && cleanName(p.name); })) return null;
    if (!room.tracks.every(function (t) { return t && typeof t === 'object' && t.id; })) return null;
    if (room.game && (!Array.isArray(room.game.tracks) || !Array.isArray(room.game.players))) return null;
    return room;
  }

  /**
   * Prepare a saved room to be hosted again. Connections didn't survive: every
   * phone is offline until it says hello again (with its token it gets its
   * slot, name and score back); a clip that was playing is stopped.
   * @param {object} saved   savedRoomEntry(...) or a bare room
   * @param {object} [o]     { now, maxAgeMs, transport }
   * @returns the room, or null (missing, too old, other version or transport, no tracks)
   */
  function restoreRoom(saved, o) {
    var room = roomOf(saved, o);
    if (!room) return null;
    room.players.forEach(function (p) {
      if (!p.local) { p.online = false; p.peerId = null; }
      p.spotifyReady = false; // said again by the phone's next hello
    });
    room.settings.soundOn = normalizeSoundOn(room.settings.soundOn);
    room.turn = room.turn && typeof room.turn === 'object' ? room.turn : { playedOnce: false, heard: 0 };
    room.playback = idlePlayback();
    room.playback.heard = Number(room.turn.heard) || 0;
    // Saved before clip lengths were configurable: 5 s, then 10 s more.
    room.settings.clip = G.normalizeClip(room.settings.clip);
    if (room.game) room.game.clip = G.clipOf(room.game);
    room.usedIds = Array.isArray(room.usedIds) ? room.usedIds : [];
    room.notes = Array.isArray(room.notes) ? room.notes : [];
    return room;
  }

  /** The newest resumable entry of a list (e.g. every saved room in localStorage), or null. */
  function pickResumableRoom(entries, o) {
    var best = null;
    (entries || []).forEach(function (e) {
      if (!e || e.kind !== 'gts-room' || !roomOf(e, o)) return;
      if (!best || e.savedAt > best.savedAt) best = e;
    });
    return best;
  }

  /**
   * A player's room, as saved in localStorage. `left`: the player pressed
   * Leave (no automatic rejoin, but the setup screen still offers it).
   */
  function savedJoinEntry(j, meta) {
    meta = meta || {};
    return {
      kind: 'gts-join',
      v: SAVE_VERSION,
      code: j.code,
      name: j.name,
      token: j.token || null,
      transport: meta.transport || 'peer',
      savedAt: meta.now == null ? Date.now() : meta.now,
      left: !!j.left,
    };
  }

  function validJoin(saved, o) {
    if (!saved || typeof saved !== 'object' || saved.kind !== 'gts-join' || saved.v !== SAVE_VERSION) return null;
    if (!normalizeCode(saved.code) || !cleanName(saved.name) || !isFresh(saved.savedAt, o)) return null;
    if (o && o.transport && saved.transport !== o.transport) return null;
    return saved;
  }

  /**
   * What a page should do on load for the player side.
   * @param {object} o
   *   urlCode      the ?room= code ('' if none)
   *   sessionJoin  {code, name} of the room this tab was in (sessionStorage: a reload), or null
   *   savedJoin    savedJoinEntry from localStorage, or null
   *   transport, now, maxAgeMs
   * @returns {{action: 'rejoin', code, name, token, source: 'session'|'saved'}
   *         | {action: 'form', code, name}            the join form, prefilled
   *         | {action: 'none', offer: savedJoin|null}} offer: show "Rejoin room ABCD" on setup
   */
  function rejoinDecision(o) {
    var saved = validJoin(o.savedJoin, o);
    var session = o.sessionJoin && normalizeCode(o.sessionJoin.code) && cleanName(o.sessionJoin.name) ? o.sessionJoin : null;
    function rejoin(code, name, source) {
      var tok = saved && saved.code === code && sameName(saved.name, name) ? saved.token : null;
      return { action: 'rejoin', code: code, name: cleanName(name), token: tok, source: source };
    }
    if (o.urlCode) {
      if (session && session.code === o.urlCode) return rejoin(o.urlCode, session.name, 'session');
      if (saved && saved.code === o.urlCode && !saved.left) return rejoin(o.urlCode, saved.name, 'saved');
      return { action: 'form', code: o.urlCode, name: saved && saved.code === o.urlCode ? saved.name : '' };
    }
    if (session) return rejoin(session.code, session.name, 'session');
    if (saved && !saved.left) return rejoin(saved.code, saved.name, 'saved');
    return { action: 'none', offer: saved };
  }

  return {
    PROTOCOL: PROTOCOL,
    CODE_ALPHABET: CODE_ALPHABET,
    CODE_LENGTH: CODE_LENGTH,
    MAX_PLAYERS: MAX_PLAYERS,
    FATAL_ERRORS: FATAL_ERRORS,
    generateCode: generateCode,
    normalizeCode: normalizeCode,
    peerIdFor: peerIdFor,
    joinLink: joinLink,
    cleanName: cleanName,
    generateToken: generateToken,
    message: message,
    createRoom: createRoom,
    roomClip: roomClip,
    clipSegment: clipSegment,
    previewFitNote: previewFitNote,
    phaseOf: phaseOf,
    playerById: playerById,
    playerByPeer: playerByPeer,
    currentPlayer: currentPlayer,
    join: join,
    addLocalPlayer: addLocalPlayer,
    removePlayer: removePlayer,
    leave: leave,
    canStart: canStart,
    startGame: startGame,
    applyAction: applyAction,
    notePlayback: notePlayback,
    playerView: playerView,
    playerScreen: playerScreen,
    soundEverywhere: soundEverywhere,
    estimateClockOffset: estimateClockOffset,
    preloadMessageFor: preloadMessageFor,
    playMessageFor: playMessageFor,
    notePlayerInfo: notePlayerInfo,
    createHost: createHost,
    createPlayer: createPlayer,
    RESUME_MAX_AGE_MS: RESUME_MAX_AGE_MS,
    savedRoomEntry: savedRoomEntry,
    restoreRoom: restoreRoom,
    pickResumableRoom: pickResumableRoom,
    savedJoinEntry: savedJoinEntry,
    rejoinDecision: rejoinDecision,
  };
});
