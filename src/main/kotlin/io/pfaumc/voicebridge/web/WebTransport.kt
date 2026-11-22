package io.pfaumc.voicebridge.web

import org.java_websocket.WebSocket
import java.util.UUID
import java.util.logging.Logger

/**
 * Transport-agnostic representation of a single browser voice client.
 *
 * Implemented both for direct embedded WebSocket connections ([DirectWebConnection])
 * and for virtual multiplexed connections over a remote Node.js proxy tunnel
 * ([ProxiedWebConnection]).
 */
interface WebClientConnection {
    val isOpen: Boolean
    fun sendText(text: String)
    fun sendBinary(data: ByteArray)
    fun close(code: Int, reason: String)
}

/**
 * Transport layer owned by [WebAdapter]. Abstracts how browser clients connect to
 * the plugin so self-hosted embedded WebSocket mode and outbound proxy tunnel mode
 * share all session, audio, and in-game control logic.
 */
interface WebTransport {
    val isRunning: Boolean
    fun start()
    fun stop()

    /**
     * Builds the clickable browser link for [sessionId].
     */
    fun buildSessionLink(sessionId: UUID): String?

    /**
     * Sends the same text payload to every open client in [targets].
     * Proxy transport overrides this to emit a single `MULTI_TEXT` frame.
     */
    fun sendTextBatch(targets: Collection<WebClientConnection>, text: String) {
        for (conn in targets) {
            try {
                if (conn.isOpen) conn.sendText(text)
            } catch (_: Exception) {
            }
        }
    }

    /**
     * Sends the same binary audio envelope to every open client in [targets].
     * Proxy transport overrides this to emit a single `MULTI_BINARY` frame.
     *
     * @return pair of (deliveredCount, droppedCount)
     */
    fun sendBinaryBatch(targets: Collection<WebClientConnection>, data: ByteArray): Pair<Int, Int> {
        var sent = 0
        var dropped = 0
        for (conn in targets) {
            if (!conn.isOpen) continue
            try {
                conn.sendBinary(data)
                sent++
            } catch (_: Exception) {
                dropped++
            }
        }
        return sent to dropped
    }

    /**
     * Human-readable one-line status for `/vb status` and `/vb reload`.
     */
    fun statusSummary(): String
}

/**
 * Direct browser connection backed by a real [WebSocket] from [WebVoiceServer].
 */
class DirectWebConnection(private val socket: WebSocket) : WebClientConnection {
    override val isOpen: Boolean get() = socket.isOpen

    override fun sendText(text: String) {
        socket.send(text)
    }

    override fun sendBinary(data: ByteArray) {
        socket.send(data)
    }

    override fun close(code: Int, reason: String) {
        socket.close(code, reason)
    }
}

/**
 * Self-hosted transport that runs the embedded [WebVoiceServer] locally.
 */
class DirectWebTransport(
    private val host: String,
    private val port: Int,
    private val linkTemplateProvider: () -> String,
    private val adapter: WebAdapter
) : WebTransport {

    private val logger = Logger.getLogger("VoiceBridge-Web")

    @Volatile
    private var server: WebVoiceServer? = null

    override val isRunning: Boolean
        get() = server != null

    override fun start() {
        val wsServer = WebVoiceServer(host, port, adapter)
        server = wsServer
        logger.info("Starting self-hosted web voice WebSocket server on $host:$port")
        wsServer.start()
    }

    override fun stop() {
        val wsServer = server
        server = null
        if (wsServer != null) {
            try {
                wsServer.stop(1000)
            } catch (_: InterruptedException) {
                Thread.currentThread().interrupt()
            } catch (_: Exception) {
            }
        }
        logger.info("Self-hosted web voice WebSocket server stopped")
    }

    override fun buildSessionLink(sessionId: UUID): String =
        linkTemplateProvider().replace("{uuid}", sessionId.toString())

    override fun statusSummary(): String = "self-hosted ($host:$port)"
}
