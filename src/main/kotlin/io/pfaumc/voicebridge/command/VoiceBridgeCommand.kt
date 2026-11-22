package io.pfaumc.voicebridge.command

import io.pfaumc.voicebridge.BridgeMetrics
import io.pfaumc.voicebridge.VoiceBridgePlugin
import io.pfaumc.voicebridge.config.Message
import io.pfaumc.voicebridge.session.BridgeSession
import io.pfaumc.voicebridge.session.ModType
import org.bukkit.command.Command
import org.bukkit.command.CommandExecutor
import org.bukkit.command.CommandSender
import org.bukkit.command.TabCompleter
import org.bukkit.util.StringUtil
import java.util.UUID
import java.util.logging.Level

class VoiceBridgeCommand(private val plugin: VoiceBridgePlugin) : CommandExecutor, TabCompleter {

    override fun onCommand(
        sender: CommandSender,
        command: Command,
        label: String,
        args: Array<out String>
    ): Boolean {
        if (!sender.hasPermission(ADMIN_PERMISSION)) {
            Message.insufficient_permissions.send(sender)
            return true
        }

        if (args.isEmpty()) {
            Message.help.send(sender)
            return true
        }

        when (args[0].lowercase()) {
            "status" -> showStatus(sender)
            "players" -> showPlayers(sender)
            "reload" -> reloadConfig(sender)
            "debug" -> toggleDebug(sender, args.getOrNull(1))
            else -> Message.help.send(sender)
        }
        return true
    }

    override fun onTabComplete(
        sender: CommandSender,
        command: Command,
        label: String,
        args: Array<out String>
    ): List<String> {
        if (!sender.hasPermission(ADMIN_PERMISSION)) return emptyList()

        return when (args.size) {
            1 -> SUBCOMMANDS.filter { StringUtil.startsWithIgnoreCase(it, args[0]) }
            2 -> if (args[0].equals("debug", ignoreCase = true)) {
                DEBUG_VALUES.filter { StringUtil.startsWithIgnoreCase(it, args[1]) }
            } else {
                emptyList()
            }
            else -> emptyList()
        }
    }

    private fun showStatus(sender: CommandSender) {
        val debug = plugin.bridgeConfig.debug
        val webAdapter = plugin.webAdapter
        val svcReady = plugin.audioRelay.svcAdapter?.isApiReady == true
        val pvReady = plugin.audioRelay.pvAdapter != null

        val statusSender = Message.status
            .replace(
                "{active_sessions}" to BridgeMetrics.activeSessions.get(),
                "{svc_to_pv_frames}" to BridgeMetrics.svcToPlasmoFrames.get(),
                "{pv_to_svc_frames}" to BridgeMetrics.plasmoToSvcFrames.get(),
                "{dropped_frames}" to BridgeMetrics.droppedFrames.get(),
                "{transcoded_frames}" to BridgeMetrics.transcodingCount.get(),
                "{web_sessions}" to BridgeMetrics.webActiveSessions.get(),
                "{web_to_game_frames}" to BridgeMetrics.webToGameFrames.get(),
                "{game_to_web_frames}" to BridgeMetrics.gameToWebFrames.get(),
                "{passthrough}" to plugin.bridgeConfig.passthrough
            )
            .replaceRaw(
                "{svc_api}" to (if (svcReady) Message.status_ready else Message.status_not_ready).asString(),
                "{pv_addon}" to (if (pvReady) Message.status_ready else Message.status_not_ready).asString(),
                "{debug}" to (if (debug) Message.status_enabled else Message.status_disabled).asString()
            )

        if (webAdapter != null && plugin.bridgeConfig.webEnabled) {
            statusSender.replace("{web_transport}" to webAdapter.statusSummary())
        } else {
            statusSender.replaceRaw("{web_transport}" to Message.status_web_disabled.asString())
        }

        statusSender.send(sender)
    }

    private fun showPlayers(sender: CommandSender) {
        val sessions = plugin.sessionManager.getAllSessions()
        val webConnected = plugin.webAdapter?.getConnectedWebPlayers().orEmpty()
        if (sessions.isEmpty() && webConnected.isEmpty()) {
            Message.players_empty.send(sender)
            return
        }

        val byUuid = sessions.associateBy { it.playerUuid }
        val allUuids = linkedSetOf<UUID>()
        sessions.forEach { allUuids.add(it.playerUuid) }
        webConnected.keys.forEach { allUuids.add(it) }

        Message.players_header
            .replace("{count}" to allUuids.size)
            .send(sender)

        for (uuid in allUuids) {
            val session = byUuid[uuid]
            val isWeb = webConnected.containsKey(uuid)
            val name = session?.playerName ?: webConnected[uuid] ?: uuid.toString()

            val tags = buildString {
                if (session != null) {
                    append(modTag(session))
                }
                if (isWeb) {
                    append(Message.players_tag_web.asString())
                }
            }
            val active = (session?.active == true) || isWeb
            val statusIcon = if (active) {
                Message.players_active.asString()
            } else {
                Message.players_inactive.asString()
            }

            Message.players_entry
                .replace(
                    "{player}" to name,
                    "{uuid}" to uuid
                )
                .replaceRaw(
                    "{tags}" to tags,
                    "{status}" to statusIcon
                )
                .send(sender)
        }
    }

    private fun modTag(session: BridgeSession): String {
        if (session.isDualMod()) {
            return Message.players_tag_dual.asString()
        }
        return when (session.modType) {
            ModType.SIMPLE_VOICE_CHAT -> Message.players_tag_svc.asString()
            ModType.PLASMO_VOICE -> Message.players_tag_pv.asString()
        }
    }

    private fun reloadConfig(sender: CommandSender) {
        try {
            val webRestarted = plugin.reloadBridgeConfig()
            when {
                webRestarted && plugin.bridgeConfig.webEnabled -> {
                    Message.reload_complete_web_restarted
                        .replace("{status}" to (plugin.webAdapter?.statusSummary() ?: "unknown"))
                        .send(sender)
                }
                webRestarted -> Message.reload_complete_web_stopped.send(sender)
                else -> Message.reload_complete.send(sender)
            }
        } catch (ex: Exception) {
            Message.reload_failed.send(sender)
            plugin.logger.log(Level.SEVERE, "Failed to reload Voice Web Bridge config", ex)
        }
    }

    private fun toggleDebug(sender: CommandSender, value: String?) {
        val enabled = when (value?.lowercase()) {
            "on", "true" -> true
            "off", "false" -> false
            else -> !plugin.bridgeConfig.debug
        }
        plugin.bridgeConfig.debug = enabled
        if (enabled) {
            Message.debug_enabled.send(sender)
        } else {
            Message.debug_disabled.send(sender)
        }
    }

    companion object {
        private const val ADMIN_PERMISSION = "voicebridge.admin"
        private val SUBCOMMANDS = listOf("status", "players", "reload", "debug")
        private val DEBUG_VALUES = listOf("on", "off")
    }
}
