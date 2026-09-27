# Guess the Song

Play it live: **https://michaelphagen.github.io/spotify-guessing-game/**

A pass-the-phone party game. Paste a Spotify playlist (or album or track) link. Each player in turn hears the **first 5 seconds** of a song and guesses what it is. If they're stuck, they can play the **next 10 seconds** (seconds 5 to 15), but a correct answer is then worth fewer points. Both lengths can be changed per game (see **Clip length** below).

- **Answer modes:** multiple choice (4 options drawn from the same playlist) or free answer (typed, fuzzy matched).
- **Scoring:** 10 points for a correct answer after the first clip, 5 points after the extra time, and 0 for a wrong or revealed answer. The points don't depend on the clip lengths; with no extra time there is only the 10-point answer.
- **Players:** 1 to 12. Turns rotate, and the scoreboard is always visible.
- **Rounds:** 1, 3, 5 or 10 (each round gives every player one song), or play until the songs run out.
- **Clip start:** from the beginning (default), or a random spot each song so the intro alone isn't always the giveaway.
- **Clip length:** **First clip** 1, 2, 3, 5 (default), 7, 10, 15 or 20 seconds, and **Extra time** none, 5, 10 (default), 15, 20 or 30 seconds. The progress bar, the “Play next … seconds” button, the status texts and the rules follow the chosen lengths; with **Extra time: None** there is no extend button. The lengths are remembered with the other settings (`gts:setup`), kept by “Play again”, saved with the game (a reload mid-round keeps them) and, in a room, set by the host and sent to the phones.
  - **Previews are 30 seconds long**, so with previews the whole clip (first clip + extra time) has to fit in 30 s. If it doesn't, the extra time is shortened to fit (first 20 s + extra 20 s plays as 20 s + 10 s) and a note says so on the setup screen and at the start of the game. The first clip is never shortened, unless a preview is itself shorter than it (it then plays to the preview's end). “Random spot” with previews picks a whole second between 0 and 30 s minus the whole clip (0 to 15 s for 5 + 10 s; always 0 for a 30-second clip).
  - **Full songs** (Spotify) keep the lengths as chosen; “random spot” picks a start between 0 and the song's length minus the whole clip minus 5 s.
- **Sound:** 30-second previews (default, no sign-in), or **full songs via Spotify** so "from the beginning" really is the start of the song (host signs in with Spotify; Premium needed to play). In rooms the clip plays on **every player's phone** in sync (or on the host device only, if chosen). See [Full songs with Spotify](#full-songs-with-spotify) and [Sound on every device](#sound-on-every-device).
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

**Host (the “TV”).** Pick the playlist, answer mode, rounds and clip start as usual and press **Host a room**. The lobby shows a 4-letter room code (letters only, no I, L or O), a join link and a **Copy link** button, and lists players as they join. You can also add players who have no phone; they play on the host device when it's their turn. Under **Sound → Sound plays on** the host picks **Every player's device** (default: every phone plays the clip in sync, and the host device too) or **Host device only** (only the host device plays, as in earlier versions). Press **Start game** once at least one player is in. The host device shows the round, the answer and the scoreboard; the room code stays in the header. During any turn the host can press play, stop, “play next … seconds”, **Skip** (0 points) or **Next** itself, which helps when a phone is unresponsive.

