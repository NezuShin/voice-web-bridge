package io.pfaumc.voicebridge.adapter

import de.maxhenkel.voicechat.api.BukkitVoicechatService
import de.maxhenkel.voicechat.api.VoicechatApi
import de.maxhenkel.voicechat.api.VoicechatPlugin
import de.maxhenkel.voicechat.api.VoicechatServerApi
import de.maxhenkel.voicechat.api.audiochannel.EntityAudioChannel
import de.maxhenkel.voicechat.api.events.EventRegistration
import de.maxhenkel.voicechat.api.events.MicrophonePacketEvent
import de.maxhenkel.voicechat.api.events.PlayerConnectedEvent
import de.maxhenkel.voicechat.api.events.PlayerDisconnectedEvent
import de.maxhenkel.voicechat.api.events.VoicechatServerStartedEvent
import io.pfaumc.voicebridge.BridgeMetrics
import io.pfaumc.voicebridge.VoiceBridgePlugin
import io.pfaumc.voicebridge.session.ModType
import org.bukkit.Bukkit
import org.bukkit.entity.Player
import java.util.*
import java.util.concurrent.ConcurrentHashMap
import java.util.logging.Logger

/**
 * Adapter for Simple Voice Chat.
 *
 * Implements VoicechatPlugin to hook into SVC's server-side API.
 * - Listens for MicrophonePacketEvents from SVC players and relays to PV players via AudioRelay.
 * - Creates EntityAudioChannels to relay audio FROM PV players TO SVC players.
 *
 * Registration: This class must be registered as a VoicechatPlugin via SVC's service discovery.
 * On Paper/Bukkit, this is done via BukkitVoicechatService.
 */
class SvcAdapter(private val plugin: VoiceBridgePlugin) : VoicechatPlugin {

    private val logger = Logger.getLogger("VoiceBridge-SVC")

    @Volatile
    private var serverApi: VoicechatServerApi? = null

    private var loggedMissingApi = false

    val isApiReady: Boolean
        get() = serverApi != null

    var pvAdapter: PvAdapter? = null

    private class OutboundChannel(
        val channel: EntityAudioChannel,
        val usingPlayerUuid: Boolean
    )

    // EntityAudioChannels for relaying PV/Web player audio to SVC clients.
    // Key: speaker UUID, Value: channel that SVC clients listen to.
    private val outboundChannels = ConcurrentHashMap<UUID, OutboundChannel>()

    init {
        // Register this plugin with SVC's Bukkit service
        registerWithSvc()
    }

    private fun registerWithSvc() {
        val service = Bukkit.getServicesManager()
            .load(BukkitVoicechatService::class.java)
        if (service != null) {
            service.registerPlugin(this)
            logger.info("Registered Voice Web Bridge as SVC plugin")
        } else {
            logger.warning("BukkitVoicechatService not available — SVC may not be fully loaded yet")
        }
    }

    override fun getPluginId(): String = "voice-web-bridge"

    override fun initialize(api: VoicechatApi) {
        if (api is VoicechatServerApi) {
            this.serverApi = api
            loggedMissingApi = false
            logger.info("SVC server API initialized")
        }
    }

    override fun registerEvents(registration: EventRegistration) {
        registration.registerEvent(VoicechatServerStartedEvent::class.java, ::onServerStarted)
        registration.registerEvent(MicrophonePacketEvent::class.java, ::onMicrophonePacket)
        registration.registerEvent(PlayerConnectedEvent::class.java, ::onPlayerConnected)
        registration.registerEvent(PlayerDisconnectedEvent::class.java, ::onPlayerDisconnected)
    }

    // --- Event Handlers ---

    private fun onServerStarted(event: VoicechatServerStartedEvent) {
        this.serverApi = event.voicechat
        loggedMissingApi = false
        logger.info("SVC server started — VoicechatServerApi ready")
        plugin.webAdapter?.resyncVoiceConnections()
    }

