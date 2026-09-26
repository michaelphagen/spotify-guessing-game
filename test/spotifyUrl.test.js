'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseSpotifyInput, SpotifyUrlError } = require('../public/lib/spotify-url.js');

const ID = '37i9dQZF1DXcBWIGoYBM5M';

test('parses playlist URLs and strips query strings', () => {
  for (const input of [
    `https://open.spotify.com/playlist/${ID}`,
    `https://open.spotify.com/playlist/${ID}?si=abc123&pt=xyz`,
    `https://open.spotify.com/playlist/${ID}#frag`,
    `  open.spotify.com/playlist/${ID}/  `,
    `http://open.spotify.com/intl-de/playlist/${ID}`,
    `https://open.spotify.com/intl-es-419/playlist/${ID}/`,
    `https://open.spotify.com/embed/playlist/${ID}?utm_source=generator`,
    `https://play.spotify.com/playlist/${ID}`,
    `https://open.spotify.com/user/spotify/playlist/${ID}`,
  ]) {
    assert.deepEqual(parseSpotifyInput(input), { type: 'playlist', id: ID }, input);
  }
});

test('parses spotify: URIs', () => {
  assert.deepEqual(parseSpotifyInput(`spotify:playlist:${ID}`), { type: 'playlist', id: ID });
  assert.deepEqual(parseSpotifyInput(`spotify:user:spotify:playlist:${ID}`), { type: 'playlist', id: ID });
  assert.deepEqual(parseSpotifyInput('spotify:album:4aawyAB9vmqN3uQ7FjRGTy'), { type: 'album', id: '4aawyAB9vmqN3uQ7FjRGTy' });
  assert.deepEqual(parseSpotifyInput('spotify:track:70cHKK8bHAfJrOGVnfRG9J'), { type: 'track', id: '70cHKK8bHAfJrOGVnfRG9J' });
});

test('parses album and track URLs', () => {
  assert.deepEqual(parseSpotifyInput('https://open.spotify.com/album/4aawyAB9vmqN3uQ7FjRGTy?si=1'), { type: 'album', id: '4aawyAB9vmqN3uQ7FjRGTy' });
  assert.deepEqual(parseSpotifyInput('https://open.spotify.com/track/70cHKK8bHAfJrOGVnfRG9J?si=x'), { type: 'track', id: '70cHKK8bHAfJrOGVnfRG9J' });
});

test('rejects unsupported or malformed input with a helpful message', () => {
  const bad = [
    '',
    '   ',
    'hello world',
    'https://example.com/playlist/' + ID,
    'https://open.spotify.com/artist/0TnOYISbd1XYRBk9myaseg',
    'https://open.spotify.com/show/abcdefghijklmnopqrstuv',
    'https://open.spotify.com/playlist/',
    'https://open.spotify.com/playlist/bad-id!',
    'spotify:artist:0TnOYISbd1XYRBk9myaseg',
    'https://spotify.link/abc123',
  ];
  for (const input of bad) {
    assert.throws(() => parseSpotifyInput(input), SpotifyUrlError, JSON.stringify(input));
  }
  assert.throws(() => parseSpotifyInput('https://open.spotify.com/artist/0TnOYISbd1XYRBk9myaseg'), /"artist" links are not supported/);
});
