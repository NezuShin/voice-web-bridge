package io.pfaumc.voicebridge.config

import io.pfaumc.voicebridge.config.updater.ConfigUpdater
import io.pfaumc.voicebridge.util.PlatformUtil
import net.kyori.adventure.text.minimessage.MiniMessage
import org.bukkit.command.CommandSender
import org.bukkit.configuration.file.FileConfiguration
import org.bukkit.configuration.file.YamlConfiguration
import org.bukkit.entity.Player
import org.bukkit.plugin.Plugin
import java.io.File
import java.io.FileOutputStream
import java.io.IOException

/**
 * Localized MiniMessage-based message registry, adapted from NMinimap's Message system.
 *
 * Supports single-line and multi-line YAML entries, automatic lang file extraction and
 * merging via [ConfigUpdater], chat and action bar delivery, and Spigot/Paper/Folia.
 */
enum class Message {

    insufficient_permissions,
    player_only,
    help,
    status,
    status_ready,
    status_not_ready,
    status_enabled,
    status_disabled,
    status_web_disabled,
    players_empty,
    players_header,
    players_entry,
    players_tag_svc,
    players_tag_pv,
    players_tag_dual,
    players_tag_web,
    players_active,
    players_inactive,
    reload_complete,
    reload_complete_web_restarted,
    reload_complete_web_stopped,
    reload_failed,
    debug_enabled,
    debug_disabled,
    web_disabled,
    web_link,
    web_not_connected,
    mic_toggled,
    mic_state_on,
    mic_state_off;

    @Volatile
    private var lines: List<String> = emptyList()

    fun load(messages: FileConfiguration) {
        val path = name
        lines = when {
            messages.isList(path) -> messages.getStringList(path)
            messages.isString(path) -> listOf(messages.getString(path).orEmpty())
            else -> emptyList()
        }
    }

    fun send(sender: CommandSender) {
        Sender(lines).send(sender)
    }

    fun sendActionBar(player: Player) {
        Sender(lines).sendActionBar(player)
    }

    fun replace(vararg pairs: Pair<String, Any?>): Sender =
        Sender(lines).replace(*pairs)

    fun replaceRaw(vararg pairs: Pair<String, Any?>): Sender =
        Sender(lines).replaceRaw(*pairs)

    fun replaceUrl(key: String, url: String): Sender =
        Sender(lines).replaceUrl(key, url)

    fun asString(): String = lines.joinToString("\n")

    class Sender(initialLines: List<String>) {

        private val lines: MutableList<String> = ArrayList(initialLines)

        /**
         * Replaces placeholders with MiniMessage-escaped plain text values so arbitrary
         * runtime strings (player names, error details, etc.) cannot break formatting.
         */
        fun replace(vararg pairs: Pair<String, Any?>): Sender {
            val mm = MiniMessage.miniMessage()
            for ((key, value) in pairs) {
                val safe = mm.escapeTags(value?.toString().orEmpty())
                for (i in lines.indices) {
                    lines[i] = lines[i].replace(key, safe)
                }
            }
            return this
        }

        /**
         * Replaces placeholders with raw MiniMessage strings (for composing styled fragments
         * from other [Message] keys).
         */
        fun replaceRaw(vararg pairs: Pair<String, Any?>): Sender {
            for ((key, value) in pairs) {
                val raw = value?.toString().orEmpty()
                for (i in lines.indices) {
                    lines[i] = lines[i].replace(key, raw)
                }
            }
            return this
        }

        /**
         * Replaces a URL placeholder safely for both `<click:open_url:'...'>` attributes and
         * visible link text.
         */
        fun replaceUrl(key: String, url: String): Sender {
            val safeUrl = url
                .replace("'", "%27")
                .replace("<", "%3C")
                .replace(">", "%3E")
            for (i in lines.indices) {
                lines[i] = lines[i].replace(key, safeUrl)
            }
            return this
        }

        fun send(sender: CommandSender): Sender {
            if (lines.isEmpty() || (lines.size == 1 && lines[0].isEmpty())) return this
            val mm = MiniMessage.miniMessage()
            for (line in lines) {
                PlatformUtil.sendMessage(sender, mm.deserialize(line))
            }
            return this
        }

        fun sendActionBar(player: Player): Sender {
            val text = lines.joinToString(" ")
            if (text.isEmpty()) return this
            PlatformUtil.sendActionBar(player, MiniMessage.miniMessage().deserialize(text))
            return this
        }
    }

    companion object {
        private const val DEFAULT_LANG = "en_US"

        fun load(plugin: Plugin, langName: String, allowUpdates: Boolean = true) {
            var file = getLangFile(plugin, langName, allowUpdates)
            if (file == null) {
                plugin.logger.severe("Language file for lang $langName is not found. Using $DEFAULT_LANG instead")
                file = getLangFile(plugin, DEFAULT_LANG, allowUpdates)
            }
            if (file != null) {
                loadFromFile(file)
            }
        }

        private fun getLangFile(plugin: Plugin, lang: String, allowUpdates: Boolean): File? {
            val file = File(plugin.dataFolder, "lang/$lang.yml")
            val resourcePath = "defaults/lang/$lang.yml"

            if (!file.exists()) {
                return try {
                    copyDefaults(plugin, resourcePath, file, false)
                    file
                } catch (_: IllegalArgumentException) {
                    null
                }
            }

            if (allowUpdates) {
                val templatePath = if (plugin.getResource(resourcePath) != null) {
                    resourcePath
                } else {
                    "defaults/lang/$DEFAULT_LANG.yml"
                }
                if (plugin.getResource(templatePath) != null) {
                    try {
                        ConfigUpdater.update(plugin, templatePath, file)
                    } catch (e: IOException) {
                        plugin.logger.warning("Failed to update language file ${file.name}: ${e.message}")
                    }
                }
            }

            return file
        }

        private fun loadFromFile(file: File) {
            val config = YamlConfiguration.loadConfiguration(file)
            for (msg in entries) {
                msg.load(config)
            }
        }

        fun copyDefaults(plugin: Plugin, resourcePath: String, dest: File, force: Boolean = false) {
            if (dest.exists()) {
                if (!force) return
                dest.delete()
            }
            dest.parentFile?.mkdirs()
            val normalized = resourcePath.replace('\\', '/')
            val input = plugin.getResource(normalized)
                ?: throw IllegalArgumentException("The embedded resource '$resourcePath' cannot be found")
            input.use { stream ->
                FileOutputStream(dest).use { out ->
                    stream.copyTo(out)
                }
            }
        }
    }
}
