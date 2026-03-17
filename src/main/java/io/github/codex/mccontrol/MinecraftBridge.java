package io.github.codex.mccontrol;

import java.io.File;
import java.io.IOException;
import java.lang.reflect.Constructor;
import java.lang.reflect.Field;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Comparator;
import java.util.Deque;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.Executor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.function.Consumer;
import java.util.stream.Stream;

public final class MinecraftBridge {
    private final ChatHistory chatHistory = new ChatHistory();
    private final Map<String, DebugFakePlayer> debugFakePlayers = new LinkedHashMap<>();

    private int nextDebugFakeEntityId = 2_000_000_000;

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
    private final Class<?> abstractContainerScreenClass;
    private final Class<?> abstractContainerMenuClass;
    private final Class<?> slotClass;
    private final Class<?> itemStackClass;
    private final Class<?> hitResultClass;
    private final Class<?> blockHitResultClass;
    private final Class<?> entityHitResultClass;
    private final Class<?> vec3Class;
    private final Class<?> blockPosClass;
    private final Class<?> playerInfoClass;
    private final Class<?> clientLevelClass;
    private final Class<?> remotePlayerClass;
    private final Class<?> gameProfileClass;
    private final Class<?> screenshotClass;
    private final Class<?> entityRemovalReasonClass;
    private final Class<?> renderTargetClass;

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
    private final Method componentLiteralMethod;
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
    private final Method hitResultGetTypeMethod;
    private final Method hitResultGetLocationMethod;
    private final Method blockHitResultGetBlockPosMethod;
    private final Method blockHitResultGetDirectionMethod;
    private final Method entityHitResultGetEntityMethod;
    private final Method blockPosAsLongMethod;
    private final Method blockPosGetXMethod;
    private final Method blockPosGetYMethod;
    private final Method blockPosGetZMethod;
    private final Method menuGetCarriedMethod;
    private final Method slotGetItemMethod;
    private final Method slotHasItemMethod;
    private final Method slotIsActiveMethod;
    private final Method slotGetContainerSlotMethod;
    private final Method slotIsFakeMethod;
    private final Method itemStackIsEmptyMethod;
    private final Method itemStackGetHoverNameMethod;
    private final Method itemStackGetCountMethod;
    private final Method itemStackGetItemMethod;
    private final Method packetListenerGetListedOnlinePlayersMethod;
    private final Method playerInfoGetProfileMethod;
    private final Method playerInfoGetGameModeMethod;
    private final Method playerInfoGetLatencyMethod;
    private final Method playerInfoGetTabListDisplayNameMethod;
    private final Method gameProfileGetIdMethod;
    private final Method gameProfileGetNameMethod;
    private final Method clientLevelAddEntityMethod;
    private final Method clientLevelRemoveEntityMethod;
    private final Method clientLevelGetEntityMethod;
    private final Method entityGetIdMethod;
    private final Method entityGetUuidMethod;
    private final Method entityGetNameMethod;
    private final Method entitySetIdMethod;
    private final Method entitySetUuidMethod;
    private final Method entitySetPosMethod;
    private final Method entitySetPosRawMethod;
    private final Method entitySetCustomNameMethod;
    private final Method entitySetCustomNameVisibleMethod;
    private final Method entitySetNoGravityMethod;
    private final Method entitySetInvisibleMethod;
    private final Method screenshotGrabMethod;

    private final Constructor<?> gameProfileConstructor;
    private final Constructor<?> remotePlayerConstructor;

    private final Field minecraftGameDirectoryField;
    private final Field minecraftOptionsField;
    private final Field minecraftPlayerField;
    private final Field minecraftGameModeField;
    private final Field minecraftScreenField;
    private final Field minecraftGuiField;
    private final Field minecraftLevelField;
    private final Field minecraftHitResultField;
    private final Field minecraftMainRenderTargetField;
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
    private final Field abstractContainerScreenMenuField;
    private final Field abstractContainerScreenHoveredSlotField;
    private final Field abstractContainerScreenLeftPosField;
    private final Field abstractContainerScreenTopPosField;
    private final Field abstractContainerMenuSlotsField;
    private final Field slotXField;
    private final Field slotYField;
    private final Field vec3XField;
    private final Field vec3YField;
    private final Field vec3ZField;

