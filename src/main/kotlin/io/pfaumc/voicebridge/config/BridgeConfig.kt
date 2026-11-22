package io.pfaumc.voicebridge.config

import org.bukkit.configuration.file.YamlConfiguration
import java.io.File
import java.util.logging.Logger

enum class WebMode(val configName: String) {
    SELF_HOSTED("self-hosted"),
    PROXY("proxy");

    companion object {
        fun fromConfig(raw: String?): WebMode = when (raw?.trim()?.lowercase()) {
            "proxy", "remote", "relay" -> PROXY
            else -> SELF_HOSTED
        }
    }
}

data class BridgeConfig(
    val enabled: Boolean = true,
    val debug: Boolean = false,
    val defaultDistance: Double = 48.0,
    val whisperMultiplier: Double = 0.33,
    val maxDistance: Double = 128.0,
    val passthrough: Boolean = true,
    val forceTranscode: Boolean = false,
    val repacing: Boolean = true,
    val repacingJitterFrames: Int = 2,
    val worldOverrides: Map<String, Double> = emptyMap(),
    val webEnabled: Boolean = true,
    val webMode: WebMode = WebMode.PROXY,
    val webHost: String = "127.0.0.1",
    val webPort: Int = 8090,
    val webLinkTemplate: String = "https://bla-bla.com/voicechat.html?id={uuid}",
    val webLinkDelaySeconds: Long = 5,
    val webProxyUrl: String = DEFAULT_PROXY_URL,
    val webProxyServerId: String = "",
    val webProxyLinkTemplate: String = "",
    val webProxyReconnectDelaySeconds: Long = 5
) {
    companion object {
        private val logger = Logger.getLogger("VoiceBridge")
        const val DEFAULT_PROXY_URL = "https://voicechat.nezushin.ru"

        fun load(dataFolder: File): BridgeConfig {
            val configFile = File(dataFolder, "config.yml")

            if (!configFile.exists()) {
                dataFolder.mkdirs()
                configFile.writeText(DEFAULT_CONFIG)
                logger.info("Created default config at ${configFile.absolutePath}")
            }

            val yaml = YamlConfiguration.loadConfiguration(configFile)

            val worldOverrides = mutableMapOf<String, Double>()
            val worldsSection = yaml.getConfigurationSection("worlds")
            worldsSection?.getKeys(false)?.forEach { worldName ->
                val distance = worldsSection.getDouble("$worldName.default-distance", -1.0)
                if (distance > 0) {
                    worldOverrides[worldName] = distance
                }
            }

            val configuredMode = yaml.getString("web.mode")
            val webMode = if (!configuredMode.isNullOrBlank()) {
                WebMode.fromConfig(configuredMode)
            } else if (yaml.contains("web.host") || yaml.contains("web.port") || yaml.contains("web.link-template")) {
                // Keep existing pre-proxy self-hosted configs working on upgrade
                WebMode.SELF_HOSTED
            } else {
                WebMode.PROXY
            }

            return BridgeConfig(
                enabled = yaml.getBoolean("bridge.enabled", true),
                debug = yaml.getBoolean("bridge.debug", false),
                defaultDistance = yaml.getDouble("proximity.default-distance", 48.0),
                whisperMultiplier = yaml.getDouble("proximity.whisper-multiplier", 0.33),
                maxDistance = yaml.getDouble("proximity.max-distance", 128.0),
                passthrough = yaml.getBoolean("audio.passthrough", true),
                forceTranscode = yaml.getBoolean("audio.force-transcode", false),
                repacing = yaml.getBoolean("audio.repacing", true),
                repacingJitterFrames = yaml.getInt("audio.jitter-frames", 2),
                worldOverrides = worldOverrides,
                webEnabled = yaml.getBoolean("web.enabled", true),
                webMode = webMode,
                webHost = yaml.getString("web.host", "127.0.0.1") ?: "127.0.0.1",
                webPort = yaml.getInt("web.port", 8090),
                webLinkTemplate = yaml.getString(
                    "web.link-template",
                    "https://bla-bla.com/voicechat.html?id={uuid}"
                ) ?: "https://bla-bla.com/voicechat.html?id={uuid}",
                webLinkDelaySeconds = yaml.getLong("web.link-delay-seconds", 5L),
                webProxyUrl = (yaml.getString("web.proxy.url", DEFAULT_PROXY_URL) ?: DEFAULT_PROXY_URL).trim(),
                webProxyServerId = (yaml.getString("web.proxy.server-id", "") ?: "").trim(),
                webProxyLinkTemplate = (yaml.getString("web.proxy.link-template", "") ?: "").trim(),
                webProxyReconnectDelaySeconds = yaml.getLong("web.proxy.reconnect-delay-seconds", 5L).coerceAtLeast(1L)
            )
        }

        private val DEFAULT_CONFIG = """
            # Voice Web Bridge Configuration
            bridge:
              enabled: true
              debug: false

            proximity:
              # Default voice distance in blocks
              default-distance: 48.0
              # Whisper distance = normal distance * this multiplier
              whisper-multiplier: 0.33
              # Maximum allowed voice distance
              max-distance: 128.0

            audio:
              # Pass Opus frames through without re-encoding (recommended, lowest latency)
              passthrough: true
              # Force decode and re-encode all frames (higher CPU, use only if codec mismatch)
              force-transcode: false
              # Smooth out bursty Simple Voice Chat frame delivery before forwarding to Plasmo
              # Voice. Holds a small lead of frames per speaker and releases them at a steady 20ms
              # cadence so PV clients don't underflow their jitter buffer and crackle.
              repacing: true
              # Frames to pre-buffer before draining (each frame is 20ms). Higher = smoother under
              # jitter but more latency. 2 = ~40ms added.
              jitter-frames: 2

            web:
              # Enable the browser voice client
              enabled: true
              # Transport mode:
              #   "proxy"       - (default, plug-and-play) connects outbound over a single WebSocket
              #                   to a hosted relay — no open web ports or Nginx required
              #   "self-hosted" - runs an embedded WebSocket server locally behind your own Nginx
              mode: proxy

              # --- Proxy mode settings (used when mode: proxy) ---
              proxy:
                # Proxy endpoint (supports ws://, wss://, http://, or https://; defaults path to /bridge-ws)
                url: "$DEFAULT_PROXY_URL"
                # Optional stable server id (6-32 chars: a-z, A-Z, 0-9, _, -).
                # Leave blank to auto-generate and persist one in proxy-identity.properties.
                server-id: ""
                # Optional link override. Leave blank to use the public URL sent by the proxy.
                # Supports {serverId} and {uuid} placeholders.
                link-template: ""
                # Initial delay in seconds before reconnecting after a tunnel disconnect
                reconnect-delay-seconds: 5

              # --- Self-hosted mode settings (used when mode: self-hosted) ---
              # Bind address. 127.0.0.1 means only a local Nginx proxy can reach it.
              host: 127.0.0.1
              port: 8090
              # Link sent to players after joining. {uuid} is replaced with the session id.
              link-template: "https://bla-bla.com/voicechat.html?id={uuid}"

              # Delay in seconds before the link message is sent after joining
              link-delay-seconds: 5

            # Per-world distance overrides (optional)
            # worlds:
            #   world_nether:
            #     default-distance: 24.0
            #   world_the_end:
            #     default-distance: 64.0
        """.trimIndent()
    }
}
