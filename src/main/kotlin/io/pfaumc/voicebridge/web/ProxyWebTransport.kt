package io.pfaumc.voicebridge.web

import io.pfaumc.voicebridge.VoiceBridgePlugin
import io.pfaumc.voicebridge.config.BridgeConfig
import org.java_websocket.client.WebSocketClient
import org.java_websocket.handshake.ServerHandshake
import java.io.File
import java.net.URI
import java.nio.ByteBuffer
import java.nio.charset.StandardCharsets
import java.security.SecureRandom
import java.util.Properties
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.logging.Logger

/**
 * Virtual browser connection multiplexed over [ProxyWebTransport]'s single tunnel WebSocket.
 */
class ProxiedWebConnection(
    val clientId: Int,
    private val transport: ProxyWebTransport
) : WebClientConnection {

    private val openFlag = AtomicBoolean(true)

    override val isOpen: Boolean
        get() = openFlag.get() && transport.isTunnelReady

    fun markClosed() {
        openFlag.set(false)
    }

    override fun sendText(text: String) {
        if (!openFlag.get()) return
        transport.sendClientText(clientId, text)
    }

    override fun sendBinary(data: ByteArray) {
        if (!openFlag.get()) return
        transport.sendClientBinary(clientId, data)
    }

    override fun close(code: Int, reason: String) {
        if (!openFlag.compareAndSet(true, false)) return
        transport.closeClient(clientId, code, reason)
    }
}

/**
 * Outbound WebSocket tunnel transport connecting the Minecraft server plugin to a hosted
 * Node.js Voice Web Bridge proxy over a single WebSocket (`ws://` or `wss://`).
 *
 * - Supports both `ws://`/`http://` and `wss://`/`https://` proxy endpoints.
 * - Persists a random `serverId` + `serverSecret` in `proxy-identity.properties` so player
 *   links stay valid across reconnects/restarts without requiring auth tokens.
 * - Multiplexes all browser voice clients over the single tunnel and uses `MULTI_BINARY` /
 *   `MULTI_TEXT` fan-out so each Opus frame is transmitted only once per speaking tick.
 */
