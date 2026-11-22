package io.pfaumc.voicebridge.command

import io.pfaumc.voicebridge.VoiceBridgePlugin
import io.pfaumc.voicebridge.config.Message
import org.bukkit.command.Command
import org.bukkit.command.CommandExecutor
import org.bukkit.command.CommandSender
import org.bukkit.command.TabCompleter
import org.bukkit.entity.Player

class MicCommand(private val plugin: VoiceBridgePlugin) : CommandExecutor, TabCompleter {

    override fun onCommand(
        sender: CommandSender,
        command: Command,
        label: String,
        args: Array<out String>
    ): Boolean {
        val player = sender as? Player
        if (player == null) {
            Message.player_only.send(sender)
            return true
        }
        val web = plugin.webAdapter
        if (web == null || !plugin.bridgeConfig.webEnabled) {
            Message.web_disabled.send(player)
            return true
        }
        if (web.triggerControlFromCommand(player, "mic_toggle")) {
            Message.mic_toggled.sendActionBar(player)
        } else {
            Message.web_not_connected.send(player)
        }
        return true
    }

    override fun onTabComplete(
        sender: CommandSender,
        command: Command,
        label: String,
        args: Array<out String>
    ): List<String> = emptyList()
}