    private final Object entityDiscardedRemovalReason;

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
        abstractContainerScreenClass = Class.forName("gti");
        abstractContainerMenuClass = Class.forName("dhi");
        slotClass = Class.forName("dji");
        itemStackClass = Class.forName("dlt");
        hitResultClass = Class.forName("ftk");
        blockHitResultClass = Class.forName("fti");
        entityHitResultClass = Class.forName("ftj");
        vec3Class = Class.forName("ftm");
        blockPosClass = Class.forName("is");
        playerInfoClass = Class.forName("hiq");
        clientLevelClass = Class.forName("hif");
        remotePlayerClass = Class.forName("hnj");
        gameProfileClass = Class.forName("com.mojang.authlib.GameProfile");
        screenshotClass = Class.forName("gfs");
        entityRemovalReasonClass = Class.forName("cgk$e");

        minecraftGameDirectoryField = findField(minecraftClass, "p");
        minecraftOptionsField = findField(minecraftClass, "k");
        minecraftPlayerField = findField(minecraftClass, "s");
        minecraftGameModeField = findField(minecraftClass, "q");
        minecraftScreenField = findField(minecraftClass, "x");
        minecraftGuiField = findField(minecraftClass, "j");
        minecraftLevelField = findField(minecraftClass, "r");
        minecraftHitResultField = findField(minecraftClass, "u");
        minecraftMainRenderTargetField = findField(minecraftClass, "an");
        renderTargetClass = minecraftMainRenderTargetField.getType();

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
        componentLiteralMethod = findMethod(componentClass, "b", String.class);
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
        hitResultGetTypeMethod = findMethod(hitResultClass, "d");
        hitResultGetLocationMethod = findMethod(hitResultClass, "g");
        blockHitResultGetBlockPosMethod = findMethod(blockHitResultClass, "b");
        blockHitResultGetDirectionMethod = findMethod(blockHitResultClass, "c");
        entityHitResultGetEntityMethod = findMethod(entityHitResultClass, "a");
        blockPosAsLongMethod = findMethod(blockPosClass, "a");
        blockPosGetXMethod = findMethod(blockPosClass, "a", long.class);
        blockPosGetYMethod = findMethod(blockPosClass, "b", long.class);
        blockPosGetZMethod = findMethod(blockPosClass, "c", long.class);
        menuGetCarriedMethod = findMethod(abstractContainerMenuClass, "g");
        slotGetItemMethod = findMethod(slotClass, "g");
        slotHasItemMethod = findMethod(slotClass, "h");
        slotIsActiveMethod = findMethod(slotClass, "b");
        slotGetContainerSlotMethod = findMethod(slotClass, "i");
        slotIsFakeMethod = findMethod(slotClass, "f");
        itemStackIsEmptyMethod = findMethod(itemStackClass, "f");
        itemStackGetHoverNameMethod = findMethod(itemStackClass, "y");
        itemStackGetCountMethod = findMethod(itemStackClass, "N");
        itemStackGetItemMethod = findMethod(itemStackClass, "h");
        packetListenerGetListedOnlinePlayersMethod = findMethod(packetListenerClass, "n");
        playerInfoGetProfileMethod = findMethod(playerInfoClass, "a");
        playerInfoGetGameModeMethod = findMethod(playerInfoClass, "e");
        playerInfoGetLatencyMethod = findMethod(playerInfoClass, "f");
        playerInfoGetTabListDisplayNameMethod = findMethod(playerInfoClass, "i");
        gameProfileGetIdMethod = findAccessibleMethod(gameProfileClass, "getId");
        gameProfileGetNameMethod = findAccessibleMethod(gameProfileClass, "getName");
        clientLevelAddEntityMethod = findMethod(clientLevelClass, "d", entityClass);
        clientLevelRemoveEntityMethod = findMethod(clientLevelClass, "a", int.class, entityRemovalReasonClass);
        clientLevelGetEntityMethod = findMethod(clientLevelClass, "a", int.class);
        entityGetIdMethod = findMethod(entityClass, "aA");
        entityGetUuidMethod = findMethod(entityClass, "cY");
        entityGetNameMethod = findMethod(entityClass, "ap");
        entitySetIdMethod = findMethod(entityClass, "e", int.class);
        entitySetUuidMethod = findMethod(entityClass, "a", UUID.class);
        entitySetPosMethod = findMethod(entityClass, "a_", double.class, double.class, double.class);
        entitySetPosRawMethod = findOptionalMethod(entityClass, "n", double.class, double.class, double.class);
        entitySetCustomNameMethod = findMethod(entityClass, "b", componentClass);
        entitySetCustomNameVisibleMethod = findMethod(entityClass, "p", boolean.class);
        entitySetNoGravityMethod = findMethod(entityClass, "g", boolean.class);
        entitySetInvisibleMethod = findMethod(entityClass, "l", boolean.class);
        screenshotGrabMethod = findMethod(screenshotClass, "a", File.class, String.class, renderTargetClass, int.class, Consumer.class);

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
        abstractContainerScreenMenuField = findField(abstractContainerScreenClass, "w");
        abstractContainerScreenHoveredSlotField = findField(abstractContainerScreenClass, "y");
        abstractContainerScreenLeftPosField = findField(abstractContainerScreenClass, "z");
        abstractContainerScreenTopPosField = findField(abstractContainerScreenClass, "A");
        abstractContainerMenuSlotsField = findField(abstractContainerMenuClass, "k");
        slotXField = findField(slotClass, "e");
        slotYField = findField(slotClass, "f");
        vec3XField = findField(vec3Class, "g");
        vec3YField = findField(vec3Class, "h");
        vec3ZField = findField(vec3Class, "i");

