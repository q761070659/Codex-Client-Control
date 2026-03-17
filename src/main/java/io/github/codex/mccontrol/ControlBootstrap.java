package io.github.codex.mccontrol;

import java.io.PrintWriter;
import java.io.StringWriter;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.nio.file.StandardOpenOption;
import java.time.LocalDateTime;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.logging.Level;
import java.util.logging.Logger;

public final class ControlBootstrap {
    private static final AtomicBoolean STARTED = new AtomicBoolean(false);
    private static final AtomicBoolean STARTING = new AtomicBoolean(false);
    private static final Path DIAGNOSTIC_PATH = Paths.get(System.getProperty("user.dir", ".")).resolve("codex-client-control-bootstrap.log");

    private ControlBootstrap() {
    }

    public static void startAsync(Logger logger) {
        appendDiagnostic("startAsync invoked", null);
        if (STARTED.get()) {
            logger.info("Codex Client Control is already running");
            appendDiagnostic("already running", null);
            return;
        }
        if (!STARTING.compareAndSet(false, true)) {
            appendDiagnostic("startAsync ignored because startup is already in progress", null);
            return;
        }

        Thread thread = new Thread(() -> startWhenReady(logger), "codex-client-control-bootstrap");
        thread.setDaemon(true);
        thread.start();
    }

    private static void startWhenReady(Logger logger) {
        appendDiagnostic("bootstrap thread started", null);
        Throwable lastFailure = null;
        for (int attempt = 1; attempt <= 180; attempt++) {
            if (STARTED.get()) {
                STARTING.set(false);
                appendDiagnostic("bootstrap exited because started flag is already true", null);
                return;
            }
            try {
                if (tryStart(logger)) {
                    STARTING.set(false);
                    appendDiagnostic("bootstrap completed successfully on attempt " + attempt, null);
                    return;
                }
            } catch (Throwable throwable) {
                lastFailure = throwable;
                appendDiagnostic("bootstrap attempt " + attempt + " failed", throwable);
                if (attempt == 1 || attempt % 10 == 0) {
                    logger.log(Level.WARNING, "Codex Client Control bootstrap attempt " + attempt + " failed", throwable);
                }
            }

            try {
                Thread.sleep(1000L);
            } catch (InterruptedException interruptedException) {
                Thread.currentThread().interrupt();
                STARTING.set(false);
                appendDiagnostic("bootstrap interrupted", interruptedException);
                logger.log(Level.SEVERE, "Codex Client Control bootstrap interrupted", interruptedException);
                return;
            }
        }

        STARTING.set(false);
        if (lastFailure != null) {
            appendDiagnostic("bootstrap gave up after retries", lastFailure);
            logger.log(Level.SEVERE, "Failed to start Codex Client Control after waiting for client readiness", lastFailure);
        } else {
            appendDiagnostic("bootstrap gave up after retries without throwable", null);
            logger.severe("Failed to start Codex Client Control after waiting for client readiness");
        }
    }

    private static boolean tryStart(Logger logger) throws Throwable {
        if (!STARTED.compareAndSet(false, true)) {
            return true;
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
            appendDiagnostic("server started at http://" + config.host() + ":" + config.port() + " with config " + configPath.toAbsolutePath(), null);
            return true;
        } catch (Throwable throwable) {
            STARTED.set(false);
            appendDiagnostic("tryStart failed", throwable);
            throw throwable;
        }
    }

    private static void appendDiagnostic(String message, Throwable throwable) {
        try {
            Files.createDirectories(DIAGNOSTIC_PATH.getParent());
            StringBuilder builder = new StringBuilder()
                .append('[')
                .append(LocalDateTime.now())
                .append("] ")
                .append(message)
                .append(System.lineSeparator());
            if (throwable != null) {
                StringWriter stringWriter = new StringWriter();
                throwable.printStackTrace(new PrintWriter(stringWriter));
                builder.append(stringWriter).append(System.lineSeparator());
            }
            Files.writeString(
                DIAGNOSTIC_PATH,
                builder.toString(),
                StandardOpenOption.CREATE,
                StandardOpenOption.APPEND
            );
        } catch (Exception ignored) {
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
