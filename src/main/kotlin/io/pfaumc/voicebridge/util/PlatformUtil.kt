@file:Suppress("DEPRECATION")

package io.pfaumc.voicebridge.util

import net.kyori.adventure.text.Component
import net.kyori.adventure.text.serializer.gson.GsonComponentSerializer
import net.kyori.adventure.text.serializer.legacy.LegacyComponentSerializer
import net.md_5.bungee.api.ChatMessageType
import net.md_5.bungee.chat.ComponentSerializer
import org.bukkit.command.CommandSender
import org.bukkit.entity.Player

/**
 * Runtime platform detection and cross-platform messaging helpers (Spigot, Paper, Folia).
 *
 * Mirrors NMinimap's Paper/Spigot detection so Adventure components work natively on
 * Paper/Folia and serialize cleanly through Spigot's Bungee chat bridge on Spigot.
 */
object PlatformUtil {

    val isPaper: Boolean = try {
        Class.forName("com.destroystokyo.paper.utils.PaperPluginLogger")
        true
    } catch (_: Throwable) {
        false
    }

    val isFolia: Boolean = try {
        Class.forName("io.papermc.paper.threadedregions.RegionizedServer")
        true
    } catch (_: Throwable) {
        false
    }

    val hasPlayerInputEvent: Boolean = try {
        Class.forName("org.bukkit.event.player.PlayerInputEvent")
        true
    } catch (_: Throwable) {
        false
    }

    fun sendMessage(sender: CommandSender, component: Component) {
        if (isPaper) {
            sender.sendMessage(component)
            return
        }

        if (sender is Player) {
            sender.spigot().sendMessage(
                *ComponentSerializer.parse(GsonComponentSerializer.gson().serialize(component))
            )
        } else {
            sender.sendMessage(LegacyComponentSerializer.legacySection().serialize(component))
        }
    }

    fun sendActionBar(player: Player, component: Component) {
        if (isPaper) {
            player.sendActionBar(component)
            return
        }

        player.spigot().sendMessage(
            ChatMessageType.ACTION_BAR,
            *ComponentSerializer.parse(GsonComponentSerializer.gson().serialize(component))
        )
    }
}
