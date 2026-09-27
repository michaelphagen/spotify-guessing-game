'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const G = require('../public/game-logic.js');

function seeded(seed) {
  // Mulberry32: deterministic RNG for repeatable tests.
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const T = (id, title, artist) => ({ id, title, artist, previewUrl: 'https://p.scdn.co/mp3-preview/' + id, image: null });

test('checkAnswer is lenient about case, punctuation, accents and suffixes', () => {
  const gw = T('a', 'Global Warming (feat. Sensato)', 'Pitbull, Sensato');
  for (const g of ['global warming', 'GLOBAL WARMING!!', 'Global Warmin', 'Global Warming feat. Sensato',
    'global warming - pitbull', 'Pitbull - Global Warming', 'global warming by pitbull', 'global warming pitbull']) {
    assert.equal(G.checkAnswer(g, gw), true, g);
  }
  for (const g of ['', 'warming', 'pitbull', 'something else']) assert.equal(G.checkAnswer(g, gw), false, g);

  assert.equal(G.checkAnswer('dont stop the party', T('b', "Don't Stop the Party (feat. TJR)", 'Pitbull, TJR')), true);
  assert.equal(G.checkAnswer('back in time', T('c', 'Back in Time - featured in "Men In Black 3"', 'Pitbull')), true);
  assert.equal(G.checkAnswer('Beyonce', T('d', 'Beyoncé', 'X')), true);
  assert.equal(G.checkAnswer('Hey Jude - Remastered', T('e', 'Hey Jude - Remastered 2015', 'The Beatles')), true);
  assert.equal(G.checkAnswer('Rock and Roll', T('f', 'Rock & Roll', 'Y')), true);
  assert.equal(G.checkAnswer('nicole kidman', T('g', 'Nicole Kidman', 'ADÉLA')), true);
  assert.equal(G.checkAnswer('nicole kidman adela', T('g', 'Nicole Kidman', 'ADÉLA')), true);
  assert.equal(G.checkAnswer('Scientist', T('h', 'The Scientist', 'Coldplay')), true);
});

test('checkAnswer is strict for short titles and numbers', () => {
  assert.equal(G.checkAnswer('7 rings', T('a', '7 rings', 'Ariana Grande')), true);
  assert.equal(G.checkAnswer('8 rings', T('a', '7 rings', 'Ariana Grande')), false);
  assert.equal(G.checkAnswer('YMCA', T('b', 'Y.M.C.A.', 'Village People')), true);
  assert.equal(G.checkAnswer('y.m.c.a', T('b', 'Y.M.C.A.', 'Village People')), true);
  assert.equal(G.checkAnswer('Hel', T('c', 'Hello', 'Adele')), false);
  assert.equal(G.checkAnswer('Helo', T('c', 'Hello', 'Adele')), true);
  assert.equal(G.checkAnswer('Up', T('d', 'Up', 'Cardi B')), true);
  assert.equal(G.checkAnswer('Us', T('d', 'Up', 'Cardi B')), false);
});

test('buildOptions returns the answer plus distinct distractors, no correctness flag', () => {
  const pool = [T('1', 'A'), T('2', 'B'), T('3', 'C'), T('4', 'D'), T('5', 'E'), T('6', 'A (Remix)')];
  const rng = seeded(42);
  for (let i = 0; i < 20; i++) {
    const opts = G.buildOptions(pool[0], pool, 4, rng);
    assert.equal(opts.length, 4);
    assert.ok(opts.some((o) => o.id === '1'));
    assert.ok(!opts.some((o) => o.id === '6'), 'same-titled remix is not a distractor');
    assert.equal(new Set(opts.map((o) => o.id)).size, 4);
    assert.deepEqual(Object.keys(opts[0]).sort(), ['artist', 'id', 'title']);
  }
  assert.equal(G.buildOptions(pool[0], pool.slice(0, 2), 4, rng).length, 2);
});

test('a game never repeats a song and ends when songs run out', () => {
  const tracks = Array.from({ length: 7 }, (_, i) => T('t' + i, 'Song ' + String.fromCharCode(65 + i), 'Artist'));
  const game = G.createGame({ players: ['Ann', 'Bob'], mode: 'choice', rounds: 0, tracks, rng: seeded(1) });
  const heard = [];
  const turnsBy = [];
  G.startTurn(game, seeded(2));
  while (game.phase !== 'over') {
    heard.push(game.current.trackId);
    turnsBy.push(game.players[G.currentPlayerIndex(game)].name);
    G.answer(game, 'reveal');
    G.nextTurn(game, seeded(3));
  }
  assert.equal(heard.length, 7);
  assert.equal(new Set(heard).size, 7, 'no song repeated');
  assert.deepEqual(turnsBy, ['Ann', 'Bob', 'Ann', 'Bob', 'Ann', 'Bob', 'Ann']);
  assert.equal(game.usedIds.length, 7);
});

test('rounds limit total turns to rounds x players and used ids are excluded', () => {
  const tracks = Array.from({ length: 20 }, (_, i) => T('t' + i, 'Song ' + i, 'X'));
  const game = G.createGame({ players: ['A', 'B', 'C'], mode: 'free', rounds: 2, tracks, usedIds: ['t0', 't1', 't2'] });
  G.startTurn(game);
  let turns = 0;
  while (game.phase !== 'over') {
    assert.ok(!['t0', 't1', 't2'].includes(game.current.trackId));
    assert.equal(game.current.options, null, 'free mode has no options');
    turns++;
    G.answer(game, 'skip');
    G.nextTurn(game);
  }
  assert.equal(turns, 6);
});

test('scoring: 10 for the 5s clip, 5 after extending, 0 for wrong/reveal', () => {
  const tracks = [T('a', 'Alpha', 'X'), T('b', 'Bravo', 'Y'), T('c', 'Charlie', 'Z'), T('d', 'Delta', 'W')];
  const game = G.createGame({ players: ['P1', 'P2'], mode: 'free', rounds: 0, tracks });
  G.startTurn(game);
  const titleOf = (g) => G.trackById(g, g.current.trackId).title;

  G.answer(game, 'guess', titleOf(game)); // P1 correct, short
  assert.equal(game.current.points, 10);
  G.nextTurn(game);
  game.current.extended = true;
  G.answer(game, 'guess', titleOf(game).toLowerCase()); // P2 correct, extended
  assert.equal(game.current.points, 5);
  G.nextTurn(game);
  G.answer(game, 'guess', 'definitely not it'); // P1 wrong
  assert.equal(game.current.outcome, 'wrong');
  assert.equal(game.current.points, 0);
  G.nextTurn(game);
  G.answer(game, 'reveal'); // P2 reveal
  assert.equal(game.current.outcome, 'revealed');
  G.answer(game, 'guess', titleOf(game)); // double answer is ignored
  assert.equal(game.players[1].score, 5);
  assert.equal(game.players[0].score, 10);

  const st = G.standings(game);
  assert.deepEqual(st.map((p) => [p.name, p.rank, p.score]), [['P1', 1, 10], ['P2', 2, 5]]);
});

test('multiple choice scoring uses the chosen option id', () => {
  const tracks = [T('a', 'Alpha', 'X'), T('b', 'Bravo', 'Y'), T('c', 'Charlie', 'Z'), T('d', 'Delta', 'W'), T('e', 'Echo', 'V')];
  const game = G.createGame({ players: ['Solo'], mode: 'choice', rounds: 0, tracks });
  G.startTurn(game);
  assert.equal(game.current.options.length, 4);
  const wrong = game.current.options.find((o) => o.id !== game.current.trackId);
  G.answer(game, 'guess', wrong.id);
  assert.equal(game.current.outcome, 'wrong');
  assert.equal(game.current.guess, wrong.title);
  G.nextTurn(game);
  G.answer(game, 'guess', game.current.trackId);
  assert.equal(game.current.points, 10);
});

test('single-track games fall back to no options and end after one turn', () => {
  const game = G.createGame({ players: ['A', 'B'], mode: 'choice', rounds: 5, tracks: [T('x', 'Only One', 'Z')] });
  G.startTurn(game);
  assert.equal(game.current.options, null);
  G.answer(game, 'guess', 'only one');
  assert.equal(game.current.points, 10);
  G.nextTurn(game);
  assert.equal(game.phase, 'over');
});

test('standings share ranks on ties', () => {
  const game = G.createGame({ players: ['A', 'B', 'C'], mode: 'free', rounds: 1, tracks: [T('x', 'X', 'Y')] });
  game.players[0].score = 10; game.players[1].score = 10; game.players[2].score = 5;
  assert.deepEqual(G.standings(game).map((p) => p.rank), [1, 1, 3]);
});

test('checkAnswer: a bare "with" is part of the title, and multi-title guesses are rejected', () => {
  assert.equal(G.checkAnswer('stay', T('a', 'Stay With Me', 'Sam Smith')), false);
  assert.equal(G.checkAnswer('die', T('b', 'Die With A Smile', 'Lady Gaga, Bruno Mars')), false);
  assert.equal(G.checkAnswer('Stay With Me', T('c', 'Stay', 'Rihanna')), false);
  assert.equal(G.checkAnswer('stay with me', T('a', 'Stay With Me', 'Sam Smith')), true);
  assert.equal(G.checkAnswer('luther', T('d', 'luther (with sza)', 'Kendrick Lamar, SZA')), true);

  const hello = T('e', 'Hello', 'Adele');
  for (const g of ['yesterday / hello', 'yesterday - believer - hello', 'stay | hello']) {
    assert.equal(G.checkAnswer(g, hello), false, g);
  }
  for (const g of ['hello - adele', 'Adele - Hello', 'adel / hello', 'hello by adele']) {
    assert.equal(G.checkAnswer(g, hello), true, g);
  }
  assert.equal(G.checkAnswer('Beatles - Hey Jude', T('f', 'Hey Jude - Remastered 2015', 'The Beatles')), true);
});

test('multiple-choice distractors prefer songs that have not been played yet', () => {
  const tracks = Array.from({ length: 12 }, (_, i) => T('t' + i, 'Song ' + String.fromCharCode(65 + i), 'X'));
  const rng = seeded(7);
  const game = G.createGame({ players: ['A', 'B'], mode: 'choice', rounds: 4, tracks, rng });
  G.startTurn(game, rng);
  while (game.phase !== 'over') {
    const played = game.usedIds.filter((id) => id !== game.current.trackId);
    for (const o of game.current.options) {
      assert.ok(!played.includes(o.id), 'an already-played song would be an obvious wrong option');
    }
    G.answer(game, 'reveal');
    G.nextTurn(game, rng);
  }
  // When fresh songs run short, already-played ones still fill the options.
  const opts = G.buildOptions(tracks[0], tracks.slice(0, 5), 4, rng, ['t1', 't2', 't3']);
  assert.equal(opts.length, 4);
  assert.ok(opts.some((o) => o.id === 't4'));
});

test('pickClipStart: "beginning" is always 0, "random" is an integer in [0, 15]', () => {
  const rng = seeded(11);
  for (let i = 0; i < 50; i++) {
    assert.equal(G.pickClipStart('beginning', rng), 0);
    assert.equal(G.pickClipStart(undefined, rng), 0, 'unknown mode defaults to the beginning');
  }
  const seen = new Set();
  for (let i = 0; i < 300; i++) {
    const off = G.pickClipStart('random', rng);
    assert.ok(Number.isInteger(off), 'offset is a whole number of seconds');
    assert.ok(off >= 0 && off <= 15, 'offset + 15 fits a 30s preview: ' + off);
    seen.add(off);
  }
  assert.ok(seen.size > 1, 'random mode actually varies');
  assert.ok(seen.has(0) && seen.has(15), 'both ends of the range are reachable: ' + [...seen].sort((a, b) => a - b));
});

test('clampClipStart fits an offset to the preview\'s real duration', () => {
  assert.equal(G.clampClipStart(9, 30), 9, 'fits as-is inside a normal 30s preview');
  assert.equal(G.clampClipStart(9, NaN), 9, 'duration unknown yet: offset passed through unchanged');
  assert.equal(G.clampClipStart(9, 0), 9, 'duration unknown (0): offset passed through unchanged');
  assert.equal(G.clampClipStart(9, -1), 9, 'duration unknown (negative): offset passed through unchanged');
  assert.equal(G.clampClipStart(9, 20), 5, 'clamped so offset + 15 fits a shorter preview');
  assert.equal(G.clampClipStart(0, 20), 0, 'an offset of 0 already fits');
  assert.equal(G.clampClipStart(9, 10), 0, 'preview too short for any 15s clip: falls back to 0');
  assert.equal(G.clampClipStart(undefined, 30), 0, 'a missing offset defaults to 0');
});

test('startTurn stores a clipStart on the current turn, driven by the game\'s clipStartMode', () => {
  const tracks = Array.from({ length: 5 }, (_, i) => T('t' + i, 'Song ' + i, 'X'));
  const beginningGame = G.createGame({ players: ['A'], mode: 'free', rounds: 0, tracks });
  G.startTurn(beginningGame);
  assert.equal(beginningGame.current.clipStart, 0);

  const randomGame = G.createGame({ players: ['A'], mode: 'free', rounds: 0, tracks, clipStartMode: 'random', rng: seeded(4) });
  G.startTurn(randomGame, seeded(5));
  assert.ok(Number.isInteger(randomGame.current.clipStart));
  assert.ok(randomGame.current.clipStart >= 0 && randomGame.current.clipStart <= 15);
});

// ---------- Free-answer matching: table-driven ----------

// [title, artist, guess, expected] where expected is 'exact' | 'close' (accepted) or false (rejected).
const FREE_ANSWER_CASES = [
  // The screenshot bug: part suffix + remaster note on the title, "artist - title" guess.
  ['Another Brick In The Wall, Pt. 2 - 2011 Remastered Version', 'Pink Floyd', 'Pink Floyd - Another Brick in the Wall', 'exact'],
  ['Another Brick In The Wall, Pt. 2 - 2011 Remastered Version', 'Pink Floyd', 'another brick in the wall', 'exact'],
  ['Another Brick In The Wall, Pt. 2 - 2011 Remastered Version', 'Pink Floyd', 'pink floyd another brick in the wall', 'exact'],
  ['Another Brick In The Wall, Pt. 2 - 2011 Remastered Version', 'Pink Floyd', 'Pink Floyd: Another Brick in the Wall', 'exact'],
  ['Another Brick In The Wall, Pt. 2 - 2011 Remastered Version', 'Pink Floyd', 'another brick in the wall by pink floyd', 'exact'],
  ['Another Brick In The Wall, Pt. 2 - 2011 Remastered Version', 'Pink Floyd', 'Another Brick in the Wall - Pink Floyd', 'exact'],
  ['Another Brick In The Wall, Pt. 2 - 2011 Remastered Version', 'Pink Floyd', 'Another Brick in the Wall Pt. 2', 'exact'],
  ['Another Brick In The Wall, Pt. 2 - 2011 Remastered Version', 'Pink Floyd', 'another brick in the wall part II', 'exact'],
  ['Another Brick In The Wall, Pt. 2 - 2011 Remastered Version', 'Pink Floyd', 'Another Brick in the Wall (Part Two)', 'exact'],
  ['Another Brick In The Wall, Pt. 2 - 2011 Remastered Version', 'Pink Floyd', 'another brick in the wall 2', 'exact'],
  ['Another Brick In The Wall, Pt. 2 - 2011 Remastered Version', 'Pink Floyd', 'anothr brick in the wall', 'close'],
  ['Another Brick In The Wall, Pt. 2 - 2011 Remastered Version', 'Pink Floyd', 'Another Brick in the Wall Pt. 1', false],
  ['Another Brick In The Wall, Pt. 2 - 2011 Remastered Version', 'Pink Floyd', 'another brick in the wall part 3', false],
  ['Another Brick In The Wall, Pt. 2 - 2011 Remastered Version', 'Pink Floyd', 'another brick in the wall 3', false],
  ['Another Brick In The Wall, Pt. 2 - 2011 Remastered Version', 'Pink Floyd', 'Pink Floyd', false],
  ['Another Brick In The Wall, Pt. 2 - 2011 Remastered Version', 'Pink Floyd', 'Pink Floyd - Comfortably Numb', false],
  ['Another Brick In The Wall, Pt. 2 - 2011 Remastered Version', 'Pink Floyd', 'the wall', false],
  ['Another Brick In The Wall, Pt. 2 - 2011 Remastered Version', 'Pink Floyd', 'Another Brick In The Wall, Pt. 2 - 2011 Remastered Version', 'exact'],
  ['Another Brick In The Wall - Part 2', 'Pink Floyd', 'another brick in the wall', 'exact'],
  ['Another Brick In The Wall - Part 2', 'Pink Floyd', 'another brick in the wall part 1', false],
  ['Money, Vol. 2', 'X', 'money', 'exact'],
  ['Money', 'X', 'money pt 2', false],

  // Decorations on the canonical title.
  ['Bohemian Rhapsody - Remastered 2011', 'Queen', 'Bohemian Rhapsody', 'exact'],
  ['Bohemian Rhapsody - Remastered 2011', 'Queen', 'bohemian rapsody', 'close'],
  ['Bohemian Rhapsody - Remastered 2011', 'Queen', 'queen bohemian rhapsody', 'exact'],
  ['Bohemian Rhapsody - Remastered 2011', 'Queen', 'Bohemian Rhapsody (Remastered)', 'exact'],
  ['Bohemian Rhapsody - Remastered 2011', 'Queen', 'Bohemian Rhapsody - Live', 'exact'],
  ['Bohemian Rhapsody - Remastered 2011', 'Queen', 'Bohemian Rhapsody - Remastered 2011', 'exact'],
  ['Bohemian Rhapsody - Remastered 2011', 'Queen', 'Killer Queen', false],
  ["Don't Stop Me Now - Remastered 2011", 'Queen', 'dont stop me now', 'exact'],
  ["Don't Stop Me Now - Remastered 2011", 'Queen', "don't stop me now!", 'exact'],
  ["Don't Stop Me Now - Remastered 2011", 'Queen', 'dont stop believin', false],
  ['Under Pressure - Remastered 2011', 'Queen, David Bowie', 'under pressure', 'exact'],
  ['Under Pressure - Remastered 2011', 'Queen, David Bowie', 'David Bowie - Under Pressure', 'exact'],
  ['Under Pressure - Remastered 2011', 'Queen, David Bowie', 'Bohemian Rhapsody', false],
  ['Hotel California - 2013 Remaster', 'Eagles', 'hotel california', 'exact'],
  ['Hotel California - 2013 Remaster', 'Eagles', 'hotel califronia', 'close'],
  ['Hotel California - 2013 Remaster', 'Eagles', 'the eagles - hotel california', 'exact'],
  ['Hey Jude - Remastered 2015', 'The Beatles', 'hey jude', 'exact'],
  ['Hey Jude - Remastered 2015', 'The Beatles', 'Hey Jude by the Beatles', 'exact'],
  ['Hey Jude - Remastered 2015', 'The Beatles', 'hey', false],
  ['Hey Jude - Remastered 2015', 'The Beatles', 'Let It Be', false],
  ['I Want To Hold Your Hand - Remastered 2015', 'The Beatles', 'i want to hold your hand', 'exact'],
  ['I Want To Hold Your Hand - Remastered 2015', 'The Beatles', 'i wanna hold your hand', 'close'],
  ['I Want To Hold Your Hand - Remastered 2015', 'The Beatles', 'hold your hand', false],
  ['Stayin\' Alive - From "Saturday Night Fever" Soundtrack', 'Bee Gees', 'stayin alive', 'exact'],
  ['Stayin\' Alive - From "Saturday Night Fever" Soundtrack', 'Bee Gees', 'staying alive', 'close'],
  ['Stayin\' Alive - From "Saturday Night Fever" Soundtrack', 'Bee Gees', 'saturday night fever', false],
  ['(I Can\'t Get No) Satisfaction - Mono Version', 'The Rolling Stones', 'satisfaction', 'exact'],
  ['(I Can\'t Get No) Satisfaction - Mono Version', 'The Rolling Stones', "I can't get no satisfaction", 'exact'],
  ['(I Can\'t Get No) Satisfaction - Mono Version', 'The Rolling Stones', 'cant get no satisfaction', 'close'],
  ['(I Can\'t Get No) Satisfaction - Mono Version', 'The Rolling Stones', 'rolling stones satisfaction', 'exact'],
  ['Paranoid - 2012 - Remaster', 'Black Sabbath', 'paranoid', 'exact'],
  ['Paranoid - 2012 - Remaster', 'Black Sabbath', 'iron man', false],
  ['Paranoid - 2012 - Remaster', 'Black Sabbath', 'paranoia', 'close'], // one letter off in an 8-letter title
  ['Jump - 2015 Remaster', 'Van Halen', 'jump', 'exact'],
  ['Jump - 2015 Remaster', 'Van Halen', 'jumo', false],
  ['Song 2 - 2012 Remaster', 'Blur', 'song 2', 'exact'],
  ['Song 2 - 2012 Remaster', 'Blur', 'song two', 'exact'],
  ['Song 2 - 2012 Remaster', 'Blur', 'song', false],
  ['Song 2 - 2012 Remaster', 'Blur', 'song 3', false],
  ['One - Remastered', 'Metallica', 'one', 'exact'],
  ['One - Remastered', 'Metallica', 'One - Metallica', 'exact'],
  ['One - Remastered', 'Metallica', 'won', false],
  ['Wonderwall - Remastered', 'Oasis', 'wonderwall', 'exact'],
  ['Wonderwall - Remastered', 'Oasis', 'wonder wall', 'exact'],
  ['Wonderwall - Remastered', 'Oasis', 'wonderwal', 'close'],
  ['Smells Like Teen Spirit - Remastered 2021', 'Nirvana', 'Smells Like Teen Spirit', 'exact'],
  ['Smells Like Teen Spirit', 'Nirvana', 'smells like teen spirt', 'close'],
  ['Smells Like Teen Spirit', 'Nirvana', 'teen spirit', false],
  ['Smells Like Teen Spirit', 'Nirvana', 'nirvana', false],
  ['Radio Ga Ga - Live at Wembley', 'Queen', 'radio ga ga', 'exact'],
  ['Losing My Religion - Radio Edit', 'R.E.M.', 'losing my religion', 'exact'],
  ['Heroes - Single Version', 'David Bowie', 'heroes', 'exact'],
  ['Heroes - Single Version', 'David Bowie', 'hero', false],
  ['Levels - Original Mix', 'Avicii', 'levels', 'exact'],
  ['Heat Waves [Explicit]', 'Glass Animals', 'heat waves', 'exact'],
  ['Cold Heart (PNAU Remix) - Extended Mix', 'Elton John, Dua Lipa', 'cold heart', 'exact'],
  ['Summer Nights - 1999', 'X', 'summer nights', 'exact'],
  ['Summer Nights - Acoustic', 'X', 'summer nights', 'exact'],
  ['Summer Nights - Deluxe', 'X', 'summer nights', 'exact'],
  ['Summer Nights - Spotify Singles', 'X', 'summer nights', 'exact'],
  ['Mr. Blue Sky', 'Electric Light Orchestra', 'Mr Blue Sky Part 2', false], // the title has no part

  // Plain real-world titles and typical human guesses.
  ['Africa', 'TOTO', 'africa', 'exact'],
  ['Africa', 'TOTO', 'toto africa', 'exact'],
  ['Africa', 'TOTO', 'america', false],
  ['Africa', 'TOTO', 'afrika', 'close'], // one edit allowed from 6 letters
  ['Africa', 'TOTO', 'afric', 'close'],
  ['Africa', 'TOTO', 'afrikka', false],
  ['Zombie', 'The Cranberries', 'zombi', 'close'],
  ['Heroes', 'David Bowie', 'hero', false],
  ['Hello', 'Adele', 'Hallo', false], // 5 letters: still exact (bar doubled letters)
  ['Hallo', 'X', 'Hello', false],
  ['Mr. Brightside', 'The Killers', 'brightside', 'close'],
  ['Mr. Brightside', 'The Killers', 'brightsid', 'close'],
  ['Mr. Brightside', 'The Killers', 'mr brightsid', 'close'],
  ['Mr. Jones', 'Counting Crows', 'mr jones', 'exact'],
  ['Mr. Jones', 'Counting Crows', 'mister jones', 'exact'],
  ['Mr. Jones', 'Counting Crows', 'jones', false], // too short to drop the honorific
  ['Mrs. Robinson', 'Simon & Garfunkel', 'robinson', 'close'],
  ['Dr. Feelgood', 'Motley Crue', 'feelgood', 'close'],
  ['Mr. Blue Sky', 'Electric Light Orchestra', 'mr blue sky', 'exact'],
  ['Mr. Blue Sky', 'Electric Light Orchestra', 'blue sky', 'close'],
  ['Mr. Blue Sky', 'Electric Light Orchestra', 'sky', false],
  ['Mr. Brightside', 'The Killers', 'mr brightside', 'exact'],
  ['Mr. Brightside', 'The Killers', 'mister brightside', 'exact'],
  ['Mr. Brightside', 'The Killers', 'the killers - mr. brightside', 'exact'],
  ["Sweet Child O' Mine", "Guns N' Roses", 'sweet child o mine', 'exact'],
  ["Sweet Child O' Mine", "Guns N' Roses", 'sweet child of mine', 'close'],
  ["Sweet Child O' Mine", "Guns N' Roses", 'guns and roses sweet child o mine', 'exact'],
  ["Sweet Child O' Mine", "Guns N' Roses", 'sweet child', false],
  ['Everybody Wants To Rule The World', 'Tears For Fears', 'everybody wants to rule the world', 'exact'],
  ['Everybody Wants To Rule The World', 'Tears For Fears', 'everyone wants to rule the world', 'close'],
  ['Everybody Wants To Rule The World', 'Tears For Fears', 'rule the world', false],
  ["Baba O'Riley", 'The Who', 'baba o riley', 'exact'],
  ["Baba O'Riley", 'The Who', 'baba oreilly', 'close'],
  ["Baba O'Riley", 'The Who', 'teenage wasteland', false],
  ['Blinding Lights', 'The Weeknd', 'blinding lights', 'exact'],
  ['Blinding Lights', 'The Weeknd', 'blinding light', 'close'],
  ['Blinding Lights', 'The Weeknd', 'Save Your Tears', false],
  ['Bad Romance', 'Lady Gaga', 'bad romance', 'exact'],
  ['Bad Romance', 'Lady Gaga', 'bad romanse', 'close'],
  ['Bad Romance', 'Lady Gaga', 'bad', false],
  ['HUMBLE.', 'Kendrick Lamar', 'humble', 'exact'],
  ['HUMBLE.', 'Kendrick Lamar', 'kendrick lamar humble', 'exact'],
  ['HUMBLE.', 'Kendrick Lamar', 'DNA.', false],
  ['...Baby One More Time', 'Britney Spears', 'baby one more time', 'exact'],
  ['...Baby One More Time', 'Britney Spears', 'baby 1 more time', 'exact'],
  ['...Baby One More Time', 'Britney Spears', 'one more time', false],
  ["Livin' On A Prayer", 'Bon Jovi', 'livin on a prayer', 'exact'],
  ["Livin' On A Prayer", 'Bon Jovi', 'living on a prayer', 'close'],
  ["Livin' On A Prayer", 'Bon Jovi', 'bon jovi - living on a prayer', 'close'],
  ["Livin' On A Prayer", 'Bon Jovi', 'on a prayer', false],
  ['Sultans of Swing', 'Dire Straits', 'sultans of swing', 'exact'],
  ['Sultans of Swing', 'Dire Straits', 'sultan of swing', 'close'],
  ['Sultans of Swing', 'Dire Straits', 'money for nothing', false],
  ['September', 'Earth, Wind & Fire', 'september', 'exact'],
  ['September', 'Earth, Wind & Fire', 'septmeber', 'close'],
  ['September', 'Earth, Wind & Fire', 'earth wind and fire september', 'exact'],
  ['September', 'Earth, Wind & Fire', 'december', false],
  ['Zombie', 'The Cranberries', 'zombie', 'exact'],
  ['Zombie', 'The Cranberries', 'zombies', 'close'],
  ['Zombie', 'The Cranberries', 'linger', false],
  ['Bittersweet Symphony', 'The Verve', 'bitter sweet symphony', 'exact'],
  ['Bittersweet Symphony', 'The Verve', 'bittersweet symphonie', 'close'],
  ['Bittersweet Symphony', 'The Verve', 'symphony', false],
  ['Nothing Else Matters', 'Metallica', 'nothing else matters', 'exact'],
  ['Nothing Else Matters', 'Metallica', 'nothing else matter', 'close'],
  ['Nothing Else Matters', 'Metallica', 'nothing matters', false],
  ['Nothing Else Matters', 'Metallica', 'Metallica - One', false],
  ['Boulevard of Broken Dreams', 'Green Day', 'boulevard of broken dreams', 'exact'],
  ['Boulevard of Broken Dreams', 'Green Day', 'boulevard of broken dream', 'close'],
  ['Boulevard of Broken Dreams', 'Green Day', 'broken dreams', false],

  // Numbers in the core title must match; number words count.
  ['7 rings', 'Ariana Grande', 'seven rings', 'exact'],
  ['seven rings', 'Ariana Grande', '7 rings', 'exact'],
  ['7 rings', 'Ariana Grande', '8 rings', false],
  ['7 rings', 'Ariana Grande', 'eight rings', false],
  ['22', 'Taylor Swift', '22', 'exact'],
  ['22', 'Taylor Swift', 'twenty two', 'exact'],
  ['22', 'Taylor Swift', '23', false],
  ['1979 - Remastered 2012', 'The Smashing Pumpkins', '1979', 'exact'],
  ['1979 - Remastered 2012', 'The Smashing Pumpkins', '1978', false],

  // Word order / article slips (token sets ignoring the, a, an, of, in, on, to, and).
  ['The Sound of Silence', 'Simon & Garfunkel', 'sound of silence', 'exact'],
  ['The Sound of Silence', 'Simon & Garfunkel', 'the sounds of silence', 'close'],
  ['Die With A Smile', 'Lady Gaga, Bruno Mars', 'die with smile', 'close'],
  ['Title: The Subtitle Here', 'X', 'title', false],
  ['Heart of Glass: Special Edition', 'Blondie', 'heart of glass', 'exact'],
  ['Stairway to Heaven, Live in Tokyo', 'Led Zeppelin', 'stairway to heaven', 'exact'],
  ['Stairway to Heaven, Live in Tokyo - 2012 Remaster', 'Led Zeppelin', 'stairway to heaven', 'exact'],
  ['Pomp and Circumstance: March No. 1', 'Edward Elgar', 'pomp and circumstance', 'close'], // up to the colon

  // Negatives that must stay rejected.
  ['Stay With Me', 'Sam Smith', 'stay', false],
  ['Die With A Smile', 'Lady Gaga, Bruno Mars', 'die', false],
  ['Hello Goodbye', 'The Beatles', 'Hello', false],
  ['Hello, Goodbye - Remastered 2009', 'The Beatles', 'Hello', false],
  ['Yesterday Once More', 'Carpenters', 'Yesterday', false],
  ['Hello', 'Adele', 'yesterday / hello', false],
  ['Hello', 'Adele', 'hello / yesterday', false],
  ['Hello', 'Adele', 'Hello - Stay With Me', false],
  ['Hello', 'Adele', 'adele', false],
  ['Hello', 'Adele', '   ', false],
  ['Hello', 'Adele', '', false],
  ['Hello', 'Adele', 'Helo', 'close'],
  ['Hello', 'Adele', 'Hello - Adele', 'exact'],
];

test('matchFreeAnswer: table of real-world titles and human guesses', () => {
  assert.ok(FREE_ANSWER_CASES.length >= 40);
  const failures = [];
  for (const [title, artist, guess, expected] of FREE_ANSWER_CASES) {
    const r = G.matchFreeAnswer(guess, T('x', title, artist));
    const got = r.ok ? r.kind : false;
    if (got !== expected) failures.push(`${JSON.stringify(guess)} for ${JSON.stringify(title)}: expected ${expected}, got ${got}`);
    assert.equal(G.checkAnswer(guess, T('x', title, artist)), r.ok, 'checkAnswer agrees with matchFreeAnswer');
  }
  assert.deepEqual(failures, []);
});

test('matchFreeAnswer reports what matched, and answer() records exact vs close on the turn', () => {
  const wall = T('w', 'Another Brick In The Wall, Pt. 2 - 2011 Remastered Version', 'Pink Floyd');
  assert.deepEqual(G.matchFreeAnswer('Pink Floyd - Another Brick in the Wall', wall),
    { ok: true, kind: 'exact', matched: 'another brick in the wall', guess: 'another brick in the wall' });
  assert.deepEqual(G.matchFreeAnswer('nope', wall), { ok: false, kind: 'none', matched: null, guess: null });
  assert.deepEqual(G.extractPart('Another Brick In The Wall, Pt. II'), { text: 'Another Brick In The Wall', part: '2' });
  assert.deepEqual(G.extractPart('Part of Me'), { text: 'Part of Me', part: null });

  const tracks = [wall, T('b', 'Bohemian Rhapsody - Remastered 2011', 'Queen'), T('c', 'Zombie', 'The Cranberries')];
  const game = G.createGame({ players: ['A'], mode: 'free', rounds: 0, tracks });
  const verdicts = {};
  const guesses = { w: 'pink floyd another brick in the wall', b: 'bohemian rapsody', c: 'linger' };
  G.startTurn(game);
  while (game.phase !== 'over') {
    const id = game.current.trackId;
    G.answer(game, 'guess', guesses[id]);
    verdicts[id] = [game.current.outcome, game.current.match, game.current.points];
    G.nextTurn(game);
  }
  assert.deepEqual(verdicts, { w: ['correct', 'exact', 10], b: ['correct', 'close', 10], c: ['wrong', 'none', 0] });
});
