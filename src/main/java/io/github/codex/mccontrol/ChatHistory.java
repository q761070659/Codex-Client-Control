package io.github.codex.mccontrol;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

final class ChatHistory {
    private static final int MAX_KEYS = 4096;
    private static final int MAX_MESSAGES = 1024;

    private final Set<String> seenKeys = new HashSet<>();
    private final Deque<String> keyOrder = new ArrayDeque<>();
    private final Deque<Map<String, Object>> messages = new ArrayDeque<>();

    private long nextSequence = 1L;

    public synchronized void record(List<ChatMessageSnapshot> currentMessages) {
        for (ChatMessageSnapshot currentMessage : currentMessages) {
            if (!seenKeys.add(currentMessage.uniqueKey())) {
                continue;
            }

            keyOrder.addLast(currentMessage.uniqueKey());
            while (keyOrder.size() > MAX_KEYS) {
                String oldestKey = keyOrder.removeFirst();
                seenKeys.remove(oldestKey);
            }

            Map<String, Object> payload = new LinkedHashMap<>();
            payload.put("sequence", nextSequence++);
            payload.put("addedTime", currentMessage.addedTime());
            payload.put("text", currentMessage.text());
            payload.put("tag", currentMessage.tag());
            messages.addLast(payload);
            while (messages.size() > MAX_MESSAGES) {
                messages.removeFirst();
            }
        }
    }

    public synchronized Map<String, Object> snapshot(long sinceExclusive, int limit, List<String> recentTyped) {
        List<Map<String, Object>> selected = new ArrayList<>();
        int safeLimit = Math.max(1, limit);

        for (Map<String, Object> message : messages) {
            long sequence = ((Number) message.get("sequence")).longValue();
            if (sequence > sinceExclusive) {
                selected.add(message);
            }
        }

        int fromIndex = Math.max(0, selected.size() - safeLimit);
        List<Map<String, Object>> trimmed = new ArrayList<>(selected.subList(fromIndex, selected.size()));

        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("ok", Boolean.TRUE);
        payload.put("messages", trimmed);
        payload.put("recentTyped", recentTyped);
        payload.put("latestSequence", nextSequence - 1);
        return payload;
    }

    record ChatMessageSnapshot(int addedTime, String text, String tag) {
        public String uniqueKey() {
            return addedTime + "|" + tag + "|" + text;
        }
    }
}
