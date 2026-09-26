/*
 * Room networking behind one small interface, so the game code doesn't care
 * how bytes move:
 *
 *   var t = Transport.create(kind, options)   kind: 'peer' | 'local'
 *   t.host(roomId)      -> Promise   become the room's host
 *   t.connect(roomId)   -> Promise   join a room as a player (the host is peer 'host')
 *   t.send(peerId, msg)              msg is a JSON-serialisable object
 *   t.onMessage(fn(peerId, msg)), t.onPeerJoin(fn(peerId)), t.onPeerLeave(fn(peerId)),
 *   t.onError(fn(err))               errors after the connection was set up
 *   t.close()
 *
 * Rejections and onError carry an Error with a `code`:
 *   'room-not-found'         nobody is hosting that room code
 *   'room-taken'             (host) the room code is already being hosted
 *   'signaling-unreachable'  the PeerJS signaling server can't be reached
 *   'timeout'                the connection couldn't be set up in time
 *   'webrtc-unsupported'     this browser can't do WebRTC data channels
 *   'transport'              anything else
 *
 * PeerTransport: WebRTC data channels via PeerJS (public/vendor/peerjs.min.js)
 * and its free public signaling server. The host's peer id is derived from the
 * room code (Room.peerIdFor), players get random ids.
 * LocalTransport: BroadcastChannel, for tabs of the same browser (dev/testing
 * mode, ?transport=local). Also works in Node 18+, which the tests use.
 *
 * Both send a small keep-alive every few seconds; a peer that is silent for
 * longer than `timeoutMs` counts as gone (WebRTC can take much longer than that
 * to notice a phone that locked its screen or lost Wi-Fi).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Transport = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var PEER_PREFIX = 'gts-room-'; // keep in sync with Room.peerIdFor
  var KA = '__gts_ka';

  var MESSAGES = {
    'room-not-found': 'That room wasn’t found. Check the code, or ask the host to open the room again.',
    'room-taken': 'That room code is already in use.',
    'signaling-unreachable': 'Couldn’t reach the PeerJS signaling server (0.peerjs.com). Check your internet connection and try again in a minute.',
    timeout: 'Connecting to the room timed out. The host may be offline, or this network may block WebRTC (common on corporate and school Wi-Fi).',
    'webrtc-unsupported': 'This browser can’t make peer-to-peer (WebRTC) connections.',
    transport: 'The connection failed.',
  };

  function transportError(code, message, cause) {
    var e = new Error(message || MESSAGES[code] || MESSAGES.transport);
    e.code = code;
    if (cause) e.cause = cause;
    return e;
  }

  function randomId() {
    return 'p' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
  }

  /** Event plumbing + keep-alive shared by both implementations. */
  function base(opts) {
    opts = opts || {};
    var handlers = { message: [], join: [], leave: [], error: [] };
    var lastSeen = {};
    var kaTimer = null;
    var interval = opts.keepAliveMs || 3000;
    var timeout = opts.timeoutMs || 12000;
    var self = {
      handlers: handlers,
      emit: function (kind) {
        var args = Array.prototype.slice.call(arguments, 1);
        handlers[kind].slice().forEach(function (fn) {
          try { fn.apply(null, args); } catch (e) { if (typeof console !== 'undefined') console.error(e); }
        });
      },
      seen: function (peerId) { lastSeen[peerId] = Date.now(); },
      forget: function (peerId) { delete lastSeen[peerId]; },
      /** Start keep-alives: sendKa(peerId) for every tracked peer; onTimeout(peerId) when silent. */
      startKeepAlive: function (sendKa, onTimeout) {
        clearInterval(kaTimer);
        var lastTick = Date.now();
        kaTimer = setInterval(function () {
          var t = Date.now();
          // This tab was frozen or too busy to run timers: messages that arrived
          // meanwhile may not have been handled yet, so the silence could be ours.
          // Don't time anyone out on this tick; the next one decides.
          var stalled = t - lastTick > Math.max(interval * 2, timeout / 2);
          lastTick = t;
          Object.keys(lastSeen).forEach(function (id) {
            if (!stalled && t - lastSeen[id] > timeout) { delete lastSeen[id]; onTimeout(id); return; }
            try { sendKa(id); } catch (e) { /* ignore */ }
          });
        }, interval);
        if (kaTimer && kaTimer.unref) kaTimer.unref();
      },
      stopKeepAlive: function () { clearInterval(kaTimer); kaTimer = null; lastSeen = {}; },
      api: {
        onMessage: function (fn) { handlers.message.push(fn); },
        onPeerJoin: function (fn) { handlers.join.push(fn); },
        onPeerLeave: function (fn) { handlers.leave.push(fn); },
        onError: function (fn) { handlers.error.push(fn); },
      },
    };
    return self;
  }

  // ---------- LocalTransport (BroadcastChannel) ----------

  /**
   * Envelopes on channel 'gts-local-<roomId>':
   *   {k:'probe'|'here'|'conn'|'acc'|'msg'|'bye'|'ka', from, to, d}
   * @param {object} [opts] { BroadcastChannel, probeMs, connectMs, keepAliveMs, timeoutMs }
   */
  function LocalTransport(opts) {
    opts = opts || {};
    var BC = opts.BroadcastChannel || (typeof BroadcastChannel !== 'undefined' ? BroadcastChannel : null);
    var b = base(opts);
    var id = randomId();
    var channel = null;
    var role = null; // 'host' | 'player'
    var peers = {}; // host: connected player ids
    var closed = false;

    function post(k, to, d) {
      if (!channel || closed) return;
      channel.postMessage(JSON.stringify({ k: k, from: id, to: to || null, d: d === undefined ? null : d }));
    }

    function open(roomId, onEnvelope) {
      if (!BC) throw transportError('webrtc-unsupported', 'This browser has no BroadcastChannel (needed for ?transport=local).');
      channel = new BC('gts-local-' + roomId);
      channel.onmessage = function (ev) {
        var env;
        try { env = typeof ev.data === 'string' ? JSON.parse(ev.data) : ev.data; } catch (e) { return; }
        if (!env || env.from === id || (env.to && env.to !== id)) return;
        onEnvelope(env);
      };
      if (channel.unref) channel.unref();
    }

    function dropPeer(pid) {
      if (!peers[pid]) return;
      delete peers[pid];
      b.forget(pid);
      b.emit('leave', pid);
    }

    var api = b.api;

    api.host = function (roomId) {
      role = 'host';
      return new Promise(function (resolve, reject) {
        var taken = false;
        try {
          // Is somebody already hosting this room? (Only answers are handled until the probe ends.)
          open(roomId, function (env) { if (env.k === 'here') taken = true; });
        } catch (e) { reject(e); return; }
        post('probe');
        setTimeout(function () {
          if (closed) { reject(transportError('transport', 'Closed.')); return; }
          if (taken) {
            channel.close();
            channel = null;
            reject(transportError('room-taken'));
            return;
          }
          channel.onmessage = function (ev) {
            var env;
            try { env = typeof ev.data === 'string' ? JSON.parse(ev.data) : ev.data; } catch (e) { return; }
            if (!env || env.from === id || (env.to && env.to !== id)) return;
            var pid = env.from;
            if (env.k === 'probe') { post('here', pid); return; }
            if (env.k === 'conn') {
              var isNew = !peers[pid];
              peers[pid] = true;
              b.seen(pid);
              post('acc', pid);
              if (isNew) b.emit('join', pid);
              return;
            }
            if (!peers[pid]) return;
            b.seen(pid);
            if (env.k === 'msg') b.emit('message', pid, env.d);
            else if (env.k === 'bye') dropPeer(pid);
          };
          b.startKeepAlive(function (pid) { post('ka', pid); }, dropPeer);
          resolve();
        }, opts.probeMs || 250);
      });
    };

    api.connect = function (roomId) {
      role = 'player';
      return new Promise(function (resolve, reject) {
        var accepted = false;
        var hostId = null;
        try {
          open(roomId, function (env) {
            if (env.k === 'acc' && !accepted) {
              accepted = true;
              hostId = env.from;
              b.seen('host');
              b.startKeepAlive(function () { post('ka', hostId); }, function () { hostId = null; b.emit('leave', 'host'); });
              resolve();
              return;
            }
            if (!accepted || env.from !== hostId) return;
            b.seen('host');
            if (env.k === 'msg') b.emit('message', 'host', env.d);
            else if (env.k === 'bye') { hostId = null; b.stopKeepAlive(); b.emit('leave', 'host'); }
          });
        } catch (e) { reject(e); return; }
        var tries = 0;
        (function knock() {
          if (accepted || closed) return;
          if (tries++ >= 3) { reject(transportError('room-not-found')); return; }
          post('conn');
          setTimeout(knock, opts.connectMs || 500);
        })();
      });
    };

    api.send = function (to, msg) {
      if (role === 'player') {
        post('msg', null, msg);
      } else {
        if (!peers[to]) return;
        post('msg', to, msg);
      }
    };

    api.close = function () {
      if (closed) return;
      post('bye');
      closed = true;
      b.stopKeepAlive();
      if (channel) { try { channel.close(); } catch (e) { /* ignore */ } }
      channel = null;
      peers = {};
    };

    api.kind = 'local';
    return api;
  }

  // ---------- PeerTransport (PeerJS / WebRTC) ----------

  function mapPeerError(err) {
    var type = err && err.type;
    if (type === 'peer-unavailable') return transportError('room-not-found', null, err);
    if (type === 'unavailable-id') return transportError('room-taken', null, err);
    if (type === 'browser-incompatible' || type === 'webrtc') return transportError('webrtc-unsupported', null, err);
    if (type === 'network' || type === 'server-error' || type === 'socket-error' || type === 'socket-closed' || type === 'ssl-unavailable') {
      return transportError('signaling-unreachable', null, err);
    }
    return transportError('transport', (err && err.message) || null, err);
  }

  /**
   * @param {object} [opts] { Peer (constructor, default window.Peer), peerOptions
   *   (host/port/path/key/config for your own PeerServer or TURN), connectTimeoutMs,
   *   keepAliveMs, timeoutMs }
   */
  function PeerTransport(opts) {
    opts = opts || {};
    var PeerCtor = opts.Peer || (typeof window !== 'undefined' ? window.Peer : null);
    var b = base(opts);
    var peer = null;
    var conns = {}; // peerId -> DataConnection
    var hostConn = null;
    var closed = false;
    var connectTimeout = opts.connectTimeoutMs || 15000;
    var peerOptions = Object.assign({ debug: 0 }, opts.peerOptions || {});

    function makePeer(id) {
      if (!PeerCtor) throw transportError('transport', 'The PeerJS library didn’t load (vendor/peerjs.min.js).');
      if (typeof RTCPeerConnection === 'undefined') throw transportError('webrtc-unsupported');
      return id ? new PeerCtor(id, peerOptions) : new PeerCtor(peerOptions);
    }

    // The signaling socket can drop (sleeping laptop, flaky Wi-Fi). Open data
    // connections keep working; reconnect so new players can still join.
    function keepSignaling(p) {
      p.on('disconnected', function () {
        if (closed || p.destroyed) return;
        setTimeout(function () { if (!closed && !p.destroyed && p.disconnected) { try { p.reconnect(); } catch (e) { /* retried on next drop */ } } }, 1500);
      });
    }

    function wire(conn, peerId, onLeave) {
      conn.on('data', function (d) {
        b.seen(peerId);
        if (d && d[KA]) return;
        b.emit('message', peerId, d);
      });
      var gone = false;
      function end() {
        if (gone) return;
        gone = true;
        onLeave(); // forgets the peer's keep-alive only if this is still its connection
      }
      conn.on('close', end);
      conn.on('error', end);
      if (conn.peerConnection) {
        // Faster than waiting for the data channel to time out.
        var pc = conn.peerConnection;
        var prev = pc.oniceconnectionstatechange;
        pc.oniceconnectionstatechange = function (ev) {
          if (prev) prev.call(pc, ev);
          if (pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'closed') end();
        };
      }
      return end;
    }

    var api = b.api;

    api.host = function (roomId) {
      return new Promise(function (resolve, reject) {
        var settled = false;
        try { peer = makePeer(PEER_PREFIX + roomId); } catch (e) { reject(e); return; }
        var timer = setTimeout(function () {
          if (settled) return;
          settled = true;
          reject(transportError('signaling-unreachable'));
          try { peer.destroy(); } catch (e) { /* ignore */ }
        }, connectTimeout);
        peer.on('open', function () {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          keepSignaling(peer);
          b.startKeepAlive(function (pid) {
            var c = conns[pid];
            if (c && c.open) { var m = {}; m[KA] = 1; c.send(m); }
          }, function (pid) {
            var c = conns[pid];
            if (c) { try { c.close(); } catch (e) { /* ignore */ } }
            if (conns[pid]) { delete conns[pid]; b.emit('leave', pid); }
          });
          resolve();
        });
        peer.on('error', function (err) {
          var e = mapPeerError(err);
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            try { peer.destroy(); } catch (x) { /* ignore */ }
            reject(e);
            return;
          }
          if (e.code === 'room-not-found') return; // a player that already left
          b.emit('error', e);
        });
        peer.on('connection', function (conn) {
          var pid = conn.peer;
          conn.on('open', function () {
            var old = conns[pid];
            conns[pid] = conn;
            b.seen(pid);
            if (old && old !== conn) { try { old.close(); } catch (e) { /* ignore */ } }
            wire(conn, pid, function () {
              if (conns[pid] !== conn) return;
              delete conns[pid];
              b.forget(pid);
              b.emit('leave', pid);
            });
            b.emit('join', pid);
          });
        });
      });
    };

    api.connect = function (roomId) {
      return new Promise(function (resolve, reject) {
        var settled = false;
        function failWith(e) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          try { peer.destroy(); } catch (x) { /* ignore */ }
          reject(e);
        }
        try { peer = makePeer(null); } catch (e) { reject(e); return; }
        var timer = setTimeout(function () { failWith(transportError(peer && peer.open ? 'timeout' : 'signaling-unreachable')); }, connectTimeout);
        peer.on('error', function (err) {
          var e = mapPeerError(err);
          if (!settled) { failWith(e); return; }
          b.emit('error', e);
        });
        peer.on('open', function () {
          if (settled) return;
          keepSignaling(peer);
          var conn = peer.connect(PEER_PREFIX + roomId, { reliable: true, serialization: 'json' });
          conn.on('open', function () {
            if (settled) { try { conn.close(); } catch (e) { /* ignore */ } return; }
            settled = true;
            clearTimeout(timer);
            hostConn = conn;
            b.seen('host');
            wire(conn, 'host', function () {
              if (hostConn !== conn) return;
              hostConn = null;
              b.stopKeepAlive();
              b.emit('leave', 'host');
            });
            b.startKeepAlive(function () {
              if (hostConn && hostConn.open) { var m = {}; m[KA] = 1; hostConn.send(m); }
            }, function () {
              var c = hostConn;
              hostConn = null;
              if (c) { try { c.close(); } catch (e) { /* ignore */ } }
              b.emit('leave', 'host');
            });
            resolve();
          });
        });
      });
    };

    api.send = function (to, msg) {
      var c = to === 'host' ? hostConn : conns[to];
      if (c && c.open) c.send(msg);
    };

    api.close = function () {
      if (closed) return;
      closed = true;
      b.stopKeepAlive();
      Object.keys(conns).forEach(function (k) { try { conns[k].close(); } catch (e) { /* ignore */ } });
      conns = {};
      if (hostConn) { try { hostConn.close(); } catch (e) { /* ignore */ } }
      hostConn = null;
      if (peer) { try { peer.destroy(); } catch (e) { /* ignore */ } }
    };

    api.kind = 'peer';
    return api;
  }

  /** 'local' when the page has ?transport=local, otherwise 'peer'. */
  function kindFromSearch(search) {
    var m = /[?&]transport=([^&#]*)/.exec(search || '');
    return m && /^local$/i.test(m[1]) ? 'local' : 'peer';
  }

  function create(kind, opts) {
    return kind === 'local' ? LocalTransport(opts) : PeerTransport(opts);
  }

  return {
    create: create,
    LocalTransport: LocalTransport,
    PeerTransport: PeerTransport,
    kindFromSearch: kindFromSearch,
    transportError: transportError,
    MESSAGES: MESSAGES,
    PEER_PREFIX: PEER_PREFIX,
  };
});
