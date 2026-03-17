package io.github.codex.mccontrol;

import java.io.File;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Deque;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.Executor;

public final class MinecraftBridge {
    private final ChatHistory chatHistory = new ChatHistory();

    private final Class<?> minecraftClass;
    private final Class<?> guiClass;
    private final Class<?> chatComponentClass;
    private final Class<?> guiMessageClass;
    private final Class<?> componentClass;
    private final Class<?> optionsClass;
    private final Class<?> keyMappingClass;
    private final Class<?> localPlayerClass;
    private final Class<?> packetListenerClass;
    private final Class<?> gameModeClass;
    private final Class<?> entityClass;
    private final Class<?> livingEntityClass;
    private final Class<?> playerClass;
    private final Class<?> inventoryClass;
    private final Class<?> foodDataClass;
    private final Class<?> screenClass;
    private final Class<?> guiEventListenerClass;
    private final Class<?> abstractWidgetClass;
    private final Class<?> editBoxClass;
    private final Class<?> keyEventClass;
    private final Class<?> characterEventClass;
    private final Class<?> mouseButtonInfoClass;
    private final Class<?> mouseButtonEventClass;

    private final Method getMinecraftInstanceMethod;
    private final Method keySetDownMethod;
    private final Method sendChatMethod;
    private final Method sendCommandMethod;
    private final Method entityGetXMethod;
    private final Method entityGetYMethod;
    private final Method entityGetZMethod;
    private final Method entityGetYawMethod;
    private final Method entityGetPitchMethod;
    private final Method entitySetYawMethod;
    private final Method entitySetPitchMethod;
    private final Method livingGetHealthMethod;
    private final Method livingGetMaxHealthMethod;
    private final Method playerGetFoodDataMethod;
    private final Method foodDataGetFoodLevelMethod;
    private final Method foodDataGetSaturationMethod;
    private final Method inventorySetSelectedSlotMethod;
    private final Method inventoryGetSelectedSlotMethod;
    private final Method gameModeSyncSelectedSlotMethod;
    private final Method guiGetChatMethod;
    private final Method componentGetStringMethod;
    private final Method screenGetTitleMethod;
    private final Method screenShouldCloseOnEscMethod;
    private final Method screenOnCloseMethod;
    private final Method screenInsertTextMethod;
    private final Method widgetGetMessageMethod;
    private final Method widgetIsActiveMethod;
    private final Method widgetGetXMethod;
    private final Method widgetGetYMethod;
    private final Method widgetGetWidthMethod;
    private final Method widgetGetHeightMethod;
    private final Method editBoxGetValueMethod;
    private final Method guiMouseClickedMethod;
    private final Method guiMouseReleasedMethod;
    private final Method guiMouseScrolledMethod;
    private final Method guiKeyPressedMethod;
    private final Method guiCharTypedMethod;

    private final Field minecraftGameDirectoryField;
    private final Field minecraftOptionsField;
    private final Field minecraftPlayerField;
    private final Field minecraftGameModeField;
    private final Field minecraftScreenField;
    private final Field minecraftGuiField;
    private final Field localPlayerConnectionField;
    private final Field playerInventoryField;
    private final Field chatAllMessagesField;
    private final Field chatRecentMessagesField;
    private final Field screenChildrenField;
    private final Field screenRenderablesField;
    private final Field screenWidthField;
    private final Field screenHeightField;
    private final Field widgetVisibleField;
    private final Field guiMessageContentField;
    private final Field guiMessageTagField;
    private final Field guiMessageAddedTimeField;
    private final Field guiMessageTagLogTagField;

