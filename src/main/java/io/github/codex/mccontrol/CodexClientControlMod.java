package io.github.codex.mccontrol;

import java.io.IOException;
import java.nio.file.Path;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.logging.Level;
import java.util.logging.Logger;

import net.fabricmc.api.ClientModInitializer;

public final class CodexClientControlMod implements ClientModInitializer {
    private static final Logger LOGGER = Logger.getLogger(CodexClientControlMod.class.getName());

    private ControlHttpServer server;
    private ScheduledExecutorService scheduler;

    @Override
    public void onInitializeClient() {
        try {
            MinecraftBridge bridge = new MinecraftBridge();
            Path gameDirectory = bridge.getGameDirectory();
            Path configPath = gameDirectory.resolve("config").resolve("codex-client-control.properties");
            ControlConfig config = ControlConfig.load(configPath);

            scheduler = Executors.newScheduledThreadPool(4, new NamedThreadFactory());
            server = new ControlHttpServer(config, bridge, scheduler, LOGGER);
            server.start();

            LOGGER.info("Codex Client Control started on http://" + config.host() + ":" + config.port());
            LOGGER.info("Config file: " + configPath.toAbsolutePath());
        } catch (Throwable throwable) {
            LOGGER.log(Level.SEVERE, "Failed to start Codex Client Control", throwable);
        }
    }

    private static final class NamedThreadFactory implements ThreadFactory {
        private final AtomicInteger counter = new AtomicInteger(1);

        @Override
        public Thread newThread(Runnable runnable) {
            Thread thread = new Thread(runnable, "codex-client-control-" + counter.getAndIncrement());
            thread.setDaemon(true);
            return thread;
        }
    }
}