**Players.** Open the join link, or the site and then **Join a room**, and enter the code and your name. The phone shows a lobby, then the live scoreboard and “It's Alice's turn” while others play. On your own turn it shows a **Play** button, the answer options or text box, “Play next … seconds” (with the game's extra time; not shown when there is none) once the first clip has finished, and **Reveal**, followed by the result. With **Every player's device** the clip plays on every phone (the one whose turn it is and the waiting ones), in sync, so remote players can take part too; each phone's progress bar follows its own player. With **Host device only** the song plays on the host device and its progress is mirrored on every phone.

**Join link format:** `https://michaelphagen.github.io/spotify-guessing-game/?room=ABCD`, which is `<site url>?room=<CODE>`. The code is case-insensitive.

**How it works.**

- **Host-authoritative, peer to peer.** The host keeps the whole game (players, scores, the song queue) and checks every action (`play`, `stop`, `extend`, `answer`, `reveal`, `next`) against whose turn it is. Players only send actions and get back a snapshot made for them. A snapshot never holds the current song's title, artist, cover, preview URL or URI until the turn is resolved (the preview URL goes out only in the `preload`/`play` messages of [Sound on every device](#sound-on-every-device)). Multiple-choice options (four titles, with nothing marking the right one) go only to the player whose turn it is. The host also picks the random clip start and the options, and its clip lengths are authoritative: every snapshot carries `clip: { firstMs, extendMs }` (as the game plays them, i.e. fitted to previews), which phones use for their labels and progress bar. The protocol and rules are in `public/lib/room.js` (pure, unit-tested); scoring, turns, options and answer matching reuse `public/game-logic.js`.
- **Networking.** WebRTC data channels via [PeerJS](https://peerjs.com) **1.5.5** (vendored in `public/vendor/peerjs.min.js`, MIT license in `public/vendor/LICENSE-peerjs.txt`). PeerJS's **free public signaling server** (`0.peerjs.com`) introduces the devices to each other; it needs no account or key and is best-effort (no uptime guarantee). The host registers the peer id `gts-room-<CODE>` and phones connect to it. After that, game messages go directly between the devices, or through a **TURN relay** when no direct path works (see [TURN relays](#turn-relays-when-a-phone-cant-join)). To use your own PeerServer or TURN servers, set `PEERJS` in `public/config.js`. The transport is behind a small interface in `public/lib/transport.js` (`host`, `connect`, `send`, `onMessage`, `onPeerJoin`/`onPeerLeave`).
- **Messages** are JSON objects with a protocol version `v`. Player to host: `hello {name, token, clockOffset?, rtt?, spotifyReady?}`, `play`, `stop`, `extend`, `answer {optionId | text}`, `reveal`, `next`, `sync {clockOffset?, rtt?, spotifyReady?}` (send me the current state again, used when a phone comes back from the background; also how a phone reports its clock offset and whether it can play full songs) and `ping {t0}` (clock sync). Host to player: `state {state}` (the player's snapshot), `playback {playback}` (the host player's clip status and position, a few times a second while playing), `pong {t0, ht}`, `error {code, message}`, and with sound on every device `preload`, `play` and `halt` (see below).
- **Dropped connections.** A player who disconnects keeps their score and shows as offline. If it's their turn, the host can wait or skip them. Rejoining with the same name reclaims the slot, and so does the same phone, which keeps a player token in `localStorage`. New players can't join once the game has started. Both sides send keep-alives, so a phone that went to sleep is noticed within about 12 seconds.
- **If the host's screen turns off or the app goes to the background.** Phones' browsers freeze background tabs and close their connection to the signaling server, so nobody can join until the host page is back. The game handles this as follows:
  - **Host.** When the page is visible again (or back online, or refocused), the host checks its signaling connection. It calls PeerJS `reconnect()`, or registers a new peer with the same room id if the old one was destroyed. If the server still holds the old registration, it keeps retrying for about 30 seconds before it shows an error. It also reconnects on its own after a Wi-Fi blip. The screen wake lock is requested again. The host screen shows a small **Connected / Reconnecting… / Offline** status, and the lobby says **Keep this screen open while players join**. While the host page is hidden, no player is marked offline because of the host's own frozen timers. When it comes back, everyone gets a grace period.
  - **Joining phones** don't give up when the host doesn't answer. They show **“Waiting for the host's screen to come back… ask the host to open the game”** and retry every few seconds for 3 minutes. The join completes by itself once the host is back. If the phone itself can't reach the signaling server, it says to check its own internet connection instead.
  - **Phones in the game** show **“Reconnecting to the host…”** (with a **Leave** button) and retry for as long as it takes, at most 10 seconds apart. They retry at once when their own tab becomes visible or comes back online. “The host closed the room” is only shown when the host really closes it.
  - **A phone's own tab** that comes back from the background asks the host for a fresh state (`sync`). If the connection died meanwhile, it reconnects and reclaims its slot.
- **Resuming a room (12 hours).** The host saves the whole room in `localStorage` under its code: settings (including the clip lengths; a room saved before they existed resumes with 5 + 10 s), players with tokens and scores, used songs, the current turn, clip start, options, progress and the track list (so no playlist fetch is needed). It's also saved in `sessionStorage`, as before.
  - **Host reloads.** Reloading the host page reopens the room with the same code.
  - **Evicted tabs.** The host page's URL carries `?host=CODE`. If the browser reloads a tab it evicted (iOS does this), the room reopens by itself.
  - **Resume room.** If the host tab was closed, the setup screen offers **Resume room ABCD** for a room saved in the last 12 hours. It reopens the room with the same code and state, and phones that are still waiting (or that come back) reclaim their slots automatically with their tokens.
  - **Clearing it.** The saved room is removed when the game ends or the host closes the room on purpose (**Close the room** / back to setup), not on a reload. If a second tab resumes the room, the first tab steps aside.
  - **Players.** A player's phone remembers its room, name and token for 12 hours. Opening the join link, or just the site, rejoins by itself (with a **Not you? Join as someone else** link). After pressing **Leave**, the setup screen offers **Rejoin room ABCD** instead.
- **Errors** are shown instead of leaving a spinner: room not found, name already taken, game already started, host left, connection lost, “Couldn't reach the PeerJS signaling server (0.peerjs.com)”, and **“Couldn't connect to the host's device”** when the host answered but no network path between the two devices worked (`ice-failed`, see below). A host whose room isn't registered with the signaling server after 10 seconds shows **Offline** and “Still can't reach the signaling server… players can't join yet” (it keeps retrying).

**Limits.**

- **Keep the host's screen open**, with the game in the foreground. The game asks the browser to keep the screen awake where supported. A host that goes to sleep or to another app can't let new players in, and phones wait (see above) until it's back. Nothing is lost, but the game pauses. If the host tab is closed, use **Resume room** within 12 hours.
- **Audio autoplay:** clips are started by a message from another device, not by a tap on the device that plays them, and mobile browsers only allow that after a tap on the page. Pressing **Start game** on the host, and **Join** (or any tap) on a phone, unlocks audio. If a browser still blocks it (for example after a reload that rejoined by itself), the phone shows **Tap to enable sound** and, once tapped, joins the clip at the position the others are at (with sound on every device the host screen does the same, and the game goes on meanwhile). With **Host device only**, a blocked host screen asks for one tap on play, and the phones say so.
- **WebRTC can be blocked.** Corporate, school and some public Wi-Fi networks block peer-to-peer traffic, the signaling server or TURN. The TURN relays help with strict NATs and Wi-Fi client isolation, but not with networks that block them outright. Joining then shows “Couldn't connect to the host's device” (and keeps trying). The simplest workaround is a phone hotspot.
- The public signaling server is shared and rate limited, and it's run by the PeerJS project, not by this game. If it's down, rooms can't be created or joined, but pass-the-phone still works.
- Up to 12 players per room.

### Sound on every device

With **Sound plays on: Every player's device** (the default; stored with the room settings, in snapshots as `settings.soundOn`, and in saved rooms) every device plays the clip itself:

- **Preload.** When a turn starts, the host sends every phone `preload {engine, previewUrl}`: the song's 30-second preview URL (a hash on Spotify's CDN; it doesn't reveal the song), so the phone can load it before Play is tapped. Never the title, artist, cover or URI.
- **Play.** When the current player taps Play (or “Play next …”), the host checks it as before and sends every phone `play {seq, engine, startMs, endMs, from, to, startAt, offset, previewUrl | uri}`: the segment in ms of the audio file (the random offset included, the same for everyone) and `startAt`, a moment ahead on the host's clock (400 ms, or the slowest phone's round trip + 250 ms; 900 ms for full songs). The host plays it too. Each device plays the segment with its own player (one `<audio>` element per device) and stops at the segment's end by itself; its progress bar follows its own player. **Stop**, an answer or the next turn sends `halt`. The host stays authoritative for scoring and turns and keeps sending `playback` for phones that can't play.
- **Clock sync.** On joining (and every 30 s, and when the page comes back from the background) a phone sends five `ping`s; from the `pong`s with the shortest round trips it estimates its offset to the host's clock (`host ≈ local + offset`) and reports it with `sync`. A phone converts `startAt` to its own clock with that offset. The clock is `performance.timeOrigin + performance.now()`, so it doesn't jump when the system clock is adjusted.
- **Staying in sync.** A device that is late (the message was slow, the preview was still loading, the tap to enable sound came later) starts at the position the others have reached; one past the segment's end skips it. While playing, previews correct drift: up to 250 ms by playing 6% faster or slower, beyond that by seeking. Measured in Chromium with the host and three phones (same machine, `?transport=local`): the phones' `currentTime` stayed within **75 ms** of the host's (95th percentile; 100 ms worst case, typically 1–3 ms median), and every device paused within **20 ms** of the host, at the clip's end position ±20 ms, and a phone that enabled sound 2.5 s into a 10 s clip joined at the others' position and stopped with them. Across real phones expect about **±150 ms** (clock sync error plus each phone's audio output latency). Full songs via Spotify start when the Spotify device does (200–600 ms per request with Spotify Connect), so they're only in sync to about ±0.3 s.
- **Full songs (Spotify).** A phone can play full songs only with its own Spotify Premium sign-in: in a room with full songs a phone shows **Sign in with Spotify to hear full songs on this phone** (same Client ID and sign-in as the host; the phone's Spotify app, or this browser where supported, is picked under the device menu shown there). Once signed in with a device the phone reports `spotifyReady: true`, and only then does its `play` carry the song's `uri` (plus its length). A signed-in player could read that URI in the browser's developer tools before answering; that's accepted (they could also just look at the song on their own Spotify device). Phones that aren't signed in get `play` without a URI and show “Sound is playing on the host's device (sign in with Spotify to hear it here)”, with the host's progress, as before. If the phone's Spotify says Premium is needed, it falls back to the host's device. Note: a Spotify account plays on one device at a time, so players should sign in with their **own** account. A player signed in with the **same** account as the host moves each clip to the phone's device (the host's device goes quiet), and with the same device too, both send the play command to that one device. The game doesn't detect this.
- So: with previews every phone hears the clip; with full songs only phones signed in to Spotify do (the others hear the host's device, which should then be audible to them).
- **Host device only** is exactly the earlier behaviour: no `preload`/`play`/`halt`, only the host device plays.

### TURN relays (when a phone can't join)

A phone joins in two steps: the signaling server (`0.peerjs.com`) introduces it to the host, then WebRTC has to find a network path between the two devices (ICE). On many networks a direct path doesn't exist: mobile data behind carrier-grade or symmetric NAT, Wi-Fi with **client isolation** (guest networks, many mesh and public networks: phones on the same Wi-Fi can't reach each other), or local addresses hidden behind mDNS names that the other phone can't resolve. STUN alone (PeerJS's default) doesn't help there; a **TURN relay** does, by relaying the (encrypted) traffic.

- `PEERJS.iceServers` in `public/config.js` lists Google's STUN server and the free **Open Relay** TURN servers of metered.ca (https://www.metered.ca/tools/openrelay/): `turn:staticauth.openrelay.metered.ca:80` (UDP and TCP) and `:443?transport=tcp` with the shared secret that the project publishes for this use (the game makes time-limited TURN credentials from it, the "TURN REST API" scheme, see `resolveIceServers` in `transport.js`), plus the older public `openrelay.metered.ca` servers with the `openrelayproject` username and password. (In September 2026 the Open Relay page lists the static-auth secret and a free API-key signup, but no longer the `openrelayproject` password; it's kept as a fallback.) They're passed to every `new Peer(id, { config: { iceServers, iceTransportPolicy: 'all' } })`, host and phones.
- These relays are **free and best-effort** (a shared monthly allowance, no uptime guarantee). For dependable games, create your own TURN credentials (for example a free metered.ca account, or your own coturn server) and put them first in `PEERJS.iceServers` as `{ urls: [...], username, credential }`.
- **Detecting it.** When the host answered but ICE failed (state `failed`, `disconnected` for 4 s, or still checking at the 15 s timeout), the join fails with `ice-failed` instead of “room not found” or a timeout, and the phone shows **“Couldn't connect to the host's device: Couldn't open a direct connection between the phones. Try again; if it keeps failing, put both phones on the same Wi-Fi or ask the host to share a hotspot.”** It keeps retrying at the same pace, and the next attempt uses TURN relays only (`iceTransportPolicy: 'relay'`), alternating with a normal attempt after that. The host gets a toast when a phone's connection fails this way.
- `?ice=relay` forces relay-only on a page (to test a TURN server); `?debug=1` … `?debug=3` sets PeerJS's log level (console) and opens the connection details.

