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
  var MAX_CLIP_START = 15; // "random spot" offsets are 0..15s, so offset+15 always fits a 30s preview

  // ---------- Clip start (where in the preview the clip begins) ----------

  /**
   * Pick where a song's clip should start within its preview.
   * 'beginning' (or anything else) always starts at 0. 'random' picks a whole
   * second in [0, MAX_CLIP_START] so the 15-second clip still fits a 30s preview.
   */
  function pickClipStart(mode, rng) {
    rng = rng || Math.random;
    if (mode === 'random') return Math.floor(rng() * (MAX_CLIP_START + 1));
    return 0;
  }

  /**
   * Fit a clip start offset to the preview's actual duration. When the duration
   * isn't known yet (not finite/positive), the offset is returned unchanged —
   * previews are normally 30s, so this only matters once metadata has loaded.
   * A preview too short to fit any 15-second clip falls back to 0.
   */
  function clampClipStart(offset, duration) {
    offset = offset || 0;
    if (!isFinite(duration) || duration <= 0) return offset;
    var maxStart = Math.floor(duration - CLIP_LONG);
    if (maxStart <= 0) return 0;
    return Math.min(offset, maxStart);
  }

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

  // Number words -> digits, so "seven rings" == "7 rings" and "song two" == "song 2".
  var UNITS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
    'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
  var TENS = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
  var WORD_NUM = {};
  UNITS.forEach(function (w, i) { WORD_NUM[w] = i; });
  // A few spelling variants people type that mean the same thing.
  var TOKEN_ALIASES = { mister: 'mr', n: 'and' };

  /** basicNormalize + number words as digits ("twenty two" -> "22") + a few aliases. */
  function canon(s) {
    var toks = basicNormalize(s).split(' ');
    var out = [];
    for (var i = 0; i < toks.length; i++) {
      var t = toks[i];
      if (!t) continue;
      if (TOKEN_ALIASES.hasOwnProperty(t)) { out.push(TOKEN_ALIASES[t]); continue; }
      if (TENS.hasOwnProperty(t)) {
        var n = TENS[t];
        var next = toks[i + 1];
        if (next && WORD_NUM.hasOwnProperty(next) && WORD_NUM[next] > 0 && WORD_NUM[next] < 10) { n += WORD_NUM[next]; i++; }
        out.push(String(n));
        continue;
      }
      out.push(WORD_NUM.hasOwnProperty(t) ? String(WORD_NUM[t]) : t);
    }
    return out.join(' ');
  }

  // "Pt. 2", ", Part II", "(Part 2)", "- Part Two", "Vol. 2": an optional part of the title.
  var PART_RE = /(?:,\s*|\s*[-\u2013\u2014]\s*|\s*[(\[]\s*|\s+|^)(?:pt|part|vol|volume)(?:\.\s*|\s+|(?=\d))(\d+|[ivx]{1,4}|one|two|three|four|five|six|seven|eight|nine|ten)\b\s*[)\]]?/i;
  var ROMAN = { i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9, x: 10 };

  /** Split a part suffix off: "Another Brick In The Wall, Pt. 2" -> { text: "Another Brick In The Wall", part: "2" }. */
  function extractPart(s) {
    s = String(s || '');
    var m = s.match(PART_RE);
    if (!m) return { text: s, part: null };
    var p = m[1].toLowerCase();
    var n = /^\d+$/.test(p) ? parseInt(p, 10) : ROMAN.hasOwnProperty(p) ? ROMAN[p] : WORD_NUM[p];
    if (n === undefined) return { text: s, part: null };
    return { text: (s.slice(0, m.index) + ' ' + s.slice(m.index + m[0].length)).trim(), part: String(n) };
  }

  // Text that describes a version rather than naming a song: "Remastered 2011", "Live at Wembley",
  // "Radio Edit", "From "Saturday Night Fever" Soundtrack", "feat. X", "2011", "Explicit"...
  var DECOR_START = /^(?:\d{4}\s+)?(?:digital(?:ly)?\s+)?(?:re-?master(?:ed)?|live|radio|single|album|mono|stereo|edit|extended|original|from|bonus|demo|acoustic|deluxe|feat|ft|featuring|with|explicit|clean|spotify|instrumental|remix|mix|version|recorded|session|unplugged|anniversary|expanded)\b/i;
  var DECOR_END = /\b(?:re-?master(?:ed)?|mix|remix|version|edit|edition|soundtrack|recording|take)\s*(?:\d{4})?$/i;
  function isDecorationText(s) {
    var t = String(s || '').replace(/^[\s(\[{"]+|[\s)\]}".]+$/g, '');
    if (!t) return false;
    return /^\d{4}$/.test(t) || DECOR_START.test(t) || DECOR_END.test(t);
  }

  /** Drop bracketed decorations ("(feat. X)", "[Explicit]", "(Remastered)") but keep other bracket text. */
  function stripDecorationBrackets(s) {
    return String(s || '').replace(/\(([^)]*)\)|\[([^\]]*)\]|\{([^}]*)\}/g, function (all, a, b, c) {
      var inner = a !== undefined ? a : b !== undefined ? b : c;
      return isDecorationText(inner) ? ' ' : ' ' + inner + ' ';
    });
  }

  function stripFeat(s) {
    return String(s || '').replace(/\s(?:feat\.?|ft\.?|featuring)\s.*$/i, ' ');
  }

  var STOPWORDS = { the: 1, a: 1, an: 1, of: 1, in: 1, on: 1, to: 1, and: 1 };
  function contentTokens(norm) {
    return norm.split(' ').filter(function (t) { return t && !STOPWORDS[t]; });
  }

  /**
   * Everything a title can be matched against.
   * @returns {{ part: string|null, variants: Array<{ norm: string, kind: 'exact'|'close' }> }}
   * `kind` is the best verdict a match on that variant can earn (prefix matches are only "close").
   */
  function titleInfo(title) {
    var raw = String(title || '');
    var p = extractPart(raw);
    // "Heart of Glass: Special Edition", "Stairway to Heaven, Live in Tokyo": a version note after , or :
    p.text = p.text.replace(/\s*[,:]\s+([^,:]*?)(\s[-\u2013\u2014]\s.*)?$/, function (all, rest, dash) {
      return isDecorationText(rest) ? ' ' + (dash || '') : all;
    });
    var list = [];
    var seen = {};
    function add(norm, kind) {
      if (!norm || seen[norm]) return;
      seen[norm] = true;
      list.push({ norm: norm, kind: kind });
      if (norm.indexOf('the ') === 0 && norm.length > 6 && !seen[norm.slice(4)]) {
        seen[norm.slice(4)] = true;
        list.push({ norm: norm.slice(4), kind: kind });
      }
      // A leading honorific is optional ("brightside" for "Mr. Brightside"; "mister" is already "mr"),
      // but only when enough title is left: "jones" stays too short to count for "Mr. Jones".
      var h = norm.match(/^(?:mr|mrs|ms|dr) (.+)$/);
      if (h && h[1].length >= 6 && !seen[h[1]]) {
        seen[h[1]] = true;
        list.push({ norm: h[1], kind: 'close' });
      }
    }
    add(canon(stripDecorations(p.text)), 'exact'); // "another brick in the wall", "satisfaction"
    // Keep non-decoration bracket text: "(I Can't Get No) Satisfaction" -> "i cant get no satisfaction".
    add(canon(stripFeat(stripDecorationBrackets(p.text)).replace(/\s[-\u2013\u2014]\s.*$/, ' ')), 'exact');
    add(canon(p.text), 'exact'); // the whole title, decorations and all (minus the part)
    // Up to the first comma/colon/bracket, if that still names at least two real words.
    var head = canon(p.text.split(/[,:(\[{]|\s[-\u2013\u2014]\s/)[0]);
    if (contentTokens(head).length >= 2) add(head, 'close');
    return { part: p.part, variants: list };
  }

  /** All acceptable normalised forms of a song title. */
  function titleVariants(title) {
    return titleInfo(title).variants.map(function (v) { return v.norm; });
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

  /** Levenshtein distance where swapping two adjacent letters ("septmeber") costs 1 (optimal string alignment). */
  function typoDistance(a, b) {
    if (a === b) return 0;
    var d = [];
    for (var i = 0; i <= a.length; i++) { d[i] = [i]; }
    for (var j = 1; j <= b.length; j++) d[0][j] = j;
    for (i = 1; i <= a.length; i++) {
      for (j = 1; j <= b.length; j++) {
        var cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
        d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
        if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
    return d[a.length][b.length];
  }

  /** 0..1 similarity based on Levenshtein distance. */
  function similarity(a, b) {
    if (!a && !b) return 1;
    var max = Math.max(a.length, b.length);
    return max ? 1 - levenshtein(a, b) / max : 1;
  }

  function typoSimilarity(a, b) {
    var max = Math.max(a.length, b.length);
    return max ? 1 - typoDistance(a, b) / max : 1;
  }

  /** How close must a title guess be? Up to 4 letters: exact; 5: exact bar doubled letters; 6+: one typo per 5. */
  function titleThreshold(len) {
    if (len <= 4) return 1;
    if (len <= 5) return 0.85;
    return 0.8;
  }

  /** Artist names are matched a bit more loosely ("adel" for "Adele"). */
  function artistThreshold(len) {
    if (len <= 3) return 1;
    if (len <= 6) return 0.8;
    return 0.75;
  }

  function numbersOf(s) {
    return (s.match(/\d+/g) || []).join(' ');
  }

  function sameTokenSet(a, b) {
    var ta = contentTokens(a);
    var tb = contentTokens(b);
    if (!ta.length || ta.length !== tb.length) return false;
    var count = {};
    ta.forEach(function (t) { count[t] = (count[t] || 0) + 1; });
    for (var i = 0; i < tb.length; i++) {
      if (!count[tb[i]]) return false;
      count[tb[i]]--;
    }
    return true;
  }

  function collapseRepeats(s) {
    return s.replace(/ /g, '').replace(/(.)\1+/g, '$1');
  }

  /**
   * Compare one normalised guess with one normalised title variant.
   * @returns {'exact'|'close'|null}
   */
  function compareTitle(g, v, part) {
    if (!g || !v) return null;
    var forms = [g];
    // "another brick in the wall 2" for "..., Pt. 2": a bare trailing part number.
    if (part && g.slice(-(part.length + 1)) === ' ' + part && numbersOf(v).split(' ').indexOf(part) === -1) {
      forms.push(g.slice(0, -(part.length + 1)));
    }
    if (g.indexOf('the ') === 0 && v.indexOf('the ') !== 0 && g.length > 6) forms.push(g.slice(4));
    var best = null;
    for (var i = 0; i < forms.length; i++) {
      var f = forms[i];
      if (!f) continue;
      if (numbersOf(f) !== numbersOf(v)) continue; // "8 rings" is not "7 rings"
      if (f === v || f.replace(/ /g, '') === v.replace(/ /g, '')) return 'exact'; // "ymca" == "y m c a"
      if (sameTokenSet(f, v)) { best = 'close'; continue; } // word order, "the"/"a" slips
      if (v.length > 4 && collapseRepeats(f) === collapseRepeats(v)) { best = 'close'; continue; } // "helo"
      if (typoSimilarity(f, v) >= titleThreshold(v.length)) best = 'close';
    }
    return best;
  }

  function looseEquals(g, v) {
    if (!g || !v) return false;
    if (g.indexOf('the ') === 0 && v.indexOf('the ') !== 0 && g.length > 6) g = g.slice(4);
    if (numbersOf(g) !== numbersOf(v)) return false;
    if (g.replace(/ /g, '') === v.replace(/ /g, '')) return true;
    return similarity(g, v) >= artistThreshold(v.length);
  }

  function artistVariants(artist) {
    var parts = String(artist || '').split(/,|&|\band\b|\bx\b|\bfeat\.?|\bft\.?/i);
    var out = [canon(artist)];
    parts.forEach(function (p) {
      var n = canon(p);
      if (n) out.push(n);
    });
    var all = [];
    out.forEach(function (a) {
      if (a.length < 2) return;
      all.push(a);
      if (a.indexOf('the ') === 0 && a.length > 6) all.push(a.slice(4));
    });
    return all;
  }

  /** Does this (already normalised) text name the track's artist, allowing small typos? */
  function isArtist(guessNorm, artist) {
    var vs = artistVariants(artist);
    for (var i = 0; i < vs.length; i++) if (looseEquals(guessNorm, vs[i])) return true;
    return false;
  }

  // Separators people put between title and artist: " - ", " / ", " | ", ": ", " by ".
  var SEP_RE = /\s+[-\u2013\u2014/|]\s+|\s*:\s+|\s+by\s+/gi;

  /**
   * The pieces of a guess that could be the title: the guess itself, and with the
   * artist (before or after, with or without a separator) or version notes removed.
   * A piece next to a separator only counts when the other side is the artist or a
   * version note, so "yesterday / hello" can't be used to guess two titles at once.
   */
  function guessCandidates(text, artist) {
    var out = [];
    function push(s) {
      var forms = [s, stripFeat(s), stripFeat(stripDecorationBrackets(s)), String(s).replace(/\([^)]*\)|\[[^\]]*\]|\{[^}]*\}/g, ' ')];
      forms.forEach(function (f) { out.push(canon(f)); });
    }
    // Drop trailing version notes: "Hey Jude - Remastered", "Title - Live - 2011".
    var t = String(text);
    var m;
    while ((m = t.match(/^(.*\S)\s+[-\u2013\u2014]\s+([^-\u2013\u2014]+)$/)) && isDecorationText(m[2])) t = m[1];
    push(t);
    if (t !== text) push(text);

    SEP_RE.lastIndex = 0;
    var seps = [];
    while ((m = SEP_RE.exec(t))) seps.push({ start: m.index, end: m.index + m[0].length });
    seps.forEach(function (sp) {
      var left = t.slice(0, sp.start);
      var right = t.slice(sp.end);
      var ln = canon(left);
      var rn = canon(right);
      if (!ln || !rn) return;
      if (isArtist(rn, artist) || isDecorationText(right)) push(left);
      if (isArtist(ln, artist)) push(right);
    });

    // "pink floyd another brick in the wall" / "global warming pitbull": artist without a separator.
    var toks = canon(t).split(' ');
    for (var k = 1; k < toks.length; k++) {
      var head = toks.slice(0, k).join(' ');
      var tail = toks.slice(k).join(' ');
      if (isArtist(head, artist)) out.push(tail);
      if (isArtist(tail, artist)) out.push(head);
    }
    var seen = {};
    return out.filter(function (c) {
      if (!c || seen[c]) return false;
      seen[c] = true;
      return true;
    });
  }

  /**
   * Free-answer check with a verdict for the UI.
   * Accepts "title", "artist - title", "title - artist", "title by artist", "artist: title",
   * "artist title" and "title artist"; ignores case, punctuation, accents, "(feat. X)",
   * version notes ("- 2011 Remastered Version", "(Live)") and an omitted part ("Pt. 2");
   * allows small typos, word-order and article slips. Numbers in the title must match.
   * @returns {{ ok: boolean, kind: 'exact'|'close'|'none', matched: string|null, guess: string|null }}
   *   `matched` is the normalised title form the guess was matched against.
   */
  function matchFreeAnswer(guess, track) {
    var none = { ok: false, kind: 'none', matched: null, guess: null };
    var raw = String(guess || '').trim();
    if (!raw || !track) return none;
    var info = titleInfo(track.title);
    var gp = extractPart(raw);
    // Naming a part is optional, but naming the wrong one ("Pt. 1" for "Pt. 2") is a different song.
    if (gp.part && gp.part !== info.part) return none;
    var cands = guessCandidates(gp.text, track.artist);
    var best = none;
    for (var i = 0; i < cands.length; i++) {
      for (var j = 0; j < info.variants.length; j++) {
        var v = info.variants[j];
        var r = compareTitle(cands[i], v.norm, info.part);
        if (!r) continue;
        var kind = r === 'exact' && v.kind === 'exact' ? 'exact' : 'close';
        if (kind === 'exact') return { ok: true, kind: 'exact', matched: v.norm, guess: cands[i] };
        if (!best.ok) best = { ok: true, kind: 'close', matched: v.norm, guess: cands[i] };
      }
    }
    return best;
  }

  /** Lenient free-answer check (boolean). See matchFreeAnswer for the rules. */
  function checkAnswer(guess, track) {
    return matchFreeAnswer(guess, track).ok;
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
   * @param {'beginning'|'random'} [cfg.clipStartMode]
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
      clipStartMode: cfg.clipStartMode === 'random' ? 'random' : 'beginning',
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
    var clipStart = pickClipStart(game.clipStartMode, rng);
    game.current = { trackId: id, extended: false, options: options, answered: false, outcome: null, points: 0, guess: '', clipStart: clipStart };
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
    var match = null;
    if (kind === 'guess') {
      if (cur.options) {
        correct = value === track.id;
        match = correct ? 'exact' : 'none';
      } else {
        match = matchFreeAnswer(value, track).kind;
        correct = match !== 'none';
      }
    }
    cur.answered = true;
    cur.guess = kind === 'guess' ? String(value || '') : '';
    if (kind === 'guess' && cur.options) {
      var chosen = cur.options.filter(function (o) { return o.id === value; })[0];
      cur.guess = chosen ? chosen.title : '';
    }
    cur.outcome = kind === 'guess' ? (correct ? 'correct' : 'wrong') : kind === 'reveal' ? 'revealed' : 'skipped';
    cur.match = match; // 'exact' | 'close' (typo, word order... forgiven) | 'none' | null (no guess)
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
    MAX_CLIP_START: MAX_CLIP_START,
    POINTS: POINTS,
    pickClipStart: pickClipStart,
    clampClipStart: clampClipStart,
    basicNormalize: basicNormalize,
    stripDecorations: stripDecorations,
    titleVariants: titleVariants,
    levenshtein: levenshtein,
    similarity: similarity,
    checkAnswer: checkAnswer,
    matchFreeAnswer: matchFreeAnswer,
    extractPart: extractPart,
    isArtist: isArtist,
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
