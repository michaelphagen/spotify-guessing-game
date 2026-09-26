'use strict';

// LocalTransport (BroadcastChannel) end to end in one Node process, driven by
// the real host and player controllers from room.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const Transport = require('../public/lib/transport.js');
const Room = require('../public/lib/room.js');

const FAST = { probeMs: 30, connectMs: 40, keepAliveMs: 50, timeoutMs: 300 };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 2000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return; await wait(10); }
  throw new Error('timed out waiting');
}

const TRACKS = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo'].map((title, i) => ({
  id: 'id' + i, title, artist: 'Band ' + i, previewUrl: 'https://p.scdn.co/mp3-preview/x' + i, image: null,
}));

test('kindFromSearch picks the BroadcastChannel transport only with ?transport=local', () => {
  assert.equal(Transport.kindFromSearch('?room=ABCD&transport=local'), 'local');
  assert.equal(Transport.kindFromSearch('?transport=LOCAL'), 'local');
  assert.equal(Transport.kindFromSearch('?room=ABCD'), 'peer');
  assert.equal(Transport.kindFromSearch(''), 'peer');
  assert.equal(Transport.create('peer', { Peer: function () {} }).kind, 'peer');
});

test('LocalTransport: unknown room, taken room code', async () => {
  const p = Transport.create('local', FAST);
  await assert.rejects(p.connect('ZZZZ'), (e) => e.code === 'room-not-found');
  p.close();
  const h1 = Transport.create('local', FAST);
  await h1.host('TAKN');
  const h2 = Transport.create('local', FAST);
  await assert.rejects(h2.host('TAKN'), (e) => e.code === 'room-taken');
  h1.close();
  h2.close();
});

test('LocalTransport: players join, play a turn, drop, rejoin, and see the host leave', async () => {
  const room = Room.createRoom({ code: 'QWER', settings: { mode: 'choice', rounds: 1 }, source: { type: 'playlist', name: 'P' }, tracks: TRACKS });
  const hostT = Transport.create('local', FAST);
  await hostT.host('QWER');
  const effects = [];
  const host = Room.createHost({ room, transport: hostT, hooks: { onEffect: (e) => effects.push(e.type) } });

  function makePlayer(name, token) {
    const p = { statuses: [], view: null, transports: [] };
    p.ctl = Room.createPlayer({
      code: 'QWER', name, token, retryMs: 50, maxRetries: 40,
      makeTransport: () => { const t = Transport.create('local', FAST); p.transports.push(t); return t; },
      hooks: { onStatus: (s) => p.statuses.push(s), onState: (v) => { p.view = v; } },
    });
    p.ctl.start();
    return p;
  }
  const alice = makePlayer('Alice');
  const bob = makePlayer('Bob');
  await until(() => alice.view && bob.view && alice.view.players.length === 2);
  assert.equal(alice.view.phase, 'lobby');

  host.start();
  await until(() => alice.view.phase === 'round');
  assert.equal(Room.playerScreen(alice.view), 'turn');
  await until(() => Room.playerScreen(bob.view) === 'waiting');
  alice.ctl.act('play');
  await until(() => effects.includes('play'));
  const correct = room.game.current.trackId;
  alice.ctl.act('answer', { optionId: correct });
  await until(() => bob.view.phase === 'result');
  assert.equal(bob.view.result.points, 10);

  // Bob closes his tab; the host marks him offline, keeping his slot.
  const bobToken = bob.ctl.token();
  bob.ctl.leave();
  await until(() => room.players[1].online === false);
  const bob2 = makePlayer('Bob', bobToken);
  await until(() => bob2.view && room.players[1].online);
  assert.equal(bob2.view.you.id, room.players[1].id);
  assert.equal(room.players.length, 2);

  // The host closes: players notice and start reconnecting.
  hostT.close();
  await until(() => alice.statuses.includes('reconnecting'));
  // The host comes back (e.g. after a reload) with the same room: players rejoin.
  const hostT2 = Transport.create('local', FAST);
  await hostT2.host('QWER');
  const restored = JSON.parse(JSON.stringify(room));
  restored.players.forEach((p) => { p.online = false; p.peerId = null; });
  Room.createHost({ room: restored, transport: hostT2 });
  await until(() => restored.players.every((p) => p.online), 3000);
  assert.equal(alice.statuses.at(-1), 'connected');

  alice.ctl.leave();
  bob2.ctl.leave();
  hostT2.close();
});

