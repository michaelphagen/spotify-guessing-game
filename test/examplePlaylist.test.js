'use strict';

// The example playlist is bundled as a snapshot (public/data/example-playlist.json,
// made by `npm run snapshot`) and served from there instead of Spotify.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const TrackSource = require('../public/lib/track-source.js');
const SpotifyUrl = require('../public/lib/spotify-url.js');
const EmbedParser = require('../public/lib/embed-parser.js');

const PUBLIC = path.join(__dirname, '..', 'public');
const SNAPSHOT_FILE = path.join(PUBLIC, 'data', 'example-playlist.json');
const snapshot = JSON.parse(fs.readFileSync(SNAPSHOT_FILE, 'utf8'));

/** public/config.js, evaluated the way the browser does. */
function loadConfig() {
  const sandbox = { window: {} };
  vm.runInNewContext(fs.readFileSync(path.join(PUBLIC, 'config.js'), 'utf8'), sandbox);
  return sandbox.window.GTS_CONFIG;
}
const config = loadConfig();
const EXAMPLE_ID = SpotifyUrl.parseSpotifyInput(config.EXAMPLE_URL).id;
const EXAMPLE_SHARE_LINK = `https://open.spotify.com/playlist/${EXAMPLE_ID}?si=DtYZGlhfShuJc2XVHhs_lQ&utm_source=copy-link`;
const OTHER = 'https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M';