### Connection details

The join, lobby, host and player screens have a small collapsible **Connection details** panel (refreshed every second while open) with a **Copy details** button, for troubleshooting: transport (`peer` or `local`), signaling status and server, this device's peer id and the host's, the last error (code and message), the data channel state, the ICE connection state and the **selected candidate pair** (`host`, `srflx` or `relay` on each side, from `getStats()`), whether TURN is configured and the ICE policy, retries and ICE failures, timestamps (joined, last attempt, connected / room opened), and the phone's clock offset. On the host it lists every phone (data channel, ICE state, path, clock offset). A path of `relay ↔ …` means a TURN relay is carrying the game.

**Same-device dev mode:** add `?transport=local` to the URL (for example `http://localhost:3000/?transport=local`) and open the host and the players in **tabs of the same browser**. Messages then go over a `BroadcastChannel` instead of PeerJS, with no network needed. Join links made in this mode keep the parameter. The automated tests use this mode, and it's handy for development.

## Full songs with Spotify

**Why.** Without an account the game plays Spotify's 30-second **previews**. A preview is a snippet Spotify picks, usually the chorus, so "from the beginning" means the beginning of the *preview*, which is mid-song. With **Sound → Full songs via Spotify**, the host signs in with Spotify and the game plays the real songs through Spotify Connect: "from the beginning" is 0:00 of the song, and "random spot" can be anywhere in it. Previews stay the default and need no sign-in.

