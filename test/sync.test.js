'use strict';

// "Sound plays on every player's device": clock sync, preload/play/halt
// messages (what each phone may see), the setting in snapshots and saved rooms,
// and the player controller's side (pings, hooks, relay after ICE failures).

const test = require('node:test');
const assert = require('node:assert/strict');
const G = require('../public/game-logic.js');
const Room = require('../public/lib/room.js');

const TRACKS = [
  ['t1', 'Jailhouse Rock', 'Elvis Presley'],
  ['t2', 'Hey Jude', 'The Beatles'],
  ['t3', 'Bohemian Rhapsody', 'Queen'],
  ['t4', 'Billie Jean', 'Michael Jackson'],
  ['t5', 'Imagine', 'John Lennon'],
].map(([id, title, artist]) => ({
  id, title, artist, uri: 'spotify:track:' + id, durationMs: 200000,
  previewUrl: 'https://p.scdn.co/mp3-preview/' + id + 'hash',
  image: 'https://i.scdn.co/image/' + id + 'cover',
}));

function fakeTransport() {
  const h = { message: [], leave: [] };
  const t = {
    sent: [],
    onMessage: (fn) => h.message.push(fn),
    onPeerLeave: (fn) => h.leave.push(fn),
    onPeerJoin: () => {},
    send: (to, msg) => t.sent.push({ to, msg: JSON.parse(JSON.stringify(msg)) }),
    deliver: (from, msg) => h.message.forEach((fn) => fn(from, JSON.parse(JSON.stringify(msg)))),
    to: (peer, type) => t.sent.filter((s) => s.to === peer && (!type || s.msg.type === type)).map((s) => s.msg),
    clear: () => { t.sent.length = 0; },
  };
  return t;
}

function setup({ soundOn, engine = 'preview', names = ['Alice', 'Bob'], localName } = {}) {
  const room = Room.createRoom({
    code: 'SYNC',
    settings: { mode: 'choice', rounds: 2, clipStart: 'random', engine, soundOn },
    source: { type: 'playlist', name: 'Hits' },
    tracks: TRACKS.map((t) => ({ ...t })),
  });
  const transport = fakeTransport();
  let clock = 1000000;
  const host = Room.createHost({ room, transport, now: () => clock, clock: () => clock + 500 });
  names.forEach((n, i) => transport.deliver('peer' + (i + 1), Room.message('hello', { name: n })));
  if (localName) host.addLocalPlayer(localName);
  return { room, transport, host, tick: (ms) => { clock += ms; } };
}
const trackOf = (room) => G.trackById(room.game, room.game.current.trackId);
const seg = (room, extra) => {
  const t = trackOf(room);
  return { engine: room.settings.engine, startMs: 12000, endMs: 17000, from: 0, to: 5, startAt: 5000, previewUrl: t.previewUrl, uri: t.uri, durationMs: t.durationMs, ...extra };
};

test('clock offset from ping/pong: the shortest round trips win', () => {
  // Host clock = phone clock + 250 ms. Samples: {t0, ht, t1} with symmetric delays.
  const mk = (t0, oneWay, back) => ({ t0, ht: t0 + oneWay + 250, t1: t0 + oneWay + back });
  const est = Room.estimateClockOffset([mk(0, 200, 30), mk(1000, 10, 10), mk(2000, 12, 12), mk(3000, 90, 5)]);
  assert.ok(Math.abs(est.offset - 250) <= 1, 'offset ' + est.offset);
  assert.equal(est.rtt, 20);
  assert.equal(est.n, 4);
  assert.equal(Room.estimateClockOffset([]), null);
  assert.equal(Room.estimateClockOffset([{ t0: 5, ht: 1, t1: 2 }]), null, 'a pong before its ping is ignored');
});

test('host answers pings (also before hello) and records what phones report in hello / sync', () => {
  const { room, transport } = setup();
  transport.deliver('stranger', Room.message('ping', { t0: 42 }));
  assert.deepEqual(transport.to('stranger', 'pong'), [{ v: 1, type: 'pong', t0: 42, ht: 1000500 }]);
  transport.deliver('peer3', Room.message('hello', { name: 'Cleo', clockOffset: -1234.4, rtt: 38, spotifyReady: true }));
  const cleo = room.players.find((p) => p.name === 'Cleo');
  assert.deepEqual([cleo.clockOffset, cleo.rtt, cleo.spotifyReady], [-1234, 38, true]);
  transport.deliver('peer3', Room.message('sync', { clockOffset: 17, spotifyReady: false }));
  assert.deepEqual([cleo.clockOffset, cleo.rtt, cleo.spotifyReady], [17, 38, false]);
  transport.deliver('peer3', Room.message('sync', { clockOffset: 'x', rtt: -5, spotifyReady: 'yes' }));
  assert.deepEqual([cleo.clockOffset, cleo.rtt, cleo.spotifyReady], [17, 38, false], 'junk is ignored');
});