class ProxyWebTransport(
    private val plugin: VoiceBridgePlugin,
    private val config: BridgeConfig,
    private val adapter: WebAdapter
) : WebTransport {

    private val logger = Logger.getLogger("VoiceBridge-Proxy")

    private val runningFlag = AtomicBoolean(false)
    private val tunnelReadyFlag = AtomicBoolean(false)
    private val reconnectAttempts = AtomicInteger(0)

    private val clients = ConcurrentHashMap<Int, ProxiedWebConnection>()

    @Volatile
    private var executor: ScheduledExecutorService? = null

    @Volatile
    private var reconnectTask: ScheduledFuture<*>? = null

    @Volatile
    private var activeTunnel: TunnelSocket? = null

    @Volatile
    private var normalizedUri: URI? = null

    @Volatile
    private var identity: ProxyIdentity = loadOrCreateIdentity(plugin.dataFolder, config.webProxyServerId)

    @Volatile
    private var assignedServerId: String = identity.serverId

    @Volatile
    private var proxyLinkTemplate: String? = null

    @Volatile
    private var lastError: String? = null

    override val isRunning: Boolean
        get() = runningFlag.get()

    val isTunnelReady: Boolean
        get() = tunnelReadyFlag.get() && (activeTunnel?.isOpen == true)

    override fun start() {
        val rawUrl = config.webProxyUrl
        val uri = normalizeProxyUri(rawUrl)
        if (uri == null) {
            lastError = "Invalid web.proxy.url: '$rawUrl'"
            logger.severe("Cannot start proxy mode — $lastError")
            return
        }

        identity = loadOrCreateIdentity(plugin.dataFolder, config.webProxyServerId)
        assignedServerId = identity.serverId
        normalizedUri = uri
        lastError = null
        reconnectAttempts.set(0)

        if (!runningFlag.compareAndSet(false, true)) return

        val exec = Executors.newSingleThreadScheduledExecutor { r ->
            Thread(r, "VoiceBridge-ProxyTunnel").apply { isDaemon = true }
        }
        executor = exec

        logger.info("Starting proxy web voice transport -> $uri (serverId=$assignedServerId)")
        exec.execute { connectNow() }
    }

    override fun stop() {
        if (!runningFlag.compareAndSet(true, false)) return

        tunnelReadyFlag.set(false)
        reconnectTask?.cancel(false)
        reconnectTask = null

        val tunnel = activeTunnel
        activeTunnel = null

        detachAllClients(notifyAdapter = false)

        if (tunnel != null) {
            try {
                tunnel.close(1000, "Server stopped")
            } catch (_: Exception) {
            }
        }

        executor?.shutdownNow()
        executor = null
        logger.info("Proxy web voice transport stopped")
    }

    override fun buildSessionLink(sessionId: UUID): String? {
        val overrideTemplate = plugin.bridgeConfig.webProxyLinkTemplate
        val template = when {
            overrideTemplate.isNotBlank() -> overrideTemplate
            !proxyLinkTemplate.isNullOrBlank() -> proxyLinkTemplate!!
            else -> deriveFallbackLinkTemplate(normalizedUri, assignedServerId)
        } ?: return null

        return template
            .replace("{serverId}", assignedServerId)
            .replace("{uuid}", sessionId.toString())
    }

    override fun sendTextBatch(targets: Collection<WebClientConnection>, text: String) {
        val tunnel = activeTunnel ?: return
        if (!tunnelReadyFlag.get() || !tunnel.isOpen) return

        val ids = extractOpenClientIds(targets)
        if (ids.isEmpty()) return

        val frame = if (ids.size == 1) {
            ProxyTunnelProtocol.encodeClientText(ids[0], text)
        } else {
            ProxyTunnelProtocol.encodeMultiText(ids, text)
        }
        val sent = sendTunnelBinary(tunnel, frame)
        debugLog { "Proxy -> clients TEXT count=${ids.size} len=${text.length} sent=$sent" }
    }

    override fun sendBinaryBatch(targets: Collection<WebClientConnection>, data: ByteArray): Pair<Int, Int> {
        val tunnel = activeTunnel ?: return 0 to targets.size
        if (!tunnelReadyFlag.get() || !tunnel.isOpen) return 0 to targets.size

        val ids = extractOpenClientIds(targets)
        if (ids.isEmpty()) return 0 to 0

        val frame = if (ids.size == 1) {
            ProxyTunnelProtocol.encodeClientBinary(ids[0], data)
        } else {
            ProxyTunnelProtocol.encodeMultiBinary(ids, data)
        }
        val ok = sendTunnelBinary(tunnel, frame)
        debugLog { "Proxy -> clients BINARY count=${ids.size} bytes=${data.size} sent=$ok" }
        return if (ok) {
            ids.size to 0
        } else {
            0 to ids.size
        }
    }

    override fun statusSummary(): String {
        val target = normalizedUri?.toString() ?: config.webProxyUrl.ifBlank { "<unconfigured>" }
        val state = when {
            isTunnelReady -> "connected, id=$assignedServerId"
            runningFlag.get() -> "reconnecting" + (lastError?.let { ": $it" } ?: "")
            else -> "stopped" + (lastError?.let { ": $it" } ?: "")
        }
        return "proxy ($target — $state)"
    }

    // --- Internal send helpers used by ProxiedWebConnection ---

    internal fun sendClientText(clientId: Int, text: String) {
        val tunnel = activeTunnel ?: return
        if (!tunnelReadyFlag.get() || !tunnel.isOpen) return
        val ok = sendTunnelBinary(tunnel, ProxyTunnelProtocol.encodeClientText(clientId, text))
        debugLog { "Proxy -> client#$clientId TEXT len=${text.length} sent=$ok" }
    }

    internal fun sendClientBinary(clientId: Int, data: ByteArray) {
        val tunnel = activeTunnel ?: return
        if (!tunnelReadyFlag.get() || !tunnel.isOpen) return
        val ok = sendTunnelBinary(tunnel, ProxyTunnelProtocol.encodeClientBinary(clientId, data))
        debugLog { "Proxy -> client#$clientId BINARY bytes=${data.size} sent=$ok" }
    }

    internal fun closeClient(clientId: Int, code: Int, reason: String) {
        clients.remove(clientId)?.markClosed()
        val tunnel = activeTunnel ?: return
        if (!tunnelReadyFlag.get() || !tunnel.isOpen) return
        val ok = sendTunnelBinary(tunnel, ProxyTunnelProtocol.encodeClientClose(clientId, code, reason))
        debugLog { "Proxy -> client#$clientId CLOSE code=$code reason=$reason sent=$ok" }
    }

    // --- Connection & reconnect logic ---

    private fun connectNow() {
        if (!runningFlag.get()) return
        val uri = normalizedUri ?: return

        val previous = activeTunnel
        if (previous != null) {
            try {
                previous.close()
            } catch (_: Exception) {
            }
        }

        val socket = TunnelSocket(uri)
        activeTunnel = socket
        debugLog { "Opening proxy tunnel -> $uri (serverId=$assignedServerId)" }
        try {
            socket.connect()
        } catch (ex: Exception) {
            lastError = ex.message ?: ex.javaClass.simpleName
            logger.warning("Failed to initiate proxy tunnel connection to $uri: $lastError")
            scheduleReconnect()
        }
    }

    private fun scheduleReconnect() {
        if (!runningFlag.get()) return
        val exec = executor ?: return
        if (exec.isShutdown) return

        val attempt = reconnectAttempts.incrementAndGet()
        val baseSeconds = config.webProxyReconnectDelaySeconds.coerceAtLeast(1L)
        val shift = (attempt - 1).coerceAtMost(4)
        val delaySeconds = (baseSeconds shl shift).coerceAtMost(60L)

        reconnectTask?.cancel(false)
        logger.info("Reconnecting to voice proxy in ${delaySeconds}s (attempt #$attempt)...")
        reconnectTask = exec.schedule({ connectNow() }, delaySeconds, TimeUnit.SECONDS)
    }

    private fun detachAllClients(notifyAdapter: Boolean) {
        val snapshot = clients.values.toList()
        clients.clear()
        for (conn in snapshot) {
            conn.markClosed()
            if (notifyAdapter) {
                try {
                    adapter.onDisconnect(conn)
                } catch (_: Exception) {
                }
            }
        }
    }

    private fun sendTunnelBinary(tunnel: TunnelSocket, frame: ByteArray): Boolean {
        return try {
            if (!tunnel.isOpen) return false
            tunnel.send(frame)
            true
        } catch (_: Exception) {
            false
        }
    }

    private fun extractOpenClientIds(targets: Collection<WebClientConnection>): IntArray {
        val ids = IntArray(targets.size)
        var n = 0
        for (conn in targets) {
            if (conn is ProxiedWebConnection && conn.isOpen) {
                ids[n++] = conn.clientId
            }
        }
        return if (n == ids.size) ids else ids.copyOf(n)
    }

    // --- Incoming tunnel frame handling ---

    private fun handleTunnelText(socket: TunnelSocket, message: String) {
        if (socket !== activeTunnel) return
        val type = extractJsonString(message, "type")
        when (type) {
            "welcome" -> {
                val remoteId = extractJsonString(message, "serverId")
                val remoteTemplate = extractJsonString(message, "linkTemplate")
                if (!remoteId.isNullOrBlank()) {
                    assignedServerId = remoteId
                }
                if (!remoteTemplate.isNullOrBlank()) {
                    proxyLinkTemplate = remoteTemplate
                }
                tunnelReadyFlag.set(true)
                reconnectAttempts.set(0)
                lastError = null
                logger.info(
                    "Connected to voice proxy (serverId=$assignedServerId, link=${proxyLinkTemplate ?: "fallback"})"
                )
            }
            "error" -> {
                val err = extractJsonString(message, "message") ?: "Unknown proxy error"
                lastError = err
                logger.warning("Voice proxy error: $err")
            }
            else -> {
                debugLog { "Ignoring unknown proxy control message: ${message.take(80)}" }
            }
        }
    }

    private fun handleTunnelBinary(socket: TunnelSocket, buffer: ByteBuffer) {
        if (socket !== activeTunnel || !tunnelReadyFlag.get()) return
        if (buffer.remaining() < 5) return

        val opcode = buffer.get()
        val clientId = buffer.int

        when (opcode) {
            ProxyTunnelProtocol.OP_CLIENT_OPEN -> {
                val sessionStr = readRemainingUtf8(buffer)
                val sessionUuid = parseUuidOrNull(sessionStr)
                debugLog { "Proxy <- CLIENT_OPEN clientId=$clientId session=${sessionStr.take(64)}" }
                val conn = ProxiedWebConnection(clientId, this)
                clients.put(clientId, conn)?.let { old ->
                    old.markClosed()
                    adapter.onDisconnect(old)
                }
                adapter.onConnect(sessionUuid, conn)
            }
            ProxyTunnelProtocol.OP_CLIENT_CLOSE -> {
                debugLog { "Proxy <- CLIENT_CLOSE clientId=$clientId" }
                val conn = clients.remove(clientId) ?: return
                conn.markClosed()
                adapter.onDisconnect(conn)
            }
            ProxyTunnelProtocol.OP_CLIENT_TEXT -> {
                val conn = clients[clientId] ?: return
                val text = readRemainingUtf8(buffer)
                debugLog { "Proxy <- CLIENT_TEXT clientId=$clientId len=${text.length}" }
                adapter.onText(conn, text)
            }
            ProxyTunnelProtocol.OP_CLIENT_BINARY -> {
                val conn = clients[clientId] ?: return
                val bytes = ByteArray(buffer.remaining())
                buffer.get(bytes)
                debugLog { "Proxy <- CLIENT_BINARY clientId=$clientId bytes=${bytes.size}" }
                adapter.onBinary(conn, bytes)
            }
            else -> {
                debugLog { "Ignoring unknown tunnel opcode: 0x%02x".format(opcode) }
            }
        }
    }

    private inline fun debugLog(message: () -> String) {
        if (plugin.bridgeConfig.debug) {
            logger.info("[Debug] ${message()}")
        }
    }

    private inner class TunnelSocket(uri: URI) : WebSocketClient(uri) {
        init {
            isTcpNoDelay = true
            connectionLostTimeout = 30
        }

        override fun onOpen(handshakedata: ServerHandshake) {
            if (this !== activeTunnel) {
                try {
                    close(1000, "Stale tunnel")
                } catch (_: Exception) {
                }
                return
            }
            @Suppress("DEPRECATION")
            val version = plugin.description.version
            val hello = buildString {
                append("""{"type":"hello","protocol":""")
                append(ProxyTunnelProtocol.PROTOCOL_VERSION)
                append(""","serverId":"""")
                append(escapeJson(identity.serverId))
                append("""","serverSecret":"""")
                append(escapeJson(identity.serverSecret))
                append("""","pluginVersion":"""")
                append(escapeJson(version.take(32)))
                append(""""}""")
            }
            try {
                send(hello)
                debugLog { "Proxy tunnel opened; sent hello (protocol=${ProxyTunnelProtocol.PROTOCOL_VERSION}, serverId=${identity.serverId}, version=$version)" }
            } catch (ex: Exception) {
                lastError = ex.message
                logger.warning("Failed to send proxy hello: ${ex.message}")
            }
        }

        override fun onMessage(message: String) {
            handleTunnelText(this, message)
        }

        override fun onMessage(bytes: ByteBuffer) {
            try {
                handleTunnelBinary(this, bytes)
            } catch (ex: Exception) {
                logger.warning("Error handling proxy tunnel binary frame: ${ex.javaClass.simpleName}: ${ex.message}")
            }
        }

        override fun onClose(code: Int, reason: String, remote: Boolean) {
            if (this !== activeTunnel) return
            tunnelReadyFlag.set(false)
            detachAllClients(notifyAdapter = true)
            if (runningFlag.get()) {
                val detail = reason.ifBlank { "code $code" }
                lastError = detail
                logger.warning("Voice proxy tunnel disconnected ($detail)")
                scheduleReconnect()
            }
        }

        override fun onError(ex: Exception) {
            if (this !== activeTunnel) return
            lastError = ex.message ?: ex.javaClass.simpleName
            logger.warning("Voice proxy tunnel error: $lastError")
        }
    }

    // --- Identity & URI helpers ---

    private data class ProxyIdentity(val serverId: String, val serverSecret: String)

    companion object {
        private val SERVER_ID_REGEX = Regex("^[a-zA-Z0-9_-]{6,32}$")
        private val SECRET_REGEX = Regex("^[0-9a-f]{32,128}$")
        private const val ID_ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
        private val secureRandom = SecureRandom()

        /**
         * Normalizes `ws://`, `wss://`, `http://`, or `https://` proxy URLs into a valid
         * WebSocket [URI], defaulting an empty or root path to `/bridge-ws`.
         */
        fun normalizeProxyUri(raw: String): URI? {
            val trimmed = raw.trim()
            if (trimmed.isEmpty()) return null
            val withWsScheme = when {
                trimmed.startsWith("http://", ignoreCase = true) -> "ws://" + trimmed.substring(7)
                trimmed.startsWith("https://", ignoreCase = true) -> "wss://" + trimmed.substring(8)
                trimmed.startsWith("ws://", ignoreCase = true) -> trimmed
                trimmed.startsWith("wss://", ignoreCase = true) -> trimmed
                else -> return null
            }
            return try {
                val parsed = URI.create(withWsScheme)
                if (parsed.host.isNullOrBlank()) return null
                val path = parsed.rawPath
                if (path.isNullOrEmpty() || path == "/") {
                    URI(
                        parsed.scheme,
                        parsed.rawUserInfo,
                        parsed.host,
                        parsed.port,
                        "/bridge-ws",
                        parsed.rawQuery,
                        null
                    )
                } else {
                    parsed
                }
            } catch (_: Exception) {
                null
            }
        }

        private fun deriveFallbackLinkTemplate(tunnelUri: URI?, serverId: String): String? {
            if (tunnelUri == null) return null
            val httpScheme = if (tunnelUri.scheme.equals("wss", ignoreCase = true)) "https" else "http"
            val portPart = if (tunnelUri.port != -1) ":${tunnelUri.port}" else ""
            return "$httpScheme://${tunnelUri.host}$portPart/voicechat.html?id=$serverId.{uuid}"
        }

        private fun loadOrCreateIdentity(dataFolder: File, configuredServerId: String): ProxyIdentity {
            val file = File(dataFolder, "proxy-identity.properties")
            val props = Properties()
            if (file.exists()) {
                try {
                    file.inputStream().use { props.load(it) }
                } catch (_: Exception) {
                }
            }

            var storedId = props.getProperty("serverId")?.trim().orEmpty()
            var storedSecret = props.getProperty("serverSecret")?.trim()?.lowercase().orEmpty()
            var dirty = false

            if (!SERVER_ID_REGEX.matches(storedId)) {
                storedId = generateRandomId(12)
                dirty = true
            }
            if (!SECRET_REGEX.matches(storedSecret)) {
                storedSecret = generateRandomHex(32)
                dirty = true
            }

            if (dirty) {
                try {
                    dataFolder.mkdirs()
                    props.setProperty("serverId", storedId)
                    props.setProperty("serverSecret", storedSecret)
                    file.outputStream().use {
                        props.store(it, "Auto-generated Voice Web Bridge proxy identity. Do not share serverSecret.")
                    }
                } catch (_: Exception) {
                }
            }

            val effectiveId = if (SERVER_ID_REGEX.matches(configuredServerId)) configuredServerId else storedId
            return ProxyIdentity(effectiveId, storedSecret)
        }

        private fun generateRandomId(length: Int): String = buildString(length) {
            repeat(length) {
                append(ID_ALPHABET[secureRandom.nextInt(ID_ALPHABET.length)])
            }
        }

        private fun generateRandomHex(numBytes: Int): String {
            val bytes = ByteArray(numBytes)
            secureRandom.nextBytes(bytes)
            return buildString(numBytes * 2) {
                for (b in bytes) {
                    val v = b.toInt() and 0xFF
                    append("0123456789abcdef"[v ushr 4])
                    append("0123456789abcdef"[v and 0x0F])
                }
            }
        }

        private fun readRemainingUtf8(buffer: ByteBuffer): String {
            if (!buffer.hasRemaining()) return ""
            val bytes = ByteArray(buffer.remaining())
            buffer.get(bytes)
            return String(bytes, StandardCharsets.UTF_8)
        }

        private fun parseUuidOrNull(raw: String): UUID? {
            return try {
                if (raw.isBlank()) null else UUID.fromString(raw.trim())
            } catch (_: Exception) {
                null
            }
        }

        private fun extractJsonString(json: String, key: String): String? {
            val regex = Regex(""""${Regex.escape(key)}"\s*:\s*"((?:\\.|[^"\\])*)"""")
            val raw = regex.find(json)?.groupValues?.getOrNull(1) ?: return null
            return raw
                .replace("\\\"", "\"")
                .replace("\\\\", "\\")
                .replace("\\/", "/")
        }

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
    }
}
