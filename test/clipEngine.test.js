'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const ClipEngine = require('../public/lib/clip-engine.js');
const SpotifyPlayer = require('../public/lib/spotify-player.js');

// ---------- A fake clock with timers ----------

function fakeClock() {
  const c = { t: 0, timers: [], seq: 0 };
  c.now = () => c.t;
  c.setTimeout = (fn, ms) => { const id = ++c.seq; c.timers.push({ id, at: c.t + Math.max(0, ms || 0), fn }); return id; };
  c.clearTimeout = (id) => { c.timers = c.timers.filter((x) => x.id !== id); };
  c.flush = () => new Promise((r) => setImmediate(r));
  /** Advance the clock to t + ms, running timers (and the promises they start) in order. */
  c.advance = async (ms) => {
    const end = c.t + ms;
    await c.flush();
    for (;;) {
      c.timers.sort((a, b) => a.at - b.at || a.id - b.id);
      const next = c.timers[0];
      if (!next || next.at > end) break;
      c.timers.shift();
      c.t = next.at;
      next.fn();
      await c.flush();
      await c.flush();
    }
    c.t = end;
    await c.flush();
  };
  c.sleep = (ms) => new Promise((r) => c.setTimeout(r, ms));
  return c;
}

/**
 * A fake Spotify device behind the controller interface. REST requests take
 * `latency` ms to answer; the audio starts `startDelay` ms after the play
 * command lands (buffering on the device). Records what happened.
 */
function fakeDevice(clock, { latency = 250, startDelay = 0, local = false } = {}) {
  const d = { log: [], playing: false, pos: 0, since: 0 };
  const position = () => (d.playing ? d.pos + Math.max(0, clock.t - d.since) : d.pos);
  d.position = position;
  d.controller = {
    play: async (uri, ms) => {
      const sent = clock.t;
      await clock.sleep(latency / 2);
      d.log.push({ type: 'play', uri, ms, at: clock.t });
      d.playing = true;
      d.pos = ms;
      d.since = clock.t + startDelay;
      await clock.sleep(latency / 2);
      return local ? { at: d.since, positionMs: ms, requestMs: clock.t - sent, local: true } : { at: clock.t, requestMs: clock.t - sent, local: false };
    },
    pause: async () => {
      d.log.push({ type: 'pause-sent', at: clock.t });
      await clock.sleep(latency / 2);
      d.pos = position();
      d.playing = false;
      d.log.push({ type: 'paused', at: clock.t, pos: d.pos });
      await clock.sleep(latency / 2);
    },
    position: async () => {
      await clock.sleep(latency / 2);
      const st = { positionMs: position(), paused: !d.playing, at: clock.t, uri: 'spotify:track:abc' };
      await clock.sleep(latency / 2);
      return st;
    },
    activate: () => d.log.push({ type: 'activate' }),
  };
  return d;
}

function engineWith(clock, device, extra = {}) {
  const events = [];
  const e = ClipEngine.createSpotifyEngine({ controller: device.controller, now: clock.now, timers: clock, ...extra });
  e.onState((s) => events.push('state:' + s));
  e.onEnded((info) => events.push({ ended: info }));
  e.onError((msg, err) => events.push({ error: msg, code: err && err.code }));
  const progress = [];
  e.onProgress((ms) => progress.push(ms));
  return { e, events, progress };
}

const TRACK = { id: 'abc', uri: 'spotify:track:abc', durationMs: 200000 };

// ---------- Random start for full songs ----------

test('randomFullStartMs: whole seconds in [0, duration - (clip + 5 s)], never past the end', () => {
  assert.equal(ClipEngine.randomFullStartMs(200000, 15000, () => 0), 0);
  assert.equal(ClipEngine.randomFullStartMs(200000, 15000, () => 0.999999), 180000, 'duration - 20 s for the default 5 + 10 s clip');
  assert.equal(ClipEngine.randomFullStartMs(200000, () => 0.999999), 180000, 'clip length defaults to 15 s');
  assert.equal(ClipEngine.randomFullStartMs(200000, 30000, () => 0.999999), 165000, 'a longer clip leaves more room at the end');
  assert.equal(ClipEngine.randomFullStartMs(200500, 15000, () => 0.999999), 180000);
  assert.equal(ClipEngine.randomFullStartMs(19000, 15000, () => 0.7), 0, 'too short for any random start');
  assert.equal(ClipEngine.randomFullStartMs(NaN, 15000, () => 0.7), 0, 'unknown duration');
  for (let i = 0; i < 500; i++) {
    const d = 20000 + Math.floor(Math.random() * 600000);
    const s = ClipEngine.randomFullStartMs(d, 15000);
    assert.equal(s % 1000, 0, 'whole seconds');
    assert.ok(s >= 0 && s + 15000 <= d && s <= d - 20000 + 999, `start ${s} fits ${d}`);
  }
});

