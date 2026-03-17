package io.github.codex.mccontrol;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.lang.reflect.InvocationTargetException;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.SocketException;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.logging.Level;
import java.util.logging.Logger;

import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

public final class ControlHttpServer {
    private static final Gson GSON = new Gson();
    private static final String[] MOVEMENT_SEQUENCE_KEYS = { "forward", "back", "left", "right", "jump", "sneak", "sprint", "use", "attack" };

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
            if ("GET".equalsIgnoreCase(request.method()) && "/target".equals(request.path())) {
                return jsonResponse(200, bridge.getCrosshairTarget());
            }
            if ("GET".equalsIgnoreCase(request.method()) && "/container".equals(request.path())) {
                return jsonResponse(200, bridge.getContainerContents());
            }
            if ("GET".equalsIgnoreCase(request.method()) && "/players".equals(request.path())) {
                return jsonResponse(200, bridge.getPlayerList());
            }
            if ("GET".equalsIgnoreCase(request.method()) && "/debug/fake-player".equals(request.path())) {
                return jsonResponse(200, bridge.listDebugFakePlayers());
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
                validateDuration(durationMs, 10, 10_000, "durationMs");

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
            if ("POST".equalsIgnoreCase(request.method()) && "/screenshot".equals(request.path())) {
                return jsonResponse(200, bridge.takeScreenshot(optionalStringValue(body, "name")));
            }
            if ("POST".equalsIgnoreCase(request.method()) && "/sequence".equals(request.path())) {
                return jsonResponse(200, executeSequence(body));
            }
            if ("POST".equalsIgnoreCase(request.method()) && "/debug/fake-player/spawn".equals(request.path())) {
                return jsonResponse(200, bridge.spawnDebugFakePlayer(
                    stringValue(body, "name"),
                    doubleObjectValue(body, "x"),
                    doubleObjectValue(body, "y"),
                    doubleObjectValue(body, "z"),
                    floatValue(body, "yaw"),
                    floatValue(body, "pitch"),
                    booleanObjectValue(body, "invisible"),
                    booleanObjectValue(body, "noGravity"),
                    booleanObjectValue(body, "nameVisible")
                ));
            }
            if ("POST".equalsIgnoreCase(request.method()) && "/debug/fake-player/move".equals(request.path())) {
                return jsonResponse(200, bridge.moveDebugFakePlayer(
                    stringValue(body, "name"),
                    doubleObjectValue(body, "x"),
                    doubleObjectValue(body, "y"),
                    doubleObjectValue(body, "z"),
                    floatValue(body, "yaw"),
                    floatValue(body, "pitch"),
                    booleanObjectValue(body, "invisible"),
                    booleanObjectValue(body, "noGravity"),
                    booleanObjectValue(body, "nameVisible")
                ));
            }
            if ("POST".equalsIgnoreCase(request.method()) && "/debug/fake-player/remove".equals(request.path())) {
                return jsonResponse(200, bridge.removeDebugFakePlayer(stringValue(body, "name")));
            }
            if ("POST".equalsIgnoreCase(request.method()) && "/debug/fake-player/clear".equals(request.path())) {
                return jsonResponse(200, bridge.clearDebugFakePlayers());
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

    private Map<String, Object> executeSequence(JsonObject body) throws Exception {
        JsonArray steps = requiredArrayValue(body, "steps");
        List<Map<String, Object>> results = new ArrayList<>();

        for (int index = 0; index < steps.size(); index++) {
            JsonElement element = steps.get(index);
            if (!element.isJsonObject()) {
                throw new IllegalArgumentException("steps[" + index + "] must be an object");
            }
            results.add(executeSequenceStep(index, element.getAsJsonObject()));
        }

        Map<String, Object> payload = okPayload("executed");
        payload.put("executed", results.size());
        payload.put("results", results);
        return payload;
    }

    private Map<String, Object> executeSequenceStep(int index, JsonObject step) throws Exception {
        String action = stringValue(step, "action");
        return switch (action) {
            case "wait" -> waitStep(index, step);
            case "look" -> lookStep(index, step);
            case "key" -> keyStep(index, step);
            case "tap" -> tapStep(index, step);
            case "hotbar" -> hotbarStep(index, step);
            case "chat" -> chatStep(index, step);
            case "command" -> commandStep(index, step);
            case "release-all", "releaseAll" -> releaseAllStep(index);
            case "move" -> moveStep(index, step);
            case "gui.click" -> guiClickStep(index, step);
            case "gui.release" -> guiReleaseStep(index, step);
            case "gui.scroll" -> guiScrollStep(index, step);
            case "gui.key" -> guiKeyStep(index, step);
            case "gui.type" -> guiTypeStep(index, step);
            case "gui.clickWidget" -> guiClickWidgetStep(index, step);
            case "screenshot" -> screenshotStep(index, step);
            default -> throw new IllegalArgumentException("unsupported sequence action: " + action);
        };
    }

    private Map<String, Object> waitStep(int index, JsonObject step) throws InterruptedException {
        int durationMs = intValue(step, "durationMs", 0);
        validateDuration(durationMs, 0, 600_000, "durationMs");
        Thread.sleep(durationMs);
        Map<String, Object> payload = stepPayload(index, "wait");
        payload.put("durationMs", durationMs);
        return payload;
    }

    private Map<String, Object> lookStep(int index, JsonObject step) throws Exception {
        bridge.setLook(floatValue(step, "yaw"), floatValue(step, "pitch"), floatValue(step, "deltaYaw"), floatValue(step, "deltaPitch"));
        return stepPayload(index, "look");
    }

    private Map<String, Object> keyStep(int index, JsonObject step) throws Exception {
        bridge.setKey(stringValue(step, "key"), booleanValue(step, "state", false));
        return stepPayload(index, "key");
    }

    private Map<String, Object> tapStep(int index, JsonObject step) throws Exception {
        String key = stringValue(step, "key");
        int durationMs = intValue(step, "durationMs", 120);
        validateDuration(durationMs, 10, 10_000, "durationMs");
        bridge.setKey(key, true);
        Thread.sleep(durationMs);
        bridge.setKey(key, false);
        Map<String, Object> payload = stepPayload(index, "tap");
        payload.put("key", key);
        payload.put("durationMs", durationMs);
        return payload;
    }

    private Map<String, Object> hotbarStep(int index, JsonObject step) throws Exception {
        bridge.setHotbarSlot(requiredIntValue(step, "slot"));
        return stepPayload(index, "hotbar");
    }

    private Map<String, Object> chatStep(int index, JsonObject step) throws Exception {
        bridge.sendChat(stringValue(step, "message"));
        return stepPayload(index, "chat");
    }

    private Map<String, Object> commandStep(int index, JsonObject step) throws Exception {
        bridge.sendCommand(stringValue(step, "command"));
        return stepPayload(index, "command");
    }

    private Map<String, Object> releaseAllStep(int index) throws Exception {
        bridge.releaseAllMovementKeys();
        return stepPayload(index, "release-all");
    }

    private Map<String, Object> moveStep(int index, JsonObject step) throws Exception {
        if (step.has("yaw") || step.has("pitch") || step.has("deltaYaw") || step.has("deltaPitch")) {
            bridge.setLook(floatValue(step, "yaw"), floatValue(step, "pitch"), floatValue(step, "deltaYaw"), floatValue(step, "deltaPitch"));
        }

        List<String> pressedKeys = new ArrayList<>();
        for (String key : MOVEMENT_SEQUENCE_KEYS) {
            if (!step.has(key)) {
                continue;
            }
            boolean state = step.get(key).getAsBoolean();
            bridge.setKey(key, state);
            if (state) {
                pressedKeys.add(key);
            }
        }

        int durationMs = intValue(step, "durationMs", 0);
        validateDuration(durationMs, 0, 600_000, "durationMs");
        if (durationMs > 0) {
            Thread.sleep(durationMs);
        }

        for (String key : pressedKeys) {
            bridge.setKey(key, false);
        }

        Map<String, Object> payload = stepPayload(index, "move");
        payload.put("durationMs", durationMs);
        payload.put("keys", pressedKeys);
        return payload;
    }

    private Map<String, Object> guiClickStep(int index, JsonObject step) throws Exception {
        bridge.guiClick(requiredDoubleValue(step, "x"), requiredDoubleValue(step, "y"), intValue(step, "button", 0), booleanValue(step, "doubleClick", false));
        return stepPayload(index, "gui.click");
    }

    private Map<String, Object> guiReleaseStep(int index, JsonObject step) throws Exception {
        bridge.guiRelease(requiredDoubleValue(step, "x"), requiredDoubleValue(step, "y"), intValue(step, "button", 0));
        return stepPayload(index, "gui.release");
    }

    private Map<String, Object> guiScrollStep(int index, JsonObject step) throws Exception {
        bridge.guiScroll(requiredDoubleValue(step, "x"), requiredDoubleValue(step, "y"), doubleValue(step, "deltaX", 0.0D), doubleValue(step, "deltaY", 0.0D));
        return stepPayload(index, "gui.scroll");
    }

    private Map<String, Object> guiKeyStep(int index, JsonObject step) throws Exception {
        bridge.guiKeyPress(requiredIntValue(step, "key"), intValue(step, "scancode", 0), intValue(step, "modifiers", 0));
        return stepPayload(index, "gui.key");
    }

    private Map<String, Object> guiTypeStep(int index, JsonObject step) throws Exception {
        bridge.guiType(stringValue(step, "text"));
        return stepPayload(index, "gui.type");
    }

    private Map<String, Object> guiClickWidgetStep(int index, JsonObject step) throws Exception {
        bridge.guiClickWidget(requiredIntValue(step, "index"), intValue(step, "button", 0));
        return stepPayload(index, "gui.clickWidget");
    }

    private Map<String, Object> screenshotStep(int index, JsonObject step) throws Exception {
        Map<String, Object> payload = stepPayload(index, "screenshot");
        payload.put("result", bridge.takeScreenshot(optionalStringValue(step, "name")));
        return payload;
    }

    private static Map<String, Object> stepPayload(int index, String action) {
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("index", index);
        payload.put("action", action);
        payload.put("ok", Boolean.TRUE);
        return payload;
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

    private static String optionalStringValue(JsonObject body, String key) {
        if (!body.has(key) || body.get(key).isJsonNull()) {
            return null;
        }
        return body.get(key).getAsString();
    }

    private static boolean booleanValue(JsonObject body, String key, boolean fallback) {
        if (!body.has(key)) {
            return fallback;
        }
        return body.get(key).getAsBoolean();
    }

    private static Boolean booleanObjectValue(JsonObject body, String key) {
        if (!body.has(key) || body.get(key).isJsonNull()) {
            return null;
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
        if (!body.has(key) || body.get(key).isJsonNull()) {
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

    private static Double doubleObjectValue(JsonObject body, String key) {
        if (!body.has(key) || body.get(key).isJsonNull()) {
            return null;
        }
        return body.get(key).getAsDouble();
    }

    private static double requiredDoubleValue(JsonObject body, String key) {
        if (!body.has(key)) {
            throw new IllegalArgumentException("missing field: " + key);
        }
        return body.get(key).getAsDouble();
    }

    private static JsonArray requiredArrayValue(JsonObject body, String key) {
        if (!body.has(key) || !body.get(key).isJsonArray()) {
            throw new IllegalArgumentException("missing array field: " + key);
        }
        return body.getAsJsonArray(key);
    }

    private static void validateDuration(int durationMs, int min, int max, String label) {
        if (durationMs < min || durationMs > max) {
            throw new IllegalArgumentException(label + " must be between " + min + " and " + max);
        }
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
            "GET /target",
            "GET /container",
            "GET /players",
            "GET /debug/fake-player",
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
            "POST /gui/click-widget",
            "POST /screenshot",
            "POST /sequence",
            "POST /debug/fake-player/spawn",
            "POST /debug/fake-player/move",
            "POST /debug/fake-player/remove",
            "POST /debug/fake-player/clear"
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
