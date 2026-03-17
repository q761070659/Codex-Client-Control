package io.github.codex.mccontrol;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.lang.reflect.InvocationTargetException;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.SocketException;
import java.net.InetSocketAddress;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.logging.Level;
import java.util.logging.Logger;

import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

public final class ControlHttpServer {
    private static final Gson GSON = new Gson();

    private final ControlConfig config;
    private final MinecraftBridge bridge;
    private final ScheduledExecutorService scheduler;
    private final Logger logger;

    private ServerSocket serverSocket;

    public ControlHttpServer(ControlConfig config, MinecraftBridge bridge, ScheduledExecutorService scheduler, Logger logger) {
        this.config = Objects.requireNonNull(config, "config");
        this.bridge = Objects.requireNonNull(bridge, "bridge");
        this.scheduler = Objects.requireNonNull(scheduler, "scheduler");
        this.logger = Objects.requireNonNull(logger, "logger");
    }

    public void start() throws IOException {
        serverSocket = new ServerSocket();
        serverSocket.bind(new InetSocketAddress(config.host(), config.port()));

        Thread acceptThread = new Thread(this::acceptLoop, "codex-client-control-listener");
        acceptThread.setDaemon(true);
        acceptThread.start();
    }

    private void acceptLoop() {
        while (!serverSocket.isClosed()) {
            try {
                Socket socket = serverSocket.accept();
                scheduler.execute(() -> handleSocket(socket));
            } catch (SocketException socketException) {
                if (!serverSocket.isClosed()) {
                    logger.log(Level.WARNING, "Control listener stopped unexpectedly", socketException);
                }
                return;
            } catch (IOException ioException) {
                logger.log(Level.WARNING, "Failed to accept control connection", ioException);
            }
        }
    }

    private void handleSocket(Socket socket) {
        try (socket;
             BufferedInputStream inputStream = new BufferedInputStream(socket.getInputStream());
             BufferedOutputStream outputStream = new BufferedOutputStream(socket.getOutputStream())) {

            HttpRequest request = readRequest(inputStream);
            if (request == null) {
                return;
            }

            HttpResponse response = route(request);
            writeResponse(outputStream, response);
        } catch (Throwable throwable) {
            logger.log(Level.WARNING, "Control socket failed", throwable);
        }
    }