// ---------- Spotify engine: segment timing ----------

test('remote device: plays from position 0 and pauses ~5 s later (pause scheduled from the play response)', async () => {
  const clock = fakeClock();
  const dev = fakeDevice(clock, { latency: 300 });
  const { e, events, progress } = engineWith(clock, dev);
  e.load(TRACK);
  e.playSegment(0, 5000);
  assert.equal(e.playing, true, 'playing (loading) at once, so a second tap stops it');
  await clock.advance(10000);
  const play = dev.log.find((x) => x.type === 'play');
  const paused = dev.log.find((x) => x.type === 'paused');
  assert.equal(play.ms, 0);
  assert.equal(play.uri, 'spotify:track:abc');
  // The device heard 5 s give or take the latency compensation (half the play round trip).
  assert.ok(Math.abs(paused.pos - 5000) <= 100, 'device position at pause: ' + paused.pos);
  assert.deepEqual(events.filter((x) => typeof x === 'string'), ['state:loading', 'state:playing', 'state:stopped']);
  const ended = events.find((x) => x.ended).ended;
  assert.equal(ended.requestedMs, 5000);
  assert.equal(ended.measured, true);
  assert.equal(ended.actualMs, paused.pos, 'the real position is read back after pausing');
  assert.equal(progress[progress.length - 1], paused.pos, 'and shown');
  assert.equal(e.playing, false);
});

test('remote device that starts late: the position check re-plans the pause', async () => {
  const clock = fakeClock();
  const dev = fakeDevice(clock, { latency: 200, startDelay: 400 });
  const { e } = engineWith(clock, dev);
  e.load(TRACK);
  e.playSegment(5000, 15000); // "play next 10 seconds"
  await clock.advance(20000);
  const play = dev.log.find((x) => x.type === 'play');
  const paused = dev.log.find((x) => x.type === 'paused');
  assert.equal(play.ms, 5000, 'resumes at 5 s');
  assert.ok(Math.abs(paused.pos - 15000) <= 120, 'paused at ~15 s despite the 400 ms start delay: ' + paused.pos);
  const noResync = fakeClock();
  const dev2 = fakeDevice(noResync, { latency: 200, startDelay: 400 });
  const r2 = engineWith(noResync, dev2, { resyncAfterMs: 0 });
  r2.e.load(TRACK);
  r2.e.playSegment(5000, 15000);
  await noResync.advance(20000);
  const p2 = dev2.log.find((x) => x.type === 'paused');
  assert.ok(p2.pos < paused.pos - 250, 'without the check the clip would be cut short: ' + p2.pos);
});

test('in-browser (SDK) device: local position polling stops within ~0.1 s', async () => {
  const clock = fakeClock();
  const dev = fakeDevice(clock, { latency: 20, local: true, startDelay: 150 });
  const { e, events } = engineWith(clock, dev);
  e.load(TRACK);
  e.playSegment(0, 5000);
  await clock.advance(8000);
  const paused = dev.log.find((x) => x.type === 'paused');
  assert.ok(Math.abs(paused.pos - 5000) <= 60, 'local pause at ' + paused.pos);
  assert.ok(events.includes('state:stopped'));
});

test('clip start offset: offsetFn gets the duration and shifts the segment (random spot)', async () => {
  const clock = fakeClock();
  const dev = fakeDevice(clock, { latency: 100 });
  const { e } = engineWith(clock, dev);
  e.load(TRACK);
  const seen = [];
  e.playSegment(5000, 15000, (dur) => { seen.push(dur); return 42000; });
  await clock.advance(20000);
  assert.deepEqual(seen, [200000]);
  assert.equal(dev.log.find((x) => x.type === 'play').ms, 47000);
  assert.equal(e.segStartMs, 47000);
  assert.equal(e.segEndMs, 57000);
});