    public MinecraftBridge() throws ReflectiveOperationException {
        minecraftClass = Class.forName("gfj");
        guiClass = Class.forName("giq");
        chatComponentClass = Class.forName("gjf");
        guiMessageClass = Class.forName("gfc");
        componentClass = Class.forName("yh");
        optionsClass = Class.forName("gfo");
        keyMappingClass = Class.forName("gfh");
        localPlayerClass = Class.forName("hnh");
        packetListenerClass = Class.forName("hig");
        gameModeClass = Class.forName("hio");
        entityClass = Class.forName("cgk");
        livingEntityClass = Class.forName("chl");
        playerClass = Class.forName("ddm");
        inventoryClass = Class.forName("ddl");
        foodDataClass = Class.forName("dhe");
        screenClass = Class.forName("gsb");
        guiEventListenerClass = Class.forName("gmm");
        abstractWidgetClass = Class.forName("gjc");
        editBoxClass = Class.forName("gjn");
        keyEventClass = Class.forName("gzb");
        characterEventClass = Class.forName("gyy");
        mouseButtonInfoClass = Class.forName("gzd");
        mouseButtonEventClass = Class.forName("gzc");

        getMinecraftInstanceMethod = findMethod(minecraftClass, "V");
        keySetDownMethod = findMethod(keyMappingClass, "a", boolean.class);
        sendChatMethod = findMethod(packetListenerClass, "c", String.class);
        sendCommandMethod = findMethod(packetListenerClass, "d", String.class);
        entityGetXMethod = findMethod(entityClass, "dP");
        entityGetYMethod = findMethod(entityClass, "dR");
        entityGetZMethod = findMethod(entityClass, "dV");
        entityGetYawMethod = findMethod(entityClass, "ec");
        entityGetPitchMethod = findMethod(entityClass, "ee");
        entitySetYawMethod = findMethod(entityClass, "v", float.class);
        entitySetPitchMethod = findMethod(entityClass, "w", float.class);
        livingGetHealthMethod = findMethod(livingEntityClass, "eZ");
        livingGetMaxHealthMethod = findMethod(livingEntityClass, "fq");
        playerGetFoodDataMethod = findMethod(playerClass, "gW");
        foodDataGetFoodLevelMethod = findMethod(foodDataClass, "a");
        foodDataGetSaturationMethod = findMethod(foodDataClass, "d");
        inventorySetSelectedSlotMethod = findMethod(inventoryClass, "d", int.class);
        inventoryGetSelectedSlotMethod = findMethod(inventoryClass, "g");
        gameModeSyncSelectedSlotMethod = findMethod(gameModeClass, "l");
        guiGetChatMethod = findMethod(guiClass, "e");
        componentGetStringMethod = findMethod(componentClass, "getString");
        screenGetTitleMethod = findMethod(screenClass, "q");
        screenShouldCloseOnEscMethod = findMethod(screenClass, "aY_");
        screenOnCloseMethod = findMethod(screenClass, "aX_");
        screenInsertTextMethod = findMethod(screenClass, "a_", String.class, boolean.class);
        widgetGetMessageMethod = findMethod(abstractWidgetClass, "B");
        widgetIsActiveMethod = findMethod(abstractWidgetClass, "b");
        widgetGetXMethod = findMethod(abstractWidgetClass, "aT_");
        widgetGetYMethod = findMethod(abstractWidgetClass, "aU_");
        widgetGetWidthMethod = findMethod(abstractWidgetClass, "aS_");
        widgetGetHeightMethod = findMethod(abstractWidgetClass, "aR_");
        editBoxGetValueMethod = findMethod(editBoxClass, "a");
        guiMouseClickedMethod = findMethod(guiEventListenerClass, "a", mouseButtonEventClass, boolean.class);
        guiMouseReleasedMethod = findMethod(guiEventListenerClass, "b", mouseButtonEventClass);
        guiMouseScrolledMethod = findMethod(guiEventListenerClass, "a", double.class, double.class, double.class, double.class);
        guiKeyPressedMethod = findMethod(guiEventListenerClass, "a", keyEventClass);
        guiCharTypedMethod = findMethod(guiEventListenerClass, "a", characterEventClass);

        minecraftGameDirectoryField = findField(minecraftClass, "p");
        minecraftOptionsField = findField(minecraftClass, "k");
        minecraftPlayerField = findField(minecraftClass, "s");
        minecraftGameModeField = findField(minecraftClass, "q");
        minecraftScreenField = findField(minecraftClass, "x");
        minecraftGuiField = findField(minecraftClass, "j");
        localPlayerConnectionField = findField(localPlayerClass, "b");
        playerInventoryField = findField(playerClass, "cE");
        chatAllMessagesField = findField(chatComponentClass, "m");
        chatRecentMessagesField = findField(chatComponentClass, "l");
        screenChildrenField = findField(screenClass, "d");
        screenRenderablesField = findField(screenClass, "t");
        screenWidthField = findField(screenClass, "o");
        screenHeightField = findField(screenClass, "p");
        widgetVisibleField = findField(abstractWidgetClass, "l");
        guiMessageContentField = findField(guiMessageClass, "b");
        guiMessageTagField = findField(guiMessageClass, "d");
        guiMessageAddedTimeField = findField(guiMessageClass, "a");
        guiMessageTagLogTagField = findOptionalField("gfd", "d");
    }

