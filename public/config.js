/*
 * Guess the Song: deployment settings. Edit this file to change where the game
 * gets its song lists from.
 *
 * How song lists are loaded:
 *   1. Ask the backend: GET <API_BASE>api/tracks?url=... (the Node server in server/).
 *   2. If there is no backend (e.g. the site is hosted on GitHub Pages, where that
 *      request returns a 404 page), fetch Spotify's embed page through the public
 *      CORS proxies below, in order, and parse it in the browser ("static mode").
 *
 * You can also override the backend per visit with a query parameter:
 *   ?api=https://my-backend.onrender.com   use that backend
 *   ?api=none                              skip the backend, always use the proxies
 */
window.GTS_CONFIG = {
  /*
   * Where the Node backend lives.
   *   ''     same origin as the page (works when `npm start` serves the game;
   *          on a static host this falls back to the proxies automatically).
   *   'https://guess-the-song.onrender.com'   a backend deployed elsewhere
   *          (it sends CORS headers, so the static site can call it).
   *   'none' never use a backend.
   */
  API_BASE: '',

  /*
   * Public CORS proxies for static mode, tried in order until one works. The
   * last proxy that worked is tried first next time.
   *   url:     template; {url} is the URL-encoded Spotify embed URL, {raw} the
   *            same URL unencoded.
   *   format:  'html' (response body is the page) or 'allorigins-json'
   *            (response is {"contents": "<page html>"}).
   *   headers: optional extra request headers.
   * Free proxies come and go and are rate limited; add your own (for example a
   * Cloudflare Worker) at the top if you have one.
   */
  CORS_PROXIES: [
    { name: 'r.jina.ai', url: 'https://r.jina.ai/{raw}', format: 'html', headers: { 'X-Return-Format': 'html' } },
    { name: 'allorigins', url: 'https://api.allorigins.win/get?url={url}', format: 'allorigins-json' },
    { name: 'allorigins-raw', url: 'https://api.allorigins.win/raw?url={url}', format: 'html' },
    { name: 'codetabs', url: 'https://api.codetabs.com/v1/proxy/?quest={url}', format: 'html' },
  ],

  /* Give up on a proxy after this many milliseconds and try the next one. */
  PROXY_TIMEOUT_MS: 12000,
};
