package io.github.codex.mccontrol;

import java.io.File;
import java.io.IOException;
import java.lang.reflect.Constructor;
import java.lang.reflect.Field;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.lang.reflect.Modifier;
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
    private static final String[] MOVEMENT_KEYS = { "forward", "back", "left", "right", "jump", "sneak", "sprint", "use", "attack" };

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
    private final Class<?> directionClass;
    private final Class<?> interactionHandClass;
    private final Class<?> playerInfoClass;
    private final Class<?> clientLevelClass;
    private final Class<?> remotePlayerClass;
    private final Class<?> gameProfileClass;
    private final Class<?> screenshotClass;
    private final Class<?> entityRemovalReasonClass;
    private final Class<?> renderTargetClass;

    private final Method getMinecraftInstanceMethod;
    private final Method keySetDownMethod;
    private final Method keyClickMethod;
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
    private final Method gameModeUseItemMethod;
    private final Method gameModeUseItemOnMethod;
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
    private final Method interactionResultConsumesActionMethod;
    private final Method interactionResultShouldSwingMethod;
    private final Method playerSwingMethod;

    private final Constructor<?> gameProfileConstructor;
    private final Constructor<?> remotePlayerConstructor;
    private final Constructor<?> vec3Constructor;
    private final Constructor<?> blockPosConstructor;
    private final Constructor<?> blockHitResultConstructor;

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
    private final Field keyMappingKeyField;
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
    private final Object directionDown;
    private final Object directionUp;
    private final Object directionNorth;
    private final Object directionSouth;
    private final Object directionWest;
    private final Object directionEast;
    private final Object mainHand;
    private final Object offHand;

    public MinecraftBridge() throws ReflectiveOperationException {
        minecraftClass = findClass("net.minecraft.client.Minecraft", "gfj");
        guiClass = findClass("net.minecraft.client.gui.Gui", "giq");
        chatComponentClass = findClass("net.minecraft.client.gui.components.ChatComponent", "gjf");
        guiMessageClass = findClass("net.minecraft.client.GuiMessage", "gfc");
        componentClass = findClass("net.minecraft.network.chat.Component", "yh");
        optionsClass = findClass("net.minecraft.client.Options", "gfo");
        keyMappingClass = findClass("net.minecraft.client.KeyMapping", "gfh");
        localPlayerClass = findClass("net.minecraft.client.player.LocalPlayer", "hnh");
        packetListenerClass = findClass("net.minecraft.client.multiplayer.ClientPacketListener", "hig");
        gameModeClass = findClass("net.minecraft.client.multiplayer.MultiPlayerGameMode", "hio");
        entityClass = findClass("net.minecraft.world.entity.Entity", "cgk");
        livingEntityClass = findClass("net.minecraft.world.entity.LivingEntity", "chl");
        playerClass = findClass("net.minecraft.world.entity.player.Player", "ddm");
        inventoryClass = findClass("net.minecraft.world.entity.player.Inventory", "ddl");
        foodDataClass = findClass("net.minecraft.world.food.FoodData", "dhe");
        screenClass = findClass("net.minecraft.client.gui.screens.Screen", "gsb");
        guiEventListenerClass = findClass("net.minecraft.client.gui.components.events.GuiEventListener", "gmm");
        abstractWidgetClass = findClass("net.minecraft.client.gui.components.AbstractWidget", "gjc");
        editBoxClass = findClass("net.minecraft.client.gui.components.EditBox", "gjn");
        keyEventClass = findClass("net.minecraft.client.input.KeyEvent", "gzb");
        characterEventClass = findClass("net.minecraft.client.input.CharacterEvent", "gyy");
        mouseButtonInfoClass = findClass("net.minecraft.client.input.MouseButtonInfo", "gzd");
        mouseButtonEventClass = findClass("net.minecraft.client.input.MouseButtonEvent", "gzc");
        abstractContainerScreenClass = findClass("net.minecraft.client.gui.screens.inventory.AbstractContainerScreen", "gti");
        abstractContainerMenuClass = findClass("net.minecraft.world.inventory.AbstractContainerMenu", "dhi");
        slotClass = findClass("net.minecraft.world.inventory.Slot", "dji");
        itemStackClass = findClass("net.minecraft.world.item.ItemStack", "dlt");
        hitResultClass = findClass("net.minecraft.world.phys.HitResult", "ftk");
        blockHitResultClass = findClass("net.minecraft.world.phys.BlockHitResult", "fti");
        entityHitResultClass = findClass("net.minecraft.world.phys.EntityHitResult", "ftj");
        vec3Class = findClass("net.minecraft.world.phys.Vec3", "ftm");
        blockPosClass = findClass("net.minecraft.core.BlockPos", "is");
        playerInfoClass = findClass("net.minecraft.client.multiplayer.PlayerInfo", "hiq");
        clientLevelClass = findClass("net.minecraft.client.multiplayer.ClientLevel", "hif");
        remotePlayerClass = findClass("net.minecraft.client.player.RemotePlayer", "hnj");
        gameProfileClass = findClass("com.mojang.authlib.GameProfile");
        screenshotClass = findClass("net.minecraft.client.Screenshot", "gfs");
        entityRemovalReasonClass = findClass("net.minecraft.world.entity.Entity$RemovalReason", "cgk$e");
        Class<?> guiMessageTagClass = findClass("net.minecraft.client.GuiMessageTag", "gfd");

        minecraftGameDirectoryField = findFieldAny(minecraftClass, "gameDirectory", "p");
        minecraftOptionsField = findFieldAny(minecraftClass, "options", "k");
        minecraftPlayerField = findFieldAny(minecraftClass, "player", "s");
        minecraftGameModeField = findFieldAny(minecraftClass, "gameMode", "q");
        minecraftScreenField = findFieldAny(minecraftClass, "screen", "x");
        minecraftGuiField = findFieldAny(minecraftClass, "gui", "j");
        minecraftLevelField = findFieldAny(minecraftClass, "level", "r");
        minecraftHitResultField = findFieldAny(minecraftClass, "hitResult", "u");
        minecraftMainRenderTargetField = findFieldAny(minecraftClass, "mainRenderTarget", "an");
        renderTargetClass = minecraftMainRenderTargetField.getType();

        getMinecraftInstanceMethod = findMethodAny(minecraftClass, new String[]{"getInstance", "V"});
        keySetDownMethod = findMethodAny(keyMappingClass, new String[]{"setDown", "a"}, boolean.class);
        keyMappingKeyField = findFieldAny(keyMappingClass, "key", "a");
        keyClickMethod = findMethodAny(keyMappingClass, new String[]{"click", "a"}, keyMappingKeyField.getType());
        sendChatMethod = findMethodAny(packetListenerClass, new String[]{"sendChat", "c"}, String.class);
        sendCommandMethod = findMethodAny(packetListenerClass, new String[]{"sendCommand", "d"}, String.class);
        entityGetXMethod = findMethodAny(entityClass, new String[]{"getX", "dP"});
        entityGetYMethod = findMethodAny(entityClass, new String[]{"getY", "dR"});
        entityGetZMethod = findMethodAny(entityClass, new String[]{"getZ", "dV"});
        entityGetYawMethod = findMethodAny(entityClass, new String[]{"getYRot", "ec"});
        entityGetPitchMethod = findMethodAny(entityClass, new String[]{"getXRot", "ee"});
        entitySetYawMethod = findMethodAny(entityClass, new String[]{"setYRot", "v"}, float.class);
        entitySetPitchMethod = findMethodAny(entityClass, new String[]{"setXRot", "w"}, float.class);
        livingGetHealthMethod = findMethodAny(livingEntityClass, new String[]{"getHealth", "eZ"});
        livingGetMaxHealthMethod = findMethodAny(livingEntityClass, new String[]{"getMaxHealth", "fq"});
        playerGetFoodDataMethod = findMethodAny(playerClass, new String[]{"getFoodData", "gW"});
        foodDataGetFoodLevelMethod = findMethodAny(foodDataClass, new String[]{"getFoodLevel", "a"});
        foodDataGetSaturationMethod = findMethodAny(foodDataClass, new String[]{"getSaturationLevel", "d"});
        inventorySetSelectedSlotMethod = findMethodAny(inventoryClass, new String[]{"setSelectedSlot", "d"}, int.class);
        inventoryGetSelectedSlotMethod = findMethodAny(inventoryClass, new String[]{"getSelectedSlot", "g"});
        gameModeSyncSelectedSlotMethod = findMethodAny(gameModeClass, new String[]{"ensureHasSentCarriedItem", "l"});
        gameModeUseItemOnMethod = findGameModeUseItemOnMethod();
        interactionHandClass = gameModeUseItemOnMethod.getParameterTypes()[1];
        gameModeUseItemMethod = findMethodAny(gameModeClass, new String[]{"useItem", "a"}, localPlayerClass, interactionHandClass);
        guiGetChatMethod = findMethodAny(guiClass, new String[]{"getChat", "e"});
        componentGetStringMethod = findMethodAny(componentClass, new String[]{"getString"});
        componentLiteralMethod = findMethodAny(componentClass, new String[]{"literal", "b"}, String.class);
        screenGetTitleMethod = findMethodAny(screenClass, new String[]{"getTitle", "q"});
        screenShouldCloseOnEscMethod = findMethodAny(screenClass, new String[]{"shouldCloseOnEsc", "aY_"});
        screenOnCloseMethod = findMethodAny(screenClass, new String[]{"onClose", "aX_"});
        screenInsertTextMethod = findMethodAny(screenClass, new String[]{"insertText", "a_"}, String.class, boolean.class);
        widgetGetMessageMethod = findMethodAny(abstractWidgetClass, new String[]{"getMessage", "B"});
        widgetIsActiveMethod = findMethodAny(abstractWidgetClass, new String[]{"isActive", "b"});
        widgetGetXMethod = findMethodAny(abstractWidgetClass, new String[]{"getX", "aT_"});
        widgetGetYMethod = findMethodAny(abstractWidgetClass, new String[]{"getY", "aU_"});
        widgetGetWidthMethod = findMethodAny(abstractWidgetClass, new String[]{"getWidth", "aS_"});
        widgetGetHeightMethod = findMethodAny(abstractWidgetClass, new String[]{"getHeight", "aR_"});
        editBoxGetValueMethod = findMethodAny(editBoxClass, new String[]{"getValue", "a"});
        guiMouseClickedMethod = findMethodAny(guiEventListenerClass, new String[]{"mouseClicked", "a"}, mouseButtonEventClass, boolean.class);
        guiMouseReleasedMethod = findMethodAny(guiEventListenerClass, new String[]{"mouseReleased", "b"}, mouseButtonEventClass);
        guiMouseScrolledMethod = findMethodAny(guiEventListenerClass, new String[]{"mouseScrolled", "a"}, double.class, double.class, double.class, double.class);
        guiKeyPressedMethod = findMethodAny(guiEventListenerClass, new String[]{"keyPressed", "a"}, keyEventClass);
        guiCharTypedMethod = findMethodAny(guiEventListenerClass, new String[]{"charTyped", "a"}, characterEventClass);
        hitResultGetTypeMethod = findMethodAny(hitResultClass, new String[]{"getType", "d"});
        hitResultGetLocationMethod = findMethodAny(hitResultClass, new String[]{"getLocation", "g"});
        blockHitResultGetBlockPosMethod = findMethodAny(blockHitResultClass, new String[]{"getBlockPos", "b"});
        blockHitResultGetDirectionMethod = findMethodAny(blockHitResultClass, new String[]{"getDirection", "c"});
        directionClass = blockHitResultGetDirectionMethod.getReturnType();
        entityHitResultGetEntityMethod = findMethodAny(entityHitResultClass, new String[]{"getEntity", "a"});
        blockPosAsLongMethod = findMethodAny(blockPosClass, new String[]{"asLong", "a"});
        blockPosGetXMethod = findMethodAny(blockPosClass, new String[]{"getX", "a"}, long.class);
        blockPosGetYMethod = findMethodAny(blockPosClass, new String[]{"getY", "b"}, long.class);
        blockPosGetZMethod = findMethodAny(blockPosClass, new String[]{"getZ", "c"}, long.class);
        menuGetCarriedMethod = findMethodAny(abstractContainerMenuClass, new String[]{"getCarried", "g"});
        slotGetItemMethod = findMethodAny(slotClass, new String[]{"getItem", "g"});
        slotHasItemMethod = findMethodAny(slotClass, new String[]{"hasItem", "h"});
        slotIsActiveMethod = findMethodAny(slotClass, new String[]{"isActive", "b"});
        slotGetContainerSlotMethod = findMethodAny(slotClass, new String[]{"getContainerSlot", "i"});
        slotIsFakeMethod = findMethodAny(slotClass, new String[]{"isFake", "f"});
        itemStackIsEmptyMethod = findMethodAny(itemStackClass, new String[]{"isEmpty", "f"});
        itemStackGetHoverNameMethod = findMethodAny(itemStackClass, new String[]{"getHoverName", "y"});
        itemStackGetCountMethod = findMethodAny(itemStackClass, new String[]{"getCount", "N"});
        itemStackGetItemMethod = findMethodAny(itemStackClass, new String[]{"getItem", "h"});
        packetListenerGetListedOnlinePlayersMethod = findMethodAny(packetListenerClass, new String[]{"getListedOnlinePlayers", "n"});
        playerInfoGetProfileMethod = findMethodAny(playerInfoClass, new String[]{"getProfile", "a"});
        playerInfoGetGameModeMethod = findMethodAny(playerInfoClass, new String[]{"getGameMode", "e"});
        playerInfoGetLatencyMethod = findMethodAny(playerInfoClass, new String[]{"getLatency", "f"});
        playerInfoGetTabListDisplayNameMethod = findMethodAny(playerInfoClass, new String[]{"getTabListDisplayName", "i"});
        gameProfileGetIdMethod = findMethodAny(gameProfileClass, new String[]{"getId", "id"});
        gameProfileGetNameMethod = findMethodAny(gameProfileClass, new String[]{"getName", "name"});
        clientLevelAddEntityMethod = findMethodAny(clientLevelClass, new String[]{"addEntity", "d"}, entityClass);
        clientLevelRemoveEntityMethod = findMethodAny(clientLevelClass, new String[]{"removeEntity", "a"}, int.class, entityRemovalReasonClass);
        clientLevelGetEntityMethod = findMethodAny(clientLevelClass, new String[]{"getEntity", "a"}, int.class);
        entityGetIdMethod = findMethodAny(entityClass, new String[]{"getId", "aA"});
        entityGetUuidMethod = findMethodAny(entityClass, new String[]{"getUUID", "cY"});
        entityGetNameMethod = findMethodAny(entityClass, new String[]{"getName", "ap"});
        entitySetIdMethod = findMethodAny(entityClass, new String[]{"setId", "e"}, int.class);
        entitySetUuidMethod = findMethodAny(entityClass, new String[]{"setUUID", "a"}, UUID.class);
        entitySetPosMethod = findMethodAny(entityClass, new String[]{"setPos", "a_"}, double.class, double.class, double.class);
        entitySetPosRawMethod = findOptionalMethodAny(entityClass, new String[]{"setPosRaw", "n"}, double.class, double.class, double.class);
        entitySetCustomNameMethod = findMethodAny(entityClass, new String[]{"setCustomName", "b"}, componentClass);
        entitySetCustomNameVisibleMethod = findMethodAny(entityClass, new String[]{"setCustomNameVisible", "p"}, boolean.class);
        entitySetNoGravityMethod = findMethodAny(entityClass, new String[]{"setNoGravity", "g"}, boolean.class);
        entitySetInvisibleMethod = findMethodAny(entityClass, new String[]{"setInvisible", "l"}, boolean.class);
        playerSwingMethod = findMethodAny(playerClass, new String[]{"swing", "a"}, interactionHandClass);
        screenshotGrabMethod = findMethodAny(screenshotClass, new String[]{"grab", "a"}, File.class, String.class, renderTargetClass, int.class, Consumer.class);
        interactionResultConsumesActionMethod = findMethodAny(gameModeUseItemOnMethod.getReturnType(), new String[]{"consumesAction", "a"});
        interactionResultShouldSwingMethod = findMethodAny(gameModeUseItemOnMethod.getReturnType(), new String[]{"shouldSwing", "b"});

        localPlayerConnectionField = findFieldAny(localPlayerClass, "connection", "b");
        playerInventoryField = findFieldAny(playerClass, "inventory", "cE");
        chatAllMessagesField = findFieldAny(chatComponentClass, "allMessages", "m");
        chatRecentMessagesField = findFieldAny(chatComponentClass, "recentChat", "l");
        screenChildrenField = findFieldAny(screenClass, "children", "d");
        screenRenderablesField = findFieldAny(screenClass, "renderables", "t");
        screenWidthField = findFieldAny(screenClass, "width", "o");
        screenHeightField = findFieldAny(screenClass, "height", "p");
        widgetVisibleField = findFieldAny(abstractWidgetClass, "visible", "l");
        guiMessageContentField = findFieldAny(guiMessageClass, "content", "b");
        guiMessageTagField = findFieldAny(guiMessageClass, "tag", "d");
        guiMessageAddedTimeField = findFieldAny(guiMessageClass, "addedTime", "a");
        guiMessageTagLogTagField = findOptionalFieldAny(guiMessageTagClass, "logTag", "d");
        abstractContainerScreenMenuField = findFieldAny(abstractContainerScreenClass, "menu", "w");
        abstractContainerScreenHoveredSlotField = findFieldAny(abstractContainerScreenClass, "hoveredSlot", "y");
        abstractContainerScreenLeftPosField = findFieldAny(abstractContainerScreenClass, "leftPos", "z");
        abstractContainerScreenTopPosField = findFieldAny(abstractContainerScreenClass, "topPos", "A");
        abstractContainerMenuSlotsField = findFieldAny(abstractContainerMenuClass, "slots", "k");
        slotXField = findFieldAny(slotClass, "x", "e");
        slotYField = findFieldAny(slotClass, "y", "f");
        vec3XField = findFieldAny(vec3Class, "x", "g");
        vec3YField = findFieldAny(vec3Class, "y", "h");
        vec3ZField = findFieldAny(vec3Class, "z", "i");

        gameProfileConstructor = gameProfileClass.getDeclaredConstructor(UUID.class, String.class);
        gameProfileConstructor.setAccessible(true);
        remotePlayerConstructor = remotePlayerClass.getDeclaredConstructor(clientLevelClass, gameProfileClass);
        remotePlayerConstructor.setAccessible(true);
        vec3Constructor = vec3Class.getDeclaredConstructor(double.class, double.class, double.class);
        vec3Constructor.setAccessible(true);
        blockPosConstructor = blockPosClass.getDeclaredConstructor(int.class, int.class, int.class);
        blockPosConstructor.setAccessible(true);
        blockHitResultConstructor = blockHitResultClass.getDeclaredConstructor(vec3Class, directionClass, blockPosClass, boolean.class);
        blockHitResultConstructor.setAccessible(true);
        entityDiscardedRemovalReason = findFieldAny(entityRemovalReasonClass, "DISCARDED", "b").get(null);
        directionDown = findFieldAny(directionClass, "DOWN", "a").get(null);
        directionUp = findFieldAny(directionClass, "UP", "b").get(null);
        directionNorth = findFieldAny(directionClass, "NORTH", "c").get(null);
        directionSouth = findFieldAny(directionClass, "SOUTH", "d").get(null);
        directionWest = findFieldAny(directionClass, "WEST", "e").get(null);
        directionEast = findFieldAny(directionClass, "EAST", "f").get(null);
        mainHand = findFieldAny(interactionHandClass, "MAIN_HAND", "a").get(null);
        offHand = findFieldAny(interactionHandClass, "OFF_HAND", "b").get(null);
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
            return statusPayload(minecraft, player);
        });
    }

    public Map<String, Object> getChat(long sinceExclusive, int limit) throws ReflectiveOperationException {
        long safeSinceExclusive = Math.max(-1L, sinceExclusive);
        int safeLimit = Math.max(1, limit);
        return onClientThread(() -> {
            Object minecraft = getMinecraft();
            return chatPayload(minecraft, safeSinceExclusive, safeLimit);
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
            Object screen = minecraftScreenField.get(minecraft);
            Object hitResult = minecraftHitResultField.get(minecraft);
            return crosshairTargetPayload(minecraft, player, screen, hitResult);
        });
    }

    public Map<String, Object> getContainerContents() throws ReflectiveOperationException {
        return onClientThread(() -> {
            Object minecraft = getMinecraft();
            Object screen = minecraftScreenField.get(minecraft);
            return containerContentsPayload(screen);
        });
    }

    public Map<String, Object> getPlayerList() throws ReflectiveOperationException {
        return onClientThread(() -> {
            Object minecraft = getMinecraft();
            Object player = minecraftPlayerField.get(minecraft);
            return playerListPayload(player);
        });
    }

    public Map<String, Object> getInventoryContents() throws ReflectiveOperationException {
        return onClientThread(() -> {
            Object minecraft = getMinecraft();
            Object player = minecraftPlayerField.get(minecraft);
            return inventoryPayload(player);
        });
    }

    public Map<String, Object> getFullState(int chatLimit) throws ReflectiveOperationException {
        int safeChatLimit = Math.max(1, chatLimit);
        return onClientThread(() -> {
            Object minecraft = getMinecraft();
            Object player = minecraftPlayerField.get(minecraft);
            Object screen = minecraftScreenField.get(minecraft);
            Object hitResult = minecraftHitResultField.get(minecraft);

            Map<String, Object> payload = new LinkedHashMap<>();
            payload.put("ok", Boolean.TRUE);
            payload.put("status", statusPayload(minecraft, player));
            payload.put("screen", screenSnapshot(screen, true));
            payload.put("target", crosshairTargetPayload(minecraft, player, screen, hitResult));
            payload.put("container", containerContentsPayload(screen));
            payload.put("players", playerListPayload(player));
            payload.put("inventory", inventoryPayload(player));
            payload.put("chat", chatPayload(minecraft, -1L, safeChatLimit));
            return payload;
        });
    }

    private Map<String, Object> statusPayload(Object minecraft, Object player) throws ReflectiveOperationException {
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
    }

    private Map<String, Object> chatPayload(Object minecraft, long sinceExclusive, int limit) throws ReflectiveOperationException {
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

        return chatHistory.snapshot(sinceExclusive, limit, recentTyped);
    }

    private Map<String, Object> crosshairTargetPayload(Object minecraft, Object player, Object screen, Object hitResult) throws ReflectiveOperationException {
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("ok", Boolean.TRUE);
        payload.put("inWorld", player != null);
        payload.put("screen", screenSummary(screen));

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
    }

    private Map<String, Object> containerContentsPayload(Object screen) throws ReflectiveOperationException {
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
    }

    private Map<String, Object> playerListPayload(Object player) throws ReflectiveOperationException {
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
    }

    private Map<String, Object> inventoryPayload(Object player) throws ReflectiveOperationException {
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("ok", Boolean.TRUE);
        payload.put("inWorld", player != null);

        if (player == null) {
            payload.put("selectedHotbarSlot", 0);
            payload.put("slotCount", 0);
            payload.put("items", List.of());
            payload.put("heldItem", itemStackSummary(null));
            return payload;
        }

        Object inventory = playerInventoryField.get(player);
        int selectedSlot = invokeInt(inventoryGetSelectedSlotMethod, inventory);
        List<InventorySection> sections = inventorySections(inventory);
        List<Map<String, Object>> items = new ArrayList<>();
        Object heldItem = null;
        int slotCount = 0;

        for (InventorySection section : sections) {
            List<?> stacks = section.stacks();
            for (int index = 0; index < stacks.size(); index++) {
                Object itemStack = stacks.get(index);
                int slot = section.slotBase() + index;
                slotCount = Math.max(slotCount, slot + 1);

                if ("main".equals(section.name()) && index == selectedSlot) {
                    heldItem = itemStack;
                }

                if (itemStack == null || (Boolean) itemStackIsEmptyMethod.invoke(itemStack)) {
                    continue;
                }

                Map<String, Object> itemPayload = itemStackSummary(itemStack);
                itemPayload.put("slot", slot);
                itemPayload.put("section", section.name());
                itemPayload.put("sectionIndex", index);
                itemPayload.put("displayName", itemPayload.get("name"));
                items.add(itemPayload);
            }
        }

        items.sort(Comparator.comparingInt(entry -> ((Number) entry.get("slot")).intValue()));
        payload.put("selectedHotbarSlot", selectedSlot + 1);
        payload.put("slotCount", slotCount);
        payload.put("items", items);
        payload.put("heldItem", itemStackSummary(heldItem));
        return payload;
    }

    private List<InventorySection> inventorySections(Object inventory) throws IllegalAccessException {
        List<List<?>> lists = new ArrayList<>();
        for (Class<?> current = inventory.getClass(); current != null && current != Object.class; current = current.getSuperclass()) {
            for (Field field : current.getDeclaredFields()) {
                if (Modifier.isStatic(field.getModifiers()) || !List.class.isAssignableFrom(field.getType())) {
                    continue;
                }

                field.setAccessible(true);
                Object value = field.get(inventory);
                if (!(value instanceof List<?> list) || !looksLikeItemStackList(list)) {
                    continue;
                }

                boolean duplicate = false;
                for (List<?> existing : lists) {
                    if (existing == list) {
                        duplicate = true;
                        break;
                    }
                }
                if (!duplicate) {
                    lists.add(list);
                }
            }
        }

        lists.sort(Comparator.comparingInt((List<?> entry) -> entry.size()).reversed());

        List<InventorySection> sections = new ArrayList<>();
        int fallbackIndex = 1;
        for (List<?> list : lists) {
            String name;
            int slotBase;
            if (list.size() == 36) {
                name = "main";
                slotBase = 0;
            } else if (list.size() == 4) {
                name = "armor";
                slotBase = 36;
            } else if (list.size() == 1) {
                name = "offhand";
                slotBase = 40;
            } else {
                name = "section" + fallbackIndex;
                slotBase = nextInventorySlotBase(sections);
                fallbackIndex += 1;
            }
            sections.add(new InventorySection(name, slotBase, list));
        }

        sections.sort(Comparator.comparingInt(InventorySection::slotBase));
        return sections;
    }

    private boolean looksLikeItemStackList(List<?> list) {
        if (list.isEmpty()) {
            return false;
        }

        int checked = 0;
        for (Object entry : list) {
            if (entry == null) {
                continue;
            }
            if (!itemStackClass.isInstance(entry)) {
                return false;
            }
            checked += 1;
            if (checked >= 4) {
                return true;
            }
        }

        return checked > 0;
    }

    private static int nextInventorySlotBase(List<InventorySection> sections) {
        int slotBase = 0;
        for (InventorySection section : sections) {
            slotBase = Math.max(slotBase, section.slotBase() + section.stacks().size());
        }
        return slotBase;
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
            applyLook(player, yaw, pitch, deltaYaw, deltaPitch);
            return null;
        });
    }

    public void setKey(String keyName, boolean state) throws ReflectiveOperationException {
        onClientThread(() -> {
            Object minecraft = getMinecraft();
            Object options = minecraftOptionsField.get(minecraft);
            applyKeyState(options, keyName, state);
            return null;
        });
    }

    public void releaseAllMovementKeys() throws ReflectiveOperationException {
        onClientThread(() -> {
            Object minecraft = getMinecraft();
            Object options = minecraftOptionsField.get(minecraft);
            for (String key : MOVEMENT_KEYS) {
                applyKeyState(options, key, false);
            }
            return null;
        });
    }

    public void setHotbarSlot(int slot) throws ReflectiveOperationException {
        if (slot < 1 || slot > 9) {
            throw new IllegalArgumentException("slot must be between 1 and 9");
        }

        int selectedSlot = slot - 1;
        onClientThread(() -> {
            Object minecraft = getMinecraft();
            Object player = requirePlayer();
            applyHotbarSlot(minecraft, player, selectedSlot);
            return null;
        });
    }

    public Map<String, Object> interactItem(String handName) throws ReflectiveOperationException {
        String normalizedHand = normalizeHandName(handName);
        return onClientThread(() -> {
            Object minecraft = getMinecraft();
            Object player = requirePlayer();
            Object gameMode = minecraftGameModeField.get(minecraft);
            if (gameMode == null) {
                throw new IllegalStateException("game mode is not available");
            }

            Object hand = resolveInteractionHand(normalizedHand);
            Object result = gameModeUseItemMethod.invoke(gameMode, player, hand);
            boolean consumesAction = (Boolean) interactionResultConsumesActionMethod.invoke(result);
            boolean shouldSwing = (Boolean) interactionResultShouldSwingMethod.invoke(result);
            if (shouldSwing) {
                playerSwingMethod.invoke(player, hand);
            }

            Map<String, Object> payload = new LinkedHashMap<>();
            payload.put("ok", Boolean.TRUE);
            payload.put("hand", normalizedHand);
            payload.put("result", String.valueOf(result));
            payload.put("consumesAction", consumesAction);
            payload.put("shouldSwing", shouldSwing);
            return payload;
        });
    }

    public Map<String, Object> interactBlock(
        int x,
        int y,
        int z,
        String faceName,
        Double hitX,
        Double hitY,
        Double hitZ,
        Boolean insideBlock,
        String handName
    ) throws ReflectiveOperationException {
        String normalizedFace = normalizeDirectionName(faceName);
        String normalizedHand = normalizeHandName(handName);
        boolean inside = insideBlock != null && insideBlock;
        return onClientThread(() -> {
            Object minecraft = getMinecraft();
            Object player = requirePlayer();
            Object gameMode = minecraftGameModeField.get(minecraft);
            if (gameMode == null) {
                throw new IllegalStateException("game mode is not available");
            }

            Object hand = resolveInteractionHand(normalizedHand);
            Object direction = resolveDirection(normalizedFace);
            double[] hit = resolveHitLocation(x, y, z, normalizedFace, hitX, hitY, hitZ);
            Object blockPos = blockPosConstructor.newInstance(x, y, z);
            Object location = vec3Constructor.newInstance(hit[0], hit[1], hit[2]);
            Object blockHitResult = blockHitResultConstructor.newInstance(location, direction, blockPos, inside);
            Object result = gameModeUseItemOnMethod.invoke(gameMode, player, hand, blockHitResult);
            boolean consumesAction = (Boolean) interactionResultConsumesActionMethod.invoke(result);
            boolean shouldSwing = (Boolean) interactionResultShouldSwingMethod.invoke(result);
            if (shouldSwing) {
                playerSwingMethod.invoke(player, hand);
            }

            Map<String, Object> hitPayload = new LinkedHashMap<>();
            hitPayload.put("x", hit[0]);
            hitPayload.put("y", hit[1]);
            hitPayload.put("z", hit[2]);

            Map<String, Object> blockPayload = new LinkedHashMap<>();
            blockPayload.put("x", x);
            blockPayload.put("y", y);
            blockPayload.put("z", z);
            blockPayload.put("face", normalizedFace);
            blockPayload.put("insideBlock", inside);

            Map<String, Object> payload = new LinkedHashMap<>();
            payload.put("ok", Boolean.TRUE);
            payload.put("hand", normalizedHand);
            payload.put("result", String.valueOf(result));
            payload.put("consumesAction", consumesAction);
            payload.put("shouldSwing", shouldSwing);
            payload.put("block", blockPayload);
            payload.put("hit", hitPayload);
            return payload;
        });
    }

    public Map<String, Object> applyControlState(
        Map<String, Boolean> keyStates,
        boolean clearMovement,
        Float yaw,
        Float pitch,
        Float deltaYaw,
        Float deltaPitch,
        Integer hotbarSlot
    ) throws ReflectiveOperationException {
        if (hotbarSlot != null && (hotbarSlot < 1 || hotbarSlot > 9)) {
            throw new IllegalArgumentException("slot must be between 1 and 9");
        }

        Map<String, Boolean> normalizedKeyStates = normalizeControlKeys(keyStates);

        return onClientThread(() -> {
            Object minecraft = getMinecraft();
            Object player = requirePlayer();
            Object options = minecraftOptionsField.get(minecraft);

            return applyControlStateNow(minecraft, player, options, normalizedKeyStates, clearMovement, yaw, pitch, deltaYaw, deltaPitch, hotbarSlot);
        });
    }

    public void submitControlState(
        Map<String, Boolean> keyStates,
        boolean clearMovement,
        Float yaw,
        Float pitch,
        Float deltaYaw,
        Float deltaPitch,
        Integer hotbarSlot,
        Consumer<Throwable> errorHandler
    ) throws ReflectiveOperationException {
        if (hotbarSlot != null && (hotbarSlot < 1 || hotbarSlot > 9)) {
            throw new IllegalArgumentException("slot must be between 1 and 9");
        }

        Map<String, Boolean> normalizedKeyStates = normalizeControlKeys(keyStates);
        Consumer<Throwable> sink = errorHandler != null ? errorHandler : ignored -> { };
        onClientThreadAsync(() -> {
            Object minecraft = getMinecraft();
            Object player = requirePlayer();
            Object options = minecraftOptionsField.get(minecraft);
            applyControlStateNow(minecraft, player, options, normalizedKeyStates, clearMovement, yaw, pitch, deltaYaw, deltaPitch, hotbarSlot);
            return null;
        }, sink);
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

    private Map<String, Object> blockHitSummary(Object blockHitResult) throws ReflectiveOperationException {
        Map<String, Object> payload = new LinkedHashMap<>();
        Object blockPos = blockHitResultGetBlockPosMethod.invoke(blockHitResult);
        payload.put("position", blockPosToMap(blockPos));
        payload.put("direction", String.valueOf(blockHitResultGetDirectionMethod.invoke(blockHitResult)));
        return payload;
    }

    private Map<String, Object> playerInfoSummary(Object playerInfo) throws ReflectiveOperationException {
        Object profile = playerInfoGetProfileMethod.invoke(playerInfo);

        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("name", String.valueOf(gameProfileGetNameMethod.invoke(profile)));
        payload.put("uuid", String.valueOf(gameProfileGetIdMethod.invoke(profile)));
        payload.put("latency", invokeInt(playerInfoGetLatencyMethod, playerInfo));
        payload.put("gameMode", String.valueOf(playerInfoGetGameModeMethod.invoke(playerInfo)));
        payload.put("displayName", componentToString(playerInfoGetTabListDisplayNameMethod.invoke(playerInfo)));
        return payload;
    }

    private Map<String, Object> entitySummary(Object entity) throws ReflectiveOperationException {
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("id", invokeInt(entityGetIdMethod, entity));
        payload.put("uuid", String.valueOf(entityGetUuidMethod.invoke(entity)));
        payload.put("name", componentToString(entityGetNameMethod.invoke(entity)));
        payload.put("className", entity.getClass().getName());
        payload.put("x", invokeDouble(entityGetXMethod, entity));
        payload.put("y", invokeDouble(entityGetYMethod, entity));
        payload.put("z", invokeDouble(entityGetZMethod, entity));
        payload.put("yaw", invokeFloat(entityGetYawMethod, entity));
        payload.put("pitch", invokeFloat(entityGetPitchMethod, entity));
        return payload;
    }

    private Map<String, Object> debugFakePlayerSummary(DebugFakePlayer debugFakePlayer, Object entity) throws ReflectiveOperationException {
        Map<String, Object> payload = entitySummary(entity);
        payload.put("debugName", debugFakePlayer.name());
        payload.put("localOnly", Boolean.TRUE);
        return payload;
    }

    private Map<String, Object> itemStackSummary(Object itemStack) throws ReflectiveOperationException {
        Map<String, Object> payload = new LinkedHashMap<>();
        if (itemStack == null || (Boolean) itemStackIsEmptyMethod.invoke(itemStack)) {
            payload.put("empty", Boolean.TRUE);
            payload.put("count", 0);
            payload.put("name", "");
            payload.put("itemClassName", "");
            return payload;
        }

        Object item = itemStackGetItemMethod.invoke(itemStack);
        payload.put("empty", Boolean.FALSE);
        payload.put("count", invokeInt(itemStackGetCountMethod, itemStack));
        payload.put("name", componentToString(itemStackGetHoverNameMethod.invoke(itemStack)));
        payload.put("itemClassName", item == null ? "" : item.getClass().getName());
        return payload;
    }

    private Map<String, Object> vec3ToMap(Object vec3) throws IllegalAccessException {
        if (vec3 == null) {
            return Map.of("x", 0.0D, "y", 0.0D, "z", 0.0D);
        }

        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("x", ((Number) vec3XField.get(vec3)).doubleValue());
        payload.put("y", ((Number) vec3YField.get(vec3)).doubleValue());
        payload.put("z", ((Number) vec3ZField.get(vec3)).doubleValue());
        return payload;
    }

    private Map<String, Object> blockPosToMap(Object blockPos) throws ReflectiveOperationException {
        long packed = ((Number) blockPosAsLongMethod.invoke(blockPos)).longValue();
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("x", ((Number) blockPosGetXMethod.invoke(null, packed)).intValue());
        payload.put("y", ((Number) blockPosGetYMethod.invoke(null, packed)).intValue());
        payload.put("z", ((Number) blockPosGetZMethod.invoke(null, packed)).intValue());
        return payload;
    }

    private Path resolveScreenshotPath(Path screenshotDirectory, String requestedName, long startedAt) {
        Path exactPath = screenshotDirectory.resolve(requestedName);
        if (Files.exists(exactPath)) {
            return exactPath;
        }

        if (!requestedName.toLowerCase(Locale.ROOT).endsWith(".png")) {
            Path pngPath = screenshotDirectory.resolve(requestedName + ".png");
            if (Files.exists(pngPath)) {
                return pngPath;
            }
        }

        String prefix = requestedName.toLowerCase(Locale.ROOT).endsWith(".png")
            ? requestedName.substring(0, requestedName.length() - 4)
            : requestedName;

        try (Stream<Path> paths = Files.list(screenshotDirectory)) {
            return paths
                .filter(Files::isRegularFile)
                .filter(path -> path.getFileName().toString().startsWith(prefix))
                .filter(path -> path.getFileName().toString().toLowerCase(Locale.ROOT).endsWith(".png"))
                .filter(path -> {
                    try {
                        return Files.getLastModifiedTime(path).toMillis() >= startedAt - 1_000L;
                    } catch (IOException ignored) {
                        return false;
                    }
                })
                .max(Comparator.comparingLong(path -> {
                    try {
                        return Files.getLastModifiedTime(path).toMillis();
                    } catch (IOException ignored) {
                        return Long.MIN_VALUE;
                    }
                }))
                .orElse(exactPath);
        } catch (IOException ignored) {
            return exactPath;
        }
    }

    private void setEntityPosition(Object entity, double x, double y, double z) throws ReflectiveOperationException {
        if (entitySetPosRawMethod != null) {
            entitySetPosRawMethod.invoke(entity, x, y, z);
        }
        entitySetPosMethod.invoke(entity, x, y, z);
    }

    private Object requireLevel() throws ReflectiveOperationException {
        Object level = minecraftLevelField.get(getMinecraft());
        if (level == null) {
            throw new IllegalStateException("level is not available");
        }
        return level;
    }

    private DebugFakePlayer requireDebugFakePlayer(String name) {
        DebugFakePlayer debugFakePlayer = debugFakePlayers.get(name);
        if (debugFakePlayer == null) {
            throw new IllegalArgumentException("fake player not found: " + name);
        }
        return debugFakePlayer;
    }

    private Object requireDebugFakePlayerEntity(DebugFakePlayer debugFakePlayer) throws ReflectiveOperationException {
        Object level = requireLevel();
        Object entity = clientLevelGetEntityMethod.invoke(level, debugFakePlayer.entityId());
        if (entity == null) {
            debugFakePlayers.remove(debugFakePlayer.name());
            throw new IllegalStateException("fake player entity is no longer available");
        }
        return entity;
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

    private float[] applyLook(Object player, Float yaw, Float pitch, Float deltaYaw, Float deltaPitch) throws ReflectiveOperationException {
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
        return new float[] { newYaw, newPitch };
    }

    private void applyKeyState(Object options, String keyName, boolean state) throws ReflectiveOperationException {
        Object keyMapping = resolveKeyMapping(options, keyName);
        keySetDownMethod.invoke(keyMapping, state);
        if (state && shouldTriggerClick(keyName)) {
            keyClickMethod.invoke(null, keyMappingKeyField.get(keyMapping));
        }
    }

    private void applyHotbarSlot(Object minecraft, Object player, int selectedSlot) throws ReflectiveOperationException {
        Object inventory = playerInventoryField.get(player);
        inventorySetSelectedSlotMethod.invoke(inventory, selectedSlot);

        Object gameMode = minecraftGameModeField.get(minecraft);
        if (gameMode != null) {
            gameModeSyncSelectedSlotMethod.invoke(gameMode);
        }
    }

    private Map<String, Boolean> normalizeControlKeys(Map<String, Boolean> keyStates) {
        Map<String, Boolean> normalizedKeyStates = new LinkedHashMap<>();
        if (keyStates == null) {
            return normalizedKeyStates;
        }
        for (Map.Entry<String, Boolean> entry : keyStates.entrySet()) {
            if (entry.getKey() == null || entry.getKey().isBlank() || entry.getValue() == null) {
                continue;
            }
            normalizedKeyStates.put(entry.getKey(), entry.getValue());
        }
        return normalizedKeyStates;
    }

    private Map<String, Object> applyControlStateNow(
        Object minecraft,
        Object player,
        Object options,
        Map<String, Boolean> normalizedKeyStates,
        boolean clearMovement,
        Float yaw,
        Float pitch,
        Float deltaYaw,
        Float deltaPitch,
        Integer hotbarSlot
    ) throws ReflectiveOperationException {
        if (clearMovement) {
            for (String key : MOVEMENT_KEYS) {
                applyKeyState(options, key, false);
            }
        }

        for (Map.Entry<String, Boolean> entry : normalizedKeyStates.entrySet()) {
            applyKeyState(options, entry.getKey(), entry.getValue());
        }

        Float appliedYaw = null;
        Float appliedPitch = null;
        if (yaw != null || pitch != null || deltaYaw != null || deltaPitch != null) {
            float[] look = applyLook(player, yaw, pitch, deltaYaw, deltaPitch);
            appliedYaw = look[0];
            appliedPitch = look[1];
        }

        if (hotbarSlot != null) {
            applyHotbarSlot(minecraft, player, hotbarSlot - 1);
        }

        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("ok", Boolean.TRUE);
        payload.put("movementCleared", clearMovement);
        payload.put("keysApplied", new ArrayList<>(normalizedKeyStates.keySet()));
        if (hotbarSlot != null) {
            payload.put("hotbarSlot", hotbarSlot);
        }
        if (appliedYaw != null && appliedPitch != null) {
            payload.put("yaw", appliedYaw);
            payload.put("pitch", appliedPitch);
        }
        return payload;
    }

    private Object resolveInteractionHand(String handName) {
        return switch (normalizeHandName(handName)) {
            case "off" -> offHand;
            default -> mainHand;
        };
    }

    private Object resolveDirection(String faceName) {
        return switch (normalizeDirectionName(faceName)) {
            case "down" -> directionDown;
            case "north" -> directionNorth;
            case "south" -> directionSouth;
            case "west" -> directionWest;
            case "east" -> directionEast;
            default -> directionUp;
        };
    }

    private double[] resolveHitLocation(int x, int y, int z, String faceName, Double hitX, Double hitY, Double hitZ) {
        double resolvedX = hitX != null ? hitX : x + 0.5D;
        double resolvedY = hitY != null ? hitY : y + 0.5D;
        double resolvedZ = hitZ != null ? hitZ : z + 0.5D;
        if (hitX != null && hitY != null && hitZ != null) {
            return new double[] { resolvedX, resolvedY, resolvedZ };
        }

        switch (normalizeDirectionName(faceName)) {
            case "down" -> resolvedY = y + 0.001D;
            case "north" -> resolvedZ = z + 0.001D;
            case "south" -> resolvedZ = z + 0.999D;
            case "west" -> resolvedX = x + 0.001D;
            case "east" -> resolvedX = x + 0.999D;
            default -> resolvedY = y + 0.999D;
        }

        return new double[] { resolvedX, resolvedY, resolvedZ };
    }

    private Object resolveKeyMapping(Object options, String keyName) throws ReflectiveOperationException {
        Field field = findFieldAny(optionsClass, optionKeyFieldNames(keyName));
        return field.get(options);
    }

    private Object resolveKeyMapping(String keyName) throws ReflectiveOperationException {
        Object minecraft = getMinecraft();
        Object options = minecraftOptionsField.get(minecraft);
        return resolveKeyMapping(options, keyName);
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
            if (cause instanceof InvocationTargetException invocationTargetException && invocationTargetException.getCause() instanceof ReflectiveOperationException reflectiveOperationException) {
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

    private void onClientThreadAsync(ReflectiveCallable<?> callable, Consumer<Throwable> errorHandler) throws ReflectiveOperationException {
        Object minecraft = getMinecraft();
        if (!(minecraft instanceof Executor executor)) {
            throw new IllegalStateException("minecraft is not an executor");
        }

        executor.execute(() -> {
            try {
                callable.call();
            } catch (Throwable throwable) {
                errorHandler.accept(throwable);
            }
        });
    }

    private static String normalizeMessage(String value, String label) {
        if (value == null || value.isBlank()) {
            throw new IllegalArgumentException(label + " must not be empty");
        }
        return value.strip();
    }

    private static String normalizeFakePlayerName(String name) {
        String normalized = normalizeMessage(name, "name");
        if (normalized.length() > 32) {
            throw new IllegalArgumentException("name must be at most 32 characters");
        }
        return normalized;
    }

    private static String normalizeHandName(String handName) {
        if (handName == null || handName.isBlank()) {
            return "main";
        }
        return switch (handName.strip().toLowerCase(Locale.ROOT)) {
            case "main", "main_hand", "main-hand", "right" -> "main";
            case "off", "off_hand", "off-hand", "left" -> "off";
            default -> throw new IllegalArgumentException("unsupported hand: " + handName);
        };
    }

    private static String normalizeDirectionName(String faceName) {
        if (faceName == null || faceName.isBlank()) {
            return "up";
        }
        return switch (faceName.strip().toLowerCase(Locale.ROOT)) {
            case "up", "top" -> "up";
            case "down", "bottom" -> "down";
            case "north", "n" -> "north";
            case "south", "s" -> "south";
            case "west", "w" -> "west";
            case "east", "e" -> "east";
            default -> throw new IllegalArgumentException("unsupported face: " + faceName);
        };
    }

    private static String normalizeScreenshotName(String requestedName) {
        String base = requestedName == null || requestedName.isBlank()
            ? "codex-" + System.currentTimeMillis()
            : requestedName.strip();
        base = base.replace('\\', '_').replace('/', '_').replace(':', '_');
        base = base.replaceAll("[^A-Za-z0-9._-]", "_");
        if (base.isBlank()) {
            base = "codex-" + System.currentTimeMillis();
        }
        return base;
    }

    private static String[] optionKeyFieldNames(String keyName) {
        Objects.requireNonNull(keyName, "keyName");
        return switch (keyName.toLowerCase(Locale.ROOT)) {
            case "forward", "up", "w" -> new String[]{"keyUp", "s"};
            case "left", "a" -> new String[]{"keyLeft", "t"};
            case "back", "down", "backward", "s_key" -> new String[]{"keyDown", "u"};
            case "right", "d" -> new String[]{"keyRight", "v"};
            case "jump", "space" -> new String[]{"keyJump", "w"};
            case "sneak", "shift", "crouch" -> new String[]{"keyShift", "x"};
            case "sprint", "run" -> new String[]{"keySprint", "y"};
            case "inventory", "inv", "e" -> new String[]{"keyInventory", "z"};
            case "use", "interact", "right_click" -> new String[]{"keyUse", "C"};
            case "attack", "left_click", "mine" -> new String[]{"keyAttack", "D"};
            case "pick", "pick_item", "middle_click" -> new String[]{"keyPickItem", "E"};
            case "chat", "t" -> new String[]{"keyChat", "F"};
            default -> throw new IllegalArgumentException("unsupported key: " + keyName);
        };
    }

    private static boolean shouldTriggerClick(String keyName) {
        return switch (keyName.toLowerCase(Locale.ROOT)) {
            case "inventory", "inv", "e", "chat", "t" -> true;
            default -> false;
        };
    }

    private static Class<?> findClass(String... names) throws ClassNotFoundException {
        ClassNotFoundException last = null;
        for (String name : names) {
            try {
                return Class.forName(name);
            } catch (ClassNotFoundException exception) {
                last = exception;
            }
        }
        throw last != null ? last : new ClassNotFoundException("no class names provided");
    }

    private static Field findFieldAny(Class<?> owner, String... names) throws ReflectiveOperationException {
        ReflectiveOperationException last = null;
        for (String name : names) {
            for (Class<?> current = owner; current != null; current = current.getSuperclass()) {
                try {
                    Field field = current.getDeclaredField(name);
                    field.setAccessible(true);
                    return field;
                } catch (NoSuchFieldException exception) {
                    last = exception;
                }
            }
        }
        throw last != null ? last : new NoSuchFieldException(owner.getName());
    }

    private static Field findOptionalFieldAny(Class<?> owner, String... names) {
        try {
            return findFieldAny(owner, names);
        } catch (ReflectiveOperationException ignored) {
            return null;
        }
    }

    private static Method findMethodAny(Class<?> owner, String[] names, Class<?>... parameterTypes) throws ReflectiveOperationException {
        ReflectiveOperationException last = null;
        for (String name : names) {
            for (Class<?> current = owner; current != null; current = current.getSuperclass()) {
                try {
                    Method method = current.getDeclaredMethod(name, parameterTypes);
                    method.setAccessible(true);
                    return method;
                } catch (NoSuchMethodException exception) {
                    last = exception;
                }
            }
            try {
                Method method = owner.getMethod(name, parameterTypes);
                method.setAccessible(true);
                return method;
            } catch (NoSuchMethodException exception) {
                last = exception;
            }
        }
        throw last != null ? last : new NoSuchMethodException(owner.getName());
    }

    private Method findGameModeUseItemOnMethod() throws ReflectiveOperationException {
        for (Method method : gameModeClass.getMethods()) {
            Class<?>[] parameterTypes = method.getParameterTypes();
            if (parameterTypes.length != 3) {
                continue;
            }
            if (parameterTypes[0] != localPlayerClass || parameterTypes[2] != blockHitResultClass) {
                continue;
            }
            String name = method.getName();
            if (!"useItemOn".equals(name) && !"a".equals(name)) {
                continue;
            }
            method.setAccessible(true);
            return method;
        }

        for (Method method : gameModeClass.getDeclaredMethods()) {
            Class<?>[] parameterTypes = method.getParameterTypes();
            if (parameterTypes.length != 3) {
                continue;
            }
            if (parameterTypes[0] != localPlayerClass || parameterTypes[2] != blockHitResultClass) {
                continue;
            }
            String name = method.getName();
            if (!"useItemOn".equals(name) && !"a".equals(name)) {
                continue;
            }
            method.setAccessible(true);
            return method;
        }

        throw new NoSuchMethodException(gameModeClass.getName() + "#useItemOn");
    }

    private static Method findOptionalMethodAny(Class<?> owner, String[] names, Class<?>... parameterTypes) {
        try {
            return findMethodAny(owner, names, parameterTypes);
        } catch (ReflectiveOperationException ignored) {
            return null;
        }
    }

    private static Method findAccessibleMethod(Class<?> owner, String name, Class<?>... parameterTypes) throws ReflectiveOperationException {
        Method method = owner.getMethod(name, parameterTypes);
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

    private record InventorySection(String name, int slotBase, List<?> stacks) {
    }

    private record DebugFakePlayer(String name, UUID uuid, int entityId) {
    }
}
