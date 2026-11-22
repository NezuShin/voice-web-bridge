# Browser voice page

`voicechat.html` + `styles.css` + `app.js` implement a Simple Voice Chat-styled
browser voice client for Voice Web Bridge using the vendored
[Pixelify Sans](https://github.com/eifetx/Pixelify-Sans) font (SIL OFL 1.1,
`lib/PixelifySans.ttf`). The plugin sends each player a link after they join:

```
https://bla-bla.com/voicechat.html?id=<session-uuid>
```

The page connects to the plugin's embedded WebSocket server, prompts for
microphone permission on user interaction (Enable Microphone or Mic On/Off),
streams microphone audio, and plays back nearby players' audio with per-speaker
volume/mute controls. Server messages (info/error) are displayed in the footer
status bar and the connection event log.

## Features

- **Simple Voice Chat GUI**: Pixel-art Minecraft GUI styling using
  `lib/PixelifySans.ttf`, live input level meter, local mic loopback test, and
  optional 8-bit UI sound cues.
- **Server Players List & Per-Player Volume Controls**:
  - Live list of online players on the server with voice mod badges
    (`[SVC]`, `[PV]`, `[SVC+PV]`, `[WEB]`, `[NO VOICE]`), search box, filters
    (`All`, `Voice Only`, `Speaking`), live speaking highlight, per-player
    volume sliders (0–200%), quick 100% reset, and per-player mute.
- **Voice Activation & In-Game Minecraft Mic On/Off Keybind**:
  - **Voice Activation**: Open Mic or configurable dB threshold + holdover
    delay, configurable on-screen Mic On/Off button visibility, and Mic Off
    hardware behavior (Soft Mute, Disable Track, or Release Mic).
  - **In-Game Minecraft Keybind for Mic On/Off** (zero client mods, synced
    live via the server): choose from `Double Shift`, `Double Ctrl`,
    `Shift+F` (cancels item swaps), or `Shift+Q` (cancels item drops while
    holding an item), plus the `/mic` in-game chat command.
- **Configurable Microphone State Overlay**:
  - Floating HUD showing live mic state (`SPEAKING`, `MIC ON`, `MIC READY`,
    `MIC OFF`, `DEAFENED`, `OFFLINE`) with configurable layout (`Icon Only`,
    `Mic State Badge`, `Full HUD`), themes, scale, opacity, and quick Mic
    On/Off button.
  - **Pop Out** launches an always-on-top Document Picture-in-Picture overlay
    window in Chromium browsers; `?id=<uuid>&overlay=1&transparent=1` is
    supported for OBS Browser Source.
- **Audio Devices & Gains**: Input/output device selection (`setSinkId` on
  Chromium browsers), output volume (0–200%), microphone gain (0–200%), and
  echo cancellation / noise suppression / auto gain toggles. All preferences
  persist in `localStorage`.

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
| client → server | `{"type":"config","ingameTrigger":"..."}` | sets in-game Mic On/Off keybind (`off`, `double_shift`, `double_ctrl`, `shift_f`, `shift_q`) |
| client → server | `{"type":"mic_state","muted":true\|false,"notify":true\|false}` | reports current mic mute state so the server can show action-bar feedback |
| client → server | `{"type":"request_players"}` | requests fresh online server player list |
| server → client | binary `[0x02][16-byte speaker uuid][opus]` | audio from one in-game player |
| server → client | `{"type":"info","message":"..."}` | displayed as last message |
| server → client | `{"type":"error","message":"..."}` | displayed, then the server closes |
| server → client | `{"type":"welcome","playerUuid":"...","playerName":"...","capabilities":[...]}` | session identity & server features (`players`, `ingame_mic`) |
| server → client | `{"type":"players","players":[...]}` | online server players with mod/web voice status |
| server → client | `{"type":"control","action":"mic_toggle"}` | in-game Minecraft Mic On/Off keybind or `/mic` command |
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

## Licenses & Corresponding Source

- The browser page (`voicechat.html`, `styles.css`, `app.js`) is part of this
  project and licensed under **GPLv3** (see [`../LICENSE`](../LICENSE) and
  [`../LICENSE-EXCEPTION`](../LICENSE-EXCEPTION)).
- `lib/encoderWorker.min.js`, `lib/decoderWorker.min.js`, and
  `lib/decoderWorker.min.wasm` are vendored from
  [opus-recorder v8.0.5](https://github.com/chris-rudmin/opus-recorder/tree/v8.0.5)
  (commit `fdfdadeeb9bc9d045c59dc75ebefed390e4ad6dc`) under MIT / BSD-3-Clause
  (see [`lib/opus-recorder-LICENSE.md`](lib/opus-recorder-LICENSE.md)). Per
  GPLv3 Section 6, when distributing packaged releases containing these
  prebuilt binaries, provide the `opus-recorder` v8.0.5 source archive
  alongside the release (see [`../THIRD_PARTY_LICENSES.md`](../THIRD_PARTY_LICENSES.md)).
- `lib/PixelifySans.ttf` is licensed exclusively under the **SIL Open Font
  License 1.1** (see [`lib/PixelifySans-LICENSE.txt`](lib/PixelifySans-LICENSE.txt)).
