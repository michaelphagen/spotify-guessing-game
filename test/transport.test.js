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

test('keep-alive: nobody is timed out while the page is hidden, and peers get a grace period when it comes back', async () => {
  // A BroadcastChannel per transport whose outgoing traffic can be cut (a frozen tab).
  function mutable() {
    const ctl = { muted: false };
    class BC extends BroadcastChannel { postMessage(m) { if (!ctl.muted) super.postMessage(m); } }
    return { ctl, BC };
  }
  const h = mutable();
  const p = mutable();
  let hostHidden = false;
  const opts = { probeMs: 30, connectMs: 40, keepAliveMs: 20, timeoutMs: 100 };
  const host = Transport.create('local', { ...opts, BroadcastChannel: h.BC, isHidden: () => hostHidden });
  await host.host('HIDE');
  const pl = Transport.create('local', { ...opts, BroadcastChannel: p.BC });
  const left = [];
  host.onPeerLeave(() => left.push('host saw player leave'));
  pl.onPeerLeave(() => left.push('player saw host leave'));
  await pl.connect('HIDE');
  assert.equal(host.status(), 'connected');

  // The host's page is in the background; nothing from the player gets through
  // (the host's own view of time can't be trusted), for 4x the timeout.
  hostHidden = true;
  p.ctl.muted = true;
  await wait(400);
  assert.deepEqual(left, [], 'no timeouts while hidden');

  // Visible again: last-seen clocks restart with a 2x timeout grace period.
  hostHidden = false;
  host.wake({ resumed: true });
  await wait(150); // longer than the timeout, still silent
  assert.deepEqual(left, [], 'grace period after coming back');
  p.ctl.muted = false;
  await wait(300);
  assert.deepEqual(left, [], 'the player is heard again: nobody dropped');

  // A player that really went quiet while the host is visible is still dropped.
  p.ctl.muted = true;
  await until(() => left.includes('host saw player leave'), 2000);
  pl.close();
  host.close();
});

test('PeerTransport host: gets the room back on the signaling server (reconnect, new Peer with the same id, unavailable-id retries)', async () => {
  const { EventEmitter } = require('node:events');
  const peers = [];
  let reconnectMode = 'open'; // what the server does when a disconnected Peer reconnects
  let newPeerMode = 'open'; // ... and when a new Peer registers
  const later = (fn) => setTimeout(fn, 2);
  class FakePeer extends EventEmitter {
    constructor(id, options) {
      super();
      this.id = id; this.options = options; this.open = false; this.disconnected = false; this.destroyed = false; this.reconnects = 0;
      peers.push(this);
      later(() => this.serve(newPeerMode, false));
    }
    serve(mode, reconnecting) {
      if (this.destroyed) return;
      if (mode === 'open') { this.open = true; this.disconnected = false; this.emit('open', this.id); }
      else if (mode === 'taken') {
        // Like PeerJS's _abort: the error, then disconnect() (or destroy() before it ever opened).
        this.emit('error', Object.assign(new Error('ID is taken'), { type: 'unavailable-id' }));
        if (reconnecting) { this.open = false; this.disconnected = true; this.emit('disconnected', this.id); }
        else this.destroy();
      } // 'hang': the server never answers
    }
    reconnect() {
      if (this.destroyed) throw new Error('destroyed');
      if (!this.disconnected) throw new Error('not disconnected');
      this.reconnects++;
      this.disconnected = false;
      later(() => this.serve(reconnectMode, true));
    }
    /** The socket closed (Wi-Fi blip): PeerJS emits a network error, then 'disconnected'. */
    dropSignaling() {
      this.open = false; this.disconnected = true;
      this.emit('error', Object.assign(new Error('Lost connection to server.'), { type: 'network' }));
      this.emit('disconnected', this.id);
    }
    disconnect() {
      if (this.disconnected) return;
      this.open = false; this.disconnected = true;
      this.emit('disconnected', this.id);
    }
    destroy() {
      if (this.destroyed) return;
      this.destroyed = true; this.open = false; this.disconnected = true;
      this.emit('close');
    }
  }
  const hadRTC = 'RTCPeerConnection' in globalThis;
  if (!hadRTC) globalThis.RTCPeerConnection = function () {};
  try {
    const t = Transport.PeerTransport({
      Peer: FakePeer, keepAliveMs: 1000, timeoutMs: 5000,
      signalingRetryMs: 10, signalingRetryMaxMs: 40, reopenTimeoutMs: 60, idRetryForMs: 300,
    });
    const statuses = [];
    const errors = [];
    t.onStatus((s) => statuses.push(s));
    t.onError((e) => errors.push(e.code));
    await t.host('ABCD');
    assert.equal(t.status(), 'connected');
    const p0 = peers[0];

    // 1. A Wi-Fi blip while visible: reconnect() after a short backoff.
    p0.dropSignaling();
    assert.equal(t.status(), 'reconnecting');
    await until(() => t.status() === 'connected');
    assert.equal(p0.reconnects, 1);
    assert.deepEqual(errors, [], 'a transient signaling error is not reported as an error');

    // 2. The tab was in the background and the socket is gone: wake() reconnects at once.
    p0.open = false; p0.disconnected = true; // (the browser hasn't delivered the close event yet)
    t.wake({ resumed: true });
    assert.equal(p0.reconnects, 2, 'reconnect() is called synchronously on wake');
    await until(() => t.status() === 'connected');

    // 3. The Peer was destroyed: a new Peer with the SAME id, and players can connect to it.
    p0.destroyed = true; p0.open = false;
    t.wake({ resumed: true });
    assert.equal(peers.length, 2);
    assert.equal(peers[1].id, 'gts-room-ABCD');
    assert.ok(peers[1].options.token, 'the host Peer has a token');
    assert.equal(peers[1].options.token, peers[0].options.token, 'same token: the server lets it take over the old registration');
    await until(() => t.status() === 'connected');
    const joins = [];
    t.onPeerJoin((id) => joins.push(id));
    const conn = Object.assign(new EventEmitter(), { peer: 'px', open: true, send() {}, close() {} });
    peers[1].emit('connection', conn);
    conn.emit('open');
    assert.deepEqual(joins, ['px']);

    // 4. A reconnect that never opens: it is aborted and retried, and the Peer
    // (with the players' data connections) is kept.
    reconnectMode = 'hang';
    peers[1].dropSignaling();
    await until(() => peers[1].reconnects >= 3, 3000);
    assert.equal(peers.length, 2, 'no new Peer');
    assert.equal(peers[1].destroyed, false);
    reconnectMode = 'open';
    await until(() => t.status() === 'connected');

    // 5. The server still holds the old registration for a while: retried, then back.
    reconnectMode = 'taken';
    const p2 = peers[1];
    p2.dropSignaling();
    await until(() => p2.reconnects >= 3, 2000);
    assert.equal(t.status(), 'reconnecting');
    reconnectMode = 'open';
    await until(() => t.status() === 'connected', 2000);
    assert.deepEqual(errors, []);

    // 6. Taken for longer than idRetryForMs: reported once, status offline, retrying stops...
    reconnectMode = 'taken';
    p2.dropSignaling();
    await until(() => errors.length === 1, 3000);
    assert.deepEqual(errors, ['room-taken']);
    assert.equal(t.status(), 'offline');
    const n = p2.reconnects;
    await wait(100);
    assert.equal(p2.reconnects, n, 'no more retries after giving up');
    // ...until the page wakes up again.
    reconnectMode = 'open';
    t.wake({});
    await until(() => t.status() === 'connected');
    assert.ok(statuses.includes('reconnecting') && statuses.includes('offline'));

    // 7. Closed: no reconnects afterwards.
    t.close();
    const count = peers.length;
    const r = peers.at(-1).reconnects;
    peers.at(-1).emit('disconnected');
    await wait(80);
    assert.equal(peers.length, count);
    assert.equal(peers.at(-1).reconnects, r);
  } finally {
    if (!hadRTC) delete globalThis.RTCPeerConnection;
  }
});

