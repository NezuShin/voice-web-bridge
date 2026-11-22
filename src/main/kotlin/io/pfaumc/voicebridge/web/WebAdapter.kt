package io.pfaumc.voicebridge.web

import io.pfaumc.voicebridge.BridgeMetrics
import io.pfaumc.voicebridge.VoiceBridgePlugin
import io.pfaumc.voicebridge.adapter.PvAdapter
import io.pfaumc.voicebridge.adapter.SvcAdapter
import io.pfaumc.voicebridge.config.BridgeConfig
import io.pfaumc.voicebridge.config.WebMode
import io.pfaumc.voicebridge.session.ModType
import net.kyori.adventure.text.Component
import net.kyori.adventure.text.event.ClickEvent
import net.kyori.adventure.text.event.HoverEvent
import net.kyori.adventure.text.format.NamedTextColor
import net.kyori.adventure.text.format.TextDecoration
import org.bukkit.Bukkit
import org.bukkit.entity.Player
import org.bukkit.event.EventHandler
import org.bukkit.event.HandlerList
import org.bukkit.event.Listener
import org.bukkit.event.player.PlayerDropItemEvent
import org.bukkit.event.player.PlayerInputEvent
import org.bukkit.event.player.PlayerJoinEvent
import org.bukkit.event.player.PlayerQuitEvent
import org.bukkit.event.player.PlayerSwapHandItemsEvent
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.logging.Logger

/**
 * Browser voice page adapter.
 *
 * Each player gets a random per-join session UUID. After a configurable delay the player
 * receives a clickable link: `<link-template>` with `{uuid}` replaced. The browser page
 * connects to the embedded WebSocket server with this id.
 *
 * Audio flow:
 * - Browser mic (raw Opus 48 kHz / 20 ms frames) → relayed to nearby SVC and PV players
 *   through the existing `sendAudioFromExternalPlayer` paths (repacing, encryption and
 *   sequence numbers are handled there), and forwarded directly to nearby web listeners.
 * - Nearby SVC/PV players speaking → `AudioRelay` fans out to `broadcastToWebListeners`,
 *   which sends `[0x02][speakerUuid][opus]` frames to every in-range web page.
 *
 * Wire protocol (documented in webpage/README.md):
 * - C→S binary: raw Opus frame (one per message, max 1500 bytes)
 * - S→C binary: [0x02][16-byte speaker player-UUID][Opus frame]
 * - S→C text:   {"type":"info"|"error","message":"..."}
 * - Close codes: 1000 normal quit, 4001 replaced by a new page, 4004 session not found
 */
class WebAdapter(private val plugin: VoiceBridgePlugin) : Listener {

    private val logger = Logger.getLogger("VoiceBridge-Web")

    private enum class IngameTrigger {
        OFF,
        DOUBLE_SHIFT,
        DOUBLE_CTRL,
        SHIFT_F,
        SHIFT_Q;

        companion object {
            fun fromKey(raw: String?): IngameTrigger = when (raw?.lowercase()) {
                "double_shift" -> DOUBLE_SHIFT
                "double_ctrl" -> DOUBLE_CTRL
                "shift_f", "sneak_swap_mic" -> SHIFT_F
                "shift_q" -> SHIFT_Q
                else -> OFF
            }
        }
    }

    private class WebSession(
        val sessionId: UUID,
        val playerUuid: UUID,
        val playerName: String,
        @Volatile var conn: WebClientConnection? = null,
        @Volatile var ingameTrigger: IngameTrigger = IngameTrigger.OFF,
        @Volatile var prevSneakInput: Boolean = false,
        @Volatile var prevSprintInput: Boolean = false,
        @Volatile var lastShiftPressMs: Long = 0L,
        @Volatile var lastCtrlPressMs: Long = 0L
    )

    // sessionId -> session, playerUuid -> sessionId, connection -> session
    private val sessions = ConcurrentHashMap<UUID, WebSession>()
    private val byPlayer = ConcurrentHashMap<UUID, UUID>()
    private val byConn = ConcurrentHashMap<WebClientConnection, WebSession>()

    @Volatile
    private var transport: WebTransport? = null

    // Web settings the currently running transport was started with; null when disabled.
    // Compared on config reload to decide whether the transport must be restarted.
    @Volatile
    private var activeWebConfig: BridgeConfig? = null