    public Path getGameDirectory() throws ReflectiveOperationException {
        Object minecraft = getMinecraft();
        File directory = (File) minecraftGameDirectoryField.get(minecraft);
        return directory.toPath();
    }

    public Map<String, Object> getStatus() throws ReflectiveOperationException {
        return onClientThread(() -> {
            Object minecraft = getMinecraft();
            Object player = minecraftPlayerField.get(minecraft);

            Map<String, Object> payload = new LinkedHashMap<>();
            payload.put("ok", Boolean.TRUE);
            payload.put("screen", screenSummary(minecraftScreenField.get(minecraft)));
            payload.put("inWorld", player != null);

            if (player != null) {
                Object foodData = playerGetFoodDataMethod.invoke(player);
                Object inventory = playerInventoryField.get(player);

                payload.put("x", invokeDouble(entityGetXMethod, player));
                payload.put("y", invokeDouble(entityGetYMethod, player));
                payload.put("z", invokeDouble(entityGetZMethod, player));
                payload.put("yaw", invokeFloat(entityGetYawMethod, player));
                payload.put("pitch", invokeFloat(entityGetPitchMethod, player));
                payload.put("health", invokeFloat(livingGetHealthMethod, player));
                payload.put("maxHealth", invokeFloat(livingGetMaxHealthMethod, player));
                payload.put("food", invokeInt(foodDataGetFoodLevelMethod, foodData));
                payload.put("saturation", invokeFloat(foodDataGetSaturationMethod, foodData));
                payload.put("selectedHotbarSlot", invokeInt(inventoryGetSelectedSlotMethod, inventory) + 1);
            }

            return payload;
        });
    }

    public Map<String, Object> getChat(long sinceExclusive, int limit) throws ReflectiveOperationException {
        return onClientThread(() -> {
            Object minecraft = getMinecraft();
            Object gui = minecraftGuiField.get(minecraft);
            Object chat = guiGetChatMethod.invoke(gui);

            List<?> rawMessages = (List<?>) chatAllMessagesField.get(chat);
            List<ChatHistory.ChatMessageSnapshot> currentMessages = new ArrayList<>();
            for (Object rawMessage : rawMessages) {
                int addedTime = ((Number) guiMessageAddedTimeField.get(rawMessage)).intValue();
                Object content = guiMessageContentField.get(rawMessage);
                Object tag = guiMessageTagField.get(rawMessage);
                currentMessages.add(new ChatHistory.ChatMessageSnapshot(
                    addedTime,
                    componentToString(content),
                    tagToString(tag)
                ));
            }

            chatHistory.record(currentMessages);

            List<String> recentTyped = new ArrayList<>();
            @SuppressWarnings("unchecked")
            Deque<String> recent = (Deque<String>) chatRecentMessagesField.get(chat);
            recentTyped.addAll(recent);

            return chatHistory.snapshot(Math.max(-1L, sinceExclusive), Math.max(1, limit), recentTyped);
        });
    }

    public Map<String, Object> getScreenSnapshot() throws ReflectiveOperationException {
        return onClientThread(() -> {
            Object minecraft = getMinecraft();
            Object screen = minecraftScreenField.get(minecraft);
            Map<String, Object> payload = screenSnapshot(screen, true);
            payload.put("ok", Boolean.TRUE);
            return payload;
        });
    }

    public void closeScreen() throws ReflectiveOperationException {
        onClientThread(() -> {
            Object screen = requireScreen();
            screenOnCloseMethod.invoke(screen);
            return null;
        });
    }

    public void guiClick(double x, double y, int button, boolean doubleClick) throws ReflectiveOperationException {
        onClientThread(() -> {
            Object screen = requireScreen();
            Object event = newMouseButtonEvent(x, y, button, 0);
            guiMouseClickedMethod.invoke(screen, event, doubleClick);
            return null;
        });
    }

