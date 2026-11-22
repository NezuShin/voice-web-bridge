package io.pfaumc.voicebridge

import io.pfaumc.voicebridge.adapter.PvAdapter
import io.pfaumc.voicebridge.adapter.SvcAdapter
import io.pfaumc.voicebridge.command.MicCommand
import io.pfaumc.voicebridge.command.VoiceBridgeCommand
import io.pfaumc.voicebridge.config.BridgeConfig
import io.pfaumc.voicebridge.config.Message
import io.pfaumc.voicebridge.relay.AudioRelay
import io.pfaumc.voicebridge.session.ModType
import io.pfaumc.voicebridge.session.SessionManager
import io.pfaumc.voicebridge.spatial.SpatialMapper
import io.pfaumc.voicebridge.util.SchedulerUtil
import io.pfaumc.voicebridge.web.WebAdapter
import kotlinx.coroutines.*
import org.bstats.bukkit.Metrics
import org.bstats.charts.AdvancedPie
import org.bstats.charts.SimplePie
import org.bstats.charts.SingleLineChart
import org.bukkit.plugin.java.JavaPlugin
import kotlin.time.Duration.Companion.seconds

class VoiceBridgePlugin : JavaPlugin() {

    lateinit var bridgeConfig: BridgeConfig
        private set
    lateinit var sessionManager: SessionManager
        private set
    lateinit var spatialMapper: SpatialMapper
        private set
    lateinit var audioRelay: AudioRelay
        private set
    lateinit var metrics: Metrics
        private set

    private var svcAdapter: SvcAdapter? = null
    private var pvAdapter: PvAdapter? = null
    internal var webAdapter: WebAdapter? = null
        private set

    private val scope = CoroutineScope(
        SupervisorJob() + CoroutineName("VoiceBridge")
    )

    override fun onEnable() {
        instance = this

        // Load config and messages
        bridgeConfig = BridgeConfig.load(this)
        Message.load(this, bridgeConfig.language, bridgeConfig.allowConfigUpdates)
        if (!bridgeConfig.enabled) {
            logger.info("Voice Web Bridge is disabled in config")
            return
        }

        // Initialize core components
        sessionManager = SessionManager()
        spatialMapper = SpatialMapper(bridgeConfig)
        audioRelay = AudioRelay(sessionManager, spatialMapper, bridgeConfig)

        // Initialize adapters
        val svcAvailable = initSvcAdapter()
        val pvAvailable = initPvAdapter()

        if (!svcAvailable && !pvAvailable) {
            logger.warning("Neither Simple Voice Chat nor Plasmo Voice detected. Bridge has nothing to do.")
            return
        }
        if (!svcAvailable) {
            logger.warning("Simple Voice Chat not detected. Bridge will not function without both mods.")
            return
        }
        if (!pvAvailable) {
            logger.warning("Plasmo Voice not detected. Bridge will not function without both mods.")
            return
        }

        // Wire adapters to relay
        audioRelay.svcAdapter = svcAdapter
        audioRelay.pvAdapter = pvAdapter

        // Wire cross-adapter references for connection icon bridging
        svcAdapter?.pvAdapter = pvAdapter
        pvAdapter?.svcAdapter = svcAdapter

        // Start the browser voice page WebSocket server
        webAdapter = WebAdapter(this)
        audioRelay.webAdapter = webAdapter
        webAdapter?.start()

        // Start cleanup coroutine
        scope.launch {
            while (isActive) {
                delay(5.seconds)
                sessionManager.cleanup()
            }
        }

        // Register commands
        registerCommands()

        // Register bStats custom charts
        setupMetrics()

        logger.info("Voice Web Bridge enabled — bridging Simple Voice Chat <-> Plasmo Voice <-> Web")
        BridgeMetrics.log(logger)
    }

    override fun onDisable() {
        webAdapter?.stop()
        svcAdapter?.shutdown()
        pvAdapter?.shutdown()
        if (::sessionManager.isInitialized) {
            sessionManager.clear()
        }
        SchedulerUtil.cancelAllTasks(this)
        scope.cancel()
        logger.info("Voice Web Bridge disabled")
    }

