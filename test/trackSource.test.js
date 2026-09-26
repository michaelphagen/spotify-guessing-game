'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const TrackSource = require('../public/lib/track-source.js');
const SpotifyUrl = require('../public/lib/spotify-url.js');
const EmbedParser = require('../public/lib/embed-parser.js');

const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
const PLAYLIST = 'https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M?si=x';
const html = (body, status = 200) => new Response(body, { status, headers: { 'content-type': 'text/html' } });
const PAGES_404 = () => html('<!DOCTYPE html><title>Page not found · GitHub Pages</title>', 404);

const PROXIES = [
  { name: 'one', url: 'https://one.example/?u={url}', format: 'html' },
  { name: 'two', url: 'https://two.example/get?url={url}', format: 'allorigins-json' },
  { name: 'three', url: 'https://three.example/{raw}', format: 'html', headers: { 'X-Return-Format': 'html' } },
];

function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) };
}

function make(fetchImpl, { config = {}, search = '', storage = memoryStorage() } = {}) {
  const calls = [];
  const src = TrackSource.create({
    config: { CORS_PROXIES: PROXIES, PROXY_TIMEOUT_MS: 200, ...config },
    fetch: async (url, init) => { calls.push({ url, init }); return fetchImpl(url, init); },
    SpotifyUrl,
    EmbedParser,
    search,
    storage,
  });
  return { src, calls, storage };
}

test('resolveApiBase: query parameter, then config, then same origin', () => {
  const r = TrackSource.resolveApiBase;
  assert.equal(r('', ''), '');
  assert.equal(r(undefined, '?foo=1'), '');
  assert.equal(r('https://api.example.com', ''), 'https://api.example.com/');
  assert.equal(r('https://api.example.com/base/', ''), 'https://api.example.com/base/');
  assert.equal(r('', '?api=https%3A%2F%2Fx.onrender.com'), 'https://x.onrender.com/');
  assert.equal(r('https://api.example.com', '?a=1&api=none'), 'none');
  assert.equal(r('none', ''), 'none');
  assert.equal(r('', '?api=javascript:alert(1)'), '', 'non-http values are ignored');
});

test('uses the backend when it answers with JSON (server mode)', async () => {
  const body = { source: { type: 'playlist', name: 'P', image: null }, tracks: [{ id: 'a' }], skipped: 0 };
  const { src, calls } = make(async () => Response.json(body));
  const out = await src.loadTracks(PLAYLIST);
  assert.equal(out.via, 'server');
  assert.equal(out.tracks.length, 1);
  assert.equal(src.mode(), 'server');
  assert.match(calls[0].url, /^api\/tracks\?url=https%3A%2F%2Fopen\.spotify\.com/, 'relative path, works under a sub-path');
});

test('backend errors (JSON) are shown as-is, without falling back', async () => {
  const { src, calls } = make(async () => Response.json({ error: 'Spotify says no.' }, { status: 502 }));
  await assert.rejects(src.loadTracks(PLAYLIST), /Spotify says no\./);
  assert.equal(calls.length, 1);
});

test('static host (HTML 404 for api/) falls back to CORS proxies, and remembers it', async () => {
  const { src, calls, storage } = make(async (url) => {
    if (url.startsWith('api/')) return PAGES_404();
    if (url.startsWith('https://one.example/')) return html('rate limited', 429);
    if (url.startsWith('https://two.example/')) return Response.json({ contents: fixture('playlist-embed.html') });
    throw new Error('unexpected ' + url);
  });
  const out = await src.loadTracks(PLAYLIST);
  assert.equal(out.via, 'proxy');
  assert.equal(out.tracks.length, 7);
  assert.equal(out.skipped, 1);
  assert.equal(src.mode(), 'static');
  assert.deepEqual(calls.map((c) => c.url.split('?')[0]), ['api/tracks', 'https://one.example/', 'https://two.example/get']);
  assert.equal(calls[1].url, 'https://one.example/?u=' + encodeURIComponent('https://open.spotify.com/embed/playlist/37i9dQZF1DXcBWIGoYBM5M'));

  // Cached per session: no second request for the same playlist.
  calls.length = 0;
  await src.loadTracks('spotify:playlist:37i9dQZF1DXcBWIGoYBM5M');
  assert.equal(calls.length, 0);

  // A new page load in the same tab skips the backend probe and starts with the proxy that worked.
  const again = make(async (url) => {
    if (url.startsWith('https://two.example/')) return Response.json({ contents: fixture('album-embed.html') });
    throw new Error('unexpected ' + url);
  }, { storage });
  const album = await again.src.loadTracks('https://open.spotify.com/album/4aawyAB9vmqN3uQ7FjRGTy');
  assert.equal(album.tracks.length, 5);
  assert.deepEqual(again.calls.map((c) => c.url.split('?')[0]), ['https://two.example/get']);
});

