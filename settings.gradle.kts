rootProject.name = "voice-web-bridge"

pluginManagement {
    repositories {
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    versionCatalogs {
        create("libs") {
            plugin("runpaper", "xyz.jpenilla.run-paper").version("3.0.2")
            plugin("kotlin-jvm", "org.jetbrains.kotlin.jvm").version("2.3.0")
            plugin("shadow", "com.gradleup.shadow").version("9.0.0-beta13")
        }
    }
}