    private val svcAdapter: SvcAdapter? get() = plugin.audioRelay.svcAdapter
    private val pvAdapter: PvAdapter? get() = plugin.audioRelay.pvAdapter

    fun statusSummary(): String = transport?.statusSummary() ?: "disabled"

    fun isPlayerWebConnected(playerUuid: UUID): Boolean =
        activeSessionFor(playerUuid)?.conn?.isOpen == true

    fun getConnectedWebPlayers(): Map<UUID, String> {
        val out = LinkedHashMap<UUID, String>()
        for (session in sessions.values) {
            if (session.conn?.isOpen == true) {
                out[session.playerUuid] = session.playerName
            }
        }
        return out
    }

    fun resyncVoiceConnections() {
        for (session in sessions.values) {
            if (session.conn?.isOpen == true) {
                registerVoiceConnected(session.playerUuid)
            }
        }
    }

    // --- Lifecycle ---

    fun start() {
        val cfg = plugin.bridgeConfig
        if (!cfg.webEnabled) {
            logger.info("Web voice page disabled in config")
            return
        }
        // Idempotent listener registration — start() may run again after a reload restart
        HandlerList.unregisterAll(this)
        plugin.server.pluginManager.registerEvents(this, plugin)

        val nextTransport: WebTransport = when (cfg.webMode) {
            WebMode.SELF_HOSTED -> DirectWebTransport(
                host = cfg.webHost,
                port = cfg.webPort,
                linkTemplateProvider = { plugin.bridgeConfig.webLinkTemplate },
                adapter = this
            )
            WebMode.PROXY -> ProxyWebTransport(
                plugin = plugin,
                config = cfg,
                adapter = this
            )
        }
        transport = nextTransport
        nextTransport.start()
        activeWebConfig = cfg
        // Players already online never fire PlayerJoinEvent (boot after a plugin reload,
        // or a web transport restart) — reserve their sessions and send them fresh links.
        ensureSessionsForOnlinePlayers()
    }

    fun stop() {
        HandlerList.unregisterAll(this)
        for (session in sessions.values) {
            val conn = session.conn ?: continue
            try {
                conn.sendText(infoJson("Server stopped"))
                conn.close(CLOSE_NORMAL, "Server stopped")
            } catch (_: Exception) {
            }
        }
        transport?.stop()
        transport = null
        sessions.clear()
        byPlayer.clear()
        byConn.clear()
        BridgeMetrics.webActiveSessions.set(0)
        activeWebConfig = null
    }

    /**
     * Applies a freshly loaded config. The web transport is restarted only when the
     * active transport settings actually changed — an unrelated reload must not
     * kick connected browser sessions. Returns true if the transport was (re)started.
     */
    fun reconfigure(newConfig: BridgeConfig): Boolean {
        val current = activeWebConfig
        val changed = if (current == null) {
            newConfig.webEnabled
        } else if (current.webEnabled != newConfig.webEnabled || current.webMode != newConfig.webMode) {
            true
        } else {
            when (newConfig.webMode) {
                WebMode.SELF_HOSTED ->
                    current.webHost != newConfig.webHost || current.webPort != newConfig.webPort
                WebMode.PROXY ->
                    current.webProxyUrl != newConfig.webProxyUrl ||
                        current.webProxyServerId != newConfig.webProxyServerId ||
                        current.webProxyReconnectDelaySeconds != newConfig.webProxyReconnectDelaySeconds
            }
        }
        if (!changed) return false

        logger.info("Web voice settings changed — restarting web transport")
        stop()
        start()
        return true
    }

    // --- Player lifecycle ---

    @EventHandler
    fun onPlayerJoin(event: PlayerJoinEvent) {
        reserveSession(event.player)
        // Delay 1 tick so Bukkit.getOnlinePlayers() includes the newly joined player.
        plugin.server.globalRegionScheduler.runDelayed(plugin, { _ ->
            broadcastPlayerList()
        }, 1L)
    }

