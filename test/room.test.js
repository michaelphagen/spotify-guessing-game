'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const G = require('../public/game-logic.js');
const Room = require('../public/lib/room.js');

function seeded(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TRACKS = [
  ['t1', 'Jailhouse Rock', 'Elvis Presley'],
  ['t2', 'Hey Jude', 'The Beatles'],
  ['t3', 'Bohemian Rhapsody', 'Queen'],
  ['t4', 'Billie Jean', 'Michael Jackson'],
  ['t5', 'Imagine', 'John Lennon'],
  ['t6', 'Respect', 'Aretha Franklin'],
].map(([id, title, artist]) => ({
  id, title, artist,
  previewUrl: 'https://p.scdn.co/mp3-preview/' + id + 'preview',
  image: 'https://i.scdn.co/image/' + id + 'cover',
}));

/** In-memory stand-in for transport.js: records what the host sends. */
function fakeTransport() {
  const h = { message: [], leave: [], join: [] };
  const t = {
    sent: [],
    onMessage: (fn) => h.message.push(fn),
    onPeerLeave: (fn) => h.leave.push(fn),
    onPeerJoin: (fn) => h.join.push(fn),
    // JSON round trip, like the real transports.
    send: (to, msg) => t.sent.push({ to, msg: JSON.parse(JSON.stringify(msg)) }),
    deliver: (from, msg) => h.message.forEach((fn) => fn(from, JSON.parse(JSON.stringify(msg)))),
    drop: (peer) => h.leave.forEach((fn) => fn(peer)),
    to: (peer) => t.sent.filter((s) => s.to === peer).map((s) => s.msg),
    last: (peer, type) => t.to(peer).filter((m) => !type || m.type === type).pop(),
    clear: () => { t.sent.length = 0; },
  };
  return t;
}

const hello = (name, token) => Room.message('hello', { name, token });
const act = (type, body) => Room.message(type, body);

function setup({ mode = 'choice', rounds = 2, names = ['Alice', 'Bob'], seed = 7 } = {}) {
  const room = Room.createRoom({
    code: 'ABCD',
    settings: { mode, rounds, clipStart: 'random', sourceUrl: 'x' },
    source: { type: 'playlist', name: 'Hits', image: null, key: 'playlist:x' },
    tracks: TRACKS.map((t) => ({ ...t })),
  });
  const transport = fakeTransport();
  const effects = [];
  const changes = [];
  let clock = 0;
  const host = Room.createHost({
    room, transport, rng: seeded(seed), now: () => clock,
    hooks: { onEffect: (e, actor) => effects.push({ ...e, actor }), onChange: (r) => changes.push(r) },
  });
  names.forEach((n, i) => transport.deliver('peer' + (i + 1), hello(n)));
  return { room, transport, host, effects, changes, tick: (ms) => { clock += ms; } };
}

/** Pretend the host's clip player played the first 5 seconds. */
function hearClip(host, secs = 5) {
  host.playback({ status: 'playing', pos: 1, from: 0, to: 5 });
  host.playback({ status: 'stopped', pos: secs, from: 0, to: 5 });
}

const trackOf = (room) => G.trackById(room.game, room.game.current.trackId);
const peerOf = (room, playerId) => room.players.find((p) => p.id === playerId).peerId;
const currentPeer = (room) => Room.currentPlayer(room).peerId;
const otherPeer = (room) => room.players.find((p) => p.id !== Room.currentPlayer(room).id).peerId;

test('room codes: 4 unambiguous letters, normalised input, join link', () => {
  const rng = seeded(3);
  for (let i = 0; i < 200; i++) {
    const c = Room.generateCode(rng);
    assert.match(c, /^[A-Z]{4}$/);
    assert.ok(!/[IOL]/.test(c), c);
    assert.equal(Room.normalizeCode(c.toLowerCase()), c);
  }
  assert.equal(Room.normalizeCode(' ab-cd '), 'ABCD');
  assert.equal(Room.normalizeCode('ABCDE'), 'ABCDE');
  for (const bad of ['', 'ABC', 'ABCDEF', 'AB0D', 'ABOD', 'AB1D', 'ABID']) assert.equal(Room.normalizeCode(bad), '', bad);
  assert.equal(Room.joinLink('https://x.github.io/game/?foo=1#h', 'ABCD'), 'https://x.github.io/game/?room=ABCD');
  assert.equal(Room.joinLink('http://localhost:3000/', 'ABCD', 'local'), 'http://localhost:3000/?room=ABCD&transport=local');
  assert.equal(Room.peerIdFor('ABCD'), 'gts-room-ABCD');
});

test('players join the lobby and get a snapshot with their own token', () => {
  const { room, transport, changes } = setup();
  assert.equal(room.players.length, 2);
  const a = transport.last('peer1', 'state').state;
  assert.equal(a.v, Room.PROTOCOL);
  assert.equal(a.phase, 'lobby');
  assert.equal(a.you.name, 'Alice');
  assert.ok(a.you.token && a.you.token.length >= 16);
  assert.deepEqual(a.players.map((p) => p.name), ['Alice', 'Bob'], 'Alice was told Bob joined');
  const b = transport.last('peer2', 'state').state;
  assert.notEqual(b.you.token, a.you.token);
  assert.ok(!JSON.stringify(b).includes(a.you.token), 'a player never sees another player’s token');
  assert.deepEqual(changes, ['join', 'join']);
  assert.equal(Room.playerScreen(a), 'lobby');

  transport.deliver('peer1', hello('Alice again'));
  assert.equal(room.players.length, 2, 'one connection is one player');
  assert.equal(transport.last('peer1', 'state').state.you.name, 'Alice');
  transport.deliver('peer3', hello('alice'));
  assert.equal(transport.last('peer3').code, 'name-taken');
  transport.deliver('peer3', hello('   '));
  assert.equal(transport.last('peer3').code, 'bad-name');
  transport.deliver('peer3', { v: 999, type: 'hello', name: 'Zed' });
  assert.equal(transport.last('peer3').code, 'version');
  transport.deliver('peer3', act('play'));
  assert.equal(transport.last('peer3').code, 'not-joined');
  assert.equal(room.players.length, 2);
});

test('the room is capped at 12 players and local players share the host device', () => {
  const { room, transport, host } = setup({ names: [] });
  assert.ok(host.addLocalPlayer('Grandma').ok);
  assert.equal(host.addLocalPlayer('grandma').code, 'name-taken');
  transport.deliver('px', hello('Grandma'));
  assert.equal(transport.last('px').code, 'name-taken', 'a phone cannot take over a local player');
  for (let i = 1; i <= 11; i++) transport.deliver('p' + i, hello('P' + i));
  assert.equal(room.players.length, 12);
  transport.deliver('p99', hello('Late'));
  assert.equal(transport.last('p99').code, 'full');
});

test('only the current player (or the host) can act; out-of-turn actions are rejected', () => {
  const { room, transport, host, effects } = setup();
  assert.equal(Room.applyAction(room, 'p1', { type: 'play' }).code, 'not-started');
  assert.ok(host.start().ok);
  assert.equal(room.game.phase, 'round');
  const cur = Room.currentPlayer(room);
  assert.equal(cur.name, 'Alice');

  transport.clear();
  for (const type of ['play', 'extend', 'answer', 'reveal', 'next', 'stop']) {
    transport.deliver(otherPeer(room), act(type, { optionId: room.game.current.options[0].id }));
    const err = transport.last(otherPeer(room));
    assert.equal(err.type, 'error', type);
    assert.equal(err.code, 'not-your-turn', type);
    assert.match(err.message, /Alice/);
  }
  assert.equal(effects.length, 0, 'nothing happened on the host');
  assert.equal(room.game.current.answered, false);
  // Players may not use host-only actions.
  transport.deliver(currentPeer(room), act('skip'));
  assert.equal(transport.last(currentPeer(room)).code, 'bad-action');
  transport.deliver(currentPeer(room), act('end'));
  assert.equal(transport.last(currentPeer(room)).code, 'bad-action');

  transport.deliver(currentPeer(room), act('play'));
  assert.deepEqual(effects.pop(), { type: 'play', from: 0, to: 5, actor: cur.id });
  assert.ok(host.act('play').ok, 'host fallback');
  assert.equal(effects.pop().actor, 'host');
  assert.equal(Room.applyAction(room, cur.id, { type: 'fly' }).code, 'bad-action');
});

test('answer scoring: +10 after 5 s, extend needs a heard clip and gives +5, wrong and reveal give 0', () => {
  const { room, transport, host, effects } = setup({ rounds: 2 });
  host.start();
  const alice = currentPeer(room);
  const bob = otherPeer(room);

  // Alice: correct after 5 seconds.
  transport.deliver(alice, act('play'));
  hearClip(host);
  transport.deliver(alice, act('answer', { optionId: 'nope' }));
  assert.equal(transport.last(alice).code, 'bad-answer');
  transport.deliver(alice, act('answer', { optionId: trackOf(room).id }));
  assert.equal(effects.pop().type, 'answered');
  let v = transport.last(alice, 'state').state;
  assert.equal(v.phase, 'result');
  assert.equal(Room.playerScreen(v), 'result');
  assert.equal(v.result.outcome, 'correct');
  assert.equal(v.result.points, 10);
  assert.equal(v.players.find((p) => p.name === 'Alice').score, 10);
  assert.equal(v.turn.nextPlayerName, 'Bob');
  // A second answer to the same song is ignored.
  transport.deliver(alice, act('reveal'));
  assert.equal(transport.last(alice).code, 'not-now');
  // Bob can't press Next for Alice's song; Alice can.
  transport.deliver(bob, act('next'));
  assert.equal(transport.last(bob).code, 'not-your-turn');
  transport.deliver(alice, act('next'));
  assert.equal(effects.pop().type, 'next');

  // Bob: extend is locked until the first clip was heard, then correct = +5.
  assert.equal(Room.currentPlayer(room).name, 'Bob');
  transport.deliver(bob, act('extend'));
  assert.equal(transport.last(bob).code, 'not-now');
  transport.deliver(bob, act('play'));
  hearClip(host);
  v = transport.last(bob, 'state').state;
  assert.equal(v.turn.playedOnce, true, 'the stop was broadcast');
  transport.deliver(bob, act('extend'));
  assert.deepEqual(effects.pop(), { type: 'play', from: 5, to: 15, extend: true, actor: room.players[1].id });
  transport.deliver(bob, act('extend'));
  assert.equal(transport.last(bob).code, 'not-now');
  v = transport.last(bob, 'state').state;
  assert.equal(v.turn.extended, true);
  assert.equal(v.turn.worth, 5);
  transport.deliver(bob, act('answer', { optionId: trackOf(room).id }));
  assert.equal(transport.last(bob, 'state').state.result.points, 5);
  transport.deliver(bob, act('next'));

  // Round 2: Alice wrong, Bob reveals.
  const wrong = room.game.current.options.find((o) => o.id !== trackOf(room).id);
  transport.deliver(alice, act('answer', { optionId: wrong.id }));
  v = transport.last(alice, 'state').state;
  assert.equal(v.result.outcome, 'wrong');
  assert.equal(v.result.points, 0);
  assert.equal(v.result.guess, wrong.title);
  transport.deliver(alice, act('next'));
  transport.deliver(bob, act('reveal'));
  v = transport.last(bob, 'state').state;
  assert.equal(v.result.outcome, 'revealed');
  assert.equal(v.turn.last, true);
  transport.deliver(bob, act('next'));
  assert.equal(effects.pop().type, 'over');

  for (const peer of [alice, bob]) {
    v = transport.last(peer, 'state').state;
    assert.equal(Room.playerScreen(v), 'over');
    assert.deepEqual(v.over.standings.map((s) => [s.name, s.score, s.rank]), [['Alice', 10, 1], ['Bob', 5, 2]]);
    assert.equal(v.over.songsPlayed, 4);
  }
  transport.deliver(alice, act('play'));
  assert.equal(transport.last(alice).code, 'game-over');
});

test('free answer mode: text answers are matched with GameLogic', () => {
  const { room, transport, host } = setup({ mode: 'free', rounds: 1 });
  host.start();
  const alice = currentPeer(room);
  transport.deliver(alice, act('answer', { text: '   ' }));
  assert.equal(transport.last(alice).code, 'bad-answer');
  transport.deliver(alice, act('answer', { text: trackOf(room).title.toUpperCase() + '!!' }));
  assert.equal(transport.last(alice, 'state').state.result.outcome, 'correct');
  transport.deliver(alice, act('next'));
  const bob = currentPeer(room);
  transport.deliver(bob, act('answer', { text: 'definitely not this' }));
  assert.equal(transport.last(bob, 'state').state.result.outcome, 'wrong');
});

test('snapshots never contain the current song before the guess is resolved', () => {
  for (const mode of ['free', 'choice']) {
    const { room, transport, host } = setup({ mode, rounds: 3, seed: 11 });
    host.start();
    let resolvedTurns = 0;
    while (room.game.phase !== 'over') {
      const t = trackOf(room);
      const peer = currentPeer(room);
      const waiting = otherPeer(room);
      transport.clear();
      transport.deliver(peer, act('play'));
      hearClip(host);
      transport.deliver(peer, act('extend'));
      host.playback({ status: 'playing', pos: 9, from: 5, to: 15 });
      const before = JSON.stringify(transport.sent);
      assert.ok(transport.sent.length > 0);
      for (const secret of [t.previewUrl, t.image, 'cover', 'preview', 'trackId', '"outcome"', '"track"']) {
        assert.ok(!before.includes(secret), `${mode}: ${secret} leaked before the answer`);
      }
      if (mode === 'free') {
        assert.ok(!before.includes(t.title), 'free mode: title not sent');
        assert.ok(!before.includes(t.artist), 'free mode: artist not sent');
      } else {
        const mine = transport.last(peer, 'state').state;
        assert.equal(mine.turn.options.length, 4);
        assert.ok(mine.turn.options.every((o) => Object.keys(o).sort().join() === 'artist,id,title'), 'no correctness flag');
        const theirs = JSON.stringify(transport.to(waiting));
        assert.ok(!theirs.includes(t.title), 'waiting players get no options');
        assert.equal(transport.last(waiting, 'state').state.turn.options, null);
        assert.equal(Room.playerScreen(transport.last(waiting, 'state').state), 'waiting');
        assert.equal(Room.playerScreen(mine), 'turn');
      }
      transport.deliver(peer, act('reveal'));
      // After the reveal everyone learns the answer.
      for (const p of [peer, waiting]) {
        const r = transport.last(p, 'state').state.result;
        assert.equal(r.track.title, t.title);
        assert.equal(r.track.image, t.image);
        assert.ok(!JSON.stringify(r).includes(t.previewUrl), 'the preview URL is never sent');
      }
      resolvedTurns++;
      transport.deliver(peer, act('next'));
    }
    assert.equal(resolvedTurns, 6);
  }
});

test('a dropped player keeps their score and reclaims the slot with a token or their name', () => {
  const { room, transport, host, changes } = setup({ rounds: 3 });
  host.start();
  const alice = currentPeer(room);
  transport.deliver(alice, act('answer', { optionId: trackOf(room).id }));
  transport.deliver(alice, act('next'));
  const aliceToken = transport.last(alice, 'state').state.you.token;
  const bobToken = transport.last('peer2', 'state').state.you.token;

  transport.drop('peer2');
  assert.equal(changes.pop(), 'leave');
  const bob = room.players[1];
  assert.equal(bob.online, false);
  assert.equal(bob.peerId, null);
  let v = transport.last(alice, 'state').state;
  assert.equal(v.players[1].online, false, 'others see Bob offline');
  assert.equal(v.turn.playerOnline, false);

  // Somebody else can't take Bob's slot while the game runs...
  transport.deliver('peer9', hello('Mallory'));
  assert.equal(transport.last('peer9').code, 'started');
  // ...and a wrong token with another name doesn't help.
  transport.deliver('peer9', hello('Mallory', 'bogus'));
  assert.equal(transport.last('peer9').code, 'started');

  // Bob comes back on a new connection with his token (name even differs in case).
  transport.deliver('peer2b', hello('BOB', bobToken));
  assert.equal(bob.peerId, 'peer2b');
  assert.equal(bob.online, true);
  assert.equal(room.players.length, 2);
  v = transport.last('peer2b', 'state').state;
  assert.equal(v.you.id, bob.id);
  assert.equal(v.you.token, bobToken);
  assert.equal(Room.playerScreen(v), 'turn', 'it is still his turn');
  assert.equal(v.turn.options.length, 4);

  // Reclaim by name after a drop (e.g. a new phone without the stored token).
  transport.drop(alice);
  transport.deliver('alice-new-phone', hello('alice'));
  assert.equal(room.players[0].peerId, 'alice-new-phone');
  assert.equal(transport.last('alice-new-phone', 'state').state.you.token, aliceToken);
  assert.equal(transport.last('alice-new-phone', 'state').state.players[0].score, 10, 'score kept');
  // A token beats a name clash: an old tab that still looks online is replaced.
  transport.deliver('alice-tab-3', hello('Alice', aliceToken));
  assert.equal(room.players[0].peerId, 'alice-tab-3');
  assert.equal(transport.last('alice-new-phone').code, 'replaced', 'the old tab is told');
  transport.deliver('alice-new-phone', act('play'));
  assert.equal(transport.last('alice-new-phone').code, 'not-joined', 'the replaced connection lost the slot');
});

test('the host can skip an offline player’s turn', () => {
  const { room, transport, host, effects } = setup({ rounds: 1 });
  host.start();
  transport.drop(currentPeer(room));
  assert.equal(Room.currentPlayer(room).online, false);
  const heardId = room.game.current.trackId;
  assert.ok(host.act('skip').ok);
  assert.equal(effects.pop().type, 'answered');
  const v = transport.last('peer2', 'state').state;
  assert.equal(v.result.outcome, 'skipped');
  assert.equal(v.result.points, 0);
  assert.ok(host.act('next').ok);
  assert.equal(Room.currentPlayer(room).name, 'Bob');
  assert.notEqual(room.game.current.trackId, heardId, 'the skipped song is not replayed');
  assert.ok(room.usedIds.includes(heardId));
  // The host can end the game at any time.
  assert.ok(host.act('end').ok);
  assert.equal(transport.last('peer2', 'state').state.phase, 'over');
});

test('late joiners are refused once the game started; lobby players can be removed', () => {
  const { room, transport, host } = setup({ names: ['Alice', 'Bob', 'Cara'] });
  const cara = room.players[2];
  host.removePlayer(cara.id);
  assert.equal(transport.last('peer3').code, 'removed');
  assert.deepEqual(room.players.map((p) => p.name), ['Alice', 'Bob']);
  host.start();
  transport.deliver('peer4', hello('Dan'));
  assert.equal(transport.last('peer4').code, 'started');
  assert.equal(host.removePlayer(room.players[0].id), null, 'no removals mid-game');
});

test('playback updates are throttled while playing and remember what was heard', () => {
  const { room, transport, host, tick } = setup();
  host.start();
  transport.clear();
  host.playback({ status: 'loading', pos: 0, from: 0, to: 5 });
  host.playback({ status: 'playing', pos: 0.1, from: 0, to: 5 });
  host.playback({ status: 'playing', pos: 0.2, from: 0, to: 5 }); // throttled
  tick(300);
  host.playback({ status: 'playing', pos: 1.5, from: 0, to: 5 });
  const pbs = transport.to('peer1').filter((m) => m.type === 'playback').map((m) => m.playback.status + '@' + m.playback.pos);
  assert.deepEqual(pbs, ['loading@0', 'playing@0.1', 'playing@1.5']);
  assert.equal(room.turn.playedOnce, false);
  host.playback({ status: 'stopped', pos: 5, from: 0, to: 5 });
  assert.equal(room.turn.playedOnce, true);
  assert.equal(room.playback.heard, 5);
  // Positions are clamped to what may be heard.
  host.playback({ status: 'stopped', pos: 99 });
  assert.equal(room.playback.heard, 5);
  // The state snapshot carries playback too (for a phone that reconnects mid-clip).
  assert.equal(host.viewFor(room.players[0].id).playback.heard, 5);
});

test('room state survives a JSON round trip (sessionStorage restore)', () => {
  const { room, transport, host } = setup({ rounds: 2 });
  host.start();
  transport.deliver(currentPeer(room), act('answer', { optionId: trackOf(room).id }));
  const restored = JSON.parse(JSON.stringify(room));
  // After a host reload nobody is connected until they rejoin.
  restored.players.forEach((p) => { if (!p.local) { p.online = false; p.peerId = null; } });
  const t2 = fakeTransport();
  const host2 = Room.createHost({ room: restored, transport: t2, rng: seeded(1) });
  t2.deliver('new-peer', hello('Alice', room.players[0].token));
  const v = t2.last('new-peer', 'state').state;
  assert.equal(v.phase, 'result');
  assert.equal(v.players[0].score, 10);
  assert.ok(host2.act('next').ok);
  assert.equal(Room.currentPlayer(restored).name, 'Bob');
});

test('player controller: connects, stores the token, retries when the host disappears, stops on fatal errors', async () => {
  const statuses = [];
  const states = [];
  const tokens = [];
  const made = [];
  const pending = [];
  const timers = { setTimeout: (fn) => { pending.push(fn); return pending.length; }, clearTimeout: () => {} };
  function fakePlayerTransport({ fail } = {}) {
    const h = { message: [], leave: [] };
    const t = {
      sent: [],
      onMessage: (fn) => h.message.push(fn),
      onPeerLeave: (fn) => h.leave.push(fn),
      connect: () => (fail ? Promise.reject(Object.assign(new Error('nope'), { code: fail })) : Promise.resolve()),
      send: (to, m) => t.sent.push(m),
      close: () => { t.closed = true; },
      fromHost: (m) => h.message.forEach((fn) => fn('host', m)),
      hostLeft: () => h.leave.forEach((fn) => fn('host')),
    };
    return t;
  }
  let nextFail = 'room-not-found';
  const player = Room.createPlayer({
    code: 'ABCD', name: 'Alice', token: null, timers, retryMs: 1, maxRetries: 2,
    makeTransport: () => { const t = fakePlayerTransport({ fail: nextFail }); made.push(t); return t; },
    hooks: { onStatus: (s, d) => statuses.push(s + (d ? ':' + d.code : '')), onState: (v) => states.push(v), onToken: (t) => tokens.push(t) },
  });
  const flush = () => new Promise((r) => setImmediate(r));

  player.start();
  await flush();
  assert.deepEqual(statuses, ['connecting', 'failed:room-not-found'], 'unknown room: no retry loop');

  nextFail = null;
  player.retry();
  await flush();
  const t1 = made[1];
  assert.deepEqual(t1.sent, [{ v: 1, type: 'hello', name: 'Alice', token: null }]);
  t1.fromHost({ v: 1, type: 'state', state: { phase: 'lobby', you: { id: 'p1', name: 'Alice', token: 'tok123' } } });
  assert.equal(statuses.at(-1), 'connected');
  assert.deepEqual(tokens, ['tok123']);
  assert.ok(player.act('play'));
  assert.deepEqual(t1.sent.at(-1), { v: 1, type: 'play' });

  // The host reloads: the player retries and says hello with the stored token.
  t1.hostLeft();
  assert.equal(statuses.at(-1), 'reconnecting:host-left');
  assert.equal(player.act('play'), false, 'actions are not sent while reconnecting');
  nextFail = 'room-not-found'; // the host page hasn't come back yet
  pending.shift()();
  await flush();
  assert.equal(statuses.at(-1), 'reconnecting:room-not-found', 'keeps trying after having been connected');
  nextFail = null;
  pending.shift()();
  await flush();
  const t3 = made.at(-1);
  assert.equal(t3.sent[0].token, 'tok123');
  t3.fromHost({ v: 1, type: 'state', state: { phase: 'round', you: { id: 'p1', name: 'Alice', token: 'tok123' } } });
  assert.equal(statuses.at(-1), 'connected');

  // Retries are limited.
  t3.hostLeft();
  nextFail = 'room-not-found';
  pending.shift()(); await flush();
  pending.shift()(); await flush();
  assert.equal(statuses.at(-1), 'failed:host-left');

  // A fatal protocol error stops the player.
  nextFail = null;
  player.retry();
  await flush();
  made.at(-1).fromHost({ v: 1, type: 'error', code: 'name-taken', message: 'taken' });
  assert.equal(statuses.at(-1), 'failed:name-taken');
  assert.equal(made.at(-1).closed, true);
  player.leave();
  assert.equal(player.status(), 'left');
});

test('malformed messages from a peer are rejected without crashing the host or changing the room', () => {
  const { room, transport, host, effects } = setup({ names: ['Alice'] });
  const before = JSON.stringify(room);
  // Garbage hellos: a name that can't become a string, wrong types, huge strings.
  const junk = [
    null, 42, 'hello', [], [1, 2],
    { v: 1 }, { v: '1', type: 'hello', name: 'X' }, { v: 1, type: 'hello' },
    { v: 1, type: 'hello', name: { toString: 1 } }, { v: 1, type: 'hello', name: ['Bob'] },
    { v: 1, type: 'hello', name: { a: 1 }, token: { b: 2 } },
    { v: 1, type: 'play' }, { v: 1, type: '__proto__' }, { v: 1, type: 'constructor' },
  ];
  for (const m of junk) assert.doesNotThrow(() => transport.deliver('mallory', m), JSON.stringify(m));
  assert.equal(JSON.stringify(room), before, 'no new player, nothing changed');
  // A name longer than allowed is cut, not refused.
  transport.deliver('longname', hello('Z'.repeat(100000)));
  assert.equal(room.players.at(-1).name, 'Z'.repeat(24));
  assert.equal(Room.cleanName(7), '7');

  host.start();
  const peer = currentPeer(room);
  const game = JSON.stringify(room.game);
  for (const m of [
    act('answer'), act('answer', { optionId: null }), act('answer', { optionId: { id: 'x' } }),
    act('answer', { optionId: ['t1'] }), act('answer', { text: 5 }), act('answer', { text: 'x'.repeat(1e6) }),
    act('next'), act('extend'), act('skip'), act('end'),
  ]) {
    assert.doesNotThrow(() => transport.deliver(peer, m));
    assert.equal(transport.last(peer).type, 'error', JSON.stringify(m).slice(0, 60));
  }
  assert.equal(JSON.stringify(room.game), game, 'rejected actions leave the game alone');
  assert.equal(effects.length, 0);
});

test('free-text guesses are capped and multiple-choice order does not give the answer away', () => {
  const { room, transport, host } = setup({ mode: 'free', names: ['Alice'] });
  host.start();
  transport.deliver(currentPeer(room), act('answer', { text: 'y'.repeat(1e6) }));
  assert.equal(room.game.current.guess.length, 200);
  assert.equal(room.game.phase, 'result');

  // Across many rooms, the right option shows up in every position.
  const positions = new Set();
  for (let seed = 1; seed <= 40; seed++) {
    const s = setup({ seed, names: ['Alice'] });
    s.host.start();
    const opts = s.transport.last(currentPeer(s.room), 'state').state.turn.options;
    positions.add(opts.findIndex((o) => o.id === s.room.game.current.trackId));
  }
  assert.deepEqual([...positions].sort(), [0, 1, 2, 3]);
});

test('a single-track link’s name (the song title) is kept from players until the game is over', () => {
  const room = Room.createRoom({
    code: 'ABCD', settings: { mode: 'free', rounds: 0 },
    source: { type: 'track', name: TRACKS[0].title, image: null, key: 'track:x' },
    tracks: [{ ...TRACKS[0] }],
  });
  const transport = fakeTransport();
  const host = Room.createHost({ room, transport });
  transport.deliver('peer1', hello('Alice'));
  host.start();
  assert.ok(!JSON.stringify(transport.sent).includes(TRACKS[0].title));
  transport.deliver('peer1', act('reveal'));
  transport.deliver('peer1', act('next'));
  assert.equal(transport.last('peer1', 'state').state.source.name, TRACKS[0].title);
});

test('a finished clip is reported as a change, so a host reload keeps "play next 10 seconds" unlocked', () => {
  const { room, host, changes } = setup();
  host.start();
  changes.length = 0;
  hearClip(host);
  assert.ok(changes.includes('playback'));
  assert.equal(room.turn.playedOnce, true);
});
