'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Api = require('../public/lib/spotify-api.js');

const json = (body, status = 200, headers = {}) =>
  new Response(body == null ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

function fakeAuth() {
  const a = { token: 'AT1', refreshes: 0 };
  a.getAccessToken = async (o) => {
    if (o && o.forceRefresh) { a.refreshes++; a.token = 'AT' + (a.refreshes + 1); }
    return a.token;
  };
  return a;
}

function make(handler) {
  const calls = [];
  const sleeps = [];
  const auth = fakeAuth();
  const api = Api.create({
    auth,
    fetch: async (url, init) => { calls.push({ url, init }); return handler(url, init, calls.length); },
    sleep: async (ms) => { sleeps.push(ms); },
  });
  return { api, calls, sleeps, auth };
}

function rawTrack(i, extra = {}) {
  const id = ('track' + String(i).padStart(4, '0') + 'abcdefghij').slice(0, 22);
  return {
    type: 'track', id, uri: 'spotify:track:' + id, name: 'Song ' + i, duration_ms: 180000 + i * 1000,
    artists: [{ name: 'Artist ' + i }, { name: 'Guest' }],
    album: { images: [{ url: 'https://i.scdn.co/image/640-' + i, width: 640 }, { url: 'https://i.scdn.co/image/300-' + i, width: 300 }, { url: 'https://i.scdn.co/image/64-' + i, width: 64 }] },
    preview_url: null,
    ...extra,
  };
}

/** A fake Web API playlist of `n` songs, served 50 per page through `next`. */
function playlistHandler(n, { extraItems = [] } = {}) {
  const items = [];
  for (let i = 0; i < n; i++) items.push({ added_at: 'x', is_local: false, item: rawTrack(i) });
  items.push(...extraItems);
  return (url) => {
    const u = new URL(url);
    if (u.pathname === '/v1/playlists/PL123456789012345678901') return json({ name: 'Big  list', images: [{ url: 'https://i.scdn.co/image/pl', width: 300 }] });
    if (u.pathname === '/v1/playlists/PL123456789012345678901/items') {
      const offset = Number(u.searchParams.get('offset'));
      const limit = Number(u.searchParams.get('limit'));
      const page = items.slice(offset, offset + limit);
      const next = offset + limit < items.length
        ? `https://api.spotify.com/v1/playlists/PL123456789012345678901/items?offset=${offset + limit}&limit=${limit}` : null;
      return json({ items: page, total: items.length, offset, limit, next });
    }
    return json({ error: { status: 404, message: 'nope' } }, 404);
  };
}

test('playlist: every page is loaded (150 songs, no 100 cap) and normalised', async () => {
  const { api, calls } = make(playlistHandler(150));
  const out = await api.loadTracks({ type: 'playlist', id: 'PL123456789012345678901' });
  assert.equal(out.tracks.length, 150);
  assert.equal(out.via, 'spotify');
  assert.deepEqual(out.source, { type: 'playlist', name: 'Big list', image: 'https://i.scdn.co/image/pl' });
  const first = new URL(calls[1].url);
  assert.equal(first.pathname, '/v1/playlists/PL123456789012345678901/items', 'the February 2026 /items endpoint');
  assert.equal(first.searchParams.get('limit'), '50');
  assert.equal(first.searchParams.get('market'), 'from_token');
  assert.equal(calls.length, 1 + 3, 'metadata + three pages of 50');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer AT1');
  const t = out.tracks[7];
  assert.deepEqual(t, {
    id: t.id, title: 'Song 7', artist: 'Artist 7, Guest', image: 'https://i.scdn.co/image/300-7',
    uri: 'spotify:track:' + t.id, durationMs: 187000, previewUrl: null,
  });
});

test('playlist: local files, podcasts, unplayable, removed and duplicate songs are skipped; old `track` field works', async () => {
  const extra = [
    { is_local: true, item: { type: 'track', id: null, uri: 'spotify:local:a:b:c:1', name: 'Local' } },
    { is_local: false, item: { type: 'episode', id: 'ep0000000000000000000a', name: 'Pod' } },
    { is_local: false, item: rawTrack(900, { is_playable: false }) },
    { is_local: false, item: null },
    { is_local: false, item: rawTrack(0) }, // duplicate of the first
    { is_local: false, track: rawTrack(901) }, // pre-2026 field name
  ];
  const { api } = make(playlistHandler(3, { extraItems: extra }));
  const out = await api.loadTracks({ type: 'playlist', id: 'PL123456789012345678901' });
  assert.deepEqual(out.tracks.map((t) => t.title), ['Song 0', 'Song 1', 'Song 2', 'Song 901']);
  assert.equal(out.skipped, 3, 'local file, episode and unplayable song (a null item is not counted)');
});

test('playlist the user does not own: 403 becomes playlist-not-owned (the game falls back to the embed page)', async () => {
  const { api } = make((url) => {
    if (/\/items/.test(url)) return json({ error: { status: 403, message: 'Forbidden' } }, 403);
    return json({ name: 'Theirs', images: [] });
  });
  await assert.rejects(api.loadTracks({ type: 'playlist', id: 'PL123456789012345678901' }),
    (e) => e.code === 'playlist-not-owned' && /own or collaborate/.test(e.message));
});

test('album: tracks paged through the album object, album cover on every song', async () => {
  const albumTracks = [];
  for (let i = 0; i < 60; i++) { const t = rawTrack(i); delete t.album; albumTracks.push(t); }
  const { api, calls } = make((url) => {
    const u = new URL(url);
    if (u.pathname === '/v1/albums/AL123456789012345678901') {
      return json({ name: 'An Album', images: [{ url: 'https://i.scdn.co/image/al', width: 640 }], tracks: { items: albumTracks.slice(0, 50), next: 'https://api.spotify.com/v1/albums/AL123456789012345678901/tracks?offset=50&limit=50' } });
    }
    if (u.pathname === '/v1/albums/AL123456789012345678901/tracks') return json({ items: albumTracks.slice(50), next: null });
    return json(null, 404);
  });
  const out = await api.loadTracks({ type: 'album', id: 'AL123456789012345678901' });
  assert.equal(out.tracks.length, 60);
  assert.equal(out.source.name, 'An Album');
  assert.ok(out.tracks.every((t) => t.image === 'https://i.scdn.co/image/al'));
  assert.equal(calls.length, 2);
});

test('track link: one song', async () => {
  const { api } = make(() => json(rawTrack(5)));
  const out = await api.loadTracks({ type: 'track', id: 'TR123456789012345678901' });
  assert.equal(out.tracks.length, 1);
  assert.equal(out.tracks[0].durationMs, 185000);
  assert.equal(out.source.type, 'track');
});

test('401: the token is refreshed and the request retried once', async () => {
  const { api, calls, auth } = make((url, init) =>
    init.headers.Authorization === 'Bearer AT1' ? json({ error: { status: 401, message: 'The access token expired' } }, 401) : json({ devices: [{ id: 'd1', name: 'Phone', type: 'Smartphone' }] }));
  const devices = await api.devices();
  assert.equal(devices.length, 1);
  assert.equal(auth.refreshes, 1);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].init.headers.Authorization, 'Bearer AT2');
});

