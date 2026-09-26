/**
 * Parse Spotify's public embed pages
 * (https://open.spotify.com/embed/{playlist|album|track}/{id}).
 *
 * Shared by the browser (window.EmbedParser, used in static mode where the page
 * is fetched through a CORS proxy) and the Node server
 * (require('../public/lib/embed-parser.js')). No DOM or Node APIs in here.
 *
 * The embed page is a Next.js app; its server-rendered state lives in
 * <script id="__NEXT_DATA__" type="application/json">. The useful bits are at
 *   props.pageProps.state.data.entity
 * with `trackList[]` entries shaped like
 *   { uri, title, subtitle (artists), duration, audioPreview: { url } }
 * For a track embed the entity itself is the track (with `artists[]`).
 *
 * Spotify can change this shape at any time, so the parser falls back to
 * walking the whole JSON tree for track-like objects.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.EmbedParser = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const EMBED_BASE = 'https://open.spotify.com/embed';

  /** The embed page URL for a parsed { type, id } reference. */
  function embedUrl(ref) {
    return `${EMBED_BASE}/${ref.type}/${encodeURIComponent(ref.id)}`;
  }

  class EmbedError extends Error {
    /** @param {'not_found'|'upstream'|'parse'|'empty'} code */
    constructor(code, message) {
      super(message);
      this.name = 'EmbedError';
      this.code = code;
    }
  }

  function extractNextData(html) {
    const m = /<script[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i.exec(html || '');
    if (!m) throw new EmbedError('parse', 'Spotify embed page did not contain the expected data.');
    try {
      return JSON.parse(m[1]);
    } catch {
      throw new EmbedError('parse', 'Spotify embed data could not be parsed.');
    }
  }

  function cleanText(s) {
    return String(s == null ? '' : s)
      .replace(/[\u00a0\u2000-\u200b\u202f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function trackIdFromUri(uri) {
    const m = /^spotify:track:([A-Za-z0-9]+)$/.exec(uri || '');
    return m ? m[1] : null;
  }

  /** Pick a ~300px image from the various image shapes the embed uses. */
  function pickImage(obj) {
    if (!obj || typeof obj !== 'object') return null;
    const lists = [];
    if (obj.coverArt && Array.isArray(obj.coverArt.sources)) lists.push(obj.coverArt.sources);
    if (obj.visualIdentity && Array.isArray(obj.visualIdentity.image)) lists.push(obj.visualIdentity.image);
    if (Array.isArray(obj.images)) lists.push(obj.images);
    for (const list of lists) {
      const imgs = list
        .filter((i) => i && typeof i.url === 'string')
        .map((i) => ({ url: i.url, size: i.maxWidth || i.width || i.maxHeight || i.height || 0 }));
      if (!imgs.length) continue;
      // Prefer the smallest image that is at least 300px; otherwise the largest.
      const big = imgs.filter((i) => i.size >= 300).sort((a, b) => a.size - b.size);
      if (big.length) return big[0].url;
      return imgs.sort((a, b) => b.size - a.size)[0].url;
    }
    return null;
  }

  function artistText(t) {
    if (Array.isArray(t.artists) && t.artists.length) {
      return cleanText(t.artists.map((a) => (a && a.name) || '').filter(Boolean).join(', '));
    }
    return cleanText(t.subtitle || t.artist || '');
  }

  function previewUrlOf(t) {
    const p = t && t.audioPreview;
    const url = p && typeof p === 'object' ? p.url : typeof p === 'string' ? p : null;
    return typeof url === 'string' && /^https:\/\//.test(url) ? url : null;
  }

  function normalizeTrack(t, fallbackImage) {
    const id = trackIdFromUri(t.uri) || (typeof t.id === 'string' ? t.id : null);
    return {
      id,
      title: cleanText(t.title || t.name),
      artist: artistText(t),
      previewUrl: previewUrlOf(t),
      image: pickImage(t) || fallbackImage || null,
    };
  }

  function isTrackLike(o) {
    return (
      o && typeof o === 'object' && !Array.isArray(o) &&
      typeof o.uri === 'string' && o.uri.startsWith('spotify:track:') &&
      (typeof o.title === 'string' || typeof o.name === 'string')
    );
  }

  /** Depth-first walk collecting track-like objects (fallback when the shape changes). */
  function walkForTracks(root) {
    const found = [];
    const seen = new Set();
    const stack = [root];
    while (stack.length) {
      const node = stack.pop();
      if (!node || typeof node !== 'object' || seen.has(node)) continue;
      seen.add(node);
      if (isTrackLike(node)) {
        found.push(node);
        continue;
      }
      const children = Array.isArray(node) ? node : Object.values(node);
      for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]);
    }
    return found;
  }

  function findEntity(data) {
    const direct =
      data && data.props && data.props.pageProps && data.props.pageProps.state &&
      data.props.pageProps.state.data && data.props.pageProps.state.data.entity;
    if (direct && typeof direct === 'object') return direct;
    // Fallback (shape changed): breadth-first search for an object that looks like
    // a playlist/album/track entity, i.e. has a trackList, or a name plus a known type.
    const stack = [data];
    const seen = new Set();
    let named = null;
    while (stack.length) {
      const node = stack.shift();
      if (!node || typeof node !== 'object' || seen.has(node)) continue;
      seen.add(node);
      if (!Array.isArray(node)) {
        if (Array.isArray(node.trackList)) return node;
        if (!named && typeof node.name === 'string' && /^(playlist|album|track)$/.test(node.type)) named = node;
      }
      for (const v of Array.isArray(node) ? node : Object.values(node)) stack.push(v);
    }
    return named || {};
  }

  /**
   * Turn parsed __NEXT_DATA__ into { source, tracks, skipped }.
   * `expectedType` is the type from the URL (used when the entity lacks one).
   */
  function parseEmbedData(data, expectedType) {
    const pageProps = (data && data.props && data.props.pageProps) || {};
    const status = Number(pageProps.status);
    if (status >= 400) {
      throw new EmbedError(
        status === 404 || status === 500 ? 'not_found' : 'upstream',
        'Spotify says this page is not available. Check that the link is correct and the playlist is public.'
      );
    }

    const entity = findEntity(data);

    const type = String(entity.type || expectedType || 'playlist').toLowerCase();
    const sourceImage = pickImage(entity);
    const source = {
      type,
      name: cleanText(entity.name || entity.title) || 'Spotify ' + type,
      image: sourceImage,
    };

    let raw;
    if (Array.isArray(entity.trackList)) raw = entity.trackList;
    else if (isTrackLike(entity)) raw = [entity];
    else raw = walkForTracks(data);
    if (!raw.length && !entity.type) {
      throw new EmbedError('not_found', 'No playlist, album or track was found at that link.');
    }

    // Playlist tracks have no per-track artwork in the embed; albums share the album cover.
    const fallbackImage = type === 'album' || type === 'track' ? sourceImage : null;

    const tracks = [];
    const ids = new Set();
    let skipped = 0;
    for (const t of raw) {
      if (!t || typeof t !== 'object') continue;
      const n = normalizeTrack(t, fallbackImage);
      if (!n.id || !n.title) continue;
      if (ids.has(n.id)) continue;
      if (!n.previewUrl || t.isPlayable === false) {
        skipped++;
        continue;
      }
      ids.add(n.id);
      tracks.push(n);
    }
    return { source, tracks, skipped };
  }

  function parseEmbedHtml(html, expectedType) {
    return parseEmbedData(extractNextData(html), expectedType);
  }

  return {
    EMBED_BASE,
    EmbedError,
    embedUrl,
    extractNextData,
    parseEmbedData,
    parseEmbedHtml,
    pickImage,
    walkForTracks,
    cleanText,
  };
});