    private HttpResponse route(HttpRequest request) {
        try {
            JsonObject body = parseBody(request.body());
            requireToken(request, body);

            if ("GET".equalsIgnoreCase(request.method()) && "/".equals(request.path())) {
                return jsonResponse(200, rootPayload());
            }
            if ("GET".equalsIgnoreCase(request.method()) && "/status".equals(request.path())) {
                return jsonResponse(200, bridge.getStatus());
            }
            if ("GET".equalsIgnoreCase(request.method()) && "/chat".equals(request.path())) {
                return jsonResponse(200, bridge.getChat(
                    queryLongValue(request.query(), "since", -1L),
                    queryIntValue(request.query(), "limit", 50)
                ));
            }
            if ("GET".equalsIgnoreCase(request.method()) && "/screen".equals(request.path())) {
                return jsonResponse(200, bridge.getScreenSnapshot());
            }
            if ("POST".equalsIgnoreCase(request.method()) && "/chat".equals(request.path())) {
                String message = stringValue(body, "message");
                if (message.startsWith("/")) {
                    bridge.sendCommand(message);
                } else {
                    bridge.sendChat(message);
                }
                return jsonResponse(200, okPayload("sent"));
            }
            if ("POST".equalsIgnoreCase(request.method()) && "/command".equals(request.path())) {
                bridge.sendCommand(stringValue(body, "command"));
                return jsonResponse(200, okPayload("sent"));
            }
            if ("POST".equalsIgnoreCase(request.method()) && "/look".equals(request.path())) {
                bridge.setLook(
                    floatValue(body, "yaw"),
                    floatValue(body, "pitch"),
                    floatValue(body, "deltaYaw"),
                    floatValue(body, "deltaPitch")
                );
                return jsonResponse(200, okPayload("updated"));
            }
            if ("POST".equalsIgnoreCase(request.method()) && "/key".equals(request.path())) {
                bridge.setKey(stringValue(body, "key"), booleanValue(body, "state", false));
                return jsonResponse(200, okPayload("updated"));
            }
            if ("POST".equalsIgnoreCase(request.method()) && "/tap".equals(request.path())) {
                String key = stringValue(body, "key");
                int durationMs = intValue(body, "durationMs", 120);
                if (durationMs < 10 || durationMs > 10_000) {
                    throw new IllegalArgumentException("durationMs must be between 10 and 10000");
                }

                bridge.setKey(key, true);
                scheduler.schedule(() -> {
                    try {
                        bridge.setKey(key, false);
                    } catch (Throwable throwable) {
                        logger.log(Level.WARNING, "Failed to release key " + key, throwable);
                    }
                }, durationMs, TimeUnit.MILLISECONDS);

                return jsonResponse(200, okPayload("tapped"));
            }
            if ("POST".equalsIgnoreCase(request.method()) && "/hotbar".equals(request.path())) {
                bridge.setHotbarSlot(intValue(body, "slot", -1));
                return jsonResponse(200, okPayload("updated"));
            }
            if ("POST".equalsIgnoreCase(request.method()) && "/release-all".equals(request.path())) {
                bridge.releaseAllMovementKeys();
                return jsonResponse(200, okPayload("released"));
            }
            if ("POST".equalsIgnoreCase(request.method()) && "/gui/close".equals(request.path())) {
                bridge.closeScreen();
                return jsonResponse(200, okPayload("closed"));
            }
            if ("POST".equalsIgnoreCase(request.method()) && "/gui/click".equals(request.path())) {
                bridge.guiClick(
                    requiredDoubleValue(body, "x"),
                    requiredDoubleValue(body, "y"),
                    intValue(body, "button", 0),
                    booleanValue(body, "doubleClick", false)
                );
                return jsonResponse(200, okPayload("clicked"));
            }
            if ("POST".equalsIgnoreCase(request.method()) && "/gui/release".equals(request.path())) {
                bridge.guiRelease(
                    requiredDoubleValue(body, "x"),
                    requiredDoubleValue(body, "y"),
                    intValue(body, "button", 0)
                );
                return jsonResponse(200, okPayload("released"));
            }
            if ("POST".equalsIgnoreCase(request.method()) && "/gui/scroll".equals(request.path())) {
                bridge.guiScroll(
                    requiredDoubleValue(body, "x"),
                    requiredDoubleValue(body, "y"),
                    doubleValue(body, "deltaX", 0.0D),
                    doubleValue(body, "deltaY", 0.0D)
                );
                return jsonResponse(200, okPayload("scrolled"));
            }
            if ("POST".equalsIgnoreCase(request.method()) && "/gui/key".equals(request.path())) {
                bridge.guiKeyPress(
                    requiredIntValue(body, "key"),
                    intValue(body, "scancode", 0),
                    intValue(body, "modifiers", 0)
                );
                return jsonResponse(200, okPayload("pressed"));
            }
            if ("POST".equalsIgnoreCase(request.method()) && "/gui/type".equals(request.path())) {
                bridge.guiType(stringValue(body, "text"));
                return jsonResponse(200, okPayload("typed"));
            }
            if ("POST".equalsIgnoreCase(request.method()) && "/gui/click-widget".equals(request.path())) {
                bridge.guiClickWidget(intValue(body, "index", -1), intValue(body, "button", 0));
                return jsonResponse(200, okPayload("clicked"));
            }

            return jsonResponse(404, errorPayload("route not found"));
        } catch (IllegalArgumentException | IllegalStateException exception) {
            return jsonResponse(400, errorPayload(exception.getMessage()));
        } catch (InvocationTargetException exception) {
            Throwable cause = exception.getCause() != null ? exception.getCause() : exception;
            logger.log(Level.WARNING, "Control request failed", cause);
            return jsonResponse(500, errorPayload(cause.getMessage() == null ? cause.toString() : cause.getMessage()));
        } catch (Throwable throwable) {
            logger.log(Level.WARNING, "Control request failed", throwable);
            return jsonResponse(500, errorPayload(throwable.getMessage() == null ? throwable.toString() : throwable.getMessage()));
        }
    }

