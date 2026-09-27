'use strict';

// ICE configuration (STUN/TURN), ICE-failure detection and diagnostics of the
// PeerJS transport, with a fake PeerJS.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const Transport = require('../public/lib/transport.js');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const ICE = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: ['turn:staticauth.openrelay.metered.ca:80', 'turn:staticauth.openrelay.metered.ca:443?transport=tcp'], authSecret: 'openrelayprojectsecret' },
  { urls: ['turn:openrelay.metered.ca:80', 'turns:openrelay.metered.ca:443?transport=tcp'], username: 'openrelayproject', credential: 'openrelayproject' },
];

/** An RTCPeerConnection stand-in: ICE state changes are dispatched like the browser does. */
class FakePC extends EventTarget {
  constructor() { super(); this.iceConnectionState = 'new'; this.connectionState = 'new'; this.remoteDescription = null; this.oniceconnectionstatechange = null; }
  setIce(state) {
    this.iceConnectionState = state;
    if (this.oniceconnectionstatechange) this.oniceconnectionstatechange();
    this.dispatchEvent(new Event('iceconnectionstatechange'));
  }
  getStats() {
    return Promise.resolve(new Map([
      ['T1', { id: 'T1', type: 'transport', selectedCandidatePairId: 'CP1' }],
      ['CP1', { id: 'CP1', type: 'candidate-pair', localCandidateId: 'L1', remoteCandidateId: 'R1', state: 'succeeded', nominated: true, currentRoundTripTime: 0.042 }],
      ['L1', { id: 'L1', type: 'local-candidate', candidateType: 'relay', protocol: 'udp', relayProtocol: 'tcp' }],
      ['R1', { id: 'R1', type: 'remote-candidate', candidateType: 'srflx', protocol: 'udp' }],
    ]));
  }
}

class FakeConn extends EventEmitter {
  constructor(peer) { super(); this.peer = peer; this.open = false; this.peerConnection = new FakePC(); this.sent = []; }
  send(m) { this.sent.push(m); }
  close() { if (this.open) { this.open = false; this.emit('close'); } }
  opened() { this.open = true; this.emit('open'); }
}

function fakePeerJS() {
  const peers = [];
  class FakePeer extends EventEmitter {
    constructor(id, options) {
      super();
      if (typeof id === 'object') { options = id; id = null; }
      this.id = id || 'rand-' + peers.length;
      this.options = options;
      this.open = false;
      this.conns = [];
      peers.push(this);
      setTimeout(() => { this.open = true; this.emit('open', this.id); }, 1);
    }
    connect(to) { const c = new FakeConn(to); this.conns.push(c); return c; }
    destroy() { this.destroyed = true; this.open = false; }
    reconnect() {}
  }
  return { FakePeer, peers };
}

function withRTC(fn) {
  return async () => {
    const had = 'RTCPeerConnection' in globalThis;
    if (!had) globalThis.RTCPeerConnection = function () {};
    try { await fn(); } finally { if (!had) delete globalThis.RTCPeerConnection; }
  };
}