test('unknown duration: the song is looked up first (resolveTrack), then placed', async () => {
  const clock = fakeClock();
  const dev = fakeDevice(clock, { latency: 100 });
  const looked = [];
  const { e } = engineWith(clock, dev, {
    resolveTrack: async (t) => { looked.push(t.id); return { id: t.id, uri: 'spotify:track:' + t.id, durationMs: 30000 }; },
  });
  const track = { id: 'zzz' };
  e.load(track);
  e.playSegment(0, 5000, (dur) => ClipEngine.randomFullStartMs(dur, 15000, () => 0.99));
  await clock.advance(10000);
  assert.deepEqual(looked, ['zzz']);
  assert.equal(track.durationMs, 30000, 'remembered on the track');
  assert.equal(dev.log.find((x) => x.type === 'play').ms, 10000, '30 s song: the start is at most 10 s');
});

test('stop while the play request is on its way: no sound is left playing', async () => {
  const clock = fakeClock();
  const dev = fakeDevice(clock, { latency: 400 });
  const { e, events } = engineWith(clock, dev);
  e.load(TRACK);
  e.playSegment(0, 5000);
  await clock.advance(100);
  e.stop();
  assert.equal(e.playing, false);
  await clock.advance(3000);
  assert.ok(dev.log.some((x) => x.type === 'paused'), 'paused again once the play landed');
  assert.deepEqual(events.filter((x) => typeof x === 'string'), ['state:loading', 'state:stopped']);
  assert.equal(dev.playing, false);
});

test('stop while playing: pauses and reports the position; a second play starts over', async () => {
  const clock = fakeClock();
  const dev = fakeDevice(clock, { latency: 200 });
  const { e, progress } = engineWith(clock, dev);
  e.load(TRACK);
  e.playSegment(0, 5000);
  await clock.advance(2200);
  e.stop();
  assert.ok(progress[progress.length - 1] > 1800 && progress[progress.length - 1] < 2300);
  await clock.advance(1000);
  assert.equal(dev.playing, false);
  e.playSegment(0, 5000);
  await clock.advance(8000);
  assert.equal(dev.log.filter((x) => x.type === 'play').length, 2);
});

test('errors from Spotify are reported with their code, and the engine is stopped', async () => {
  const clock = fakeClock();
  const controller = {
    play: async () => { throw Object.assign(new Error('Full-song playback needs Spotify Premium.'), { code: 'premium' }); },
    pause: async () => {}, position: async () => null,
  };
  const { e, events } = engineWith(clock, { controller });
  e.load(TRACK);
  e.playSegment(0, 5000);
  await clock.advance(100);
  assert.equal(e.playing, false);
  assert.deepEqual(events, ['state:loading', 'state:stopped', { error: 'Full-song playback needs Spotify Premium.', code: 'premium' }]);
});

test('segment is clamped to the end of the song', async () => {
  const clock = fakeClock();
  const dev = fakeDevice(clock, { latency: 100 });
  const { e } = engineWith(clock, dev);
  e.load({ id: 'abc', uri: 'spotify:track:abc', durationMs: 12000 });
  e.playSegment(5000, 15000);
  await clock.advance(20000);
  assert.equal(e.segEndMs, 12000);
});

// ---------- One player, two engines ----------

test('createSwitch: forwards calls to the active engine and only its events', () => {
  function stub(kind) {
    const handlers = {};
    const s = { kind, playing: false, segStartMs: 0, segEndMs: 0, calls: [] };
    ['Progress', 'State', 'Ended', 'Error'].forEach((n) => { s['on' + n] = (fn) => { handlers[n] = fn; }; });
    s.emit = (n, ...a) => handlers[n](...a);
    ['load', 'unload', 'prime', 'playSegment', 'positionMs', 'durationMs'].forEach((m) => { s[m] = (...a) => { s.calls.push([m, ...a]); return 7; }; });
    s.stop = () => s.calls.push(['stop']);
    return s;
  }
  const a = stub('preview');
  const b = stub('spotify');
  const sw = ClipEngine.createSwitch(a);
  const got = [];
  sw.onState((s) => got.push(s));
  sw.playSegment(0, 5000);
  assert.deepEqual(a.calls, [['playSegment', 0, 5000]]);
  assert.equal(sw.kind, 'preview');
  sw.use(b);
  assert.deepEqual(a.calls[1], ['stop'], 'the old engine is stopped');
  assert.equal(sw.kind, 'spotify');
  b.playing = true;
  assert.equal(sw.playing, true);
  a.emit('State', 'playing');
  b.emit('State', 'loading');
  assert.deepEqual(got, ['loading']);
  assert.equal(sw.durationMs(), 7);
});

