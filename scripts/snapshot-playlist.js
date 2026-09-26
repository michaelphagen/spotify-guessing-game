#!/usr/bin/env node
'use strict';

/**
 * Save a Spotify playlist (or album or track) to public/data/example-playlist.json,
 * so the setup screen's "example playlist" works without fetching Spotify and
 * keeps working if the live playlist changes or disappears.
 *
 *   npm run snapshot                      refresh the bundled example playlist
 *   npm run snapshot -- <spotify link>    snapshot another playlist instead
 *
 * Uses the server's embed-page fetch (server/embed.js), so it needs network
 * access to open.spotify.com. Covers for playlist tracks are looked up through
 * Spotify's public oEmbed endpoint (a failed lookup just leaves the cover out).
 * Behind an HTTPS proxy, run it with NODE_USE_ENV_PROXY=1 (Node 22.21+ / 24+).
 *
 * If you snapshot a different playlist, also set EXAMPLE_URL in
 * public/config.js to its link, otherwise the game ignores the snapshot.
 */

const fs = require('node:fs');
const path = require('node:path');
const { parseSpotifyInput } = require('../public/lib/spotify-url.js');
const { fetchEmbed } = require('../server/embed.js');

const DEFAULT_URL = 'https://open.spotify.com/playlist/6i2Qd6OpeRBAzxfscNXeWp';
const OUT_FILE = path.join(__dirname, '..', 'public', 'data', 'example-playlist.json');
const COVER_CONCURRENCY = 4;

/** Keep only https URLs, without query strings or fragments. */
function cleanUrl(u) {
  if (typeof u !== 'string' || !/^https:\/\/[^\s]+$/i.test(u)) return null;
  return u.replace(/[?#].*$/, '');
}

async function oembedCover(trackId) {
  const url = 'https://open.spotify.com/oembed?url=' + encodeURIComponent('https://open.spotify.com/track/' + trackId);
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return null;
    const j = await res.json();
    return cleanUrl(j && j.thumbnail_url);
  } catch {
    return null;
  }
}

/** Fill in missing track covers, a few requests at a time. */
async function addCovers(tracks) {
  const todo = tracks.filter((t) => !t.image);
  let next = 0;
  let found = 0;
  async function worker() {
    while (next < todo.length) {
      const t = todo[next++];
      t.image = await oembedCover(t.id);
      if (t.image) found++;
    }
  }
  await Promise.all(Array.from({ length: COVER_CONCURRENCY }, worker));
  return { looked: todo.length, found };
}

async function main() {
  const input = process.argv[2] || DEFAULT_URL;
  const ref = parseSpotifyInput(input);
  const cleanLink = `https://open.spotify.com/${ref.type}/${ref.id}`;
  console.log(`Fetching ${cleanLink} ...`);

  const parsed = await fetchEmbed(ref, { timeoutMs: 20000 });
  if (!parsed.tracks.length) throw new Error('No tracks with an audio preview were found at that link.');

  // Copy only the fields the game uses: nothing else from the page is stored.
  const tracks = parsed.tracks.map((t) => ({
    id: t.id,
    title: t.title,
    artist: t.artist,
    previewUrl: cleanUrl(t.previewUrl),
    image: cleanUrl(t.image),
  })).filter((t) => t.id && t.title && t.previewUrl);

  const covers = await addCovers(tracks);

  const snapshot = {
    source: {
      type: parsed.source.type,
      name: parsed.source.name,
      image: cleanUrl(parsed.source.image),
      url: cleanLink,
    },
    tracks,
    snapshotAt: new Date().toISOString(),
  };

  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(snapshot, null, 2) + '\n');

  console.log(`Saved "${snapshot.source.name}": ${tracks.length} tracks to ${path.relative(process.cwd(), OUT_FILE)}`);
  if (parsed.skipped) console.log(`  ${parsed.skipped} track(s) without an audio preview were left out.`);
  if (covers.looked) console.log(`  Covers: found ${covers.found} of ${covers.looked} via oEmbed.`);
  if (tracks.length + parsed.skipped >= 100) console.log('  Note: Spotify\'s embed page lists at most ~100 tracks; if the playlist is longer, only the first ~100 were saved.');
  if (cleanLink !== DEFAULT_URL) {
    console.log(`  This is not the default example. Set EXAMPLE_URL: '${cleanLink}' in public/config.js so the game uses it.`);
  }
}

main().catch((err) => {
  console.error('Snapshot failed: ' + (err && err.message ? err.message : err));
  process.exit(1);
});
