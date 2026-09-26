/*
 * Pure game logic shared by the browser (window.GameLogic) and the Node tests
 * (require('../public/game-logic.js')). No DOM access in here.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.GameLogic = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var CLIP_SHORT = 5; // seconds heard first
  var CLIP_LONG = 15; // seconds heard after "play next 10 seconds"
  var POINTS = { short: 10, extended: 5 };

  // ---------- Text normalisation & fuzzy matching ----------

  function stripDiacritics(s) {
    return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  }

  /** Lowercase, drop accents and punctuation, "&" -> "and", collapse spaces. */
  function basicNormalize(s) {
    return stripDiacritics(String(s || ''))
      .toLowerCase()
      .replace(/[\u2018\u2019\u02bc`']/g, '') // don't -> dont
      .replace(/&/g, ' and ')
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /** Remove "(feat. X)", "[Remastered]", "feat. X", " - Remastered 2011", etc. */
  function stripDecorations(s) {
    var out = String(s || '');
    out = out.replace(/\([^)]*\)|\[[^\]]*\]|\{[^}]*\}/g, ' ');
    // A bare "with" is usually part of the title ("Stay With Me"); "(with X)" is caught above.
    out = out.replace(/\s(?:feat\.?|ft\.?|featuring)\s.*$/i, ' ');
    out = out.replace(/\s[-\u2013\u2014]\s.*$/, ' ');
    return out;
  }

  /** All acceptable normalised forms of a song title. */
  function titleVariants(title) {
    var set = {};
    var full = basicNormalize(title);
    var core = basicNormalize(stripDecorations(title));
    [full, core].forEach(function (v) {
      if (v) {
        set[v] = true;
        if (v.indexOf('the ') === 0 && v.length > 6) set[v.slice(4)] = true;
      }
    });
    return Object.keys(set);
  }

  function levenshtein(a, b) {
    if (a === b) return 0;
    if (!a.length) return b.length;
    if (!b.length) return a.length;
    var prev = new Array(b.length + 1);
    var cur = new Array(b.length + 1);
    for (var j = 0; j <= b.length; j++) prev[j] = j;
    for (var i = 1; i <= a.length; i++) {
      cur[0] = i;
      for (var k = 1; k <= b.length; k++) {
        var cost = a.charCodeAt(i - 1) === b.charCodeAt(k - 1) ? 0 : 1;
        cur[k] = Math.min(prev[k] + 1, cur[k - 1] + 1, prev[k - 1] + cost);
      }
      var tmp = prev; prev = cur; cur = tmp;
    }
    return prev[b.length];
  }

  /** 0..1 similarity based on Levenshtein distance. */
  function similarity(a, b) {
    if (!a && !b) return 1;
    var max = Math.max(a.length, b.length);
    return max ? 1 - levenshtein(a, b) / max : 1;
  }

  /** How close must a guess be? Short titles need to be (nearly) exact. */
  function threshold(len) {
    if (len <= 3) return 1;
    if (len <= 6) return 0.8; // one typo in a 5-6 letter title
    return 0.75;
  }

  function numbersOf(s) {
    return (s.match(/\d+/g) || []).join(' ');
  }

  function matchesTitle(guessNorm, variants) {
    if (!guessNorm) return false;
    for (var i = 0; i < variants.length; i++) {
      var v = variants[i];
      var g = guessNorm;
      if (g.indexOf('the ') === 0 && v.indexOf('the ') !== 0 && g.length > 6) g = g.slice(4);
      if (numbersOf(g) !== numbersOf(v)) continue; // "8 rings" is not "7 rings"
      if (g.replace(/ /g, '') === v.replace(/ /g, '')) return true; // "ymca" == "y m c a"
      if (similarity(g, v) >= threshold(v.length)) return true;
    }
    return false;
  }

  function artistVariants(artist) {
    var parts = String(artist || '').split(/,|&|\band\b|\bx\b|\bfeat\.?|\bft\.?/i);
    var out = [basicNormalize(artist)];
    parts.forEach(function (p) {
      var n = basicNormalize(p);
      if (n) out.push(n);
    });
    return out.filter(Boolean);
  }

  function isArtist(guessNorm, artist) {
    var vs = [];
    artistVariants(artist).forEach(function (a) {
      vs.push(a);
      if (a.indexOf('the ') === 0 && a.length > 6) vs.push(a.slice(4));
    });
    return matchesTitle(guessNorm, vs);
  }

  /**
   * Lenient free-answer check. Accepts:
   *   "title", "title - artist", "artist - title", "title by artist",
   *   "title artist" (artist appended without a separator)
   * with case/punctuation/accents/"(feat. ...)" ignored and small typos allowed.
   */
  function checkAnswer(guess, track) {
    var raw = String(guess || '').trim();
    if (!raw) return false;
    var variants = titleVariants(track.title);
    var candidates = [raw, stripDecorations(raw)];

    // Split on separators: "title - artist", "artist - title", "title by artist", "title / artist".
    // Only two-part guesses, and the second part only counts as the title when the
    // first names the artist, so "A / B / C" can't be used to guess several titles at once.
    var sepParts = raw.split(/\s+[-\u2013\u2014/|:]\s+|\s+by\s+/i);
    if (sepParts.length === 2) {
      candidates.push(sepParts[0]);
      if (isArtist(basicNormalize(sepParts[0]), track.artist)) candidates.push(sepParts[1]);
    }

    for (var i = 0; i < candidates.length; i++) {
      if (matchesTitle(basicNormalize(candidates[i]), variants)) return true;
    }

    // "title artist" with no separator: strip a trailing/leading artist name.
    var g = basicNormalize(raw);
    var artists = artistVariants(track.artist);
    for (var a = 0; a < artists.length; a++) {
      var art = artists[a];
      if (art.length < 2) continue;
      if (g.length > art.length && g.slice(-art.length) === art) {
        if (matchesTitle(g.slice(0, -art.length).trim(), variants)) return true;
      }
      if (g.length > art.length && g.indexOf(art + ' ') === 0) {
        if (matchesTitle(g.slice(art.length).trim(), variants)) return true;
      }
    }
    return false;
  }

  // ---------- Randomness helpers ----------

  function shuffle(arr, rng) {
    rng = rng || Math.random;
    var a = arr.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(rng() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  /**
   * Build multiple-choice options: the answer + up to (n-1) distractors from the
   * pool whose titles are distinct from the answer and each other.
   * Distractors are drawn from tracks not in `playedIds` first: since songs never
   * repeat, an already-played option could otherwise be ruled out by the players.
   * Returns [{id, title, artist}] in random order (no "correct" flag).
   */
  function buildOptions(track, pool, n, rng, playedIds) {
    n = n || 4;
    var seen = {};
    seen[basicNormalize(stripDecorations(track.title))] = true;
    var played = {};
    (playedIds || []).forEach(function (id) { played[id] = true; });
    var others = pool.filter(function (t) { return t.id !== track.id; });
    var distractors = [];
    var candidates = shuffle(others.filter(function (t) { return !played[t.id]; }), rng)
      .concat(shuffle(others.filter(function (t) { return played[t.id]; }), rng));
    for (var i = 0; i < candidates.length && distractors.length < n - 1; i++) {
      var key = basicNormalize(stripDecorations(candidates[i].title));
      if (!key || seen[key]) continue;
      seen[key] = true;
      distractors.push(candidates[i]);
    }
    return shuffle([track].concat(distractors), rng).map(function (t) {
      return { id: t.id, title: t.title, artist: t.artist };
    });
  }

  /** Number of distinct titles in a track list (limits multiple-choice option count). */
  function distinctTitleCount(tracks) {
    var seen = {};
    var c = 0;
    tracks.forEach(function (t) {
      var k = basicNormalize(stripDecorations(t.title));
      if (k && !seen[k]) { seen[k] = true; c++; }
    });
    return c;
  }

  // ---------- Game state ----------

  /**
   * @param {object} cfg
   * @param {string[]} cfg.players
   * @param {'choice'|'free'} cfg.mode
   * @param {number|null} cfg.rounds  null/0 = until songs run out
   * @param {Array} cfg.tracks        tracks from /api/tracks
   * @param {string[]} [cfg.usedIds]  ids already played this session
   * @param {object} [cfg.source]
   */
  function createGame(cfg) {
    var used = (cfg.usedIds || []).slice();
    var usedSet = {};
    used.forEach(function (id) { usedSet[id] = true; });
    var remaining = cfg.tracks.filter(function (t) { return !usedSet[t.id]; });
    var players = cfg.players.map(function (name) { return { name: name, score: 0, correct: 0 }; });
    var rounds = cfg.rounds && cfg.rounds > 0 ? Math.floor(cfg.rounds) : null;
    return {
      version: 1,
      source: cfg.source || null,
      sourceUrl: cfg.sourceUrl || '',
      mode: cfg.mode === 'free' ? 'free' : 'choice',
      rounds: rounds,
      totalTurns: rounds ? rounds * players.length : null,
      players: players,
      tracks: cfg.tracks,
      queue: shuffle(remaining, cfg.rng).map(function (t) { return t.id; }),
      usedIds: used,
      turn: 0, // index of the current turn (0-based)
      current: null, // { trackId, extended, options, answered, outcome, points, guess }
      history: [],
      phase: 'round', // 'round' | 'result' | 'over'
    };
  }

  function trackById(game, id) {
    for (var i = 0; i < game.tracks.length; i++) if (game.tracks[i].id === id) return game.tracks[i];
    return null;
  }

  function currentPlayerIndex(game) {
    return game.turn % game.players.length;
  }

  function roundNumber(game) {
    return Math.floor(game.turn / game.players.length) + 1;
  }

  function isOver(game) {
    if (game.totalTurns !== null && game.turn >= game.totalTurns) return true;
    return game.queue.length === 0;
  }

  /** Start the next turn: take a fresh (never-played) track off the queue. */
  function startTurn(game, rng) {
    if (isOver(game)) {
      game.phase = 'over';
      game.current = null;
      return null;
    }
    var id = game.queue.shift();
    game.usedIds.push(id); // counts as used as soon as it is heard
    var track = trackById(game, id);
    var optionCount = Math.min(4, distinctTitleCount(game.tracks));
    var options = null;
    if (game.mode === 'choice' && optionCount >= 2) {
      options = buildOptions(track, game.tracks, optionCount, rng, game.usedIds);
    }
    game.current = { trackId: id, extended: false, options: options, answered: false, outcome: null, points: 0, guess: '' };
    game.phase = 'round';
    return game.current;
  }

  /**
   * Record an answer for the current turn.
   * @param {'guess'|'reveal'|'skip'} kind
   * @param {string} [value] free text or chosen option id
   */
  function answer(game, kind, value) {
    var cur = game.current;
    if (!cur || cur.answered) return cur;
    var track = trackById(game, cur.trackId);
    var correct = false;
    if (kind === 'guess') {
      if (cur.options) correct = value === track.id;
      else correct = checkAnswer(value, track);
    }
    cur.answered = true;
    cur.guess = kind === 'guess' ? String(value || '') : '';
    if (kind === 'guess' && cur.options) {
      var chosen = cur.options.filter(function (o) { return o.id === value; })[0];
      cur.guess = chosen ? chosen.title : '';
    }
    cur.outcome = kind === 'guess' ? (correct ? 'correct' : 'wrong') : kind === 'reveal' ? 'revealed' : 'skipped';
    cur.points = correct ? (cur.extended ? POINTS.extended : POINTS.short) : 0;
    var p = game.players[currentPlayerIndex(game)];
    p.score += cur.points;
    if (correct) p.correct += 1;
    game.history.push({
      turn: game.turn,
      player: p.name,
      trackId: cur.trackId,
      outcome: cur.outcome,
      points: cur.points,
      extended: cur.extended,
    });
    game.phase = 'result';
    return cur;
  }

  function nextTurn(game, rng) {
    game.turn += 1;
    game.current = null;
    return startTurn(game, rng);
  }

  /** Players sorted by score (desc) with shared ranks for ties. */
  function standings(game) {
    var sorted = game.players
      .map(function (p, i) { return { name: p.name, score: p.score, correct: p.correct, index: i }; })
      .sort(function (a, b) { return b.score - a.score || b.correct - a.correct || a.index - b.index; });
    var rank = 0;
    var prev = null;
    sorted.forEach(function (p, i) {
      if (prev === null || p.score !== prev) rank = i + 1;
      p.rank = rank;
      prev = p.score;
    });
    return sorted;
  }

  return {
    CLIP_SHORT: CLIP_SHORT,
    CLIP_LONG: CLIP_LONG,
    POINTS: POINTS,
    basicNormalize: basicNormalize,
    stripDecorations: stripDecorations,
    titleVariants: titleVariants,
    levenshtein: levenshtein,
    similarity: similarity,
    checkAnswer: checkAnswer,
    shuffle: shuffle,
    buildOptions: buildOptions,
    distinctTitleCount: distinctTitleCount,
    createGame: createGame,
    trackById: trackById,
    currentPlayerIndex: currentPlayerIndex,
    roundNumber: roundNumber,
    isOver: isOver,
    startTurn: startTurn,
    answer: answer,
    nextTurn: nextTurn,
    standings: standings,
  };
});
