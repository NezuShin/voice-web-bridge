package io.pfaumc.voicebridge.config

import io.pfaumc.voicebridge.config.updater.ConfigUpdater
import org.bukkit.configuration.file.FileConfiguration
import org.bukkit.configuration.file.YamlConfiguration
import org.bukkit.plugin.Plugin
import java.io.File
import java.io.IOException
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
    val language: String = "en_US",
    val allowConfigUpdates: Boolean = true,
    val enabled: Boolean = true,
    @Volatile var debug: Boolean = false,
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

        fun load(plugin: Plugin): BridgeConfig {
            val dataFolder = plugin.dataFolder
            val configFile = File(dataFolder, "config.yml")

            var yaml: FileConfiguration
            if (!configFile.exists()) {
                dataFolder.mkdirs()
                plugin.saveDefaultConfig()
                logger.info("Created default config at ${configFile.absolutePath}")
                yaml = YamlConfiguration.loadConfiguration(configFile)
            } else {
                yaml = YamlConfiguration.loadConfiguration(configFile)
                migrateLegacyWebMode(yaml)

                if (yaml.getBoolean("config.allow-config-updates", true)) {
                    try {
                        ConfigUpdater.update(plugin, "config.yml", configFile, yaml, "worlds")
                        yaml = YamlConfiguration.loadConfiguration(configFile)
                    } catch (ex: IOException) {
                        logger.warning("Failed to auto-update config.yml: ${ex.message}")
                    }
                }
            }

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
                language = (yaml.getString("language", "en_US") ?: "en_US").trim().ifEmpty { "en_US" },
                allowConfigUpdates = yaml.getBoolean("config.allow-config-updates", true),
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

        /**
         * Preserves self-hosted mode for pre-proxy configs before [ConfigUpdater] writes
         * the default `web.mode: proxy` key.
         */
        private fun migrateLegacyWebMode(yaml: FileConfiguration) {
            if (yaml.contains("web.mode")) return
            if (yaml.contains("web.host") || yaml.contains("web.port") || yaml.contains("web.link-template")) {
                yaml.set("web.mode", WebMode.SELF_HOSTED.configName)
            }
        }
    }
}