    /**
     * Reserves a web session for a player and schedules the link message.
     */
    private fun reserveSession(player: Player) {
        val sessionId = UUID.randomUUID()
        sessions[sessionId] = WebSession(sessionId, player.uniqueId, player.name)
        byPlayer.put(player.uniqueId, sessionId)?.let { stale ->
            sessions.remove(stale)
        }
        BridgeMetrics.webActiveSessions.incrementAndGet()
        logger.info("Web voice session ${sessionId} reserved for ${player.name}")

        val delayTicks = plugin.bridgeConfig.webLinkDelaySeconds.coerceAtLeast(0) * 20L
        plugin.server.globalRegionScheduler.runDelayed(plugin, { _ ->
            sendLinkIfActive(player.uniqueId, sessionId)
        }, delayTicks)
    }

    /**
     * Creates sessions for players who are online but have none yet. Used after the web
     * transport (re)starts, because PlayerJoinEvent only fires for new joins.
     */
    private fun ensureSessionsForOnlinePlayers() {
        if (transport == null) return
        for (player in Bukkit.getOnlinePlayers()) {
            if (byPlayer.containsKey(player.uniqueId)) continue
            reserveSession(player)
        }
    }

    @EventHandler
    fun onPlayerQuit(event: PlayerQuitEvent) {
        val sessionId = byPlayer.remove(event.player.uniqueId) ?: return
        val session = sessions.remove(sessionId) ?: return
        BridgeMetrics.webActiveSessions.decrementAndGet()

        val conn = session.conn
        if (conn != null) {
            byConn.remove(conn)
            session.conn = null
            try {
                conn.sendText(infoJson("Player left the game"))
                conn.close(CLOSE_NORMAL, "Player left the game")
            } catch (_: Exception) {
            }
        }
        unregisterVoiceConnected(session.playerUuid)
        cleanupGameAudio(session.playerUuid)
        broadcastPlayerList(excludeUuid = event.player.uniqueId)
        logger.info("Web voice session $sessionId removed (${event.player.name} quit)")
    }

    @EventHandler
    fun onPlayerInput(event: PlayerInputEvent) {
        val session = activeSessionFor(event.player.uniqueId) ?: return
        val input = event.input
        val nowSneak = input.isSneak
        val nowSprint = input.isSprint
        val wasSneak = session.prevSneakInput
        val wasSprint = session.prevSprintInput
        session.prevSneakInput = nowSneak
        session.prevSprintInput = nowSprint

        val conn = session.conn ?: return
        val now = System.currentTimeMillis()

        when (session.ingameTrigger) {
            IngameTrigger.DOUBLE_SHIFT -> {
                if (!wasSneak && nowSneak) {
                    val prev = session.lastShiftPressMs
                    if (prev != 0L && now - prev <= DOUBLE_TAP_WINDOW_MS) {
                        session.lastShiftPressMs = 0L
                        triggerMicToggleFromIngame(event.player, conn)
                    } else {
                        session.lastShiftPressMs = now
                    }
                }
            }
            IngameTrigger.DOUBLE_CTRL -> {
                if (!wasSprint && nowSprint) {
                    val prev = session.lastCtrlPressMs
                    if (prev != 0L && now - prev <= DOUBLE_TAP_WINDOW_MS) {
                        session.lastCtrlPressMs = 0L
                        triggerMicToggleFromIngame(event.player, conn)
                    } else {
                        session.lastCtrlPressMs = now
                    }
                }
            }
            else -> {}
        }
    }

    @EventHandler(ignoreCancelled = true)
    fun onPlayerSwapHandItems(event: PlayerSwapHandItemsEvent) {
        val session = activeSessionFor(event.player.uniqueId) ?: return
        if (session.ingameTrigger != IngameTrigger.SHIFT_F) return
        if (!event.player.isSneaking && !session.prevSneakInput) return
        val conn = session.conn ?: return
        event.isCancelled = true
        triggerMicToggleFromIngame(event.player, conn)
    }

    @EventHandler(ignoreCancelled = true)
    fun onPlayerDropItem(event: PlayerDropItemEvent) {
        val session = activeSessionFor(event.player.uniqueId) ?: return
        if (session.ingameTrigger != IngameTrigger.SHIFT_Q) return
        if (!event.player.isSneaking && !session.prevSneakInput) return
        val conn = session.conn ?: return
        event.isCancelled = true
        triggerMicToggleFromIngame(event.player, conn)
    }