    private void requireToken(HttpRequest request, JsonObject body) {
        String headerToken = request.headers().get("x-auth-token");
        String queryToken = queryValue(request.query(), "token");
        String bodyToken = body.has("token") ? body.get("token").getAsString() : null;
        String presentedToken = firstNonBlank(headerToken, queryToken, bodyToken);

        if (!config.token().equals(presentedToken)) {
            throw new IllegalArgumentException("invalid token");
        }
    }

    private static String firstNonBlank(String... values) {
        for (String value : values) {
            if (value != null && !value.isBlank()) {
                return value;
            }
        }
        return null;
    }

    private static JsonObject parseBody(byte[] bytes) {
        if (bytes.length == 0) {
            return new JsonObject();
        }

        String text = new String(bytes, StandardCharsets.UTF_8).trim();
        if (text.isEmpty()) {
            return new JsonObject();
        }

        return JsonParser.parseString(text).getAsJsonObject();
    }

    private static String stringValue(JsonObject body, String key) {
        if (!body.has(key)) {
            throw new IllegalArgumentException("missing field: " + key);
        }
        return body.get(key).getAsString();
    }

    private static boolean booleanValue(JsonObject body, String key, boolean fallback) {
        if (!body.has(key)) {
            return fallback;
        }
        return body.get(key).getAsBoolean();
    }

    private static int intValue(JsonObject body, String key, int fallback) {
        if (!body.has(key)) {
            return fallback;
        }
        return body.get(key).getAsInt();
    }

    private static int requiredIntValue(JsonObject body, String key) {
        if (!body.has(key)) {
            throw new IllegalArgumentException("missing field: " + key);
        }
        return body.get(key).getAsInt();
    }

    private static Float floatValue(JsonObject body, String key) {
        if (!body.has(key)) {
            return null;
        }
        return body.get(key).getAsFloat();
    }

    private static double doubleValue(JsonObject body, String key, double fallback) {
        if (!body.has(key)) {
            return fallback;
        }
        return body.get(key).getAsDouble();
    }

    private static double requiredDoubleValue(JsonObject body, String key) {
        if (!body.has(key)) {
            throw new IllegalArgumentException("missing field: " + key);
        }
        return body.get(key).getAsDouble();
    }

    private static String queryValue(String query, String key) {
        if (query == null || query.isBlank()) {
            return null;
        }

        for (String pair : query.split("&")) {
            String[] parts = pair.split("=", 2);
            String currentKey = decode(parts[0]);
            if (key.equals(currentKey)) {
                return parts.length > 1 ? decode(parts[1]) : "";
            }
        }
        return null;
    }

    private static String decode(String value) {
        return URLDecoder.decode(value, StandardCharsets.UTF_8);
    }

    private static int queryIntValue(String query, String key, int fallback) {
        String value = queryValue(query, key);
        if (value == null || value.isBlank()) {
            return fallback;
        }
        return Integer.parseInt(value);
    }

    private static long queryLongValue(String query, String key, long fallback) {
        String value = queryValue(query, key);
        if (value == null || value.isBlank()) {
            return fallback;
        }
        return Long.parseLong(value);
    }

    private static Map<String, Object> rootPayload() {
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("ok", Boolean.TRUE);
        payload.put("routes", new String[] {
            "GET /status",
            "GET /chat",
            "GET /screen",
            "POST /chat",
            "POST /command",
            "POST /look",
            "POST /key",
            "POST /tap",
            "POST /hotbar",
            "POST /release-all",
            "POST /gui/close",
            "POST /gui/click",
            "POST /gui/release",
            "POST /gui/scroll",
            "POST /gui/key",
            "POST /gui/type",
            "POST /gui/click-widget"
        });
        return payload;
    }

