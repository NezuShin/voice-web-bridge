# Voice Web Bridge

**Proximity voice chat for everyone on your Minecraft server.**

Voice Web Bridge is a server-side [Paper](https://papermc.io/) / Folia plugin that unites
[Simple Voice Chat](https://modrinth.com/plugin/simple-voice-chat),
[Plasmo Voice](https://modrinth.com/plugin/plasmo-voice), and a built-in **browser voice client** —
so players using different voice mods *and* players with no client mods at all (vanilla Java, Bedrock via Geyser, or anyone who cannot install mods) can all talk together in proximity voice chat.

## Highlights

- **Voice chat for everyone:** Players with Simple Voice Chat, players with Plasmo Voice, and unmodded players in any modern web browser can hear and speak to each other seamlessly.
- **Zero client mods needed for web users:** Players automatically receive a personal clickable link in chat after joining — open it in a browser, allow the microphone, and talk.
- **Low-latency Opus passthrough:** Simple Voice Chat, Plasmo Voice, and the browser client all use 48 kHz mono 20 ms Opus frames. Frames are relayed directly without transcoding, with optional frame re-pacing for smooth playback.
- **Full-featured browser voice GUI:** Minecraft-styled web interface with voice activation / open mic, input/output device selection, mic & output gain (0–200%), live server player list with voice badges (`[SVC]`, `[PV]`, `[SVC+PV]`, `[WEB]`, `[NO VOICE]`), and per-player volume/mute controls.
- **In-game Minecraft mic keybinds (no client mod):** Web users can toggle their microphone directly from Minecraft using `Double Shift`, `Double Ctrl`, `Shift+F`, `Shift+Q`, or `/mic` (`/vmic`), with live action-bar feedback.
- **Overlay & OBS support:** Configurable floating microphone HUD with always-on-top Document Picture-in-Picture pop-out (Chromium) and transparent OBS Browser Source mode.

## How it works

All three endpoints — Simple Voice Chat (SVC), Plasmo Voice (PV), and the vendored WebAssembly Opus browser client — encode audio as 48 kHz, mono, 20 ms Opus frames. Voice Web Bridge intercepts audio packets from each source and forwards raw Opus frames to nearby listeners without re-encoding.

```
SVC Player     ◄──► SVC API          ◄──┐
                                        ├──► Voice Web Bridge ◄──► Embedded WebSocket
PV Player      ◄──► PV API           ◄──┘                              │
                                                                       ▼
No-Mod Player  ◄──────────────────────── Browser Voice Page (HTTPS / WSS)
```

## Requirements

- **Server:** Paper 1.21.4+ (or Folia)
- **Runtime:** Java 21+
- **Server plugins:**
  - [Simple Voice Chat](https://modrinth.com/plugin/simple-voice-chat)
  - [Plasmo Voice](https://modrinth.com/plugin/plasmo-voice)
- **For the browser voice client:** A web server / reverse proxy with **HTTPS** (e.g. Nginx) to serve `webpage/` and proxy `/voice-ws` to the plugin's embedded WebSocket server (browsers require HTTPS for microphone access).

## Installation

### 1. Server plugin

1. Install both **Simple Voice Chat** and **Plasmo Voice** on your Paper/Folia server.
2. Build or download the Voice Web Bridge plugin JAR (`build/libs/voice-web-bridge-<version>-reobf.jar`).
3. Place it in your server's `plugins/` directory and restart the server.
4. Edit `plugins/voice-web-bridge/config.yml` and set `web.link-template` to your public HTTPS URL (for example `https://voice.example.com/voicechat.html?id={uuid}`), then run `/vb reload`.

### 2. Browser voice page

1. Host the [`webpage/`](webpage/) directory behind an HTTPS web server.
2. Proxy `/voice-ws` to the plugin's WebSocket server (`127.0.0.1:8090` by default).

See [`webpage/README.md`](webpage/README.md) and [`webpage/nginx.conf.example`](webpage/nginx.conf.example) for full setup instructions, wire protocol details, and OBS overlay parameters.

## Building from source

```shell
./gradlew build
```

The production plugin JAR is output to `build/libs/` (`*-reobf.jar`).

### Running a dev server

```shell
# With Mojang mappings (for debugging)
./gradlew runDevBundleServer

# With obfuscation (production-like)
./gradlew runServer
```

## Configuration

A `config.yml` is generated on first run in `plugins/voice-web-bridge/`:

```yaml
bridge:
  enabled: true       # Enable/disable the bridge
  debug: false        # Enable debug logging

proximity:
  default-distance: 48.0      # Default voice range in blocks
  whisper-multiplier: 0.33    # Whisper range = distance * multiplier
  max-distance: 128.0         # Maximum allowed voice distance

audio:
  passthrough: true           # Opus passthrough (recommended, lowest latency)
  force-transcode: false      # Force transcoding (not yet implemented)
  repacing: true              # Smooth bursty SVC frames into a steady 20ms cadence for PV
  jitter-frames: 2            # Pre-buffered 20ms frames (~40ms) before draining

web:
  enabled: true               # Embedded WebSocket server for the browser voice page
  host: 127.0.0.1             # Bind address (127.0.0.1 for a local reverse proxy)
  port: 8090                  # WebSocket listen port
  link-template: "https://bla-bla.com/voicechat.html?id={uuid}"
  link-delay-seconds: 5       # Delay after player join before sending the chat link

# Optional per-world distance overrides
# worlds:
#   world_nether:
#     default-distance: 24.0
#   world_the_end:
#     default-distance: 64.0
```

## Commands

### Player commands

| Command              | Description                                                                   |
|----------------------|-------------------------------------------------------------------------------|
| `/mic` (alias `/vmic`) | Toggle your browser voice microphone On/Off (or resend your voice link if disconnected) |

### Admin commands

Permission: `voicebridge.admin` (default: op). Aliases: `/vb`, `/voicewebbridge`, `/vwb`.

| Command                        | Description                                    |
|--------------------------------|------------------------------------------------|
| `/voicebridge status`          | Show bridge status, metrics, and config        |
| `/voicebridge players`         | List active bridged sessions and mod types     |
| `/voicebridge reload`          | Reload configuration (restarts web server if needed) |
| `/voicebridge debug [on\|off]` | Toggle debug logging                           |

## Architecture

```
┌───────────────────────────────────────────────────────────────┐
│                       VoiceBridgePlugin                       │
├────────────┬──────────────┬────────────────┬──────────────────┤
│ SvcAdapter │  PvAdapter   │   WebAdapter   │    AudioRelay    │
│            │ FrameRepacer │ WebVoiceServer │  SessionManager  │
├────────────┴──────────────┴────────────────┴──────────────────┤
│    SpatialMapper    │    BridgeConfig    │    BridgeMetrics   │
└───────────────────────────────────────────────────────────────┘
```

- **SvcAdapter** — integrates with Simple Voice Chat via `VoicechatPlugin`
- **PvAdapter** + **FrameRepacer** — integrates with Plasmo Voice via `@Addon` / `AddonInitializer` and re-paces bursty SVC frames into a steady 20 ms cadence
- **WebAdapter** + **WebVoiceServer** — embedded WebSocket server managing per-player browser sessions, live player status broadcasts, in-game mic keybind triggers, and proximity audio routing
- **AudioRelay** — central router forwarding audio frames between mod adapters and in-range browser listeners
- **SessionManager** — tracks which voice mod(s) each player is using (including dual-mod deduplication)
- **SpatialMapper** — maps proximity distances across SVC, PV, web listeners, and per-world overrides
- **webpage/** — standalone browser voice client (`voicechat.html`, `styles.css`, `app.js`, vendored `opus-recorder` WASM workers, and Pixelify Sans font)

## Known limitations

- Proximity voice chat only (group/channel bridging is not yet supported)
- Transcoding mode is not yet implemented (Opus passthrough only)
- Browser players currently bridge bidirectionally with Simple Voice Chat and Plasmo Voice players; direct web-to-web audio forwarding is not yet implemented
- SVC-only players may not receive audio from PV players in some edge cases

## License

Voice Web Bridge is distributed under the **GNU General Public License v3.0** ([LICENSE](LICENSE)) with an additional permission under GPLv3 Section 7 allowing linking and combining with Simple Voice Chat, Minecraft, and Minecraft server platforms ([LICENSE-EXCEPTION](LICENSE-EXCEPTION)).

Copyright (c) 2026 nezushin. Based on [Voice Bridge](https://github.com/PfauMC/voice-bridge) — Copyright (c) 2026 PfauMC, originally licensed under the MIT License.

All preserved upstream and third-party notices (PfauMC, bStats, Java-WebSocket, SLF4J, `opus-recorder` / Opus / Speex, and the `Pixelify Sans` SIL OFL 1.1 font) — along with GPLv3 Section 6 Corresponding Source details for release distributions — are documented in [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md).
