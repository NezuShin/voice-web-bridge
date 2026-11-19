package io.pfaumc.voicebridge.relay

import io.pfaumc.voicebridge.BridgeMetrics
import io.pfaumc.voicebridge.adapter.PvAdapter
import io.pfaumc.voicebridge.adapter.SvcAdapter
import io.pfaumc.voicebridge.config.BridgeConfig
import io.pfaumc.voicebridge.session.ModType
import io.pfaumc.voicebridge.session.SessionManager
import io.pfaumc.voicebridge.spatial.SpatialMapper
import io.pfaumc.voicebridge.web.WebAdapter
import org.bukkit.entity.Player
import java.util.*
import java.util.logging.Logger

/**
 * Central audio relay that routes voice frames between the two mod adapters
 * and the browser voice page.
 *
 * Audio flow:
 * - SVC player speaks → SvcAdapter receives MicrophonePacketEvent → calls relaySvcToPv()
 * - PV player speaks → PvAdapter receives activation event → calls relayPvToSvc()
 * - Browser page speaks → WebAdapter relays via the mod adapters directly
 * - Both relay methods fan out to in-range web pages via WebAdapter
 */
class AudioRelay(
    private val sessionManager: SessionManager,
    private val spatialMapper: SpatialMapper,
    private val config: BridgeConfig
) {
    private val logger = Logger.getLogger("VoiceBridge")

    var svcAdapter: SvcAdapter? = null
    var pvAdapter: PvAdapter? = null
    var webAdapter: WebAdapter? = null

    /**
     * Relay audio from a Simple Voice Chat player to all nearby Plasmo Voice players.
     *
     * @param senderUuid UUID of the SVC player speaking
     * @param senderPlayer the Bukkit player entity of the sender
     * @param opusData Opus-encoded audio frame
     * @param sequenceNumber packet sequence number
     * @param distance hearing distance (SVC float)
     * @param whispering whether the sender is whispering
     */
    fun relaySvcToPv(
        senderUuid: UUID,
        senderPlayer: Player,
        opusData: ByteArray,
        sequenceNumber: Long,
        distance: Float,
        whispering: Boolean
    ) {
        // Fan out to web pages before the dual-mod skip — dual-mod speakers
        // must still reach browser listeners. Web listeners with SVC installed
        // are skipped (they hear this leg natively).
        webAdapter?.broadcastToWebListeners(
            speakerUuid = senderUuid,
            speakerPlayer = senderPlayer,
            opusData = opusData,
            distanceBlocks = spatialMapper.getEffectiveDistance(distance.toDouble(), senderPlayer.world),
            skipMod = ModType.SIMPLE_VOICE_CHAT
        )

        val pv = pvAdapter ?: return

        // Skip relay for dual-mod players — PV clients already hear them via PV natively
        if (sessionManager.isDualMod(senderUuid)) return

        val effectiveDistance = if (whispering) {
            spatialMapper.whisperDistance(distance.toDouble())
        } else {
            distance.toDouble()
        }
        val pvDistance = spatialMapper.svcToPvDistance(effectiveDistance.toFloat(), senderPlayer.world)

        // Let the PV adapter handle sending to nearby PV players
        val sent = pv.sendAudioFromExternalPlayer(
            senderUuid,
            senderPlayer,
            opusData,
            sequenceNumber,
            pvDistance
        )

        if (sent) {
            BridgeMetrics.svcToPlasmoFrames.incrementAndGet()
        }

        if (config.debug) {
            logger.fine("SVC->PV: ${senderPlayer.name} seq=$sequenceNumber dist=$pvDistance whisper=$whispering")
        }
    }

    /**
     * Relay audio from a Plasmo Voice player to all nearby Simple Voice Chat players.
     *
     * @param senderUuid UUID of the PV player speaking
     * @param senderPlayer the Bukkit player entity of the sender
     * @param opusData Opus-encoded audio frame
     * @param sequenceNumber packet sequence number
     * @param distance hearing distance (PV short)
     */
    fun relayPvToSvc(
        senderUuid: UUID,
        senderPlayer: Player,
        opusData: ByteArray,
        sequenceNumber: Long,
        distance: Short
    ) {
        // Fan out to web pages before the dual-mod skip. Web listeners with PV
        // installed are skipped (they hear this leg natively).
        webAdapter?.broadcastToWebListeners(
            speakerUuid = senderUuid,
            speakerPlayer = senderPlayer,
            opusData = opusData,
            distanceBlocks = spatialMapper.getEffectiveDistance(distance.toDouble(), senderPlayer.world),
            skipMod = ModType.PLASMO_VOICE
        )

        val svc = svcAdapter ?: return

        // Skip relay for dual-mod players — SVC clients already hear them via SVC natively
        if (sessionManager.isDualMod(senderUuid)) return

        val svcDistance = spatialMapper.pvToSvcDistance(distance, senderPlayer.world)

        // Let the SVC adapter handle sending to nearby SVC players
        val sent = svc.sendAudioFromExternalPlayer(
            senderUuid,
            senderPlayer,
            opusData,
            sequenceNumber,
            svcDistance
        )

        if (sent) {
            BridgeMetrics.plasmoToSvcFrames.incrementAndGet()
        }

        if (config.debug) {
            logger.fine("PV->SVC: ${senderPlayer.name} seq=$sequenceNumber dist=$svcDistance")
        }
    }
}