test('previews on every device: preload at each turn start, play with the preview URL to every phone, halt on stop/answer', () => {
  const { room, transport, host } = setup({ localName: 'Dora' });
  assert.equal(room.settings.soundOn, 'all', 'every device is the default');
  host.start();
  const t = trackOf(room);
  for (const peer of ['peer1', 'peer2']) {
    assert.deepEqual(transport.to(peer, 'preload'), [{ v: 1, type: 'preload', engine: 'preview', previewUrl: t.previewUrl }]);
  }
  transport.clear();
  const seq = host.play(seg(room));
  assert.equal(seq, 1);
  const a = transport.to('peer1', 'play')[0];
  assert.deepEqual(a, { v: 1, type: 'play', seq: 1, engine: 'preview', startMs: 12000, endMs: 17000, from: 0, to: 5, extend: false, startAt: 5000, offset: null, previewUrl: t.previewUrl, hostOnly: false });
  assert.equal(transport.to('peer2', 'play').length, 1);
  assert.equal(transport.sent.length, 2, 'nothing for the player on the host device');
  // Stop and answers halt the phones' copies.
  transport.clear();
  const current = room.players.find((p) => p.id === Room.currentPlayer(room).id);
  transport.deliver(current.peerId || 'peer1', Room.message('stop'));
  assert.ok(transport.sent.some((s) => s.msg.type === 'halt'));
  transport.clear();
  host.act('reveal');
  assert.equal(transport.to('peer1', 'halt').length, 1);
  // The next turn preloads the next song.
  transport.clear();
  host.act('next');
  assert.equal(transport.to('peer2', 'preload')[0].previewUrl, trackOf(room).previewUrl);
  // A phone that comes back mid-turn gets the preload too.
  transport.clear();
  transport.deliver('peer9', Room.message('hello', { name: 'Alice', token: room.players[0].token }));
  assert.equal(transport.to('peer9', 'preload').length, 1);
});

test('a phone that (re)joins while a clip plays gets that clip (same seq and startAt); not after it ended or was halted', () => {
  const { room, transport, host, tick } = setup();
  host.start();
  const alice = room.players.find((p) => p.name === 'Alice');
  const rejoin = (peer) => transport.deliver(peer, Room.message('hello', { name: 'Alice', token: alice.token }));
  const startAt = host.clock() + 400;
  host.play(seg(room, { startAt }));
  const first = transport.to('peer1', 'play')[0];
  // Mid-clip (the 5-second clip ends at startAt + 5000).
  transport.clear();
  tick(3000);
  rejoin('peer7');
  const again = transport.to('peer7', 'play');
  assert.equal(again.length, 1, 'the clip in progress is re-sent to the rejoining phone');
  assert.deepEqual({ ...again[0], offset: first.offset }, first, 'same seq, segment and start time');
  assert.equal(transport.to('peer2', 'play').length, 0, 'the other phones are left alone');
  // After the clip's end: nothing to catch up with.
  transport.clear();
  tick(3000);
  rejoin('peer8');
  assert.equal(transport.to('peer8', 'play').length, 0);
  // Halted (Stop): nothing either, even within the clip's time.
  host.play(seg(room, { startAt: host.clock() + 400 }));
  host.act('stop');
  transport.clear();
  rejoin('peer9');
  assert.equal(transport.to('peer9', 'play').length, 0);
});

test('full songs on every device: the URI only to phones that reported spotifyReady; no URI in preload', () => {
  const { room, transport, host } = setup({ engine: 'spotify' });
  transport.deliver('peer2', Room.message('sync', { spotifyReady: true }));
  host.start();
  const t = trackOf(room);
  assert.deepEqual(transport.to('peer1', 'preload'), [{ v: 1, type: 'preload', engine: 'spotify' }]);
  transport.clear();
  host.play(seg(room));
  const plain = transport.to('peer1', 'play')[0];
  const ready = transport.to('peer2', 'play')[0];
  assert.equal(plain.uri, undefined);
  assert.equal(plain.previewUrl, undefined);
  assert.equal(plain.hostOnly, true, 'this phone hears the host device');
  assert.equal(ready.uri, t.uri);
  assert.equal(ready.durationMs, 200000);
  assert.equal(ready.hostOnly, false);
  assert.ok(!JSON.stringify(transport.sent).includes(t.id + 'hash'), 'no preview URL with full songs');
});

