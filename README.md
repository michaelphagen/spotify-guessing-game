# Guess the Song

Play it live: **https://michaelphagen.github.io/spotify-guessing-game/**

A pass-the-phone party game. Paste a Spotify playlist (or album or track) link. Each player in turn hears the **first 5 seconds** of a song and guesses what it is. If they're stuck, they can play the **next 10 seconds** (seconds 5 to 15), but a correct answer is then worth fewer points.

- **Answer modes:** multiple choice (4 options drawn from the same playlist) or free answer (typed, fuzzy matched).
- **Scoring:** 10 points for a correct answer after the 5-second clip, 5 points after the extra 10 seconds, and 0 for a wrong or revealed answer.
- **Players:** 1 to 12. Turns rotate, and the scoreboard is always visible.
- **Rounds:** 1, 3, 5 or 10 (each round gives every player one song), or play until the songs run out.
- **Clip start:** from the beginning of the preview (default), or a random spot each song (0–15s in) so the intro alone isn't always the giveaway.
- **No repeats:** a song is never played twice in a session. "Play again" can keep excluding songs you've already heard.
- **Reloads are safe:** the game state lives in `sessionStorage`. A hosted room is also kept in `localStorage` for 12 hours, so it can be resumed after the tab is closed (see [Multiplayer rooms](#multiplayer-rooms)).
- **Multiplayer rooms:** instead of passing one phone around, one device can host a room that everyone joins with their own phone (see [Multiplayer rooms](#multiplayer-rooms)).

## Run it

Requires Node 18 or newer.

```bash
npm install
npm start            # http://localhost:3000  (set PORT to change)
npm test             # node:test unit + API tests (offline, fixture based)
npm run snapshot     # refresh the bundled example playlist (see below)
```

To play on phones on the same Wi-Fi network, open `http://<your-computer-ip>:3000`.

## Multiplayer rooms

Besides pass-the-phone (**Start game**), the setup screen has **Host a room** and **Join a room**. Rooms work on the static GitHub Pages site; no server of our own is involved.

**Host (the “TV”).** Pick the playlist, answer mode, rounds and clip start as usual and press **Host a room**. The lobby shows a 4-letter room code (letters only, no I, L or O), a join link and a **Copy link** button, and lists players as they join. You can also add players who have no phone; they play on the host device when it's their turn. Press **Start game** once at least one player is in. The host device plays all the audio and shows the round, the answer and the scoreboard; the room code stays in the header. During any turn the host can press play, stop, “play next 10 seconds”, **Skip** (0 points) or **Next** itself, which helps when a phone is unresponsive.

**Players.** Open the join link, or the site and then **Join a room**, and enter the code and your name. The phone shows a lobby, then the live scoreboard and “It's Alice's turn” while others play. On your own turn it shows a **Play** button (the song plays on the host device, not the phone), the answer options or text box, “Play next 10 seconds” once the first clip has finished, and **Reveal**, followed by the result. The clip's progress is mirrored on every phone. Nobody hears audio on their own phone, since everyone is in the same room.

**Join link format:** `https://michaelphagen.github.io/spotify-guessing-game/?room=ABCD`, which is `<site url>?room=<CODE>`. The code is case-insensitive.

**How it works.**

- **Host-authoritative, peer to peer.** The host keeps the whole game (players, scores, the song queue) and checks every action (`play`, `stop`, `extend`, `answer`, `reveal`, `next`) against whose turn it is. Players only send actions and get back a snapshot made for them. A snapshot never holds the current song's title, artist, cover or preview URL until the turn is resolved. Multiple-choice options (four titles, with nothing marking the right one) go only to the player whose turn it is. The host also picks the random clip start and the options. The protocol and rules are in `public/lib/room.js` (pure, unit-tested); scoring, turns, options and answer matching reuse `public/game-logic.js`.
- **Networking.** WebRTC data channels via [PeerJS](https://peerjs.com) **1.5.5** (vendored in `public/vendor/peerjs.min.js`, MIT license in `public/vendor/LICENSE-peerjs.txt`). PeerJS's **free public signaling server** (`0.peerjs.com`) introduces the devices to each other; it needs no account or key and is best-effort (no uptime guarantee). The host registers the peer id `gts-room-<CODE>` and phones connect to it. After that, game messages go directly between the devices (or through PeerJS's public TURN relay when a direct path isn't possible). To use your own PeerServer or TURN servers, set `PEERJS` in `public/config.js`. The transport is behind a small interface in `public/lib/transport.js` (`host`, `connect`, `send`, `onMessage`, `onPeerJoin`/`onPeerLeave`).
- **Messages** are JSON objects with a protocol version `v`. Player to host: `hello {name, token}`, `play`, `stop`, `extend`, `answer {optionId | text}`, `reveal`, `next`, and `sync` (send me the current state again, used when a phone comes back from the background). Host to player: `state {state}` (the player's snapshot), `playback {playback}` (the clip status and position, a few times a second while playing) and `error {code, message}`.
- **Dropped connections.** A player who disconnects keeps their score and shows as offline. If it's their turn, the host can wait or skip them. Rejoining with the same name reclaims the slot, and so does the same phone, which keeps a player token in `localStorage`. New players can't join once the game has started. Both sides send keep-alives, so a phone that went to sleep is noticed within about 12 seconds.
- **If the host's screen turns off or the app goes to the background.** Phones' browsers freeze background tabs and close their connection to the signaling server, so nobody can join until the host page is back. The game handles this as follows:
  - **Host.** When the page is visible again (or back online, or refocused), the host checks its signaling connection. It calls PeerJS `reconnect()`, or registers a new peer with the same room id if the old one was destroyed. If the server still holds the old registration, it keeps retrying for about 30 seconds before it shows an error. It also reconnects on its own after a Wi-Fi blip. The screen wake lock is requested again. The host screen shows a small **Connected / Reconnecting… / Offline** status, and the lobby says **Keep this screen open while players join**. While the host page is hidden, no player is marked offline because of the host's own frozen timers. When it comes back, everyone gets a grace period.
  - **Joining phones** don't give up when the host doesn't answer. They show **“Waiting for the host's screen to come back… ask the host to open the game”** and retry every few seconds for 3 minutes. The join completes by itself once the host is back. If the phone itself can't reach the signaling server, it says to check its own internet connection instead.
  - **Phones in the game** show **“Reconnecting to the host…”** (with a **Leave** button) and retry for as long as it takes, at most 10 seconds apart. They retry at once when their own tab becomes visible or comes back online. “The host closed the room” is only shown when the host really closes it.
  - **A phone's own tab** that comes back from the background asks the host for a fresh state (`sync`). If the connection died meanwhile, it reconnects and reclaims its slot.
- **Resuming a room (12 hours).** The host saves the whole room in `localStorage` under its code: settings, players with tokens and scores, used songs, the current turn, clip start, options, progress and the track list (so no playlist fetch is needed). It's also saved in `sessionStorage`, as before.
  - **Host reloads.** Reloading the host page reopens the room with the same code.
  - **Evicted tabs.** The host page's URL carries `?host=CODE`. If the browser reloads a tab it evicted (iOS does this), the room reopens by itself.
  - **Resume room.** If the host tab was closed, the setup screen offers **Resume room ABCD** for a room saved in the last 12 hours. It reopens the room with the same code and state, and phones that are still waiting (or that come back) reclaim their slots automatically with their tokens.
  - **Clearing it.** The saved room is removed when the game ends or the host closes the room on purpose (**Close the room** / back to setup), not on a reload. If a second tab resumes the room, the first tab steps aside.
  - **Players.** A player's phone remembers its room, name and token for 12 hours. Opening the join link, or just the site, rejoins by itself (with a **Not you? Join as someone else** link). After pressing **Leave**, the setup screen offers **Rejoin room ABCD** instead.
- **Errors** are shown instead of leaving a spinner: room not found, name already taken, game already started, host left, connection lost, and “Couldn't reach the PeerJS signaling server (0.peerjs.com)”.

**Limits.**

- **Keep the host's screen open**, with the game in the foreground. The game asks the browser to keep the screen awake where supported. A host that goes to sleep or to another app can't let new players in, and phones wait (see above) until it's back. Nothing is lost, but the game pauses. If the host tab is closed, use **Resume room** within 12 hours.
- **Audio autoplay:** phones start songs remotely, so the host browser must allow playback. Pressing **Start game** on the host unlocks audio. If the browser still blocks it (for example after a reload), the host screen asks for one tap on play, and the phones say so.
- **WebRTC can be blocked.** Corporate, school and some public Wi-Fi networks block peer-to-peer traffic or the signaling server. The TURN relay helps with strict NATs, but not with networks that block it outright. Joining then times out with an error. The simplest workaround is a phone hotspot.
- The public signaling server is shared and rate limited, and it's run by the PeerJS project, not by this game. If it's down, rooms can't be created or joined, but pass-the-phone still works.
- Up to 12 players per room.

**Same-device dev mode:** add `?transport=local` to the URL (for example `http://localhost:3000/?transport=local`) and open the host and the players in **tabs of the same browser**. Messages then go over a `BroadcastChannel` instead of PeerJS, with no network needed. Join links made in this mode keep the parameter. The automated tests use this mode, and it's handy for development.

## Example playlist

The **Use an example playlist** button fills in [Top 100 Greatest Songs of All Time](https://open.spotify.com/playlist/6i2Qd6OpeRBAzxfscNXeWp). Its track list is **bundled with the game** in `public/data/example-playlist.json`, so the example starts instantly, needs no backend or CORS proxy, and keeps working if the playlist on Spotify changes or is deleted. Pasting that playlist's link by hand uses the bundled copy too; every other link loads from Spotify as usual. If the bundled file can't be loaded, the game falls back to loading the playlist live.

The file is a **snapshot**: it holds each track's id, title, artist, 30-second preview URL and cover URL (all on Spotify's CDN), plus the date it was taken (`snapshotAt`). It doesn't follow later changes to the playlist. To refresh it:

```bash
npm run snapshot                                   # re-snapshot the example playlist
npm run snapshot -- https://open.spotify.com/playlist/<id>   # snapshot another playlist instead
```

The script (`scripts/snapshot-playlist.js`) uses the server's embed-page fetch, so it needs internet access; covers come from Spotify's oEmbed endpoint. It always writes `public/data/example-playlist.json`. If you snapshot a different playlist, also set `EXAMPLE_URL` in `public/config.js` to its link (the script reminds you); the game only uses the snapshot for the link it was taken from. Behind an HTTPS proxy, run it with `NODE_USE_ENV_PROXY=1` (Node 22.21+ or 24+). If a bundled song ever stops playing (Spotify can retire preview files), re-run the snapshot.

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
  config.js       API_BASE, the CORS proxy list for static mode, the example playlist
  data/
    example-playlist.json   bundled snapshot of the example playlist
  lib/
    spotify-url.js    link / URI parsing and validation (browser + server)
    embed-parser.js   __NEXT_DATA__ parser (browser + server)
    track-source.js   bundled example, backend detection, CORS-proxy fallback, cover lookup
    room.js           multiplayer rooms: protocol, host-side rules, player snapshots, host/player controllers
    transport.js      room networking: PeerTransport (PeerJS/WebRTC) and LocalTransport (BroadcastChannel)
  vendor/
    peerjs.min.js     PeerJS 1.5.5 (MIT, see LICENSE-peerjs.txt)
  game-logic.js   pure game rules (matching, options, turns, scoring), also used by tests
  app.js          UI controller (pass-the-phone, room host, room player), clip player, persistence
scripts/
  snapshot-playlist.js   `npm run snapshot`: saves a playlist to public/data/example-playlist.json
test/
  *.test.js       node:test suites (URL parsing, parser, track source, example snapshot, game logic, rooms, transport, HTTP API)
  fixtures/       captured embed pages (trimmed; session tokens removed)
render.yaml       Render Blueprint for the optional backend
.github/workflows/deploy.yml   GitHub Pages deployment
```