test('TURN REST API credentials: HMAC-SHA1 of "<expiry>:<user>" with the shared secret, passthrough otherwise', () => {
  const now = Date.UTC(2026, 8, 27, 12, 0, 0);
  const list = Transport.resolveIceServers(ICE, now);
  assert.deepEqual(list[0], { urls: 'stun:stun.l.google.com:19302' });
  const exp = Math.floor(now / 1000) + 86400;
  assert.equal(list[1].username, exp + ':gts');
  assert.equal(list[1].credential, crypto.createHmac('sha1', 'openrelayprojectsecret').update(exp + ':gts').digest('base64'));
  assert.deepEqual(list[1].urls, ICE[1].urls);
  assert.ok(!('authSecret' in list[1]), 'the secret itself is not handed to RTCPeerConnection');
  assert.deepEqual(list[2], { urls: ICE[2].urls, username: 'openrelayproject', credential: 'openrelayproject' });
  // TTL and user name can be set; long keys and non-ASCII are hashed like Node's HMAC.
  const custom = Transport.resolveIceServers([{ urls: 'turn:x', authSecret: 'k'.repeat(99) + 'é', authTtlSeconds: 60, authUser: 'me' }], now)[0];
  assert.equal(custom.username, (Math.floor(now / 1000) + 60) + ':me');
  assert.equal(custom.credential, crypto.createHmac('sha1', 'k'.repeat(99) + 'é').update(custom.username).digest('base64'));
  // Block boundaries of SHA-1 (55/56/64 bytes) and of the HMAC key (64/65 bytes).
  for (const kl of [0, 1, 63, 64, 65, 130]) {
    for (const ml of [0, 1, 55, 56, 63, 64, 65, 119, 120, 500]) {
      const k = 's'.repeat(kl); const m = 'm'.repeat(ml);
      assert.equal(Transport.hmacSha1Base64(k, m), crypto.createHmac('sha1', k).update(m).digest('base64'), `key ${kl}, msg ${ml}`);
    }
  }
  assert.equal(Transport.hasTurn(ICE), true);
  assert.equal(Transport.hasTurn([ICE[0]]), false);
  assert.equal(Transport.resolveIceServers(null), null);
});

test('PeerTransport passes the ICE servers (TURN included) and the policy to new Peer() for host and joiner', withRTC(async () => {
  const { FakePeer, peers } = fakePeerJS();
  const host = Transport.PeerTransport({ Peer: FakePeer, iceServers: ICE, debug: 2, keepAliveMs: 1000, timeoutMs: 5000 });
  await host.host('ABCD');
  const hp = peers[0];
  assert.equal(hp.id, 'gts-room-ABCD');
  assert.equal(hp.options.debug, 2);
  assert.equal(hp.options.config.iceTransportPolicy, 'all');
  const urls = hp.options.config.iceServers.flatMap((s) => [].concat(s.urls));
  assert.ok(urls.includes('turn:staticauth.openrelay.metered.ca:80'));
  assert.ok(urls.includes('turns:openrelay.metered.ca:443?transport=tcp'));
  assert.ok(hp.options.config.iceServers[1].credential, 'TURN credentials are filled in');
  assert.ok(hp.options.token, 'the host keeps its token');

  const joiner = Transport.PeerTransport({ Peer: FakePeer, iceServers: ICE, iceTransportPolicy: 'relay', iceCandidatePoolSize: 2, keepAliveMs: 1000, timeoutMs: 5000 });
  const joined = joiner.connect('ABCD');
  await wait(5);
  const jp = peers[1];
  assert.equal(jp.options.config.iceTransportPolicy, 'relay', 'relay only when asked');
  assert.equal(jp.options.config.iceCandidatePoolSize, 2);
  assert.equal(jp.options.config.iceServers.length, 3);
  jp.conns[0].opened();
  await joined;
  const d = joiner.diag();
  assert.equal(d.turn, true);
  assert.equal(d.policy, 'relay');
  assert.equal(d.hostPeerId, 'gts-room-ABCD');
  assert.deepEqual(d.conns[0], { peer: 'gts-room-ABCD', dataChannel: 'open', ice: 'new', pc: 'new' });
  assert.ok(!JSON.stringify(d).includes('openrelayproject"'), 'no credentials in the diagnostics');
  const pairs = await joiner.candidates();
  assert.deepEqual(pairs.host, { local: 'relay', remote: 'srflx', protocol: 'udp', relayProtocol: 'tcp', rttMs: 42 });
  // Without ICE servers in the options, PeerJS keeps its own defaults (no config passed).
  const plain = Transport.PeerTransport({ Peer: FakePeer });
  plain.host('PLAN').catch(() => {});
  assert.equal(peers.at(-1).options.config, undefined);
  host.close(); joiner.close(); plain.close();
}));