        gameProfileConstructor = gameProfileClass.getDeclaredConstructor(UUID.class, String.class);
        gameProfileConstructor.setAccessible(true);
        remotePlayerConstructor = remotePlayerClass.getDeclaredConstructor(clientLevelClass, gameProfileClass);
        remotePlayerConstructor.setAccessible(true);
        entityDiscardedRemovalReason = findField(entityRemovalReasonClass, "b").get(null);
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

    public Map<String, Object> getCrosshairTarget() throws ReflectiveOperationException {
        return onClientThread(() -> {
            Object minecraft = getMinecraft();
            Object player = minecraftPlayerField.get(minecraft);
            Object hitResult = minecraftHitResultField.get(minecraft);

            Map<String, Object> payload = new LinkedHashMap<>();
            payload.put("ok", Boolean.TRUE);
            payload.put("inWorld", player != null);
            payload.put("screen", screenSummary(minecraftScreenField.get(minecraft)));

            if (hitResult == null) {
                payload.put("type", "NONE");
                payload.put("hit", Boolean.FALSE);
                return payload;
            }

            String type = String.valueOf(hitResultGetTypeMethod.invoke(hitResult));
            payload.put("type", type);
            payload.put("hit", !"MISS".equalsIgnoreCase(type));
            payload.put("location", vec3ToMap(hitResultGetLocationMethod.invoke(hitResult)));

            if (blockHitResultClass.isInstance(hitResult)) {
                payload.put("block", blockHitSummary(hitResult));
            } else if (entityHitResultClass.isInstance(hitResult)) {
                payload.put("entity", entitySummary(entityHitResultGetEntityMethod.invoke(hitResult)));
            }

            return payload;
        });
    }

