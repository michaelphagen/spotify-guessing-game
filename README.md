# Guess the Song

Play it live: **https://michaelphagen.github.io/spotify-guessing-game/**

A pass-the-phone party game. Paste a Spotify playlist (or album or track) link. Each player in turn hears the **first 5 seconds** of a song and guesses what it is. If they're stuck, they can play the **next 10 seconds** (seconds 5 to 15), but a correct answer is then worth fewer points.

- **Answer modes:** multiple choice (4 options drawn from the same playlist) or free answer (typed, fuzzy matched).
- **Scoring:** 10 points for a correct answer after the 5-second clip, 5 points after the extra 10 seconds, and 0 for a wrong or revealed answer.
- **Players:** 1 to 12. Turns rotate, and the scoreboard is always visible.
- **Rounds:** 1, 3, 5 or 10 (each round gives every player one song), or play until the songs run out.
- **No repeats:** a song is never played twice in a session. "Play again" can keep excluding songs you've already heard.
- **Reloads are safe:** the game state lives in `sessionStorage`.

## Run it

Requires Node 18 or newer.

```bash
npm install
npm start            # http://localhost:3000  (set PORT to change)
npm test             # node:test unit + API tests (offline, fixture based)
```

To play on phones on the same Wi-Fi network, open `http://<your-computer-ip>:3000`.

## Deploy to GitHub Pages