    /**
     * Reloads config.yml and language files and applies the new values at runtime.
     *
     * @return true if the web voice server was (re)started because web settings changed
     */
    fun reloadBridgeConfig(): Boolean {
        bridgeConfig = BridgeConfig.load(this)
        Message.load(this, bridgeConfig.language, bridgeConfig.allowConfigUpdates)
        spatialMapper.config = bridgeConfig
        audioRelay.config = bridgeConfig
        val webRestarted = webAdapter?.reconfigure(bridgeConfig) ?: false
        logger.info("Voice Web Bridge config reloaded")
        return webRestarted
    }

    private fun setupMetrics() {
        metrics = Metrics(this, 35526)

        // Player counts
        metrics.addCustomChart(SingleLineChart("svc_players") {
            sessionManager.getSessionsByMod(ModType.SIMPLE_VOICE_CHAT).size
        })
        metrics.addCustomChart(SingleLineChart("pv_players") {
            sessionManager.getSessionsByMod(ModType.PLASMO_VOICE).size
        })
        metrics.addCustomChart(SingleLineChart("dual_mod_players") {
            sessionManager.getAllSessions().count { it.isDualMod() }
        })

        // Distribution of connected players across voice clients.
        // Dual-mod players are counted once in "Both mods"; web-only players in "Web".
        metrics.addCustomChart(AdvancedPie("voice_mod_distribution") {
            val dual = sessionManager.getAllSessions().count { it.isDualMod() }
            val svcOnly = sessionManager.getSessionsByMod(ModType.SIMPLE_VOICE_CHAT).size - dual
            val pvOnly = sessionManager.getSessionsByMod(ModType.PLASMO_VOICE).size - dual
            val webOnly = webAdapter?.getConnectedWebPlayers()?.keys?.count { !sessionManager.isRegistered(it) } ?: 0
            mutableMapOf(
                "Simple Voice Chat" to svcOnly,
                "Plasmo Voice" to pvOnly,
                "Both mods" to dual,
                "Web" to webOnly
            )
        })
        metrics.addCustomChart(SingleLineChart("bridged_sessions") {
            BridgeMetrics.activeSessions.get()
        })
        metrics.addCustomChart(SingleLineChart("web_players") {
            webAdapter?.getConnectedWebPlayers()?.size ?: 0
        })

        // Config values
        metrics.addCustomChart(SimplePie("default_distance") {
            bridgeConfig.defaultDistance.toString()
        })
        metrics.addCustomChart(SimplePie("passthrough_mode") {
            if (bridgeConfig.passthrough) "passthrough" else "transcode"
        })
    }

    private fun registerCommands() {
        val adminCommand = VoiceBridgeCommand(this)
        getCommand("voicebridge")?.apply {
            setExecutor(adminCommand)
            tabCompleter = adminCommand
        } ?: logger.warning("Command 'voicebridge' is missing from plugin.yml")

        val micCommand = MicCommand(this)
        getCommand("mic")?.apply {
            setExecutor(micCommand)
            tabCompleter = micCommand
        } ?: logger.warning("Command 'mic' is missing from plugin.yml")
    }

    private fun initSvcAdapter(): Boolean {
        return try {
            Class.forName("de.maxhenkel.voicechat.api.VoicechatPlugin")
            svcAdapter = SvcAdapter(this)
            logger.info("Simple Voice Chat detected — SVC adapter initialized")
            true
        } catch (e: ClassNotFoundException) {
            logger.info("Simple Voice Chat not found on classpath")
            false
        }
    }

    private fun initPvAdapter(): Boolean {
        return try {
            Class.forName("su.plo.voice.api.server.PlasmoVoiceServer")
            pvAdapter = PvAdapter(this)
            logger.info("Plasmo Voice detected — PV adapter initialized")
            true
        } catch (e: ClassNotFoundException) {
            logger.info("Plasmo Voice not found on classpath")
            false
        }
    }

    companion object {
        lateinit var instance: VoiceBridgePlugin
            private set
    }
}
