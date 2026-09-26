'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createApp } = require('../server/app');

const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');

/** Stub for Spotify: serves fixtures for known ids, 404 for others. */
function fakeSpotify(calls) {
  return async (url) => {
    calls.push(url);
    if (url.includes('/embed/playlist/37i9dQZF1DXcBWIGoYBM5M')) return new Response(fixture('playlist-embed.html'));
    if (url.includes('/embed/album/4aawyAB9vmqN3uQ7FjRGTy')) return new Response(fixture('album-embed.html'));
    if (url.includes('/embed/track/70cHKK8bHAfJrOGVnfRG9J')) return new Response(fixture('track-embed.html'));
    if (url.includes('/embed/playlist/0000000000000000000000')) return new Response(fixture('notfound-embed.html'));
    if (url.includes('/embed/playlist/1111111111111111111111')) return new Response('bad gateway', { status: 502 });
    if (url.includes('/oembed')) return Response.json({ thumbnail_url: 'https://image-cdn-fa.spotifycdn.com/image/abc' });
    return new Response('not found', { status: 404 });
  };
}

async function withServer(fn) {
  const calls = [];
  const server = createApp({ fetchImpl: fakeSpotify(calls) }).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base, calls);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

test('GET /api/tracks returns source + tracks for a playlist URL (and caches)', () =>
  withServer(async (base, calls) => {
    const url = 'https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M?si=abc';
    const res = await fetch(`${base}/api/tracks?url=${encodeURIComponent(url)}`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(Object.keys(body.source).sort(), ['image', 'name', 'type']);
    assert.equal(body.source.type, 'playlist');
    assert.equal(body.tracks.length, 7);
    assert.deepEqual(Object.keys(body.tracks[0]).sort(), ['artist', 'id', 'image', 'previewUrl', 'title']);

    assert.equal(res.headers.get('cache-control'), 'no-store');

    const again = await fetch(`${base}/api/tracks?url=${encodeURIComponent('spotify:playlist:37i9dQZF1DXcBWIGoYBM5M')}`);
    assert.equal(calls.length, 1, 'second request served from cache');
    assert.equal(again.headers.get('cache-control'), 'no-store');
  }));

test('GET /api/tracks handles album and track URLs', () =>
  withServer(async (base) => {
    let body = await (await fetch(`${base}/api/tracks?url=${encodeURIComponent('https://open.spotify.com/album/4aawyAB9vmqN3uQ7FjRGTy')}`)).json();
    assert.equal(body.source.type, 'album');
    assert.equal(body.tracks.length, 5);
    body = await (await fetch(`${base}/api/tracks?url=${encodeURIComponent('https://open.spotify.com/track/70cHKK8bHAfJrOGVnfRG9J')}`)).json();
    assert.equal(body.source.type, 'track');
    assert.equal(body.tracks.length, 1);
  }));

test('GET /api/tracks error statuses', () =>
  withServer(async (base) => {
    let res = await fetch(`${base}/api/tracks`);
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /Spotify/);

    res = await fetch(`${base}/api/tracks?url=${encodeURIComponent('https://open.spotify.com/artist/0TnOYISbd1XYRBk9myaseg')}`);
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /not supported/);

    res = await fetch(`${base}/api/tracks?url=${encodeURIComponent('https://open.spotify.com/playlist/0000000000000000000000')}`);
    assert.equal(res.status, 404);

    res = await fetch(`${base}/api/tracks?url=${encodeURIComponent('https://open.spotify.com/playlist/2222222222222222222222')}`);
    assert.equal(res.status, 404);

    res = await fetch(`${base}/api/tracks?url=${encodeURIComponent('https://open.spotify.com/playlist/1111111111111111111111')}`);
    assert.equal(res.status, 502);
    assert.ok((await res.json()).error);
  }));

test('GET /api/cover validates the id and returns an image url', () =>
  withServer(async (base) => {
    let res = await fetch(`${base}/api/cover?id=../../etc`);
    assert.equal(res.status, 400);
    res = await fetch(`${base}/api/cover?id=70cHKK8bHAfJrOGVnfRG9J`);
    assert.equal(res.status, 200);
    assert.match((await res.json()).image, /^https:\/\//);
  }));

test('serves the static frontend', () =>
  withServer(async (base) => {
    const res = await fetch(`${base}/`);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /Guess the Song/);
    const js = await fetch(`${base}/game-logic.js`);
    assert.equal(js.status, 200);
    const api404 = await fetch(`${base}/api/nope`);
    assert.equal(api404.status, 404);
  }));

test('/api responses allow cross-origin use (static frontend on another host)', () =>
  withServer(async (base) => {
    const res = await fetch(`${base}/api/tracks?url=${encodeURIComponent('spotify:album:4aawyAB9vmqN3uQ7FjRGTy')}`, {
      headers: { Origin: 'https://someone.github.io' },
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
    const pre = await fetch(`${base}/api/cover?id=70cHKK8bHAfJrOGVnfRG9J`, {
      method: 'OPTIONS',
      headers: { Origin: 'https://someone.github.io', 'Access-Control-Request-Method': 'GET' },
    });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get('access-control-allow-origin'), '*');
  }));