**What you need.** A Spotify account with **Premium** for the host (Spotify only allows playback control and in-browser playback for Premium accounts), and a Spotify app of your own for the Client ID. Players don't need anything; with sound on every device, players who want to hear full songs on their own phone sign in with their own Premium account (see [Sound on every device](#sound-on-every-device)), and add them to the app's user list (step 5).

### One-time setup: create a Spotify app

The live site is already set up with the owner's app; these steps are for the owner (to add users), for forks, and for hosts who want their own app.


1. Open **https://developer.spotify.com/dashboard**, log in, and choose **Create app**.
2. Give it any name and description. Under **Redirect URIs** add exactly:
   - `https://michaelphagen.github.io/spotify-guessing-game/` (the live site; use your own Pages URL for a fork), and
   - `http://127.0.0.1:3000/` for local development (`npm start`). Spotify no longer accepts `http://localhost` redirect URIs; open the game at `http://127.0.0.1:3000/` rather than `localhost` when you want to sign in locally.
   Under **Which API/SDKs are you planning to use?** tick **Web API** and **Web Playback SDK**. Save.
3. Copy the app's **Client ID** (32 characters; the client secret is *not* needed and must not be put in the site).
4. Put it in `SPOTIFY_CLIENT_ID` in `public/config.js`. **The live site already has one** (`a010d85057d64fdfabe0fb42155cacba`, the site owner's app), so on https://michaelphagen.github.io/spotify-guessing-game/ you can just press **Sign in with Spotify**. A host who wants to use their own app instead (for example because the site's app is limited to the users on its list, see step 5) opens **Use a different Spotify app** on the setup screen and pastes their Client ID; it overrides the default in that browser only (`localStorage`) until **Use this site's app instead**. With `SPOTIFY_CLIENT_ID: ''` the field is always shown.
5. **Development Mode user list.** New Spotify apps are in Development Mode: only the app's owner and the users added under **User Management** in the dashboard can sign in (up to **5** users for apps created or migrated since February 2026; older apps may still show 25). Only the host signs in, so add the Spotify account(s) of whoever hosts. Since February 2026 Spotify also requires the owner of a Development Mode app to have Premium.

