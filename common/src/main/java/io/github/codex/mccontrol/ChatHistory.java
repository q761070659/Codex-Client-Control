package io.github.codex.mccontrol;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.stream.Collectors;

/**
 * 聊天历史记录管理类。
 *
 * <p>使用环形缓冲区模式管理聊天消息，支持：</p>
 * <ul>
 *   <li>消息去重（基于时间戳、标签和内容的组合键）</li>
 *   <li>固定容量限制（防止内存无限增长）</li>
 *   <li>增量快照查询（基于序列号的范围查询）</li>
 * </ul>
 *
 * <p>容量限制：</p>
 * <ul>
 *   <li>最大唯一键数量：4096</li>
 *   <li>最大消息数量：1024</li>
 * </ul>
 */
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
        int safeLimit = Math.max(1, limit);

        List<Map<String, Object>> trimmed = messages.stream()
            .filter(msg -> ((Number) msg.get("sequence")).longValue() > sinceExclusive)
            .collect(Collectors.toList());

        int fromIndex = Math.max(0, trimmed.size() - safeLimit);
        if (fromIndex > 0) {
            trimmed = new ArrayList<>(trimmed.subList(fromIndex, trimmed.size()));
        }

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
