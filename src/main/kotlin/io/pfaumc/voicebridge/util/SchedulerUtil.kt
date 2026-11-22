package io.pfaumc.voicebridge.util

import org.bukkit.Bukkit
import org.bukkit.entity.Entity
import org.bukkit.plugin.Plugin
import java.util.concurrent.TimeUnit

/**
 * Cross-platform scheduler abstraction for Spigot, Paper, and Folia.
 *
 * Adapted from NMinimap's SchedulerUtil: instantiates Folia's regional schedulers only
 * when Folia's RegionizedServer class is present so Spigot servers never touch Folia APIs.
 */
object SchedulerUtil {

    fun interface RunningTask {
        fun cancel()
    }

    interface Scheduler {
        fun cancelAllTasks(plugin: Plugin)
        fun sync(plugin: Plugin, task: Runnable)
        fun syncDelayed(plugin: Plugin, delayTicks: Long, task: Runnable): RunningTask
        fun async(plugin: Plugin, delayTicks: Long, task: Runnable): RunningTask
        fun asyncTimer(plugin: Plugin, delayTicks: Long, periodTicks: Long, task: Runnable): RunningTask
        fun entity(plugin: Plugin, entity: Entity, task: Runnable)
        fun entityTimer(plugin: Plugin, entity: Entity, delayTicks: Long, periodTicks: Long, task: () -> Boolean)
        val isFolia: Boolean
    }

    val scheduler: Scheduler = if (PlatformUtil.isFolia) FoliaScheduler() else SpigotScheduler()

    fun cancelAllTasks(plugin: Plugin) = scheduler.cancelAllTasks(plugin)

    fun sync(plugin: Plugin, task: () -> Unit) = scheduler.sync(plugin, Runnable(task))

    fun syncDelayed(plugin: Plugin, delayTicks: Long, task: () -> Unit): RunningTask =
        scheduler.syncDelayed(plugin, delayTicks, Runnable(task))

    fun async(plugin: Plugin, delayTicks: Long = 0L, task: () -> Unit): RunningTask =
        scheduler.async(plugin, delayTicks, Runnable(task))

    fun asyncTimer(plugin: Plugin, delayTicks: Long, periodTicks: Long, task: () -> Unit): RunningTask =
        scheduler.asyncTimer(plugin, delayTicks, periodTicks, Runnable(task))

    fun entity(plugin: Plugin, entity: Entity, task: () -> Unit) =
        scheduler.entity(plugin, entity, Runnable(task))

    private class SpigotScheduler : Scheduler {

        override fun cancelAllTasks(plugin: Plugin) {
            Bukkit.getScheduler().cancelTasks(plugin)
        }

        override fun sync(plugin: Plugin, task: Runnable) {
            Bukkit.getScheduler().runTask(plugin, task)
        }

        override fun syncDelayed(plugin: Plugin, delayTicks: Long, task: Runnable): RunningTask {
            val scheduled = if (delayTicks <= 0L) {
                Bukkit.getScheduler().runTask(plugin, task)
            } else {
                Bukkit.getScheduler().runTaskLater(plugin, task, delayTicks)
            }
            return RunningTask { scheduled.cancel() }
        }

        override fun async(plugin: Plugin, delayTicks: Long, task: Runnable): RunningTask {
            val scheduled = if (delayTicks <= 0L) {
                Bukkit.getScheduler().runTaskAsynchronously(plugin, task)
            } else {
                Bukkit.getScheduler().runTaskLaterAsynchronously(plugin, task, delayTicks)
            }
            return RunningTask { scheduled.cancel() }
        }

        override fun asyncTimer(plugin: Plugin, delayTicks: Long, periodTicks: Long, task: Runnable): RunningTask {
            val scheduled = Bukkit.getScheduler().runTaskTimerAsynchronously(plugin, task, delayTicks, periodTicks)
            return RunningTask { scheduled.cancel() }
        }

        override fun entity(plugin: Plugin, entity: Entity, task: Runnable) {
            Bukkit.getScheduler().runTask(plugin, Runnable {
                if (entity.isValid) {
                    task.run()
                }
            })
        }

        override fun entityTimer(plugin: Plugin, entity: Entity, delayTicks: Long, periodTicks: Long, task: () -> Boolean) {
            Bukkit.getScheduler().runTaskTimer(plugin, { bukkitTask ->
                if (!entity.isValid || !task()) {
                    bukkitTask.cancel()
                }
            }, delayTicks, periodTicks)
        }

        override val isFolia: Boolean = false
    }

    private class FoliaScheduler : Scheduler {

        override fun cancelAllTasks(plugin: Plugin) {
            Bukkit.getAsyncScheduler().cancelTasks(plugin)
            Bukkit.getGlobalRegionScheduler().cancelTasks(plugin)
        }

        override fun sync(plugin: Plugin, task: Runnable) {
            Bukkit.getGlobalRegionScheduler().execute(plugin, task)
        }

        override fun syncDelayed(plugin: Plugin, delayTicks: Long, task: Runnable): RunningTask {
            val scheduled = if (delayTicks <= 0L) {
                Bukkit.getGlobalRegionScheduler().run(plugin) { _ -> task.run() }
            } else {
                Bukkit.getGlobalRegionScheduler().runDelayed(plugin, { _ -> task.run() }, delayTicks)
            }
            return RunningTask { scheduled.cancel() }
        }

        override fun async(plugin: Plugin, delayTicks: Long, task: Runnable): RunningTask {
            val scheduled = if (delayTicks <= 0L) {
                Bukkit.getAsyncScheduler().runNow(plugin) { _ -> task.run() }
            } else {
                Bukkit.getAsyncScheduler().runDelayed(plugin, { _ -> task.run() }, delayTicks * 50L, TimeUnit.MILLISECONDS)
            }
            return RunningTask { scheduled.cancel() }
        }

        override fun asyncTimer(plugin: Plugin, delayTicks: Long, periodTicks: Long, task: Runnable): RunningTask {
            val scheduled = Bukkit.getAsyncScheduler().runAtFixedRate(
                plugin,
                { _ -> task.run() },
                delayTicks.coerceAtLeast(1L) * 50L,
                periodTicks.coerceAtLeast(1L) * 50L,
                TimeUnit.MILLISECONDS
            )
            return RunningTask { scheduled.cancel() }
        }

        override fun entity(plugin: Plugin, entity: Entity, task: Runnable) {
            entity.scheduler.run(plugin, { _ -> task.run() }, null)
        }

        override fun entityTimer(plugin: Plugin, entity: Entity, delayTicks: Long, periodTicks: Long, task: () -> Boolean) {
            entity.scheduler.runAtFixedRate(plugin, { scheduledTask ->
                if (!task()) {
                    scheduledTask.cancel()
                }
            }, null, delayTicks.coerceAtLeast(1L), periodTicks.coerceAtLeast(1L))
        }

        override val isFolia: Boolean = true
    }
}