    private fun triggerMicToggleFromIngame(player: Player, conn: WebClientConnection) {
        sendSafe(conn, """{"type":"control","action":"mic_toggle"}""")
        player.sendActionBar(
            Component.text("[Voice] ", NamedTextColor.GOLD)
                .append(Component.text("Microphone toggled", NamedTextColor.AQUA))
        )
    }

    private fun sendLinkIfActive(playerUuid: UUID, sessionId: UUID) {
        val session = sessions[sessionId] ?: return
        if (session.playerUuid != playerUuid) return
        if (byPlayer[playerUuid] != sessionId) return
        val player = Bukkit.getPlayer(playerUuid) ?: return

        val link = transport?.buildSessionLink(sessionId) ?: return
        player.sendMessage(
            Component.text("[", NamedTextColor.GRAY)
                .append(Component.text("Voice", NamedTextColor.GOLD, TextDecoration.BOLD))
                .append(Component.text("] ", NamedTextColor.GRAY))
                .append(Component.text("Voice chat page: ", NamedTextColor.GRAY))
                .append(
                    Component.text(link, NamedTextColor.AQUA, TextDecoration.UNDERLINED)
                        .clickEvent(ClickEvent.openUrl(link))
                        .hoverEvent(
                            HoverEvent.showText(
                                Component.text("Click to open the voice chat page", NamedTextColor.GRAY)
                            )
                        )
                )
        )
        logger.fine("Link sent to ${player.name}: $link")
    }

    // --- WebSocket lifecycle (called from transport worker threads) ---

    /**
     * Validates and registers a connection for a session id.
     * Missing/unknown id → JSON error + close(4004).
     * Existing connection → informed with a message and closed with 4001.
     */
    fun onConnect(sessionId: UUID?, conn: WebClientConnection) {
        if (sessionId == null) {
            reject(conn, "Missing id parameter")
            return
        }
        val session = sessions[sessionId] ?: run {
            reject(conn, "Session not found")
            return
        }

        val old = session.conn
        if (old != null && old !== conn) {
            byConn.remove(old)
            try {
                old.sendText(infoJson("New page opened; closing this connection"))
                old.close(CLOSE_REPLACED, "New page opened")
            } catch (_: Exception) {
            }
        }

        session.conn = conn
        byConn[conn] = session
        sendSafe(conn, infoJson("Connected as ${session.playerName}"))
        sendSafe(conn, welcomeJson(session))
        registerVoiceConnected(session.playerUuid)
        broadcastPlayerList()
        logger.info("Web page connected for ${session.playerName} (session ${session.sessionId})")
    }

    fun onBinary(conn: WebClientConnection, opus: ByteArray) {
        if (opus.isEmpty() || opus.size > MAX_FRAME_BYTES) {
            BridgeMetrics.webDroppedFrames.incrementAndGet()
            return
        }
        val session = byConn[conn] ?: return
        val player = Bukkit.getPlayer(session.playerUuid) ?: return
        plugin.sessionManager.getSession(session.playerUuid)?.touch()

        val cfg = plugin.bridgeConfig
        val distance = plugin.spatialMapper.getEffectiveDistance(cfg.defaultDistance, player.world)

        // Skip a mod's leg when the player has that mod installed natively —
        // their in-game mic already reaches those listeners (avoids double audio).
        val mods = plugin.sessionManager.getSession(session.playerUuid)
        val routedToPv = mods?.hasModType(ModType.PLASMO_VOICE) != true && pvAdapter != null
        val routedToSvc = mods?.hasModType(ModType.SIMPLE_VOICE_CHAT) != true && svcAdapter != null

        var sent = false
        if (routedToPv) {
            try {
                val pvDistance = plugin.spatialMapper.svcToPvDistance(distance.toFloat(), player.world)
                sent = pvAdapter?.sendAudioFromExternalPlayer(
                    session.playerUuid, player, opus, 0L, pvDistance
                ) == true
            } catch (ex: Exception) {
                logger.warning("Failed to relay web audio to PV for ${session.playerName}: ${ex.message}")
            }
        }
        if (routedToSvc) {
            try {
                sent = svcAdapter?.sendAudioFromExternalPlayer(
                    session.playerUuid, player, opus, 0L, distance.toFloat()
                ) == true || sent
            } catch (ex: Exception) {
                logger.warning("Failed to relay web audio to SVC for ${session.playerName}: ${ex.message}")
            }
        }
        if (sent) BridgeMetrics.webToGameFrames.incrementAndGet()

        // Direct web-to-web proximity forwarding. Skip any listener who already
        // receives this audio natively via SVC or PV so mod users who also keep
        // the web page open do not hear double audio.
        broadcastToWebListeners(
            speakerUuid = session.playerUuid,
            speakerPlayer = player,
            opusData = opus,
            distanceBlocks = distance,
            shouldSkipListener = { listenerUuid ->
                val listenerMods = plugin.sessionManager.getSession(listenerUuid)
                if (listenerMods == null) {
                    false
                } else if (listenerMods.isDualMod()) {
                    // Dual-mod listeners receive web-speaker audio via SVC when routedToSvc and speaker has no PV.
                    routedToSvc && mods?.hasModType(ModType.PLASMO_VOICE) != true
                } else {
                    (routedToPv && listenerMods.hasModType(ModType.PLASMO_VOICE)) ||
                        (routedToSvc && listenerMods.hasModType(ModType.SIMPLE_VOICE_CHAT))
                }
            }
        )
    }

