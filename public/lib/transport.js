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
 *   t.onStatus(fn(status)), t.status()   'connected' | 'reconnecting' | 'offline'
 *   t.wake({resumed})                the page is visible/online again (resumed: it was
 *                                    hidden or frozen); the host re-registers the room
 *                                    with the signaling server if needed
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
 * to notice a phone that locked its screen or lost Wi-Fi). While this page is
 * hidden nobody is timed out (its own timers may be frozen), and after it comes
 * back every peer gets a grace period (see base()).
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

  /**
   * Event plumbing, connection status and keep-alive shared by both implementations.
   *
   * Keep-alive and hidden pages: mobile browsers throttle or freeze the timers
   * of a background tab, so while this page is hidden (or right after its
   * timers stalled) its own clock says nothing about its peers. Nobody is timed
   * out while the page is hidden, and when it is visible again every peer's
   * "last seen" is reset and gets a grace period of 2x the timeout.
   */
  function base(opts) {
    opts = opts || {};
    var handlers = { message: [], join: [], leave: [], error: [], status: [] };
    var lastSeen = {};
    var kaTimer = null;
    var interval = opts.keepAliveMs || 3000;
    var timeout = opts.timeoutMs || 12000;
    var now = opts.now || function () { return Date.now(); };
    var isHidden = opts.isHidden || function () { return typeof document !== 'undefined' && !!document.hidden; };
    var graceUntil = 0;
    var wasHidden = false;
    var status = 'idle';
    var self = {
      handlers: handlers,
      now: now,
      emit: function (kind) {
        var args = Array.prototype.slice.call(arguments, 1);
        handlers[kind].slice().forEach(function (fn) {
          try { fn.apply(null, args); } catch (e) { if (typeof console !== 'undefined') console.error(e); }
        });
      },
      /** 'idle' | 'connected' | 'reconnecting' | 'offline' (signaling / channel status). */
      setStatus: function (s, err) {
        if (s === status) return;
        status = s;
        self.emit('status', s, err || null);
      },
      seen: function (peerId) { lastSeen[peerId] = now(); },
      forget: function (peerId) { delete lastSeen[peerId]; },
      /** This page was hidden or frozen: don't hold its own silence against anyone. */
      resume: function () {
        var t = now();
        Object.keys(lastSeen).forEach(function (id) { lastSeen[id] = t; });
        graceUntil = t + timeout * 2;
      },
      /** Start keep-alives: sendKa(peerId) for every tracked peer; onTimeout(peerId) when silent. */
      startKeepAlive: function (sendKa, onTimeout) {
        clearInterval(kaTimer);
        var lastTick = now();
        kaTimer = setInterval(function () {
          var t = now();
          // This tab was frozen or too busy to run timers: messages that arrived
          // meanwhile may not have been handled yet, so the silence could be ours.
          var stalled = t - lastTick > Math.max(interval * 2, timeout / 2);
          lastTick = t;
          var hidden = isHidden();
          if (hidden) wasHidden = true;
          else if (wasHidden || stalled) { wasHidden = false; self.resume(); }
          var mayDrop = !hidden && !stalled && t >= graceUntil;
          Object.keys(lastSeen).forEach(function (id) {
            if (mayDrop && t - lastSeen[id] > timeout) { delete lastSeen[id]; onTimeout(id); return; }
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
        onStatus: function (fn) { handlers.status.push(fn); },
        status: function () { return status; },
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
          b.setStatus('connected');
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
              b.setStatus('connected');
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

    /** The page is back (visible, online, ...). `info.resumed`: it was hidden or frozen. */
    api.wake = function (info) {
      if (info && info.resumed) b.resume();
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
   *   keepAliveMs, timeoutMs, isHidden, now,
   *   signalingRetryMs (first delay before reconnecting to the signaling server, 500),
   *   signalingRetryMaxMs (backoff cap, 15000), reopenTimeoutMs (how long a
   *   reconnect may take before it is aborted and retried, 10000), idRetryForMs (how
   *   long to keep retrying while the server still holds the room's id, 30000) }
   *
   * Host signaling supervisor: mobile browsers close the signaling WebSocket of
   * a background tab, and PeerJS then leaves the Peer `disconnected` (or
   * destroyed). Nobody can join until it is registered again, so the host
   * reconnects on its own: on 'disconnected' / 'close' / signaling errors (with
   * backoff) and at once on wake() (the page is visible or online again). A
   * disconnected Peer gets peer.reconnect() (a reconnect that doesn't open in
   * time is aborted and retried); a destroyed one is replaced by a new Peer with
   * the same id and token.
   * The server can still hold the old registration for a while ('unavailable-id'):
   * that is retried for `idRetryForMs` before an error is reported.
   * Status (onStatus): 'connected' | 'reconnecting' | 'offline' (gave up; wake() retries).
   */
  function PeerTransport(opts) {
    opts = opts || {};
    var PeerCtor = opts.Peer || (typeof window !== 'undefined' ? window.Peer : null);
    var b = base(opts);
    var now = b.now;
    var peer = null;
    var conns = {}; // peerId -> DataConnection
    var hostConn = null;
    var closed = false;
    var connectTimeout = opts.connectTimeoutMs || 15000;
    var peerOptions = Object.assign({ debug: 0 }, opts.peerOptions || {});
    var retryBase = opts.signalingRetryMs || 500;
    var retryMax = opts.signalingRetryMaxMs || 15000;
    var reopenTimeout = opts.reopenTimeoutMs || 10000;
    var idRetryFor = opts.idRetryForMs || 30000;
    // Host signaling supervisor state.
    var hostId = null;
    var started = false; // the room opened once: from now on, keep it registered
    var sigTimer = null;
    var sigDelay = 0;
    var openWait = null;
    var idTakenSince = 0;
    var gaveUp = false;

    // The host's Peers share one token: the signaling server lets a new Peer
    // with the same id AND token take over a registration it still holds
    // (otherwise it answers 'unavailable-id' until the old one times out).
    var hostToken = peerOptions.token || Math.random().toString(36).slice(2);

    function makePeer(id) {
      if (!PeerCtor) throw transportError('transport', 'The PeerJS library didn’t load (vendor/peerjs.min.js).');
      if (typeof RTCPeerConnection === 'undefined') throw transportError('webrtc-unsupported');
      return id ? new PeerCtor(id, Object.assign({}, peerOptions, { token: hostToken })) : new PeerCtor(peerOptions);
    }

    // A player's signaling socket can drop too; its data connection keeps working.
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

    // ---- Host: signaling supervisor ----

    function peerIsUp(p) { return !!(p && p.open && !p.disconnected && !p.destroyed); }

    function clearSigTimers() {
      clearTimeout(sigTimer);
      clearTimeout(openWait);
      sigTimer = null;
      openWait = null;
    }

    function sigConnected() {
      clearSigTimers();
      sigDelay = 0;
      idTakenSince = 0;
      gaveUp = false;
      b.setStatus('connected');
    }

    /** Try again after a backoff delay (unless a try is already scheduled). */
    function scheduleSignaling() {
      if (closed || !started || gaveUp) return;
      b.setStatus('reconnecting');
      if (sigTimer) return;
      sigDelay = sigDelay ? Math.min(sigDelay * 2, retryMax) : retryBase;
      sigTimer = setTimeout(function () { sigTimer = null; ensureSignaling(); }, sigDelay);
    }

    /** Get the room's id registered with the signaling server again. */
    function ensureSignaling() {
      if (closed || !started || gaveUp) return;
      if (peerIsUp(peer)) { sigConnected(); return; }
      if (!peer || peer.destroyed) { recreatePeer(); return; }
      b.setStatus('reconnecting');
      if (peer.disconnected) {
        try { peer.reconnect(); } catch (e) { recreatePeer(); return; }
      }
      awaitOpen();
    }

    /**
     * The reconnect (or new Peer) must open in time; otherwise abort it and try
     * again. The Peer itself is kept (unless it was destroyed): destroying it
     * would also close the players' data connections, which work fine without
     * the signaling server.
     */
    function awaitOpen() {
      clearTimeout(openWait);
      var p = peer;
      openWait = setTimeout(function () {
        openWait = null;
        if (closed || p !== peer || peerIsUp(p)) return;
        if (p.destroyed) peer = null; // the next try makes a new one with the same id
        else if (!p.disconnected) {
          // A hanging attempt: close its socket, so the next try can call reconnect().
          try { p.disconnect(); } catch (e) { peer = null; try { p.destroy(); } catch (x) { /* ignore */ } }
        }
        scheduleSignaling();
      }, reopenTimeout);
    }

    function recreatePeer() {
      var old = peer;
      peer = null;
      // The old Peer's data connections close with it; players reconnect on their own.
      if (old && !old.destroyed) { try { old.destroy(); } catch (e) { /* ignore */ } }
      var p;
      try { p = makePeer(hostId); } catch (e) { scheduleSignaling(); return; }
      peer = p;
      b.setStatus('reconnecting');
      attachHostPeer(p, null);
      awaitOpen();
    }

    function noteIdTaken() {
      if (!idTakenSince) idTakenSince = now();
      if (now() - idTakenSince >= idRetryFor) {
        // Someone else really holds the room's id (another tab or device hosting it?).
        gaveUp = true;
        clearSigTimers();
        idTakenSince = 0;
        b.setStatus('offline');
        b.emit('error', transportError('room-taken', 'Another tab or device is hosting this room code now.'));
        return;
      }
      scheduleSignaling();
    }

    function onHostConnection(conn) {
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
    }

    /**
     * Events of a host Peer (the first one, or a replacement). `first` settles
     * host()'s promise: {resolve, reject, timer, settled}.
     */
    function attachHostPeer(p, first) {
      p.on('open', function () {
        if (closed || p !== peer) return;
        if (first && !first.settled) {
          first.settled = true;
          clearTimeout(first.timer);
          started = true;
          b.startKeepAlive(function (pid) {
            var c = conns[pid];
            if (c && c.open) { var m = {}; m[KA] = 1; c.send(m); }
          }, function (pid) {
            var c = conns[pid];
            if (c) { try { c.close(); } catch (e) { /* ignore */ } }
            if (conns[pid]) { delete conns[pid]; b.emit('leave', pid); }
          });
          sigConnected();
          first.resolve();
          return;
        }
        sigConnected();
      });
      p.on('error', function (err) {
        if (closed || p !== peer) return;
        var e = mapPeerError(err);
        if (first && !first.settled) {
          first.settled = true;
          clearTimeout(first.timer);
          peer = null;
          try { p.destroy(); } catch (x) { /* ignore */ }
          first.reject(e);
          return;
        }
        if (e.code === 'room-not-found') return; // a player that already left
        if (e.code === 'room-taken') { noteIdTaken(); return; }
        if (e.code === 'signaling-unreachable') { scheduleSignaling(); return; }
        b.emit('error', e);
      });
      p.on('disconnected', function () { if (!closed && p === peer) scheduleSignaling(); });
      p.on('close', function () { if (!closed && p === peer) scheduleSignaling(); });
      p.on('connection', onHostConnection);
    }

    var api = b.api;

    api.host = function (roomId) {
      hostId = PEER_PREFIX + roomId;
      return new Promise(function (resolve, reject) {
        var first = { resolve: resolve, reject: reject, settled: false, timer: null };
        var p;
        try { p = makePeer(hostId); } catch (e) { reject(e); return; }
        peer = p;
        first.timer = setTimeout(function () {
          if (first.settled) return;
          first.settled = true;
          peer = null;
          reject(transportError('signaling-unreachable'));
          try { p.destroy(); } catch (e) { /* ignore */ }
        }, connectTimeout);
        attachHostPeer(p, first);
      });
    };

    /**
     * The page is back (visible, pageshow, focus, online). Host: make sure the
     * room is registered with the signaling server (retrying at once, and again
     * after an 'offline' give-up). `info.resumed`: the page was hidden or frozen,
     * so keep-alive clocks restart with a grace period.
     */
    api.wake = function (info) {
      if (info && info.resumed) b.resume();
      if (closed || !started) return;
      if (peerIsUp(peer)) { sigConnected(); return; }
      gaveUp = false;
      idTakenSince = 0;
      clearTimeout(sigTimer);
      sigTimer = null;
      sigDelay = 0;
      // A reconnect already under way (awaitOpen pending) is left to finish.
      if (openWait && peer && !peer.disconnected && !peer.destroyed) return;
      ensureSignaling();
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
            b.setStatus('connected');
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
      clearSigTimers();
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
