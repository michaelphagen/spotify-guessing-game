/**
 * Parse a Spotify link or URI into { type, id }.
 *
 * Shared by the browser (window.SpotifyUrl, loaded from public/lib/) and the
 * Node server (require('../public/lib/spotify-url.js')). No DOM or Node APIs.
 *
 * Accepts:
 *   https://open.spotify.com/playlist/{id}?si=...
 *   https://open.spotify.com/intl-de/album/{id}
 *   https://open.spotify.com/embed/track/{id}
 *   https://play.spotify.com/playlist/{id}
 *   open.spotify.com/playlist/{id}            (scheme optional)
 *   spotify:playlist:{id}, spotify:album:{id}, spotify:track:{id}
 *   spotify:user:{user}:playlist:{id}         (legacy URI form)
 *
 * Throws a SpotifyUrlError (with a user-facing message) for anything else.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SpotifyUrl = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const SUPPORTED_TYPES = ['playlist', 'album', 'track'];
  const ID_RE = /^[A-Za-z0-9]{10,40}$/;

  class SpotifyUrlError extends Error {
    constructor(message) {
      super(message);
      this.name = 'SpotifyUrlError';
    }
  }

  function checkTypeAndId(type, id) {
    type = String(type || '').toLowerCase();
    if (!SUPPORTED_TYPES.includes(type)) {
      const what = type ? `"${type}" links` : 'That link';
      throw new SpotifyUrlError(
        `${what} are not supported. Paste a Spotify playlist, album or track link.`
      );
    }
    if (!ID_RE.test(id || '')) {
      throw new SpotifyUrlError('That Spotify link does not contain a valid ID.');
    }
    return { type, id };
  }

  function parseSpotifyInput(input) {
    if (typeof input !== 'string' || !input.trim()) {
      throw new SpotifyUrlError('Please paste a Spotify playlist, album or track link.');
    }
    let s = input.trim();

    // spotify:playlist:ID  /  spotify:user:NAME:playlist:ID
    if (/^spotify:/i.test(s)) {
      s = s.split(/[?#]/)[0];
      const parts = s.split(':').filter(Boolean);
      // parts[0] === 'spotify'
      const rest = parts.slice(1);
      if (rest[0] && rest[0].toLowerCase() === 'user' && rest.length >= 4) {
        return checkTypeAndId(rest[2], rest[3]);
      }
      return checkTypeAndId(rest[0], rest[1]);
    }

    if (/^spotify\.link\//i.test(s.replace(/^https?:\/\//i, ''))) {
      throw new SpotifyUrlError(
        'Short spotify.link URLs are not supported. Open the link in a browser and copy the full open.spotify.com address.'
      );
    }

    if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
    let url;
    try {
      url = new URL(s);
    } catch {
      throw new SpotifyUrlError('That does not look like a Spotify link.');
    }
    const host = url.hostname.toLowerCase();
    if (host !== 'open.spotify.com' && host !== 'play.spotify.com') {
      throw new SpotifyUrlError('Only open.spotify.com links (or spotify: URIs) are supported.');
    }

    // Query string (?si=...) and hash are ignored by using only the pathname.
    let segs = url.pathname.split('/').filter(Boolean);
    // Drop locale prefix like "intl-de" and an "embed" prefix.
    if (segs[0] && /^intl-[a-z0-9-]+$/i.test(segs[0])) segs = segs.slice(1);
    if (segs[0] && segs[0].toLowerCase() === 'embed') segs = segs.slice(1);
    // Legacy /user/{name}/playlist/{id}
    if (segs[0] && segs[0].toLowerCase() === 'user' && segs.length >= 4) segs = segs.slice(2);

    return checkTypeAndId(segs[0], segs[1]);
  }

  return { parseSpotifyInput, SpotifyUrlError, SUPPORTED_TYPES };
});
