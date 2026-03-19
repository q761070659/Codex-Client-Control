package io.github.codex.mccontrol;

/**
 * API 路由路径常量类。
 *
 * <p>此类集中管理所有 HTTP 和 WebSocket API 的路径字符串常量，
 * 避免在代码中散布字符串字面量，提高可维护性和可读性。</p>
 *
 * @see ControlHttpServer
 */
public final class ApiRoutes {

    private ApiRoutes() {
    }

    public static final String PATH_ROOT = "/";
    public static final String PATH_STATUS = "/status";
    public static final String PATH_FULL_STATE = "/full-state";
    public static final String PATH_CHAT = "/chat";
    public static final String PATH_SCREEN = "/screen";
    public static final String PATH_TARGET = "/target";
    public static final String PATH_CONTAINER = "/container";
    public static final String PATH_PLAYERS = "/players";
    public static final String PATH_ACTION_STATUS = "/action/status";
    public static final String PATH_ACTION_RUN = "/action/run";
    public static final String PATH_ACTION_CANCEL = "/action/cancel";
    public static final String PATH_LOOK = "/look";
    public static final String PATH_KEY = "/key";
    public static final String PATH_INPUT = "/input";
    public static final String PATH_TAP = "/tap";
    public static final String PATH_HOTBAR = "/hotbar";
    public static final String PATH_RELEASE_ALL = "/release-all";
    public static final String PATH_COMMAND = "/command";
    public static final String PATH_SCREENSHOT = "/screenshot";
    public static final String PATH_SEQUENCE = "/sequence";
    public static final String PATH_WS = "/ws";

    public static final String GUI_CLOSE = "/gui/close";
    public static final String GUI_CLICK = "/gui/click";
    public static final String GUI_RELEASE = "/gui/release";
    public static final String GUI_SCROLL = "/gui/scroll";
    public static final String GUI_KEY = "/gui/key";
    public static final String GUI_TYPE = "/gui/type";
    public static final String GUI_CLICK_WIDGET = "/gui/click-widget";

    public static final String DEBUG_FAKE_PLAYER = "/debug/fake-player";
    public static final String DEBUG_FAKE_PLAYER_SPAWN = "/debug/fake-player/spawn";
    public static final String DEBUG_FAKE_PLAYER_MOVE = "/debug/fake-player/move";
    public static final String DEBUG_FAKE_PLAYER_REMOVE = "/debug/fake-player/remove";
    public static final String DEBUG_FAKE_PLAYER_CLEAR = "/debug/fake-player/clear";

    public static final String WS_ACTION_PING = "ping";
    public static final String WS_ACTION_STATUS = "status";
    public static final String WS_ACTION_FULL_STATE = "full-state";
    public static final String WS_ACTION_CHAT = "chat";
    public static final String WS_ACTION_CHAT_READ = "chat.read";
    public static final String WS_ACTION_CHAT_SEND = "chat.send";
    public static final String WS_ACTION_SUBSCRIBE = "subscribe";
    public static final String WS_ACTION_UNSUBSCRIBE = "unsubscribe";
    public static final String WS_ACTION_SUBSCRIPTIONS = "subscriptions";
    public static final String WS_ACTION_SCREEN = "screen";
    public static final String WS_ACTION_TARGET = "target";
    public static final String WS_ACTION_CONTAINER = "container";
    public static final String WS_ACTION_PLAYERS = "players";
    public static final String WS_ACTION_ACTION_STATUS = "action.status";
    public static final String WS_ACTION_ACTION_RUN = "action.run";
    public static final String WS_ACTION_ACTION_CANCEL = "action.cancel";
    public static final String WS_ACTION_COMMAND = "command";
    public static final String WS_ACTION_LOOK = "look";
    public static final String WS_ACTION_KEY = "key";
    public static final String WS_ACTION_INPUT = "input";
    public static final String WS_ACTION_TAP = "tap";
    public static final String WS_ACTION_HOTBAR = "hotbar";
    public static final String WS_ACTION_RELEASE_ALL = "release-all";
    public static final String WS_ACTION_GUI_CLOSE = "gui.close";
    public static final String WS_ACTION_GUI_CLICK = "gui.click";
    public static final String WS_ACTION_GUI_RELEASE = "gui.release";
    public static final String WS_ACTION_GUI_SCROLL = "gui.scroll";
    public static final String WS_ACTION_GUI_KEY = "gui.key";
    public static final String WS_ACTION_GUI_TYPE = "gui.type";
    public static final String WS_ACTION_GUI_CLICK_WIDGET = "gui.click-widget";
    public static final String WS_ACTION_SCREENSHOT = "screenshot";
    public static final String WS_ACTION_SEQUENCE = "sequence";
    public static final String WS_ACTION_DEBUG_FAKE_PLAYER = "debug.fake-player";
    public static final String WS_ACTION_DEBUG_FAKE_PLAYER_LIST = "debug.fake-player.list";
    public static final String WS_ACTION_DEBUG_FAKE_PLAYER_SPAWN = "debug.fake-player.spawn";
    public static final String WS_ACTION_DEBUG_FAKE_PLAYER_MOVE = "debug.fake-player.move";
    public static final String WS_ACTION_DEBUG_FAKE_PLAYER_REMOVE = "debug.fake-player.remove";
    public static final String WS_ACTION_DEBUG_FAKE_PLAYER_CLEAR = "debug.fake-player.clear";
}
