package io.pfaumc.voicebridge.web

import java.nio.ByteBuffer
import java.nio.charset.StandardCharsets

/**
 * Binary multiplexing protocol shared between [ProxyWebTransport] and the Node.js proxy.
 *
 * Single-client frame layout:
 * - `[0x01][clientId: u32 BE][sessionUuid: UTF-8]`                         (Proxy -> Plugin: CLIENT_OPEN)
 * - `[0x02][clientId: u32 BE][closeCode: u16 BE][reason: UTF-8]`           (Bidirectional: CLIENT_CLOSE)
 * - `[0x03][clientId: u32 BE][json: UTF-8]`                                (Bidirectional: CLIENT_TEXT)
 * - `[0x04][clientId: u32 BE][binary payload]`                             (Bidirectional: CLIENT_BINARY)
 *
 * Multi-client fan-out layout (Plugin -> Proxy):
 * - `[0x05][count: u16 BE][clientId_1: u32 BE ... clientId_N: u32 BE][binary payload]` (MULTI_BINARY)
 * - `[0x06][count: u16 BE][clientId_1: u32 BE ... clientId_N: u32 BE][json: UTF-8]`    (MULTI_TEXT)
 */
object ProxyTunnelProtocol {
    const val PROTOCOL_VERSION = 1

    const val OP_CLIENT_OPEN: Byte = 0x01
    const val OP_CLIENT_CLOSE: Byte = 0x02
    const val OP_CLIENT_TEXT: Byte = 0x03
    const val OP_CLIENT_BINARY: Byte = 0x04
    const val OP_MULTI_BINARY: Byte = 0x05
    const val OP_MULTI_TEXT: Byte = 0x06

    private const val MAX_CLOSE_REASON_BYTES = 123

    fun encodeClientClose(clientId: Int, code: Int, reason: String): ByteArray {
        val rawReason = reason.toByteArray(StandardCharsets.UTF_8)
        val reasonLen = rawReason.size.coerceAtMost(MAX_CLOSE_REASON_BYTES)
        val buf = ByteBuffer.allocate(1 + 4 + 2 + reasonLen)
        buf.put(OP_CLIENT_CLOSE)
        buf.putInt(clientId)
        buf.putShort((code and 0xFFFF).toShort())
        if (reasonLen > 0) {
            buf.put(rawReason, 0, reasonLen)
        }
        return buf.array()
    }

    fun encodeClientText(clientId: Int, text: String): ByteArray {
        val utf8 = text.toByteArray(StandardCharsets.UTF_8)
        val buf = ByteBuffer.allocate(1 + 4 + utf8.size)
        buf.put(OP_CLIENT_TEXT)
        buf.putInt(clientId)
        buf.put(utf8)
        return buf.array()
    }

    fun encodeClientBinary(clientId: Int, payload: ByteArray): ByteArray {
        val buf = ByteBuffer.allocate(1 + 4 + payload.size)
        buf.put(OP_CLIENT_BINARY)
        buf.putInt(clientId)
        buf.put(payload)
        return buf.array()
    }

    fun encodeMultiBinary(clientIds: IntArray, payload: ByteArray): ByteArray {
        val count = clientIds.size.coerceAtMost(0xFFFF)
        val buf = ByteBuffer.allocate(1 + 2 + count * 4 + payload.size)
        buf.put(OP_MULTI_BINARY)
        buf.putShort(count.toShort())
        for (i in 0 until count) {
            buf.putInt(clientIds[i])
        }
        buf.put(payload)
        return buf.array()
    }

    fun encodeMultiText(clientIds: IntArray, text: String): ByteArray {
        val utf8 = text.toByteArray(StandardCharsets.UTF_8)
        val count = clientIds.size.coerceAtMost(0xFFFF)
        val buf = ByteBuffer.allocate(1 + 2 + count * 4 + utf8.size)
        buf.put(OP_MULTI_TEXT)
        buf.putShort(count.toShort())
        for (i in 0 until count) {
            buf.putInt(clientIds[i])
        }
        buf.put(utf8)
        return buf.array()
    }
}