    public Map<String, Object> getContainerContents() throws ReflectiveOperationException {
        return onClientThread(() -> {
            Object minecraft = getMinecraft();
            Object screen = minecraftScreenField.get(minecraft);

            Map<String, Object> payload = new LinkedHashMap<>();
            payload.put("ok", Boolean.TRUE);
            payload.put("screen", screenSummary(screen));

            if (screen == null || !abstractContainerScreenClass.isInstance(screen)) {
                payload.put("containerOpen", Boolean.FALSE);
                payload.put("slotCount", 0);
                payload.put("slots", List.of());
                payload.put("carried", itemStackSummary(null));
                return payload;
            }

            Object menu = abstractContainerScreenMenuField.get(screen);
            Object hoveredSlot = abstractContainerScreenHoveredSlotField.get(screen);
            @SuppressWarnings("unchecked")
            List<Object> slots = (List<Object>) abstractContainerMenuSlotsField.get(menu);

            List<Map<String, Object>> slotPayloads = new ArrayList<>();
            for (int index = 0; index < slots.size(); index++) {
                Object slot = slots.get(index);
                Map<String, Object> slotPayload = new LinkedHashMap<>();
                slotPayload.put("index", index);
                slotPayload.put("containerSlot", invokeInt(slotGetContainerSlotMethod, slot));
                slotPayload.put("x", ((Number) slotXField.get(slot)).intValue());
                slotPayload.put("y", ((Number) slotYField.get(slot)).intValue());
                slotPayload.put("active", slotIsActiveMethod.invoke(slot));
                slotPayload.put("fake", slotIsFakeMethod.invoke(slot));
                slotPayload.put("hovered", slot == hoveredSlot);
                slotPayload.put("hasItem", slotHasItemMethod.invoke(slot));
                slotPayload.put("item", itemStackSummary(slotGetItemMethod.invoke(slot)));
                slotPayloads.add(slotPayload);
            }

            payload.put("containerOpen", Boolean.TRUE);
            payload.put("className", screen.getClass().getName());
            payload.put("leftPos", ((Number) abstractContainerScreenLeftPosField.get(screen)).intValue());
            payload.put("topPos", ((Number) abstractContainerScreenTopPosField.get(screen)).intValue());
            payload.put("slotCount", slotPayloads.size());
            payload.put("slots", slotPayloads);
            payload.put("carried", itemStackSummary(menuGetCarriedMethod.invoke(menu)));
            return payload;
        });
    }

    public Map<String, Object> getPlayerList() throws ReflectiveOperationException {
        return onClientThread(() -> {
            Object minecraft = getMinecraft();
            Object player = minecraftPlayerField.get(minecraft);

            Map<String, Object> payload = new LinkedHashMap<>();
            payload.put("ok", Boolean.TRUE);
            payload.put("inWorld", player != null);

            if (player == null) {
                payload.put("count", 0);
                payload.put("players", List.of());
                return payload;
            }

            Object connection = localPlayerConnectionField.get(player);
            @SuppressWarnings("unchecked")
            Collection<Object> rawPlayers = (Collection<Object>) packetListenerGetListedOnlinePlayersMethod.invoke(connection);

            List<Map<String, Object>> players = new ArrayList<>();
            for (Object rawPlayer : rawPlayers) {
                players.add(playerInfoSummary(rawPlayer));
            }

            players.sort(Comparator.comparing(entry -> String.valueOf(entry.get("name")), String.CASE_INSENSITIVE_ORDER));
            payload.put("count", players.size());
            payload.put("players", players);
            return payload;
        });
    }

