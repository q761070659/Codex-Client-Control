package io.github.codex.mccontrol;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Objects;
import java.util.Properties;
import java.util.UUID;

public record ControlConfig(String host, int port, String token) {
    public static ControlConfig load(Path path) throws IOException {
        Objects.requireNonNull(path, "path");
        Files.createDirectories(path.getParent());

        Properties properties = new Properties();
        if (Files.exists(path)) {
            try (InputStream inputStream = Files.newInputStream(path)) {
                properties.load(inputStream);
            }
        }

        String host = readString(properties, "host", "127.0.0.1");
        int port = readInt(properties, "port", 47862);
        String token = readString(properties, "token", UUID.randomUUID().toString());

        properties.setProperty("host", host);
        properties.setProperty("port", Integer.toString(port));
        properties.setProperty("token", token);

        try (OutputStream outputStream = Files.newOutputStream(path)) {
            properties.store(outputStream, "Codex Client Control");
        }

        return new ControlConfig(host, port, token);
    }

    private static String readString(Properties properties, String key, String fallback) {
        String value = properties.getProperty(key);
        if (value == null || value.isBlank()) {
            return fallback;
        }
        return value.trim();
    }

    private static int readInt(Properties properties, String key, int fallback) {
        String value = properties.getProperty(key);
        if (value == null || value.isBlank()) {
            return fallback;
        }

        try {
            return Integer.parseInt(value.trim());
        } catch (NumberFormatException ignored) {
            return fallback;
        }
    }
}
