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

  /*
   * The "Use an example playlist" button. Its track list is bundled with the
   * game in EXAMPLE_SNAPSHOT (made by `npm run snapshot`), so the example loads
   * without a backend or proxy. The snapshot is used whenever the link entered
   * is this playlist; if the file is missing or is of another playlist, the
   * game loads the playlist from Spotify as usual.
   */
  EXAMPLE_URL: 'https://open.spotify.com/playlist/6i2Qd6OpeRBAzxfscNXeWp',
  EXAMPLE_SNAPSHOT: 'data/example-playlist.json',

  /*
   * Multiplayer rooms connect phones to the host with WebRTC (PeerJS), using
   * PeerJS's free public signaling server (0.peerjs.com) unless host/port/path/
   * key/secure are set here for your own PeerServer:
   *   PEERJS: { host: 'peer.example.com', port: 443, path: '/', secure: true, iceServers: [...] }
   *
   * iceServers: how two devices find a path to each other. STUN finds a
   * device's public address; TURN relays the traffic when no direct path works
   * (carrier-grade or symmetric NAT on mobile data, Wi-Fi with client
   * isolation, guest networks). Without a TURN relay those phones can't join.
   * The defaults are Google's STUN server and the free Open Relay TURN servers
   * of metered.ca (https://www.metered.ca/tools/openrelay/). Open Relay is a
   * free, best-effort service (about 20 GB a month shared by everyone using
   * these credentials, no uptime guarantee). For reliable games, put your own
   * TURN credentials first, e.g. a free metered.ca account's:
   *   { urls: ['turn:<you>.relay.metered.ca:80', 'turns:<you>.relay.metered.ca:443?transport=tcp'],
   *     username: '...', credential: '...' },
   * An entry with `authSecret` (instead of username/credential) is a TURN
   * server with a shared secret (the "TURN REST API" / coturn use-auth-secret
   * scheme): the game makes a time-limited username and credential from it.
   * Open Relay publishes its secret for exactly this use; these credentials
   * are public, not private.
   *
   * iceTransportPolicy: 'all' (default) or 'relay' (TURN only; also per visit
   * with ?ice=relay). A phone whose join fails because no path worked
   * (ICE failed) retries with 'relay' by itself.
   * Add ?transport=local to the URL to use tabs of one browser instead (testing),
   * and ?debug=1..3 for PeerJS logs in the browser console.
   */
  PEERJS: {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      // Open Relay (metered.ca), static-auth TURN, as published on the page above in September 2026.
      {
        urls: [
          'turn:staticauth.openrelay.metered.ca:80',
          'turn:staticauth.openrelay.metered.ca:80?transport=tcp',
          'turn:staticauth.openrelay.metered.ca:443?transport=tcp',
        ],
        authSecret: 'openrelayprojectsecret',
      },
      // Open Relay's older public username/password (no longer listed on the page; kept as a fallback).
      {
        urls: [
          'turn:openrelay.metered.ca:80',
          'turn:openrelay.metered.ca:443',
          'turn:openrelay.metered.ca:443?transport=tcp',
          'turns:openrelay.metered.ca:443?transport=tcp',
        ],
        username: 'openrelayproject',
        credential: 'openrelayproject',
      },
    ],
    iceTransportPolicy: 'all',
  },

  /*
   * "Full songs via Spotify": the Client ID of the Spotify app used to sign in
   * (https://developer.spotify.com/dashboard). Sign-in uses PKCE, so there is
   * no client secret, here or anywhere else. The app's Redirect URIs must
   * include this site's address, https://michaelphagen.github.io/spotify-guessing-game/
   * and, for local development, http://127.0.0.1:3000/ (Spotify doesn't accept
   * "localhost"). A host can still use a different app by pasting its Client
   * ID on the setup screen ("Use a different Spotify app"; kept in that
   * browser's localStorage). '' = no default: the host must paste one.
   * See "Full songs with Spotify" in the README.
   */
  SPOTIFY_CLIENT_ID: 'a010d85057d64fdfabe0fb42155cacba',
};