The frontend in `public/` is plain static files, and it works without the Node server (see [Static mode](#static-mode)). The workflow in `.github/workflows/deploy.yml` runs the tests and publishes `public/` to GitHub Pages.

One-time setup:

1. In the GitHub repo, open **Settings → Pages** and under **Build and deployment** set **Source** to **GitHub Actions**. (This replaces any existing branch-based Pages site for the repo.)

After that, every push to `main` deploys automatically. You can also run the workflow by hand from the **Actions** tab (**Run workflow**).

The game is published at `https://<user>.github.io/<repo>/`, for this repo `https://michaelphagen.github.io/spotify-guessing-game/`. All asset and API paths are relative, so the sub-path works; any other static host (Netlify, Cloudflare Pages, S3, `python3 -m http.server`) works the same way.

## Static mode

When the page is served without the Node server, `GET api/tracks` returns the host's 404 page instead of JSON. The game notices this once per browser tab and switches to static mode:

1. The Spotify link is parsed in the browser (`public/lib/spotify-url.js`).
2. The embed page is fetched through a **public CORS proxy**, trying each proxy in `CORS_PROXIES` in `public/config.js` in order (12-second timeout each). The proxy that worked is tried first next time.
3. The page is parsed in the browser with the same parser the server uses (`public/lib/embed-parser.js`). Results are cached in memory for 10 minutes.
4. Cover art on the result screen comes from Spotify's oEmbed endpoint, which allows cross-origin requests. If that fails, the playlist cover (or a note icon) is shown.

Preview MP3s already allow cross-origin playback, so audio works the same in both modes.

Limits of static mode:

- **Third-party dependency.** Free proxies are run by other people. They get rate limited, go down, start requiring API keys, or disappear. When all of them fail you'll see "Couldn't load that playlist. Public proxies are rate limited; try again or run the server locally." The list in `config.js` was checked in September 2026: `r.jina.ai` worked reliably, `api.allorigins.win` worked intermittently, and `api.codetabs.com` was mostly timing out. `corsproxy.io` now requires an API key and was removed.
- **Rate limits.** The proxies limit requests per IP. A few games an hour is fine; heavy use isn't.
- **Privacy.** The proxy sees which playlist you load (nothing else is sent).
- **Same ~100 track cap** and preview rules as server mode (see [Limitations](#limitations)).

To add your own proxy (for example a small Cloudflare Worker), put it at the top of `CORS_PROXIES`. `{url}` in the template is replaced with the URL-encoded embed URL and `{raw}` with the plain one.

### Point the static site at your own backend

If you deploy the Node server somewhere (see below), the static site can use it instead of the proxies. The server sends `Access-Control-Allow-Origin: *` on `/api` responses (set the `CORS_ORIGIN` environment variable to restrict it, e.g. `https://<user>.github.io`). Then either:

- edit `public/config.js` and set `API_BASE: 'https://your-backend.onrender.com'`, or
- open the game with `?api=https://your-backend.onrender.com` appended to the URL, which is handy for testing. `?api=none` forces static mode.

If the configured backend can't be reached (a free Render service may take up to a minute to wake up), the game falls back to the proxies for that request.

## Deploy the backend (optional)

`render.yaml` is a [Render](https://render.com) Blueprint for a free Node web service that runs `npm start`. In Render choose **New → Blueprint** and pick this repository. The service serves the whole game as well as the API, so you can play at its URL directly, or use it as the backend of the Pages site as described above. Any Node host works (Fly.io, Railway, a VPS): run `npm ci && npm start` and set `PORT` if needed.

## How audio is sourced

No Spotify account, API keys or OAuth are needed.

Spotify's Web API stopped returning `preview_url` for apps created after November 2024, and the Web Playback SDK needs Premium plus OAuth. This game uses Spotify's public **embed pages** instead:

1. The browser calls `GET api/tracks?url=<spotify link>` (relative to the page). Without a server, the browser does steps 2 to 4 itself; see [Static mode](#static-mode).
2. The server normalises the link (`?si=` query strings, `intl-xx/` prefixes and `spotify:` URIs are all fine) and fetches `https://open.spotify.com/embed/{playlist|album|track}/{id}`.
3. The server parses the Next.js state in `<script id="__NEXT_DATA__">`, specifically `props.pageProps.state.data.entity.trackList[]`. Each entry has a `uri`, `title`, `subtitle` (the artists) and `audioPreview.url`, which is a 30-second MP3 on `p.scdn.co`. If Spotify moves that path, the parser falls back to walking the whole JSON tree for track-like objects.
4. The server responds with:
   ```json
   { "source": { "type": "playlist", "name": "…", "image": "…" },
     "tracks": [ { "id": "…", "title": "…", "artist": "…", "previewUrl": "https://p.scdn.co/mp3-preview/…", "image": null } ],
     "skipped": 0 }
   ```
   Errors come back as `{ "error": "…" }`: 400 for an unsupported or malformed link, 404 when the item isn't found or has no playable previews, and 502 when Spotify can't be reached or returns something unexpected.
5. The browser plays the preview MP3 directly from Spotify's CDN in an HTML5 `Audio` element. The CDN sends `Access-Control-Allow-Origin: *` over HTTPS, so no audio proxy is needed. Playback stops at exactly 5.0 s (or 15.0 s). Stopping uses three mechanisms: a `requestAnimationFrame` position check, the `timeupdate` event, and a `setTimeout` safety net that re-checks the media clock.
6. On the result screen, playlist tracks get their cover art from `GET api/cover?id=<trackId>`. This endpoint wraps Spotify's public oEmbed endpoint, and the lookup only happens after the answer has been given. Album and track links already include the cover.

The answer (title, artist, cover) is never written into the page before a guess is made. In multiple-choice mode, the option buttons show titles but nothing marks which one is correct. The preview URL is visible in the browser's network tab, but it doesn't reveal the song.

## Limitations

- **Track cap:** the embed page returns at most about **100 tracks** for a playlist. For example, a 150-song playlist yields its first 100. Larger playlists therefore only use their first ~100 songs.
- **Tracks without a preview are skipped.** The server reports how many were skipped and the game shows a notice. Tracks Spotify marks as unplayable are also skipped.
- **CORS.** Browsers can't fetch `open.spotify.com` directly, so either the small Express server does the fetch (responses cached in memory for 10 minutes) or, in static mode, a public CORS proxy does.
- **Unofficial data source.** The embed page format isn't a public API and could change without notice. The parser is defensive, and `test/fixtures/` holds real captured pages so you can tell quickly if the format breaks.
- **Link types:** artist, show and episode links, and `spotify.link` short links, aren't supported. For a short link, open it in a browser and paste the full `open.spotify.com` address instead.
- **Single-track links** produce a one-song game. Multiple choice needs at least 2 different songs, so a single-track game switches to free answer. With 2 or 3 songs, fewer options are shown.
- **Browser autoplay rules:** audio only starts from a tap, which the game always uses. On iOS, make sure the ringer/silent switch isn't muting the page.

## Free-answer matching

Answers are compared case-insensitively. Accents and punctuation are ignored, `&` is treated as "and", and suffixes such as `(feat. …)`, `[Remastered]` and ` - Remastered 2011` are dropped. A leading "The" is optional. Small typos are accepted: a Levenshtein similarity of at least 0.75, or 0.8 for short titles. Titles of 3 characters or fewer must match exactly, and numbers must match ("8 rings" is not "7 rings"). You can also type `title - artist`, `artist - title` or `title by artist`.

## Project layout

```
server/
  index.js        entry point (PORT, default 3000)
  app.js          Express app: /api/tracks, /api/cover (CORS enabled), static files
  embed.js        server-side embed page fetch (uses public/lib/embed-parser.js)
public/
  index.html, styles.css
  config.js       API_BASE and the CORS proxy list for static mode
  lib/
    spotify-url.js    link / URI parsing and validation (browser + server)
    embed-parser.js   __NEXT_DATA__ parser (browser + server)
    track-source.js   backend detection, CORS-proxy fallback, cover lookup
  game-logic.js   pure game rules (matching, options, turns, scoring), also used by tests
  app.js          UI controller, clip player, sessionStorage persistence
test/
  *.test.js       node:test suites (URL parsing, parser, track source, game logic, HTTP API)
  fixtures/       captured embed pages (trimmed; session tokens removed)
render.yaml       Render Blueprint for the optional backend
.github/workflows/deploy.yml   GitHub Pages deployment
```
