package io.github.codex.mccontrol;

import java.nio.file.Path;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.logging.Level;
import java.util.logging.Logger;

public final class ControlBootstrap {
    private static final AtomicBoolean STARTED = new AtomicBoolean(false);

    private ControlBootstrap() {
    }

    public static void start(Logger logger) {
        if (!STARTED.compareAndSet(false, true)) {
            logger.info("Codex Client Control is already running");
            return;
        }

        try {
            MinecraftBridge bridge = new MinecraftBridge();
            Path gameDirectory = bridge.getGameDirectory();
            Path configPath = gameDirectory.resolve("config").resolve("codex-client-control.properties");
            ControlConfig config = ControlConfig.load(configPath);

            ScheduledExecutorService scheduler = Executors.newScheduledThreadPool(4, new NamedThreadFactory());
            ControlHttpServer server = new ControlHttpServer(config, bridge, scheduler, logger);
            server.start();

            logger.info("Codex Client Control started on http://" + config.host() + ":" + config.port());
            logger.info("Config file: " + configPath.toAbsolutePath());
        } catch (Throwable throwable) {
            STARTED.set(false);
            logger.log(Level.SEVERE, "Failed to start Codex Client Control", throwable);
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