    private fun onPlayerConnected(event: PlayerConnectedEvent) {
        if (serverApi == null) {
            serverApi = event.voicechat
            loggedMissingApi = false
        }
        val connection = event.connection
        val playerUuid = connection.player.uuid
        val bukkitPlayer = connection.player.player as? Player
        val playerName = bukkitPlayer?.name ?: playerUuid.toString()

        // Register this player as an SVC user
        plugin.sessionManager.register(playerUuid, playerName, ModType.SIMPLE_VOICE_CHAT)
        logger.info("SVC player connected: $playerName")

        // Register a fake UDP connection in PV so PV clients see a voice icon
        pvAdapter?.registerBridgedConnection(playerUuid)
        plugin.audioRelay.webAdapter?.broadcastPlayerList()
    }

    private fun onPlayerDisconnected(event: PlayerDisconnectedEvent) {
        val playerUuid = event.playerUuid

        // Remove the fake PV connection unless the player is still connected via web voice
        if (plugin.webAdapter?.isPlayerWebConnected(playerUuid) != true) {
            pvAdapter?.removeBridgedConnection(playerUuid)
        }

        // Remove only the SVC mod type; session is fully removed only when all mod types are gone
        plugin.sessionManager.unregister(playerUuid, ModType.SIMPLE_VOICE_CHAT)
        plugin.audioRelay.webAdapter?.broadcastPlayerList()

        // Close any outbound channels for this player
        outboundChannels.remove(playerUuid)?.let { entry ->
            entry.channel.flush()
            logger.fine("Closed outbound channel for disconnected SVC player $playerUuid")
        }

        // Signal audio end on PV side for this player's outbound source
        plugin.audioRelay.pvAdapter?.cleanupSource(playerUuid)
    }

    /**
     * Called when an SVC player sends a microphone packet.
     * Relay this audio to PV players via the AudioRelay.
     */
    private fun onMicrophonePacket(event: MicrophonePacketEvent) {
        val api = serverApi ?: event.voicechat.also {
            serverApi = it
            loggedMissingApi = false
        }
        val senderConnection = event.senderConnection ?: return
        val senderUuid = senderConnection.player.uuid
        val packet = event.packet
        val opusData = packet.opusEncodedData
        if (opusData.isEmpty()) return
        val whispering = packet.isWhispering

        // Touch session to keep it alive
        plugin.sessionManager.getSession(senderUuid)?.touch()

        // Get the Bukkit player for position info
        val bukkitPlayer = Bukkit.getPlayer(senderUuid) ?: return

        // Get the configured distance
        val distance = api.voiceChatDistance.toFloat()

        // Relay to PV players
        plugin.audioRelay.relaySvcToPv(
            senderUuid = senderUuid,
            senderPlayer = bukkitPlayer,
            opusData = opusData,
            sequenceNumber = 0, // SVC MicrophonePacket doesn't expose sequence to API
            distance = distance,
            whispering = whispering
        )
    }

    // --- Outbound: Send audio FROM a PV/Web player TO SVC clients ---

