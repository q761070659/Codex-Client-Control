package io.github.codex.mccontrol;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.ByteArrayOutputStream;
import java.io.EOFException;
import java.io.IOException;
import java.lang.reflect.InvocationTargetException;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.SocketException;
import java.net.URLDecoder;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Collections;
import java.util.LinkedHashSet;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.logging.Level;
import java.util.logging.Logger;

import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

/**
 * HTTP/WebSocket 控制服务器，提供远程控制 Minecraft 客户端的 API。
 *
 * <p>此服务器监听配置指定的主机和端口，提供两类接口：</p>
 * <ul>
 *   <li><b>HTTP REST API</b> - 用于查询状态和执行操作</li>
 *   <li><b>WebSocket API</b> - 用于实时订阅状态更新和高效的双向通信</li>
 * </ul>
 *
 * <p>主要功能包括：</p>
 * <ul>
 *   <li>玩家状态查询（位置、血量、视角等）</li>
 *   <li>GUI 自动化控制（点击、输入、拖拽）</li>
 *   <li>键盘/鼠标输入模拟</li>
 *   <li>聊天消息发送</li>
 *   <li>调试用假玩家管理</li>
 *   <li>动作序列执行（可中断的步骤序列）</li>
 * </ul>
 *
 * <p>所有 API 都需要通过 Token 进行身份验证，Token 可在配置文件中设置。</p>
 *
 * @see ControlBootstrap
 * @see MinecraftBridge
 */
public final class ControlHttpServer {
    private static final Gson GSON = new Gson();
    private static final String[] MOVEMENT_SEQUENCE_KEYS = { "forward", "back", "left", "right", "jump", "sneak", "sprint", "use", "attack" };
    private static final String WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
    private static final int FULL_STATE_CHAT_LIMIT = 20;
    private static final int DEFAULT_CONTROL_IDLE_RELEASE_MS = 250;
    private static final List<String> ALL_SUBSCRIPTION_TOPICS = List.of("status", "screen", "target", "container", "players", "chat", "full-state", "action");

    private final ControlConfig config;
    private final MinecraftBridge bridge;
    private final ScheduledExecutorService scheduler;
    private final Logger logger;
    private final ActionManager actionManager;

    private ServerSocket serverSocket;