test('"host device only": no preload, play or halt to phones (as before)', () => {
  const { room, transport, host } = setup({ soundOn: 'host' });
  host.start();
  assert.equal(host.play(seg(room)), 0);
  host.act('reveal');
  assert.deepEqual(transport.sent.filter((s) => ['preload', 'play', 'halt'].includes(s.msg.type)), []);
  assert.equal(transport.to('peer1', 'state').at(-1).state.settings.soundOn, 'host');
});

test('leak check: the preview URL travels in preload/play only; title, artist, cover and URI never do', () => {
  const { room, transport, host } = setup({ names: ['Alice', 'Bob', 'Cleo'] });
  transport.deliver('peer3', Room.message('sync', { spotifyReady: true })); // irrelevant with previews
  host.start();
  for (let turn = 0; turn < 4 && room.game.phase !== 'over'; turn++) {
    const t = trackOf(room);
    transport.clear();
    const peer = Room.currentPlayer(room).peerId;
    transport.deliver(peer, Room.message('play'));
    host.play(seg(room));
    host.playback({ status: 'playing', pos: 1, from: 0, to: 5 });
    host.playback({ status: 'stopped', pos: 5, from: 0, to: 5 });
    for (const s of transport.sent) {
      const body = JSON.stringify(s.msg);
      assert.ok(!body.includes(t.uri) && !body.includes(t.image), 'no URI/cover: ' + s.msg.type);
      if (s.msg.type === 'play' || s.msg.type === 'preload') {
        assert.ok(!body.includes(t.title) && !body.includes(t.artist), 'play/preload carry no title/artist');
      } else {
        assert.ok(!body.includes(t.previewUrl), 'the preview URL only in play/preload, not in ' + s.msg.type);
      }
    }
    // Snapshots never carry the preview URL, before or after the answer.
    transport.deliver(peer, Room.message('reveal'));
    assert.ok(transport.sent.filter((s) => s.msg.type === 'state').every((s) => !JSON.stringify(s.msg).includes(t.previewUrl)));
    transport.deliver(peer, Room.message('next'));
  }
});

test('the setting is in snapshots, saved rooms and restores; old saves get every device; spotifyReady is re-said', () => {
  const { room, transport, host } = setup({ soundOn: 'host', engine: 'spotify' });
  transport.deliver('peer1', Room.message('sync', { spotifyReady: true }));
  host.start();
  const v = transport.to('peer1', 'state').at(-1).state;
  assert.deepEqual(v.settings, { mode: 'choice', rounds: 2, clipStart: 'random', soundOn: 'host', fullSongs: true });
  const saved = JSON.parse(JSON.stringify(Room.savedRoomEntry(room, { now: 1, transport: 'peer' })));
  const back = Room.restoreRoom(saved, { now: 2, transport: 'peer' });
  assert.equal(back.settings.soundOn, 'host');
  assert.equal(back.players[0].spotifyReady, false, 'said again by the phone after it reconnects');
  const old = JSON.parse(JSON.stringify(room));
  delete old.settings.soundOn;
  assert.equal(Room.restoreRoom(old).settings.soundOn, 'all');
  assert.equal(Room.createRoom({ code: 'X', settings: { soundOn: 'nonsense' } }).settings.soundOn, 'all');
});

