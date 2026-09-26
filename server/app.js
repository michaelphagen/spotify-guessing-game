'use strict';

const path = require('path');
const express = require('express');
const { parseSpotifyInput, SpotifyUrlError } = require('../public/lib/spotify-url.js');
const { fetchEmbed, EmbedError } = require('./embed');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX = 200;

/** Tiny TTL cache so repeated games on the same playlist don't re-hit Spotify. */
function createCache() {
  const map = new Map();
  return {
    get(key) {
      const hit = map.get(key);
      if (!hit) return undefined;
      if (Date.now() > hit.expires) {
        map.delete(key);
        return undefined;
      }
      return hit.value;
    },
    set(key, value) {
      if (map.size >= CACHE_MAX) map.delete(map.keys().next().value);
      map.set(key, { value, expires: Date.now() + CACHE_TTL_MS });
    },
  };
}

/**
 * @param {{fetchImpl?: typeof fetch, corsOrigin?: string}} [options]
 *   fetchImpl is injectable for tests. corsOrigin is the Access-Control-Allow-Origin
 *   sent on /api responses (default: CORS_ORIGIN env var, or '*') so a static copy
 *   of the frontend (e.g. on GitHub Pages) can use this server as its backend.
 */
function createApp(options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const corsOrigin = options.corsOrigin || process.env.CORS_ORIGIN || '*';
  const app = express();
  const tracksCache = createCache();
  const coverCache = createCache();

  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'no-referrer');
    next();
  });

  // The API is read-only and public, so cross-origin GETs are allowed.
  app.use('/api', (req, res, next) => {
    res.set('Access-Control-Allow-Origin', corsOrigin);
    if (corsOrigin !== '*') res.set('Vary', 'Origin');
    if (req.method === 'OPTIONS') {
      res.set('Access-Control-Allow-Methods', 'GET');
      res.set('Access-Control-Allow-Headers', 'Accept');
      res.set('Access-Control-Max-Age', '86400');
      return res.sendStatus(204);
    }
    next();
  });

  app.get('/api/health', (req, res) => res.json({ ok: true }));

  app.get('/api/tracks', async (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    let ref;
    try {
      ref = parseSpotifyInput(String(req.query.url || ''));
    } catch (err) {
      if (err instanceof SpotifyUrlError) return res.status(400).json({ error: err.message });
      return next(err); // Express 4 does not catch errors thrown from async handlers
    }

    const key = `${ref.type}:${ref.id}`;
    const cached = tracksCache.get(key);
    if (cached) return res.json(cached);

    try {
      const { source, tracks, skipped } = await fetchEmbed(ref, { fetchImpl });
      if (!tracks.length) {
        return res.status(404).json({
          error: skipped
            ? `Found ${skipped} track(s), but none of them have an audio preview available. Try another playlist.`
            : 'No tracks were found at that link.',
        });
      }
      const body = { source, tracks, skipped };
      tracksCache.set(key, body);
      return res.json(body);
    } catch (err) {
      if (err instanceof EmbedError) {
        const status = err.code === 'not_found' ? 404 : 502;
        return res.status(status).json({ error: err.message });
      }
      console.error('Unexpected error in /api/tracks:', err);
      return res.status(500).json({ error: 'Unexpected server error.' });
    }
  });

  // Track artwork for the reveal screen. Playlist embeds don't include per-track
  // covers, so we look it up lazily (after the guess) via Spotify's public oEmbed.
  app.get('/api/cover', async (req, res) => {
    const id = String(req.query.id || '');
    if (!/^[A-Za-z0-9]{10,40}$/.test(id)) return res.status(400).json({ error: 'Invalid track id.' });
    const cached = coverCache.get(id);
    if (cached !== undefined) return res.json({ image: cached });
    try {
      const url = `https://open.spotify.com/oembed?url=${encodeURIComponent('https://open.spotify.com/track/' + id)}`;
      const r = await fetchImpl(url, { signal: AbortSignal.timeout(8000) });
      if (!r.ok) return res.status(r.status === 404 ? 404 : 502).json({ error: 'Cover not available.' });
      const j = await r.json();
      const image = typeof j.thumbnail_url === 'string' && /^https:\/\//.test(j.thumbnail_url) ? j.thumbnail_url : null;
      coverCache.set(id, image);
      return res.json({ image });
    } catch {
      return res.status(502).json({ error: 'Cover not available.' });
    }
  });

  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

  app.use(express.static(PUBLIC_DIR, { extensions: ['html'] }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).json({ error: 'Unexpected server error.' });
  });

  return app;
}

module.exports = { createApp };