### Playing

- **Sign in.** On the setup screen pick **Sound → Full songs via Spotify** and press **Sign in with Spotify**. Spotify asks you to allow the app, then sends you back to the game. Sign-in uses the Authorization Code flow with PKCE entirely in the browser (no backend, no client secret), so it works on GitHub Pages. Scopes: `streaming user-read-email user-read-private user-modify-playback-state user-read-playback-state playlist-read-private playlist-read-collaborative`. The redirect URI is the page's own address (origin + path, so the `/spotify-guessing-game/` sub-path works). Room parameters (`?room=`, `?host=`, `?api=`, `?transport=`) travel through the OAuth `state` and are restored afterwards, so signing in again in the middle of a hosted game returns to the same room.
- **Pick a device** under **Play on**. The list comes from Spotify Connect (`GET /me/player/devices`): the Spotify app on your phone or computer, speakers, TVs, and **Guess the Song (this browser)**, which is this page itself (registered with Spotify's Web Playback SDK, loaded only after sign-in). If your phone or speaker isn't listed, open Spotify on it and press **Refresh**. **Test sound** plays a second and a half of music on the chosen device. The choice is remembered, and during a game the round screen has a **Plays on** menu for switching devices.
- **Songs.** With full songs the track list comes from the Spotify Web API: every song of an album, and every song of a playlist **you own or collaborate on** (paged 50 at a time, so the ~100-song cap of the embed page doesn't apply). Spotify's February 2026 rules only let Development Mode apps read the contents of the signed-in user's own playlists; for any other playlist (including the example) the game uses the public embed page as before (up to ~100 songs) and plays those songs in full. Local files and songs that aren't playable in your country are skipped. Tip: to play someone else's big playlist in full, add it to a playlist of your own in Spotify.
- **Playback and timing.** Each clip is `PUT /me/player/play?device_id=…` with the song's URI and `position_ms` (0 for "from the beginning", the clip's random start otherwise), and a pause at start + the first clip (5 s by default; or, for the extra time, play at start + 5 s and pause at start + 15 s, following the chosen clip lengths). The pause is scheduled from the moment the play request resolves, minus half the play request's round trip (the pause request's own travel time), and the device's position is read back once about 1.2 s in (`GET /me/player`) to correct for a device that starts late. After pausing, the real position is read back and shown. With a phone, computer or speaker (Spotify Connect over the internet, 200–600 ms per request), expect clips to end within about **±0.25 s** of the mark, more on a slow connection. With **this browser** as the device the SDK's local player state is polled every 100 ms and the local pause takes effect in about 50 ms, so clips end within about **±0.1 s**.
- **Random spot** with full songs picks a whole second between 0 and the song's length minus the whole clip minus 5 s (length − 20 s for the default 5 + 10 s clip), so it never runs past the end. It's chosen by the host, once per song.
- **Result screen:** **Play the song** plays it from the start (with **Pause**); **Open in Spotify** is still there.
- **Rooms:** the sound setting (previews / full songs) and the host's device are the host's. With **Host device only**, or for phones that aren't signed in, the host's device plays and phones see the clip's progress. Phones signed in to Spotify play the clip on their own device (see [Sound on every device](#sound-on-every-device)); only they get the song's URI, in the `play` message. Room snapshots never contain the current song's URI or title before the turn is resolved (the URI would reveal the track id). The saved room (for **Resume room**) remembers the sound setting, where the sound plays and the device.