test('a join whose ICE fails is reported as ice-failed, not as a missing room or a timeout', withRTC(async () => {
  const { FakePeer, peers } = fakePeerJS();
  const connect = (opts = {}) => {
    const t = Transport.PeerTransport({ Peer: FakePeer, iceServers: ICE, connectTimeoutMs: 200, iceDisconnectGraceMs: 50, ...opts });
    const p = t.connect('ROOM');
    return { t, p, conn: () => peers.at(-1).conns[0] };
  };
  // 1. ICE state 'failed' (the RTCPeerConnection's own event).
  let j = connect();
  await wait(5);
  j.conn().peerConnection.setIce('checking');
  j.conn().peerConnection.setIce('failed');
  await assert.rejects(j.p, (e) => e.code === 'ice-failed' && /direct connection between the phones/.test(e.message));
  assert.equal(j.t.diag().lastError.code, 'ice-failed');
  assert.equal(j.t.diag().iceFailures, 1);
  assert.equal(j.t.diag().conns[0].ice, 'failed', 'the failed ICE state stays visible in the diagnostics');
  assert.equal(peers.at(-1).destroyed, true);
  // 2. PeerJS's own report of it ('negotiation-failed' on the connection).
  j = connect();
  await wait(5);
  j.conn().emit('error', Object.assign(new Error('Negotiation of connection to x failed.'), { type: 'negotiation-failed' }));
  await assert.rejects(j.p, (e) => e.code === 'ice-failed');
  // 3. 'disconnected' that doesn't recover within the grace period.
  j = connect();
  await wait(5);
  j.conn().peerConnection.setIce('disconnected');
  await assert.rejects(j.p, (e) => e.code === 'ice-failed');
  // ...but a short blip that recovers is fine.
  j = connect();
  await wait(5);
  j.conn().peerConnection.setIce('disconnected');
  j.conn().peerConnection.setIce('connected');
  await wait(80);
  j.conn().opened();
  await j.p;
  j.t.close();
  // 4. The timeout: the host answered (remote description set) -> ice-failed; it didn't -> timeout.
  j = connect();
  await wait(5);
  j.conn().peerConnection.remoteDescription = { type: 'answer' };
  j.conn().peerConnection.setIce('checking');
  await assert.rejects(j.p, (e) => e.code === 'ice-failed');
  j = connect();
  await assert.rejects(j.p, (e) => e.code === 'timeout');
  // 5. The room isn't registered: still room-not-found.
  j = connect();
  await wait(5);
  peers.at(-1).emit('error', Object.assign(new Error('Could not connect to peer'), { type: 'peer-unavailable' }));
  await assert.rejects(j.p, (e) => e.code === 'room-not-found');
}));

test('host: a phone whose ICE fails before its connection opens is reported (and counted in the diagnostics)', withRTC(async () => {
  const { FakePeer, peers } = fakePeerJS();
  const t = Transport.PeerTransport({ Peer: FakePeer, iceServers: ICE, keepAliveMs: 1000, timeoutMs: 5000 });
  const errors = [];
  t.onError((e) => errors.push(e.code));
  await t.host('HOST');
  const c = new FakeConn('phone1');
  peers[0].emit('connection', c);
  assert.equal(t.diag().conns[0].pending, true);
  c.peerConnection.setIce('failed');
  assert.deepEqual(errors, ['ice-failed']);
  assert.equal(t.diag().iceFailures, 1);
  // A phone that gets through is listed with its state.
  const ok = new FakeConn('phone2');
  peers[0].emit('connection', ok);
  ok.opened();
  ok.peerConnection.setIce('connected');
  assert.ok(t.diag().conns.some((x) => x.peer === 'phone2' && x.dataChannel === 'open' && x.ice === 'connected'));
  const pairs = await t.candidates();
  assert.equal(pairs.phone2.local, 'relay');
  t.close();
}));

test('LocalTransport diagnostics', async () => {
  const opts = { probeMs: 20, connectMs: 30, keepAliveMs: 50, timeoutMs: 300 };
  const h = Transport.create('local', opts);
  await h.host('DIAG');
  const p = Transport.create('local', opts);
  await p.connect('DIAG');
  await wait(20);
  assert.equal(h.diag().kind, 'local');
  assert.equal(h.diag().conns.length, 1);
  assert.equal(p.diag().hostPeerId, h.diag().peerId);
  assert.deepEqual(await p.candidates(), {});
  p.close();
  h.close();
});
