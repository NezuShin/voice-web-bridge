package io.pfaumc.voicebridge

import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong
import java.util.logging.Logger

object BridgeMetrics {
    val activeSessions = AtomicInteger(0)
    val svcToPlasmoFrames = AtomicLong(0)
    val plasmoToSvcFrames = AtomicLong(0)
    val droppedFrames = AtomicLong(0)
    val transcodingCount = AtomicLong(0)
    val webActiveSessions = AtomicInteger(0)
    val webToGameFrames = AtomicLong(0)
    val gameToWebFrames = AtomicLong(0)
    val webDroppedFrames = AtomicLong(0)

    fun reset() {
        activeSessions.set(0)
        svcToPlasmoFrames.set(0)
        plasmoToSvcFrames.set(0)
        droppedFrames.set(0)
        transcodingCount.set(0)
        webActiveSessions.set(0)
        webToGameFrames.set(0)
        gameToWebFrames.set(0)
        webDroppedFrames.set(0)
    }

    fun log(logger: Logger) {
        logger.info(
            "Bridge metrics: sessions=${activeSessions.get()}, " +
                "svc->pv=${svcToPlasmoFrames.get()}, " +
                "pv->svc=${plasmoToSvcFrames.get()}, " +
                "dropped=${droppedFrames.get()}, " +
                "transcoded=${transcodingCount.get()}, " +
                "webSessions=${webActiveSessions.get()}, " +
                "web->game=${webToGameFrames.get()}, " +
                "game->web=${gameToWebFrames.get()}, " +
                "webDropped=${webDroppedFrames.get()}"
        )
    }
}