// ---------- Preview engine with a fake <audio> ----------

test('preview engine: plays the segment and stops at its end (ms interface)', async () => {
  const listeners = {};
  const audio = {
    currentTime: 0, duration: 30, readyState: 4, paused: true, muted: false, attrs: {},
    addEventListener: (n, fn) => { (listeners[n] = listeners[n] || []).push(fn); },
    removeEventListener: () => {},
    getAttribute: (k) => audio.attrs[k] || null,
    removeAttribute: (k) => { delete audio.attrs[k]; },
    set src(v) { audio.attrs.src = v; },
    load: () => {},
    play: () => { audio.paused = false; return Promise.resolve(); },
    pause: () => { audio.paused = true; },
  };
  const frames = [];
  const e = ClipEngine.createPreviewEngine({ createAudio: () => audio, raf: (f) => { frames.push(f); return frames.length; }, caf: () => {} });
  const states = [];
  const ended = [];
  e.onState((s) => states.push(s));
  e.onEnded((i) => ended.push(i));
  e.load({ previewUrl: 'https://p.scdn.co/mp3-preview/x' });
  e.playSegment(5000, 15000, (dur) => { assert.equal(dur, 30000); return 3000; });
  assert.equal(audio.currentTime, 8, 'offset applied: 5 s + 3 s');
  assert.equal(e.segEndMs, 18000);
  audio.currentTime = 18.01;
  frames.shift()();
  assert.equal(e.playing, false);
  assert.equal(audio.paused, true);
  assert.deepEqual(states, ['loading', 'stopped']);
  assert.equal(ended.length, 1);
  assert.equal(e.kind, 'preview');
});

// ---------- Spotify player controller (devices, SDK device, errors) ----------

test('controller: device list puts this browser first and keeps it selected across visits', async () => {
  const storage = new Map();
  const store = { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v), removeItem: (k) => storage.delete(k) };
  const listeners = {};
  const sdkPlayer = {
    addListener: (n, fn) => { listeners[n] = fn; },
    connect: async () => { setImmediate(() => listeners.ready({ device_id: 'sdk-2' })); return true; },
    getCurrentState: async () => null, pause: async () => {}, activateElement: () => {}, disconnect: () => {},
  };
  const api = {
    devices: async () => [{ id: 'phone', name: 'Pixel', type: 'Smartphone', is_active: true }, { id: 'sdk-2', name: 'Guess the Song', type: 'Computer' }],
  };
  store.setItem(SpotifyPlayer.KEY_DEVICE, JSON.stringify({ id: 'sdk-1', name: 'Guess the Song', local: true }));
  const ctl = SpotifyPlayer.create({
    api, auth: { getAccessToken: async () => 'AT' }, storage: store,
    loadSdk: async () => ({ Player: function () { return sdkPlayer; } }),
  });
  assert.equal(await ctl.connectSdk(), 'sdk-2');
  const list = await ctl.listDevices();
  assert.deepEqual(list.map((d) => [d.id, d.local, d.label]), [
    ['sdk-2', true, 'Guess the Song (this browser)'],
    ['phone', false, 'Pixel · smartphone (active)'],
  ]);
  assert.equal(ctl.deviceId(), 'sdk-2', 'the saved "this browser" choice follows the new device id');
  assert.equal(ctl.isLocal(), true);
  ctl.selectDevice(list[1]);
  assert.equal(ctl.deviceId(), 'phone');
  assert.equal(JSON.parse(storage.get(SpotifyPlayer.KEY_DEVICE)).id, 'phone', 'remembered');
});

