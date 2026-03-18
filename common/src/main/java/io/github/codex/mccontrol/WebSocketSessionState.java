package io.github.codex.mccontrol;

import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

/**
 * WebSocket 会话状态管理类。
 *
 * <p>负责管理单个 WebSocket 连接的会话状态，包括：</p>
 * <ul>
 *   <li>主题订阅管理</li>
 *   <li>推送间隔控制</li>
 *   <li>控制输入空闲释放</li>
 *   <li>有效载荷去重</li>
 * </ul>
 *
 * @see ControlHttpServer
 */
final class WebSocketSessionState {

    private static final int DEFAULT_INTERVAL_MS = 50;
    private static final int MIN_INTERVAL_MS = 25;
    private static final int MAX_INTERVAL_MS = 5_000;
    private static final int DEFAULT_CONTROL_IDLE_RELEASE_MS = 250;

    private final Object writeLock = new Object();
    private final Set<String> topics = new LinkedHashSet<>();
    private final Set<String> skipInitialTopics = new HashSet<>();
    private final Map<String, String> lastPayloads = new LinkedHashMap<>();
    private final Map<String, Boolean> activeControlKeys = new LinkedHashMap<>();

    private volatile boolean open = true;
    private volatile long nextPushAtMillis = 0L;
    private volatile int intervalMs = DEFAULT_INTERVAL_MS;
    private volatile long chatSince = -1L;
    private volatile long lastControlInputAtMillis = 0L;

    public synchronized Map<String, Object> subscribe(List<String> requestedTopics, Integer requestedIntervalMs, boolean includeInitial, Long requestedChatSince) {
        if (requestedIntervalMs != null) {
            if (requestedIntervalMs < MIN_INTERVAL_MS || requestedIntervalMs > MAX_INTERVAL_MS) {
                throw new IllegalArgumentException("intervalMs must be between " + MIN_INTERVAL_MS + " and " + MAX_INTERVAL_MS);
            }
            intervalMs = requestedIntervalMs;
        }

        topics.addAll(requestedTopics);
        if (requestedChatSince != null) {
            chatSince = requestedChatSince;
        }

        if (includeInitial) {
            for (String topic : requestedTopics) {
                lastPayloads.remove(topic);
                skipInitialTopics.remove(topic);
            }
            nextPushAtMillis = 0L;
        } else {
            skipInitialTopics.addAll(requestedTopics);
        }

        return snapshot();
    }

    public synchronized Map<String, Object> unsubscribe(List<String> requestedTopics) {
        if (requestedTopics.isEmpty()) {
            topics.clear();
            skipInitialTopics.clear();
            lastPayloads.clear();
        } else {
            for (String topic : requestedTopics) {
                topics.remove(topic);
                skipInitialTopics.remove(topic);
                lastPayloads.remove(topic);
            }
        }
        return snapshot();
    }

    public synchronized Map<String, Object> snapshot() {
        Map<String, Object> payload = Map.of(
            "ok", Boolean.TRUE,
            "subscribed", new ArrayList<>(topics),
            "intervalMs", intervalMs,
            "chatSince", chatSince,
            "controlIdleReleaseMs", DEFAULT_CONTROL_IDLE_RELEASE_MS
        );
        return new LinkedHashMap<>(payload);
    }

    public synchronized List<String> topicsSnapshot() {
        return new ArrayList<>(topics);
    }

    public synchronized boolean rememberPayload(String topic, String payload) {
        if (skipInitialTopics.remove(topic)) {
            lastPayloads.put(topic, payload);
            return false;
        }
        String previous = lastPayloads.put(topic, payload);
        return !payload.equals(previous);
    }

    public synchronized void recordControlInput(Map<String, Boolean> keyStates, boolean clearMovement) {
        if (clearMovement) {
            activeControlKeys.clear();
        }

        if (keyStates != null) {
            for (Map.Entry<String, Boolean> entry : keyStates.entrySet()) {
                String key = entry.getKey() == null ? null : entry.getKey().strip().toLowerCase(Locale.ROOT);
                if (!isManagedControlKey(key)) {
                    continue;
                }
                if (Boolean.TRUE.equals(entry.getValue())) {
                    activeControlKeys.put(key, Boolean.TRUE);
                } else {
                    activeControlKeys.remove(key);
                }
            }
        }

        lastControlInputAtMillis = activeControlKeys.isEmpty()
            ? 0L
            : System.currentTimeMillis();
    }

    public synchronized Map<String, Boolean> consumeStaleControlRelease(long now) {
        if (activeControlKeys.isEmpty() || lastControlInputAtMillis <= 0L || now - lastControlInputAtMillis < DEFAULT_CONTROL_IDLE_RELEASE_MS) {
            return Collections.emptyMap();
        }
        return drainControlRelease();
    }

    public synchronized Map<String, Boolean> consumeAllControlRelease() {
        if (activeControlKeys.isEmpty()) {
            return Collections.emptyMap();
        }
        return drainControlRelease();
    }

    private Map<String, Boolean> drainControlRelease() {
        Map<String, Boolean> releasedKeys = new LinkedHashMap<>();
        for (String key : activeControlKeys.keySet()) {
            releasedKeys.put(key, Boolean.FALSE);
        }
        activeControlKeys.clear();
        lastControlInputAtMillis = 0L;
        return releasedKeys;
    }

    public boolean shouldPushNow() {
        long now = System.currentTimeMillis();
        if (now < nextPushAtMillis) {
            return false;
        }
        nextPushAtMillis = now + intervalMs;
        return true;
    }

    public Object writeLock() {
        return writeLock;
    }

    public long chatSince() {
        return chatSince;
    }

    public void setChatSince(long chatSince) {
        this.chatSince = chatSince;
    }

    public boolean isOpen() {
        return open;
    }

    public void close() {
        open = false;
    }

    private static final String[] MOVEMENT_SEQUENCE_KEYS = { "forward", "back", "left", "right", "jump", "sneak", "sprint", "use", "attack" };

    private static boolean isManagedControlKey(String keyName) {
        if (keyName == null || keyName.isBlank()) {
            return false;
        }

        String normalized = keyName.strip().toLowerCase(Locale.ROOT);
        for (String key : MOVEMENT_SEQUENCE_KEYS) {
            if (key.equals(normalized)) {
                return true;
            }
        }
        return false;
    }
}