    public void guiRelease(double x, double y, int button) throws ReflectiveOperationException {
        onClientThread(() -> {
            Object screen = requireScreen();
            Object event = newMouseButtonEvent(x, y, button, 0);
            guiMouseReleasedMethod.invoke(screen, event);
            return null;
        });
    }

    public void guiScroll(double x, double y, double deltaX, double deltaY) throws ReflectiveOperationException {
        onClientThread(() -> {
            Object screen = requireScreen();
            guiMouseScrolledMethod.invoke(screen, x, y, deltaX, deltaY);
            return null;
        });
    }

    public void guiKeyPress(int key, int scancode, int modifiers) throws ReflectiveOperationException {
        onClientThread(() -> {
            Object screen = requireScreen();
            Object event = keyEventClass.getDeclaredConstructor(int.class, int.class, int.class).newInstance(key, scancode, modifiers);
            guiKeyPressedMethod.invoke(screen, event);
            return null;
        });
    }

    public void guiType(String text) throws ReflectiveOperationException {
        String normalized = normalizeMessage(text, "text");
        onClientThread(() -> {
            Object screen = requireScreen();
            screenInsertTextMethod.invoke(screen, normalized, Boolean.FALSE);

            for (int offset = 0; offset < normalized.length();) {
                int codepoint = normalized.codePointAt(offset);
                offset += Character.charCount(codepoint);
                Object characterEvent = characterEventClass.getDeclaredConstructor(int.class, int.class).newInstance(codepoint, 0);
                guiCharTypedMethod.invoke(screen, characterEvent);
            }
            return null;
        });
    }

    public void guiClickWidget(int index, int button) throws ReflectiveOperationException {
        onClientThread(() -> {
            Object screen = requireScreen();
            List<?> children = (List<?>) screenChildrenField.get(screen);
            List<Object> widgets = new ArrayList<>();
            for (Object child : children) {
                if (abstractWidgetClass.isInstance(child) && isVisibleWidget(child)) {
                    widgets.add(child);
                }
            }

            if (index < 0 || index >= widgets.size()) {
                throw new IllegalArgumentException("widget index out of range");
            }

            Object widget = widgets.get(index);
            double centerX = invokeInt(widgetGetXMethod, widget) + invokeInt(widgetGetWidthMethod, widget) / 2.0;
            double centerY = invokeInt(widgetGetYMethod, widget) + invokeInt(widgetGetHeightMethod, widget) / 2.0;
            Object event = newMouseButtonEvent(centerX, centerY, button, 0);
            guiMouseClickedMethod.invoke(widget, event, Boolean.FALSE);
            return null;
        });
    }

    public void sendChat(String message) throws ReflectiveOperationException {
        String normalized = normalizeMessage(message, "message");
        onClientThread(() -> {
            Object player = requirePlayer();
            Object connection = localPlayerConnectionField.get(player);
            sendChatMethod.invoke(connection, normalized);
            return null;
        });
    }

    public void sendCommand(String command) throws ReflectiveOperationException {
        String normalized = normalizeMessage(command, "command");
        if (normalized.startsWith("/")) {
            normalized = normalized.substring(1);
        }
        String finalCommand = normalized;
        onClientThread(() -> {
            Object player = requirePlayer();
            Object connection = localPlayerConnectionField.get(player);
            sendCommandMethod.invoke(connection, finalCommand);
            return null;
        });
    }

    public void setLook(Float yaw, Float pitch, Float deltaYaw, Float deltaPitch) throws ReflectiveOperationException {
        onClientThread(() -> {
            Object player = requirePlayer();

            float newYaw = yaw != null ? yaw : invokeFloat(entityGetYawMethod, player);
            float newPitch = pitch != null ? pitch : invokeFloat(entityGetPitchMethod, player);

            if (deltaYaw != null) {
                newYaw += deltaYaw;
            }
            if (deltaPitch != null) {
                newPitch += deltaPitch;
            }

            newPitch = Math.max(-90.0F, Math.min(90.0F, newPitch));
            entitySetYawMethod.invoke(player, newYaw);
            entitySetPitchMethod.invoke(player, newPitch);
            return null;
        });
    }

    public void setKey(String keyName, boolean state) throws ReflectiveOperationException {
        String fieldName = optionKeyFieldName(keyName);
        onClientThread(() -> {
            Object keyMapping = resolveKeyMapping(fieldName);
            keySetDownMethod.invoke(keyMapping, state);
            return null;
        });
    }

