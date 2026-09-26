'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseEmbedHtml, parseEmbedData, extractNextData, fetchEmbed, EmbedError } = require('../server/embed');

// Fixtures are real embed pages captured from open.spotify.com (trimmed, with
// the anonymous session token removed).
const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');

test('parses a playlist embed page and skips tracks without previews', () => {
  const { source, tracks, skipped } = parseEmbedHtml(fixture('playlist-embed.html'), 'playlist');
  assert.equal(source.type, 'playlist');
  assert.equal(source.name, 'Today’s Top Hits');
  assert.match(source.image, /^https:\/\//);
  assert.equal(tracks.length, 7); // fixture has 8 tracks, one without audioPreview
  assert.equal(skipped, 1);
  const first = tracks[0];
  assert.deepEqual(Object.keys(first).sort(), ['artist', 'id', 'image', 'previewUrl', 'title']);
  assert.equal(first.id, '70cHKK8bHAfJrOGVnfRG9J');
  assert.equal(first.title, 'Nicole Kidman');
  assert.equal(first.artist, 'ADÉLA');
  assert.match(first.previewUrl, /^https:\/\/p\.scdn\.co\/mp3-preview\//);
  assert.equal(first.image, null); // playlist embeds carry no per-track art
  for (const t of tracks) {
    assert.ok(t.id && t.title && t.previewUrl, JSON.stringify(t));
    assert.ok(!/ /.test(t.artist), 'non-breaking spaces are normalised');
  }
});

test('parses an album embed page; tracks share the album cover', () => {
  const { source, tracks } = parseEmbedHtml(fixture('album-embed.html'), 'album');
  assert.equal(source.type, 'album');
  assert.equal(source.name, 'Global Warming');
  assert.ok(source.image);
  assert.equal(tracks.length, 5);
  assert.equal(tracks[0].title, 'Global Warming (feat. Sensato)');
  assert.equal(tracks[0].artist, 'Pitbull, Sensato');
  assert.ok(tracks.every((t) => t.image === source.image));
});

test('parses a single-track embed page', () => {
  const { source, tracks } = parseEmbedHtml(fixture('track-embed.html'), 'track');
  assert.equal(source.type, 'track');
  assert.equal(tracks.length, 1);
  assert.equal(tracks[0].id, '70cHKK8bHAfJrOGVnfRG9J');
  assert.equal(tracks[0].artist, 'ADÉLA');
  assert.match(tracks[0].image, /^https:\/\//);
});

test('reports not-found embed pages', () => {
  assert.throws(() => parseEmbedHtml(fixture('notfound-embed.html'), 'playlist'), (e) => e instanceof EmbedError && e.code === 'not_found');
});

test('throws a parse error when __NEXT_DATA__ is missing or invalid', () => {
  assert.throws(() => extractNextData('<html></html>'), (e) => e.code === 'parse');
  assert.throws(() => extractNextData('<script id="__NEXT_DATA__">{nope</script>'), (e) => e.code === 'parse');
});

test('falls back to walking the JSON when the entity path changes', () => {
  const data = {
    props: {
      pageProps: {
        somethingNew: {
          media: {
            name: 'Moved Playlist',
            type: 'playlist',
            items: [
              { uri: 'spotify:track:AAAAAAAAAAAAAAAAAAAAAA', title: 'One', subtitle: 'A', audioPreview: { url: 'https://p.scdn.co/mp3-preview/1' } },
              { uri: 'spotify:track:BBBBBBBBBBBBBBBBBBBBBB', title: 'Two', subtitle: 'B', audioPreview: { url: 'https://p.scdn.co/mp3-preview/2' } },
              { uri: 'spotify:track:CCCCCCCCCCCCCCCCCCCCCC', title: 'No preview', subtitle: 'C' },
              { uri: 'spotify:track:AAAAAAAAAAAAAAAAAAAAAA', title: 'One', subtitle: 'A', audioPreview: { url: 'https://p.scdn.co/mp3-preview/1' } },
            ],
          },
        },
      },
    },
  };
  const { tracks, skipped } = parseEmbedData(data, 'playlist');
  assert.deepEqual(tracks.map((t) => t.title), ['One', 'Two']);
  assert.equal(skipped, 1);
});

test('fetchEmbed maps HTTP failures to error codes', async () => {
  const ref = { type: 'playlist', id: '37i9dQZF1DXcBWIGoYBM5M' };
  const mk = (status, body = '') => async () => new Response(body, { status });
  await assert.rejects(fetchEmbed(ref, { fetchImpl: mk(404) }), (e) => e.code === 'not_found');
  await assert.rejects(fetchEmbed(ref, { fetchImpl: mk(503) }), (e) => e.code === 'upstream');
  await assert.rejects(fetchEmbed(ref, { fetchImpl: async () => { throw new TypeError('fetch failed'); } }), (e) => e.code === 'upstream');
  // A timeout while reading the body must still surface as an EmbedError (502), not a 500.
  const stalled = new ReadableStream({ pull(c) { c.error(new DOMException('timed out', 'TimeoutError')); } });
  await assert.rejects(fetchEmbed(ref, { fetchImpl: async () => new Response(stalled, { status: 200 }) }),
    (e) => e instanceof EmbedError && e.code === 'upstream');
  let calledUrl;
  const ok = await fetchEmbed(ref, {
    fetchImpl: async (url) => { calledUrl = url; return new Response(fixture('playlist-embed.html'), { status: 200 }); },
  });
  assert.equal(calledUrl, 'https://open.spotify.com/embed/playlist/37i9dQZF1DXcBWIGoYBM5M');
  assert.equal(ok.tracks.length, 7);
});