    fun onText(conn: WebClientConnection, text: String) {
        val session = byConn[conn] ?: return
        when (extractJsonString(text, "type")) {
            "config" -> {
                val trigger = IngameTrigger.fromKey(extractJsonString(text, "ingameTrigger"))
                session.ingameTrigger = trigger
                session.lastShiftPressMs = 0L
                session.lastCtrlPressMs = 0L
                logger.fine("Updated in-game trigger for ${session.playerName}: $trigger")
            }
            "mic_state" -> {
                val muted = extractJsonBoolean(text, "muted") ?: return
                val notify = extractJsonBoolean(text, "notify") == true
                if (notify) {
                    val player = Bukkit.getPlayer(session.playerUuid) ?: return
                    val stateText = if (muted) {
                        Component.text("Mic: OFF", NamedTextColor.RED)
                    } else {
                        Component.text("Mic: ON", NamedTextColor.GREEN)
                    }
                    player.scheduler.run(plugin, { _ ->
                        player.sendActionBar(
                            Component.text("[Voice] ", NamedTextColor.GOLD).append(stateText)
                        )
                    }, null)
                }
            }
            "request_players" -> {
                sendSafe(conn, buildPlayersJson())
            }
            else -> {
                logger.fine("Ignoring text message from web client: ${text.take(64)}")
            }
        }
    }

    /**
     * A web page disconnected.
     *
     * The session itself is KEPT — it belongs to the player's game session and is
     * only removed on quit. This makes page reloads work: the old connection is
     * detached here and the new one takes over in [onConnect].
     */
    fun onDisconnect(conn: WebClientConnection) {
        val session = byConn.remove(conn) ?: return
        // Only act if this connection is still the active one
        // (a replaced connection's close event must not touch the new page).
        if (session.conn !== conn) return
        session.conn = null
        unregisterVoiceConnected(session.playerUuid)
        cleanupGameAudio(session.playerUuid)
        broadcastPlayerList()
        logger.info("Web page disconnected for ${session.playerName} (session ${session.sessionId})")
    }

    /**
     * Triggers a control action (e.g. "mic_toggle") from an in-game command.
     * Returns true if the player has an active connected web page; otherwise resends their link.
     */
    fun triggerControlFromCommand(player: Player, action: String): Boolean {
        val session = activeSessionFor(player.uniqueId)
        val conn = session?.conn
        if (conn != null) {
            sendSafe(conn, """{"type":"control","action":"${escapeJson(action)}"}""")
            return true
        }
        val sessionId = byPlayer[player.uniqueId]
        if (sessionId != null) {
            sendLinkIfActive(player.uniqueId, sessionId)
        }
        return false
    }

    /**
     * Broadcasts the current online server player list (with voice mod/web status)
     * to every connected browser page.
     */
    fun broadcastPlayerList(excludeUuid: UUID? = null) {
        val targets = byConn.keys.toList()
        if (targets.isEmpty()) return
        val payload = buildPlayersJson(excludeUuid)
        transport?.sendTextBatch(targets, payload)
    }

