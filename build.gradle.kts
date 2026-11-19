plugins {
    idea
    alias(libs.plugins.paper)
    alias(libs.plugins.runpaper)
    alias(libs.plugins.kotlin.jvm)
    alias(libs.plugins.shadow)
}

group = project.properties["plugin.group"].toString()
version = project.properties["plugin.version"].toString()

repositories {
    mavenCentral()

    // Simple Voice Chat API
    maven("https://maven.maxhenkel.de/repository/public") {
        name = "henkelmax"
    }

    // Plasmo Voice API
    maven("https://repo.plasmoverse.com/releases") {
        name = "plasmoverse-releases"
    }
    maven("https://repo.plasmoverse.com/snapshots") {
        name = "plasmoverse-snapshots"
    }
}

dependencies {
    paperweight.paperDevBundle(project.properties["paper.version"].toString())

    // Simple Voice Chat API (provided at runtime by the mod)
    compileOnly("de.maxhenkel.voicechat:voicechat-api:${project.properties["svc.api.version"]}")

    // Plasmo Voice Server API (provided at runtime by the mod)
    compileOnly("su.plo.voice.api:server:${project.properties["plasmo.voice.version"]}")
    compileOnly("su.plo.voice.api:common:${project.properties["plasmo.voice.version"]}")
    compileOnly("su.plo.voice.api:server-proxy-common:${project.properties["plasmo.voice.version"]}")
    compileOnly("su.plo.voice:protocol:${project.properties["plasmo.voice.version"]}")
    compileOnly("su.plo.slib:api-server:1.2.0")

    compileOnly(kotlin("stdlib"))
    compileOnly("org.jetbrains.kotlinx:kotlinx-coroutines-core:1.10.1")
    implementation("org.bstats:bstats-bukkit:3.1.0")

    // Embedded WebSocket server for the browser voice page.
    // Java-WebSocket requires SLF4J; slf4j-jdk14 routes its logs to java.util.logging.
    implementation("org.java-websocket:Java-WebSocket:1.6.0")
    implementation("org.slf4j:slf4j-api:2.0.13")
    implementation("org.slf4j:slf4j-jdk14:2.0.13")
}

kotlin {
    jvmToolchain(21)
}

tasks {
    assemble {
        dependsOn(reobfJar)
    }

    shadowJar {
        relocate("org.bstats", "io.pfaumc.voicebridge.lib.bstats")
        relocate("org.java_websocket", "io.pfaumc.voicebridge.lib.ws")
        relocate("org.slf4j", "io.pfaumc.voicebridge.lib.slf4j")
        // Rewrites META-INF/services entries to the relocated class names
        // (slf4j loads its provider reflectively via ServiceLoader).
        mergeServiceFiles()
        // No minimize(): Java-WebSocket and SLF4J load classes reflectively,
        // which the minimizer strips.
    }

    reobfJar {
        inputJar = shadowJar.flatMap { it.archiveFile }
    }

    processResources {
        filteringCharset = Charsets.UTF_8.name()
        val props = mapOf(
            "name" to project.properties["plugin.name"],
            "version" to project.version,
            "main" to project.properties["plugin.main"],
            "apiVersion" to project.properties["paper.api"],
        )
        inputs.properties(props)
        filesMatching("plugin.yml") {
            expand(props)
        }
    }
}