    public void releaseAllMovementKeys() throws ReflectiveOperationException {
        for (String key : new String[] { "forward", "back", "left", "right", "jump", "sneak", "sprint", "use", "attack" }) {
            setKey(key, false);
        }
    }

    public void setHotbarSlot(int slot) throws ReflectiveOperationException {
        if (slot < 1 || slot > 9) {
            throw new IllegalArgumentException("slot must be between 1 and 9");
        }

        int selectedSlot = slot - 1;
        onClientThread(() -> {
            Object minecraft = getMinecraft();
            Object player = requirePlayer();
            Object inventory = playerInventoryField.get(player);
            inventorySetSelectedSlotMethod.invoke(inventory, selectedSlot);

            Object gameMode = minecraftGameModeField.get(minecraft);
            if (gameMode != null) {
                gameModeSyncSelectedSlotMethod.invoke(gameMode);
            }
            return null;
        });
    }

    private Map<String, Object> screenSummary(Object screen) throws ReflectiveOperationException {
        if (screen == null) {
            Map<String, Object> payload = new LinkedHashMap<>();
            payload.put("open", Boolean.FALSE);
            return payload;
        }

        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("open", Boolean.TRUE);
        payload.put("className", screen.getClass().getName());
        payload.put("title", componentToString(screenGetTitleMethod.invoke(screen)));
        payload.put("width", screenWidthField.get(screen));
        payload.put("height", screenHeightField.get(screen));
        payload.put("canCloseOnEsc", screenShouldCloseOnEscMethod.invoke(screen));
        return payload;
    }

    private Map<String, Object> screenSnapshot(Object screen, boolean includeWidgets) throws ReflectiveOperationException {
        Map<String, Object> payload = screenSummary(screen);
        if (screen == null) {
            payload.put("widgets", List.of());
            payload.put("childCount", 0);
            payload.put("renderableCount", 0);
            return payload;
        }

        List<?> children = (List<?>) screenChildrenField.get(screen);
        List<?> renderables = (List<?>) screenRenderablesField.get(screen);
        payload.put("childCount", children.size());
        payload.put("renderableCount", renderables.size());

        if (!includeWidgets) {
            return payload;
        }

        List<Map<String, Object>> widgets = new ArrayList<>();
        for (Object child : children) {
            if (!abstractWidgetClass.isInstance(child) || !isVisibleWidget(child)) {
                continue;
            }

            Map<String, Object> widget = new LinkedHashMap<>();
            widget.put("index", widgets.size());
            widget.put("className", child.getClass().getName());
            widget.put("x", invokeInt(widgetGetXMethod, child));
            widget.put("y", invokeInt(widgetGetYMethod, child));
            widget.put("width", invokeInt(widgetGetWidthMethod, child));
            widget.put("height", invokeInt(widgetGetHeightMethod, child));
            widget.put("active", widgetIsActiveMethod.invoke(child));
            widget.put("visible", widgetVisibleField.get(child));
            widget.put("message", componentToString(widgetGetMessageMethod.invoke(child)));
            if (editBoxClass.isInstance(child)) {
                widget.put("type", "editBox");
                widget.put("value", editBoxGetValueMethod.invoke(child));
            } else {
                widget.put("type", "widget");
            }
            widgets.add(widget);
        }

        payload.put("widgets", widgets);
        return payload;
    }

    private boolean isVisibleWidget(Object widget) throws IllegalAccessException {
        return (Boolean) widgetVisibleField.get(widget);
    }

    private String componentToString(Object component) throws ReflectiveOperationException {
        if (component == null) {
            return "";
        }
        return (String) componentGetStringMethod.invoke(component);
    }

    private String tagToString(Object tag) throws ReflectiveOperationException {
        if (tag == null) {
            return "";
        }
        if (guiMessageTagLogTagField != null) {
            Object value = guiMessageTagLogTagField.get(tag);
            return value == null ? "" : value.toString();
        }
        return tag.toString();
    }

    private Object requirePlayer() throws ReflectiveOperationException {
        Object minecraft = getMinecraft();
        Object player = minecraftPlayerField.get(minecraft);
        if (player == null) {
            throw new IllegalStateException("player is not available");
        }
        return player;
    }