    // --- Outbound: game / web → web pages ---

    /**
     * Sends one Opus frame to every web page whose bound player is in range of [speakerPlayer].
     *
     * @param skipMod listeners who have this mod installed are skipped — they hear this
     *                audio leg natively in-game and would otherwise get double audio.
     */
    fun broadcastToWebListeners(
        speakerUuid: UUID,
        speakerPlayer: Player,
        opusData: ByteArray,
        distanceBlocks: Double,
        skipMod: ModType
    ) {
        broadcastToWebListeners(
            speakerUuid = speakerUuid,
            speakerPlayer = speakerPlayer,
            opusData = opusData,
            distanceBlocks = distanceBlocks,
            shouldSkipListener = { listenerUuid ->
                plugin.sessionManager.getSession(listenerUuid)?.hasModType(skipMod) == true
            }
        )
    }

    /**
     * Sends one Opus frame to every in-range web listener not excluded by [shouldSkipListener].
     */
    fun broadcastToWebListeners(
        speakerUuid: UUID,
        speakerPlayer: Player,
        opusData: ByteArray,
        distanceBlocks: Double,
        shouldSkipListener: (UUID) -> Boolean
    ) {
        val currentTransport = transport ?: return
        if (sessions.isEmpty()) return
        val speakerLoc = speakerPlayer.location
        val maxDistSq = distanceBlocks * distanceBlocks

        val targets = ArrayList<WebClientConnection>(4)
        for (session in sessions.values) {
            if (session.playerUuid == speakerUuid) continue
            val conn = session.conn ?: continue
            if (!conn.isOpen) continue
            if (shouldSkipListener(session.playerUuid)) continue
            val listener = Bukkit.getPlayer(session.playerUuid) ?: continue
            if (listener.world != speakerLoc.world) continue
            if (listener.location.distanceSquared(speakerLoc) > maxDistSq) continue
            targets.add(conn)
        }
        if (targets.isEmpty()) return

        val (sent, dropped) = currentTransport.sendBinaryBatch(targets, audioEnvelope(speakerUuid, opusData))
        if (sent > 0) BridgeMetrics.gameToWebFrames.addAndGet(sent.toLong())
        if (dropped > 0) BridgeMetrics.webDroppedFrames.addAndGet(dropped.toLong())
    }

    // --- Helpers ---

    /**
     * Marks the browser-bound player as voice-connected in both mods so clients
     * show a voice icon and treat the player as an audio source. Skipped for a
     * mod the player has installed natively — their in-game connection already
     * provides it.
     */
    private fun registerVoiceConnected(playerUuid: UUID) {
        val mods = plugin.sessionManager.getSession(playerUuid)
        if (mods?.hasModType(ModType.PLASMO_VOICE) != true) {
            try {
                pvAdapter?.registerBridgedConnection(playerUuid)
            } catch (ex: Exception) {
                logger.warning("Failed to register PV bridged connection for $playerUuid: ${ex.message}")
            }
        }
        if (mods?.hasModType(ModType.SIMPLE_VOICE_CHAT) != true) {
            try {
                svcAdapter?.setExternalPlayerConnected(playerUuid, true)
            } catch (ex: Exception) {
                logger.warning("Failed to mark SVC player connected for $playerUuid: ${ex.message}")
            }
        }
    }

    private fun unregisterVoiceConnected(playerUuid: UUID) {
        val mods = plugin.sessionManager.getSession(playerUuid)
        if (mods?.hasModType(ModType.PLASMO_VOICE) != true) {
            try {
                pvAdapter?.removeBridgedConnection(playerUuid)
            } catch (ex: Exception) {
                logger.warning("Failed to remove PV bridged connection for $playerUuid: ${ex.message}")
            }
        }
        if (mods?.hasModType(ModType.SIMPLE_VOICE_CHAT) != true) {
            try {
                svcAdapter?.setExternalPlayerConnected(playerUuid, false)
            } catch (ex: Exception) {
                logger.warning("Failed to mark SVC player disconnected for $playerUuid: ${ex.message}")
            }
        }
    }

    private fun cleanupGameAudio(playerUuid: UUID) {
        svcAdapter?.removeChannel(playerUuid)
        pvAdapter?.cleanupSource(playerUuid)
    }