test('401 twice: signed-out error (no endless loop)', async () => {
  const { api, calls } = make(() => json({ error: { status: 401, message: 'Invalid access token' } }, 401));
  await assert.rejects(api.devices(), (e) => e.code === 'signed-out');
  assert.equal(calls.length, 2);
});

test('player errors: 403 Premium required, 404 no active device', async () => {
  const premium = make(() => json({ error: { status: 403, message: 'Player command failed: Premium required', reason: 'PREMIUM_REQUIRED' } }, 403));
  await assert.rejects(premium.api.play('dev1', 'spotify:track:x', 0), (e) => e.code === 'premium' && /Premium/.test(e.message) && e.status === 403);
  const noDevice = make(() => json({ error: { status: 404, message: 'Player command failed: No active device found', reason: 'NO_ACTIVE_DEVICE' } }, 404));
  await assert.rejects(noDevice.api.play('dev1', 'spotify:track:x', 0), (e) => e.code === 'no-device' && /Open Spotify/.test(e.message));
  assert.equal(Api.classify(403, { error: { message: 'Premium required' } }, '/me/player/play'), 'premium');
  assert.equal(Api.classify(404, {}, '/me/player/pause'), 'no-device');
  assert.equal(Api.classify(404, {}, '/playlists/x'), 'not-found');
});