    private static Map<String, Object> okPayload(String message) {
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("ok", Boolean.TRUE);
        payload.put("message", message);
        return payload;
    }

    private static Map<String, Object> errorPayload(String message) {
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("ok", Boolean.FALSE);
        payload.put("error", message);
        return payload;
    }

    private static HttpResponse jsonResponse(int statusCode, Object payload) {
        byte[] bytes = GSON.toJson(payload).getBytes(StandardCharsets.UTF_8);
        Map<String, String> headers = new LinkedHashMap<>();
        headers.put("Content-Type", "application/json; charset=utf-8");
        headers.put("Connection", "close");
        return new HttpResponse(statusCode, headers, bytes);
    }

    private static HttpRequest readRequest(BufferedInputStream inputStream) throws IOException {
        String requestLine = readAsciiLine(inputStream);
        if (requestLine == null || requestLine.isBlank()) {
            return null;
        }

        String[] requestParts = requestLine.split(" ", 3);
        if (requestParts.length < 2) {
            throw new IllegalArgumentException("invalid request line");
        }

        String method = requestParts[0];
        String rawTarget = requestParts[1];
        String path = rawTarget;
        String query = "";
        int queryIndex = rawTarget.indexOf('?');
        if (queryIndex >= 0) {
            path = rawTarget.substring(0, queryIndex);
            query = rawTarget.substring(queryIndex + 1);
        }

        Map<String, String> headers = new LinkedHashMap<>();
        String line;
        while ((line = readAsciiLine(inputStream)) != null && !line.isEmpty()) {
            int separator = line.indexOf(':');
            if (separator <= 0) {
                continue;
            }
            String headerName = line.substring(0, separator).trim().toLowerCase(Locale.ROOT);
            String headerValue = line.substring(separator + 1).trim();
            headers.put(headerName, headerValue);
        }

        int contentLength = 0;
        if (headers.containsKey("content-length")) {
            contentLength = Integer.parseInt(headers.get("content-length"));
        }

        byte[] body = inputStream.readNBytes(contentLength);
        return new HttpRequest(method, path, query, headers, body);
    }

    private static String readAsciiLine(BufferedInputStream inputStream) throws IOException {
        ByteArrayOutputStream buffer = new ByteArrayOutputStream();
        while (true) {
            int value = inputStream.read();
            if (value == -1) {
                if (buffer.size() == 0) {
                    return null;
                }
                break;
            }
            if (value == '\n') {
                break;
            }
            if (value != '\r') {
                buffer.write(value);
            }
        }
        return buffer.toString(StandardCharsets.US_ASCII);
    }

    private static void writeResponse(BufferedOutputStream outputStream, HttpResponse response) throws IOException {
        outputStream.write(("HTTP/1.1 " + response.statusCode() + " " + reasonPhrase(response.statusCode()) + "\r\n").getBytes(StandardCharsets.US_ASCII));
        outputStream.write(("Content-Length: " + response.body().length + "\r\n").getBytes(StandardCharsets.US_ASCII));
        for (Map.Entry<String, String> header : response.headers().entrySet()) {
            outputStream.write((header.getKey() + ": " + header.getValue() + "\r\n").getBytes(StandardCharsets.US_ASCII));
        }
        outputStream.write("\r\n".getBytes(StandardCharsets.US_ASCII));
        outputStream.write(response.body());
        outputStream.flush();
    }

    private static String reasonPhrase(int statusCode) {
        return switch (statusCode) {
            case 200 -> "OK";
            case 400 -> "Bad Request";
            case 404 -> "Not Found";
            case 500 -> "Internal Server Error";
            default -> "OK";
        };
    }

    private record HttpRequest(String method, String path, String query, Map<String, String> headers, byte[] body) {
    }

    private record HttpResponse(int statusCode, Map<String, String> headers, byte[] body) {
    }
}