test('raw URL template and custom headers are passed to the proxy', async () => {
  const { src, calls } = make(async (url) => {
    if (url.startsWith('https://three.example/')) return html(fixture('track-embed.html'));
    return html('nope', 500);
  }, { config: { API_BASE: 'none' } });
  const out = await src.loadTracks('https://open.spotify.com/track/70cHKK8bHAfJrOGVnfRG9J');
  assert.equal(out.tracks.length, 1);
  const last = calls[calls.length - 1];
  assert.equal(last.url, 'https://three.example/https://open.spotify.com/embed/track/70cHKK8bHAfJrOGVnfRG9J');
  assert.equal(last.init.headers['X-Return-Format'], 'html');
  assert.ok(!calls.some((c) => c.url.startsWith('api/')), 'API_BASE none skips the backend');
});

test('a proxy that hangs is abandoned after the timeout', async () => {
  const { src } = make(async (url, init) => {
    if (url.startsWith('https://one.example/')) {
      return new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
    }
    if (url.startsWith('https://two.example/')) return Response.json({ contents: fixture('playlist-embed.html') });
    return html('x', 500);
  }, { config: { API_BASE: 'none' } });
  const t0 = Date.now();
  const out = await src.loadTracks(PLAYLIST);
  assert.equal(out.tracks.length, 7);
  assert.ok(Date.now() - t0 < 2000);
});

test('Spotify "not found" through a proxy stops immediately with a clear message', async () => {
  const { src, calls } = make(async () => html(fixture('notfound-embed.html')), { config: { API_BASE: 'none' } });
  await assert.rejects(src.loadTracks('https://open.spotify.com/playlist/0000000000000000000000'), /not available/);
  assert.equal(calls.length, 1);
});

test('all proxies failing gives the rate-limit message; bad links fail before any request', async () => {
  const { src, calls } = make(async () => html('error code: 522', 522), { config: { API_BASE: 'none' } });
  await assert.rejects(src.loadTracks(PLAYLIST), (e) => {
    assert.match(e.message, /Couldn’t load that playlist\. Public proxies are rate limited; try again or run the server locally\./);
    assert.equal(e.attempts.length, 3);
    return true;
  });
  calls.length = 0;
  await assert.rejects(src.loadTracks('https://open.spotify.com/artist/0TnOYISbd1XYRBk9myaseg'), /not supported/);
  assert.equal(calls.length, 0);
});

test('an unreachable configured backend falls back to the proxies', async () => {
  const { src } = make(async (url) => {
    if (url.startsWith('https://backend.example/')) throw new TypeError('Failed to fetch');
    return Response.json({ contents: fixture('playlist-embed.html') });
  }, { search: '?api=https://backend.example' });
  const out = await src.loadTracks(PLAYLIST);
  assert.equal(out.via, 'proxy');
});

test('coverUrl: backend when present, otherwise Spotify oEmbed; never rejects', async () => {
  let s = make(async () => Response.json({ image: 'https://i.scdn.co/image/x' }));
  assert.equal(await s.src.coverUrl('70cHKK8bHAfJrOGVnfRG9J'), 'https://i.scdn.co/image/x');
  assert.match(s.calls[0].url, /^api\/cover\?id=/);

  s = make(async (url) => {
    if (url.startsWith('api/')) return PAGES_404();
    return Response.json({ thumbnail_url: 'https://image-cdn-fa.spotifycdn.com/image/abc' });
  });
  assert.equal(await s.src.coverUrl('70cHKK8bHAfJrOGVnfRG9J'), 'https://image-cdn-fa.spotifycdn.com/image/abc');
  assert.match(s.calls[1].url, /^https:\/\/open\.spotify\.com\/oembed\?url=/);

  s = make(async () => { throw new TypeError('offline'); }, { config: { API_BASE: 'none' } });
  assert.equal(await s.src.coverUrl('70cHKK8bHAfJrOGVnfRG9J'), null);
  assert.equal(await s.src.coverUrl('../etc'), null);
});

test('index.html only uses relative asset paths (works under /RepoName/)', () => {
  const page = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const refs = [...page.matchAll(/\b(?:src|href)="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(refs.includes('lib/embed-parser.js') && refs.includes('config.js'));
  for (const r of refs) assert.ok(!r.startsWith('/'), r);
  const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert.ok(!/fetch\(\s*['"]\//.test(js), 'no root-relative fetches in app.js');
});