test('PeerTransport host: a long signaling outage keeps the Peer and the players\' data connections', async () => {
  const { EventEmitter } = require('node:events');
  const peers = [];
  let up = true;
  class FakePeer extends EventEmitter {
    constructor(id) { super(); this.id = id; this.open = false; this.disconnected = false; this.destroyed = false; peers.push(this); setTimeout(() => this.serve(), 2); }
    serve() {
      if (this.destroyed) return;
      if (up) { this.open = true; this.disconnected = false; this.emit('open', this.id); return; }
      // The server can't be reached: the socket closes at once (PeerJS: network error, then disconnect).
      this.emit('error', Object.assign(new Error('Lost connection to server.'), { type: 'network' }));
      this.open = false; this.disconnected = true; this.emit('disconnected', this.id);
    }
    reconnect() { this.disconnected = false; setTimeout(() => this.serve(), 2); }
    disconnect() { if (this.disconnected) return; this.open = false; this.disconnected = true; this.emit('disconnected', this.id); }
    destroy() { if (this.destroyed) return; this.destroyed = true; this.open = false; this.disconnected = true; this.emit('close'); }
  }
  const hadRTC = 'RTCPeerConnection' in globalThis;
  if (!hadRTC) globalThis.RTCPeerConnection = function () {};
  let t = null;
  try {
    t = Transport.PeerTransport({
      Peer: FakePeer, keepAliveMs: 1000, timeoutMs: 60000,
      signalingRetryMs: 10, signalingRetryMaxMs: 80, reopenTimeoutMs: 40,
    });
    const left = [];
    t.onPeerLeave((id) => left.push(id));
    await t.host('LONG');
    const conn = Object.assign(new EventEmitter(), {
      peer: 'px', open: true, sent: 0,
      send() { this.sent++; },
      close() { if (this.open) { this.open = false; this.emit('close'); } },
    });
    peers[0].on('close', () => conn.close()); // like PeerJS: destroy() closes its connections
    peers[0].emit('connection', conn);
    conn.emit('open');

    up = false;
    peers[0].open = false; peers[0].disconnected = true; peers[0].emit('disconnected', peers[0].id);
    await wait(600); // many reopen timeouts and backoff rounds
    assert.equal(t.status(), 'reconnecting');
    assert.equal(peers.length, 1, 'the Peer is not replaced');
    assert.deepEqual(left, [], 'the player is still connected');
    t.send('px', { hi: 1 });
    assert.equal(conn.sent, 1);

    up = true;
    await until(() => t.status() === 'connected');
    assert.equal(peers.length, 1);
  } finally {
    if (t) t.close();
    if (!hadRTC) delete globalThis.RTCPeerConnection;
  }
});
