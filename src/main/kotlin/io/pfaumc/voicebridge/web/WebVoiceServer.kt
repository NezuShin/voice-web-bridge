package io.pfaumc.voicebridge.web

import org.java_websocket.WebSocket
import org.java_websocket.handshake.ClientHandshake
import org.java_websocket.server.WebSocketServer
import java.net.InetSocketAddress
import java.net.URI
import java.nio.ByteBuffer
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.logging.Logger

/**
 * Embedded WebSocket server (Java-WebSocket) for the self-hosted browser voice page.
 *
 * - Accepts connections with `?id=<session-uuid>` query parameter.
 * - Binary messages are raw Opus frames (one frame per message).
 * - All callbacks run on the library's worker threads; every downstream send
 *   (mod adapters) is non-blocking, matching the threading rules in SPEC.md.
 */
class WebVoiceServer(
    host: String,
    port: Int,
    private val adapter: WebAdapter
) : WebSocketServer(InetSocketAddress(host, port)) {

    private val logger = Logger.getLogger("VoiceBridge-WebServer")
    private val connections = ConcurrentHashMap<WebSocket, DirectWebConnection>()

    init {
        // Voice frames must not be delayed by Nagle buffering.
        isTcpNoDelay = true
    }

    override fun onStart() {
        logger.info("Web voice WebSocket server started on ${address.hostString}:${address.port}")
    }

    override fun onOpen(conn: WebSocket, handshake: ClientHandshake) {
        val wrapped = DirectWebConnection(conn)
        connections[conn] = wrapped
        adapter.onConnect(parseSessionId(handshake.resourceDescriptor), wrapped)
    }

    override fun onMessage(conn: WebSocket, message: String) {
        val wrapped = connections[conn] ?: return
        adapter.onText(wrapped, message)
    }

    override fun onMessage(conn: WebSocket, message: ByteBuffer) {
        val wrapped = connections[conn] ?: return
        val bytes = ByteArray(message.remaining())
        message.get(bytes)
        adapter.onBinary(wrapped, bytes)
    }

    override fun onClose(conn: WebSocket, code: Int, reason: String, remote: Boolean) {
        val wrapped = connections.remove(conn) ?: return
        adapter.onDisconnect(wrapped)
    }

    override fun onError(conn: WebSocket?, ex: Exception) {
        if (conn == null) {
            logger.warning("Web voice server error: ${ex.message}")
        } else {
            adapter.debugLog { "Web voice connection error: ${ex.message}" }
        }
    }

    /**
     * Extracts the session UUID from the request query string (`?id=<uuid>`).
     * Returns null when the parameter is missing or malformed.
     */
    private fun parseSessionId(resourceDescriptor: String): UUID? {
        return try {
            val query = URI.create(resourceDescriptor).query ?: return null
            query.split('&')
                .firstOrNull { it.startsWith("id=") }
                ?.substring(3)
                ?.takeIf { it.isNotEmpty() }
                ?.let { UUID.fromString(it) }
        } catch (_: Exception) {
            null
        }
    }
}
