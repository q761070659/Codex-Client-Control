package io.github.codex.mccontrol;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Objects;
import java.util.Properties;
import java.util.UUID;

/**
 * 控制服务器配置数据类。
 *
 * <p>使用 Java Record 实现不可变配置对象，包含：</p>
 * <ul>
 *   <li>{@code host} - 服务器绑定地址，默认为 127.0.0.1</li>
 *   <li>{@code port} - 服务器监听端口，默认为 47862</li>
 *   <li>{@code token} - API 认证令牌，自动生成 UUID</li>
 * </ul>
 *
 * <p>配置通过 {@link #load(Path)} 方法从文件加载，如文件不存在则创建默认配置。</p>
 *
 * @see ControlBootstrap
 */
public record ControlConfig(String host, int port, String token) {

    /**
     * 从指定路径加载配置文件。
     *
     * <p>如果文件不存在，将创建默认配置文件。</p>
     *
     * @param path 配置文件路径
     * @return 加载的配置对象
     * @throws IOException 当文件操作失败时抛出
     */
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
