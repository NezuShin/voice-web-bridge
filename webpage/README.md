# Browser voice page (prototype)

`voicechat.html` + `app.js` implement a minimal browser voice client for
Voice Bridge. The plugin sends each player a link after they join:

```
https://bla-bla.com/voicechat.html?id=<session-uuid>
```

The page connects to the plugin's embedded WebSocket server, asks for the
microphone permission on the first click (the prompt only reliably appears
inside a user gesture), then streams the mic continuously and plays back
nearby players' audio. Server messages (info/error) are displayed as the last
message.

Two selects let the user pick the input/output devices; changes apply
immediately (the capture pipeline restarts on the new microphone, the output
switches via `HTMLMediaElement.setSinkId`). A volume slider (0–200%, default
100%, remembered across reloads) controls the playback gain — useful for
matching the game client's loudness. Note: `setSinkId` is currently
Chromium-only; other browsers show a message instead.

## How it works

- **Encoding**: the page captures PCM from the selected microphone and feeds it
  to the vendored [opus-recorder](https://github.com/chris-rudmin/opus-recorder)
  v8.0.5 `encoderWorker` (classic Worker protocol, MIT license). The worker
  resamples to 48 kHz and emits Ogg pages with 20 ms mono Opus frames
  (`maxFramesPerPage: 1`); `app.js` strips the container and sends bare frames.
- **Decoding**: one `decoderWorker` instance per speaking player. Since the
  worker expects Ogg pages, `app.js` re-wraps each incoming bare frame into a
  minimal Ogg page (with a fake OpusHead header page per stream) and plays the
  decoded PCM through a `MediaStreamAudioDestinationNode` bound to the output
  `<audio>` element, which carries the speaker selection.
- **Transport**: WebSocket proxied by Nginx (`/voice-ws`).

## Wire protocol

| Direction | Message | Meaning |
|---|---|---|
| client → server | binary, raw Opus frame | one 20 ms frame (max 1500 bytes) |
| server → client | binary `[0x02][16-byte speaker uuid][opus]` | audio from one in-game player |
| server → client | `{"type":"info","message":"..."}` | displayed as last message |
| server → client | `{"type":"error","message":"..."}` | displayed, then the server closes |
| server → client | close code 4001 | this page was replaced by a newer one |
| server → client | close code 4004 | session not found / bad id |

Reloading the page is safe: the session belongs to the player's game session
(created on join, removed on quit), so the old connection is closed with a
"New page opened" message and the new one takes over.

## Running in development (no Nginx)

1. Start the dev server (`./gradlew runDevBundleServer`) and join it.
   Copy the link from the chat message.
2. Serve this folder on localhost, e.g. `python -m http.server 8080`, and open
   `http://localhost:8080/voicechat.html?id=<uuid>`. (Do not open via `file://`:
   browsers block loading the encoder/decoder workers from local files.)
3. Because the page is served from localhost and the plugin binds
   `127.0.0.1:8090`, the page's WS endpoint `/voice-ws` points to the static
   server — add the Nginx proxy from `nginx.conf.example` locally, or open the
   page through Nginx directly.

Notes:
- The mic needs a secure context (`https://` or `localhost`) — otherwise
  `getUserMedia` does not exist and the browser never shows a permission
  prompt. The page says so explicitly and keeps playback working.
- The microphone permission is requested from the first click on the page
  (never on load): browsers reliably show the prompt inside a user gesture.
  Click once → allow the microphone → it streams until the page is closed.
- iOS Safari is untested; `opus-recorder`'s encoder supports it, playback may
  not work (per upstream README).

## Production (Nginx)

See `nginx.conf.example` — it serves this directory and proxies `/voice-ws`
to the plugin with TLS termination.

## Audio-path regression test

`.test/verify.js` runs the page's exact audio logic (Ogg page wrapping and
demuxing from `app.js`) against the real vendored encoder/decoder WASM in
Node: a 440 Hz sine is encoded, extracted, re-wrapped and decoded, then
checked for amplitude and frequency. Both the native Ogg path and the page's
synthetic pages must report `ratio ≈ 1.000` and `freq ≈ 440.00`.

```
node .test/verify.js
```