    private fun reject(conn: WebClientConnection, message: String) {
        try {
            conn.sendText(errorJson(message))
            conn.close(CLOSE_NOT_FOUND, message)
        } catch (_: Exception) {
        }
    }

    private fun audioEnvelope(speakerUuid: UUID, opus: ByteArray): ByteArray {
        val out = ByteArray(1 + 16 + opus.size)
        out[0] = MSG_AUDIO
        val msb = speakerUuid.mostSignificantBits
        val lsb = speakerUuid.leastSignificantBits
        for (i in 0 until 8) out[1 + i] = (msb ushr (56 - 8 * i)).toByte()
        for (i in 0 until 8) out[9 + i] = (lsb ushr (56 - 8 * i)).toByte()
        System.arraycopy(opus, 0, out, 17, opus.size)
        return out
    }

    private fun activeSessionFor(playerUuid: UUID): WebSession? {
        val sessionId = byPlayer[playerUuid] ?: return null
        return sessions[sessionId]
    }

    private fun sendSafe(conn: WebClientConnection, message: String) {
        try {
            if (conn.isOpen) conn.sendText(message)
        } catch (_: Exception) {
        }
    }

    private fun welcomeJson(session: WebSession): String =
        """{"type":"welcome","playerUuid":"${session.playerUuid}","playerName":"${escapeJson(session.playerName)}","capabilities":["players","ingame_mic"]}"""

    private fun buildPlayersJson(excludeUuid: UUID? = null): String {
        val online = try {
            Bukkit.getOnlinePlayers().toList()
        } catch (_: Exception) {
            emptyList()
        }
        val sb = StringBuilder()
        sb.append("""{"type":"players","players":[""")
        var first = true
        for (p in online) {
            val uuid = p.uniqueId
            if (excludeUuid != null && uuid == excludeUuid) continue
            if (!first) sb.append(',')
            first = false

            val modSession = plugin.sessionManager.getSession(uuid)
            val hasSvc = modSession?.hasModType(ModType.SIMPLE_VOICE_CHAT) == true
            val hasPv = modSession?.hasModType(ModType.PLASMO_VOICE) == true
            val hasWeb = activeSessionFor(uuid)?.conn != null
            val hasVoice = hasSvc || hasPv || hasWeb

            sb.append("""{"uuid":"$uuid","name":"${escapeJson(p.name)}","mods":[""")
            var modFirst = true
            if (hasSvc) {
                sb.append("\"SVC\"")
                modFirst = false
            }
            if (hasPv) {
                if (!modFirst) sb.append(',')
                sb.append("\"PV\"")
            }
            sb.append("""],"web":$hasWeb,"voice":$hasVoice}""")
        }
        sb.append("]}")
        return sb.toString()
    }

    private fun extractJsonString(json: String, key: String): String? {
        val regex = Regex(""""${Regex.escape(key)}"\s*:\s*"((?:\\.|[^"\\])*)"""")
        return regex.find(json)?.groupValues?.getOrNull(1)
    }

    private fun extractJsonBoolean(json: String, key: String): Boolean? {
        val regex = Regex(""""${Regex.escape(key)}"\s*:\s*(true|false)""")
        return regex.find(json)?.groupValues?.getOrNull(1)?.toBooleanStrictOrNull()
    }

    private fun infoJson(message: String) = json("info", message)
    private fun errorJson(message: String) = json("error", message)

    private fun json(type: String, message: String): String =
        """{"type":"$type","message":"${escapeJson(message)}"}"""

    private fun escapeJson(s: String): String = buildString {
        for (c in s) when (c) {
            '"' -> append("\\\"")
            '\\' -> append("\\\\")
            '\n' -> append("\\n")
            '\r' -> append("\\r")
            '\t' -> append("\\t")
            else -> if (c < ' ') append("\\u%04x".format(c.code)) else append(c)
        }
    }

    companion object {
        private const val MAX_FRAME_BYTES = 1500
        private const val DOUBLE_TAP_WINDOW_MS = 450L
        private const val MSG_AUDIO: Byte = 0x02
        private const val CLOSE_NORMAL = 1000
        private const val CLOSE_REPLACED = 4001
        private const val CLOSE_NOT_FOUND = 4004
    }
}