test('controller: SDK that cannot start (e.g. iOS Safari) fails gracefully; play without a device is a no-device error', async () => {
  const listeners = {};
  const ctl = SpotifyPlayer.create({
    api: { devices: async () => [] },
    auth: { getAccessToken: async () => 'AT' },
    loadSdk: async () => ({
      Player: function () {
        return {
          addListener: (n, fn) => { listeners[n] = fn; },
          connect: async () => { setImmediate(() => listeners.initialization_error({ message: 'Failed to initialize player' })); return true; },
        };
      },
    }),
  });
  assert.equal(await ctl.connectSdk(), null);
  assert.equal(ctl.sdkInfo().status, 'failed');
  assert.match(ctl.sdkInfo().error, /phone’s Spotify app/);
  await assert.rejects(ctl.play('spotify:track:x', 0), (e) => e.code === 'no-device');
  const failingLoad = SpotifyPlayer.create({ api: {}, auth: {}, loadSdk: async () => { throw new Error('blocked'); } });
  assert.equal(await failingLoad.connectSdk(), null);
  assert.equal(failingLoad.sdkInfo().status, 'failed');
});

test('controller: REST play/pause go to the chosen device; the position comes from GET /me/player', async () => {
  const calls = [];
  const api = {
    play: async (id, uri, ms) => { calls.push(['play', id, uri, ms]); return null; },
    pause: async (id) => { calls.push(['pause', id]); return null; },
    playerState: async () => ({ progress_ms: 5123, is_playing: false, item: { uri: 'spotify:track:x' } }),
  };
  const ctl = SpotifyPlayer.create({ api, auth: {} });
  ctl.selectDevice({ id: 'phone', name: 'Pixel' });
  const info = await ctl.play('spotify:track:x', 0);
  assert.equal(info.local, false);
  await ctl.pause();
  const st = await ctl.position();
  assert.deepEqual(calls, [['play', 'phone', 'spotify:track:x', 0], ['pause', 'phone']]);
  assert.equal(st.positionMs, 5123);
  assert.equal(st.paused, true);
});

test('stop, then play again before the first play request answered: the new clip is not paused by the old one', async () => {
  const clock = fakeClock();
  const dev = fakeDevice(clock, { latency: 400 });
  const { e } = engineWith(clock, dev);
  e.load(TRACK);
  e.playSegment(0, 5000);
  await clock.advance(100);
  e.stop();
  await clock.advance(100);
  e.playSegment(0, 5000);
  await clock.advance(2000);
  assert.equal(dev.playing, true, dev.log.map((x) => x.type + '@' + x.at).join(' '));
  await clock.advance(4000);
  assert.equal(dev.playing, false, 'the second clip still ends');
});

test('stop while playing, then play at once: the play command waits for the pause to land', async () => {
  const clock = fakeClock();
  const dev = fakeDevice(clock, { latency: 400 });
  const { e } = engineWith(clock, dev);
  e.load(TRACK);
  e.playSegment(0, 5000);
  await clock.advance(2000);
  e.stop();
  e.playSegment(5000, 15000);
  await clock.advance(2000);
  const paused = dev.log.find((x) => x.type === 'paused');
  const plays = dev.log.filter((x) => x.type === 'play');
  assert.equal(plays.length, 2);
  assert.ok(plays[1].at > paused.at, dev.log.map((x) => x.type + '@' + x.at).join(' '));
  assert.equal(dev.playing, true);
});

test('switching the device mid-clip pauses the device that was playing, not the new one', async () => {
  const calls = [];
  const api = {
    play: async (id, uri, ms) => { calls.push(['play', id, ms]); return null; },
    pause: async (id) => { calls.push(['pause', id]); return null; },
    playerState: async () => null,
  };
  const ctl = SpotifyPlayer.create({ api, auth: {} });
  ctl.selectDevice({ id: 'kitchen', name: 'Kitchen' });
  const clock = fakeClock();
  const e = ClipEngine.createSpotifyEngine({ controller: ctl, now: clock.now, timers: clock });
  e.load(TRACK);
  e.playSegment(0, 5000);
  await clock.advance(1000);
  assert.equal(e.playing, true);
  // What the app does when another device is picked under "Plays on".
  e.stop();
  ctl.selectDevice({ id: 'phone', name: 'Pixel' });
  await clock.advance(100);
  assert.deepEqual(calls, [['play', 'kitchen', 0], ['pause', 'kitchen']]);
});
