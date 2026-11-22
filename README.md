# Voice Web Bridge

**Plug-and-play proximity voice chat for everyone on your Minecraft server — voice chat available in 3 clicks for players.**

Voice Web Bridge is a server-side [Paper](https://papermc.io/) / Folia plugin that unites
[Simple Voice Chat](https://modrinth.com/plugin/simple-voice-chat),
[Plasmo Voice](https://modrinth.com/plugin/plasmo-voice), and a **browser voice client** —
so players using different voice mods *and* players with no client mods at all (vanilla Java, Bedrock via Geyser, or anyone who cannot install mods) can all talk together in proximity voice chat.

Out of the box, Voice Web Bridge works in **plug-and-play proxy mode**:
- **For server owners:** Drop the plugin into `plugins/` and restart — **no open web ports, no Nginx, no SSL certificates, and no config edits needed**. The plugin connects outbound over a single WebSocket to the free hosted relay (`https://voicechat.nezushin.ru`).
- **For players (3 clicks, zero mods):** Join the server → **1)** Click the personal voice link in chat → **2)** Click **Enable Microphone** → **3)** Allow microphone access in your browser and talk!
- **Self-hosting still supported:** Prefer hosting the web page on your own domain? Flip one setting (`web.mode: self-hosted`) to run the embedded WebSocket server behind your own Nginx.

## Highlights

- **Plug-and-play for server owners:** Works immediately after placing the JAR in `plugins/` — connects outbound via a single WebSocket tunnel to `https://voicechat.nezushin.ru` with no firewall/port forwarding or reverse proxy setup required.
- **Voice chat in 3 clicks for players:** No client mods required. Players automatically receive a clickable link in chat after joining — open it, click Enable Microphone, allow access, and speak with nearby players (modded or web).
- **Voice chat for everyone:** Players with Simple Voice Chat, players with Plasmo Voice, and unmodded browser players can all hear and talk to each other seamlessly (SVC ↔ PV ↔ Web, including Web ↔ Web).
- **Low-latency Opus passthrough:** Simple Voice Chat, Plasmo Voice, and the browser client all use 48 kHz mono 20 ms Opus frames. Frames are relayed directly without transcoding, with optional frame re-pacing for smooth playback.
- **Full-featured browser voice GUI:** Minecraft-styled web interface with voice activation / open mic, input/output device selection, mic & output gain (0–200%), live server player list with voice badges (`[SVC]`, `[PV]`, `[SVC+PV]`, `[WEB]`, `[NO VOICE]`), and per-player volume/mute controls.
- **In-game Minecraft mic keybinds (no client mod):** Web users can toggle their microphone directly from Minecraft using `Double Shift`, `Double Ctrl`, `Shift+F`, `Shift+Q`, or `/mic` (`/vmic`), with live action-bar feedback.
- **Overlay & OBS support:** Configurable floating microphone HUD with always-on-top Document Picture-in-Picture pop-out (Chromium) and transparent OBS Browser Source mode.
- **Optional self-hosting:** Full self-hosted mode (`webpage/` + embedded WebSocket server) remains built in for servers that want to host everything on their own infrastructure.

## How it works

All three endpoints — Simple Voice Chat (SVC), Plasmo Voice (PV), and the vendored WebAssembly Opus browser client — encode audio as 48 kHz, mono, 20 ms Opus frames. Voice Web Bridge intercepts audio packets from each source and forwards raw Opus frames to nearby listeners without re-encoding.

```
SVC Player     ◄──► SVC API    ◄──┐
                                  ├──► Voice Web Bridge ◄──(1 outbound WS)──► Voice Proxy (HTTPS / WSS)
PV Player      ◄──► PV API     ◄──┘                                                  │
                                                                                     ▼
No-Mod Player  ◄────────────────────────────────────────────── Browser Voice Page (3 clicks, no mods)
```

*(In `self-hosted` mode, the plugin instead exposes an embedded local WebSocket server behind your own HTTPS reverse proxy.)*

## Requirements

