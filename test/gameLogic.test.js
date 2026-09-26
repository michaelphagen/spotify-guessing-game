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