test('play / pause: device id in the query, uri and position in the body; 204 resolves', async () => {
  const { api, calls } = make(() => new Response(null, { status: 204 }));
  assert.equal(await api.play('dev 1', 'spotify:track:abc', 5000.4), null);
  assert.equal(await api.pause('dev 1'), null);
  const u = new URL(calls[0].url);
  assert.equal(calls[0].init.method, 'PUT');
  assert.equal(u.pathname, '/v1/me/player/play');
  assert.equal(u.searchParams.get('device_id'), 'dev 1');
  assert.deepEqual(JSON.parse(calls[0].init.body), { uris: ['spotify:track:abc'], position_ms: 5000 });
  assert.equal(new URL(calls[1].url).pathname, '/v1/me/player/pause');
});

test('429: waits for Retry-After, then retries; a very long wait gives up with a rate error', async () => {
  const short = make((url, init, n) => (n === 1 ? json({ error: { status: 429 } }, 429, { 'Retry-After': '2' }) : json({ devices: [] })));
  assert.deepEqual(await short.api.devices(), []);
  assert.deepEqual(short.sleeps, [2000]);
  assert.equal(short.calls.length, 2);

  const long = make(() => json({ error: { status: 429 } }, 429, { 'Retry-After': '3600' }));
  await assert.rejects(long.api.devices(), (e) => e.code === 'rate' && e.retryAfter === 3600);
  assert.deepEqual(long.sleeps, []);

  const always = make(() => json({ error: { status: 429 } }, 429, { 'Retry-After': '1' }));
  await assert.rejects(always.api.devices(), (e) => e.code === 'rate');
  assert.equal(always.calls.length, 3, 'two retries');
});

test('network failure and signed-out auth are mapped to friendly errors', async () => {
  const { api } = make(() => { throw new TypeError('Failed to fetch'); });
  await assert.rejects(api.devices(), (e) => e.code === 'network');
  const api2 = Api.create({ auth: { getAccessToken: async () => { throw new Error('Sign in with Spotify to play full songs.'); } }, fetch: async () => assert.fail() });
  await assert.rejects(api2.devices(), (e) => e.code === 'signed-out' && /Sign in/.test(e.message));
});

test('normalizeTrack / pickImage', () => {
  assert.equal(Api.normalizeTrack({ type: 'track', id: 'short', name: 'x' }), null, 'bad id');
  assert.equal(Api.normalizeTrack(rawTrack(1, { is_local: true })), null);
  assert.equal(Api.pickImage([{ url: 'https://a/1', width: 100 }, { url: 'https://a/2', width: 200 }]), 'https://a/2');
  assert.equal(Api.pickImage([{ url: 'http://insecure', width: 300 }]), null);
  assert.equal(Api.normalizeTrack(rawTrack(2), 'https://fallback').image, 'https://i.scdn.co/image/300-2');
});

test('the token only goes to api.spotify.com: a `next` link elsewhere is refused unsent', async () => {
  const { api, calls } = make((url) => {
    const u = new URL(url);
    if (u.pathname === '/v1/playlists/PL123456789012345678901') return json({ name: 'x' });
    if (u.pathname === '/v1/playlists/PL123456789012345678901/items') return json({ items: [], next: 'https://evil.example/v1/steal' });
    return json({ items: [], next: null });
  });
  await assert.rejects(api.loadTracks({ type: 'playlist', id: 'PL123456789012345678901' }), (e) => e.code === 'http');
  assert.ok(calls.every((c) => c.url.startsWith('https://api.spotify.com/v1/')), calls.map((c) => c.url).join(' '));
  await assert.rejects(api.request('GET', 'https://api.spotify.com.evil.example/v1/me'));
  assert.equal(calls.length, 2);
});

test('429 without Retry-After waits a second; a network error while refreshing the token is not a sign-out', async () => {
  const r = make((url, init, n) => (n === 1 ? json({ error: { status: 429 } }, 429) : json({ devices: [] })));
  assert.deepEqual(await r.api.devices(), []);
  assert.deepEqual(r.sleeps, [1000]);
  const offline = Api.create({
    auth: { getAccessToken: async () => { throw Object.assign(new Error('Couldn’t reach Spotify to sign in.'), { code: 'network' }); } },
    fetch: async () => assert.fail(),
  });
  await assert.rejects(offline.devices(), (e) => e.code === 'network');
});