- **Server:** Paper 1.21.4+ (or Folia)
- **Runtime:** Java 21+
- **Server plugins:**
  - [Simple Voice Chat](https://modrinth.com/plugin/simple-voice-chat)
  - [Plasmo Voice](https://modrinth.com/plugin/plasmo-voice)
- **Web hosting:** **None required** in the default proxy mode! *(An HTTPS web server such as Nginx is only needed if you switch to `web.mode: self-hosted`.)*

## Quick Start (Plug & Play)

### For Server Owners

1. Install **Simple Voice Chat** and **Plasmo Voice** on your Paper/Folia server.
2. Download or build the Voice Web Bridge JAR (`voice-web-bridge-<version>-reobf.jar`).
3. Drop it into your server's `plugins/` folder and restart the server.

That's it! On first run, the plugin generates `plugins/voice-web-bridge/config.yml` with `web.mode: proxy` pointing to `https://voicechat.nezushin.ru`, opens a single outbound WebSocket tunnel, and starts sending players their personal voice links automatically.

### For Players (Voice Chat in 3 Clicks)

1. **Click** the personal voice chat link sent in Minecraft chat a few seconds after joining (or run `/mic` anytime to resend it).
2. **Click** **Enable Microphone** on the voice page.
3. **Click** **Allow** in your browser's microphone prompt — you're live in proximity voice chat!

## Self-Hosting (Optional)

If you want to host the browser page on your own domain instead of using the hosted proxy:

1. Host the [`webpage/`](webpage/) directory behind an HTTPS web server (browsers require HTTPS for microphone access).
2. Proxy `/voice-ws` to the plugin's embedded WebSocket server (`127.0.0.1:8090` by default).
3. In `plugins/voice-web-bridge/config.yml`, set `web.mode: self-hosted` and set `web.link-template` to your public HTTPS URL (e.g. `https://voice.example.com/voicechat.html?id={uuid}`), then run `/vb reload`.

See [`webpage/README.md`](webpage/README.md) and [`webpage/nginx.conf.example`](webpage/nginx.conf.example) for Nginx config, wire protocol details, and OBS overlay parameters.

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
  enabled: true               # Enable the browser voice client
  mode: proxy                 # "proxy" (default, plug-and-play) or "self-hosted" (embedded WS)

  # Proxy mode settings (used when mode: proxy)
  proxy:
    url: "https://voicechat.nezushin.ru" # Supports ws://, wss://, http://, https://
    server-id: ""             # Optional; auto-generated & persisted when blank
    link-template: ""         # Optional; defaults to public URL sent by proxy
    reconnect-delay-seconds: 5

  # Self-hosted mode settings (used when mode: self-hosted)
  host: 127.0.0.1             # Local bind address (127.0.0.1 for local Nginx)
  port: 8090                  # Embedded WebSocket listen port
  link-template: "https://bla-bla.com/voicechat.html?id={uuid}"

  link-delay-seconds: 5       # Delay after player join before sending the chat link

# Optional per-world distance overrides
# worlds:
#   world_nether:
#     default-distance: 24.0
#   world_the_end:
#     default-distance: 64.0
```

*(Existing servers upgrading from an older `config.yml` without `web.mode` automatically stay in `self-hosted` mode until you set `web.mode: proxy`.)*

## Commands

### Player commands

| Command              | Description                                                                   |
|----------------------|-------------------------------------------------------------------------------|
| `/mic` (alias `/vmic`) | Toggle your browser voice microphone On/Off (or resend your voice link if disconnected) |

### Admin commands

Permission: `voicebridge.admin` (default: op). Aliases: `/vb`, `/voicewebbridge`, `/vwb`.

| Command                        | Description                                           |
|--------------------------------|-------------------------------------------------------|
| `/voicebridge status`          | Show bridge status, web transport state, and metrics  |
| `/voicebridge players`         | List active bridged sessions (`[SVC]`, `[PV]`, `[WEB]`) |
| `/voicebridge reload`          | Reload configuration (restarts web transport if needed) |
| `/voicebridge debug [on\|off]` | Toggle debug logging                                  |

## Architecture

```
┌───────────────────────────────────────────────────────────────────┐
│                         VoiceBridgePlugin                         │
├────────────┬──────────────┬────────────────────┬──────────────────┤
│ SvcAdapter │  PvAdapter   │     WebAdapter     │    AudioRelay    │
│            │ FrameRepacer │ ProxyWebTransport  │  SessionManager  │
│            │              │  / WebVoiceServer  │                  │
├────────────┴──────────────┴────────────────────┴──────────────────┤
│     SpatialMapper     │     BridgeConfig     │   BridgeMetrics    │
└───────────────────────────────────────────────────────────────────┘
```

- **SvcAdapter** — integrates with Simple Voice Chat via `VoicechatPlugin`
- **PvAdapter** + **FrameRepacer** — integrates with Plasmo Voice via `@Addon` / `AddonInitializer` and re-paces bursty SVC frames into a steady 20 ms cadence
- **WebAdapter** + **ProxyWebTransport** / **WebVoiceServer** — manages per-player browser sessions, live player status broadcasts, in-game mic keybind triggers, and proximity audio routing over either a single outbound proxy tunnel (default) or an embedded local WebSocket server
- **AudioRelay** — central router forwarding audio frames between mod adapters and in-range browser listeners
- **SessionManager** — tracks which voice mod(s) each player is using (including dual-mod deduplication)
- **SpatialMapper** — maps proximity distances across SVC, PV, web listeners, and per-world overrides
- **webpage/** — standalone browser voice client (`voicechat.html`, `styles.css`, `app.js`, vendored `opus-recorder` WASM workers, and Pixelify Sans font)

## Known limitations

- Proximity voice chat only (group/channel bridging is not yet supported)
- Transcoding mode is not yet implemented (Opus passthrough only)
- SVC-only players may not receive audio from PV players in some edge cases

## License

Voice Web Bridge is distributed under the **GNU General Public License v3.0** ([LICENSE](LICENSE)) with an additional permission under GPLv3 Section 7 allowing linking and combining with Simple Voice Chat, Minecraft, and Minecraft server platforms ([LICENSE-EXCEPTION](LICENSE-EXCEPTION)).

Copyright (c) 2026 nezushin. Based on [Voice Bridge](https://github.com/PfauMC/voice-bridge) — Copyright (c) 2026 PfauMC, originally licensed under the MIT License.

All preserved upstream and third-party notices (PfauMC, bStats, Java-WebSocket, SLF4J, `opus-recorder` / Opus / Speex, and the `Pixelify Sans` SIL OFL 1.1 font) — along with GPLv3 Section 6 Corresponding Source details for release distributions — are documented in [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md).