    public ControlHttpServer(ControlConfig config, MinecraftBridge bridge, ScheduledExecutorService scheduler, Logger logger) {
        this.config = Objects.requireNonNull(config, "config");
        this.bridge = Objects.requireNonNull(bridge, "bridge");
        this.scheduler = Objects.requireNonNull(scheduler, "scheduler");
        this.logger = Objects.requireNonNull(logger, "logger");
        this.actionManager = new ActionManager();
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
            while (true) {
                HttpRequest request = readRequest(inputStream);
                if (request == null) {
                    return;
                }

                if (isWebSocketUpgrade(request)) {
                    handleWebSocketUpgrade(request, inputStream, outputStream);
                    return;
                }

                boolean keepAlive = shouldKeepAlive(request);
                HttpResponse response = withConnectionHeader(route(request), keepAlive);
                writeResponse(outputStream, response);
                if (!keepAlive) {
                    return;
                }
            }
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
            if ("GET".equalsIgnoreCase(request.method()) && "/full-state".equals(request.path())) {
                return jsonResponse(200, buildFullStatePayload());
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
            if ("GET".equalsIgnoreCase(request.method()) && "/inventory".equals(request.path())) {
                return jsonResponse(200, bridge.getInventoryContents());
            }
            if ("GET".equalsIgnoreCase(request.method()) && "/debug/fake-player".equals(request.path())) {
                return jsonResponse(200, bridge.listDebugFakePlayers());
            }
            if ("GET".equalsIgnoreCase(request.method()) && "/action/status".equals(request.path())) {
                return jsonResponse(200, actionManager.snapshot());
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
            if ("POST".equalsIgnoreCase(request.method()) && "/input".equals(request.path())) {
                return jsonResponse(200, bridge.applyControlState(
                    optionalBooleanMapValue(body, "keys"),
                    booleanValue(body, "clearMovement", false),
                    floatValue(body, "yaw"),
                    floatValue(body, "pitch"),
                    floatValue(body, "deltaYaw"),
                    floatValue(body, "deltaPitch"),
                    intObjectValue(body, "hotbar")
                ));
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
            if ("POST".equalsIgnoreCase(request.method()) && "/interact/item".equals(request.path())) {
                return jsonResponse(200, bridge.interactItem(optionalStringValue(body, "hand", "main")));
            }
            if ("POST".equalsIgnoreCase(request.method()) && "/interact/block".equals(request.path())) {
                return jsonResponse(200, bridge.interactBlock(
                    requiredIntValue(body, "x"),
                    requiredIntValue(body, "y"),
                    requiredIntValue(body, "z"),
                    optionalStringValue(body, "face", "up"),
                    doubleObjectValue(body, "hitX"),
                    doubleObjectValue(body, "hitY"),
                    doubleObjectValue(body, "hitZ"),
                    booleanObjectValue(body, "insideBlock"),
                    optionalStringValue(body, "hand", "main")
                ));
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
            if ("POST".equalsIgnoreCase(request.method()) && "/action/run".equals(request.path())) {
                return jsonResponse(200, runManagedAction(body));
            }
            if ("POST".equalsIgnoreCase(request.method()) && "/action/cancel".equals(request.path())) {
                return jsonResponse(200, cancelManagedAction(body));
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

    private static boolean isWebSocketUpgrade(HttpRequest request) {
        if (!"GET".equalsIgnoreCase(request.method()) || !"/ws".equals(request.path())) {
            return false;
        }
        String upgrade = request.headers().get("upgrade");
        String connection = request.headers().get("connection");
        return upgrade != null
            && "websocket".equalsIgnoreCase(upgrade)
            && connection != null
            && connection.toLowerCase(Locale.ROOT).contains("upgrade");
    }

    private void handleWebSocketUpgrade(HttpRequest request, BufferedInputStream inputStream, BufferedOutputStream outputStream) throws IOException {
        try {
            requireToken(request, new JsonObject());

            String key = request.headers().get("sec-websocket-key");
            if (key == null || key.isBlank()) {
                throw new IllegalArgumentException("missing sec-websocket-key");
            }

            Map<String, String> headers = new LinkedHashMap<>();
            headers.put("Upgrade", "websocket");
            headers.put("Connection", "Upgrade");
            headers.put("Sec-WebSocket-Accept", webSocketAccept(key));
            String protocol = selectedWebSocketProtocol(request.headers().get("sec-websocket-protocol"));
            if (protocol != null) {
                headers.put("Sec-WebSocket-Protocol", protocol);
            }
            writeResponse(outputStream, new HttpResponse(101, headers, new byte[0]));
            handleWebSocketSession(inputStream, outputStream);
        } catch (IllegalArgumentException | IllegalStateException exception) {
            writeResponse(outputStream, withConnectionHeader(jsonResponse(400, errorPayload(exception.getMessage())), false));
        }
    }

    private void handleWebSocketSession(BufferedInputStream inputStream, BufferedOutputStream outputStream) throws IOException {
        WebSocketSessionState session = new WebSocketSessionState();
        ScheduledFuture<?> pushTask = scheduler.scheduleWithFixedDelay(
            () -> pushWebSocketSubscriptions(session, outputStream),
            25L,
            25L,
            TimeUnit.MILLISECONDS
        );

        try {
            while (session.isOpen()) {
                WebSocketFrame frame;
                try {
                    frame = readWebSocketFrame(inputStream);
                } catch (IllegalArgumentException exception) {
                    session.close();
                    closeWebSocket(outputStream, session.writeLock(), 1002, exception.getMessage());
                    return;
                }

                if (frame == null) {
                    session.close();
                    return;
                }

                if (!frame.fin()) {
                    session.close();
                    closeWebSocket(outputStream, session.writeLock(), 1003, "fragmented frames are not supported");
                    return;
                }

                switch (frame.opcode()) {
                    case 0x1 -> handleWebSocketTextMessage(session, outputStream, new String(frame.payload(), StandardCharsets.UTF_8));
                    case 0x8 -> {
                        session.close();
                        writeWebSocketFrame(outputStream, session.writeLock(), 0x8, frame.payload());
                        return;
                    }
                    case 0x9 -> writeWebSocketFrame(outputStream, session.writeLock(), 0xA, frame.payload());
                    case 0xA -> {
                    }
                    default -> {
                        session.close();
                        closeWebSocket(outputStream, session.writeLock(), 1003, "unsupported websocket opcode");
                        return;
                    }
                }
            }
        } finally {
            session.close();
            pushTask.cancel(true);
            releaseSessionControl(session);
        }
    }

    private void handleWebSocketTextMessage(WebSocketSessionState session, BufferedOutputStream outputStream, String message) throws IOException {
        String action = null;
        Object id = null;
        try {
            JsonObject body = JsonParser.parseString(message).getAsJsonObject();
            action = canonicalWebSocketAction(firstNonBlank(optionalStringValue(body, "action"), optionalStringValue(body, "type")));
            id = optionalPrimitiveValue(body, "id");
            boolean respond = booleanValue(body, "respond", id != null || shouldRespondToWebSocketAction(action, body));
            Map<String, Object> payload = executeWebSocketAction(session, outputStream, action, body, respond);
            if (respond && payload != null) {
                writeWebSocketJson(outputStream, session.writeLock(), webSocketResponse(action, id, payload));
            }
        } catch (IllegalArgumentException | IllegalStateException exception) {
            writeWebSocketJson(outputStream, session.writeLock(), webSocketError(action, id, exception.getMessage()));
        } catch (InvocationTargetException exception) {
            Throwable cause = exception.getCause() != null ? exception.getCause() : exception;
            logger.log(Level.WARNING, "WebSocket control message failed", cause);
            writeWebSocketJson(outputStream, session.writeLock(), webSocketError(action, id, cause.getMessage() == null ? cause.toString() : cause.getMessage()));
        } catch (Throwable throwable) {
            logger.log(Level.WARNING, "WebSocket control message failed", throwable);
            writeWebSocketJson(outputStream, session.writeLock(), webSocketError(action, id, throwable.getMessage() == null ? throwable.toString() : throwable.getMessage()));
        }
    }

    private Map<String, Object> executeWebSocketAction(WebSocketSessionState session, BufferedOutputStream outputStream, String action, JsonObject body, boolean respond) throws Exception {
        return switch (action) {
            case "ping" -> okPayload("pong");
            case "status" -> bridge.getStatus();
            case "full-state" -> buildFullStatePayload();
            case "chat" -> body.has("message")
                ? webSocketChatSend(body)
                : bridge.getChat(longObjectValue(body, "since", -1L), intValue(body, "limit", 50));
            case "chat.read" -> bridge.getChat(longObjectValue(body, "since", -1L), intValue(body, "limit", 50));
            case "subscribe" -> webSocketSubscribe(session, body);
            case "unsubscribe" -> webSocketUnsubscribe(session, body);
            case "subscriptions" -> session.snapshot();
            case "screen" -> bridge.getScreenSnapshot();
            case "target" -> bridge.getCrosshairTarget();
            case "container" -> bridge.getContainerContents();
            case "players" -> bridge.getPlayerList();
            case "action.status" -> actionManager.snapshot();
            case "action.run" -> runManagedAction(body);
            case "action.cancel" -> cancelManagedAction(body);
            case "command" -> webSocketCommand(body);
            case "look" -> webSocketLook(body);
            case "key" -> webSocketKey(body);
            case "input" -> webSocketInput(session, outputStream, body, respond);
            case "tap" -> webSocketTap(body);
            case "hotbar" -> webSocketHotbar(body);
            case "interact.item" -> bridge.interactItem(optionalStringValue(body, "hand", "main"));
            case "interact.block" -> bridge.interactBlock(
                requiredIntValue(body, "x"),
                requiredIntValue(body, "y"),
                requiredIntValue(body, "z"),
                optionalStringValue(body, "face", "up"),
                doubleObjectValue(body, "hitX"),
                doubleObjectValue(body, "hitY"),
                doubleObjectValue(body, "hitZ"),
                booleanObjectValue(body, "insideBlock"),
                optionalStringValue(body, "hand", "main")
            );
            case "release-all" -> webSocketReleaseAll();
            case "gui.close" -> webSocketGuiClose();
            case "gui.click" -> webSocketGuiClick(body);
            case "gui.release" -> webSocketGuiRelease(body);
            case "gui.scroll" -> webSocketGuiScroll(body);
            case "gui.key" -> webSocketGuiKey(body);
            case "gui.type" -> webSocketGuiType(body);
            case "gui.click-widget" -> webSocketGuiClickWidget(body);
            case "screenshot" -> bridge.takeScreenshot(optionalStringValue(body, "name"));
            case "sequence" -> executeSequence(body);
            case "debug.fake-player", "debug.fake-player.list" -> bridge.listDebugFakePlayers();
            case "debug.fake-player.spawn" -> bridge.spawnDebugFakePlayer(
                stringValue(body, "name"),
                doubleObjectValue(body, "x"),
                doubleObjectValue(body, "y"),
                doubleObjectValue(body, "z"),
                floatValue(body, "yaw"),
                floatValue(body, "pitch"),
                booleanObjectValue(body, "invisible"),
                booleanObjectValue(body, "noGravity"),
                booleanObjectValue(body, "nameVisible")
            );
            case "debug.fake-player.move" -> bridge.moveDebugFakePlayer(
                stringValue(body, "name"),
                doubleObjectValue(body, "x"),
                doubleObjectValue(body, "y"),
                doubleObjectValue(body, "z"),
                floatValue(body, "yaw"),
                floatValue(body, "pitch"),
                booleanObjectValue(body, "invisible"),
                booleanObjectValue(body, "noGravity"),
                booleanObjectValue(body, "nameVisible")
            );
            case "debug.fake-player.remove" -> bridge.removeDebugFakePlayer(stringValue(body, "name"));
            case "debug.fake-player.clear" -> bridge.clearDebugFakePlayers();
            default -> throw new IllegalArgumentException("unsupported websocket action: " + action);
        };
    }

    private Map<String, Object> webSocketChatSend(JsonObject body) throws Exception {
        String message = stringValue(body, "message");
        if (message.startsWith("/")) {
            bridge.sendCommand(message);
        } else {
            bridge.sendChat(message);
        }
        return okPayload("sent");
    }

    private Map<String, Object> webSocketCommand(JsonObject body) throws Exception {
        bridge.sendCommand(stringValue(body, "command"));
        return okPayload("sent");
    }

    private Map<String, Object> webSocketLook(JsonObject body) throws Exception {
        bridge.setLook(floatValue(body, "yaw"), floatValue(body, "pitch"), floatValue(body, "deltaYaw"), floatValue(body, "deltaPitch"));
        return okPayload("updated");
    }

    private Map<String, Object> webSocketKey(JsonObject body) throws Exception {
        bridge.setKey(stringValue(body, "key"), booleanValue(body, "state", false));
        return okPayload("updated");
    }

    private Map<String, Object> webSocketSubscribe(WebSocketSessionState session, JsonObject body) throws Exception {
        List<String> topics = normalizeSubscriptionTopics(optionalStringListValue(body, "topics"));
        if (topics.isEmpty()) {
            throw new IllegalArgumentException("topics must not be empty");
        }

        boolean includeInitial = booleanValue(body, "includeInitial", true);
        Integer intervalMs = intObjectValue(body, "intervalMs");
        Long chatSince = body.has("since") ? longObjectValue(body, "since", -1L) : null;

        if (!includeInitial && topics.contains("chat") && chatSince == null) {
            Map<String, Object> snapshot = bridge.getChat(-1L, 1);
            chatSince = ((Number) snapshot.get("latestSequence")).longValue();
        }

        return session.subscribe(topics, intervalMs, includeInitial, chatSince);
    }

    private Map<String, Object> webSocketUnsubscribe(WebSocketSessionState session, JsonObject body) {
        return session.unsubscribe(normalizeSubscriptionTopics(optionalStringListValue(body, "topics")));
    }

    private Map<String, Object> webSocketInput(WebSocketSessionState session, BufferedOutputStream outputStream, JsonObject body, boolean respond) throws Exception {
        Map<String, Boolean> keys = optionalBooleanMapValue(body, "keys");
        boolean clearMovement = booleanValue(body, "clearMovement", false);
        Float yaw = floatValue(body, "yaw");
        Float pitch = floatValue(body, "pitch");
        Float deltaYaw = floatValue(body, "deltaYaw");
        Float deltaPitch = floatValue(body, "deltaPitch");
        Integer hotbar = intObjectValue(body, "hotbar");

        session.recordControlInput(keys, clearMovement);

        if (!respond) {
            bridge.submitControlState(
                keys,
                clearMovement,
                yaw,
                pitch,
                deltaYaw,
                deltaPitch,
                hotbar,
                throwable -> {
                    logger.log(Level.WARNING, "Async WebSocket input failed", throwable);
                    try {
                        writeWebSocketJson(outputStream, session.writeLock(), webSocketError("input", null, throwable.getMessage() == null ? throwable.toString() : throwable.getMessage()));
                    } catch (IOException ioException) {
                        logger.log(Level.FINE, "Failed to emit async websocket error", ioException);
                        session.close();
                    }
                }
            );
            return null;
        }

        return bridge.applyControlState(keys, clearMovement, yaw, pitch, deltaYaw, deltaPitch, hotbar);
    }

    private Map<String, Object> webSocketTap(JsonObject body) throws Exception {
        String key = stringValue(body, "key");
        int durationMs = intValue(body, "durationMs", 120);
        validateDuration(durationMs, 10, 10_000, "durationMs");

        bridge.setKey(key, true);
        scheduler.schedule(() -> {
            try {
                bridge.setKey(key, false);
            } catch (Throwable throwable) {
                logger.log(Level.WARNING, "Failed to release WebSocket key " + key, throwable);
            }
        }, durationMs, TimeUnit.MILLISECONDS);

        Map<String, Object> payload = okPayload("tapped");
        payload.put("key", key);
        payload.put("durationMs", durationMs);
        return payload;
    }

    private Map<String, Object> webSocketHotbar(JsonObject body) throws Exception {
        bridge.setHotbarSlot(requiredIntValue(body, "slot"));
        return okPayload("updated");
    }

    private Map<String, Object> webSocketReleaseAll() throws Exception {
        bridge.releaseAllMovementKeys();
        return okPayload("released");
    }

    private Map<String, Object> webSocketGuiClose() throws Exception {
        bridge.closeScreen();
        return okPayload("closed");
    }

    private Map<String, Object> webSocketGuiClick(JsonObject body) throws Exception {
        bridge.guiClick(requiredDoubleValue(body, "x"), requiredDoubleValue(body, "y"), intValue(body, "button", 0), booleanValue(body, "doubleClick", false));
        return okPayload("clicked");
    }

    private Map<String, Object> webSocketGuiRelease(JsonObject body) throws Exception {
        bridge.guiRelease(requiredDoubleValue(body, "x"), requiredDoubleValue(body, "y"), intValue(body, "button", 0));
        return okPayload("released");
    }

    private Map<String, Object> webSocketGuiScroll(JsonObject body) throws Exception {
        bridge.guiScroll(requiredDoubleValue(body, "x"), requiredDoubleValue(body, "y"), doubleValue(body, "deltaX", 0.0D), doubleValue(body, "deltaY", 0.0D));
        return okPayload("scrolled");
    }

    private Map<String, Object> webSocketGuiKey(JsonObject body) throws Exception {
        bridge.guiKeyPress(requiredIntValue(body, "key"), intValue(body, "scancode", 0), intValue(body, "modifiers", 0));
        return okPayload("pressed");
    }

    private Map<String, Object> webSocketGuiType(JsonObject body) throws Exception {
        bridge.guiType(stringValue(body, "text"));
        return okPayload("typed");
    }

    private Map<String, Object> webSocketGuiClickWidget(JsonObject body) throws Exception {
        bridge.guiClickWidget(requiredIntValue(body, "index"), intValue(body, "button", 0));
        return okPayload("clicked");
    }

    private void pushWebSocketSubscriptions(WebSocketSessionState session, BufferedOutputStream outputStream) {
        if (!session.isOpen()) {
            return;
        }

        releaseStaleWebSocketControl(session);

        if (!session.shouldPushNow()) {
            return;
        }

        try {
            for (String topic : session.topicsSnapshot()) {
                switch (topic) {
                    case "chat" -> pushWebSocketChat(session, outputStream);
                    case "status" -> pushWebSocketSnapshot(session, outputStream, topic, bridge.getStatus());
                    case "screen" -> pushWebSocketSnapshot(session, outputStream, topic, bridge.getScreenSnapshot());
                    case "target" -> pushWebSocketSnapshot(session, outputStream, topic, bridge.getCrosshairTarget());
                    case "container" -> pushWebSocketSnapshot(session, outputStream, topic, bridge.getContainerContents());
                    case "players" -> pushWebSocketSnapshot(session, outputStream, topic, bridge.getPlayerList());
                    case "full-state" -> pushWebSocketSnapshot(session, outputStream, topic, buildFullStatePayload());
                    case "action" -> pushWebSocketSnapshot(session, outputStream, topic, actionManager.snapshot());
                    default -> {
                    }
                }
            }
        } catch (Throwable throwable) {
            session.close();
            logger.log(Level.WARNING, "WebSocket subscription push failed", throwable);
        }
    }

    private void pushWebSocketChat(WebSocketSessionState session, BufferedOutputStream outputStream) throws Exception {
        Map<String, Object> payload = bridge.getChat(session.chatSince(), 50);
        long latestSequence = ((Number) payload.get("latestSequence")).longValue();
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> messages = (List<Map<String, Object>>) payload.get("messages");
        if (!messages.isEmpty()) {
            session.setChatSince(latestSequence);
            writeWebSocketJson(outputStream, session.writeLock(), webSocketStateUpdate("chat", payload));
        } else if (session.chatSince() < latestSequence) {
            session.setChatSince(latestSequence);
        }
    }

    private void pushWebSocketSnapshot(WebSocketSessionState session, BufferedOutputStream outputStream, String topic, Map<String, Object> payload) throws IOException {
        String encoded = GSON.toJson(payload);
        if (session.rememberPayload(topic, encoded)) {
            writeWebSocketJson(outputStream, session.writeLock(), webSocketStateUpdate(topic, payload));
        }
    }

    private Map<String, Object> buildFullStatePayload() throws ReflectiveOperationException {
        Map<String, Object> payload = bridge.getFullState(FULL_STATE_CHAT_LIMIT);
        payload.put("action", actionManager.snapshot());
        return payload;
    }

    private Map<String, Object> runManagedAction(JsonObject body) {
        JsonArray steps = requiredArrayValue(body, "steps");
        Integer timeoutMs = intObjectValue(body, "timeoutMs");
        if (timeoutMs != null) {
            validateDuration(timeoutMs, 0, 3_600_000, "timeoutMs");
        }

        return actionManager.start(
            optionalStringValue(body, "label"),
            steps,
            booleanValue(body, "replace", true),
            timeoutMs,
            booleanValue(body, "releaseOnFinish", true),
            booleanValue(body, "releaseOnCancel", true)
        );
    }

    private Map<String, Object> cancelManagedAction(JsonObject body) {
        return actionManager.cancel(optionalStringValue(body, "reason"), booleanValue(body, "releaseKeys", true));
    }

    private void releaseStaleWebSocketControl(WebSocketSessionState session) {
        if (actionManager.isActive()) {
            return;
        }

        Map<String, Boolean> releaseKeys = session.consumeStaleControlRelease(System.currentTimeMillis());
        if (releaseKeys.isEmpty()) {
            return;
        }

        try {
            bridge.submitControlState(releaseKeys, false, null, null, null, null, null, throwable -> {
                logger.log(Level.FINE, "Failed to release stale websocket control", throwable);
                session.close();
            });
        } catch (Throwable throwable) {
            logger.log(Level.FINE, "Failed to queue stale websocket control release", throwable);
            session.close();
        }
    }

    private void releaseSessionControl(WebSocketSessionState session) {
        Map<String, Boolean> releaseKeys = session.consumeAllControlRelease();
        if (releaseKeys.isEmpty()) {
            return;
        }

        try {
            bridge.submitControlState(releaseKeys, false, null, null, null, null, null, throwable -> logger.log(Level.FINE, "Failed to release websocket session control", throwable));
        } catch (Throwable throwable) {
            logger.log(Level.FINE, "Failed to queue websocket session control release", throwable);
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
            case "input" -> inputStep(index, step);
            case "tap" -> tapStep(index, step);
            case "hotbar" -> hotbarStep(index, step);
            case "interact.item" -> interactItemStep(index, step);
            case "interact.block" -> interactBlockStep(index, step);
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
        sleepStep(durationMs);
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

    private Map<String, Object> inputStep(int index, JsonObject step) throws Exception {
        Map<String, Object> payload = stepPayload(index, "input");
        payload.putAll(bridge.applyControlState(
            optionalBooleanMapValue(step, "keys"),
            booleanValue(step, "clearMovement", false),
            floatValue(step, "yaw"),
            floatValue(step, "pitch"),
            floatValue(step, "deltaYaw"),
            floatValue(step, "deltaPitch"),
            intObjectValue(step, "hotbar")
        ));
        return payload;
    }

    private Map<String, Object> tapStep(int index, JsonObject step) throws Exception {
        String key = stringValue(step, "key");
        int durationMs = intValue(step, "durationMs", 120);
        validateDuration(durationMs, 10, 10_000, "durationMs");
        bridge.setKey(key, true);
        try {
            sleepStep(durationMs);
        } finally {
            bridge.setKey(key, false);
        }
        Map<String, Object> payload = stepPayload(index, "tap");
        payload.put("key", key);
        payload.put("durationMs", durationMs);
        return payload;
    }

    private Map<String, Object> hotbarStep(int index, JsonObject step) throws Exception {
        bridge.setHotbarSlot(requiredIntValue(step, "slot"));
        return stepPayload(index, "hotbar");
    }

    private Map<String, Object> interactItemStep(int index, JsonObject step) throws Exception {
        Map<String, Object> payload = stepPayload(index, "interact.item");
        payload.put("result", bridge.interactItem(optionalStringValue(step, "hand", "main")));
        return payload;
    }

    private Map<String, Object> interactBlockStep(int index, JsonObject step) throws Exception {
        Map<String, Object> payload = stepPayload(index, "interact.block");
        payload.put("result", bridge.interactBlock(
            requiredIntValue(step, "x"),
            requiredIntValue(step, "y"),
            requiredIntValue(step, "z"),
            optionalStringValue(step, "face", "up"),
            doubleObjectValue(step, "hitX"),
            doubleObjectValue(step, "hitY"),
            doubleObjectValue(step, "hitZ"),
            booleanObjectValue(step, "insideBlock"),
            optionalStringValue(step, "hand", "main")
        ));
        return payload;
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
        Map<String, Boolean> keyStates = new LinkedHashMap<>();
        List<String> pressedKeys = new ArrayList<>();
        for (String key : MOVEMENT_SEQUENCE_KEYS) {
            if (!step.has(key)) {
                continue;
            }
            boolean state = step.get(key).getAsBoolean();
            keyStates.put(key, state);
            if (state) {
                pressedKeys.add(key);
            }
        }

        if (!keyStates.isEmpty() || step.has("yaw") || step.has("pitch") || step.has("deltaYaw") || step.has("deltaPitch")) {
            bridge.applyControlState(
                keyStates,
                false,
                floatValue(step, "yaw"),
                floatValue(step, "pitch"),
                floatValue(step, "deltaYaw"),
                floatValue(step, "deltaPitch"),
                null
            );
        }

        int durationMs = intValue(step, "durationMs", 0);
        validateDuration(durationMs, 0, 600_000, "durationMs");
        try {
            sleepStep(durationMs);
        } finally {
            if (!pressedKeys.isEmpty()) {
                Map<String, Boolean> releasedKeys = new LinkedHashMap<>();
                for (String key : pressedKeys) {
                    releasedKeys.put(key, Boolean.FALSE);
                }
                bridge.applyControlState(releasedKeys, false, null, null, null, null, null);
            }
        }

        Map<String, Object> payload = stepPayload(index, "move");
        payload.put("durationMs", durationMs);
        payload.put("keys", pressedKeys);
        return payload;
    }

    private static void sleepStep(int durationMs) throws InterruptedException {
        if (durationMs > 0) {
            Thread.sleep(durationMs);
        }
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

    private static String optionalStringValue(JsonObject body, String key, String fallback) {
        String value = optionalStringValue(body, key);
        if (value == null || value.isBlank()) {
            return fallback;
        }
        return value;
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

    private static Map<String, Boolean> optionalBooleanMapValue(JsonObject body, String key) {
        if (!body.has(key) || body.get(key).isJsonNull()) {
            return Map.of();
        }
        if (!body.get(key).isJsonObject()) {
            throw new IllegalArgumentException("field must be an object: " + key);
        }

        Map<String, Boolean> values = new LinkedHashMap<>();
        for (Map.Entry<String, JsonElement> entry : body.getAsJsonObject(key).entrySet()) {
            JsonElement value = entry.getValue();
            if (value == null || value.isJsonNull()) {
                continue;
            }
            values.put(entry.getKey(), value.getAsBoolean());
        }
        return values;
    }

    private static Object optionalPrimitiveValue(JsonObject body, String key) {
        if (!body.has(key) || body.get(key).isJsonNull()) {
            return null;
        }
        JsonElement value = body.get(key);
        if (!value.isJsonPrimitive()) {
            throw new IllegalArgumentException("field must be primitive: " + key);
        }
        if (value.getAsJsonPrimitive().isBoolean()) {
            return value.getAsBoolean();
        }
        if (value.getAsJsonPrimitive().isNumber()) {
            return value.getAsNumber();
        }
        return value.getAsString();
    }

    private static List<String> optionalStringListValue(JsonObject body, String key) {
        if (!body.has(key) || body.get(key).isJsonNull()) {
            return List.of();
        }
        if (!body.get(key).isJsonArray()) {
            throw new IllegalArgumentException("field must be an array: " + key);
        }

        List<String> values = new ArrayList<>();
        for (JsonElement element : body.getAsJsonArray(key)) {
            if (element == null || element.isJsonNull()) {
                continue;
            }
            values.add(element.getAsString());
        }
        return values;
    }

    private static int intValue(JsonObject body, String key, int fallback) {
        if (!body.has(key)) {
            return fallback;
        }
        return body.get(key).getAsInt();
    }

    private static Integer intObjectValue(JsonObject body, String key) {
        if (!body.has(key) || body.get(key).isJsonNull()) {
            return null;
        }
        return body.get(key).getAsInt();
    }

    private static long longObjectValue(JsonObject body, String key, long fallback) {
        if (!body.has(key) || body.get(key).isJsonNull()) {
            return fallback;
        }
        return body.get(key).getAsLong();
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

    private static String canonicalWebSocketAction(String action) {
        if (action == null || action.isBlank()) {
            throw new IllegalArgumentException("missing field: action");
        }

        String normalized = action.strip().replace('/', '.');
        return switch (normalized) {
            case "fullState" -> "full-state";
            case "releaseAll" -> "release-all";
            case "gui.clickWidget" -> "gui.click-widget";
            case "interactItem" -> "interact.item";
            case "interactBlock" -> "interact.block";
            case "debug.fake-player.list" -> "debug.fake-player.list";
            default -> normalized;
        };
    }

    private static boolean shouldRespondToWebSocketAction(String action, JsonObject body) {
        return switch (action) {
            case "status", "full-state", "chat.read", "screen", "target", "container", "players", "debug.fake-player", "debug.fake-player.list", "screenshot", "sequence", "subscribe", "unsubscribe", "subscriptions", "action.status", "action.run", "action.cancel", "interact.item", "interact.block", "ping" -> true;
            case "chat" -> !body.has("message");
            default -> false;
        };
    }

    private static List<String> normalizeSubscriptionTopics(List<String> topics) {
        List<String> normalized = new ArrayList<>();
        if (topics == null) {
            return normalized;
        }
        for (String topic : topics) {
            if (topic == null || topic.isBlank()) {
                continue;
            }
            String value = topic.strip().toLowerCase(Locale.ROOT).replace('/', '.').replace('_', '-');
            if ("full.state".equals(value) || "fullstate".equals(value)) {
                value = "full-state";
            }
            if ("all".equals(value)) {
                normalized.clear();
                normalized.addAll(ALL_SUBSCRIPTION_TOPICS);
                return normalized;
            }
            switch (value) {
                case "status", "screen", "target", "container", "players", "chat", "full-state", "action" -> {
                    if (!normalized.contains(value)) {
                        normalized.add(value);
                    }
                }
                default -> throw new IllegalArgumentException("unsupported subscription topic: " + topic);
            }
        }
        return normalized;
    }

    private static Map<String, Object> webSocketResponse(String action, Object id, Map<String, Object> payload) {
        Map<String, Object> response = new LinkedHashMap<>();
        response.put("ok", Boolean.TRUE);
        if (id != null) {
            response.put("id", id);
        }
        response.putAll(payload);
        response.put("requestAction", action);
        response.putIfAbsent("action", action);
        return response;
    }

    private static Map<String, Object> webSocketError(String action, Object id, String message) {
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("ok", Boolean.FALSE);
        payload.put("error", message);
        if (action != null && !action.isBlank()) {
            payload.put("action", action);
        }
        if (id != null) {
            payload.put("id", id);
        }
        return payload;
    }

    private static Map<String, Object> webSocketStateUpdate(String topic, Object data) {
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("ok", Boolean.TRUE);
        payload.put("event", "state-update");
        payload.put("topic", topic);
        payload.put("data", data);
        return payload;
    }

    private static Map<String, Object> rootPayload() {
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("ok", Boolean.TRUE);
        payload.put("routes", new String[] {
            "GET /status",
            "GET /full-state",
            "GET /chat",
            "GET /screen",
            "GET /target",
            "GET /container",
            "GET /players",
            "GET /inventory",
            "GET /debug/fake-player",
            "GET /action/status",
            "WS /ws",
            "POST /chat",
            "POST /command",
            "POST /look",
            "POST /key",
            "POST /input",
            "POST /tap",
            "POST /hotbar",
            "POST /interact/item",
            "POST /interact/block",
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
            "POST /action/run",
            "POST /action/cancel",
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
        return new HttpResponse(statusCode, headers, bytes);
    }

    private static HttpResponse withConnectionHeader(HttpResponse response, boolean keepAlive) {
        Map<String, String> headers = new LinkedHashMap<>(response.headers());
        headers.put("Connection", keepAlive ? "keep-alive" : "close");
        return new HttpResponse(response.statusCode(), headers, response.body());
    }

    private static boolean shouldKeepAlive(HttpRequest request) {
        String connection = request.headers().get("connection");
        return connection == null || !"close".equalsIgnoreCase(connection);
    }

    private static String webSocketAccept(String key) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-1");
            byte[] hash = digest.digest((key.strip() + WEBSOCKET_GUID).getBytes(StandardCharsets.US_ASCII));
            return Base64.getEncoder().encodeToString(hash);
        } catch (NoSuchAlgorithmException exception) {
            throw new IllegalStateException("SHA-1 is not available", exception);
        }
    }

    private static String selectedWebSocketProtocol(String header) {
        if (header == null || header.isBlank()) {
            return null;
        }
        for (String value : header.split(",")) {
            String candidate = value.trim();
            if ("codex-client-control.v1".equalsIgnoreCase(candidate)) {
                return "codex-client-control.v1";
            }
        }
        return null;
    }

    private static WebSocketFrame readWebSocketFrame(BufferedInputStream inputStream) throws IOException {
        int first = inputStream.read();
        if (first == -1) {
            return null;
        }

        int second = inputStream.read();
        if (second == -1) {
            throw new EOFException("unexpected eof while reading websocket frame");
        }

        boolean fin = (first & 0x80) != 0;
        int opcode = first & 0x0F;
        boolean masked = (second & 0x80) != 0;
        long length = second & 0x7F;

        if (length == 126) {
            byte[] extended = readExact(inputStream, 2);
            length = ((extended[0] & 0xFF) << 8) | (extended[1] & 0xFF);
        } else if (length == 127) {
            byte[] extended = readExact(inputStream, 8);
            length = 0L;
            for (byte value : extended) {
                length = (length << 8) | (value & 0xFFL);
            }
        }

        if (!masked) {
            throw new IllegalArgumentException("websocket client frames must be masked");
        }
        if (length > Integer.MAX_VALUE) {
            throw new IllegalArgumentException("websocket frame is too large");
        }

        byte[] mask = readExact(inputStream, 4);
        byte[] payload = readExact(inputStream, (int) length);
        for (int index = 0; index < payload.length; index++) {
            payload[index] ^= mask[index % 4];
        }
        return new WebSocketFrame(fin, opcode, payload);
    }

    private static byte[] readExact(BufferedInputStream inputStream, int length) throws IOException {
        byte[] bytes = inputStream.readNBytes(length);
        if (bytes.length != length) {
            throw new EOFException("unexpected eof while reading websocket payload");
        }
        return bytes;
    }

    private static void writeWebSocketJson(BufferedOutputStream outputStream, Object writeLock, Map<String, Object> payload) throws IOException {
        synchronized (writeLock) {
            writeWebSocketFrame(outputStream, 0x1, GSON.toJson(payload).getBytes(StandardCharsets.UTF_8));
        }
    }

    private static void writeWebSocketFrame(BufferedOutputStream outputStream, int opcode, byte[] payload) throws IOException {
        byte[] framePayload = payload == null ? new byte[0] : payload;
        outputStream.write(0x80 | (opcode & 0x0F));
        if (framePayload.length <= 125) {
            outputStream.write(framePayload.length);
        } else if (framePayload.length <= 0xFFFF) {
            outputStream.write(126);
            outputStream.write((framePayload.length >>> 8) & 0xFF);
            outputStream.write(framePayload.length & 0xFF);
        } else {
            outputStream.write(127);
            long length = framePayload.length;
            for (int shift = 56; shift >= 0; shift -= 8) {
                outputStream.write((int) ((length >>> shift) & 0xFF));
            }
        }
        outputStream.write(framePayload);
        outputStream.flush();
    }

    private static void writeWebSocketFrame(BufferedOutputStream outputStream, Object writeLock, int opcode, byte[] payload) throws IOException {
        synchronized (writeLock) {
            writeWebSocketFrame(outputStream, opcode, payload);
        }
    }

    private static void closeWebSocket(BufferedOutputStream outputStream, Object writeLock, int code, String reason) throws IOException {
        byte[] reasonBytes = reason == null || reason.isBlank()
            ? new byte[0]
            : reason.getBytes(StandardCharsets.UTF_8);
        byte[] payload = new byte[2 + reasonBytes.length];
        payload[0] = (byte) ((code >>> 8) & 0xFF);
        payload[1] = (byte) (code & 0xFF);
        System.arraycopy(reasonBytes, 0, payload, 2, reasonBytes.length);
        writeWebSocketFrame(outputStream, writeLock, 0x8, payload);
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
            case 101 -> "Switching Protocols";
            case 200 -> "OK";
            case 400 -> "Bad Request";
            case 404 -> "Not Found";
            case 500 -> "Internal Server Error";
            default -> "OK";
        };
    }

    private final class ActionManager {
        private static final long FAST_LOOP_WINDOW_MS = 40L;
        private static final int FAST_LOOP_LIMIT = 8;

        private final ExecutorService executor = Executors.newSingleThreadExecutor(runnable -> {
            Thread thread = new Thread(runnable, "codex-client-control-action");
            thread.setDaemon(true);
            return thread;
        });

        private long nextActionId = 1L;
        private long currentActionId = 0L;
        private boolean active = false;
        private boolean releaseOnCancel = true;
        private String state = "idle";
        private String label = "Idle";
        private int stepIndex = -1;
        private int stepCount = 0;
        private int completedSteps = 0;
        private long startedAt = 0L;
        private long updatedAt = 0L;
        private long lastRequestAt = 0L;
        private int rapidRequestCount = 0;
        private String message = "idle";
        private String error = "";
        private Future<?> currentFuture;
        private ScheduledFuture<?> currentTimeout;

        public Map<String, Object> start(String requestedLabel, JsonArray requestedSteps, boolean replace, Integer timeoutMs, boolean releaseOnFinish, boolean requestedReleaseOnCancel) {
            if (requestedSteps.isEmpty()) {
                throw new IllegalArgumentException("steps must not be empty");
            }

            JsonArray steps = requestedSteps.deepCopy();
            Future<?> cancelledFuture = null;
            ScheduledFuture<?> cancelledTimeout = null;
            boolean releaseCancelledKeys = false;
            Map<String, Object> snapshot;
            long actionId;
            String resolvedLabel;
            long now = System.currentTimeMillis();

            synchronized (this) {
                updateRapidRequestCounter(now);
                if (rapidRequestCount > FAST_LOOP_LIMIT) {
                    throw new IllegalStateException("fast action loop detected");
                }

                if (active) {
                    if (!replace) {
                        throw new IllegalStateException("action already running: " + label);
                    }

                    cancelledFuture = currentFuture;
                    cancelledTimeout = currentTimeout;
                    releaseCancelledKeys = releaseOnCancel;
                    if (cancelledTimeout != null) {
                        cancelledTimeout.cancel(false);
                    }
                    if (cancelledFuture != null) {
                        cancelledFuture.cancel(true);
                    }
                }

                actionId = nextActionId++;
                resolvedLabel = requestedLabel == null || requestedLabel.isBlank()
                    ? "action-" + actionId
                    : requestedLabel.strip();

                active = true;
                currentActionId = actionId;
                this.releaseOnCancel = requestedReleaseOnCancel;
                state = "running";
                label = resolvedLabel;
                stepIndex = -1;
                stepCount = steps.size();
                completedSteps = 0;
                startedAt = now;
                updatedAt = now;
                message = "running";
                error = "";
                currentTimeout = null;
                currentFuture = executor.submit(() -> runAction(actionId, steps, releaseOnFinish, requestedReleaseOnCancel));
                if (timeoutMs != null && timeoutMs > 0) {
                    currentTimeout = scheduler.schedule(() -> timeout(actionId, timeoutMs), timeoutMs, TimeUnit.MILLISECONDS);
                }
                snapshot = snapshotLocked();
            }

            if (releaseCancelledKeys) {
                releaseManagedControlKeysAsync("action replaced");
            }

            Map<String, Object> payload = okPayload("started");
            payload.put("action", snapshot);
            return payload;
        }

        public Map<String, Object> cancel(String requestedReason, boolean releaseKeys) {
            Future<?> future;
            ScheduledFuture<?> timeout;
            Map<String, Object> snapshot;

            synchronized (this) {
                if (!active) {
                    Map<String, Object> payload = okPayload("idle");
                    payload.put("action", snapshotLocked());
                    return payload;
                }

                state = "cancelling";
                message = requestedReason == null || requestedReason.isBlank()
                    ? "cancel requested"
                    : requestedReason.strip();
                updatedAt = System.currentTimeMillis();
                future = currentFuture;
                timeout = currentTimeout;
                currentTimeout = null;
                snapshot = snapshotLocked();
            }

            if (timeout != null) {
                timeout.cancel(false);
            }
            if (future != null) {
                future.cancel(true);
            }
            if (releaseKeys) {
                releaseManagedControlKeysAsync(messageFromSnapshot(snapshot));
            }

            Map<String, Object> payload = okPayload("cancelling");
            payload.put("action", snapshot);
            return payload;
        }

        public synchronized Map<String, Object> snapshot() {
            return snapshotLocked();
        }

        public synchronized boolean isActive() {
            return active;
        }

        private void runAction(long actionId, JsonArray steps, boolean releaseOnFinish, boolean requestedReleaseOnCancel) {
            int completed = 0;
            try {
                for (int index = 0; index < steps.size(); index++) {
                    ensureRunning(actionId);
                    JsonElement element = steps.get(index);
                    if (!element.isJsonObject()) {
                        throw new IllegalArgumentException("steps[" + index + "] must be an object");
                    }

                    synchronized (this) {
                        if (currentActionId != actionId) {
                            return;
                        }
                        stepIndex = index;
                        updatedAt = System.currentTimeMillis();
                    }

                    executeSequenceStep(index, element.getAsJsonObject());
                    completed = index + 1;

                    synchronized (this) {
                        if (currentActionId == actionId) {
                            completedSteps = completed;
                            updatedAt = System.currentTimeMillis();
                        }
                    }
                }

                if (releaseOnFinish) {
                    releaseManagedControlKeysAsync("action completed");
                }
                finish(actionId, "completed", "completed", "", completed);
            } catch (InterruptedException interruptedException) {
                Thread.currentThread().interrupt();
                if (requestedReleaseOnCancel) {
                    releaseManagedControlKeysAsync("action interrupted");
                }
                finish(actionId, "cancelled", "cancelled", "", completed);
            } catch (Throwable throwable) {
                logger.log(Level.WARNING, "Managed action failed", throwable);
                if (requestedReleaseOnCancel) {
                    releaseManagedControlKeysAsync("action failed");
                }
                finish(actionId, "failed", "failed", throwable.getMessage() == null ? throwable.toString() : throwable.getMessage(), completed);
            }
        }

        private void timeout(long actionId, int timeoutMs) {
            Future<?> future;
            synchronized (this) {
                if (!active || currentActionId != actionId) {
                    return;
                }

                state = "cancelling";
                message = "timed out after " + timeoutMs + "ms";
                updatedAt = System.currentTimeMillis();
                future = currentFuture;
                currentTimeout = null;
            }

            if (future != null) {
                future.cancel(true);
            }
            if (releaseOnCancel) {
                releaseManagedControlKeysAsync("action timeout");
            }
        }

        private void ensureRunning(long actionId) throws InterruptedException {
            if (Thread.currentThread().isInterrupted()) {
                throw new InterruptedException("action interrupted");
            }

            synchronized (this) {
                if (!active || currentActionId != actionId) {
                    throw new InterruptedException("action no longer active");
                }
            }
        }

        private void finish(long actionId, String nextState, String nextMessage, String nextError, int completed) {
            ScheduledFuture<?> timeout;
            synchronized (this) {
                if (currentActionId != actionId) {
                    return;
                }

                active = false;
                state = nextState;
                message = nextMessage;
                error = nextError == null ? "" : nextError;
                completedSteps = completed;
                updatedAt = System.currentTimeMillis();
                currentFuture = null;
                timeout = currentTimeout;
                currentTimeout = null;
            }

            if (timeout != null) {
                timeout.cancel(false);
            }
        }

        private void updateRapidRequestCounter(long now) {
            if (lastRequestAt > 0L && now - lastRequestAt <= FAST_LOOP_WINDOW_MS) {
                rapidRequestCount++;
            } else {
                rapidRequestCount = 0;
            }
            lastRequestAt = now;
        }

        private Map<String, Object> snapshotLocked() {
            Map<String, Object> payload = new LinkedHashMap<>();
            payload.put("ok", Boolean.TRUE);
            payload.put("active", active);
            payload.put("isIdle", !active);
            payload.put("current", active ? label : "Idle");
            payload.put("state", state);
            payload.put("id", currentActionId == 0L ? null : currentActionId);
            payload.put("label", label);
            payload.put("stepIndex", stepIndex);
            payload.put("stepNumber", stepIndex < 0 ? 0 : stepIndex + 1);
            payload.put("stepCount", stepCount);
            payload.put("completedSteps", completedSteps);
            payload.put("startedAt", startedAt == 0L ? null : startedAt);
            payload.put("updatedAt", updatedAt == 0L ? null : updatedAt);
            payload.put("message", message);
            payload.put("error", error);
            payload.put("rapidRequests", rapidRequestCount);
            return payload;
        }

        private void releaseManagedControlKeysAsync(String reason) {
            Map<String, Boolean> releaseKeys = new LinkedHashMap<>();
            for (String key : MOVEMENT_SEQUENCE_KEYS) {
                releaseKeys.put(key, Boolean.FALSE);
            }

            try {
                bridge.submitControlState(releaseKeys, false, null, null, null, null, null, throwable -> logger.log(Level.FINE, "Failed to release managed action control after " + reason, throwable));
            } catch (Throwable throwable) {
                logger.log(Level.FINE, "Failed to queue managed action control release after " + reason, throwable);
            }
        }
    }

    private static String messageFromSnapshot(Map<String, Object> snapshot) {
        Object value = snapshot.get("message");
        return value == null ? "action cancelled" : String.valueOf(value);
    }

    private record HttpRequest(String method, String path, String query, Map<String, String> headers, byte[] body) {
    }

    private record HttpResponse(int statusCode, Map<String, String> headers, byte[] body) {
    }

    private record WebSocketFrame(boolean fin, int opcode, byte[] payload) {
    }
}