    /**
     * Send audio from a PV or browser player to nearby SVC clients using EntityAudioChannel.
     *
     * @return true if audio was sent successfully
     */
    fun sendAudioFromExternalPlayer(
        senderUuid: UUID,
        senderPlayer: Player,
        opusData: ByteArray,
        sequenceNumber: Long,
        distance: Float
    ): Boolean {
        val api = serverApi
        if (api == null) {
            if (!loggedMissingApi) {
                loggedMissingApi = true
                logger.warning("Cannot relay audio to SVC: SVC serverApi is null (did VoicechatServerStartedEvent fire?)")
            }
            return false
        }

        // Ensure non-SVC speakers are marked connected so SVC clients show them connected
        // and don't auto-close channels keyed by their player UUID.
        val svcConn = api.getConnectionOf(senderUuid)
        if (svcConn != null && !svcConn.isInstalled && !svcConn.isConnected) {
            svcConn.isConnected = true
        }

        // Prefer the speaker's player UUID as channelId so SVC's per-player volume/mute works.
        // If SVC still considers the speaker disconnected (for example, a player who has the SVC
        // mod installed on their client but is disconnected from SVC UDP and using the web page
        // as fallback), fall back to a synthetic channelId so SVC clients don't auto-close the
        // channel on arrival.
        val usePlayerUuid = svcConn?.isConnected == true

        var entry = outboundChannels[senderUuid]
        if (entry != null && entry.usingPlayerUuid != usePlayerUuid) {
            outboundChannels.remove(senderUuid, entry)
            entry.channel.flush()
            entry = null
        }

        if (entry == null) {
            val entity = api.fromEntity(senderPlayer)
            val channelId = if (usePlayerUuid) {
                senderUuid
            } else {
                UUID.nameUUIDFromBytes("voice-web-bridge-$senderUuid".toByteArray())
            }
            val newChannel = api.createEntityAudioChannel(channelId, entity)
            if (newChannel == null) {
                logger.warning("Failed to create EntityAudioChannel for external speaker $senderUuid")
                BridgeMetrics.droppedFrames.incrementAndGet()
                return false
            }
            newChannel.distance = distance
            // Target SVC listeners. Exclude dual-mod listeners only when the speaker has
            // Plasmo Voice natively (dual-mod players hear PV speakers natively in PV).
            // For web-only speakers, PV's source excludes dual-mod, so SVC delivers to them once.
            newChannel.setFilter { serverPlayer ->
                val listenerSession = plugin.sessionManager.getSession(serverPlayer.uuid)
                if (listenerSession == null || !listenerSession.hasModType(ModType.SIMPLE_VOICE_CHAT)) {
                    false
                } else if (listenerSession.isDualMod()) {
                    plugin.sessionManager.getSession(senderUuid)?.hasModType(ModType.PLASMO_VOICE) != true
                } else {
                    true
                }
            }
            val created = OutboundChannel(newChannel, usePlayerUuid)
            outboundChannels[senderUuid] = created
            entry = created
        }

        // The SVC API requires refreshing the bound entity for players after death/respawn.
        // A stale entity would throw on send and leave the speaker silent until they rejoin.
        entry.channel.updateEntity(api.fromEntity(senderPlayer))
        entry.channel.distance = distance
        entry.channel.send(opusData)
        return true
    }

    /**
     * Clean up resources for a speaker who stopped talking.
     */
    fun flushChannel(senderUuid: UUID) {
        outboundChannels[senderUuid]?.channel?.flush()
    }

    /**
     * Remove channel for a player (e.g., on disconnect).
     */
    fun removeChannel(senderUuid: UUID) {
        outboundChannels.remove(senderUuid)?.channel?.flush()
    }

    /**
     * Mark a non-SVC player as connected/disconnected in SVC's player state.
     * This updates the voice icon for SVC clients.
     * Only works for players without the SVC mod installed (i.e., PV-only or browser players).
     */
    fun setExternalPlayerConnected(playerUuid: UUID, connected: Boolean) {
        val api = serverApi
        if (api == null) {
            logger.warning("Cannot set SVC connected=$connected for $playerUuid: SVC serverApi is not initialized")
            return
        }
        val conn = api.getConnectionOf(playerUuid)
        if (conn == null) {
            logger.warning("Cannot set SVC connected=$connected for $playerUuid: no SVC VoicechatConnection found")
            return
        }
        if (connected && conn.isInstalled && !conn.isConnected) {
            logger.info(
                "Player $playerUuid has the Simple Voice Chat mod installed on their client but is disconnected " +
                    "from SVC UDP — SVC does not allow plugins to clear the disconnected icon for modded clients, " +
                    "but bridged audio will still be delivered via a fallback channel."
            )
            return
        }
        conn.isConnected = connected
        // If connected state changed, reset any cached channel so the channel ID strategy matches.
        outboundChannels[playerUuid]?.let { existing ->
            if (existing.usingPlayerUuid != conn.isConnected) {
                outboundChannels.remove(playerUuid, existing)
                existing.channel.flush()
            }
        }
    }

    fun shutdown() {
        outboundChannels.values.forEach { it.channel.flush() }
        outboundChannels.clear()
        logger.info("SVC adapter shut down")
    }
}