### When something goes wrong

- **"Full-song playback needs Spotify Premium"** (Spotify answers 403): the game switches to previews, looks up the previews of the loaded songs (songs without one are taken out) and carries on.
- **"No active Spotify device"** (404): open Spotify on the chosen device, or pick another one under **Plays on**, and tap play again.
- **Expired sign-in:** access tokens are refreshed automatically with the refresh token (and a 401 is retried once with a fresh token). If the refresh fails, a banner offers **Sign in again**; the game is saved and continues where it was.
- **Rate limits** (429): requests wait for `Retry-After` (up to 30 s) and are retried.
- **iOS Safari** (and some other mobile browsers) can't run the Web Playback SDK, so "this browser" isn't offered there. Pick the phone's own Spotify app (or any other device) instead; the game then controls it over Spotify Connect. Headless and DRM-less browsers can't use the in-browser player either.

**Privacy.** Tokens (access and refresh) and the Client ID are stored only in this browser's `localStorage` (`gts:sp:*` keys) and are sent only to Spotify (`accounts.spotify.com`, `api.spotify.com`, and the Web Playback SDK from `sdk.scdn.co`). **Sign out** removes them. There's no server of ours involved, and other devices never receive them (a player who signs in on their phone has their own tokens in their own browser).

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

This section describes the default **Previews** sound, which needs no Spotify account, API keys or OAuth. For full songs, see [Full songs with Spotify](#full-songs-with-spotify).

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
5. The browser plays the preview MP3 directly from Spotify's CDN in an HTML5 `Audio` element. The CDN sends `Access-Control-Allow-Origin: *` over HTTPS, so no audio proxy is needed. Playback stops at exactly the end of the clip (5.0 s, or 15.0 s after the extension, with the default lengths). Stopping uses three mechanisms: a `requestAnimationFrame` position check, the `timeupdate` event, and a `setTimeout` safety net that re-checks the media clock.
6. On the result screen, playlist tracks get their cover art from `GET api/cover?id=<trackId>`. This endpoint wraps Spotify's public oEmbed endpoint, and the lookup only happens after the answer has been given. Album and track links already include the cover.

The answer (title, artist, cover) is never written into the page before a guess is made. In multiple-choice mode, the option buttons show titles but nothing marks which one is correct. The preview URL is visible in the browser's network tab, but it doesn't reveal the song.

## Limitations

- **Track cap:** the embed page returns at most about **100 tracks** for a playlist (with full songs via Spotify, your own playlists aren't capped). For example, a 150-song playlist yields its first 100. Larger playlists therefore only use their first ~100 songs.
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
  config.js       API_BASE, the CORS proxy list for static mode, the example playlist, PEERJS (signaling server, STUN/TURN servers), SPOTIFY_CLIENT_ID
  data/
    example-playlist.json   bundled snapshot of the example playlist
  lib/
    spotify-url.js    link / URI parsing and validation (browser + server)
    embed-parser.js   __NEXT_DATA__ parser (browser + server)
    track-source.js   bundled example, backend detection, CORS-proxy fallback, cover lookup
    room.js           multiplayer rooms: protocol, host-side rules, player snapshots, clock sync and play messages, host/player controllers
    transport.js      room networking: PeerTransport (PeerJS/WebRTC, ICE/TURN config, ICE-failure detection, diagnostics) and LocalTransport (BroadcastChannel)
    spotify-auth.js   Spotify sign-in: PKCE, redirect handling, token storage and refresh
    spotify-api.js    Spotify Web API: track lists (paged), player endpoints, retry/refresh and error mapping
    spotify-player.js Spotify Connect: device list, Web Playback SDK device, play/pause/position
    clip-engine.js    one clip-player interface for previews (<audio>) and full songs (Spotify), segment timing
  vendor/
    peerjs.min.js     PeerJS 1.5.5 (MIT, see LICENSE-peerjs.txt)
  game-logic.js   pure game rules (matching, options, turns, scoring), also used by tests
  app.js          UI controller (pass-the-phone, room host, room player), sound setting, persistence
scripts/
  snapshot-playlist.js   `npm run snapshot`: saves a playlist to public/data/example-playlist.json
test/
  *.test.js       node:test suites (URL parsing, parser, track source, example snapshot, game logic, rooms, transport, ICE/TURN, sound sync, HTTP API, Spotify sign-in, Web API, clip engines)
  fixtures/       captured embed pages (trimmed; session tokens removed)
render.yaml       Render Blueprint for the optional backend
.github/workflows/deploy.yml   GitHub Pages deployment
```