test('player: clock-sync pings after joining, offset reported with sync; play/preload/halt hooks; setInfo', async () => {
  const timers = [];
  let clock = 0;
  const hooks = { plays: [], preloads: [], halts: [], clocks: [] };
  const made = [];
  const player = Room.createPlayer({
    code: 'ABCD', name: 'Alice', pingCount: 3, pingGapMs: 100, pingEveryMs: 30000,
    now: () => clock, clock: () => clock,
    timers: { setTimeout: (fn, ms) => { timers.push({ fn, at: clock + ms }); return timers.length; }, clearTimeout: (id) => { if (timers[id - 1]) timers[id - 1].off = true; } },
    makeTransport: () => {
      const h = [];
      const t = { sent: [], onMessage: (fn) => h.push(fn), onPeerLeave: () => {}, connect: () => Promise.resolve(), send: (to, m) => t.sent.push(m), close: () => {}, from: (m) => h.forEach((fn) => fn('host', m)) };
      made.push(t);
      return t;
    },
    hooks: { onPlay: (m) => hooks.plays.push(m), onPreload: (m) => hooks.preloads.push(m), onHalt: (m) => hooks.halts.push(m), onClock: (c) => hooks.clocks.push(c) },
  });
  const run = async () => { const n = timers.filter((x) => !x.off && !x.done).sort((a, b) => a.at - b.at)[0]; clock = Math.max(clock, n.at); n.done = true; n.fn(); await new Promise((r) => setImmediate(r)); };
  player.start();
  await new Promise((r) => setImmediate(r));
  const t = made[0];
  assert.equal(t.sent[0].type, 'hello');
  assert.equal(t.sent[0].spotifyReady, undefined, 'hello says nothing about Spotify until it is ready');
  t.from({ v: 1, type: 'state', state: { phase: 'lobby', you: { id: 'p1', name: 'Alice', token: 'x' } } });
  // The host's clock is 5000 ms ahead; each ping takes 20 ms each way.
  const answerPings = () => t.sent.filter((m) => m.type === 'ping' && !m.answered).forEach((m) => { m.answered = true; clock += 40; t.from({ v: 1, type: 'pong', t0: m.t0, ht: m.t0 + 20 + 5000 }); clock -= 40; });
  assert.equal(t.sent.filter((m) => m.type === 'ping').length, 1, 'the first ping goes out at once');
  answerPings();
  await run(); answerPings();
  await run(); answerPings();
  await run(); // all pings out: wait for the last pong
  await run(); // settle
  const sync = t.sent.filter((m) => m.type === 'sync').at(-1);
  assert.equal(sync.clockOffset, 5000);
  assert.equal(sync.rtt, 40);
  assert.equal(player.clockInfo().offset, 5000);
  assert.equal(player.hostNow(), clock + 5000);
  assert.equal(hooks.clocks.length, 1);
  // Messages for the phone's own player.
  t.from({ v: 1, type: 'preload', engine: 'preview', previewUrl: 'u' });
  t.from({ v: 1, type: 'play', seq: 1, startMs: 0, endMs: 5000, startAt: 9 });
  t.from({ v: 1, type: 'halt', seq: 1 });
  assert.deepEqual([hooks.preloads.length, hooks.plays.length, hooks.halts.length], [1, 1, 1]);
  // Signing in to Spotify on the phone: told to the host at once, only on a change.
  assert.equal(player.setInfo({ spotifyReady: true }), true);
  assert.deepEqual(t.sent.at(-1), { v: 1, type: 'sync', spotifyReady: true, clockOffset: 5000, rtt: 40 });
  assert.equal(player.setInfo({ spotifyReady: true }), false);
  assert.equal(player.info().clock.offset, 5000);
  player.leave();
});

test('player: after an ICE failure the next attempt asks for TURN relays only, alternating after that', async () => {
  const asked = [];
  const timers = [];
  let fail = 'ice-failed';
  let clock = 0;
  const statuses = [];
  const player = Room.createPlayer({
    code: 'ABCD', name: 'Alice', joinRetryMs: 4000, joinWaitMs: 180000, now: () => clock,
    timers: { setTimeout: (fn, ms) => { timers.push({ fn, at: clock + ms }); return timers.length; }, clearTimeout: () => {} },
    makeTransport: (o) => {
      asked.push(o.relay);
      return { onMessage: () => {}, onPeerLeave: () => {}, send: () => {}, close: () => {}, connect: () => (fail ? Promise.reject(Object.assign(new Error('x'), { code: fail })) : Promise.resolve()), diag: () => ({ kind: 'fake' }) };
    },
    hooks: { onStatus: (s, d) => statuses.push(s + (d && d.code ? ':' + d.code : '')) },
  });
  const flush = () => new Promise((r) => setImmediate(r));
  const next = async () => { const n = timers.filter((x) => !x.done).sort((a, b) => a.at - b.at)[0]; clock = n.at; n.done = true; n.fn(); await flush(); };
  player.start();
  await flush();
  assert.equal(statuses.at(-1), 'waiting:ice-failed', 'shown as its own case, still retrying');
  await next();
  await next();
  fail = 'room-not-found';
  await next();
  assert.deepEqual(asked, [false, true, false, true], 'all, relay, all, relay (a non-ICE failure keeps the last choice)');
  const info = player.info();
  assert.equal(info.iceFailures, 3);
  assert.equal(info.attempts, 4);
  assert.equal(info.lastError.code, 'room-not-found');
  assert.deepEqual(info.transport, { kind: 'fake' });
  player.leave();
});