    public Map<String, Object> takeScreenshot(String requestedName) throws ReflectiveOperationException {
        Path gameDirectory = getGameDirectory();
        String fileName = normalizeScreenshotName(requestedName);
        Path screenshotDirectory = gameDirectory.resolve("screenshots");
        long startedAt = System.currentTimeMillis();
        CompletableFuture<Path> savedPathFuture = new CompletableFuture<>();

        try {
            Files.createDirectories(screenshotDirectory);
        } catch (IOException ioException) {
            throw new IllegalStateException("failed to create screenshots directory", ioException);
        }

        onClientThread(() -> {
            Object minecraft = getMinecraft();
            Object renderTarget = minecraftMainRenderTargetField.get(minecraft);
            Consumer<Object> callback = ignored -> {
                try {
                    savedPathFuture.complete(resolveScreenshotPath(screenshotDirectory, fileName, startedAt));
                } catch (Throwable throwable) {
                    savedPathFuture.completeExceptionally(throwable);
                }
            };

            screenshotGrabMethod.invoke(null, gameDirectory.toFile(), fileName, renderTarget, 1, callback);
            return null;
        });

        try {
            Path savedPath = savedPathFuture.get(15L, TimeUnit.SECONDS);
            Map<String, Object> payload = new LinkedHashMap<>();
            payload.put("ok", Boolean.TRUE);
            payload.put("name", savedPath.getFileName().toString());
            payload.put("path", savedPath.toAbsolutePath().toString());
            return payload;
        } catch (InterruptedException interruptedException) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException("interrupted while waiting for screenshot", interruptedException);
        } catch (TimeoutException timeoutException) {
            throw new IllegalStateException("screenshot timed out", timeoutException);
        } catch (ExecutionException executionException) {
            Throwable cause = executionException.getCause();
            if (cause instanceof RuntimeException runtimeException) {
                throw runtimeException;
            }
            if (cause instanceof Error error) {
                throw error;
            }
            throw new IllegalStateException("failed to save screenshot", cause);
        }
    }

    public Map<String, Object> listDebugFakePlayers() throws ReflectiveOperationException {
        return onClientThread(() -> {
            Object level = minecraftLevelField.get(getMinecraft());
            List<Map<String, Object>> players = new ArrayList<>();

            if (level == null) {
                debugFakePlayers.clear();
            } else {
                List<String> missingNames = new ArrayList<>();
                for (DebugFakePlayer debugFakePlayer : debugFakePlayers.values()) {
                    Object entity = clientLevelGetEntityMethod.invoke(level, debugFakePlayer.entityId());
                    if (entity == null) {
                        missingNames.add(debugFakePlayer.name());
                        continue;
                    }
                    players.add(debugFakePlayerSummary(debugFakePlayer, entity));
                }
                for (String missingName : missingNames) {
                    debugFakePlayers.remove(missingName);
                }
            }

            Map<String, Object> payload = new LinkedHashMap<>();
            payload.put("ok", Boolean.TRUE);
            payload.put("localOnly", Boolean.TRUE);
            payload.put("count", players.size());
            payload.put("players", players);
            return payload;
        });
    }

    public Map<String, Object> spawnDebugFakePlayer(
        String name,
        Double x,
        Double y,
        Double z,
        Float yaw,
        Float pitch,
        Boolean invisible,
        Boolean noGravity,
        Boolean nameVisible
    ) throws ReflectiveOperationException {
        String normalizedName = normalizeFakePlayerName(name);
        return onClientThread(() -> {
            Object player = requirePlayer();
            Object level = requireLevel();

            DebugFakePlayer existing = debugFakePlayers.remove(normalizedName);
            if (existing != null) {
                clientLevelRemoveEntityMethod.invoke(level, existing.entityId(), entityDiscardedRemovalReason);
            }

            UUID uuid = UUID.randomUUID();
            Object profile = gameProfileConstructor.newInstance(uuid, normalizedName);
            Object entity = remotePlayerConstructor.newInstance(level, profile);
            int entityId = nextDebugFakeEntityId++;

            entitySetIdMethod.invoke(entity, entityId);
            entitySetUuidMethod.invoke(entity, uuid);
            setEntityPosition(
                entity,
                x != null ? x : invokeDouble(entityGetXMethod, player),
                y != null ? y : invokeDouble(entityGetYMethod, player),
                z != null ? z : invokeDouble(entityGetZMethod, player)
            );
            entitySetYawMethod.invoke(entity, yaw != null ? yaw : invokeFloat(entityGetYawMethod, player));
            entitySetPitchMethod.invoke(entity, pitch != null ? pitch : invokeFloat(entityGetPitchMethod, player));
            entitySetInvisibleMethod.invoke(entity, invisible != null ? invisible : Boolean.FALSE);
            entitySetNoGravityMethod.invoke(entity, noGravity != null ? noGravity : Boolean.TRUE);
            entitySetCustomNameMethod.invoke(entity, componentLiteralMethod.invoke(null, normalizedName));
            entitySetCustomNameVisibleMethod.invoke(entity, nameVisible != null ? nameVisible : Boolean.TRUE);

            clientLevelAddEntityMethod.invoke(level, entity);

            DebugFakePlayer debugFakePlayer = new DebugFakePlayer(normalizedName, uuid, entityId);
            debugFakePlayers.put(normalizedName, debugFakePlayer);
            return debugFakePlayerSummary(debugFakePlayer, entity);
        });
    }

    public Map<String, Object> moveDebugFakePlayer(
        String name,
        Double x,
        Double y,
        Double z,
        Float yaw,
        Float pitch,
        Boolean invisible,
        Boolean noGravity,
        Boolean nameVisible
    ) throws ReflectiveOperationException {
        String normalizedName = normalizeFakePlayerName(name);
        return onClientThread(() -> {
            DebugFakePlayer debugFakePlayer = requireDebugFakePlayer(normalizedName);
            Object entity = requireDebugFakePlayerEntity(debugFakePlayer);

            setEntityPosition(
                entity,
                x != null ? x : invokeDouble(entityGetXMethod, entity),
                y != null ? y : invokeDouble(entityGetYMethod, entity),
                z != null ? z : invokeDouble(entityGetZMethod, entity)
            );
            if (yaw != null) {
                entitySetYawMethod.invoke(entity, yaw);
            }
            if (pitch != null) {
                entitySetPitchMethod.invoke(entity, pitch);
            }
            if (invisible != null) {
                entitySetInvisibleMethod.invoke(entity, invisible);
            }
            if (noGravity != null) {
                entitySetNoGravityMethod.invoke(entity, noGravity);
            }
            if (nameVisible != null) {
                entitySetCustomNameVisibleMethod.invoke(entity, nameVisible);
            }

            return debugFakePlayerSummary(debugFakePlayer, entity);
        });
    }

    public Map<String, Object> removeDebugFakePlayer(String name) throws ReflectiveOperationException {
        String normalizedName = normalizeFakePlayerName(name);
        return onClientThread(() -> {
            Object level = minecraftLevelField.get(getMinecraft());
            DebugFakePlayer debugFakePlayer = debugFakePlayers.remove(normalizedName);
            if (debugFakePlayer == null) {
                throw new IllegalArgumentException("fake player not found: " + normalizedName);
            }

            if (level != null) {
                clientLevelRemoveEntityMethod.invoke(level, debugFakePlayer.entityId(), entityDiscardedRemovalReason);
            }

            Map<String, Object> payload = new LinkedHashMap<>();
            payload.put("ok", Boolean.TRUE);
            payload.put("removed", normalizedName);
            return payload;
        });
    }

    public Map<String, Object> clearDebugFakePlayers() throws ReflectiveOperationException {
        return onClientThread(() -> {
            Object level = minecraftLevelField.get(getMinecraft());
            int removed = debugFakePlayers.size();

            if (level != null) {
                for (DebugFakePlayer debugFakePlayer : debugFakePlayers.values()) {
                    clientLevelRemoveEntityMethod.invoke(level, debugFakePlayer.entityId(), entityDiscardedRemovalReason);
                }
            }

            debugFakePlayers.clear();

            Map<String, Object> payload = new LinkedHashMap<>();
            payload.put("ok", Boolean.TRUE);
            payload.put("removed", removed);
            payload.put("localOnly", Boolean.TRUE);
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
            double centerX = invokeInt(widgetGetXMethod, widget) + invokeInt(widgetGetWidthMethod, widget) / 2.0D;
            double centerY = invokeInt(widgetGetYMethod, widget) + invokeInt(widgetGetHeightMethod, widget) / 2.0D;
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