test('keep-alive: a tab that was frozen or busy doesn’t count its own stall against its peers', async () => {
  const opts = { probeMs: 30, connectMs: 40, keepAliveMs: 30, timeoutMs: 150 };
  const h = Transport.create('local', opts);
  await h.host('STAL');
  const p = Transport.create('local', opts);
  const left = [];
  h.onPeerLeave((id) => left.push('host saw ' + id));
  p.onPeerLeave((id) => left.push('player saw ' + id));
  await p.connect('STAL');
  await wait(80);
  const end = Date.now() + 400;
  while (Date.now() < end) { /* both "tabs" are blocked, longer than the timeout */ }
  await wait(150);
  assert.deepEqual(left, []);
  // Peers that really went quiet (no goodbye: the network dropped) are still dropped.
  const origPost = BroadcastChannel.prototype.postMessage;
  try {
    BroadcastChannel.prototype.postMessage = function () {};
    await until(() => left.length === 2, 2000);
  } finally {
    BroadcastChannel.prototype.postMessage = origPost;
  }
  assert.deepEqual(left.map((l) => l.split(' ')[0]).sort(), ['host', 'player']);
  p.close();
  h.close();
});

test('PeerTransport: a replacement connection from the same peer keeps its keep-alive; leave fires once', async () => {
  const { EventEmitter } = require('node:events');
  class FakeConn extends EventEmitter {
    constructor(peer) { super(); this.peer = peer; this.open = true; this.sent = []; }
    send(m) { if (!this.open) throw new Error('closed'); this.sent.push(m); }
    close() { if (!this.open) return; this.open = false; this.emit('close'); }
  }
  let peer = null;
  class FakePeer extends EventEmitter {
    constructor(id) { super(); this.id = id; peer = this; setTimeout(() => this.emit('open'), 1); }
    destroy() { this.destroyed = true; }
  }
  const hadRTC = 'RTCPeerConnection' in globalThis;
  if (!hadRTC) globalThis.RTCPeerConnection = function () {};
  try {
    const t = Transport.PeerTransport({ Peer: FakePeer, keepAliveMs: 20, timeoutMs: 120 });
    await t.host('ABCD');
    assert.equal(peer.id, 'gts-room-ABCD');
    const joins = [];
    const leaves = [];
    const msgs = [];
    t.onPeerJoin((id) => joins.push(id));
    t.onPeerLeave((id) => leaves.push(id));
    t.onMessage((id, m) => msgs.push([id, m]));
    const c1 = new FakeConn('px');
    peer.emit('connection', c1); c1.emit('open');
    const c2 = new FakeConn('px');
    peer.emit('connection', c2); c2.emit('open');
    assert.equal(c1.open, false, 'the old connection is closed');
    assert.deepEqual(leaves, [], 'replacing a connection is not a leave');
    await wait(70);
    assert.ok(c2.sent.length > 0, 'keep-alives go to the new connection');
    c2.emit('data', { v: 1, type: 'play' });
    c2.emit('data', { __gts_ka: 1 });
    assert.deepEqual(msgs, [['px', { v: 1, type: 'play' }]], 'keep-alives are not delivered as messages');
    // The new connection goes silent: dropped once, and closed.
    await until(() => leaves.length > 0, 1000);
    await wait(60);
    assert.deepEqual(leaves, ['px']);
    assert.equal(c2.open, false);
    assert.doesNotThrow(() => t.send('px', { v: 1 }), 'sending to a gone peer is a no-op');
    t.close();
    t.close();
    assert.equal(peer.destroyed, true);
  } finally {
    if (!hadRTC) delete globalThis.RTCPeerConnection;
  }
});