test('bundled example snapshot is well-formed', () => {
  const { source, tracks, snapshotAt } = snapshot;
  assert.equal(source.type, 'playlist');
  assert.ok(typeof source.name === 'string' && source.name.trim(), 'has a playlist name');
  assert.equal(source.url, `https://open.spotify.com/playlist/${EXAMPLE_ID}`, 'clean link, no ?si= or utm parameters');
  assert.ok(!Number.isNaN(Date.parse(snapshotAt)), 'snapshotAt is a date');

  assert.ok(Array.isArray(tracks) && tracks.length >= 4, 'at least 4 tracks (enough for multiple choice)');
  const ids = new Set();
  for (const t of tracks) {
    assert.deepEqual(Object.keys(t).sort(), ['artist', 'id', 'image', 'previewUrl', 'title'], 'only the fields the game uses');
    assert.match(t.id, /^[A-Za-z0-9]{22}$/);
    assert.ok(typeof t.title === 'string' && t.title.trim(), `${t.id} has a title`);
    assert.ok(typeof t.artist === 'string' && t.artist.trim(), `${t.id} has an artist`);
    assert.match(t.previewUrl, /^https:\/\/p\.scdn\.co\/mp3-preview\/[A-Za-z0-9]+$/, `${t.id} preview on Spotify's CDN, no query string`);
    if (t.image !== null) assert.match(t.image, /^https:\/\/[a-z0-9-]+\.(scdn\.co|spotifycdn\.com)\/image\/[A-Za-z0-9]+$/);
    assert.ok(!ids.has(t.id), `duplicate track ${t.id}`);
    ids.add(t.id);
  }
  // Every URL in the file points at Spotify (no proxies, no tokens in query strings).
  const urls = JSON.stringify(snapshot).match(/https?:\/\/[^"]+/g);
  for (const u of urls) {
    const url = new URL(u);
    assert.match(url.hostname, /(^|\.)(spotify\.com|scdn\.co|spotifycdn\.com)$/, u);
    assert.equal(url.search, '', u);
  }
});

test('config.js points the example at the bundled snapshot, with a relative path', () => {
  assert.equal(config.EXAMPLE_SNAPSHOT, 'data/example-playlist.json');
  assert.ok(fs.existsSync(path.join(PUBLIC, config.EXAMPLE_SNAPSHOT)));
});

/** A TrackSource whose fetch serves the snapshot file and records every request. */
function make(route, { cfg = {}, search = '' } = {}) {
  const calls = [];
  const src = TrackSource.create({
    config: { ...config, CORS_PROXIES: [{ name: 'p', url: 'https://proxy.example/{raw}', format: 'html' }], PROXY_TIMEOUT_MS: 200, ...cfg },
    fetch: async (url, init) => {
      calls.push(url);
      return route(url, init);
    },
    SpotifyUrl,
    EmbedParser,
    search,
    storage: null,
  });
  return { src, calls };
}
const serveSnapshot = (url) => {
  if (url === 'data/example-playlist.json') return Response.json(snapshot);
  throw new Error('unexpected request ' + url);
};

test('the example link is served from the bundled snapshot, in any mode, without Spotify or proxies', async () => {
  for (const cfg of [{ API_BASE: '' }, { API_BASE: 'none' }, { API_BASE: 'https://backend.example' }]) {
    const { src, calls } = make(serveSnapshot, { cfg });
    assert.equal(src.isExample(EXAMPLE_SHARE_LINK), true);
    assert.equal(src.isExample(`spotify:playlist:${EXAMPLE_ID}`), true);
    assert.equal(src.isExample(OTHER), false);
    assert.equal(src.isExample('not a link'), false);
    assert.equal(src.exampleUrl(), config.EXAMPLE_URL);

    const out = await src.loadTracks(EXAMPLE_SHARE_LINK);
    assert.equal(out.via, 'snapshot');
    assert.equal(out.source.name, snapshot.source.name);
    assert.equal(out.source.type, 'playlist');
    assert.equal(out.tracks.length, snapshot.tracks.length);
    assert.equal(out.skipped, 0);
    await src.loadTracks(config.EXAMPLE_URL);
    assert.deepEqual(calls, ['data/example-playlist.json'], 'one relative request, then cached');
  }
});

test('if the snapshot is missing or is of another playlist, the example loads live', async () => {
  const live = { source: { type: 'playlist', name: 'Live', image: null }, tracks: [{ id: 'a', title: 'A', artist: 'X', previewUrl: 'https://p.scdn.co/mp3-preview/a' }], skipped: 0 };
  const cases = [
    () => new Response('<h1>404</h1>', { status: 404, headers: { 'content-type': 'text/html' } }),
    () => Response.json({ ...snapshot, source: { ...snapshot.source, url: OTHER } }),
    () => Response.json({ ...snapshot, tracks: [{ id: 'x', title: '', previewUrl: 'nope' }] }),
    () => { throw new TypeError('Failed to fetch'); },
  ];
  for (const snap of cases) {
    const { src, calls } = make((url) => (url.startsWith('api/tracks') ? Response.json(live) : snap()));
    const out = await src.loadTracks(EXAMPLE_SHARE_LINK);
    assert.equal(out.via, 'server');
    assert.equal(out.source.name, 'Live');
    assert.deepEqual(calls.map((u) => u.split('?')[0]), ['data/example-playlist.json', 'api/tracks']);
    assert.equal(await src.loadExampleSnapshot(), null);
  }
});

test('other links never touch the snapshot', async () => {
  const { src, calls } = make((url) => {
    if (url.startsWith('api/tracks')) return Response.json({ source: { type: 'playlist', name: 'P' }, tracks: [], skipped: 0 });
    throw new Error('unexpected request ' + url);
  });
  await src.loadTracks(OTHER);
  assert.deepEqual(calls.map((u) => u.split('?')[0]), ['api/tracks']);
});

test('validateSnapshot keeps only well-formed, unique tracks and checks the playlist id', () => {
  const ref = { type: 'playlist', id: EXAMPLE_ID };
  const data = {
    source: { type: 'playlist', name: 'N', image: 'javascript:alert(1)', url: `https://open.spotify.com/playlist/${EXAMPLE_ID}?si=x` },
    tracks: [
      { id: 'a1', title: 'One', artist: 'X', previewUrl: 'https://p.scdn.co/mp3-preview/1', image: null },
      { id: 'a1', title: 'One again', artist: 'X', previewUrl: 'https://p.scdn.co/mp3-preview/1' },
      { id: 'a2', title: 'No preview', artist: 'X', previewUrl: null },
      { id: 'a3', title: 'Three', previewUrl: 'https://p.scdn.co/mp3-preview/3', image: 'https://i.scdn.co/image/3', extra: 'dropped' },
      null,
    ],
  };
  const v = TrackSource.validateSnapshot(data, ref, SpotifyUrl);
  assert.deepEqual(v.source, { type: 'playlist', name: 'N', image: null, url: `https://open.spotify.com/playlist/${EXAMPLE_ID}` });
  assert.deepEqual(v.tracks, [
    { id: 'a1', title: 'One', artist: 'X', previewUrl: 'https://p.scdn.co/mp3-preview/1', image: null },
    { id: 'a3', title: 'Three', artist: '', previewUrl: 'https://p.scdn.co/mp3-preview/3', image: 'https://i.scdn.co/image/3' },
  ]);
  assert.equal(TrackSource.validateSnapshot(data, { type: 'album', id: EXAMPLE_ID }, SpotifyUrl), null);
  assert.equal(TrackSource.validateSnapshot(null, ref, SpotifyUrl), null);
  assert.equal(TrackSource.validateSnapshot({ source: data.source, tracks: [] }, ref, SpotifyUrl), null);
});