    private Object requireScreen() throws ReflectiveOperationException {
        Object minecraft = getMinecraft();
        Object screen = minecraftScreenField.get(minecraft);
        if (screen == null) {
            throw new IllegalStateException("no screen is currently open");
        }
        return screen;
    }

    private Object newMouseButtonEvent(double x, double y, int button, int modifiers) throws ReflectiveOperationException {
        Object info = mouseButtonInfoClass.getDeclaredConstructor(int.class, int.class).newInstance(button, modifiers);
        return mouseButtonEventClass.getDeclaredConstructor(double.class, double.class, mouseButtonInfoClass).newInstance(x, y, info);
    }

    private Object resolveKeyMapping(String fieldName) throws ReflectiveOperationException {
        Object minecraft = getMinecraft();
        Object options = minecraftOptionsField.get(minecraft);
        Field field = findField(optionsClass, fieldName);
        return field.get(options);
    }

    private Object getMinecraft() throws ReflectiveOperationException {
        return getMinecraftInstanceMethod.invoke(null);
    }

    private <T> T onClientThread(ReflectiveCallable<T> callable) throws ReflectiveOperationException {
        Object minecraft = getMinecraft();
        if (!(minecraft instanceof Executor executor)) {
            throw new IllegalStateException("minecraft is not an executor");
        }

        CompletableFuture<T> future = new CompletableFuture<>();
        executor.execute(() -> {
            try {
                future.complete(callable.call());
            } catch (Throwable throwable) {
                future.completeExceptionally(throwable);
            }
        });

        try {
            return future.get();
        } catch (InterruptedException interruptedException) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException("interrupted while waiting for client thread", interruptedException);
        } catch (ExecutionException executionException) {
            Throwable cause = executionException.getCause();
            if (cause instanceof ReflectiveOperationException reflectiveOperationException) {
                throw reflectiveOperationException;
            }
            if (cause instanceof RuntimeException runtimeException) {
                throw runtimeException;
            }
            if (cause instanceof Error error) {
                throw error;
            }
            throw new IllegalStateException("client task failed", cause);
        }
    }

    private static String normalizeMessage(String value, String label) {
        if (value == null || value.isBlank()) {
            throw new IllegalArgumentException(label + " must not be empty");
        }
        return value.strip();
    }

    private static String optionKeyFieldName(String keyName) {
        Objects.requireNonNull(keyName, "keyName");
        return switch (keyName.toLowerCase(Locale.ROOT)) {
            case "forward", "up", "w" -> "s";
            case "left", "a" -> "t";
            case "back", "down", "backward", "s_key" -> "u";
            case "right", "d" -> "v";
            case "jump", "space" -> "w";
            case "sneak", "shift", "crouch" -> "x";
            case "sprint", "run" -> "y";
            case "inventory", "inv", "e" -> "z";
            case "use", "interact", "right_click" -> "C";
            case "attack", "left_click", "mine" -> "D";
            case "pick", "pick_item", "middle_click" -> "E";
            case "chat", "t" -> "F";
            default -> throw new IllegalArgumentException("unsupported key: " + keyName);
        };
    }

    private static Field findField(Class<?> owner, String name) throws ReflectiveOperationException {
        Field field = owner.getDeclaredField(name);
        field.setAccessible(true);
        return field;
    }

    private static Field findOptionalField(String ownerClassName, String name) {
        try {
            Field field = Class.forName(ownerClassName).getDeclaredField(name);
            field.setAccessible(true);
            return field;
        } catch (ReflectiveOperationException ignored) {
            return null;
        }
    }

    private static Method findMethod(Class<?> owner, String name, Class<?>... parameterTypes) throws ReflectiveOperationException {
        Method method = owner.getDeclaredMethod(name, parameterTypes);
        method.setAccessible(true);
        return method;
    }

    private static double invokeDouble(Method method, Object target) throws ReflectiveOperationException {
        return ((Number) method.invoke(target)).doubleValue();
    }

    private static float invokeFloat(Method method, Object target) throws ReflectiveOperationException {
        return ((Number) method.invoke(target)).floatValue();
    }

    private static int invokeInt(Method method, Object target) throws ReflectiveOperationException {
        return ((Number) method.invoke(target)).intValue();
    }

    @FunctionalInterface
    private interface ReflectiveCallable<T> {
        T call() throws Exception;
    }
}
