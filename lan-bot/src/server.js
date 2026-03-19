"use strict";
const fs = require("fs");
const http = require("http");
const path = require("path");
const { URL } = require("url");

const mineflayer = require("mineflayer");
const mc = require("minecraft-protocol");
const { pathfinder, Movements, goals } = require("mineflayer-pathfinder");
const prismarineItem = require("prismarine-item");
const vec3Module = require("vec3");

const ChatHistory = require("./chat-history");
const ActionManager = require("./action-manager");
const AgentRuntime = require("./agent-runtime");
const { createModClient, resolveModClientOptions } = require("./mod-client");
const RealtimeHub = require("./realtime-hub");
const WorldMemory = require("./world-memory");
const { loadConfig, saveConfig } = require("./config");

const Vec3 = typeof vec3Module === "function" ? vec3Module : vec3Module.Vec3;
const AIR_BLOCKS = new Set(["air", "cave_air", "void_air"]);

function createEmptyModCache() {
  return {
    status: null,
    players: null,
    inventory: null,
    fullState: null,
    chat: null,
    screen: null,
    target: null,
    container: null,
    fakePlayers: null
  };
}

const loaded = loadConfig(process.cwd());
const rootDir = loaded.rootDir;
const configPath = loaded.configPath;
const config = loaded.config;
const memoryPath = path.join(path.dirname(configPath), "codex-lan-memory.json");
const agentPath = path.join(path.dirname(configPath), "codex-lan-agent.json");

const chatHistory = new ChatHistory();
const actionManager = new ActionManager();
const worldMemory = new WorldMemory(memoryPath);
const agentRuntime = new AgentRuntime(agentPath, config.agent || {});
let realtimeHub = null;

const state = {
  driver: "none",
  bot: null,
  modClient: null,
  modCache: createEmptyModCache(),
  botOptions: null,
  connected: false,
  connecting: false,
  spawned: false,
  telemetryInterval: null,
  lastError: "",
  lastDisconnect: ""
};

actionManager.setCancelHook(() => {
  if (isModClientDriver() && state.modClient) {
    state.modClient.releaseAll().catch(() => {
      // ignore
    });
  }
  if (state.bot && state.bot.pathfinder) {
    try {
      state.bot.pathfinder.stop();
    } catch (error) {
      // ignore
    }
  }
});

actionManager.subscribe((snapshot) => {
  worldMemory.setLastAction(snapshot);
  if (realtimeHub) {
    realtimeHub.broadcast("action", snapshot);
  }
});

worldMemory.subscribe((event) => {
  if (realtimeHub) {
    realtimeHub.broadcast("memory", event);
  }
});

agentRuntime.subscribe((event) => {
  if (realtimeHub) {
    realtimeHub.broadcast("agent", event);
  }
});

const DIRECT_COMMAND_SPECS = {
  read_status: {
    description: "Read bot status, position, health and mode.",
    args: {}
  },
  read_full_state: {
    description: "Read status, players, inventory, chat, action and memory.",
    args: {}
  },
  read_inventory: {
    description: "Read current inventory items and held item.",
    args: {}
  },
  read_players: {
    description: "Read the current player list.",
    args: {}
  },
  read_block: {
    description: "Read a single block at coordinates.",
    args: {
      x: "number",
      y: "number",
      z: "number"
    }
  },
  read_target: {
    description: "Read current crosshair block/entity target.",
    args: {
      maxDistance: "number, default 6"
    }
  },
  read_screen: {
    description: "Read the current GUI screen snapshot and visible widgets.",
    args: {}
  },
  read_container: {
    description: "Open and inspect a container, or read the currently open GUI container.",
    args: {
      x: "number, optional",
      y: "number, optional",
      z: "number, optional",
      range: "number, default 4",
      face: "string, default up"
    }
  },
  read_furnace: {
    description: "Open and inspect a furnace.",
    args: {
      x: "number",
      y: "number",
      z: "number",
      range: "number, default 4"
    }
  },
  read_memory: {
    description: "Read persistent world memory and session memory.",
    args: {}
  },
  chat: {
    description: "Send chat text.",
    args: {
      message: "string"
    }
  },
  hotbar: {
    description: "Select hotbar slot 1-9.",
    args: {
      slot: "number"
    }
  },
  equip: {
    description: "Equip an item by name, or select slot.",
    args: {
      item: "string",
      slot: "number, optional"
    }
  },
  move_to: {
    description: "Walk to coordinates with pathfinder.",
    args: {
      x: "number",
      y: "number",
      z: "number",
      range: "number, default 1"
    }
  },
  look_at: {
    description: "Rotate camera toward coordinates.",
    args: {
      x: "number",
      y: "number",
      z: "number",
      force: "boolean, default true"
    }
  },
  use_item: {
    description: "Use held item, or interact with target block.",
    args: {
      x: "number, optional",
      y: "number, optional",
      z: "number, optional",
      face: "string, optional",
      hand: "string, default main",
      hitX: "number, optional",
      hitY: "number, optional",
      hitZ: "number, optional",
      insideBlock: "boolean, optional",
      range: "number, default 4"
    }
  },
  interact_block: {
    description: "Use held item on a specific block through the native client interaction chain.",
    args: {
      x: "number",
      y: "number",
      z: "number",
      face: "string, default up",
      hand: "string, default main",
      hitX: "number, optional",
      hitY: "number, optional",
      hitZ: "number, optional",
      insideBlock: "boolean, optional"
    }
  },
  set_input: {
    description: "Set native input state on the mod-client backend.",
    args: {
      keys: "object, optional",
      clearMovement: "boolean, default false",
      yaw: "number, optional",
      pitch: "number, optional",
      deltaYaw: "number, optional",
      deltaPitch: "number, optional",
      hotbar: "number, optional"
    }
  },
  tap_key: {
    description: "Tap a movement or action key on the mod-client backend.",
    args: {
      key: "string",
      durationMs: "number, default 120"
    }
  },
  release_all: {
    description: "Release all currently held native movement keys.",
    args: {}
  },
  gui_click: {
    description: "Click the current GUI at screen coordinates.",
    args: {
      x: "number",
      y: "number",
      button: "number, default 0",
      doubleClick: "boolean, default false"
    }
  },
  gui_release: {
    description: "Release a pressed GUI mouse button.",
    args: {
      x: "number",
      y: "number",
      button: "number, default 0"
    }
  },
  gui_scroll: {
    description: "Scroll within the current GUI.",
    args: {
      x: "number",
      y: "number",
      deltaX: "number, default 0",
      deltaY: "number, default 0"
    }
  },
  gui_key: {
    description: "Send a GUI key press.",
    args: {
      key: "number",
      scancode: "number, default 0",
      modifiers: "number, default 0"
    }
  },
  gui_type: {
    description: "Type text into the current GUI.",
    args: {
      text: "string"
    }
  },
  gui_click_widget: {
    description: "Click a widget by visible index on the current GUI screen.",
    args: {
      index: "number",
      button: "number, default 0"
    }
  },
  gui_close: {
    description: "Close the current GUI screen.",
    args: {}
  },
  screenshot: {
    description: "Save a client screenshot and return the saved path.",
    args: {
      name: "string, optional"
    }
  },
  debug_fake_player_list: {
    description: "List debug fake players managed by the mod-client backend.",
    args: {}
  },
  debug_fake_player_spawn: {
    description: "Spawn a local debug fake player on the mod-client backend.",
    args: {
      name: "string",
      x: "number, optional",
      y: "number, optional",
      z: "number, optional",
      yaw: "number, optional",
      pitch: "number, optional",
      invisible: "boolean, optional",
      noGravity: "boolean, optional",
      nameVisible: "boolean, optional"
    }
  },
  debug_fake_player_move: {
    description: "Move an existing local debug fake player on the mod-client backend.",
    args: {
      name: "string",
      x: "number, optional",
      y: "number, optional",
      z: "number, optional",
      yaw: "number, optional",
      pitch: "number, optional",
      invisible: "boolean, optional",
      noGravity: "boolean, optional",
      nameVisible: "boolean, optional"
    }
  },
  debug_fake_player_remove: {
    description: "Remove a local debug fake player from the mod-client backend.",
    args: {
      name: "string"
    }
  },
  place: {
    description: "Hand place one block.",
    args: {
      item: "string",
      x: "number",
      y: "number",
      z: "number",
      range: "number, default 4",
      replace: "boolean, default false"
    }
  },
  place_water: {
    description: "Place water by bucket onto a block face.",
    args: {
      x: "number",
      y: "number",
      z: "number",
      item: "string, default water_bucket",
      range: "number, default 4"
    }
  },
  dig: {
    description: "Dig a block by hand.",
    args: {
      x: "number",
      y: "number",
      z: "number",
      range: "number, default 4"
    }
  },
  clear_block: {
    description: "Dig only when target is occupied.",
    args: {
      x: "number",
      y: "number",
      z: "number",
      range: "number, default 4"
    }
  },
  container_deposit: {
    description: "Store items into container.",
    args: {
      x: "number",
      y: "number",
      z: "number",
      item: "string",
      count: "number"
    }
  },
  container_withdraw: {
    description: "Take items from container.",
    args: {
      x: "number",
      y: "number",
      z: "number",
      item: "string",
      count: "number"
    }
  },
  smelt_item: {
    description: "Put input and fuel into furnace and take cooked output.",
    args: {
      x: "number",
      y: "number",
      z: "number",
      inputItem: "string",
      inputCount: "number, default 1",
      fuelItem: "string, default coal",
      fuelCount: "number, default 1",
      outputItem: "string, optional"
    }
  },
  consume: {
    description: "Eat held or named food item.",
    args: {
      item: "string, optional"
    }
  },
  fish_until: {
    description: "Fish until a cookable fish is caught or attempts run out.",
    args: {
      x: "number, optional",
      y: "number, optional",
      z: "number, optional",
      lookX: "number, optional",
      lookY: "number, optional",
      lookZ: "number, optional",
      fishAttempts: "number, default 8"
    }
  },
  wait: {
    description: "Pause execution.",
    args: {
      milliseconds: "number",
      seconds: "number, optional"
    }
  },
  memory_note: {
    description: "Store a text note in persistent memory.",
    args: {
      text: "string",
      tag: "string, optional"
    }
  },
  memory_waypoint: {
    description: "Store a named coordinate.",
    args: {
      name: "string",
      x: "number",
      y: "number",
      z: "number",
      note: "string, optional"
    }
  },
  memory_context: {
    description: "Update the agent task context with arbitrary fields.",
    args: {
      patch: "object or key/value"
    }
  }
};

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function nowIso() {
  return new Date().toISOString();
}

function logMessage(text, tag) {
  chatHistory.add(text, tag);
  worldMemory.addObservation("log", {
    tag,
    text
  });
  if (realtimeHub) {
    realtimeHub.broadcast(tag === "Chat" ? "chat" : "log", {
      tag,
      text,
      time: nowIso()
    });
  }
  const line = "[" + nowIso() + "] [" + tag + "] " + text;
  if (tag === "Error") {
    console.error(line);
    return;
  }
  console.log(line);
}

function optionalStringValue(body, key, fallback) {
  if (!body || !(key in body) || typeof body[key] === "undefined" || body[key] === null) {
    return fallback;
  }
  if (typeof body[key] !== "string") {
    throw new Error("invalid string field: " + key);
  }
  return body[key];
}

function roundNumber(value, digits) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return 0;
  }
  return Number(parsed.toFixed(digits));
}

function normalizeDriverName(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw || raw === "auto") {
    return "auto";
  }
  if (raw === "mod" || raw === "modclient" || raw === "mod_client" || raw === "client_mod") {
    return "mod_client";
  }
  if (raw === "mineflayer" || raw === "lan" || raw === "lan_bot" || raw === "lan-bot") {
    return "mineflayer";
  }
  throw new Error("unsupported driver: " + value);
}

function isMineflayerDriver() {
  return state.driver === "mineflayer";
}

function isModClientDriver() {
  return state.driver === "mod_client";
}

function isMineflayerReady() {
  return Boolean(isMineflayerDriver() && state.bot && state.connected && state.spawned);
}

function isModClientConnected() {
  return Boolean(isModClientDriver() && state.modClient && state.connected);
}

function resetModCache() {
  state.modCache = createEmptyModCache();
}

function extractModClientOverrides(body) {
  const overrides = body && body.modClient && typeof body.modClient === "object" && !Array.isArray(body.modClient)
    ? { ...body.modClient }
    : {};

  for (const key of ["host", "port", "token", "configPath", "bootstrapLogPath"]) {
    if (body && key in body) {
      overrides[key] = body[key];
    }
  }

  return overrides;
}

function modClientBotPayload(options) {
  const safeOptions = options && typeof options === "object" ? options : {};
  return {
    username: safeOptions.username || "ModClient",
    host: safeOptions.host || (config.modClient && config.modClient.host) || "127.0.0.1",
    port: Number.isFinite(Number(safeOptions.port)) ? Number(safeOptions.port) : ((config.modClient && Number(config.modClient.port)) || 0),
    auth: "local",
    version: "native",
    driver: "mod_client",
    configPath: safeOptions.configPath || (config.modClient && config.modClient.configPath) || "",
    bootstrapLogPath: safeOptions.bootstrapLogPath || (config.modClient && config.modClient.bootstrapLogPath) || ""
  };
}

function defaultEmptyItemPayload() {
  return {
    empty: true,
    name: "",
    count: 0,
    slot: -1,
    displayName: ""
  };
}

function normalizeModStatusPayload(remote) {
  const payload = {
    ok: true,
    mode: "lan-bot",
    driver: "mod_client",
    connected: isModClientConnected(),
    connecting: state.connecting,
    bot: modClientBotPayload(state.botOptions),
    action: actionManager.snapshot(),
    memory: worldMemory.summary(),
    agent: {
      currentSessionId: agentRuntime.snapshot().currentSessionId || "",
      llmConfigured: agentRuntime.llmConfigured(),
      sessions: agentRuntime.listSessions().slice(0, 5)
    }
  };

  if (state.lastError) {
    payload.lastError = state.lastError;
  }
  if (state.lastDisconnect) {
    payload.lastDisconnect = state.lastDisconnect;
  }

  const status = remote && typeof remote === "object" ? remote : {};
  payload.inWorld = Boolean(status.inWorld);
  if (status.screen) {
    payload.screen = clone(status.screen);
  }
  if (payload.inWorld) {
    payload.x = roundNumber(status.x, 2);
    payload.y = roundNumber(status.y, 2);
    payload.z = roundNumber(status.z, 2);
    payload.yaw = roundNumber(status.yaw, 4);
    payload.pitch = roundNumber(status.pitch, 4);
    payload.health = roundNumber(status.health, 2);
    payload.maxHealth = roundNumber(status.maxHealth, 2);
    payload.food = Number.isFinite(Number(status.food)) ? Number(status.food) : 0;
    payload.saturation = roundNumber(status.saturation, 2);
  }
  payload.selectedHotbarSlot = Number.isFinite(Number(status.selectedHotbarSlot))
    ? Number(status.selectedHotbarSlot)
    : 0;
  payload.heldItem = state.modCache.inventory && state.modCache.inventory.heldItem
    ? clone(state.modCache.inventory.heldItem)
    : defaultEmptyItemPayload();
  return payload;
}

function normalizeModPlayersPayload(remote) {
  const rawPlayers = remote && Array.isArray(remote.players) ? remote.players : [];
  const players = rawPlayers.map((player) => ({
    name: player && player.name ? String(player.name) : "",
    uuid: player && player.uuid ? String(player.uuid) : "",
    displayName: player && player.displayName ? String(player.displayName) : "",
    latency: player && Number.isFinite(Number(player.latency)) ? Number(player.latency) : 0,
    ping: player && Number.isFinite(Number(player.latency)) ? Number(player.latency) : 0,
    gameMode: player && player.gameMode ? String(player.gameMode) : "",
    gamemode: player && player.gameMode ? String(player.gameMode) : ""
  })).filter((player) => player.name);

  return {
    ok: true,
    connected: isModClientConnected(),
    inWorld: Boolean(remote && remote.inWorld),
    count: players.length,
    players
  };
}

function normalizeModInventoryPayload(remote) {
  const inventory = remote && typeof remote === "object" ? remote : {};
  return {
    ok: true,
    connected: isModClientConnected(),
    inWorld: Boolean(inventory.inWorld),
    selectedHotbarSlot: Number.isFinite(Number(inventory.selectedHotbarSlot))
      ? Number(inventory.selectedHotbarSlot)
      : 0,
    items: Array.isArray(inventory.items) ? clone(inventory.items) : [],
    heldItem: inventory.heldItem ? clone(inventory.heldItem) : defaultEmptyItemPayload(),
    slotCount: Number.isFinite(Number(inventory.slotCount)) ? Number(inventory.slotCount) : 0
  };
}

function normalizeModTargetPayload(remote, maxDistance) {
  if (!remote || typeof remote !== "object") {
    return {
      ok: true,
      connected: isModClientConnected(),
      target: null
    };
  }

  let block = null;
  if (remote.block && remote.block.position) {
    const position = remote.block.position;
    block = {
      x: Number(position.x),
      y: Number(position.y),
      z: Number(position.z),
      position: clone(position),
      direction: remote.block.direction || ""
    };
  }

  let entity = null;
  if (remote.entity) {
    entity = {
      id: Number.isFinite(Number(remote.entity.id)) ? Number(remote.entity.id) : 0,
      uuid: remote.entity.uuid ? String(remote.entity.uuid) : "",
      name: remote.entity.name ? String(remote.entity.name) : "",
      className: remote.entity.className ? String(remote.entity.className) : "",
      x: roundNumber(remote.entity.x, 2),
      y: roundNumber(remote.entity.y, 2),
      z: roundNumber(remote.entity.z, 2),
      yaw: roundNumber(remote.entity.yaw, 4),
      pitch: roundNumber(remote.entity.pitch, 4)
    };
  }

  return {
    ok: true,
    connected: isModClientConnected(),
    target: {
      maxDistance: Number.isFinite(Number(maxDistance)) ? Number(maxDistance) : 6,
      type: remote.type ? String(remote.type) : "",
      hit: Boolean(remote.hit),
      screen: remote.screen ? clone(remote.screen) : null,
      location: remote.location ? clone(remote.location) : null,
      block,
      entity
    }
  };
}

function normalizeModScreenPayload(remote) {
  if (!remote || typeof remote !== "object") {
    return {
      ok: true,
      connected: isModClientConnected(),
      open: false,
      widgets: []
    };
  }

  const payload = clone(remote);
  payload.connected = isModClientConnected();
  return payload;
}

function normalizeModContainerPayload(remote) {
  if (!remote || typeof remote !== "object") {
    return {
      ok: true,
      connected: isModClientConnected(),
      containerOpen: false,
      slotCount: 0,
      slots: [],
      carried: defaultEmptyItemPayload()
    };
  }

  const payload = clone(remote);
  payload.connected = isModClientConnected();
  return payload;
}

function normalizeModFakePlayersPayload(remote) {
  const payload = remote && typeof remote === "object" ? clone(remote) : {
    ok: true,
    players: [],
    count: 0
  };
  payload.connected = isModClientConnected();
  return payload;
}

function syncModCacheFromFullState(fullState) {
  if (!fullState || typeof fullState !== "object") {
    return;
  }

  state.modCache.fullState = clone(fullState);
  if (fullState.status) {
    state.modCache.status = clone(fullState.status);
  }
  if (fullState.players) {
    state.modCache.players = clone(fullState.players);
  }
  if (fullState.inventory) {
    state.modCache.inventory = clone(fullState.inventory);
  }
  if (fullState.chat) {
    state.modCache.chat = clone(fullState.chat);
  }
  if (fullState.screen) {
    state.modCache.screen = clone(fullState.screen);
  }
  if (fullState.target) {
    state.modCache.target = clone(fullState.target);
  }
  if (fullState.container) {
    state.modCache.container = clone(fullState.container);
  }
}

function rememberModContainerObservation(containerPayload, position, source) {
  if (!position || !containerPayload || !containerPayload.containerOpen || !Array.isArray(containerPayload.slots)) {
    return;
  }

  const slots = containerPayload.slots
    .filter((entry) => entry && entry.item && !entry.item.empty)
    .map((entry) => ({
      slot: Number.isFinite(Number(entry.index)) ? Number(entry.index) : -1,
      name: entry.item.name || "",
      count: Number.isFinite(Number(entry.item.count)) ? Number(entry.item.count) : 0,
      displayName: entry.item.displayName || entry.item.name || ""
    }))
    .filter((entry) => entry.slot >= 0);

  worldMemory.rememberContainer({
    x: position.x,
    y: position.y,
    z: position.z,
    name: "container",
    title: containerPayload.className || "",
    slots,
    source
  });
}

function requireModClient() {
  if (!state.modClient || !isModClientDriver()) {
    throw new Error("mod-client backend is not connected");
  }
  return state.modClient;
}

async function readStatusPayload() {
  if (!isModClientDriver()) {
    return getStatusPayload();
  }

  const remote = await requireModClient().status();
  state.modCache.status = clone(remote);
  state.connected = true;
  state.spawned = true;
  state.lastError = "";
  return getStatusPayload();
}

async function readPlayersPayload() {
  if (!isModClientDriver()) {
    return getPlayersPayload();
  }

  const remote = await requireModClient().players();
  state.modCache.players = clone(remote);
  state.connected = true;
  state.spawned = true;
  state.lastError = "";
  return getPlayersPayload();
}

async function readInventoryPayload() {
  if (!isModClientDriver()) {
    return getInventoryPayload();
  }

  const remote = await requireModClient().inventory();
  state.modCache.inventory = clone(remote);
  state.connected = true;
  state.spawned = true;
  state.lastError = "";
  return getInventoryPayload();
}

async function readTargetPayload(maxDistance) {
  if (!isModClientDriver()) {
    return getTargetPayload(maxDistance);
  }

  const remote = await requireModClient().target({
    maxDistance: Number.isFinite(Number(maxDistance)) ? Number(maxDistance) : 6
  });
  state.modCache.target = clone(remote);
  state.connected = true;
  state.spawned = true;
  state.lastError = "";
  return normalizeModTargetPayload(remote, maxDistance);
}

async function readScreenPayload() {
  if (!isModClientDriver()) {
    throw new Error("read_screen requires mod_client backend");
  }

  const remote = await requireModClient().screen();
  state.modCache.screen = clone(remote);
  state.connected = true;
  state.spawned = true;
  state.lastError = "";
  return normalizeModScreenPayload(remote);
}

async function readContainerPayload() {
  if (!isModClientDriver()) {
    throw new Error("container GUI read requires mod_client backend");
  }

  const remote = await requireModClient().container();
  state.modCache.container = clone(remote);
  state.connected = true;
  state.spawned = true;
  state.lastError = "";
  return normalizeModContainerPayload(remote);
}

async function readFakePlayersPayload() {
  if (!isModClientDriver()) {
    throw new Error("debug fake players require mod_client backend");
  }

  const remote = await requireModClient().listFakePlayers();
  state.modCache.fakePlayers = clone(remote);
  state.connected = true;
  state.spawned = true;
  state.lastError = "";
  return normalizeModFakePlayersPayload(remote);
}

async function readFullStatePayload() {
  if (!isModClientDriver()) {
    return getFullStatePayload();
  }

  const remote = await requireModClient().fullState();
  syncModCacheFromFullState(remote);
  state.connected = true;
  state.spawned = true;
  state.lastError = "";

  return {
    ok: true,
    status: getStatusPayload(),
    players: getPlayersPayload(),
    inventory: getInventoryPayload(),
    chat: state.modCache.chat ? clone(state.modCache.chat) : { ok: true, messages: [], typed: [] },
    screen: normalizeModScreenPayload(state.modCache.screen),
    target: normalizeModTargetPayload(state.modCache.target, 6),
    container: normalizeModContainerPayload(state.modCache.container),
    action: actionManager.snapshot(),
    memory: worldMemory.snapshot(),
    agent: agentRuntime.snapshot()
  };
}

async function readChatPayload(since, limit) {
  if (!isModClientDriver()) {
    return chatHistory.get(since, limit);
  }

  const remote = await requireModClient().readChat({
    since,
    limit
  });
  state.modCache.chat = clone(remote);
  state.connected = true;
  state.spawned = true;
  state.lastError = "";
  return clone(remote);
}

async function readBlockPayload(x, y, z) {
  if (!isModClientDriver()) {
    return getBlockPayload(x, y, z);
  }
  throw new Error("read_block is not supported in mod_client backend yet");
}

function calculateLookAngles(origin, target) {
  const eyeX = Number(origin.x || 0);
  const eyeY = Number(origin.y || 0) + 1.62;
  const eyeZ = Number(origin.z || 0);
  const dx = Number(target.x) - eyeX;
  const dy = Number(target.y) - eyeY;
  const dz = Number(target.z) - eyeZ;
  const horizontalDistance = Math.sqrt((dx * dx) + (dz * dz));

  return {
    yaw: Math.atan2(-dx, dz) * (180 / Math.PI),
    pitch: Math.atan2(-dy, horizontalDistance) * (180 / Math.PI)
  };
}

function blockPayloadFromBlock(block) {
  if (!block) {
    return null;
  }

  let properties = {};
  if (typeof block.getProperties === "function") {
    properties = block.getProperties() || {};
  }

  return {
    x: block.position.x,
    y: block.position.y,
    z: block.position.z,
    name: block.name,
    displayName: block.displayName || block.name,
    stateId: block.stateId,
    type: block.type,
    isAir: isAir(block),
    properties
  };
}

function updateMemorySnapshot() {
  const status = getStatusPayload();
  const players = getPlayersPayload();
  worldMemory.setBotStatus(status);
  worldMemory.setPlayers(players);
  if (realtimeHub) {
    realtimeHub.broadcast("status", status);
    realtimeHub.broadcast("players", players);
  }
}

async function refreshModTelemetry() {
  if (!isModClientDriver() || !state.modClient) {
    return;
  }

  try {
    const [status, players] = await Promise.all([
      state.modClient.status(),
      state.modClient.players()
    ]);
    state.modCache.status = clone(status);
    state.modCache.players = clone(players);
    state.connected = true;
    state.spawned = true;
    state.lastError = "";
    updateMemorySnapshot();
  } catch (error) {
    state.connected = false;
    state.lastError = error && error.message ? error.message : String(error);
  }
}

function stopTelemetryLoop() {
  if (state.telemetryInterval) {
    clearInterval(state.telemetryInterval);
    state.telemetryInterval = null;
  }
}

function startTelemetryLoop() {
  stopTelemetryLoop();
  if (isModClientDriver()) {
    void refreshModTelemetry();
    state.telemetryInterval = setInterval(() => {
      void refreshModTelemetry();
    }, 500);
    return;
  }
  updateMemorySnapshot();
  state.telemetryInterval = setInterval(() => {
    try {
      updateMemorySnapshot();
    } catch (error) {
      // ignore periodic telemetry errors
    }
  }, 1500);
}

function requireBot() {
  if (!isMineflayerDriver()) {
    throw new Error("command requires mineflayer backend; current backend is " + (state.driver || "none"));
  }
  if (!state.bot || !state.connected || !state.spawned) {
    throw new Error("mineflayer bot is not connected");
  }
  return state.bot;
}

function parseJsonBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (error) {
        reject(new Error("invalid json body"));
      }
    });
    request.on("error", reject);
  });
}

function sendJson(response, statusCode, payload) {
  const json = JSON.stringify(payload);
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(json),
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, X-Auth-Token",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS"
  });
  response.end(json);
}

function ensureToken(request) {
  const token = request.headers["x-auth-token"];
  if (!token || token !== config.token) {
    throw new Error("unauthorized");
  }
}

function ensureProvidedToken(token) {
  if (!token || token !== config.token) {
    throw new Error("unauthorized");
  }
}

function numberValue(body, key, fallback) {
  if (!(key in body)) {
    return fallback;
  }
  const value = Number(body[key]);
  if (!Number.isFinite(value)) {
    throw new Error("invalid numeric field: " + key);
  }
  return value;
}

function stringValue(body, key, fallback) {
  if (!(key in body)) {
    return fallback;
  }
  const value = body[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("invalid string field: " + key);
  }
  return value;
}

function boolValue(body, key, fallback) {
  if (!(key in body)) {
    return fallback;
  }
  return Boolean(body[key]);
}

function isAir(block) {
  return !block || AIR_BLOCKS.has(block.name);
}

function blockKey(x, y, z) {
  return String(x) + "," + String(y) + "," + String(z);
}

function guessLanPortFromLatestLog() {
  const latestLogPath = path.join(rootDir, "logs", "latest.log");
  if (!fs.existsSync(latestLogPath)) {
    return null;
  }

  const text = fs.readFileSync(latestLogPath, "utf8");
  const patterns = [
    /Started serving on (\d+)/g,
    /Local game hosted on port (\d+)/g,
    /started an integrated server at [^:]+:(\d+)/gi
  ];

  let detected = null;
  for (const pattern of patterns) {
    let match = pattern.exec(text);
    while (match) {
      detected = Number(match[1]);
      match = pattern.exec(text);
    }
  }
  return Number.isFinite(detected) ? detected : null;
}

async function verifyMinecraftPort(host, port) {
  return new Promise((resolve) => {
    let finished = false;
    mc.ping({ host, port }, (error) => {
      if (!finished) {
        finished = true;
        resolve(!error);
      }
    });
    setTimeout(() => {
      if (!finished) {
        finished = true;
        resolve(false);
      }
    }, 1500);
  });
}

async function resolveMineflayerConnectOptions(body) {
  const merged = {
    ...config.bot,
    ...(body || {})
  };

  if (!merged.host) {
    merged.host = "127.0.0.1";
  }
  if (!merged.username) {
    merged.username = "CodexLanBot";
  }
  if (!merged.auth) {
    merged.auth = "offline";
  }
  if (!merged.version) {
    merged.version = "auto";
  }

  if (!Number.isFinite(Number(merged.port)) || Number(merged.port) <= 0) {
    const guessedPort = guessLanPortFromLatestLog();
    if (!guessedPort) {
      throw new Error("could not detect LAN port from latest.log, please provide port explicitly");
    }
    merged.port = guessedPort;
  } else {
    merged.port = Number(merged.port);
  }

  merged.connectTimeoutMs = Number.isFinite(Number(merged.connectTimeoutMs)) ? Number(merged.connectTimeoutMs) : 20000;

  const reachable = await verifyMinecraftPort(merged.host, merged.port);
  if (!reachable) {
    throw new Error("minecraft server not reachable at " + merged.host + ":" + merged.port);
  }

  return merged;
}

async function resolveRequestedDriver(body) {
  const configuredDriver = normalizeDriverName((config.bot && config.bot.driver) || "auto");
  const requestedDriver = normalizeDriverName(optionalStringValue(body, "driver", configuredDriver));
  if (requestedDriver !== "auto") {
    return requestedDriver;
  }

  try {
    resolveModClientOptions(rootDir, config.modClient, extractModClientOverrides(body));
    return "mod_client";
  } catch (error) {
    return "mineflayer";
  }
}

function resetRuntimeConnection(closeModClientTransport) {
  const currentModClient = state.modClient;
  stopTelemetryLoop();
  state.driver = "none";
  state.bot = null;
  state.modClient = null;
  resetModCache();
  state.botOptions = null;
  state.connected = false;
  state.connecting = false;
  state.spawned = false;

  if (closeModClientTransport && currentModClient && typeof currentModClient.close === "function") {
    currentModClient.close();
  }
}

function cleanupBot(bot) {
  if (state.bot !== bot) {
    return;
  }
  resetRuntimeConnection(false);
  worldMemory.setBotStatus(getStatusPayload());
}

function cleanupModClient(closeTransport) {
  if (!state.modClient && !isModClientDriver()) {
    return;
  }
  resetRuntimeConnection(closeTransport !== false);
  worldMemory.setBotStatus(getStatusPayload());
}

function attachBotListeners(bot, options) {
  bot.loadPlugin(pathfinder);

  bot.once("login", () => {
    state.connected = true;
    state.botOptions = options;
    logMessage("logged in as " + bot.username, "System");
    updateMemorySnapshot();
  });

  bot.once("spawn", () => {
    state.spawned = true;
    logMessage("spawned in world", "System");
    startTelemetryLoop();
  });

  bot.on("messagestr", (message) => {
    if (typeof message === "string" && message.length > 0) {
      chatHistory.add(message, "Chat");
      worldMemory.addObservation("chat", {
        text: message
      });
    }
  });

  bot.on("whisper", (username, message) => {
    chatHistory.add("[whisper] <" + username + "> " + message, "Chat");
    worldMemory.addObservation("whisper", {
      username,
      message
    });
  });

  bot.on("playerJoined", () => {
    worldMemory.setPlayers(getPlayersPayload());
  });

  bot.on("playerLeft", () => {
    worldMemory.setPlayers(getPlayersPayload());
  });

  bot.on("blockUpdate", (oldBlock, newBlock) => {
    if (newBlock) {
      worldMemory.rememberBlock(blockPayloadFromBlock(newBlock), "block_update");
      return;
    }
    if (oldBlock) {
      worldMemory.rememberBlock(blockPayloadFromBlock(oldBlock), "block_update");
    }
  });

  bot.on("error", (error) => {
    state.lastError = error && error.message ? error.message : String(error);
    logMessage(state.lastError, "Error");
    updateMemorySnapshot();
  });

  bot.on("kicked", (reason) => {
    const text = typeof reason === "string" ? reason : JSON.stringify(reason);
    state.lastDisconnect = text;
    logMessage("kicked: " + text, "Error");
    worldMemory.addObservation("disconnect", {
      reason: text,
      type: "kicked"
    });
  });

  bot.on("end", (reason) => {
    state.lastDisconnect = reason || "connection ended";
    logMessage("disconnected: " + state.lastDisconnect, "System");
    worldMemory.addObservation("disconnect", {
      reason: state.lastDisconnect,
      type: "end"
    });
    cleanupBot(bot);
  });
}

function buildCreateOptions(options, username) {
  const createOptions = {
    host: options.host,
    port: options.port,
    username: username || options.username,
    auth: options.auth
  };

  if (options.version && options.version !== "auto") {
    createOptions.version = options.version;
  }

  return createOptions;
}

async function waitForBotSpawn(bot, timeoutMs) {
  await new Promise((resolve, reject) => {
    let timeoutId = null;

    const cleanup = () => {
      bot.removeListener("spawn", onSpawn);
      bot.removeListener("error", onError);
      bot.removeListener("end", onEnd);
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    };

    const onSpawn = () => {
      cleanup();
      resolve();
    };

    const onError = (error) => {
      cleanup();
      reject(error);
    };

    const onEnd = () => {
      cleanup();
      reject(new Error("connection closed before spawn"));
    };

    timeoutId = setTimeout(() => {
      cleanup();
      reject(new Error("connect timeout after " + timeoutMs + "ms"));
    }, timeoutMs);

    bot.once("spawn", onSpawn);
    bot.once("error", onError);
    bot.once("end", onEnd);
  });
}

function attachAuxiliaryBotListeners(bot, label) {
  bot.loadPlugin(pathfinder);

  bot.on("error", (error) => {
    const text = error && error.message ? error.message : String(error);
    logMessage(label + " error: " + text, "Error");
  });

  bot.on("kicked", (reason) => {
    const text = typeof reason === "string" ? reason : JSON.stringify(reason);
    logMessage(label + " kicked: " + text, "Error");
  });

  bot.on("end", (reason) => {
    logMessage(label + " disconnected: " + (reason || "connection ended"), "System");
  });
}

async function connectAuxiliaryBot(options, username) {
  const bot = mineflayer.createBot(buildCreateOptions(options, username));
  attachAuxiliaryBotListeners(bot, username);
  await waitForBotSpawn(bot, options.connectTimeoutMs || 20000);
  logMessage("aux bot spawned: " + username, "System");
  return bot;
}

async function disconnectAuxiliaryBots(bots) {
  for (const bot of bots || []) {
    if (!bot) {
      continue;
    }

    try {
      bot.quit();
    } catch (error) {
      try {
        bot.end();
      } catch (endError) {
        // ignore
      }
    }
  }
}

async function connectModClient(body) {
  const client = createModClient(rootDir, config.modClient, extractModClientOverrides(body));
  let status;
  try {
    status = await client.status();
  } catch (error) {
    client.close();
    throw error;
  }

  resetRuntimeConnection(true);
  state.driver = "mod_client";
  state.modClient = client;
  state.modCache.status = clone(status);
  state.botOptions = {
    ...client.options,
    driver: "mod_client",
    username: "ModClient"
  };
  state.connected = true;
  state.spawned = true;

  config.bot = {
    ...config.bot,
    driver: "mod_client"
  };
  config.modClient = {
    ...config.modClient,
    ...client.options
  };
  saveConfig(configPath, config);

  worldMemory.addNote("mod-client connected", "system", {
    host: client.options.host,
    port: client.options.port,
    configPath: client.options.configPath
  });
  startTelemetryLoop();
  updateMemorySnapshot();
  return getStatusPayload();
}

async function connectBot(body) {
  if (state.connecting) {
    throw new Error("connection already in progress");
  }
  if ((state.bot || state.modClient) && state.connected) {
    return isModClientDriver() ? readStatusPayload() : getStatusPayload();
  }

  state.connecting = true;
  state.lastError = "";
  state.lastDisconnect = "";

  try {
    const driver = await resolveRequestedDriver(body);
    if (driver === "mod_client") {
      return await connectModClient(body);
    }

    const options = await resolveMineflayerConnectOptions(body);
    const createOptions = buildCreateOptions(options);
    const bot = mineflayer.createBot(createOptions);

    resetRuntimeConnection(true);
    state.driver = "mineflayer";
    state.bot = bot;
    attachBotListeners(bot, options);

    await waitForBotSpawn(bot, options.connectTimeoutMs);

    config.bot = {
      ...config.bot,
      ...options,
      driver: "mineflayer"
    };
    saveConfig(configPath, config);
    worldMemory.addNote("bot connected", "system", {
      host: options.host,
      port: options.port,
      username: options.username
    });
    updateMemorySnapshot();
    return getStatusPayload();
  } catch (error) {
    if (isModClientDriver()) {
      cleanupModClient(true);
    } else if (state.bot) {
      cleanupBot(state.bot);
    }
    throw error;
  } finally {
    state.connecting = false;
  }
}

function disconnectBot() {
  if (!state.bot && !state.modClient) {
    return {
      ok: true,
      disconnected: true
    };
  }
  actionManager.cancel();

  if (isModClientDriver()) {
    const details = modClientBotPayload(state.botOptions);
    cleanupModClient(true);
    worldMemory.addNote("mod-client disconnect requested", "system", {
      host: details.host,
      port: details.port
    });
    return {
      ok: true,
      disconnected: true
    };
  }

  const bot = state.bot;
  bot.quit("codex disconnect");
  worldMemory.addNote("bot disconnect requested", "system", {
    username: bot ? bot.username : ""
  });
  return {
    ok: true,
    disconnecting: true
  };
}

function itemPayload(item) {
  if (!item) {
    return {
      empty: true,
      name: "",
      count: 0,
      slot: -1,
      displayName: ""
    };
  }

  return {
    empty: false,
    name: item.name,
    count: item.count,
    slot: item.slot,
    displayName: item.displayName || item.name
  };
}

function getInventoryPayload() {
  if (isModClientDriver()) {
    return normalizeModInventoryPayload(state.modCache.inventory);
  }

  if (!isMineflayerReady()) {
    return {
      ok: true,
      connected: false,
      selectedHotbarSlot: 0,
      items: [],
      heldItem: defaultEmptyItemPayload()
    };
  }

  const bot = state.bot;
  return {
    ok: true,
    connected: true,
    selectedHotbarSlot: typeof bot.quickBarSlot === "number" ? bot.quickBarSlot + 1 : 0,
    items: bot.inventory.items().map((item) => ({
      name: item.name,
      count: item.count,
      slot: item.slot,
      displayName: item.displayName || item.name
    })),
    heldItem: itemPayload(bot.heldItem)
  };
}

function getPlayersPayload() {
  if (isModClientDriver()) {
    return normalizeModPlayersPayload(state.modCache.players);
  }

  if (!isMineflayerReady()) {
    return {
      ok: true,
      connected: false,
      players: [],
      count: 0
    };
  }

  const players = Object.entries(state.bot.players).map(([name, player]) => ({
    name,
    ping: player.ping ?? 0,
    gamemode: player.gamemode ?? null,
    hasEntity: Boolean(player.entity),
    position: player.entity ? {
      x: Number(player.entity.position.x.toFixed(2)),
      y: Number(player.entity.position.y.toFixed(2)),
      z: Number(player.entity.position.z.toFixed(2))
    } : null
  }));

  return {
    ok: true,
    connected: true,
    count: players.length,
    players
  };
}

function getBlockPayload(x, y, z) {
  if (!isMineflayerReady()) {
    return {
      ok: true,
      connected: false,
      block: null
    };
  }

  const block = state.bot.blockAt(new Vec3(x, y, z));
  if (!block) {
    return {
      ok: true,
      connected: true,
      block: null
    };
  }

  return {
    ok: true,
    connected: true,
    block: blockPayloadFromBlock(block)
  };
}

function getTargetPayload(maxDistance) {
  if (isModClientDriver()) {
    return normalizeModTargetPayload(state.modCache.target, maxDistance);
  }

  if (!isMineflayerReady()) {
    return {
      ok: true,
      connected: false,
      target: null
    };
  }

  const bot = state.bot;
  const reach = Number.isFinite(maxDistance) ? maxDistance : 6;
  const block = typeof bot.blockAtCursor === "function" ? bot.blockAtCursor(reach) : null;
  const entity = typeof bot.entityAtCursor === "function" ? bot.entityAtCursor(reach) : null;

  return {
    ok: true,
    connected: true,
    target: {
      maxDistance: reach,
      block: block ? blockPayloadFromBlock(block) : null,
      entity: entity ? {
        id: entity.id,
        name: entity.name || entity.username || entity.displayName || "",
        type: entity.type || "",
        kind: entity.kind || "",
        username: entity.username || "",
        position: entity.position ? {
          x: Number(entity.position.x.toFixed(2)),
          y: Number(entity.position.y.toFixed(2)),
          z: Number(entity.position.z.toFixed(2))
        } : null
      } : null
    }
  };
}

function windowSlotPayload(window, start, end) {
  const result = [];
  for (let slot = start; slot < end; slot += 1) {
    const item = window.slots[slot];
    if (!item) {
      continue;
    }
    result.push({
      slot,
      name: item.name,
      count: item.count,
      displayName: item.displayName || item.name
    });
  }
  return result;
}

function containerWindowPayload(window) {
  return {
    title: window.title || "",
    type: window.type || "",
    inventoryStart: typeof window.inventoryStart === "number" ? window.inventoryStart : 0,
    inventoryEnd: typeof window.inventoryEnd === "number" ? window.inventoryEnd : 0,
    slots: windowSlotPayload(window, 0, typeof window.inventoryStart === "number" ? window.inventoryStart : window.slots.length)
  };
}

function furnaceWindowPayload(furnace) {
  return {
    input: itemPayload(typeof furnace.inputItem === "function" ? furnace.inputItem() : null),
    fuel: itemPayload(typeof furnace.fuelItem === "function" ? furnace.fuelItem() : null),
    output: itemPayload(typeof furnace.outputItem === "function" ? furnace.outputItem() : null)
  };
}

function getCapabilitiesPayload() {
  return {
    ok: true,
    mode: "lan-bot",
    driver: state.driver === "none" ? normalizeDriverName((config.bot && config.bot.driver) || "auto") : state.driver,
    directControl: {
      start: "node src/server.js",
      singleCommandEndpoint: "/control/run",
      workflowEndpoint: "/workflow/run",
      memoryEndpoint: "/memory",
      websocketEndpoint: "/ws?token=<token>",
      agentEndpoints: [
        "/agent/start",
        "/agent/status",
        "/agent/message",
        "/agent/plan",
        "/agent/run",
        "/agent/prompt",
        "/agent/autoplan"
      ],
      variableSyntax: "$last.field or $named.step.field",
      websocketMessageTypes: [
        "subscribe",
        "command",
        "workflow",
        "agent",
        "ping"
      ]
    },
    commands: clone(DIRECT_COMMAND_SPECS),
    agent: {
      currentSessionId: agentRuntime.snapshot().currentSessionId || "",
      llmConfigured: agentRuntime.llmConfigured()
    }
  };
}

function getStatusPayload() {
  if (isModClientDriver()) {
    return normalizeModStatusPayload(state.modCache.status);
  }

  const payload = {
    ok: true,
    mode: "lan-bot",
    driver: state.driver === "none" ? normalizeDriverName((config.bot && config.bot.driver) || "auto") : state.driver,
    connected: Boolean(state.bot && state.connected && state.spawned),
    connecting: state.connecting,
    bot: {
      username: state.botOptions ? state.botOptions.username : config.bot.username,
      host: state.botOptions ? state.botOptions.host : config.bot.host,
      port: state.botOptions ? state.botOptions.port : config.bot.port,
      auth: state.botOptions ? state.botOptions.auth : config.bot.auth,
      version: state.botOptions ? state.botOptions.version : config.bot.version
    },
    action: actionManager.snapshot(),
    memory: worldMemory.summary(),
    agent: {
      currentSessionId: agentRuntime.snapshot().currentSessionId || "",
      llmConfigured: agentRuntime.llmConfigured(),
      sessions: agentRuntime.listSessions().slice(0, 5)
    }
  };

  if (state.lastError) {
    payload.lastError = state.lastError;
  }
  if (state.lastDisconnect) {
    payload.lastDisconnect = state.lastDisconnect;
  }

  if (!state.bot || !state.connected || !state.spawned) {
    return payload;
  }

  const bot = state.bot;
  payload.inWorld = true;
  payload.x = Number(bot.entity.position.x.toFixed(2));
  payload.y = Number(bot.entity.position.y.toFixed(2));
  payload.z = Number(bot.entity.position.z.toFixed(2));
  payload.yaw = Number(bot.entity.yaw.toFixed(4));
  payload.pitch = Number(bot.entity.pitch.toFixed(4));
  payload.health = Number(Number.isFinite(bot.health) ? bot.health.toFixed(2) : "0");
  payload.food = Number.isFinite(bot.food) ? bot.food : 0;
  payload.dimension = bot.game.dimension;
  payload.gamemode = bot.game.gameMode;
  payload.selectedHotbarSlot = typeof bot.quickBarSlot === "number" ? bot.quickBarSlot + 1 : 0;
  payload.heldItem = itemPayload(bot.heldItem);
  return payload;
}

async function sendChat(body) {
  const message = stringValue(body, "message");
  chatHistory.addTyped(message);
  if (isModClientDriver()) {
    const payload = await requireModClient().sendChat(message);
    state.lastError = "";
    return {
      ok: true,
      sent: true,
      payload
    };
  }

  const bot = requireBot();
  bot.chat(message);
  return {
    ok: true,
    sent: true
  };
}

async function setHotbar(body) {
  const slot = numberValue(body, "slot");
  const zeroBasedSlot = Math.floor(slot) - 1;
  if (zeroBasedSlot < 0 || zeroBasedSlot > 8) {
    throw new Error("slot must be between 1 and 9");
  }

  if (isModClientDriver()) {
    const payload = await requireModClient().hotbar(zeroBasedSlot + 1);
    if (state.modCache.status && typeof state.modCache.status === "object") {
      state.modCache.status.selectedHotbarSlot = zeroBasedSlot + 1;
    }
    if (state.modCache.inventory && typeof state.modCache.inventory === "object") {
      state.modCache.inventory.selectedHotbarSlot = zeroBasedSlot + 1;
    }
    state.lastError = "";
    return {
      ok: true,
      slot: zeroBasedSlot + 1,
      payload
    };
  }

  const bot = requireBot();
  if (typeof bot.setQuickBarSlot === "function") {
    bot.setQuickBarSlot(zeroBasedSlot);
  } else {
    bot.quickBarSlot = zeroBasedSlot;
  }
  return {
    ok: true,
    slot: zeroBasedSlot + 1
  };
}

async function equipItemByName(bot, itemName) {
  const normalized = itemName.toLowerCase();
  const item = bot.inventory.items().find((entry) => {
    const displayName = entry.displayName ? entry.displayName.toLowerCase() : "";
    return entry.name.toLowerCase() === normalized || displayName === normalized;
  });

  if (!item) {
    throw new Error("item not found: " + itemName);
  }

  await bot.equip(item, "hand");
  return item;
}

async function equipItem(body) {
  const bot = requireBot();
  if ("slot" in body) {
    return setHotbar(body);
  }
  const item = await equipItemByName(bot, stringValue(body, "item"));
  return {
    ok: true,
    item: itemPayload(item)
  };
}

function createPathMovements(bot, options) {
  const movements = new Movements(bot);
  movements.allowSprinting = true;

  const conservative = !options || options.conservative !== false;
  if (conservative) {
    movements.canDig = false;
    movements.allow1by1towers = false;
    movements.allowParkour = false;
    movements.maxDropDown = 2;
    movements.scafoldingBlocks = [];
  }

  return movements;
}

async function ensureNear(bot, x, y, z, range, options) {
  const distance = bot.entity.position.distanceTo(new Vec3(x, y, z));
  if (distance <= range) {
    return;
  }

  const movements = createPathMovements(bot, options);
  bot.pathfinder.setMovements(movements);

  if (options && options.lookAtBlock) {
    await bot.pathfinder.goto(new goals.GoalLookAtBlock(new Vec3(x, y, z), bot.world, {
      reach: options.reach || Math.max(4.5, range)
    }));
    return;
  }

  if (options && options.horizontalOnly) {
    await bot.pathfinder.goto(new goals.GoalNearXZ(x, z, range));
    return;
  }

  await bot.pathfinder.goto(new goals.GoalNear(x, y, z, range));
}

function registryItemName(itemName) {
  return String(itemName || "").toLowerCase().replace(/^minecraft:/, "");
}

function deriveRelatedItemName(itemName, variant) {
  const raw = String(itemName || "").trim();
  if (!raw) {
    return variant;
  }

  const separatorIndex = raw.indexOf(":");
  const namespace = separatorIndex >= 0 ? raw.slice(0, separatorIndex) : "";
  const baseName = separatorIndex >= 0 ? raw.slice(separatorIndex + 1) : raw;
  const normalizedBase = baseName.toLowerCase();

  if (normalizedBase.endsWith("_" + variant)) {
    return raw;
  }

  let stem = normalizedBase;
  if (stem.endsWith("_planks")) {
    stem = stem.slice(0, -"_planks".length);
  }

  const derivedName = stem + "_" + variant;
  return namespace ? namespace + ":" + derivedName : derivedName;
}

function isItemVariant(itemName, variant) {
  return registryItemName(itemName).endsWith("_" + variant);
}

function getItemStackSize(bot, itemName) {
  const normalized = registryItemName(itemName);
  const registryItem = bot.registry &&
    bot.registry.itemsByName &&
    bot.registry.itemsByName[normalized];
  if (registryItem && typeof registryItem.stackSize === "number" && registryItem.stackSize > 0) {
    return registryItem.stackSize;
  }

  const inventoryItem = bot.inventory.items().find((entry) => entry.name === normalized);
  if (inventoryItem && typeof inventoryItem.stackSize === "number" && inventoryItem.stackSize > 0) {
    return inventoryItem.stackSize;
  }

  return 64;
}

function isCreativeMode(bot) {
  return Boolean(bot && bot.game && bot.game.gameMode === "creative");
}

function buildCreativeInventorySlots() {
  const slots = [];
  for (let slot = 36; slot <= 44; slot += 1) {
    slots.push(slot);
  }
  for (let slot = 9; slot <= 35; slot += 1) {
    slots.push(slot);
  }
  return slots;
}

function createCreativeInventoryItem(bot, itemName, count) {
  const normalized = registryItemName(itemName);
  const registryItem = bot.registry &&
    bot.registry.itemsByName &&
    bot.registry.itemsByName[normalized];
  if (!registryItem) {
    throw new Error("unknown item: " + itemName);
  }

  const Item = prismarineItem(bot.registry);
  const stackSize = typeof registryItem.stackSize === "number" && registryItem.stackSize > 0
    ? registryItem.stackSize
    : 64;
  const itemCount = Math.max(1, Math.min(Math.floor(count || stackSize), stackSize));
  return new Item(registryItem.id, itemCount);
}

async function setCreativeInventoryItem(bot, itemName, count, preferredSlot) {
  if (!bot.creative || !isCreativeMode(bot)) {
    throw new Error("creative inventory control requires creative mode");
  }

  const normalized = registryItemName(itemName);
  const slots = buildCreativeInventorySlots();
  let slot = Number.isFinite(preferredSlot) ? preferredSlot : null;
  if (slot === null) {
    slot = slots.find((entry) => {
      const item = bot.inventory.slots[entry];
      return item && item.name === normalized;
    });
  }
  if (slot === undefined || slot === null) {
    slot = slots.find((entry) => !bot.inventory.slots[entry]);
  }
  if (slot === undefined || slot === null) {
    slot = slots[slots.length - 1];
  }

  await bot.creative.setInventorySlot(slot, createCreativeInventoryItem(bot, itemName, count));
  return slot;
}

async function clearCreativeBuildInventory(bot) {
  if (!bot.creative || !isCreativeMode(bot)) {
    throw new Error("creative inventory control requires creative mode");
  }

  for (const slot of buildCreativeInventorySlots()) {
    if (bot.inventory.slots[slot]) {
      await bot.creative.clearSlot(slot);
    }
  }
}

async function dropInventoryItemCount(bot, itemName, count) {
  let remaining = Math.max(0, Math.floor(count || 0));
  while (remaining > 0) {
    const item = bot.inventory.items().find((entry) => entry.name === registryItemName(itemName));
    if (!item) {
      break;
    }
    const amount = Math.min(remaining, item.count);
    await bot.toss(item.type, item.metadata ?? null, amount);
    remaining -= amount;
    await sleep(150);
  }
}

async function trimInventoryItem(bot, itemName, maximumCount) {
  const limit = Math.max(0, Math.floor(maximumCount || 0));
  let current = countInventoryItem(bot, itemName);
  if (current <= limit) {
    return current;
  }

  const removeCount = current - limit;
  await runBotCommand(bot, "/clear " + bot.username + " " + itemName + " " + String(removeCount));
  for (let attempt = 0; attempt < 8; attempt += 1) {
    await sleep(200);
    current = countInventoryItem(bot, itemName);
    if (current <= limit) {
      return current;
    }
  }

  await dropInventoryItemCount(bot, itemName, current - limit);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    await sleep(200);
    current = countInventoryItem(bot, itemName);
    if (current <= limit) {
      return current;
    }
  }

  throw new Error("failed to trim item: " + itemName);
}

async function ensureInventoryItem(bot, itemName, minimumCount, options) {
  const requiredCount = Math.max(1, Math.floor(minimumCount || 1));
  const stackSize = getItemStackSize(bot, itemName);
  let current = countInventoryItem(bot, itemName);
  const commandBot = options && options.commandBot ? options.commandBot : bot;
  const allowCommands = !options || options.allowCommands !== false;
  const inventoryMode = options && options.inventoryMode ? options.inventoryMode : "";

  if (current >= requiredCount) {
    return current;
  }

  if (inventoryMode === "creative_manual") {
    await setCreativeInventoryItem(bot, itemName, Math.min(requiredCount, stackSize));
    current = countInventoryItem(bot, itemName);
    if (current > 0) {
      return current;
    }
    throw new Error("failed to obtain creative item: " + itemName);
  }

  if (!allowCommands) {
    throw new Error("failed to obtain item without commands: " + itemName);
  }

  let stalledBatches = 0;
  while (current < requiredCount && stalledBatches < 3) {
    const missing = requiredCount - current;
    const giveCount = Math.max(1, Math.min(missing, stackSize));
    const previous = current;
    await runBotCommand(commandBot, "/give " + bot.username + " " + itemName + " " + String(giveCount));

    for (let attempt = 0; attempt < 12; attempt += 1) {
      await sleep(250);
      current = countInventoryItem(bot, itemName);
      if (current >= requiredCount || current >= previous + giveCount) {
        break;
      }
    }

    if (current > previous) {
      stalledBatches = 0;
    } else {
      stalledBatches += 1;
    }
  }

  if (current >= requiredCount) {
    return current;
  }

  throw new Error("failed to obtain item: " + itemName);
}

function getPlacementSupportCandidates(bot, x, y, z, preferredSupport) {
  const ordered = [];
  const deferred = [];
  const seen = new Set();

  function addCandidate(position, face) {
    if (!position || !face) {
      return;
    }

    if (position.x + face.x !== x ||
      position.y + face.y !== y ||
      position.z + face.z !== z) {
      return;
    }

    const key = blockKey(position.x, position.y, position.z) + "|" + blockKey(face.x, face.y, face.z);
    if (seen.has(key)) {
      return;
    }
    seen.add(key);

    const block = bot.blockAt(position);
    if (isAir(block)) {
      return;
    }

    const interactive = block.name.endsWith("_door") ||
      block.name === "chest" ||
      block.name === "trapped_chest" ||
      block.name.endsWith("_fence_gate");

    const entry = {
      block,
      face
    };
    if (interactive) {
      deferred.push(entry);
      return;
    }

    ordered.push(entry);
  }

  if (preferredSupport && preferredSupport.position && preferredSupport.face) {
    addCandidate(preferredSupport.position, preferredSupport.face);
  }

  const candidates = [
    { support: new Vec3(x, y - 1, z), face: new Vec3(0, 1, 0) },
    { support: new Vec3(x - 1, y, z), face: new Vec3(1, 0, 0) },
    { support: new Vec3(x + 1, y, z), face: new Vec3(-1, 0, 0) },
    { support: new Vec3(x, y, z - 1), face: new Vec3(0, 0, 1) },
    { support: new Vec3(x, y, z + 1), face: new Vec3(0, 0, -1) },
    { support: new Vec3(x, y + 1, z), face: new Vec3(0, -1, 0) }
  ];

  for (const candidate of candidates) {
    addCandidate(candidate.support, candidate.face);
  }

  return ordered.concat(deferred);
}

function getPlacementSupport(bot, x, y, z, preferredSupport) {
  const candidates = getPlacementSupportCandidates(bot, x, y, z, preferredSupport);
  return candidates.length > 0 ? candidates[0] : null;
}

function botIntersectsBlock(bot, x, y, z) {
  if (!bot || !bot.entity || !bot.entity.position) {
    return false;
  }

  const halfWidth = 0.3;
  const position = bot.entity.position;
  const minX = position.x - halfWidth;
  const maxX = position.x + halfWidth;
  const minY = position.y;
  const maxY = position.y + (bot.entity.height || 1.8);
  const minZ = position.z - halfWidth;
  const maxZ = position.z + halfWidth;

  return maxX > x &&
    minX < x + 1 &&
    maxY > y &&
    minY < y + 1 &&
    maxZ > z &&
    minZ < z + 1;
}

function botTouchesPlacement(bot, x, y, z) {
  if (!bot || !bot.entity || !bot.entity.position) {
    return false;
  }

  if (botIntersectsBlock(bot, x, y, z)) {
    return true;
  }

  const halfWidth = 0.3;
  const position = bot.entity.position;
  const minX = Math.floor(position.x - halfWidth);
  const maxX = Math.floor(position.x + halfWidth);
  const minZ = Math.floor(position.z - halfWidth);
  const maxZ = Math.floor(position.z + halfWidth);
  const standingY = Math.floor(position.y - 0.01);

  return y === standingY &&
    x >= minX &&
    x <= maxX &&
    z >= minZ &&
    z <= maxZ;
}

async function moveOutOfTargetBlock(bot, x, y, z, support) {
  const supportPosition = support && support.block ? support.block.position : null;
  if (!botTouchesPlacement(bot, x, y, z) &&
    !(supportPosition && botTouchesPlacement(bot, supportPosition.x, supportPosition.y, supportPosition.z))) {
    return;
  }

  const offsets = [
    { dx: 3, dz: 0 },
    { dx: -3, dz: 0 },
    { dx: 0, dz: 3 },
    { dx: 0, dz: -3 },
    { dx: 2, dz: 0 },
    { dx: -2, dz: 0 },
    { dx: 0, dz: 2 },
    { dx: 0, dz: -2 },
    { dx: 2, dz: 2 },
    { dx: -2, dz: 2 },
    { dx: 2, dz: -2 },
    { dx: -2, dz: -2 }
  ];

  for (const offset of offsets) {
    try {
      await ensureNear(bot, x + offset.dx, y, z + offset.dz, 1, {
        horizontalOnly: true
      });
    } catch (error) {
      continue;
    }

    if (!botTouchesPlacement(bot, x, y, z) &&
      !(supportPosition && botTouchesPlacement(bot, supportPosition.x, supportPosition.y, supportPosition.z))) {
      return;
    }
  }
}

async function waitForExpectedBlock(bot, position, itemName, attempts, delayMs) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const block = bot.blockAt(position);
    if (block && block.name === itemName) {
      return block;
    }
    await sleep(delayMs);
  }

  return bot.blockAt(position);
}

async function sendPlacePacket(bot, support, placeOptions) {
  const effectiveOptions = {
    forceLook: true,
    swingArm: "right",
    ...(placeOptions || {})
  };

  if (typeof bot._genericPlace === "function") {
    await bot._genericPlace(support.block, support.face, effectiveOptions);
    return;
  }

  if (typeof bot._placeBlockWithOptions === "function") {
    await bot._placeBlockWithOptions(support.block, support.face, effectiveOptions);
    return;
  }

  await bot.placeBlock(support.block, support.face);
}

async function restoreReplacedBlock(bot, itemName, position, options) {
  if (!itemName) {
    return false;
  }

  const commandBot = options && options.commandBot ? options.commandBot : bot;
  const allowCommands = !options || options.allowCommands !== false;
  const inventoryMode = options && options.inventoryMode ? options.inventoryMode : "";
  const range = options && Number.isFinite(options.range) ? options.range : 4;
  const placeDelayMs = options && Number.isFinite(options.placeDelayMs) ? options.placeDelayMs : 100;

  if (allowCommands) {
    try {
      await runBotCommand(
        commandBot,
        "/setblock " + String(position.x) + " " + String(position.y) + " " + String(position.z) + " " + itemName
      );
      const restoredByCommand = await waitForExpectedBlock(bot, position, itemName, 10, placeDelayMs);
      if (restoredByCommand && restoredByCommand.name === itemName) {
        return true;
      }
    } catch (error) {
    }
  }

  try {
    await ensureInventoryItem(bot, itemName, 1, {
      commandBot,
      allowCommands,
      inventoryMode
    });
    const support = getPlacementSupport(bot, position.x, position.y, position.z, null);
    if (!support) {
      return false;
    }

    await ensureNear(bot, support.block.position.x, support.block.position.y, support.block.position.z, range, {
      lookAtBlock: true,
      reach: Math.max(5, range)
    });
    await moveOutOfTargetBlock(bot, position.x, position.y, position.z, support);
    await equipItemByName(bot, itemName);
    await sendPlacePacket(bot, support, {});
    const restored = await waitForExpectedBlock(bot, position, itemName, 12, placeDelayMs);
    return Boolean(restored && restored.name === itemName);
  } catch (error) {
    return false;
  }
}

async function placeBlockByHand(bot, placement, options) {
  const x = placement.x;
  const y = placement.y;
  const z = placement.z;
  const item = placement.item;
  const range = options.range;
  const placeDelayMs = options.placeDelayMs;
  const replace = options.replace;
  const commandBot = options.commandBot || bot;
  const allowCommands = options.allowCommands !== false;
  const inventoryMode = options.inventoryMode || "";
  const preferredSupport = placement.preferredSupport || options.preferredSupport || null;
  const skipInventoryCheck = Boolean(options.skipInventoryCheck);
  const inventoryOptions = {
    commandBot,
    allowCommands,
    inventoryMode
  };
  const placeOptions = {
    ...(placement.placeOptions || {}),
    ...(options.placeOptions || {})
  };

  if (!skipInventoryCheck) {
    await ensureInventoryItem(bot, item, 1, inventoryOptions);
  }

  const targetPos = new Vec3(x, y, z);
  const existing = bot.blockAt(targetPos);
  const replacedBlockName = existing && !isAir(existing) ? existing.name : "";
  if (existing && existing.name === item) {
    return {
      x,
      y,
      z,
      item,
      placed: false,
      skipped: true,
      finalBlock: existing.name
    };
  }

  const supports = getPlacementSupportCandidates(bot, x, y, z, preferredSupport);
  if (supports.length === 0) {
    throw new Error("no support block near " + blockKey(x, y, z));
  }

  let clearedOriginal = false;
  try {
    if (!isAir(existing)) {
      if (!replace) {
        throw new Error("target occupied at " + blockKey(x, y, z) + " by " + existing.name);
      }
      await ensureNear(bot, x, y, z, range, {
        horizontalOnly: true
      });
      await bot.dig(existing, true);
      await sleep(150);
      const cleared = bot.blockAt(targetPos);
      if (!isAir(cleared)) {
        throw new Error("failed to clear target at " + blockKey(x, y, z));
      }
      clearedOriginal = true;
    }

    await ensureNear(bot, x, y, z, range, {
      horizontalOnly: true
    });

    let lastError = null;
    for (const support of supports) {
      await ensureNear(bot, support.block.position.x, support.block.position.y, support.block.position.z, range, {
        lookAtBlock: true,
        reach: Math.max(5, range)
      });
      await moveOutOfTargetBlock(bot, x, y, z, support);
      await equipItemByName(bot, item);

      try {
        await sendPlacePacket(bot, support, placeOptions);
      } catch (error) {
        lastError = error;
      }

      const placedAfterAttempt = await waitForExpectedBlock(bot, targetPos, item, 12, placeDelayMs);
      if (placedAfterAttempt && placedAfterAttempt.name === item) {
        return {
          x,
          y,
          z,
          item,
          placed: true,
          skipped: false,
          finalBlock: placedAfterAttempt.name
        };
      }
    }

    const placed = bot.blockAt(targetPos);
    if (lastError) {
      throw lastError;
    }

    throw new Error("place verification failed at " + blockKey(x, y, z) + ", got " + (placed ? placed.name : "air"));
  } catch (error) {
    if (clearedOriginal && replacedBlockName) {
      const restored = await restoreReplacedBlock(bot, replacedBlockName, targetPos, {
        commandBot,
        allowCommands,
        inventoryMode,
        range,
        placeDelayMs
      });
      if (!restored) {
        logMessage("failed to restore replaced block " + replacedBlockName + " at " + blockKey(x, y, z), "Error");
      }
    }
    throw error;
  }
}

async function clearBlockIfNeeded(bot, x, y, z, range, delayMs) {
  const position = new Vec3(x, y, z);
  const initialBlock = bot.blockAt(position);
  if (isAir(initialBlock)) {
    return {
      cleared: false,
      finalBlock: "air"
    };
  }

  await ensureNear(bot, x, y, z, range, {
    horizontalOnly: true
  });
  await bot.dig(initialBlock, true);

  let finalBlock = bot.blockAt(position);
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await sleep(delayMs);
    finalBlock = bot.blockAt(position);
    if (isAir(finalBlock)) {
      return {
        cleared: true,
        finalBlock: "air"
      };
    }
  }

  throw new Error("failed to clear block at " + blockKey(x, y, z) + ", got " + (finalBlock ? finalBlock.name : "unknown"));
}

function parseBlockPlacements(body) {
  if (!Array.isArray(body.placements) || body.placements.length === 0) {
    throw new Error("placements must be a non-empty array");
  }

  return body.placements.map((entry) => {
    const x = Number(entry.x);
    const y = Number(entry.y);
    const z = Number(entry.z);
    const item = String(entry.item || "");
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z) || !item) {
      throw new Error("invalid placement entry");
    }
    return {
      x,
      y,
      z,
      item
    };
  });
}

function sortPlacements(placements) {
  return placements.slice().sort((left, right) => {
    if (left.y !== right.y) {
      return left.y - right.y;
    }
    if (left.z !== right.z) {
      return left.z - right.z;
    }
    return left.x - right.x;
  });
}

function addWalkableStairRun(config) {
  const {
    setPlacementData,
    clearPlacement,
    startX,
    startY,
    startZ,
    dirX,
    dirZ,
    width,
    rise,
    supportItem,
    blockItem,
    slabItem,
    stage
  } = config;

  const perpX = -dirZ;
  const perpZ = dirX;
  const topY = startY + rise;
  const placedPositions = [];

  for (let stepIndex = 0; stepIndex < rise * 2; stepIndex += 1) {
    const blockY = startY + 1 + Math.floor(stepIndex / 2);
    const forwardOffset = stepIndex + 1;
    const stepStartX = startX + dirX * forwardOffset;
    const stepStartZ = startZ + dirZ * forwardOffset;
    const useSlab = stepIndex % 2 === 0;
    const item = useSlab ? slabItem : blockItem;

    for (let widthOffset = 0; widthOffset < width; widthOffset += 1) {
      const x = stepStartX + perpX * widthOffset;
      const z = stepStartZ + perpZ * widthOffset;

      for (let supportY = startY; supportY < blockY; supportY += 1) {
        setPlacementData({
          x,
          y: supportY,
          z,
          item: supportItem,
          stage
        });
      }

      const placement = {
        x,
        y: blockY,
        z,
        item,
        stage
      };
      if (useSlab) {
        placement.placeOptions = {
          half: "bottom"
        };
      }
      setPlacementData(placement);
      placedPositions.push({ x, y: blockY, z });

      clearPlacement(x, blockY + 1, z);
      clearPlacement(x, blockY + 2, z);
    }
  }

  return {
    topY,
    placedPositions
  };
}

async function ensurePlacementInventory(bot, placements, extraRequirements, options) {
  const requiredCounts = new Map();

  for (const placement of placements) {
    const itemName = String(placement.item || "");
    if (!itemName) {
      continue;
    }
    requiredCounts.set(itemName, (requiredCounts.get(itemName) || 0) + 1);
  }

  if (extraRequirements) {
    for (const [itemName, extraCount] of Object.entries(extraRequirements)) {
      const count = Math.max(0, Math.floor(extraCount || 0));
      if (count <= 0) {
        continue;
      }
      requiredCounts.set(itemName, (requiredCounts.get(itemName) || 0) + count);
    }
  }

  const entries = Array.from(requiredCounts.entries()).sort((left, right) => right[1] - left[1]);
  const inventoryMode = options && options.inventoryMode ? options.inventoryMode : "";
  if (inventoryMode === "creative_manual") {
    await clearCreativeBuildInventory(bot);
    const slots = buildCreativeInventorySlots();
    for (let index = 0; index < entries.length; index += 1) {
      const [itemName] = entries[index];
      await setCreativeInventoryItem(bot, itemName, getItemStackSize(bot, itemName), slots[index]);
    }
    return;
  }

  for (const [itemName, count] of entries) {
    await ensureInventoryItem(bot, itemName, count, options);
  }
}

function buildSmallHousePlacements(originX, originY, originZ, wallItem, roofItem, windowItem, lightItem) {
  const placements = [];
  const width = 5;
  const depth = 5;
  const wallHeight = 3;

  for (let dz = 0; dz < depth; dz += 1) {
    for (let dx = 0; dx < width; dx += 1) {
      placements.push({ x: originX + dx, y: originY, z: originZ + dz, item: wallItem });
    }
  }

  for (let dy = 1; dy <= wallHeight; dy += 1) {
    for (let dx = 0; dx < width; dx += 1) {
      placements.push({ x: originX + dx, y: originY + dy, z: originZ, item: wallItem });
      placements.push({ x: originX + dx, y: originY + dy, z: originZ + depth - 1, item: wallItem });
    }
    for (let dz = 1; dz < depth - 1; dz += 1) {
      placements.push({ x: originX, y: originY + dy, z: originZ + dz, item: wallItem });
      placements.push({ x: originX + width - 1, y: originY + dy, z: originZ + dz, item: wallItem });
    }
  }

  const holeKeys = new Set([
    blockKey(originX, originY + 1, originZ + 2),
    blockKey(originX, originY + 2, originZ + 2)
  ]);

  const windowPlacements = [
    { x: originX + 2, y: originY + 2, z: originZ, item: windowItem },
    { x: originX + 2, y: originY + 2, z: originZ + depth - 1, item: windowItem },
    { x: originX + width - 1, y: originY + 2, z: originZ + 2, item: windowItem }
  ];
  for (const windowPlacement of windowPlacements) {
    holeKeys.add(blockKey(windowPlacement.x, windowPlacement.y, windowPlacement.z));
  }

  const filteredWalls = placements.filter((placement) => !holeKeys.has(blockKey(placement.x, placement.y, placement.z)));
  const result = filteredWalls.concat(windowPlacements);

  for (let dz = 0; dz < depth; dz += 1) {
    for (let dx = 0; dx < width; dx += 1) {
      result.push({ x: originX + dx, y: originY + wallHeight + 1, z: originZ + dz, item: roofItem });
    }
  }

  result.push({ x: originX + 2, y: originY + 1, z: originZ + 2, item: lightItem });
  return sortPlacements(result);
}

function buildDecoratedTwoStoryHousePlacements(originX, originY, originZ, palette) {
  const width = 7;
  const depth = 7;
  const placements = new Map();
  const {
    foundationItem,
    floorItem,
    wallItem,
    pillarItem,
    roofItem,
    windowItem,
    fenceItem,
    lightItem,
    leafItem,
    doorItem,
    stairItem
  } = palette;

  function setPlacement(x, y, z, item) {
    placements.set(blockKey(x, y, z), { x, y, z, item });
  }

  function fillRect(x1, x2, y, z1, z2, item) {
    for (let z = z1; z <= z2; z += 1) {
      for (let x = x1; x <= x2; x += 1) {
        setPlacement(x, y, z, item);
      }
    }
  }

  function fillPerimeter(x1, x2, y1, y2, z1, z2, item, openings) {
    const holeKeys = openings || new Set();
    for (let y = y1; y <= y2; y += 1) {
      for (let x = x1; x <= x2; x += 1) {
        const frontKey = blockKey(x, y, z1);
        if (!holeKeys.has(frontKey)) {
          setPlacement(x, y, z1, item);
        }
        const backKey = blockKey(x, y, z2);
        if (!holeKeys.has(backKey)) {
          setPlacement(x, y, z2, item);
        }
      }
      for (let z = z1 + 1; z < z2; z += 1) {
        const leftKey = blockKey(x1, y, z);
        if (!holeKeys.has(leftKey)) {
          setPlacement(x1, y, z, item);
        }
        const rightKey = blockKey(x2, y, z);
        if (!holeKeys.has(rightKey)) {
          setPlacement(x2, y, z, item);
        }
      }
    }
  }

  const frontLeftX = originX;
  const frontLeftZ = originZ;
  const backRightX = originX + width - 1;
  const backRightZ = originZ + depth - 1;
  const secondFloorY = originY + 4;
  const roofY = originY + 8;
  const slabStaircase = isItemVariant(stairItem, "slab");
  const stairPlacements = [
    { x: originX + 1, y: originY + 1, z: originZ + 1 },
    { x: originX + 1, y: originY + 2, z: originZ + 2 },
    { x: originX + 1, y: originY + 3, z: originZ + 3 },
    { x: originX + 1, y: originY + 4, z: originZ + 4 }
  ].map((placement) => {
    const result = {
      ...placement,
      item: stairItem,
      preferredSupport: {
        position: new Vec3(originX, placement.y, placement.z),
        face: new Vec3(1, 0, 0)
      }
    };

    if (slabStaircase) {
      result.placeOptions = {
        delta: new Vec3(1, 0.75, 0.5)
      };
    }

    return result;
  });
  const stairwellHoles = new Set([
    blockKey(originX + 1, secondFloorY, originZ + 2),
    blockKey(originX + 1, secondFloorY, originZ + 3)
  ]);

  fillRect(frontLeftX, backRightX, originY, frontLeftZ, backRightZ, foundationItem);
  fillRect(originX + 2, originX + 4, originY, originZ - 1, originZ - 1, foundationItem);

  for (let z = frontLeftZ; z <= backRightZ; z += 1) {
    for (let x = frontLeftX; x <= backRightX; x += 1) {
      if (stairwellHoles.has(blockKey(x, secondFloorY, z))) {
        continue;
      }
      setPlacement(x, secondFloorY, z, floorItem);
    }
  }
  fillRect(originX + 1, originX + 5, secondFloorY, originZ - 1, originZ - 1, floorItem);

  for (const stairPlacement of stairPlacements) {
    placements.set(blockKey(stairPlacement.x, stairPlacement.y, stairPlacement.z), stairPlacement);
  }

  for (let y = originY + 1; y <= originY + 7; y += 1) {
    setPlacement(frontLeftX, y, frontLeftZ, pillarItem);
    setPlacement(backRightX, y, frontLeftZ, pillarItem);
    setPlacement(frontLeftX, y, backRightZ, pillarItem);
    setPlacement(backRightX, y, backRightZ, pillarItem);
  }

  for (let y = originY + 1; y <= originY + 3; y += 1) {
    setPlacement(originX + 1, y, originZ - 1, fenceItem);
    setPlacement(originX + 5, y, originZ - 1, fenceItem);
  }

  const firstFloorOpenings = new Set([
    blockKey(originX + 3, originY + 1, originZ),
    blockKey(originX + 3, originY + 2, originZ)
  ]);
  const firstFloorWindows = [
    { x: originX + 2, y: originY + 2, z: originZ },
    { x: originX + 4, y: originY + 2, z: originZ },
    { x: originX + 2, y: originY + 2, z: backRightZ },
    { x: originX + 4, y: originY + 2, z: backRightZ },
    { x: frontLeftX, y: originY + 2, z: originZ + 4 },
    { x: backRightX, y: originY + 2, z: originZ + 2 },
    { x: backRightX, y: originY + 2, z: originZ + 4 },
    { x: originX + 2, y: originY + 3, z: originZ },
    { x: originX + 3, y: originY + 3, z: originZ },
    { x: originX + 4, y: originY + 3, z: originZ }
  ];
  for (const opening of firstFloorWindows) {
    firstFloorOpenings.add(blockKey(opening.x, opening.y, opening.z));
  }

  fillPerimeter(frontLeftX, backRightX, originY + 1, originY + 3, frontLeftZ, backRightZ, wallItem, firstFloorOpenings);
  for (const windowPlacement of firstFloorWindows) {
    setPlacement(windowPlacement.x, windowPlacement.y, windowPlacement.z, windowItem);
  }
  setPlacement(originX + 3, originY + 1, originZ, doorItem);

  const secondFloorOpenings = new Set();
  const secondFloorWindows = [
    { x: originX + 2, y: originY + 6, z: originZ },
    { x: originX + 3, y: originY + 6, z: originZ },
    { x: originX + 4, y: originY + 6, z: originZ },
    { x: originX + 2, y: originY + 6, z: backRightZ },
    { x: originX + 3, y: originY + 6, z: backRightZ },
    { x: originX + 4, y: originY + 6, z: backRightZ },
    { x: frontLeftX, y: originY + 6, z: originZ + 2 },
    { x: frontLeftX, y: originY + 6, z: originZ + 4 },
    { x: backRightX, y: originY + 6, z: originZ + 2 },
    { x: backRightX, y: originY + 6, z: originZ + 4 }
  ];
  for (const opening of secondFloorWindows) {
    secondFloorOpenings.add(blockKey(opening.x, opening.y, opening.z));
  }

  fillPerimeter(frontLeftX, backRightX, originY + 5, originY + 7, frontLeftZ, backRightZ, wallItem, secondFloorOpenings);
  for (const windowPlacement of secondFloorWindows) {
    setPlacement(windowPlacement.x, windowPlacement.y, windowPlacement.z, windowItem);
  }

  fillRect(frontLeftX, backRightX, roofY, frontLeftZ, backRightZ, roofItem);
  fillRect(originX + 1, originX + 5, roofY, originZ - 1, originZ - 1, roofItem);

  for (let x = frontLeftX; x <= backRightX; x += 1) {
    setPlacement(x, roofY + 1, frontLeftZ, fenceItem);
    setPlacement(x, roofY + 1, backRightZ, fenceItem);
  }
  for (let z = frontLeftZ + 1; z < backRightZ; z += 1) {
    setPlacement(frontLeftX, roofY + 1, z, fenceItem);
    setPlacement(backRightX, roofY + 1, z, fenceItem);
  }

  const lanternPlacements = [
    { x: originX + 5, y: originY + 1, z: originZ + 1 },
    { x: originX + 3, y: originY + 1, z: originZ + 5 },
    { x: originX + 2, y: secondFloorY + 1, z: originZ + 1 },
    { x: originX + 4, y: secondFloorY + 1, z: originZ + 1 },
    { x: frontLeftX + 1, y: roofY + 1, z: frontLeftZ + 1 },
    { x: backRightX - 1, y: roofY + 1, z: frontLeftZ + 1 },
    { x: frontLeftX + 1, y: roofY + 1, z: backRightZ - 1 },
    { x: backRightX - 1, y: roofY + 1, z: backRightZ - 1 }
  ];
  for (const lanternPlacement of lanternPlacements) {
    setPlacement(lanternPlacement.x, lanternPlacement.y, lanternPlacement.z, lightItem);
  }

  const shrubPlacements = [
    { x: originX - 1, y: originY + 1, z: originZ + 1 },
    { x: originX - 1, y: originY + 1, z: originZ + 5 },
    { x: backRightX + 1, y: originY + 1, z: originZ + 1 },
    { x: backRightX + 1, y: originY + 1, z: originZ + 5 },
    { x: originX + 2, y: originY + 1, z: originZ - 2 },
    { x: originX + 4, y: originY + 1, z: originZ - 2 }
  ];
  for (const shrubPlacement of shrubPlacements) {
    setPlacement(shrubPlacement.x, shrubPlacement.y, shrubPlacement.z, leafItem);
  }

  return sortPlacements(Array.from(placements.values()));
}

function buildRusticBalconyHousePlacements(originX, originY, originZ, palette) {
  const width = 11;
  const depth = 8;
  const placements = new Map();
  const {
    foundationItem,
    baseAccentItem,
    floorItem,
    wallItem,
    beamItem,
    roofItem,
    roofAccentItem,
    windowItem,
    fenceItem,
    lightItem,
    doorItem,
    stairItem,
    leafItem
  } = palette;

  function setPlacement(x, y, z, item) {
    placements.set(blockKey(x, y, z), { x, y, z, item });
  }

  function setPlacementData(entry) {
    placements.set(blockKey(entry.x, entry.y, entry.z), entry);
  }

  function fillRect(x1, x2, y, z1, z2, item) {
    for (let z = z1; z <= z2; z += 1) {
      for (let x = x1; x <= x2; x += 1) {
        setPlacement(x, y, z, item);
      }
    }
  }

  function fillPerimeter(x1, x2, y1, y2, z1, z2, item, openings) {
    const holeKeys = openings || new Set();
    for (let y = y1; y <= y2; y += 1) {
      for (let x = x1; x <= x2; x += 1) {
        const frontKey = blockKey(x, y, z1);
        if (!holeKeys.has(frontKey)) {
          setPlacement(x, y, z1, item);
        }
        const backKey = blockKey(x, y, z2);
        if (!holeKeys.has(backKey)) {
          setPlacement(x, y, z2, item);
        }
      }

      for (let z = z1 + 1; z < z2; z += 1) {
        const leftKey = blockKey(x1, y, z);
        if (!holeKeys.has(leftKey)) {
          setPlacement(x1, y, z, item);
        }
        const rightKey = blockKey(x2, y, z);
        if (!holeKeys.has(rightKey)) {
          setPlacement(x2, y, z, item);
        }
      }
    }
  }

  function fillColumn(x, y1, y2, z, item) {
    for (let y = y1; y <= y2; y += 1) {
      setPlacement(x, y, z, item);
    }
  }

  const frontLeftX = originX;
  const frontLeftZ = originZ;
  const backRightX = originX + width - 1;
  const backRightZ = originZ + depth - 1;
  const balconyZ = originZ - 1;
  const frontPathZ = originZ - 2;
  const upperFloorY = originY + 4;
  const upperWallStartY = originY + 5;
  const upperWallTopY = originY + 7;
  const roofBaseY = originY + 8;
  const slabStaircase = isItemVariant(stairItem, "slab");

  const stairPlacements = [
    { x: originX + 2, y: originY + 1, z: originZ + 2 },
    { x: originX + 2, y: originY + 2, z: originZ + 3 },
    { x: originX + 2, y: originY + 3, z: originZ + 4 },
    { x: originX + 2, y: originY + 4, z: originZ + 5 }
  ].map((placement) => {
    const result = {
      ...placement,
      item: stairItem,
      preferredSupport: {
        position: new Vec3(originX + 1, placement.y, placement.z),
        face: new Vec3(1, 0, 0)
      }
    };

    if (slabStaircase) {
      result.placeOptions = {
        delta: new Vec3(1, 0.75, 0.5)
      };
    }

    return result;
  });

  const stairwellHoles = new Set([
    blockKey(originX + 2, upperFloorY, originZ + 3),
    blockKey(originX + 2, upperFloorY, originZ + 4)
  ]);

  fillRect(frontLeftX, backRightX, originY, frontLeftZ, backRightZ, foundationItem);
  fillRect(originX + 2, originX + 8, originY, balconyZ, balconyZ, foundationItem);
  fillRect(originX + 4, originX + 6, originY, frontPathZ, frontPathZ, foundationItem);
  setPlacement(originX + 1, originY, frontPathZ, foundationItem);
  setPlacement(originX + 9, originY, frontPathZ, foundationItem);

  const baseOpenings = new Set();
  for (let y = originY + 1; y <= originY + 2; y += 1) {
    for (let x = originX + 4; x <= originX + 6; x += 1) {
      baseOpenings.add(blockKey(x, y, originZ));
    }
    baseOpenings.add(blockKey(originX + 1, y, originZ));
    baseOpenings.add(blockKey(originX + 9, y, originZ));
  }

  fillPerimeter(frontLeftX, backRightX, originY + 1, originY + 3, frontLeftZ, backRightZ, foundationItem, baseOpenings);

  fillColumn(originX, originY + 1, originY + 3, originZ, baseAccentItem);
  fillColumn(originX + 3, originY + 1, originY + 3, originZ, baseAccentItem);
  fillColumn(originX + 7, originY + 1, originY + 3, originZ, baseAccentItem);
  fillColumn(originX + 10, originY + 1, originY + 3, originZ, baseAccentItem);
  fillColumn(originX, originY + 1, originY + 3, backRightZ, baseAccentItem);
  fillColumn(originX + 10, originY + 1, originY + 3, backRightZ, baseAccentItem);

  for (let x = originX + 4; x <= originX + 6; x += 1) {
    setPlacement(x, originY + 3, originZ, baseAccentItem);
  }

  setPlacement(originX + 1, originY + 1, originZ, doorItem);
  setPlacement(originX + 9, originY + 1, originZ, doorItem);

  fillRect(originX + 4, originX + 6, originY + 1, balconyZ, originZ + 2, floorItem);
  fillRect(originX + 2, originX + 8, originY + 3, balconyZ, balconyZ, beamItem);
  fillColumn(originX + 2, originY + 1, originY + 2, balconyZ, beamItem);
  fillColumn(originX + 5, originY + 1, originY + 2, balconyZ, beamItem);
  fillColumn(originX + 8, originY + 1, originY + 2, balconyZ, beamItem);
  fillColumn(originX + 2, originY + 1, originY + 3, originZ, beamItem);
  fillColumn(originX + 8, originY + 1, originY + 3, originZ, beamItem);
  fillColumn(originX + 4, originY + 1, originY + 2, frontPathZ, beamItem);
  fillColumn(originX + 6, originY + 1, originY + 2, frontPathZ, beamItem);
  setPlacement(originX + 4, originY + 3, frontPathZ, lightItem);
  setPlacement(originX + 6, originY + 3, frontPathZ, lightItem);
  setPlacement(originX + 1, originY + 1, frontPathZ, leafItem);
  setPlacement(originX + 9, originY + 1, frontPathZ, leafItem);

  for (let y = originY + 1; y <= upperFloorY; y += 1) {
    for (let z = originZ + 2; z <= originZ + 5; z += 1) {
      setPlacement(originX + 1, y, z, wallItem);
    }
  }

  for (let z = frontLeftZ; z <= backRightZ; z += 1) {
    for (let x = originX + 1; x <= originX + 9; x += 1) {
      if (stairwellHoles.has(blockKey(x, upperFloorY, z))) {
        continue;
      }
      setPlacement(x, upperFloorY, z, floorItem);
    }
  }
  fillRect(originX + 2, originX + 8, upperFloorY, balconyZ, balconyZ, floorItem);

  for (const stairPlacement of stairPlacements) {
    setPlacementData(stairPlacement);
  }

  const upperOpenings = new Set([
    blockKey(originX + 2, upperWallStartY + 1, originZ + 1),
    blockKey(originX + 8, upperWallStartY + 1, originZ + 1),
    blockKey(originX + 1, upperWallStartY + 1, originZ + 3),
    blockKey(originX + 1, upperWallStartY + 1, originZ + 5),
    blockKey(originX + 9, upperWallStartY + 1, originZ + 3),
    blockKey(originX + 9, upperWallStartY + 1, originZ + 5),
    blockKey(originX + 3, upperWallStartY + 1, backRightZ),
    blockKey(originX + 5, upperWallStartY + 1, backRightZ),
    blockKey(originX + 7, upperWallStartY + 1, backRightZ)
  ]);

  fillPerimeter(originX + 1, originX + 9, upperWallStartY, upperWallTopY, originZ + 1, backRightZ, wallItem, upperOpenings);

  fillColumn(originX + 1, upperWallStartY, upperWallTopY, originZ + 1, beamItem);
  fillColumn(originX + 9, upperWallStartY, upperWallTopY, originZ + 1, beamItem);
  fillColumn(originX + 1, upperWallStartY, upperWallTopY, backRightZ, beamItem);
  fillColumn(originX + 9, upperWallStartY, upperWallTopY, backRightZ, beamItem);

  setPlacement(originX + 2, upperWallStartY + 1, originZ + 1, windowItem);
  setPlacement(originX + 8, upperWallStartY + 1, originZ + 1, windowItem);
  setPlacement(originX + 1, upperWallStartY + 1, originZ + 3, windowItem);
  setPlacement(originX + 1, upperWallStartY + 1, originZ + 5, windowItem);
  setPlacement(originX + 9, upperWallStartY + 1, originZ + 3, windowItem);
  setPlacement(originX + 9, upperWallStartY + 1, originZ + 5, windowItem);
  setPlacement(originX + 3, upperWallStartY + 1, backRightZ, windowItem);
  setPlacement(originX + 5, upperWallStartY + 1, backRightZ, windowItem);
  setPlacement(originX + 7, upperWallStartY + 1, backRightZ, windowItem);

  fillColumn(originX + 3, upperWallStartY, upperWallTopY, originZ, wallItem);
  fillColumn(originX + 4, upperWallStartY, upperWallTopY, originZ, beamItem);
  fillColumn(originX + 6, upperWallStartY, upperWallTopY, originZ, beamItem);
  fillColumn(originX + 7, upperWallStartY, upperWallTopY, originZ, wallItem);
  setPlacement(originX + 5, upperWallTopY, originZ, wallItem);
  setPlacement(originX + 3, upperWallStartY + 1, originZ, windowItem);
  setPlacement(originX + 7, upperWallStartY + 1, originZ, windowItem);
  setPlacement(originX + 5, upperWallStartY, originZ, doorItem);

  for (let x = originX + 2; x <= originX + 8; x += 1) {
    if (x === originX + 4 || x === originX + 6) {
      continue;
    }
    setPlacement(x, upperWallStartY, balconyZ, fenceItem);
  }
  setPlacement(originX + 2, upperWallStartY, originZ, fenceItem);
  setPlacement(originX + 8, upperWallStartY, originZ, fenceItem);
  setPlacement(originX + 4, upperWallStartY, balconyZ, lightItem);
  setPlacement(originX + 6, upperWallStartY, balconyZ, lightItem);

  const roofTiers = [
    { y: roofBaseY, x1: frontLeftX + 1, x2: backRightX - 1, z1: frontLeftZ + 1, z2: backRightZ },
    { y: roofBaseY + 1, x1: frontLeftX + 2, x2: backRightX - 2, z1: frontLeftZ + 1, z2: backRightZ },
    { y: roofBaseY + 2, x1: frontLeftX + 3, x2: backRightX - 3, z1: frontLeftZ + 1, z2: backRightZ },
    { y: roofBaseY + 3, x1: frontLeftX + 4, x2: backRightX - 4, z1: frontLeftZ + 1, z2: backRightZ },
    { y: roofBaseY + 4, x1: frontLeftX + 5, x2: backRightX - 5, z1: frontLeftZ + 1, z2: backRightZ }
  ];

  for (const roofTier of roofTiers) {
    fillRect(roofTier.x1, roofTier.x2, roofTier.y, roofTier.z1, roofTier.z2, roofItem);
  }

  const frontGableTiers = [
    { y: roofBaseY, x1: originX + 3, x2: originX + 7 },
    { y: roofBaseY + 1, x1: originX + 4, x2: originX + 6 },
    { y: roofBaseY + 2, x1: originX + 5, x2: originX + 5 }
  ];

  for (const frontGableTier of frontGableTiers) {
    fillRect(frontGableTier.x1, frontGableTier.x2, frontGableTier.y, frontLeftZ, frontLeftZ, roofItem);
  }

  for (let z = frontLeftZ + 1; z <= backRightZ; z += 1) {
    setPlacement(originX + 5, roofBaseY + 4, z, roofAccentItem);
  }

  return sortPlacements(Array.from(placements.values()));
}

function buildImperialPagodaPlacements(originX, originY, originZ, palette) {
  const placements = new Map();
  const clearKeys = new Set();
  const {
    plotItem,
    plotBorderLightItem,
    plotBorderDarkItem,
    podiumItem,
    podiumAccentItem,
    podiumStairBlockItem,
    podiumStairSlabItem,
    terraceItem,
    beamItem,
    pillarItem,
    accentItem,
    wallItem,
    windowItem,
    railingItem,
    eaveItem,
    roofItem,
    roofAccentItem,
    ornamentItem,
    ornamentBaseItem,
    lanternItem,
    doorItem,
    stairBlockItem,
    stairSlabItem
  } = palette;

  const plotMinX = originX;
  const plotMaxX = originX + 32;
  const plotMinZ = originZ;
  const plotMaxZ = originZ + 30;
  const centerX = originX + 16;

  const lowerFloorY = originY + 5;
  const middleFloorY = originY + 11;
  const upperFloorY = originY + 17;
  const roofBaseY = originY + 23;

  const podiumMinX = originX + 4;
  const podiumMaxX = originX + 28;
  const podiumMinZ = originZ + 8;
  const podiumMaxZ = originZ + 28;

  const lowerTerraceMinX = originX + 4;
  const lowerTerraceMaxX = originX + 28;
  const lowerTerraceMinZ = originZ + 8;
  const lowerTerraceMaxZ = originZ + 28;

  const lowerHallMinX = originX + 7;
  const lowerHallMaxX = originX + 25;
  const lowerHallMinZ = originZ + 10;
  const lowerHallMaxZ = originZ + 24;

  const middleTerraceMinX = originX + 3;
  const middleTerraceMaxX = originX + 29;
  const middleTerraceMinZ = originZ + 8;
  const middleTerraceMaxZ = originZ + 28;

  const middleHallMinX = originX + 6;
  const middleHallMaxX = originX + 26;
  const middleHallMinZ = originZ + 10;
  const middleHallMaxZ = originZ + 24;

  const upperTerraceMinX = originX + 7;
  const upperTerraceMaxX = originX + 25;
  const upperTerraceMinZ = originZ + 10;
  const upperTerraceMaxZ = originZ + 26;

  const upperHallMinX = originX + 10;
  const upperHallMaxX = originX + 22;
  const upperHallMinZ = originZ + 12;
  const upperHallMaxZ = originZ + 23;

  const leftWingMinX = originX + 0;
  const leftWingMaxX = originX + 4;
  const rightWingMinX = originX + 28;
  const rightWingMaxX = originX + 32;
  const wingMinZ = originZ + 15;
  const wingMaxZ = originZ + 21;

  function clearPlacement(x, y, z) {
    const key = blockKey(x, y, z);
    clearKeys.add(key);
    placements.delete(key);
  }

  function removePlacement(x, y, z) {
    placements.delete(blockKey(x, y, z));
  }

  function setPlacementData(entry) {
    const key = blockKey(entry.x, entry.y, entry.z);
    if (clearKeys.has(key)) {
      return;
    }
    placements.set(key, entry);
  }

  function setPlacement(x, y, z, item, stage, extra) {
    setPlacementData({
      x,
      y,
      z,
      item,
      stage,
      ...(extra || {})
    });
  }

  function fillRect(x1, x2, y, z1, z2, item, stage, extra) {
    for (let z = z1; z <= z2; z += 1) {
      for (let x = x1; x <= x2; x += 1) {
        setPlacement(x, y, z, item, stage, extra);
      }
    }
  }

  function fillColumn(x, y1, y2, z, item, stage, extra) {
    for (let y = y1; y <= y2; y += 1) {
      setPlacement(x, y, z, item, stage, extra);
    }
  }

  function fillPerimeter(x1, x2, y1, y2, z1, z2, item, stage, openings, extra) {
    const holeKeys = openings || new Set();
    for (let y = y1; y <= y2; y += 1) {
      for (let x = x1; x <= x2; x += 1) {
        const frontKey = blockKey(x, y, z1);
        if (!holeKeys.has(frontKey)) {
          setPlacement(x, y, z1, item, stage, extra);
        }
        const backKey = blockKey(x, y, z2);
        if (!holeKeys.has(backKey)) {
          setPlacement(x, y, z2, item, stage, extra);
        }
      }
      for (let z = z1 + 1; z < z2; z += 1) {
        const leftKey = blockKey(x1, y, z);
        if (!holeKeys.has(leftKey)) {
          setPlacement(x1, y, z, item, stage, extra);
        }
        const rightKey = blockKey(x2, y, z);
        if (!holeKeys.has(rightKey)) {
          setPlacement(x2, y, z, item, stage, extra);
        }
      }
    }
  }

  function steppedPositions(min, max, step) {
    const result = [];
    for (let value = min; value <= max; value += step) {
      result.push(value);
    }
    if (result[result.length - 1] !== max) {
      result.push(max);
    }
    return Array.from(new Set(result));
  }

  function addBalconyRailing(x1, x2, z1, z2, y, stage, gaps) {
    const gapKeys = new Set();
    for (const gap of gaps || []) {
      for (let z = gap.z1; z <= gap.z2; z += 1) {
        for (let x = gap.x1; x <= gap.x2; x += 1) {
          gapKeys.add(blockKey(x, y, z));
        }
      }
    }

    for (let x = x1; x <= x2; x += 1) {
      if (!gapKeys.has(blockKey(x, y, z1))) {
        setPlacement(x, y, z1, railingItem, stage);
      }
      if (!gapKeys.has(blockKey(x, y, z2))) {
        setPlacement(x, y, z2, railingItem, stage);
      }
    }

    for (let z = z1 + 1; z < z2; z += 1) {
      if (!gapKeys.has(blockKey(x1, y, z))) {
        setPlacement(x1, y, z, railingItem, stage);
      }
      if (!gapKeys.has(blockKey(x2, y, z))) {
        setPlacement(x2, y, z, railingItem, stage);
      }
    }
  }

  function addLanternPair(leftX, rightX, y, z, stage) {
    setPlacement(leftX, y, z, lanternItem, stage);
    setPlacement(rightX, y, z, lanternItem, stage);
  }

  function addCloudOrnament(baseX, baseY, baseZ, mirror, stage) {
    const points = [
      { x: 0, y: 0, z: 0, item: ornamentBaseItem },
      { x: 1, y: 0, z: 0, item: ornamentBaseItem },
      { x: 2, y: 0, z: 0, item: ornamentBaseItem },
      { x: 3, y: 0, z: 0, item: ornamentBaseItem },
      { x: 1, y: 1, z: 0, item: ornamentItem },
      { x: 2, y: 1, z: 0, item: ornamentItem },
      { x: 3, y: 1, z: 0, item: ornamentItem },
      { x: 4, y: 1, z: 0, item: ornamentItem },
      { x: 5, y: 1, z: 0, item: ornamentItem },
      { x: 5, y: 2, z: 0, item: ornamentItem },
      { x: 6, y: 2, z: 0, item: ornamentItem },
      { x: 6, y: 3, z: 0, item: ornamentItem },
      { x: 5, y: 3, z: 0, item: ornamentItem },
      { x: 4, y: 3, z: 0, item: ornamentItem },
      { x: 4, y: 4, z: 0, item: ornamentItem },
      { x: 3, y: 4, z: 0, item: ornamentItem },
      { x: 2, y: 5, z: 0, item: ornamentItem },
      { x: 1, y: 4, z: 0, item: ornamentItem },
      { x: 0, y: 3, z: 0, item: ornamentItem }
    ];

    for (const point of points) {
      const x = baseX + (mirror ? -point.x : point.x);
      setPlacement(x, baseY + point.y, baseZ, point.item, stage);
    }
  }

  function addBracketAnchor(x, y, z, dirX, dirZ, stage) {
    setPlacement(x, y - 1, z, beamItem, stage);
    setPlacement(x, y - 2, z, beamItem, stage);
    setPlacement(x + dirX, y - 2, z + dirZ, eaveItem, stage);
    setPlacement(x + dirX, y - 3, z + dirZ, eaveItem, stage);
  }

  function addTerraceBrackets(x1, x2, z1, z2, floorY, stage) {
    for (let x = x1 + 2; x <= x2 - 2; x += 5) {
      addBracketAnchor(x, floorY, z1, 0, -1, stage);
      addBracketAnchor(x, floorY, z2, 0, 1, stage);
    }
    for (let z = z1 + 2; z <= z2 - 2; z += 5) {
      addBracketAnchor(x1, floorY, z, -1, 0, stage);
      addBracketAnchor(x2, floorY, z, 1, 0, stage);
    }
  }

  function addWingTerrace(x1, x2, z1, z2, floorY, ceilingY, stage) {
    fillRect(x1, x2, floorY, z1, z2, terraceItem, stage);
    fillPerimeter(x1, x2, floorY - 1, floorY - 1, z1, z2, eaveItem, stage);
    addBalconyRailing(x1, x2, z1, z2, floorY + 1, stage);
    addTerraceBrackets(x1, x2, z1, z2, floorY, stage);

    const corners = [
      { x: x1 + 1, z: z1 + 1 },
      { x: x1 + 1, z: z2 - 1 },
      { x: x2 - 1, z: z1 + 1 },
      { x: x2 - 1, z: z2 - 1 }
    ];

    for (const corner of corners) {
      fillColumn(corner.x, floorY + 1, ceilingY - 1, corner.z, pillarItem, stage);
      setPlacement(corner.x, ceilingY, corner.z, accentItem, stage);
    }
  }

  function addFrontPedestal(x1, x2, z1, z2) {
    fillRect(x1, x2, originY + 1, z1, z2, podiumItem, "podium");
    fillRect(x1 + 1, x2 - 1, originY + 2, z1 + 1, z2 - 1, podiumItem, "podium");
    for (let x = x1 + 1; x <= x2 - 1; x += 3) {
      setPlacement(x, originY + 1, z1, wallItem, "podium");
    }
  }

  function addPagodaLevel(config) {
    const {
      terraceMinX,
      terraceMaxX,
      terraceMinZ,
      terraceMaxZ,
      hallMinX,
      hallMaxX,
      hallMinZ,
      hallMaxZ,
      floorY,
      ceilingY,
      stage,
      frontGap,
      useRailing,
      extraTerraces
    } = config;

    fillRect(terraceMinX, terraceMaxX, floorY, terraceMinZ, terraceMaxZ, terraceItem, stage);
    fillPerimeter(terraceMinX, terraceMaxX, floorY - 1, floorY - 1, terraceMinZ, terraceMaxZ, eaveItem, stage);
    fillPerimeter(terraceMinX - 1, terraceMaxX + 1, ceilingY, ceilingY, terraceMinZ - 1, terraceMaxZ + 1, eaveItem, stage);
    addTerraceBrackets(terraceMinX, terraceMaxX, terraceMinZ, terraceMaxZ, floorY, stage);

    if (useRailing) {
      addBalconyRailing(terraceMinX, terraceMaxX, terraceMinZ, terraceMaxZ, floorY + 1, stage, frontGap ? [frontGap] : []);
    }

    for (const rect of extraTerraces || []) {
      addWingTerrace(rect.x1, rect.x2, rect.z1, rect.z2, floorY, ceilingY, stage);
    }

    const beamXs = steppedPositions(hallMinX, hallMaxX, 4);
    const beamZs = steppedPositions(hallMinZ, hallMaxZ, 4);
    const wallBottomY = floorY + 1;
    const wallMidTopY = ceilingY - 2;
    const windowY = ceilingY - 1;
    const capY = ceilingY;
    const centerDoorX = Math.floor((hallMinX + hallMaxX - 1) / 2);

    for (const x of beamXs) {
      fillColumn(x, wallBottomY, capY, hallMinZ, beamItem, stage);
      fillColumn(x, wallBottomY, capY, hallMaxZ, beamItem, stage);
    }
    for (const z of beamZs) {
      fillColumn(hallMinX, wallBottomY, capY, z, beamItem, stage);
      fillColumn(hallMaxX, wallBottomY, capY, z, beamItem, stage);
    }

    for (let x = hallMinX + 1; x < hallMaxX; x += 1) {
      const frontIsDoor = x === centerDoorX || x === centerDoorX + 1 || x === centerDoorX + 2;
      if (!frontIsDoor) {
        for (let y = wallBottomY; y <= wallMidTopY; y += 1) {
          setPlacement(x, y, hallMinZ, wallItem, stage);
        }
      }
      setPlacement(x, windowY, hallMinZ, windowItem, stage);
      setPlacement(x, capY, hallMinZ, accentItem, stage);

      for (let y = wallBottomY; y <= wallMidTopY; y += 1) {
        setPlacement(x, y, hallMaxZ, wallItem, stage);
      }
      setPlacement(x, windowY, hallMaxZ, windowItem, stage);
      setPlacement(x, capY, hallMaxZ, accentItem, stage);
    }

    for (let z = hallMinZ + 1; z < hallMaxZ; z += 1) {
      for (let y = wallBottomY; y <= wallMidTopY; y += 1) {
        setPlacement(hallMinX, y, z, wallItem, stage);
        setPlacement(hallMaxX, y, z, wallItem, stage);
      }
      setPlacement(hallMinX, windowY, z, windowItem, stage);
      setPlacement(hallMaxX, windowY, z, windowItem, stage);
      setPlacement(hallMinX, capY, z, accentItem, stage);
      setPlacement(hallMaxX, capY, z, accentItem, stage);
    }

    removePlacement(centerDoorX, wallBottomY, hallMinZ);
    removePlacement(centerDoorX, wallBottomY + 1, hallMinZ);
    removePlacement(centerDoorX + 1, wallBottomY, hallMinZ);
    removePlacement(centerDoorX + 1, wallBottomY + 1, hallMinZ);
    removePlacement(centerDoorX + 2, wallBottomY, hallMinZ);
    removePlacement(centerDoorX + 2, wallBottomY + 1, hallMinZ);
    setPlacement(centerDoorX, wallBottomY, hallMinZ, doorItem, stage);
    setPlacement(centerDoorX + 1, wallBottomY, hallMinZ, doorItem, stage);

    addLanternPair(centerDoorX - 2, centerDoorX + 4, wallBottomY, hallMinZ - 1, stage);
    fillPerimeter(hallMinX, hallMaxX, capY, capY, hallMinZ, hallMaxZ, beamItem, stage);

    const pillarXs = steppedPositions(terraceMinX + 2, terraceMaxX - 2, 4);
    const pillarZs = steppedPositions(terraceMinZ + 2, terraceMaxZ - 2, 4);
    for (const x of pillarXs) {
      fillColumn(x, floorY + 1, floorY + 3, terraceMinZ + 1, pillarItem, stage);
      fillColumn(x, floorY + 1, floorY + 3, terraceMaxZ - 1, pillarItem, stage);
      fillColumn(x, floorY + 4, ceilingY - 1, terraceMinZ + 1, pillarItem, stage);
      fillColumn(x, floorY + 4, ceilingY - 1, terraceMaxZ - 1, pillarItem, stage);
      setPlacement(x, capY, terraceMinZ + 1, accentItem, stage);
      setPlacement(x, capY, terraceMaxZ - 1, accentItem, stage);
    }
    for (const z of pillarZs) {
      fillColumn(terraceMinX + 1, floorY + 1, floorY + 3, z, pillarItem, stage);
      fillColumn(terraceMaxX - 1, floorY + 1, floorY + 3, z, pillarItem, stage);
      fillColumn(terraceMinX + 1, floorY + 4, ceilingY - 1, z, pillarItem, stage);
      fillColumn(terraceMaxX - 1, floorY + 4, ceilingY - 1, z, pillarItem, stage);
      setPlacement(terraceMinX + 1, capY, z, accentItem, stage);
      setPlacement(terraceMaxX - 1, capY, z, accentItem, stage);
    }
  }

  fillRect(plotMinX, plotMaxX, originY, plotMinZ, plotMaxZ, plotItem, "plot");
  for (let x = plotMinX; x <= plotMaxX; x += 1) {
    const frontItem = (x - plotMinX) % 2 === 0 ? plotBorderLightItem : plotBorderDarkItem;
    const backItem = (x - plotMinX) % 2 === 0 ? plotBorderDarkItem : plotBorderLightItem;
    setPlacement(x, originY, plotMinZ, frontItem, "plot");
    setPlacement(x, originY, plotMaxZ, backItem, "plot");
  }
  for (let z = plotMinZ + 1; z < plotMaxZ; z += 1) {
    const leftItem = (z - plotMinZ) % 2 === 0 ? plotBorderLightItem : plotBorderDarkItem;
    const rightItem = (z - plotMinZ) % 2 === 0 ? plotBorderDarkItem : plotBorderLightItem;
    setPlacement(plotMinX, originY, z, leftItem, "plot");
    setPlacement(plotMaxX, originY, z, rightItem, "plot");
  }

  fillRect(podiumMinX - 1, podiumMaxX + 1, originY + 1, podiumMinZ - 1, podiumMaxZ + 1, podiumItem, "podium");
  fillRect(podiumMinX, podiumMaxX, originY + 2, podiumMinZ, podiumMaxZ, podiumItem, "podium");

  const frontWallOpenings = new Set();
  for (let y = originY + 1; y <= lowerFloorY - 1; y += 1) {
    for (let z = podiumMinZ - 2; z <= podiumMinZ; z += 1) {
      for (let x = centerX - 4; x <= centerX + 4; x += 1) {
        frontWallOpenings.add(blockKey(x, y, z));
      }
    }
  }

  fillPerimeter(podiumMinX - 2, podiumMaxX + 2, originY + 1, lowerFloorY - 1, podiumMinZ - 2, podiumMaxZ + 1, podiumItem, "podium", frontWallOpenings);

  for (let x = podiumMinX - 2; x <= podiumMaxX + 2; x += 2) {
    setPlacement(x, lowerFloorY, podiumMinZ - 2, podiumAccentItem, "podium");
    setPlacement(x, lowerFloorY, podiumMaxZ + 1, podiumAccentItem, "podium");
  }
  for (let z = podiumMinZ; z <= podiumMaxZ - 1; z += 2) {
    setPlacement(podiumMinX - 2, lowerFloorY, z, podiumAccentItem, "podium");
    setPlacement(podiumMaxX + 2, lowerFloorY, z, podiumAccentItem, "podium");
  }

  addWalkableStairRun({
    setPlacementData,
    clearPlacement,
    startX: centerX - 3,
    startY: originY,
    startZ: plotMinZ,
    dirX: 0,
    dirZ: 1,
    width: 7,
    rise: 5,
    supportItem: podiumItem,
    blockItem: podiumStairBlockItem,
    slabItem: podiumStairSlabItem,
    stage: "podium"
  });

  fillRect(centerX - 3, centerX + 3, lowerFloorY, podiumMinZ - 1, podiumMinZ + 2, terraceItem, "podium");
  fillRect(centerX - 1, centerX + 1, lowerFloorY, podiumMinZ + 3, podiumMinZ + 5, terraceItem, "podium");

  addFrontPedestal(originX + 4, originX + 10, originZ + 2, originZ + 6);
  addFrontPedestal(originX + 22, originX + 28, originZ + 2, originZ + 6);
  addCloudOrnament(originX + 5, originY + 3, originZ + 4, false, "decor");
  addCloudOrnament(originX + 27, originY + 3, originZ + 4, true, "decor");
  addLanternPair(originX + 9, originX + 23, originY + 2, originZ + 7, "decor");

  addPagodaLevel({
    terraceMinX: lowerTerraceMinX,
    terraceMaxX: lowerTerraceMaxX,
    terraceMinZ: lowerTerraceMinZ,
    terraceMaxZ: lowerTerraceMaxZ,
    hallMinX: lowerHallMinX,
    hallMaxX: lowerHallMaxX,
    hallMinZ: lowerHallMinZ,
    hallMaxZ: lowerHallMaxZ,
    floorY: lowerFloorY,
    ceilingY: middleFloorY - 1,
    stage: "level1",
    useRailing: false,
    extraTerraces: [],
    frontGap: {
      x1: centerX - 3,
      x2: centerX + 3,
      z1: lowerTerraceMinZ,
      z2: lowerTerraceMinZ
    }
  });

  addWalkableStairRun({
    setPlacementData,
    clearPlacement,
    startX: lowerHallMinX + 1,
    startY: lowerFloorY,
    startZ: lowerHallMaxZ - 1,
    dirX: 1,
    dirZ: 0,
    width: 2,
    rise: 6,
    supportItem: beamItem,
    blockItem: stairBlockItem,
    slabItem: stairSlabItem,
    stage: "level1"
  });

  addPagodaLevel({
    terraceMinX: middleTerraceMinX,
    terraceMaxX: middleTerraceMaxX,
    terraceMinZ: middleTerraceMinZ,
    terraceMaxZ: middleTerraceMaxZ,
    hallMinX: middleHallMinX,
    hallMaxX: middleHallMaxX,
    hallMinZ: middleHallMinZ,
    hallMaxZ: middleHallMaxZ,
    floorY: middleFloorY,
    ceilingY: upperFloorY - 1,
    stage: "level2",
    useRailing: true,
    extraTerraces: [
      { x1: leftWingMinX, x2: leftWingMaxX, z1: wingMinZ, z2: wingMaxZ },
      { x1: rightWingMinX, x2: rightWingMaxX, z1: wingMinZ, z2: wingMaxZ }
    ]
  });

  addLanternPair(centerX - 3, centerX + 3, middleFloorY + 1, middleTerraceMinZ + 1, "decor");

  addWalkableStairRun({
    setPlacementData,
    clearPlacement,
    startX: middleHallMaxX - 1,
    startY: middleFloorY,
    startZ: middleHallMinZ + 1,
    dirX: -1,
    dirZ: 0,
    width: 2,
    rise: 6,
    supportItem: beamItem,
    blockItem: stairBlockItem,
    slabItem: stairSlabItem,
    stage: "level2"
  });

  addPagodaLevel({
    terraceMinX: upperTerraceMinX,
    terraceMaxX: upperTerraceMaxX,
    terraceMinZ: upperTerraceMinZ,
    terraceMaxZ: upperTerraceMaxZ,
    hallMinX: upperHallMinX,
    hallMaxX: upperHallMaxX,
    hallMinZ: upperHallMinZ,
    hallMaxZ: upperHallMaxZ,
    floorY: upperFloorY,
    ceilingY: roofBaseY - 1,
    stage: "level3",
    useRailing: true,
    extraTerraces: []
  });

  addCloudOrnament(upperTerraceMinX + 3, upperFloorY + 1, upperTerraceMinZ + 2, false, "decor");
  addCloudOrnament(upperTerraceMaxX - 3, upperFloorY + 1, upperTerraceMinZ + 2, true, "decor");
  addLanternPair(centerX - 2, centerX + 2, upperFloorY + 1, upperTerraceMinZ + 1, "decor");

  fillPerimeter(upperTerraceMinX - 3, upperTerraceMaxX + 3, roofBaseY - 1, roofBaseY - 1, upperTerraceMinZ - 3, upperTerraceMaxZ + 2, eaveItem, "roof");

  const roofTiers = [
    { y: roofBaseY, x1: upperTerraceMinX - 3, x2: upperTerraceMaxX + 3, z1: upperTerraceMinZ - 3, z2: upperTerraceMaxZ + 2 },
    { y: roofBaseY + 1, x1: upperTerraceMinX - 2, x2: upperTerraceMaxX + 2, z1: upperTerraceMinZ - 2, z2: upperTerraceMaxZ + 1 },
    { y: roofBaseY + 2, x1: upperTerraceMinX - 1, x2: upperTerraceMaxX + 1, z1: upperTerraceMinZ - 1, z2: upperTerraceMaxZ },
    { y: roofBaseY + 3, x1: upperTerraceMinX, x2: upperTerraceMaxX, z1: upperTerraceMinZ, z2: upperTerraceMaxZ - 1 },
    { y: roofBaseY + 4, x1: upperHallMinX - 1, x2: upperHallMaxX + 1, z1: upperHallMinZ, z2: upperHallMaxZ }
  ];

  for (const roofTier of roofTiers) {
    fillRect(roofTier.x1, roofTier.x2, roofTier.y, roofTier.z1, roofTier.z2, roofItem, "roof");
  }

  const upperRoofTiers = [
    { y: roofBaseY + 5, x1: upperHallMinX - 1, x2: upperHallMaxX + 1, z1: upperHallMinZ, z2: upperHallMaxZ },
    { y: roofBaseY + 6, x1: upperHallMinX, x2: upperHallMaxX, z1: upperHallMinZ + 1, z2: upperHallMaxZ - 1 },
    { y: roofBaseY + 7, x1: upperHallMinX + 1, x2: upperHallMaxX - 1, z1: upperHallMinZ + 2, z2: upperHallMaxZ - 2 },
    { y: roofBaseY + 8, x1: upperHallMinX + 2, x2: upperHallMaxX - 2, z1: upperHallMinZ + 3, z2: upperHallMaxZ - 3 },
    { y: roofBaseY + 9, x1: upperHallMinX + 3, x2: upperHallMaxX - 3, z1: upperHallMinZ + 4, z2: upperHallMaxZ - 4 }
  ];

  for (const roofTier of upperRoofTiers) {
    fillRect(roofTier.x1, roofTier.x2, roofTier.y, roofTier.z1, roofTier.z2, roofItem, "roof");
  }

  const frontGableTiers = [
    { y: roofBaseY + 5, x1: centerX - 4, x2: centerX + 4, z1: upperTerraceMinZ - 1, z2: upperTerraceMinZ - 1 },
    { y: roofBaseY + 6, x1: centerX - 3, x2: centerX + 3, z1: upperTerraceMinZ - 2, z2: upperTerraceMinZ - 2 },
    { y: roofBaseY + 7, x1: centerX - 2, x2: centerX + 2, z1: upperTerraceMinZ - 3, z2: upperTerraceMinZ - 3 },
    { y: roofBaseY + 8, x1: centerX - 1, x2: centerX + 1, z1: upperTerraceMinZ - 4, z2: upperTerraceMinZ - 4 }
  ];
  const backGableTiers = [
    { y: roofBaseY + 5, x1: centerX - 4, x2: centerX + 4, z1: upperTerraceMaxZ, z2: upperTerraceMaxZ },
    { y: roofBaseY + 6, x1: centerX - 3, x2: centerX + 3, z1: upperTerraceMaxZ + 1, z2: upperTerraceMaxZ + 1 },
    { y: roofBaseY + 7, x1: centerX - 2, x2: centerX + 2, z1: upperTerraceMaxZ + 2, z2: upperTerraceMaxZ + 2 },
    { y: roofBaseY + 8, x1: centerX - 1, x2: centerX + 1, z1: upperTerraceMaxZ + 3, z2: upperTerraceMaxZ + 3 }
  ];

  for (const tier of frontGableTiers.concat(backGableTiers)) {
    fillRect(tier.x1, tier.x2, tier.y, tier.z1, tier.z2, roofItem, "roof");
  }

  const roofCornerTips = [
    { x: upperTerraceMinX - 3, z: upperTerraceMinZ - 3, dx: -1, dz: -1 },
    { x: upperTerraceMaxX + 3, z: upperTerraceMinZ - 3, dx: 1, dz: -1 },
    { x: upperTerraceMinX - 3, z: upperTerraceMaxZ + 2, dx: -1, dz: 1 },
    { x: upperTerraceMaxX + 3, z: upperTerraceMaxZ + 2, dx: 1, dz: 1 }
  ];

  for (const tip of roofCornerTips) {
    setPlacement(tip.x, roofBaseY, tip.z, eaveItem, "roof");
    setPlacement(tip.x + tip.dx, roofBaseY, tip.z, eaveItem, "roof");
    setPlacement(tip.x + tip.dx * 2, roofBaseY + 1, tip.z + tip.dz, roofAccentItem, "roof", {
      placeOptions: {
        half: "bottom"
      }
    });
  }

  for (let z = upperTerraceMinZ - 1; z <= upperTerraceMaxZ + 1; z += 1) {
    setPlacement(centerX, roofBaseY + 9, z, roofAccentItem, "roof", {
      placeOptions: {
        half: "bottom"
      }
    });
  }

  return Array.from(placements.values());
}

function findFlatBuildOrigin(bot, options) {
  const allowedGround = new Set(["grass_block", "dirt", "coarse_dirt"]);
  const width = Math.max(8, Math.floor(options.width || 8));
  const depth = Math.max(8, Math.floor(options.depth || 8));
  const searchRadius = Math.max(12, Math.floor(options.searchRadius || 96));
  const sampleStep = Math.max(2, Math.floor(options.sampleStep || 2));
  const ringStep = Math.max(4, Math.floor(options.ringStep || 6));
  const currentY = Math.floor(bot.entity.position.y);
  const baseY = Number.isFinite(options.y) ? Math.floor(options.y) : currentY - 1;
  const scanMinY = Number.isFinite(options.minY) ? Math.floor(options.minY) : Math.max(-64, baseY - 16);
  const scanMaxY = Number.isFinite(options.maxY) ? Math.floor(options.maxY) : Math.min(320, currentY + 192);
  const centerX = Number.isFinite(options.centerX) ? Math.floor(options.centerX) : Math.floor(bot.entity.position.x);
  const centerZ = Number.isFinite(options.centerZ) ? Math.floor(options.centerZ) : Math.floor(bot.entity.position.z);
  const surfaceCache = new Map();

  function findSurfaceY(x, z) {
    const cacheKey = blockKey(x, 0, z);
    if (surfaceCache.has(cacheKey)) {
      return surfaceCache.get(cacheKey);
    }

    for (let y = scanMaxY; y >= scanMinY; y -= 1) {
      const ground = bot.blockAt(new Vec3(x, y, z));
      const above = bot.blockAt(new Vec3(x, y + 1, z));
      const aboveUpper = bot.blockAt(new Vec3(x, y + 2, z));
      if (ground && allowedGround.has(ground.name) && isAir(above) && isAir(aboveUpper)) {
        surfaceCache.set(cacheKey, y);
        return y;
      }
    }

    surfaceCache.set(cacheKey, null);
    return null;
  }

  function areaIsClear(originX, originZ) {
    const sampleX = originX + Math.floor(width / 2);
    const sampleZ = originZ + Math.floor(depth / 2);
    const targetY = findSurfaceY(sampleX, sampleZ);
    if (!Number.isFinite(targetY)) {
      return null;
    }

    for (let z = 0; z < depth; z += sampleStep) {
      for (let x = 0; x < width; x += sampleStep) {
        const ground = bot.blockAt(new Vec3(originX + x, targetY, originZ + z));
        const above = bot.blockAt(new Vec3(originX + x, targetY + 1, originZ + z));
        const aboveUpper = bot.blockAt(new Vec3(originX + x, targetY + 2, originZ + z));
        if (!ground || !allowedGround.has(ground.name) || !isAir(above) || !isAir(aboveUpper)) {
          return null;
        }
      }
    }
    return targetY;
  }

  const candidates = [];
  for (let radius = ringStep; radius <= searchRadius; radius += ringStep) {
    for (let dz = -radius; dz <= radius; dz += ringStep) {
      for (let dx = -radius; dx <= radius; dx += ringStep) {
        if (Math.abs(dx) !== radius && Math.abs(dz) !== radius) {
          continue;
        }
        candidates.push({
          x: centerX + dx,
          z: centerZ + dz
        });
      }
    }
  }

  for (const candidate of candidates) {
    const targetY = areaIsClear(candidate.x, candidate.z);
    if (Number.isFinite(targetY)) {
      return {
        x: candidate.x,
        y: targetY,
        z: candidate.z
      };
    }
  }

  throw new Error("could not find a flat empty build area nearby");
}

function buildReferencePathChainPlacements(originX, originY, originZ, palette) {
  const placements = new Map();
  const {
    segmentCount,
    segmentLength,
    pathWidth,
    dirX,
    dirZ,
    stoneMainItem,
    stoneEdgeItem,
    stoneAccentItem,
    dirtMainItem,
    dirtEdgeItem,
    dirtAccentItem,
    postItem,
    leafItem,
    lanternItem,
    shrubItem
  } = palette;

  const halfWidth = Math.max(2, Math.floor(pathWidth / 2));
  const perpX = -dirZ;
  const perpZ = dirX;
  const totalLength = segmentCount * segmentLength;
  const centerX = originX + 4;
  const centerZ = originZ + 4 + halfWidth;

  function setPlacement(x, y, z, item, stage, extra) {
    placements.set(stage + "|" + blockKey(x, y, z), {
      x,
      y,
      z,
      item,
      stage,
      ...(extra || {})
    });
  }

  function makePreferredSupport(supportX, supportY, supportZ, faceX, faceY, faceZ) {
    return {
      position: new Vec3(supportX, supportY, supportZ),
      face: new Vec3(faceX, faceY, faceZ)
    };
  }

  function addTreeCanopy(treeX, treeZ) {
    const trunkTopY = originY + 4;
    const centerLeafY = originY + 5;
    const upperLeafY = originY + 6;

    setPlacement(treeX, centerLeafY, treeZ, leafItem, "decor_base", {
      preferredSupport: makePreferredSupport(treeX, trunkTopY, treeZ, 0, 1, 0)
    });

    const sideOffsets = [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1]
    ];
    for (const [dx, dz] of sideOffsets) {
      setPlacement(treeX + dx, centerLeafY, treeZ + dz, leafItem, "decor_leaf", {
        preferredSupport: makePreferredSupport(treeX, centerLeafY, treeZ, dx, 0, dz)
      });
      setPlacement(treeX + dx, upperLeafY, treeZ + dz, leafItem, "decor_top", {
        preferredSupport: makePreferredSupport(treeX + dx, centerLeafY, treeZ + dz, 0, 1, 0)
      });
    }

    setPlacement(treeX, centerLeafY, treeZ, lanternItem, "decor_finish", {
      preferredSupport: makePreferredSupport(treeX, trunkTopY, treeZ, 0, 1, 0)
    });
  }

  function addTreePair(stepIndex) {
    const anchorX = centerX + dirX * stepIndex;
    const anchorZ = centerZ + dirZ * stepIndex;
    const leftX = anchorX + perpX * (halfWidth + 3);
    const leftZ = anchorZ + perpZ * (halfWidth + 3);
    const rightX = anchorX - perpX * (halfWidth + 3);
    const rightZ = anchorZ - perpZ * (halfWidth + 3);

    for (let y = originY + 1; y <= originY + 4; y += 1) {
      setPlacement(leftX, y, leftZ, postItem, "posts");
      setPlacement(rightX, y, rightZ, postItem, "posts");
    }

    addTreeCanopy(leftX, leftZ);
    addTreeCanopy(rightX, rightZ);
  }

  function addShrubPair(stepIndex) {
    const anchorX = centerX + dirX * stepIndex;
    const anchorZ = centerZ + dirZ * stepIndex;
    const leftX = anchorX + perpX * (halfWidth + 2);
    const leftZ = anchorZ + perpZ * (halfWidth + 2);
    const rightX = anchorX - perpX * (halfWidth + 2);
    const rightZ = anchorZ - perpZ * (halfWidth + 2);

    setPlacement(leftX, originY + 1, leftZ, shrubItem, "decor_base");
    setPlacement(rightX, originY + 1, rightZ, shrubItem, "decor_base");
  }

  function groundItemFor(style, lateral, stepIndex) {
    const absLateral = Math.abs(lateral);
    if (style === "stone") {
      if (absLateral === 0) {
        return stoneMainItem;
      }
      if (absLateral === halfWidth) {
        return stepIndex % 2 === 0 ? stoneEdgeItem : stoneAccentItem;
      }
      return (stepIndex + lateral) % 2 === 0 ? stoneAccentItem : stoneMainItem;
    }

    if (absLateral === 0) {
      return dirtMainItem;
    }
    if (absLateral === halfWidth) {
      return dirtEdgeItem;
    }
    return (stepIndex + lateral) % 3 === 0 ? dirtAccentItem : dirtMainItem;
  }

  for (let segmentIndex = 0; segmentIndex < segmentCount; segmentIndex += 1) {
    const style = segmentIndex % 2 === 0 ? "stone" : "dirt";
    const segmentStart = segmentIndex * segmentLength;

    for (let localStep = 0; localStep < segmentLength; localStep += 1) {
      const stepIndex = segmentStart + localStep;
      const pathX = centerX + dirX * stepIndex;
      const pathZ = centerZ + dirZ * stepIndex;

      for (let lateral = -halfWidth; lateral <= halfWidth; lateral += 1) {
        const x = pathX + perpX * lateral;
        const z = pathZ + perpZ * lateral;
        setPlacement(x, originY, z, groundItemFor(style, lateral, stepIndex), "ground");
      }

      if (localStep === 0 && segmentIndex > 0) {
        for (let lateral = -halfWidth - 1; lateral <= halfWidth + 1; lateral += 1) {
          const seamX = pathX + perpX * lateral;
          const seamZ = pathZ + perpZ * lateral;
          const blendItem = style === "stone" ? stoneEdgeItem : dirtEdgeItem;
          setPlacement(seamX, originY, seamZ, blendItem, "ground");
        }
      }

      if (style === "stone" && localStep % 5 === 2) {
        addTreePair(stepIndex);
      }
      if (style === "dirt" && localStep % 4 === 1) {
        addShrubPair(stepIndex);
      }
    }
  }

  return {
    placements: Array.from(placements.values()),
    totalLength,
    center: {
      x: centerX + dirX * Math.floor(totalLength / 2),
      y: originY + 1,
      z: centerZ + dirZ * Math.floor(totalLength / 2)
    },
    footprint: {
      width: totalLength + 8,
      depth: pathWidth + 12
    }
  };
}

function countInventoryItem(bot, itemName) {
  const normalized = registryItemName(itemName);
  return bot.inventory.items()
    .filter((item) => item.name === normalized)
    .reduce((sum, item) => sum + item.count, 0);
}

function getBlockAge(block) {
  if (!block) {
    return null;
  }
  if (typeof block.getProperties === "function") {
    const properties = block.getProperties();
    if (properties && "age" in properties) {
      if (typeof properties.age === "number" && Number.isFinite(properties.age)) {
        return properties.age;
      }
      const parsedAge = Number(properties.age);
      if (Number.isFinite(parsedAge)) {
        return parsedAge;
      }
    }
  }
  return null;
}

function isMatureCrop(block, cropName) {
  if (!block || block.name !== cropName) {
    return false;
  }
  const age = getBlockAge(block);
  if (age === null) {
    return true;
  }
  return age >= 7;
}

async function runBotCommand(bot, command) {
  chatHistory.addTyped(command);
  bot.chat(command);
  await sleep(400);
}

async function rightClickBlockWithItem(bot, itemName, x, y, z, range, delayMs, options) {
  const face = options && options.face ? options.face : new Vec3(0, 1, 0);
  const cursorPos = options && options.cursorPos ? options.cursorPos : new Vec3(0.5, 0.5, 0.5);
  await ensureNear(bot, x, y, z, range);
  await equipItemByName(bot, itemName);
  const block = bot.blockAt(new Vec3(x, y, z));
  if (!block) {
    throw new Error("target block not found at " + blockKey(x, y, z));
  }
  await bot.lookAt(new Vec3(x + 0.5, y + 0.5, z + 0.5), true);
  await bot.activateBlock(block, face, cursorPos);
  await sleep(delayMs);
  return block;
}

function directionVectorToNumber(direction) {
  if (direction.y < 0) {
    return 0;
  }
  if (direction.y > 0) {
    return 1;
  }
  if (direction.z < 0) {
    return 2;
  }
  if (direction.z > 0) {
    return 3;
  }
  if (direction.x < 0) {
    return 4;
  }
  return 5;
}

function nextUseSequence(bot) {
  const current = Number.isFinite(bot.__codexUseSequence) ? bot.__codexUseSequence : 0;
  const next = current + 1;
  bot.__codexUseSequence = next;
  return next;
}

async function useHeldItemOnBlockFace(bot, block, direction, cursorPos, forceLook) {
  if (!block) {
    throw new Error("target block not found");
  }
  if (!bot.heldItem) {
    throw new Error("must be holding an item");
  }

  const face = direction || new Vec3(0, 1, 0);
  const cursor = cursorPos || new Vec3(0.5, 0.5, 0.5);
  if (forceLook !== false) {
    await bot.lookAt(block.position.offset(cursor.x, cursor.y, cursor.z), true);
  }

  if (bot.supportFeature("blockPlaceHasHeldItem")) {
    bot._client.write("block_place", {
      location: block.position,
      direction: directionVectorToNumber(face),
      heldItem: prismarineItem(bot.registry).toNotch(bot.heldItem),
      cursorX: Math.floor(cursor.x * 16),
      cursorY: Math.floor(cursor.y * 16),
      cursorZ: Math.floor(cursor.z * 16)
    });
  } else if (bot.supportFeature("blockPlaceHasHandAndIntCursor")) {
    bot._client.write("block_place", {
      location: block.position,
      direction: directionVectorToNumber(face),
      hand: 0,
      cursorX: Math.floor(cursor.x * 16),
      cursorY: Math.floor(cursor.y * 16),
      cursorZ: Math.floor(cursor.z * 16)
    });
  } else if (bot.supportFeature("blockPlaceHasHandAndFloatCursor")) {
    bot._client.write("block_place", {
      location: block.position,
      direction: directionVectorToNumber(face),
      hand: 0,
      cursorX: cursor.x,
      cursorY: cursor.y,
      cursorZ: cursor.z
    });
  } else if (bot.supportFeature("blockPlaceHasInsideBlock")) {
    bot._client.write("block_place", {
      location: block.position,
      direction: directionVectorToNumber(face),
      hand: 0,
      cursorX: cursor.x,
      cursorY: cursor.y,
      cursorZ: cursor.z,
      insideBlock: false,
      worldBorderHit: false,
      sequence: nextUseSequence(bot)
    });
  } else {
    throw new Error("block interaction packet not supported");
  }

  bot.swingArm("right");
}

async function ensureSupportBlockByHand(bot, x, y, z, itemName, range, delayMs) {
  const supportBlock = bot.blockAt(new Vec3(x, y, z));
  if (!isAir(supportBlock)) {
    return {
      x,
      y,
      z,
      item: itemName,
      placed: false,
      skipped: true,
      finalBlock: supportBlock.name
    };
  }

  return placeBlockByHand(bot, { x, y, z, item: itemName }, {
    range,
    placeDelayMs: delayMs,
    replace: false
  });
}

async function placeWaterSourceByHand(bot, itemName, x, y, z, range, delayMs, options) {
  const targetPos = new Vec3(x, y, z);
  const existing = bot.blockAt(targetPos);
  if (existing && existing.name === "water") {
    return {
      x,
      y,
      z,
      placed: false,
      skipped: true,
      finalBlock: existing.name,
      method: "existing"
    };
  }

  if (!isAir(existing)) {
    throw new Error("water target occupied at " + blockKey(x, y, z) + " by " + existing.name);
  }

  const supportBlock = bot.blockAt(new Vec3(x, y - 1, z));
  if (!supportBlock || isAir(supportBlock)) {
    throw new Error("water support missing at " + blockKey(x, y - 1, z));
  }

  const inventoryOptions = {
    ...(options || {})
  };
  await ensureInventoryItem(bot, itemName, 1, inventoryOptions);
  await ensureNear(bot, x, y - 1, z, range, {
    lookAtBlock: true,
    reach: Math.max(4.5, range)
  });
  await equipItemByName(bot, itemName);
  const face = new Vec3(0, 1, 0);
  const cursors = [
    new Vec3(0.5, 0.999, 0.5),
    new Vec3(0.5, 0.875, 0.5),
    new Vec3(0.5, 0.75, 0.5),
    new Vec3(0.55, 0.99, 0.55),
    new Vec3(0.45, 0.99, 0.45)
  ];

  async function waitForWater(method, cursor) {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await sleep(delayMs);
      const placed = bot.blockAt(targetPos);
      if (placed && placed.name === "water") {
        return {
          x,
          y,
          z,
          placed: true,
          skipped: false,
          finalBlock: placed.name,
          method,
          cursor: cursor ? { x: cursor.x, y: cursor.y, z: cursor.z } : null
        };
      }
    }
    return null;
  }

  const errors = [];
  for (const cursor of cursors) {
    const bucketAttempts = [
      {
        method: "use_on_packet",
        run: async () => {
          await useHeldItemOnBlockFace(bot, supportBlock, face, cursor, true);
        }
      },
      {
        method: "activate_block",
        run: async () => {
          await bot.lookAt(supportBlock.position.offset(cursor.x, cursor.y, cursor.z), true);
          await bot.activateBlock(supportBlock, face, cursor);
        }
      },
      {
        method: "activate_item",
        run: async () => {
          await bot.lookAt(supportBlock.position.offset(cursor.x, cursor.y, cursor.z), true);
          await bot.activateItem(false);
        }
      }
    ];

    if (typeof bot._placeBlockWithOptions === "function") {
      bucketAttempts.splice(1, 0, {
        method: "place_with_options",
        run: async () => {
          await bot._placeBlockWithOptions(supportBlock, face, {
            delta: cursor,
            forceLook: true,
            swingArm: "right"
          });
        }
      });
    }

    for (const attempt of bucketAttempts) {
      try {
        await attempt.run();
      } catch (error) {
        errors.push(attempt.method + "@" + cursor.x.toFixed(3) + "," + cursor.y.toFixed(3) + "," + cursor.z.toFixed(3) + ": " + error.message);
      }
      const waterResult = await waitForWater(attempt.method, cursor);
      if (waterResult) {
        return waterResult;
      }
    }
  }

  const finalBlock = bot.blockAt(targetPos);
  const finalName = finalBlock ? finalBlock.name : "air";
  const details = errors.length > 0 ? " attempts=" + errors.join(" | ") : "";
  throw new Error("failed to place water at " + blockKey(x, y, z) + ", got " + finalName + details);
}

async function isDoubleChestContainer(bot, x, y, z, range) {
  await ensureNear(bot, x, y, z, range);
  const chestBlock = bot.blockAt(new Vec3(x, y, z));
  if (!chestBlock || chestBlock.name !== "chest") {
    return false;
  }

  const container = await bot.openContainer(chestBlock);
  try {
    return container.inventoryStart >= 54;
  } finally {
    container.close();
    await sleep(150);
  }
}

async function placeDoubleChestByHand(bot, firstPlacement, secondPlacement, options) {
  const range = options.range;
  const placeDelayMs = options.placeDelayMs;
  const chestY = firstPlacement.y;
  const centerX = (firstPlacement.x + secondPlacement.x) / 2;
  const centerZ = (firstPlacement.z + secondPlacement.z) / 2;
  const standPoints = [
    { x: centerX, y: chestY, z: centerZ + 2 },
    { x: centerX, y: chestY, z: centerZ - 2 },
    { x: centerX - 2, y: chestY, z: centerZ },
    { x: centerX + 2, y: chestY, z: centerZ }
  ];

  for (const standPoint of standPoints) {
    await clearBlockIfNeeded(bot, firstPlacement.x, firstPlacement.y, firstPlacement.z, range, placeDelayMs);
    await clearBlockIfNeeded(bot, secondPlacement.x, secondPlacement.y, secondPlacement.z, range, placeDelayMs);
    await ensureNear(bot, standPoint.x, standPoint.y, standPoint.z, 0.6);

    await placeBlockByHand(bot, firstPlacement, {
      range,
      placeDelayMs,
      replace: false
    });
    await placeBlockByHand(bot, secondPlacement, {
      range,
      placeDelayMs,
      replace: false
    });

    if (await isDoubleChestContainer(bot, firstPlacement.x, firstPlacement.y, firstPlacement.z, range)) {
      return {
        placed: true,
        merged: true
      };
    }
  }

  throw new Error("failed to merge double chest at " + blockKey(firstPlacement.x, firstPlacement.y, firstPlacement.z));
}

function findWindowItemSlot(window, itemName, start, end) {
  for (let slot = start; slot < end; slot += 1) {
    const item = window.slots[slot];
    if (item && item.name === itemName) {
      return slot;
    }
  }
  return -1;
}

function firstEmptyContainerSlot(window, startSlot) {
  for (let slot = startSlot; slot < window.inventoryStart; slot += 1) {
    if (!window.slots[slot]) {
      return slot;
    }
  }
  return -1;
}

function buildFivePatternSlots() {
  return [
    0, 1, 2,
    9,
    18, 19, 20,
    29,
    36, 37, 38
  ];
}

async function arrangeItemsInChest(window, bot, itemName, patternSlots, remainderSlot) {
  const requiredSlots = Math.max(...patternSlots) + 1;
  if (window.inventoryStart < requiredSlots) {
    throw new Error("container too small for pattern, storage slots=" + String(window.inventoryStart));
  }

  const sourceSlot = findWindowItemSlot(window, itemName, window.inventoryStart, window.inventoryEnd);
  if (sourceSlot < 0) {
    throw new Error("item not found in inventory window: " + itemName);
  }

  await bot.clickWindow(sourceSlot, 0, 0);
  for (const slot of patternSlots) {
    await bot.clickWindow(slot, 1, 0);
  }

  if (window.selectedItem) {
    const targetSlot = remainderSlot >= 0 ? remainderSlot : sourceSlot;
    await bot.clickWindow(targetSlot, 0, 0);
  }
}

async function depositContainerItem(window, bot, itemName, count) {
  const normalized = registryItemName(itemName);
  const registryItem = bot.registry.itemsByName[normalized];
  if (!registryItem) {
    throw new Error("unknown item: " + itemName);
  }
  await window.deposit(registryItem.id, null, count);
}

async function withdrawContainerItem(window, bot, itemName, count) {
  const normalized = registryItemName(itemName);
  const registryItem = bot.registry.itemsByName[normalized];
  if (!registryItem) {
    throw new Error("unknown item: " + itemName);
  }
  await window.withdraw(registryItem.id, null, count);
}

async function waitForInventoryItemCount(bot, itemName, minimumCount, timeoutMs) {
  const startedAt = Date.now();
  while ((Date.now() - startedAt) < timeoutMs) {
    if (countInventoryItem(bot, itemName) >= minimumCount) {
      return true;
    }
    await sleep(200);
  }
  return countInventoryItem(bot, itemName) >= minimumCount;
}

async function waitForFurnaceOutput(furnace, itemName, timeoutMs) {
  const startedAt = Date.now();
  while ((Date.now() - startedAt) < timeoutMs) {
    const output = furnace.outputItem();
    if (output && output.name === itemName && output.count > 0) {
      return output;
    }
    await sleep(250);
  }
  return furnace.outputItem();
}

async function fishUntilCookable(bot, options) {
  const fishingSpot = options.fishingSpot;
  const maxAttempts = Math.max(1, Math.floor(options.maxAttempts || 8));
  const castTimeoutMs = Math.max(3000, Math.floor(options.castTimeoutMs || 30000));
  const rawFishNames = options.rawFishNames || ["cod", "salmon"];
  const previousCounts = {};
  for (const itemName of rawFishNames) {
    previousCounts[itemName] = countInventoryItem(bot, itemName);
  }

  await ensureInventoryItem(bot, options.rodItem || "fishing_rod", 1, {
    allowCommands: options.allowCommands,
    inventoryMode: options.inventoryMode
  });
  await equipItemByName(bot, options.rodItem || "fishing_rod");
  await ensureNear(bot, fishingSpot.x, fishingSpot.y, fishingSpot.z, 1, {
    horizontalOnly: true
  });

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    await bot.lookAt(new Vec3(fishingSpot.lookX, fishingSpot.lookY, fishingSpot.lookZ), true);
    try {
      await Promise.race([
        bot.fish(),
        sleep(castTimeoutMs).then(() => {
          try {
            bot.activateItem();
          } catch (error) {
          }
          throw new Error("fishing cast timeout");
        })
      ]);
    } catch (error) {
      await sleep(500);
      continue;
    }
    await sleep(1500);

    for (const itemName of rawFishNames) {
      const current = countInventoryItem(bot, itemName);
      if (current > previousCounts[itemName]) {
        return {
          caughtItem: itemName,
          count: current - previousCounts[itemName],
          totals: Object.fromEntries(rawFishNames.map((name) => [name, countInventoryItem(bot, name)])),
          attempts: attempt + 1
        };
      }
    }
  }

  return {
    caughtItem: "",
    count: 0,
    totals: Object.fromEntries(rawFishNames.map((name) => [name, countInventoryItem(bot, name)])),
    attempts: maxAttempts
  };
}

function normalizeCommandName(command) {
  return String(command || "")
    .trim()
    .toLowerCase()
    .replace(/[\/\s-]+/g, "_");
}

function extractCommandArgs(body) {
  if (body && body.args && typeof body.args === "object" && !Array.isArray(body.args)) {
    return body.args;
  }

  const args = {
    ...(body || {})
  };
  delete args.args;
  delete args.command;
  delete args.op;
  delete args.action;
  delete args.label;
  delete args.steps;
  delete args.continueOnError;
  delete args.remember;
  delete args.saveAs;
  return args;
}

function resolvePathValue(source, rawPath) {
  const pathText = String(rawPath || "").replace(/\[(\d+)\]/g, ".$1");
  const segments = pathText.split(".").filter(Boolean);
  let current = source;

  for (const segment of segments) {
    if (current === null || typeof current === "undefined") {
      return undefined;
    }
    current = current[segment];
  }

  return current;
}

function resolveWorkflowValue(value, scope) {
  if (typeof value === "string" && value.startsWith("$")) {
    return resolvePathValue(scope, value.slice(1));
  }

  if (Array.isArray(value)) {
    return value.map((entry) => resolveWorkflowValue(entry, scope));
  }

  if (value && typeof value === "object") {
    const result = {};
    for (const [key, entry] of Object.entries(value)) {
      result[key] = resolveWorkflowValue(entry, scope);
    }
    return result;
  }

  return value;
}

function buildWorkflowScope(label) {
  return {
    label,
    named: {},
    last: null,
    results: [],
    memory: worldMemory.snapshot().memory,
    status: getStatusPayload()
  };
}

function getInventoryOptions(body) {
  return {
    allowCommands: !body || body.allowCommands !== false,
    inventoryMode: body && typeof body.inventoryMode === "string" ? body.inventoryMode : ""
  };
}

function cookedVariantForRaw(itemName) {
  const normalized = registryItemName(itemName);
  if (normalized === "cod") {
    return "cooked_cod";
  }
  if (normalized === "salmon") {
    return "cooked_salmon";
  }
  return "";
}

async function moveToDirect(body) {
  const bot = requireBot();
  const x = numberValue(body, "x");
  const y = numberValue(body, "y");
  const z = numberValue(body, "z");
  const range = numberValue(body, "range", 1);

  await ensureNear(bot, x, y, z, range);
  updateMemorySnapshot();
  return {
    ok: true,
    x,
    y,
    z,
    range
  };
}

async function waitCommand(body) {
  const milliseconds = "milliseconds" in body
    ? numberValue(body, "milliseconds", 0)
    : ("ms" in body ? numberValue(body, "ms", 0) : Math.floor(numberValue(body, "seconds", 0) * 1000));
  const waitedMs = Math.max(0, Math.floor(milliseconds));
  await sleep(waitedMs);
  return {
    ok: true,
    waitedMs
  };
}

async function digBlock(body) {
  const bot = requireBot();
  const x = Math.floor(numberValue(body, "x"));
  const y = Math.floor(numberValue(body, "y"));
  const z = Math.floor(numberValue(body, "z"));
  const range = numberValue(body, "range", 4);
  const delayMs = numberValue(body, "delayMs", 150);
  const block = bot.blockAt(new Vec3(x, y, z));

  if (!block || isAir(block)) {
    return {
      ok: true,
      dug: false,
      skipped: true,
      block: getBlockPayload(x, y, z).block
    };
  }

  await ensureNear(bot, x, y, z, range, {
    horizontalOnly: true
  });
  await bot.dig(block, true);
  await sleep(delayMs);
  const payload = getBlockPayload(x, y, z);
  worldMemory.rememberBlock(payload.block, "dig");
  return {
    ok: true,
    dug: true,
    block: payload.block
  };
}

async function clearBlockCommand(body) {
  const bot = requireBot();
  const x = Math.floor(numberValue(body, "x"));
  const y = Math.floor(numberValue(body, "y"));
  const z = Math.floor(numberValue(body, "z"));
  const range = numberValue(body, "range", 4);
  const delayMs = numberValue(body, "delayMs", 150);
  const result = await clearBlockIfNeeded(bot, x, y, z, range, delayMs);
  const payload = getBlockPayload(x, y, z);
  worldMemory.rememberBlock(payload.block, "clear_block");
  return {
    ok: true,
    ...result,
    block: payload.block
  };
}

async function placeWaterCommand(body) {
  const bot = requireBot();
  const x = Math.floor(numberValue(body, "x"));
  const y = Math.floor(numberValue(body, "y"));
  const z = Math.floor(numberValue(body, "z"));
  const range = numberValue(body, "range", 4);
  const delayMs = numberValue(body, "delayMs", 200);
  const itemName = optionalStringValue(body, "item", "water_bucket");
  const result = await placeWaterSourceByHand(bot, itemName, x, y, z, range, delayMs, getInventoryOptions(body));
  const payload = getBlockPayload(x, y, z);
  worldMemory.rememberBlock(payload.block, "place_water");
  return {
    ok: true,
    ...result,
    block: payload.block
  };
}

async function openContainerAt(bot, x, y, z, range) {
  await ensureNear(bot, x, y, z, range, {
    lookAtBlock: true,
    reach: Math.max(4.5, range)
  });
  const block = bot.blockAt(new Vec3(x, y, z));
  if (!block) {
    throw new Error("container block not found at " + blockKey(x, y, z));
  }
  const window = await bot.openContainer(block);
  return {
    block,
    window
  };
}

async function readContainer(body) {
  const bot = requireBot();
  const x = Math.floor(numberValue(body, "x"));
  const y = Math.floor(numberValue(body, "y"));
  const z = Math.floor(numberValue(body, "z"));
  const range = numberValue(body, "range", 4);
  const { block, window } = await openContainerAt(bot, x, y, z, range);
  try {
    const container = containerWindowPayload(window);
    worldMemory.rememberContainer({
      x,
      y,
      z,
      name: block.name,
      title: container.title,
      slots: container.slots,
      source: "read_container"
    });
    return {
      ok: true,
      block: blockPayloadFromBlock(block),
      container
    };
  } finally {
    window.close();
    await sleep(120);
  }
}

async function containerDeposit(body) {
  const bot = requireBot();
  const x = Math.floor(numberValue(body, "x"));
  const y = Math.floor(numberValue(body, "y"));
  const z = Math.floor(numberValue(body, "z"));
  const range = numberValue(body, "range", 4);
  const itemName = stringValue(body, "item");
  const count = Math.max(1, Math.floor(numberValue(body, "count", 1)));
  const { block, window } = await openContainerAt(bot, x, y, z, range);
  try {
    await depositContainerItem(window, bot, itemName, count);
    const container = containerWindowPayload(window);
    worldMemory.rememberContainer({
      x,
      y,
      z,
      name: block.name,
      title: container.title,
      slots: container.slots,
      source: "container_deposit"
    });
    return {
      ok: true,
      item: itemName,
      count,
      block: blockPayloadFromBlock(block),
      container
    };
  } finally {
    window.close();
    await sleep(120);
  }
}

async function containerWithdraw(body) {
  const bot = requireBot();
  const x = Math.floor(numberValue(body, "x"));
  const y = Math.floor(numberValue(body, "y"));
  const z = Math.floor(numberValue(body, "z"));
  const range = numberValue(body, "range", 4);
  const itemName = stringValue(body, "item");
  const count = Math.max(1, Math.floor(numberValue(body, "count", 1)));
  const { block, window } = await openContainerAt(bot, x, y, z, range);
  try {
    await withdrawContainerItem(window, bot, itemName, count);
    const container = containerWindowPayload(window);
    worldMemory.rememberContainer({
      x,
      y,
      z,
      name: block.name,
      title: container.title,
      slots: container.slots,
      source: "container_withdraw"
    });
    return {
      ok: true,
      item: itemName,
      count,
      block: blockPayloadFromBlock(block),
      container
    };
  } finally {
    window.close();
    await sleep(120);
  }
}

async function openFurnaceAt(bot, x, y, z, range) {
  await ensureNear(bot, x, y, z, range, {
    lookAtBlock: true,
    reach: Math.max(4.5, range)
  });
  const block = bot.blockAt(new Vec3(x, y, z));
  if (!block) {
    throw new Error("furnace block not found at " + blockKey(x, y, z));
  }
  const furnace = await bot.openFurnace(block);
  return {
    block,
    furnace
  };
}

async function readFurnace(body) {
  const bot = requireBot();
  const x = Math.floor(numberValue(body, "x"));
  const y = Math.floor(numberValue(body, "y"));
  const z = Math.floor(numberValue(body, "z"));
  const range = numberValue(body, "range", 4);
  const { block, furnace } = await openFurnaceAt(bot, x, y, z, range);
  try {
    const furnaceState = furnaceWindowPayload(furnace);
    worldMemory.rememberFurnace({
      x,
      y,
      z,
      name: block.name,
      ...furnaceState,
      source: "read_furnace"
    });
    return {
      ok: true,
      block: blockPayloadFromBlock(block),
      furnace: furnaceState
    };
  } finally {
    furnace.close();
    await sleep(120);
  }
}

async function smeltItem(body) {
  const bot = requireBot();
  const x = Math.floor(numberValue(body, "x"));
  const y = Math.floor(numberValue(body, "y"));
  const z = Math.floor(numberValue(body, "z"));
  const range = numberValue(body, "range", 4);
  const inputItem = stringValue(body, "inputItem");
  const inputCount = Math.max(1, Math.floor(numberValue(body, "inputCount", 1)));
  const fuelItem = optionalStringValue(body, "fuelItem", "coal");
  const fuelCount = Math.max(1, Math.floor(numberValue(body, "fuelCount", 1)));
  const timeoutMs = Math.max(1000, Math.floor(numberValue(body, "timeoutMs", 45000)));
  const outputItem = optionalStringValue(body, "outputItem", cookedVariantForRaw(inputItem));
  const inventoryOptions = getInventoryOptions(body);

  if (!outputItem) {
    throw new Error("outputItem is required for smelt_item when it cannot be inferred");
  }

  await ensureInventoryItem(bot, inputItem, inputCount, inventoryOptions);
  await ensureInventoryItem(bot, fuelItem, fuelCount, inventoryOptions);

  const { block, furnace } = await openFurnaceAt(bot, x, y, z, range);
  try {
    const inputRegistry = bot.registry.itemsByName[registryItemName(inputItem)];
    const fuelRegistry = bot.registry.itemsByName[registryItemName(fuelItem)];
    if (!inputRegistry || !fuelRegistry) {
      throw new Error("unknown furnace item");
    }

    await furnace.putInput(inputRegistry.id, null, inputCount);
    await furnace.putFuel(fuelRegistry.id, null, fuelCount);
    const output = await waitForFurnaceOutput(furnace, outputItem, timeoutMs);
    if (!output || output.name !== outputItem) {
      throw new Error("furnace did not produce " + outputItem);
    }
    const taken = await furnace.takeOutput();
    const furnaceState = furnaceWindowPayload(furnace);
    worldMemory.rememberFurnace({
      x,
      y,
      z,
      name: block.name,
      ...furnaceState,
      source: "smelt_item"
    });
    return {
      ok: true,
      block: blockPayloadFromBlock(block),
      taken: itemPayload(taken),
      furnace: furnaceState
    };
  } finally {
    furnace.close();
    await sleep(120);
  }
}

async function consumeItem(body) {
  const bot = requireBot();
  const itemName = optionalStringValue(body, "item", "");
  const inventoryOptions = getInventoryOptions(body);
  if (itemName) {
    await ensureInventoryItem(bot, itemName, 1, inventoryOptions);
    await equipItemByName(bot, itemName);
  }
  await bot.consume();
  updateMemorySnapshot();
  return {
    ok: true,
    item: itemName || (bot.heldItem ? bot.heldItem.name : "")
  };
}

async function fishUntilCommand(body) {
  const bot = requireBot();
  const x = "x" in body ? numberValue(body, "x") : bot.entity.position.x;
  const y = "y" in body ? numberValue(body, "y") : bot.entity.position.y;
  const z = "z" in body ? numberValue(body, "z") : bot.entity.position.z;
  const rawFishNames = Array.isArray(body.rawFishNames) && body.rawFishNames.length > 0
    ? body.rawFishNames.map((entry) => registryItemName(entry))
    : ["cod", "salmon"];
  const fishingSpot = {
    x,
    y,
    z,
    lookX: "lookX" in body ? numberValue(body, "lookX") : x,
    lookY: "lookY" in body ? numberValue(body, "lookY") : y,
    lookZ: "lookZ" in body ? numberValue(body, "lookZ") : z
  };
  const result = await fishUntilCookable(bot, {
    fishingSpot,
    maxAttempts: Math.max(1, Math.floor(numberValue(body, "fishAttempts", 8))),
    castTimeoutMs: Math.max(3000, Math.floor(numberValue(body, "timeoutMs", 30000))),
    rawFishNames,
    rodItem: optionalStringValue(body, "rodItem", "fishing_rod"),
    allowCommands: body.allowCommands !== false,
    inventoryMode: typeof body.inventoryMode === "string" ? body.inventoryMode : ""
  });
  worldMemory.addObservation("fish_until", result);
  return {
    ok: true,
    fishingSpot,
    ...result
  };
}

async function executeDirectCommand(command, rawArgs, context) {
  const normalized = normalizeCommandName(command);
  const args = resolveWorkflowValue(rawArgs || {}, context && context.scope ? context.scope : {});

  switch (normalized) {
    case "status":
    case "read_status":
      if (!isModClientDriver()) {
        updateMemorySnapshot();
      }
      return readStatusPayload();
    case "full_state":
    case "read_full_state":
      if (!isModClientDriver()) {
        updateMemorySnapshot();
      }
      return readFullStatePayload();
    case "inventory":
    case "read_inventory":
      return readInventoryPayload();
    case "players":
    case "read_players":
      {
        const payload = await readPlayersPayload();
        worldMemory.setPlayers(payload);
        return payload;
      }
    case "block":
    case "read_block": {
      const payload = await readBlockPayload(
        Math.floor(numberValue(args, "x")),
        Math.floor(numberValue(args, "y")),
        Math.floor(numberValue(args, "z"))
      );
      worldMemory.rememberBlock(payload.block, "read_block");
      return payload;
    }
    case "target":
    case "read_target": {
      const payload = await readTargetPayload(numberValue(args, "maxDistance", 6));
      worldMemory.addObservation("target", payload.target);
      return payload;
    }
    case "screen":
    case "read_screen":
      return readScreenCommand(args);
    case "memory":
    case "read_memory":
      return worldMemory.snapshot();
    case "chat":
      return sendChat(args);
    case "hotbar":
      return setHotbar(args);
    case "equip":
      return equipItem(args);
    case "move_to":
      return moveToDirect(args);
    case "look_at": {
      const result = await lookAt(args);
      worldMemory.addObservation("look_at", result.lookedAt);
      return result;
    }
    case "use_item":
      return useItem(args);
    case "interact_block":
      return interactBlockCommand(args);
    case "set_input":
      return setInputCommand(args);
    case "tap_key":
      return tapKeyCommand(args);
    case "release_all":
      return releaseAllCommand(args);
    case "gui_click":
      return guiClickCommand(args);
    case "gui_release":
      return guiReleaseCommand(args);
    case "gui_scroll":
      return guiScrollCommand(args);
    case "gui_key":
      return guiKeyCommand(args);
    case "gui_type":
      return guiTypeCommand(args);
    case "gui_click_widget":
      return guiClickWidgetCommand(args);
    case "gui_close":
      return guiCloseCommand(args);
    case "screenshot":
      return screenshotCommand(args);
    case "debug_fake_player":
    case "debug_fake_player_list":
      return debugFakePlayerListCommand(args);
    case "debug_fake_player_spawn":
      return debugFakePlayerSpawnCommand(args);
    case "debug_fake_player_move":
      return debugFakePlayerMoveCommand(args);
    case "debug_fake_player_remove":
      return debugFakePlayerRemoveCommand(args);
    case "place": {
      const result = await placeItem(args);
      if ("x" in args && "y" in args && "z" in args) {
        const payload = getBlockPayload(Math.floor(Number(args.x)), Math.floor(Number(args.y)), Math.floor(Number(args.z)));
        worldMemory.rememberBlock(payload.block, "place");
      }
      return result;
    }
    case "place_water":
      return placeWaterCommand(args);
    case "dig":
      return digBlock(args);
    case "clear_block":
      return clearBlockCommand(args);
    case "read_container":
      return readContainerCommand(args);
    case "container_deposit":
      return containerDeposit(args);
    case "container_withdraw":
      return containerWithdraw(args);
    case "read_furnace":
      return readFurnace(args);
    case "smelt_item":
      return smeltItem(args);
    case "consume":
      return consumeItem(args);
    case "fish_until":
      return fishUntilCommand(args);
    case "wait":
      return waitCommand(args);
    case "memory_note": {
      const note = worldMemory.addNote(stringValue(args, "text"), optionalStringValue(args, "tag", "note"), args.extra);
      return {
        ok: true,
        note
      };
    }
    case "memory_waypoint": {
      const name = stringValue(args, "name");
      const waypoint = worldMemory.setWaypoint(name, {
        position: {
          x: numberValue(args, "x"),
          y: numberValue(args, "y"),
          z: numberValue(args, "z")
        },
        note: optionalStringValue(args, "note", ""),
        dimension: optionalStringValue(args, "dimension", "")
      });
      return {
        ok: true,
        waypoint
      };
    }
    case "memory_context": {
      let patch = {};
      if (args.patch && typeof args.patch === "object" && !Array.isArray(args.patch)) {
        patch = args.patch;
      } else if ("key" in args) {
        patch[stringValue(args, "key")] = args.value;
      } else {
        patch = extractCommandArgs(args);
      }
      return {
        ok: true,
        context: worldMemory.updateContext(patch)
      };
    }
    default:
      throw new Error("unsupported direct command: " + normalized);
  }
}

async function runDirectControl(body) {
  const rawCommand = body && (body.command || body.op || body.action);
  if (typeof rawCommand !== "string" || rawCommand.length === 0) {
    throw new Error("command is required");
  }

  const scope = buildWorkflowScope("direct_control");
  const result = await executeDirectCommand(rawCommand, extractCommandArgs(body), {
    scope
  });
  return {
    ok: true,
    command: normalizeCommandName(rawCommand),
    result
  };
}

async function runWorkflow(body) {
  const steps = Array.isArray(body.steps) ? body.steps : [];
  if (steps.length === 0) {
    throw new Error("steps must be a non-empty array");
  }

  const label = optionalStringValue(body, "label", "workflow");
  const continueOnError = boolValue(body, "continueOnError", false);

  return actionManager.run(label, async (manager) => {
    const scope = buildWorkflowScope(label);
    const results = [];
    worldMemory.addNote("workflow started", "workflow", {
      label,
      stepCount: steps.length
    });

    for (let index = 0; index < steps.length; index += 1) {
      if (manager.isCancelled()) {
        throw new Error("action cancelled");
      }

      const step = steps[index];
      if (!step || typeof step !== "object" || Array.isArray(step)) {
        throw new Error("invalid workflow step at index " + String(index));
      }

      const rawCommand = step.command || step.op || step.action;
      if (typeof rawCommand !== "string" || rawCommand.length === 0) {
        throw new Error("workflow step command is required at index " + String(index));
      }

      const resolvedArgs = resolveWorkflowValue(extractCommandArgs(step), scope);
      const normalized = normalizeCommandName(rawCommand);
      manager.setProgress("step " + String(index + 1) + "/" + String(steps.length) + ": " + normalized, {
        action: "workflow",
        label,
        step: index + 1,
        totalSteps: steps.length,
        command: normalized
      });

      try {
        const result = await executeDirectCommand(normalized, resolvedArgs, {
          scope
        });
        const entry = {
          index: index + 1,
          command: normalized,
          ok: true,
          result
        };
        results.push(entry);
        scope.last = result;
        scope.results.push(entry);
        if (typeof step.saveAs === "string" && step.saveAs.length > 0) {
          scope.named[step.saveAs] = result;
        }
      } catch (error) {
        const message = error && error.message ? error.message : String(error);
        const entry = {
          index: index + 1,
          command: normalized,
          ok: false,
          error: message
        };
        results.push(entry);
        scope.last = entry;
        scope.results.push(entry);
        if (!continueOnError) {
          throw new Error("workflow step " + String(index + 1) + " failed: " + message);
        }
      }

      scope.memory = worldMemory.snapshot().memory;
      scope.status = getStatusPayload();
    }

    const okCount = results.filter((entry) => entry.ok).length;
    const failureCount = results.length - okCount;
    worldMemory.addNote("workflow finished", "workflow", {
      label,
      okCount,
      failureCount
    });

    return {
      ok: failureCount === 0,
      label,
      stepCount: steps.length,
      okCount,
      failureCount,
      results,
      named: scope.named
    };
  });
}

function resolveAgentSessionId(body, fallbackRequired = true) {
  const sessionId = body && typeof body.id === "string" && body.id.length > 0
    ? body.id
    : "";
  if (sessionId) {
    return sessionId;
  }

  const current = agentRuntime.snapshot().currentSessionId || "";
  if (current) {
    return current;
  }

  if (fallbackRequired) {
    throw new Error("agent session id is required");
  }
  return "";
}

function getAgentContextBundle(sessionId) {
  updateMemorySnapshot();
  return {
    capabilities: getCapabilitiesPayload(),
    world: getFullStatePayload(),
    memory: worldMemory.snapshot(),
    agent: agentRuntime.snapshot(sessionId || undefined)
  };
}

async function agentStart(body) {
  const session = agentRuntime.createSession({
    id: optionalStringValue(body, "id", ""),
    label: optionalStringValue(body, "label", "agent-session"),
    goal: optionalStringValue(body, "goal", ""),
    mode: optionalStringValue(body, "mode", "llm_bridge"),
    autoExecute: boolValue(body, "autoExecute", false),
    systemPrompt: optionalStringValue(body, "systemPrompt", ""),
    metadata: body && body.metadata && typeof body.metadata === "object" && !Array.isArray(body.metadata)
      ? body.metadata
      : {}
  });

  if (body && typeof body.message === "string" && body.message.length > 0) {
    agentRuntime.addMessage(session.id, {
      role: "user",
      source: "operator",
      content: body.message
    });
  }

  worldMemory.addNote("agent session started", "agent", {
    id: session.id,
    label: session.label,
    goal: session.goal
  });

  return {
    ok: true,
    session: agentRuntime.snapshot(session.id).session
  };
}

async function agentMessage(body) {
  const id = resolveAgentSessionId(body);
  const message = agentRuntime.addMessage(id, {
    role: optionalStringValue(body, "role", "user"),
    source: optionalStringValue(body, "source", "operator"),
    content: stringValue(body, "content")
  });
  return {
    ok: true,
    session: agentRuntime.snapshot(id).session,
    message
  };
}

async function agentPlan(body) {
  const id = resolveAgentSessionId(body);
  const mode = optionalStringValue(body, "mode", "replace");
  const steps = Array.isArray(body.steps) ? body.steps : [];
  if (mode === "append") {
    agentRuntime.appendPlan(id, steps);
  } else if (mode === "clear") {
    agentRuntime.clearPlan(id);
  } else {
    agentRuntime.setPlan(id, steps, {
      clearResults: boolValue(body, "clearResults", true)
    });
  }

  if (body && typeof body.note === "string" && body.note.length > 0) {
    agentRuntime.addMessage(id, {
      role: "system",
      source: "planner",
      content: body.note
    });
  }

  return {
    ok: true,
    session: agentRuntime.snapshot(id).session
  };
}

async function agentPrompt(body) {
  const id = resolveAgentSessionId(body);
  return agentRuntime.buildPromptPayload(id, getAgentContextBundle(id));
}

async function agentAutoplan(body) {
  const id = resolveAgentSessionId(body);
  if (body && typeof body.message === "string" && body.message.length > 0) {
    agentRuntime.addMessage(id, {
      role: "user",
      source: "operator",
      content: body.message
    });
  }
  const result = await agentRuntime.requestPlan(id, getAgentContextBundle(id));
  worldMemory.addNote("agent llm planned workflow", "agent", {
    id,
    stepCount: result.session.plan.length
  });
  return result;
}

async function agentRun(body) {
  const id = resolveAgentSessionId(body);
  const session = agentRuntime.requireSession(id);
  if (!Array.isArray(session.plan) || session.plan.length === 0) {
    throw new Error("agent session plan is empty");
  }

  if (boolValue(body, "resetResults", true)) {
    agentRuntime.clearResults(id);
  }

  agentRuntime.markRunning(id);
  worldMemory.addNote("agent run started", "agent", {
    id,
    label: session.label,
    stepCount: session.plan.length
  });

  try {
    const workflow = await runWorkflow({
      label: "agent:" + session.label,
      steps: session.plan,
      continueOnError: boolValue(body, "continueOnError", false)
    });
    agentRuntime.appendResults(id, workflow.results || []);
    if (workflow.ok) {
      agentRuntime.markCompleted(id);
    } else {
      agentRuntime.markFailed(id, "workflow completed with failures");
    }
    return {
      ok: workflow.ok,
      session: agentRuntime.snapshot(id).session,
      workflow
    };
  } catch (error) {
    agentRuntime.markFailed(id, error && error.message ? error.message : String(error));
    throw error;
  }
}

async function agentStep(body) {
  const id = resolveAgentSessionId(body);
  const session = agentRuntime.requireSession(id);
  let command = optionalStringValue(body, "command", "");
  let rawArgs = body && body.args && typeof body.args === "object" && !Array.isArray(body.args) ? body.args : {};
  let index = -1;

  if (!command) {
    index = Array.isArray(session.results) ? session.results.length : 0;
    if (!Array.isArray(session.plan) || index >= session.plan.length) {
      throw new Error("no remaining agent step");
    }
    const step = session.plan[index];
    command = step.command || step.op || step.action;
    rawArgs = extractCommandArgs(step);
  }

  agentRuntime.markRunning(id);
  try {
    const scope = buildWorkflowScope("agent_step");
    scope.named.session = session;
    const result = await executeDirectCommand(command, rawArgs, {
      scope
    });
    const entry = {
      index: index >= 0 ? index + 1 : (Array.isArray(session.results) ? session.results.length + 1 : 1),
      command: normalizeCommandName(command),
      ok: true,
      result
    };
    agentRuntime.appendResults(id, [entry]);
    agentRuntime.markIdle(id);
    return {
      ok: true,
      session: agentRuntime.snapshot(id).session,
      step: entry
    };
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    agentRuntime.appendResults(id, [{
      index: index >= 0 ? index + 1 : (Array.isArray(session.results) ? session.results.length + 1 : 1),
      command: normalizeCommandName(command),
      ok: false,
      error: message
    }]);
    agentRuntime.markFailed(id, message);
    throw error;
  }
}

async function agentStop(body) {
  const id = resolveAgentSessionId(body);
  agentRuntime.markStopped(id);
  actionManager.cancel();
  return {
    ok: true,
    session: agentRuntime.snapshot(id).session
  };
}

async function handleRealtimeMessage(client, message) {
  const type = normalizeCommandName(message && message.type ? message.type : "");

  switch (type) {
    case "command":
      return runDirectControl({
        command: message.command,
        args: message.args
      });
    case "workflow":
      return runWorkflow({
        label: message.label,
        steps: Array.isArray(message.steps) ? message.steps : [],
        continueOnError: Boolean(message.continueOnError)
      });
    case "agent": {
      const op = normalizeCommandName(message.op || message.command || "");
      const args = message.args && typeof message.args === "object" && !Array.isArray(message.args)
        ? message.args
        : {};
      switch (op) {
        case "start":
          return agentStart(args);
        case "status":
          return agentRuntime.snapshot(args.id || undefined);
        case "message":
          return agentMessage(args);
        case "plan":
          return agentPlan(args);
        case "prompt":
          return agentPrompt(args);
        case "autoplan":
          return agentAutoplan(args);
        case "run":
          return agentRun(args);
        case "step":
          return agentStep(args);
        case "stop":
          return agentStop(args);
        default:
          throw new Error("unsupported realtime agent op: " + op);
      }
    }
    case "read_status":
    case "status":
      return readStatusPayload();
    default:
      throw new Error("unsupported realtime message type: " + type);
  }
}

async function setInputCommand(body) {
  if (!isModClientDriver()) {
    throw new Error("set_input requires mod_client backend");
  }

  const payload = await requireModClient().input({
    keys: body && body.keys && typeof body.keys === "object" && !Array.isArray(body.keys) ? body.keys : undefined,
    clearMovement: boolValue(body || {}, "clearMovement", false),
    yaw: "yaw" in body ? numberValue(body, "yaw") : undefined,
    pitch: "pitch" in body ? numberValue(body, "pitch") : undefined,
    deltaYaw: "deltaYaw" in body ? numberValue(body, "deltaYaw") : undefined,
    deltaPitch: "deltaPitch" in body ? numberValue(body, "deltaPitch") : undefined,
    hotbar: "hotbar" in body ? Math.floor(numberValue(body, "hotbar")) : undefined
  });
  state.lastError = "";
  if (payload && typeof payload === "object" && payload.selectedHotbarSlot && state.modCache.status) {
    state.modCache.status.selectedHotbarSlot = payload.selectedHotbarSlot;
  }
  return {
    ok: true,
    input: payload
  };
}

async function tapKeyCommand(body) {
  if (!isModClientDriver()) {
    throw new Error("tap_key requires mod_client backend");
  }

  const key = stringValue(body, "key");
  const durationMs = Math.max(10, Math.floor(numberValue(body, "durationMs", 120)));
  const payload = await requireModClient().tap(key, durationMs);
  state.lastError = "";
  return {
    ok: true,
    key,
    durationMs,
    payload
  };
}

async function releaseAllCommand() {
  if (!isModClientDriver()) {
    throw new Error("release_all requires mod_client backend");
  }

  const payload = await requireModClient().releaseAll();
  state.lastError = "";
  return {
    ok: true,
    payload
  };
}

async function interactBlockCommand(body) {
  if (!isModClientDriver()) {
    throw new Error("interact_block requires mod_client backend");
  }

  const payload = {
    x: Math.floor(numberValue(body, "x")),
    y: Math.floor(numberValue(body, "y")),
    z: Math.floor(numberValue(body, "z")),
    face: optionalStringValue(body, "face", "up"),
    hand: optionalStringValue(body, "hand", "main")
  };

  if ("hitX" in body) {
    payload.hitX = numberValue(body, "hitX");
  }
  if ("hitY" in body) {
    payload.hitY = numberValue(body, "hitY");
  }
  if ("hitZ" in body) {
    payload.hitZ = numberValue(body, "hitZ");
  }
  if ("insideBlock" in body) {
    payload.insideBlock = boolValue(body, "insideBlock", false);
  }

  const result = await requireModClient().interactBlock(payload);
  state.lastError = "";
  return {
    ok: true,
    interaction: result
  };
}

async function readContainerCommand(body) {
  if (!isModClientDriver()) {
    return readContainer(body);
  }

  let position = null;
  if ("x" in body && "y" in body && "z" in body) {
    position = {
      x: Math.floor(numberValue(body, "x")),
      y: Math.floor(numberValue(body, "y")),
      z: Math.floor(numberValue(body, "z"))
    };
    await interactBlockCommand({
      ...body,
      ...position,
      face: optionalStringValue(body, "face", "up"),
      hand: optionalStringValue(body, "hand", "main")
    });
    await sleep(Math.max(60, Math.floor(numberValue(body, "openDelayMs", 150))));
  }

  const payload = await readContainerPayload();
  rememberModContainerObservation(payload, position, "read_container");
  return {
    ok: true,
    block: position,
    container: payload
  };
}

async function readScreenCommand() {
  return readScreenPayload();
}

async function screenshotCommand(body) {
  if (!isModClientDriver()) {
    throw new Error("screenshot requires mod_client backend");
  }

  const payload = await requireModClient().screenshot(optionalStringValue(body, "name", ""));
  state.lastError = "";
  return payload;
}

async function guiClickCommand(body) {
  if (!isModClientDriver()) {
    throw new Error("gui_click requires mod_client backend");
  }

  return requireModClient().guiClick({
    x: numberValue(body, "x"),
    y: numberValue(body, "y"),
    button: Math.floor(numberValue(body, "button", 0)),
    doubleClick: boolValue(body, "doubleClick", false)
  });
}

async function guiReleaseCommand(body) {
  if (!isModClientDriver()) {
    throw new Error("gui_release requires mod_client backend");
  }

  return requireModClient().guiRelease({
    x: numberValue(body, "x"),
    y: numberValue(body, "y"),
    button: Math.floor(numberValue(body, "button", 0))
  });
}

async function guiScrollCommand(body) {
  if (!isModClientDriver()) {
    throw new Error("gui_scroll requires mod_client backend");
  }

  return requireModClient().guiScroll({
    x: numberValue(body, "x"),
    y: numberValue(body, "y"),
    deltaX: numberValue(body, "deltaX", 0),
    deltaY: numberValue(body, "deltaY", 0)
  });
}

async function guiKeyCommand(body) {
  if (!isModClientDriver()) {
    throw new Error("gui_key requires mod_client backend");
  }

  return requireModClient().guiKey({
    key: Math.floor(numberValue(body, "key")),
    scancode: Math.floor(numberValue(body, "scancode", 0)),
    modifiers: Math.floor(numberValue(body, "modifiers", 0))
  });
}

async function guiTypeCommand(body) {
  if (!isModClientDriver()) {
    throw new Error("gui_type requires mod_client backend");
  }
  return requireModClient().guiType(stringValue(body, "text"));
}

async function guiClickWidgetCommand(body) {
  if (!isModClientDriver()) {
    throw new Error("gui_click_widget requires mod_client backend");
  }

  return requireModClient().guiClickWidget({
    index: Math.floor(numberValue(body, "index")),
    button: Math.floor(numberValue(body, "button", 0))
  });
}

async function guiCloseCommand() {
  if (!isModClientDriver()) {
    throw new Error("gui_close requires mod_client backend");
  }
  return requireModClient().guiClose();
}

async function debugFakePlayerListCommand() {
  return readFakePlayersPayload();
}

async function debugFakePlayerSpawnCommand(body) {
  if (!isModClientDriver()) {
    throw new Error("debug_fake_player_spawn requires mod_client backend");
  }
  return requireModClient().spawnFakePlayer(body);
}

async function debugFakePlayerMoveCommand(body) {
  if (!isModClientDriver()) {
    throw new Error("debug_fake_player_move requires mod_client backend");
  }
  return requireModClient().moveFakePlayer(body);
}

async function debugFakePlayerRemoveCommand(body) {
  if (!isModClientDriver()) {
    throw new Error("debug_fake_player_remove requires mod_client backend");
  }
  return requireModClient().removeFakePlayer(stringValue(body, "name"));
}

async function moveTo(body) {
  return actionManager.run("move_to", async () => {
    return moveToDirect(body);
  });
}

async function lookAt(body) {
  const x = numberValue(body, "x");
  const y = numberValue(body, "y");
  const z = numberValue(body, "z");

  if (isModClientDriver()) {
    const status = await readStatusPayload();
    if (!status.inWorld) {
      throw new Error("look_at requires the mod-client to be in a world");
    }
    const angles = calculateLookAngles(status, { x, y, z });
    const payload = await requireModClient().look({
      yaw: angles.yaw,
      pitch: angles.pitch
    });
    state.lastError = "";
    if (state.modCache.status && typeof state.modCache.status === "object") {
      state.modCache.status.yaw = angles.yaw;
      state.modCache.status.pitch = angles.pitch;
    }
    return {
      ok: true,
      lookedAt: { x, y, z },
      yaw: angles.yaw,
      pitch: angles.pitch,
      payload
    };
  }

  const bot = requireBot();
  const force = boolValue(body, "force", true);

  await bot.lookAt(new Vec3(x, y, z), force);
  return {
    ok: true,
    lookedAt: { x, y, z }
  };
}

async function useItem(body) {
  if (isModClientDriver()) {
    if ("x" in body && "y" in body && "z" in body) {
      const interaction = await interactBlockCommand(body);
      return {
        ok: true,
        target: {
          x: Math.floor(numberValue(body, "x")),
          y: Math.floor(numberValue(body, "y")),
          z: Math.floor(numberValue(body, "z"))
        },
        interaction: interaction.interaction
      };
    }
    const payload = await requireModClient().interactItem(optionalStringValue(body, "hand", "main"));
    state.lastError = "";
    return {
      ok: true,
      activatedItem: true,
      payload
    };
  }

  const bot = requireBot();
  if ("x" in body && "y" in body && "z" in body) {
    const x = numberValue(body, "x");
    const y = numberValue(body, "y");
    const z = numberValue(body, "z");
    const block = bot.blockAt(new Vec3(x, y, z));
    if (!block) {
      throw new Error("target block not found");
    }
    await ensureNear(bot, x, y, z, numberValue(body, "range", 4));
    await bot.lookAt(new Vec3(x + 0.5, y + 0.5, z + 0.5), true);
    await bot.activateBlock(block);
    return {
      ok: true,
      target: {
        x,
        y,
        z,
        name: block.name
      }
    };
  }

  await bot.activateItem();
  return {
    ok: true,
    activatedItem: true
  };
}

async function placeItem(body) {
  const bot = requireBot();
  const itemName = stringValue(body, "item");
  const x = numberValue(body, "x");
  const y = numberValue(body, "y");
  const z = numberValue(body, "z");
  const range = numberValue(body, "range", 4);
  const placeDelayMs = numberValue(body, "placeDelayMs", 150);
  const replace = boolValue(body, "replace", false);
  let preferredSupport = null;
  const placeOptions = {};

  if ("supportX" in body && "supportY" in body && "supportZ" in body && "faceX" in body && "faceY" in body && "faceZ" in body) {
    preferredSupport = {
      position: new Vec3(
        Math.floor(numberValue(body, "supportX")),
        Math.floor(numberValue(body, "supportY")),
        Math.floor(numberValue(body, "supportZ"))
      ),
      face: new Vec3(
        Math.floor(numberValue(body, "faceX")),
        Math.floor(numberValue(body, "faceY")),
        Math.floor(numberValue(body, "faceZ"))
      )
    };
  }

  if ("deltaX" in body && "deltaY" in body && "deltaZ" in body) {
    placeOptions.delta = new Vec3(
      numberValue(body, "deltaX"),
      numberValue(body, "deltaY"),
      numberValue(body, "deltaZ")
    );
  }

  if ("half" in body) {
    const half = String(body.half || "").toLowerCase();
    if (half === "top" || half === "bottom") {
      placeOptions.half = half;
    }
  }

  if ("forceLook" in body) {
    placeOptions.forceLook = boolValue(body, "forceLook", true);
  }

  const result = await placeBlockByHand(bot, { x, y, z, item: itemName }, {
    range,
    placeDelayMs,
    replace,
    preferredSupport,
    placeOptions
  });

  return {
    ok: true,
    placed: result.finalBlock
  };
}

async function placeBlocks(body) {
  return actionManager.run("place_blocks", async (manager) => {
    const bot = requireBot();
    const placements = sortPlacements(parseBlockPlacements(body));
    const range = numberValue(body, "range", 4);
    const placeDelayMs = numberValue(body, "placeDelayMs", 150);
    const replace = boolValue(body, "replace", false);
    const continueOnError = boolValue(body, "continueOnError", false);
    const results = [];

    for (const placement of placements) {
      if (manager.isCancelled()) {
        throw new Error("action cancelled");
      }

      try {
        const result = await placeBlockByHand(bot, placement, {
          range,
          placeDelayMs,
          replace
        });
        results.push({
          ...result,
          success: true
        });
      } catch (error) {
        const failure = {
          x: placement.x,
          y: placement.y,
          z: placement.z,
          item: placement.item,
          success: false,
          error: error && error.message ? error.message : String(error)
        };
        results.push(failure);
        if (!continueOnError) {
          return {
            ok: false,
            action: "place_blocks",
            placedCount: results.filter((entry) => entry.success).length,
            results
          };
        }
      }
    }

    return {
      ok: true,
      action: "place_blocks",
      placedCount: results.filter((entry) => entry.success).length,
      results
    };
  });
}

function parsePositions(body) {
  if (!Array.isArray(body.positions) || body.positions.length === 0) {
    throw new Error("positions must be a non-empty array");
  }
  return body.positions.map((entry) => ({
    x: Number(entry.x),
    y: Number(entry.y),
    z: Number(entry.z)
  })).map((entry) => {
    if (!Number.isFinite(entry.x) || !Number.isFinite(entry.y) || !Number.isFinite(entry.z)) {
      throw new Error("invalid position entry");
    }
    return entry;
  });
}

async function plantAndBonemeal(body) {
  return actionManager.run("plant_and_bonemeal", async (manager) => {
    const bot = requireBot();
    const positions = parsePositions(body);
    const sapling = stringValue(body, "sapling", "oak_sapling");
    const bonemeal = stringValue(body, "bonemeal", "bone_meal");
    const successBlock = stringValue(body, "successBlock", "oak_log");
    const triesPerPosition = numberValue(body, "triesPerPosition", 16);
    const useDelayMs = numberValue(body, "useDelayMs", 250);
    const range = numberValue(body, "range", 4);

    const results = [];

    for (const position of positions) {
      if (manager.isCancelled()) {
        throw new Error("action cancelled");
      }

      await ensureNear(bot, position.x, position.y, position.z, range);

      const result = {
        x: position.x,
        y: position.y,
        z: position.z,
        planted: false,
        bonemealUses: 0,
        success: false,
        finalBlock: ""
      };

      let block = bot.blockAt(new Vec3(position.x, position.y, position.z));
      if (block && block.name === successBlock) {
        result.success = true;
        result.finalBlock = block.name;
        results.push(result);
        continue;
      }

      if (isAir(block)) {
        await equipItemByName(bot, sapling);
        const support = bot.blockAt(new Vec3(position.x, position.y - 1, position.z));
        if (!support || isAir(support)) {
          throw new Error("support block missing at " + position.x + "," + (position.y - 1) + "," + position.z);
        }
        await bot.lookAt(new Vec3(position.x + 0.5, position.y + 0.5, position.z + 0.5), true);
        await bot.placeBlock(support, new Vec3(0, 1, 0));
        await sleep(200);
        result.planted = true;
        block = bot.blockAt(new Vec3(position.x, position.y, position.z));
      }

      for (let attempt = 0; attempt < triesPerPosition; attempt += 1) {
        if (manager.isCancelled()) {
          throw new Error("action cancelled");
        }

        block = bot.blockAt(new Vec3(position.x, position.y, position.z));
        if (block && (block.name === successBlock || block.name.endsWith("_log"))) {
          result.success = true;
          result.finalBlock = block.name;
          break;
        }

        if (!block || block.name !== sapling) {
          result.finalBlock = block ? block.name : "";
          break;
        }

        await equipItemByName(bot, bonemeal);
        await bot.lookAt(new Vec3(position.x + 0.5, position.y + 0.5, position.z + 0.5), true);
        await bot.activateBlock(block);
        result.bonemealUses += 1;
        await sleep(useDelayMs);
      }

      block = bot.blockAt(new Vec3(position.x, position.y, position.z));
      if (block) {
        result.finalBlock = block.name;
        if (block.name === successBlock || block.name.endsWith("_log")) {
          result.success = true;
        }
      }

      results.push(result);
    }

    return {
      ok: true,
      action: "plant_and_bonemeal",
      successCount: results.filter((entry) => entry.success).length,
      results
    };
  });
}

async function buildSmallHouse(body) {
  return actionManager.run("build_small_house", async (manager) => {
    const bot = requireBot();
    const x = Math.floor(numberValue(body, "x"));
    const y = Math.floor(numberValue(body, "y"));
    const z = Math.floor(numberValue(body, "z"));
    const wallItem = stringValue(body, "wallItem", "oak_planks");
    const roofItem = stringValue(body, "roofItem", wallItem);
    const windowItem = stringValue(body, "windowItem", "glass_pane");
    const lightItem = stringValue(body, "lightItem", "torch");
    const range = numberValue(body, "range", 4);
    const placeDelayMs = numberValue(body, "placeDelayMs", 150);
    const continueOnError = boolValue(body, "continueOnError", false);
    const placements = buildSmallHousePlacements(x, y, z, wallItem, roofItem, windowItem, lightItem);
    const results = [];

    await ensureInventoryItem(bot, wallItem, 64);
    await ensureInventoryItem(bot, roofItem, 64);
    await ensureInventoryItem(bot, windowItem, 16);
    await ensureInventoryItem(bot, lightItem, 8);

    for (const placement of placements) {
      if (manager.isCancelled()) {
        throw new Error("action cancelled");
      }

      try {
        const result = await placeBlockByHand(bot, placement, {
          range,
          placeDelayMs,
          replace: false
        });
        results.push({
          ...result,
          success: true
        });
      } catch (error) {
        const failure = {
          x: placement.x,
          y: placement.y,
          z: placement.z,
          item: placement.item,
          success: false,
          error: error && error.message ? error.message : String(error)
        };
        results.push(failure);
        if (!continueOnError) {
          return {
            ok: false,
            action: "build_small_house",
            placedCount: results.filter((entry) => entry.success).length,
            results
          };
        }
      }
    }

    return {
      ok: true,
      action: "build_small_house",
      placedCount: results.filter((entry) => entry.success).length,
      results
    };
  });
}

async function buildDecoratedTwoStoryHouse(body) {
  return actionManager.run("build_decorated_two_story_house", async (manager) => {
    const bot = requireBot();
    const x = Math.floor(numberValue(body, "x"));
    const y = Math.floor(numberValue(body, "y"));
    const z = Math.floor(numberValue(body, "z"));
    const foundationItem = stringValue(body, "foundationItem", "stone_bricks");
    const floorItem = stringValue(body, "floorItem", "spruce_planks");
    const wallItem = stringValue(body, "wallItem", "birch_planks");
    const pillarItem = stringValue(body, "pillarItem", "oak_log");
    const roofItem = stringValue(body, "roofItem", "dark_oak_planks");
    const windowItem = stringValue(body, "windowItem", "glass_pane");
    const fenceItem = stringValue(body, "fenceItem", "oak_fence");
    const lightItem = stringValue(body, "lightItem", "lantern");
    const leafItem = stringValue(body, "leafItem", "oak_leaves");
    const doorItem = stringValue(body, "doorItem", "oak_door");
    const stairItem = stringValue(body, "stairItem", deriveRelatedItemName(floorItem, "slab"));
    const range = numberValue(body, "range", 4);
    const roofRange = numberValue(body, "roofRange", Math.max(range, 8));
    const placeDelayMs = numberValue(body, "placeDelayMs", 150);
    const continueOnError = boolValue(body, "continueOnError", false);
    const placements = buildDecoratedTwoStoryHousePlacements(x, y, z, {
      foundationItem,
      floorItem,
      wallItem,
      pillarItem,
      roofItem,
      windowItem,
      fenceItem,
      lightItem,
      leafItem,
      doorItem,
      stairItem
    });
    const secondFloorY = y + 4;
    const roofY = y + 8;
    const lowerPlacements = placements.filter((placement) => placement.y <= secondFloorY);
    const upperPlacements = placements.filter((placement) => placement.y > secondFloorY);
    const roofExtensionPlacements = upperPlacements.filter((placement) => placement.y === roofY && placement.z === z - 1);
    const upperCorePlacements = upperPlacements.filter((placement) => !(placement.y === roofY && placement.z === z - 1));
    const results = [];

    await ensureInventoryItem(bot, foundationItem, 64);
    await ensureInventoryItem(bot, floorItem, 64);
    await ensureInventoryItem(bot, wallItem, 160);
    await ensureInventoryItem(bot, pillarItem, 32);
    await ensureInventoryItem(bot, roofItem, 96);
    await ensureInventoryItem(bot, windowItem, 32);
    await ensureInventoryItem(bot, fenceItem, 48);
    await ensureInventoryItem(bot, lightItem, 16);
    await ensureInventoryItem(bot, leafItem, 16);
    await ensureInventoryItem(bot, doorItem, 1);
    await ensureInventoryItem(bot, stairItem, 16);

    async function placePlacementList(list) {
      for (const placement of list) {
        if (manager.isCancelled()) {
          throw new Error("action cancelled");
        }

        try {
          const result = await placeBlockByHand(bot, placement, {
            range,
            placeDelayMs,
            replace: true
          });
          results.push({
            ...result,
            success: true
          });
        } catch (error) {
          const failure = {
            x: placement.x,
            y: placement.y,
            z: placement.z,
            item: placement.item,
            success: false,
            error: error && error.message ? error.message : String(error)
          };
          results.push(failure);
          if (!continueOnError) {
            return false;
          }
        }
      }

      return true;
    }

    const lowerOk = await placePlacementList(lowerPlacements);
    if (!lowerOk) {
      return {
        ok: false,
        action: "build_decorated_two_story_house",
        placedCount: results.filter((entry) => entry.success).length,
        results
      };
    }

    await ensureNear(bot, x + 2, secondFloorY + 1, z + 4, 1);

    const upperOk = await placePlacementList(upperCorePlacements);
    if (!upperOk) {
      return {
        ok: false,
        action: "build_decorated_two_story_house",
        placedCount: results.filter((entry) => entry.success).length,
        results
      };
    }

    const roofOk = await placePlacementList(roofExtensionPlacements);
    if (!roofOk) {
      return {
        ok: false,
        action: "build_decorated_two_story_house",
        placedCount: results.filter((entry) => entry.success).length,
        results
      };
    }

    return {
      ok: true,
      action: "build_decorated_two_story_house",
      placedCount: results.filter((entry) => entry.success).length,
      results
    };
  });
}

async function buildRusticBalconyHouse(body) {
  return actionManager.run("build_rustic_balcony_house", async (manager) => {
    const bot = requireBot();
    const x = Math.floor(numberValue(body, "x"));
    const y = Math.floor(numberValue(body, "y"));
    const z = Math.floor(numberValue(body, "z"));
    const foundationItem = stringValue(body, "foundationItem", "cobblestone");
    const baseAccentItem = stringValue(body, "baseAccentItem", "stone_bricks");
    const floorItem = stringValue(body, "floorItem", "spruce_planks");
    const wallItem = stringValue(body, "wallItem", "spruce_planks");
    const beamItem = stringValue(body, "beamItem", "stripped_spruce_log");
    const roofItem = stringValue(body, "roofItem", "dark_oak_planks");
    const roofAccentItem = stringValue(body, "roofAccentItem", deriveRelatedItemName(roofItem, "slab"));
    const windowItem = stringValue(body, "windowItem", "glass_pane");
    const fenceItem = stringValue(body, "fenceItem", "spruce_fence");
    const lightItem = stringValue(body, "lightItem", "lantern");
    const doorItem = stringValue(body, "doorItem", "spruce_door");
    const leafItem = stringValue(body, "leafItem", "oak_leaves");
    const stairItem = stringValue(body, "stairItem", deriveRelatedItemName(floorItem, "slab"));
    const range = numberValue(body, "range", 4);
    const roofRange = numberValue(body, "roofRange", Math.max(range, 8));
    const placeDelayMs = numberValue(body, "placeDelayMs", 150);
    const continueOnError = boolValue(body, "continueOnError", false);
    const placements = buildRusticBalconyHousePlacements(x, y, z, {
      foundationItem,
      baseAccentItem,
      floorItem,
      wallItem,
      beamItem,
      roofItem,
      roofAccentItem,
      windowItem,
      fenceItem,
      lightItem,
      doorItem,
      stairItem,
      leafItem
    });
    const upperFloorY = y + 4;
    const roofBaseY = y + 8;
    const lowerPlacements = placements.filter((placement) => placement.y <= upperFloorY);
    const wallPlacements = placements.filter((placement) => placement.y > upperFloorY && placement.y < roofBaseY);
    const roofCenterX = x + 5;
    const roofCenterZ = z + 3;
    const roofPlacements = placements
      .filter((placement) => placement.y >= roofBaseY)
      .slice()
      .sort((left, right) => {
        if (left.y !== right.y) {
          return left.y - right.y;
        }

        const leftDistance = Math.abs(left.x - roofCenterX) + Math.abs(left.z - roofCenterZ);
        const rightDistance = Math.abs(right.x - roofCenterX) + Math.abs(right.z - roofCenterZ);
        if (leftDistance !== rightDistance) {
          return rightDistance - leftDistance;
        }

        if (left.z !== right.z) {
          return left.z - right.z;
        }
        return left.x - right.x;
      });
    const results = [];

    await ensurePlacementInventory(bot, placements, {
      [lightItem]: 4,
      [doorItem]: 2
    });

    async function placePlacementList(list) {
      for (const placement of list) {
        if (manager.isCancelled()) {
          throw new Error("action cancelled");
        }

        try {
          const result = await placeBlockByHand(bot, placement, {
            range,
            placeDelayMs,
            replace: true
          });
          results.push({
            ...result,
            success: true
          });
        } catch (error) {
          const failure = {
            x: placement.x,
            y: placement.y,
            z: placement.z,
            item: placement.item,
            success: false,
            error: error && error.message ? error.message : String(error)
          };
          results.push(failure);
          if (!continueOnError) {
            return false;
          }
        }
      }

      return true;
    }

    const lowerOk = await placePlacementList(lowerPlacements);
    if (!lowerOk) {
      return {
        ok: false,
        action: "build_rustic_balcony_house",
        placedCount: results.filter((entry) => entry.success).length,
        results
      };
    }

    await ensureNear(bot, x + 5, upperFloorY + 1, z + 4, 1);

    const upperOk = await placePlacementList(wallPlacements);
    if (!upperOk) {
      return {
        ok: false,
        action: "build_rustic_balcony_house",
        placedCount: results.filter((entry) => entry.success).length,
        results
      };
    }

    await ensureNear(bot, x + 5, upperFloorY + 1, z + 4, 1);

    async function placeRoofPlacementList(list) {
      for (const placement of list) {
        if (manager.isCancelled()) {
          throw new Error("action cancelled");
        }

        try {
          const result = await placeBlockByHand(bot, placement, {
            range: roofRange,
            placeDelayMs,
            replace: true
          });
          results.push({
            ...result,
            success: true
          });
        } catch (error) {
          const failure = {
            x: placement.x,
            y: placement.y,
            z: placement.z,
            item: placement.item,
            success: false,
            error: error && error.message ? error.message : String(error)
          };
          results.push(failure);
          if (!continueOnError) {
            return false;
          }
        }
      }

      return true;
    }

    const roofOk = await placeRoofPlacementList(roofPlacements);
    if (!roofOk) {
      return {
        ok: false,
        action: "build_rustic_balcony_house",
        placedCount: results.filter((entry) => entry.success).length,
        results
      };
    }

    return {
      ok: true,
      action: "build_rustic_balcony_house",
      placedCount: results.filter((entry) => entry.success).length,
      results
    };
  });
}

async function buildImperialPagoda(body) {
  return actionManager.run("build_imperial_pagoda", async (manager) => {
    const bot = requireBot();
    const connectOptions = state.botOptions || config.bot;
    const x = Math.floor(numberValue(body, "x"));
    const y = Math.floor(numberValue(body, "y"));
    const z = Math.floor(numberValue(body, "z"));
    const plotItem = stringValue(body, "plotItem", "sandstone");
    const plotBorderLightItem = stringValue(body, "plotBorderLightItem", "quartz_block");
    const plotBorderDarkItem = stringValue(body, "plotBorderDarkItem", "smooth_stone");
    const podiumItem = stringValue(body, "podiumItem", "stone_bricks");
    const podiumAccentItem = stringValue(body, "podiumAccentItem", "stone_brick_wall");
    const podiumStairBlockItem = stringValue(body, "podiumStairBlockItem", "stone_bricks");
    const podiumStairSlabItem = stringValue(body, "podiumStairSlabItem", "stone_brick_slab");
    const terraceItem = stringValue(body, "terraceItem", "spruce_planks");
    const beamItem = stringValue(body, "beamItem", "dark_oak_log");
    const pillarItem = stringValue(body, "pillarItem", "quartz_pillar");
    const accentItem = stringValue(body, "accentItem", "emerald_block");
    const wallItem = stringValue(body, "wallItem", "red_terracotta");
    const windowItem = stringValue(body, "windowItem", "green_stained_glass");
    const railingItem = stringValue(body, "railingItem", "acacia_fence");
    const eaveItem = stringValue(body, "eaveItem", "acacia_planks");
    const roofItem = stringValue(body, "roofItem", "acacia_planks");
    const roofAccentItem = stringValue(body, "roofAccentItem", deriveRelatedItemName(roofItem, "slab"));
    const ornamentItem = stringValue(body, "ornamentItem", "quartz_block");
    const ornamentBaseItem = stringValue(body, "ornamentBaseItem", "chiseled_stone_bricks");
    const lanternItem = stringValue(body, "lanternItem", "lantern");
    const doorItem = stringValue(body, "doorItem", "spruce_door");
    const stairBlockItem = stringValue(body, "stairBlockItem", "spruce_planks");
    const stairSlabItem = stringValue(body, "stairSlabItem", "spruce_slab");
    const requestedWorkers = Math.max(1, Math.floor(numberValue(body, "workers", 4)));
    const helperPrefix = stringValue(body, "helperPrefix", bot.username.slice(0, 12));
    const workerMode = String(stringValue(body, "workerMode", "auto")).toLowerCase();
    const range = numberValue(body, "range", 4);
    const roofRange = numberValue(body, "roofRange", Math.max(range, 10));
    const placeDelayMs = numberValue(body, "placeDelayMs", 150);
    const continueOnError = boolValue(body, "continueOnError", false);
    if (!["auto", "lanes", "grid", "round_robin"].includes(workerMode)) {
      throw new Error("invalid workerMode: " + workerMode);
    }
    const placements = buildImperialPagodaPlacements(x, y, z, {
      plotItem,
      plotBorderLightItem,
      plotBorderDarkItem,
      podiumItem,
      podiumAccentItem,
      podiumStairBlockItem,
      podiumStairSlabItem,
      terraceItem,
      beamItem,
      pillarItem,
      accentItem,
      wallItem,
      windowItem,
      railingItem,
      eaveItem,
      roofItem,
      roofAccentItem,
      ornamentItem,
      ornamentBaseItem,
      lanternItem,
      doorItem,
      stairBlockItem,
      stairSlabItem
    });
    const stageOrder = ["plot", "podium", "level1", "level2", "level3", "roof", "decor"];
    const stageTargets = {
      podium: { x: x + 16, y: y + 6, z: z + 12 },
      level1: { x: x + 16, y: y + 6, z: z + 18 },
      level2: { x: x + 16, y: y + 12, z: z + 18 },
      level3: { x: x + 16, y: y + 18, z: z + 18 }
    };
    const results = [];
    const helperBots = [];
    const workerBots = [bot];
    let placedCount = 0;
    let failureCount = 0;
    const workerFallbackTarget = {
      x: x + 16,
      y: y + 2,
      z: z + 15
    };

    function buildBounds(list) {
      if (!list || list.length === 0) {
        return null;
      }

      const bounds = {
        minX: list[0].x,
        maxX: list[0].x,
        minY: list[0].y,
        maxY: list[0].y,
        minZ: list[0].z,
        maxZ: list[0].z
      };

      for (const placement of list) {
        bounds.minX = Math.min(bounds.minX, placement.x);
        bounds.maxX = Math.max(bounds.maxX, placement.x);
        bounds.minY = Math.min(bounds.minY, placement.y);
        bounds.maxY = Math.max(bounds.maxY, placement.y);
        bounds.minZ = Math.min(bounds.minZ, placement.z);
        bounds.maxZ = Math.max(bounds.maxZ, placement.z);
      }

      return bounds;
    }

    function sortWorkerPlacements(list, primaryAxis, secondaryAxis) {
      return list.slice().sort((left, right) => {
        if (left.y !== right.y) {
          return left.y - right.y;
        }
        if (left[secondaryAxis] !== right[secondaryAxis]) {
          return left[secondaryAxis] - right[secondaryAxis];
        }
        return left[primaryAxis] - right[primaryAxis];
      });
    }

    async function teleportWorkerNearChunk(workerBot, bounds, fallbackTarget) {
      const target = bounds ? {
        x: bounds.minX,
        y: bounds.maxY + 2,
        z: bounds.minZ
      } : fallbackTarget;

      await runBotCommand(
        bot,
        "/tp " + workerBot.username + " " + String(target.x) + " " + String(target.y) + " " + String(target.z)
      );
      await sleep(300);
    }

    function splitPlacementsForWorkers(list, botCount) {
      const emptyPlan = {
        strategy: "empty",
        chunks: Array.from({ length: botCount }, () => [])
      };

      if (botCount <= 1) {
        return {
          strategy: "single",
          chunks: [sortPlacements(list)]
        };
      }
      if (!list || list.length === 0) {
        return emptyPlan;
      }

      const bounds = buildBounds(list);
      const width = bounds.maxX - bounds.minX + 1;
      const depth = bounds.maxZ - bounds.minZ + 1;
      const effectiveMode = workerMode === "auto"
        ? (botCount >= 4 && width >= 6 && depth >= 6 ? "grid" : "lanes")
        : workerMode;

      if (effectiveMode === "round_robin") {
        const chunks = Array.from({ length: botCount }, () => []);
        const ordered = list.slice().sort((left, right) => {
          if (left.x !== right.x) {
            return left.x - right.x;
          }
          if (left.z !== right.z) {
            return left.z - right.z;
          }
          return left.y - right.y;
        });

        ordered.forEach((placement, index) => {
          chunks[index % botCount].push(placement);
        });

        return {
          strategy: "round_robin",
          chunks: chunks.map((chunk) => sortPlacements(chunk))
        };
      }

      if (effectiveMode === "grid") {
        const columns = Math.max(1, Math.min(botCount, Math.ceil(Math.sqrt(botCount))));
        const rows = Math.max(1, Math.ceil(botCount / columns));
        const spanX = Math.max(1, bounds.maxX - bounds.minX + 1);
        const spanZ = Math.max(1, bounds.maxZ - bounds.minZ + 1);
        const chunks = Array.from({ length: botCount }, () => []);

        for (const placement of list) {
          const column = Math.min(columns - 1, Math.floor(((placement.x - bounds.minX) * columns) / spanX));
          const row = Math.min(rows - 1, Math.floor(((placement.z - bounds.minZ) * rows) / spanZ));
          let index = row * columns + column;
          if (index >= botCount) {
            index = botCount - 1;
          }
          chunks[index].push(placement);
        }

        return {
          strategy: String(rows) + "x" + String(columns) + "_grid",
          chunks: chunks.map((chunk) => sortWorkerPlacements(chunk, "x", "z"))
        };
      }

      const primaryAxis = width >= depth ? "x" : "z";
      const secondaryAxis = primaryAxis === "x" ? "z" : "x";
      const minCoordinate = primaryAxis === "x" ? bounds.minX : bounds.minZ;
      const span = Math.max(1, (primaryAxis === "x" ? bounds.maxX : bounds.maxZ) - minCoordinate + 1);
      const chunks = Array.from({ length: botCount }, () => []);

      for (const placement of list) {
        const coordinate = primaryAxis === "x" ? placement.x : placement.z;
        const ratioIndex = Math.floor(((coordinate - minCoordinate) * botCount) / span);
        const index = Math.max(0, Math.min(botCount - 1, ratioIndex));
        chunks[index].push(placement);
      }

      return {
        strategy: primaryAxis + "_lanes",
        chunks: chunks.map((chunk) => sortWorkerPlacements(chunk, primaryAxis, secondaryAxis))
      };
    }

    function snapshotStageProgress(stageName, stageRange, stageStrategy, stageWorkers, stageStatus) {
      return {
        name: stageName,
        range: stageRange,
        strategy: stageStrategy,
        total: stageStatus.total,
        completed: stageStatus.completed,
        placedCount: stageStatus.placedCount,
        failureCount: stageStatus.failureCount,
        workers: stageWorkers.map((entry) => ({
          username: entry.username,
          assigned: entry.assigned,
          completed: entry.completed,
          placedCount: entry.placedCount,
          failureCount: entry.failureCount,
          bounds: entry.bounds
        }))
      };
    }

    function updateBuildProgress(message, extra) {
      manager.setProgress(message, {
        action: "build_imperial_pagoda",
        workerMode,
        requestedWorkers,
        connectedWorkers: workerBots.map((entry) => entry.username),
        placedCount,
        failureCount,
        ...(extra || {})
      });
    }

    async function placeStageChunk(workerBot, chunk, stageName, stageRange, stageStatus, workerState, publishProgress, shouldStop) {
      for (const placement of chunk) {
        if (manager.isCancelled()) {
          throw new Error("action cancelled");
        }
        if (shouldStop()) {
          return false;
        }

        try {
          const result = await placeBlockByHand(workerBot, placement, {
            range: stageRange,
            placeDelayMs,
            replace: true,
            skipInventoryCheck: true,
            commandBot: bot
          });
          results.push({
            ...result,
            worker: workerBot.username,
            success: true
          });
          placedCount += 1;
          stageStatus.completed += 1;
          stageStatus.placedCount += 1;
          workerState.completed += 1;
          workerState.placedCount += 1;
        } catch (error) {
          const failure = {
            x: placement.x,
            y: placement.y,
            z: placement.z,
            item: placement.item,
            worker: workerBot.username,
            success: false,
            error: error && error.message ? error.message : String(error)
          };
          results.push(failure);
          failureCount += 1;
          stageStatus.completed += 1;
          stageStatus.failureCount += 1;
          workerState.completed += 1;
          workerState.failureCount += 1;
          publishProgress();
          if (!continueOnError) {
            return false;
          }
        }

        publishProgress();
      }

      return true;
    }

    async function placeStage(stageName) {
      const list = sortPlacements(placements.filter((placement) => placement.stage === stageName));
      const stageRange = stageName === "roof" ? roofRange : range;
      const stageBots = workerBots.slice();
      const splitPlan = splitPlacementsForWorkers(list, stageBots.length);
      const chunks = splitPlan.chunks;
      const stageStatus = {
        total: list.length,
        completed: 0,
        placedCount: 0,
        failureCount: 0
      };
      const stageWorkers = stageBots.map((workerBot, index) => ({
        username: workerBot.username,
        assigned: (chunks[index] || []).length,
        completed: 0,
        placedCount: 0,
        failureCount: 0,
        bounds: buildBounds(chunks[index] || [])
      }));
      let lastPublishedCount = -1;
      let stopRequested = false;

      const publishProgress = (force) => {
        if (!force && stageStatus.completed === lastPublishedCount) {
          return;
        }
        if (!force && stageStatus.completed !== stageStatus.total && stageStatus.completed % 16 !== 0) {
          return;
        }

        lastPublishedCount = stageStatus.completed;
        updateBuildProgress("stage " + stageName + " " + String(stageStatus.completed) + "/" + String(stageStatus.total), {
          stage: snapshotStageProgress(stageName, stageRange, splitPlan.strategy, stageWorkers, stageStatus)
        });
      };

      logMessage(
        "pagoda stage " + stageName + " start: " + String(list.length) + " blocks, " +
        String(stageBots.length) + " bots, strategy=" + splitPlan.strategy,
        "System"
      );
      publishProgress(true);

      for (let index = 0; index < stageBots.length; index += 1) {
        const workerBot = stageBots[index];
        const chunk = chunks[index];
        if (!chunk || chunk.length === 0) {
          continue;
        }

        await teleportWorkerNearChunk(workerBot, stageWorkers[index].bounds, stageTargets[stageName] || workerFallbackTarget);
        await runBotCommand(bot, "/clear " + workerBot.username);
        await ensurePlacementInventory(workerBot, chunk, null, {
          commandBot: bot
        });
      }

      const stageResults = await Promise.all(stageBots.map((workerBot, index) => placeStageChunk(
        workerBot,
        chunks[index] || [],
        stageName,
        stageRange,
        stageStatus,
        stageWorkers[index],
        publishProgress,
        () => stopRequested
      ).then((ok) => {
        if (!ok && !continueOnError) {
          stopRequested = true;
        }
        return ok;
      })));
      publishProgress(true);
      logMessage(
        "pagoda stage " + stageName + " done: placed=" + String(stageStatus.placedCount) +
        ", failed=" + String(stageStatus.failureCount),
        "System"
      );
      if (!continueOnError && stageResults.some((entry) => !entry)) {
        return false;
      }

      const target = stageTargets[stageName];
      if (target) {
        try {
          await ensureNear(bot, target.x, target.y, target.z, 1);
        } catch (error) {
          await runBotCommand(bot, "/tp " + bot.username + " " + String(target.x) + " " + String(target.y) + " " + String(target.z));
        }
      }

      return true;
    }

    try {
      updateBuildProgress("connecting worker bots", {
        stage: {
          name: "setup",
          requestedWorkers,
          connectedWorkers: workerBots.map((entry) => entry.username)
        }
      });

      for (let helperIndex = 1; helperIndex < requestedWorkers; helperIndex += 1) {
        const helperName = (helperPrefix + String(helperIndex)).slice(0, 16);
        if (helperName === bot.username) {
          continue;
        }

        try {
          const helperBot = await connectAuxiliaryBot(connectOptions, helperName);
          helperBots.push(helperBot);
          workerBots.push(helperBot);
          await runBotCommand(bot, "/gamemode creative " + helperName);
          await teleportWorkerNearChunk(helperBot, null, workerFallbackTarget);
          updateBuildProgress("connected worker " + helperName, {
            stage: {
              name: "setup",
              requestedWorkers,
              connectedWorkers: workerBots.map((entry) => entry.username)
            }
          });
        } catch (error) {
          logMessage("failed to connect aux bot " + helperName + ": " + (error && error.message ? error.message : String(error)), "Error");
        }
      }

      for (const stageName of stageOrder) {
        const ok = await placeStage(stageName);
        if (!ok) {
          return {
            ok: false,
            action: "build_imperial_pagoda",
            workers: workerBots.map((entry) => entry.username),
            workerMode,
            placedCount,
            failureCount,
            results
          };
        }
      }

      return {
        ok: true,
        action: "build_imperial_pagoda",
        workers: workerBots.map((entry) => entry.username),
        workerMode,
        placedCount,
        failureCount,
        results
      };
    } finally {
      await disconnectAuxiliaryBots(helperBots);
    }
  });
}

async function buildReferencePathChain(body) {
  return actionManager.run("build_reference_path_chain", async (manager) => {
    const bot = requireBot();
    const connectOptions = state.botOptions || config.bot;
    const manualOnly = boolValue(body, "manualOnly", true);
    const segmentCount = Math.max(2, Math.floor(numberValue(body, "segmentCount", 6)));
    const segmentLength = Math.max(6, Math.floor(numberValue(body, "segmentLength", 10)));
    const pathWidth = Math.max(5, Math.floor(numberValue(body, "pathWidth", 7)));
    const requestedWorkers = Math.max(1, Math.floor(numberValue(body, "workers", 4)));
    const helperPrefix = stringValue(body, "helperPrefix", bot.username.slice(0, 12));
    const workerMode = String(stringValue(body, "workerMode", "lanes")).toLowerCase();
    const range = numberValue(body, "range", 5);
    const placeDelayMs = numberValue(body, "placeDelayMs", 50);
    const continueOnError = boolValue(body, "continueOnError", true);
    const dirXRaw = Math.sign(numberValue(body, "dirX", 1));
    const dirZRaw = Math.sign(numberValue(body, "dirZ", 0));
    const dirX = dirXRaw === 0 && dirZRaw === 0 ? 1 : dirXRaw;
    const dirZ = dirXRaw === 0 && dirZRaw === 0 ? 0 : dirZRaw;
    const searchRadius = numberValue(body, "searchRadius", 96);
    const stoneMainItem = stringValue(body, "stoneMainItem", "stone_bricks");
    const stoneEdgeItem = stringValue(body, "stoneEdgeItem", "gravel");
    const stoneAccentItem = stringValue(body, "stoneAccentItem", "cobblestone");
    const dirtMainItem = stringValue(body, "dirtMainItem", "coarse_dirt");
    const dirtEdgeItem = stringValue(body, "dirtEdgeItem", "gravel");
    const dirtAccentItem = stringValue(body, "dirtAccentItem", "dirt");
    const postItem = stringValue(body, "postItem", "oak_log");
    const leafItem = stringValue(body, "leafItem", "oak_leaves");
    const lanternItem = stringValue(body, "lanternItem", "lantern");
    const shrubItem = stringValue(body, "shrubItem", "moss_block");
    const inventoryMode = manualOnly ? "creative_manual" : "";

    if (!["auto", "lanes", "grid", "round_robin"].includes(workerMode)) {
      throw new Error("invalid workerMode: " + workerMode);
    }
    if (Math.abs(dirX) + Math.abs(dirZ) !== 1) {
      throw new Error("dirX/dirZ must describe one horizontal axis");
    }
    if (manualOnly && !isCreativeMode(bot)) {
      throw new Error("manual path chain requires the bot to be in creative mode");
    }

    let originX;
    let originY;
    let originZ;
    if ("x" in body && "y" in body && "z" in body) {
      originX = Math.floor(numberValue(body, "x"));
      originY = Math.floor(numberValue(body, "y"));
      originZ = Math.floor(numberValue(body, "z"));
    } else {
      const found = findFlatBuildOrigin(bot, {
        width: segmentCount * segmentLength + 12,
        depth: pathWidth + 12,
        searchRadius
      });
      originX = found.x;
      originY = found.y;
      originZ = found.z;
    }

    const pathPlan = buildReferencePathChainPlacements(originX, originY, originZ, {
      segmentCount,
      segmentLength,
      pathWidth,
      dirX,
      dirZ,
      stoneMainItem,
      stoneEdgeItem,
      stoneAccentItem,
      dirtMainItem,
      dirtEdgeItem,
      dirtAccentItem,
      postItem,
      leafItem,
      lanternItem,
      shrubItem
    });
    const placements = pathPlan.placements;
    const stageOrder = ["ground", "posts", "decor_base", "decor_leaf", "decor_top", "decor_finish"];
    const stageTargets = {
      ground: pathPlan.center,
      posts: { x: pathPlan.center.x, y: pathPlan.center.y + 2, z: pathPlan.center.z },
      decor_base: { x: pathPlan.center.x, y: pathPlan.center.y + 4, z: pathPlan.center.z },
      decor_leaf: { x: pathPlan.center.x, y: pathPlan.center.y + 4, z: pathPlan.center.z },
      decor_top: { x: pathPlan.center.x, y: pathPlan.center.y + 5, z: pathPlan.center.z },
      decor_finish: { x: pathPlan.center.x, y: pathPlan.center.y + 4, z: pathPlan.center.z }
    };
    const results = [];
    const helperBots = [];
    const workerBots = [bot];
    let placedCount = 0;
    let failureCount = 0;
    const workerFallbackTarget = {
      x: pathPlan.center.x,
      y: pathPlan.center.y,
      z: pathPlan.center.z
    };

    function buildBounds(list) {
      if (!list || list.length === 0) {
        return null;
      }

      const bounds = {
        minX: list[0].x,
        maxX: list[0].x,
        minY: list[0].y,
        maxY: list[0].y,
        minZ: list[0].z,
        maxZ: list[0].z
      };

      for (const placement of list) {
        bounds.minX = Math.min(bounds.minX, placement.x);
        bounds.maxX = Math.max(bounds.maxX, placement.x);
        bounds.minY = Math.min(bounds.minY, placement.y);
        bounds.maxY = Math.max(bounds.maxY, placement.y);
        bounds.minZ = Math.min(bounds.minZ, placement.z);
        bounds.maxZ = Math.max(bounds.maxZ, placement.z);
      }

      return bounds;
    }

    function sortWorkerPlacements(list, primaryAxis, secondaryAxis) {
      return list.slice().sort((left, right) => {
        if (left.y !== right.y) {
          return left.y - right.y;
        }
        if (left[secondaryAxis] !== right[secondaryAxis]) {
          return left[secondaryAxis] - right[secondaryAxis];
        }
        return left[primaryAxis] - right[primaryAxis];
      });
    }

    async function moveWorkerNearChunk(workerBot, bounds, fallbackTarget) {
      const target = bounds ? {
        x: bounds.minX,
        y: workerFallbackTarget.y,
        z: bounds.minZ
      } : fallbackTarget;

      await ensureNear(workerBot, target.x, target.y, target.z, 2);
    }

    function splitPlacementsForWorkers(list, botCount) {
      const emptyPlan = {
        strategy: "empty",
        chunks: Array.from({ length: botCount }, () => [])
      };

      if (botCount <= 1) {
        return {
          strategy: "single",
          chunks: [sortPlacements(list)]
        };
      }
      if (!list || list.length === 0) {
        return emptyPlan;
      }

      const bounds = buildBounds(list);
      const width = bounds.maxX - bounds.minX + 1;
      const depth = bounds.maxZ - bounds.minZ + 1;
      const effectiveMode = workerMode === "auto"
        ? (width >= depth ? "lanes" : "grid")
        : workerMode;

      if (effectiveMode === "round_robin") {
        const chunks = Array.from({ length: botCount }, () => []);
        const ordered = list.slice().sort((left, right) => {
          if (left.x !== right.x) {
            return left.x - right.x;
          }
          if (left.z !== right.z) {
            return left.z - right.z;
          }
          return left.y - right.y;
        });

        ordered.forEach((placement, index) => {
          chunks[index % botCount].push(placement);
        });

        return {
          strategy: "round_robin",
          chunks: chunks.map((chunk) => sortPlacements(chunk))
        };
      }

      if (effectiveMode === "grid") {
        const columns = Math.max(1, Math.min(botCount, Math.ceil(Math.sqrt(botCount))));
        const rows = Math.max(1, Math.ceil(botCount / columns));
        const spanX = Math.max(1, bounds.maxX - bounds.minX + 1);
        const spanZ = Math.max(1, bounds.maxZ - bounds.minZ + 1);
        const chunks = Array.from({ length: botCount }, () => []);

        for (const placement of list) {
          const column = Math.min(columns - 1, Math.floor(((placement.x - bounds.minX) * columns) / spanX));
          const row = Math.min(rows - 1, Math.floor(((placement.z - bounds.minZ) * rows) / spanZ));
          let index = row * columns + column;
          if (index >= botCount) {
            index = botCount - 1;
          }
          chunks[index].push(placement);
        }

        return {
          strategy: String(rows) + "x" + String(columns) + "_grid",
          chunks: chunks.map((chunk) => sortWorkerPlacements(chunk, "x", "z"))
        };
      }

      const primaryAxis = Math.abs(dirX) === 1 ? "x" : "z";
      const secondaryAxis = primaryAxis === "x" ? "z" : "x";
      const minCoordinate = primaryAxis === "x" ? bounds.minX : bounds.minZ;
      const span = Math.max(1, (primaryAxis === "x" ? bounds.maxX : bounds.maxZ) - minCoordinate + 1);
      const chunks = Array.from({ length: botCount }, () => []);

      for (const placement of list) {
        const coordinate = primaryAxis === "x" ? placement.x : placement.z;
        const ratioIndex = Math.floor(((coordinate - minCoordinate) * botCount) / span);
        const index = Math.max(0, Math.min(botCount - 1, ratioIndex));
        chunks[index].push(placement);
      }

      return {
        strategy: primaryAxis + "_lanes",
        chunks: chunks.map((chunk) => sortWorkerPlacements(chunk, primaryAxis, secondaryAxis))
      };
    }

    function snapshotStageProgress(stageName, stageRange, stageStrategy, stageWorkers, stageStatus) {
      return {
        name: stageName,
        range: stageRange,
        strategy: stageStrategy,
        total: stageStatus.total,
        completed: stageStatus.completed,
        placedCount: stageStatus.placedCount,
        failureCount: stageStatus.failureCount,
        workers: stageWorkers.map((entry) => ({
          username: entry.username,
          assigned: entry.assigned,
          completed: entry.completed,
          placedCount: entry.placedCount,
          failureCount: entry.failureCount,
          bounds: entry.bounds
        }))
      };
    }

    function updateBuildProgress(message, extra) {
      manager.setProgress(message, {
        action: "build_reference_path_chain",
        workerMode,
        requestedWorkers,
        connectedWorkers: workerBots.map((entry) => entry.username),
        placedCount,
        failureCount,
        ...(extra || {})
      });
    }

    async function placeStageChunk(workerBot, chunk, stageName, stageRange, stageStatus, workerState, publishProgress, shouldStop) {
      for (const placement of chunk) {
        if (manager.isCancelled()) {
          throw new Error("action cancelled");
        }
        if (shouldStop()) {
          return false;
        }

        try {
          const result = await placeBlockByHand(workerBot, placement, {
            range: stageRange,
            placeDelayMs,
            replace: true,
            skipInventoryCheck: true,
            commandBot: bot,
            allowCommands: !manualOnly,
            inventoryMode
          });
          results.push({
            ...result,
            worker: workerBot.username,
            success: true
          });
          placedCount += 1;
          stageStatus.completed += 1;
          stageStatus.placedCount += 1;
          workerState.completed += 1;
          workerState.placedCount += 1;
        } catch (error) {
          results.push({
            x: placement.x,
            y: placement.y,
            z: placement.z,
            item: placement.item,
            worker: workerBot.username,
            success: false,
            error: error && error.message ? error.message : String(error)
          });
          failureCount += 1;
          stageStatus.completed += 1;
          stageStatus.failureCount += 1;
          workerState.completed += 1;
          workerState.failureCount += 1;
          publishProgress();
          if (!continueOnError) {
            return false;
          }
        }

        publishProgress();
      }

      return true;
    }

    async function placeStage(stageName) {
      const list = sortPlacements(placements.filter((placement) => placement.stage === stageName));
      const stageRange = range;
      const stageBots = workerBots.slice();
      const splitPlan = splitPlacementsForWorkers(list, stageBots.length);
      const chunks = splitPlan.chunks;
      const stageStatus = {
        total: list.length,
        completed: 0,
        placedCount: 0,
        failureCount: 0
      };
      const stageWorkers = stageBots.map((workerBot, index) => ({
        username: workerBot.username,
        assigned: (chunks[index] || []).length,
        completed: 0,
        placedCount: 0,
        failureCount: 0,
        bounds: buildBounds(chunks[index] || [])
      }));
      let lastPublishedCount = -1;
      let stopRequested = false;

      const publishProgress = (force) => {
        if (!force && stageStatus.completed === lastPublishedCount) {
          return;
        }
        if (!force && stageStatus.completed !== stageStatus.total && stageStatus.completed % 16 !== 0) {
          return;
        }

        lastPublishedCount = stageStatus.completed;
        updateBuildProgress("stage " + stageName + " " + String(stageStatus.completed) + "/" + String(stageStatus.total), {
          stage: snapshotStageProgress(stageName, stageRange, splitPlan.strategy, stageWorkers, stageStatus)
        });
      };

      logMessage(
        "path stage " + stageName + " start: " + String(list.length) + " blocks, " +
        String(stageBots.length) + " bots, strategy=" + splitPlan.strategy,
        "System"
      );
      publishProgress(true);

      for (let index = 0; index < stageBots.length; index += 1) {
        const workerBot = stageBots[index];
        const chunk = chunks[index];
        if (!chunk || chunk.length === 0) {
          continue;
        }

        await moveWorkerNearChunk(workerBot, stageWorkers[index].bounds, stageTargets[stageName] || workerFallbackTarget);
        await ensurePlacementInventory(workerBot, chunk, null, {
          commandBot: bot,
          allowCommands: !manualOnly,
          inventoryMode
        });
      }

      const stageResults = await Promise.all(stageBots.map((workerBot, index) => placeStageChunk(
        workerBot,
        chunks[index] || [],
        stageName,
        stageRange,
        stageStatus,
        stageWorkers[index],
        publishProgress,
        () => stopRequested
      ).then((ok) => {
        if (!ok && !continueOnError) {
          stopRequested = true;
        }
        return ok;
      })));
      publishProgress(true);

      const target = stageTargets[stageName];
      if (target) {
        try {
          await ensureNear(bot, target.x, workerFallbackTarget.y, target.z, 1);
        } catch (error) {
          logMessage("failed to walk near stage target: " + (error && error.message ? error.message : String(error)), "Error");
        }
      }

      if (!continueOnError && stageResults.some((entry) => !entry)) {
        return false;
      }
      return true;
    }

    try {
      updateBuildProgress("connecting worker bots", {
        stage: {
          name: "setup",
          requestedWorkers,
          connectedWorkers: workerBots.map((entry) => entry.username)
        }
      });

      for (let helperIndex = 1; helperIndex < requestedWorkers; helperIndex += 1) {
        const helperName = (helperPrefix + String(helperIndex)).slice(0, 16);
        if (helperName === bot.username) {
          continue;
        }

        let helperBot = null;
        try {
          helperBot = await connectAuxiliaryBot(connectOptions, helperName);
          if (manualOnly && !isCreativeMode(helperBot)) {
            await disconnectAuxiliaryBots([helperBot]);
            throw new Error("helper bot is not in creative mode");
          }
          helperBots.push(helperBot);
          workerBots.push(helperBot);
          await moveWorkerNearChunk(helperBot, null, workerFallbackTarget);
        } catch (error) {
          logMessage("failed to connect aux bot " + helperName + ": " + (error && error.message ? error.message : String(error)), "Error");
        }
      }

      for (const stageName of stageOrder) {
        const ok = await placeStage(stageName);
        if (!ok) {
          return {
            ok: false,
            action: "build_reference_path_chain",
            origin: {
              x: originX,
              y: originY,
              z: originZ
            },
            workers: workerBots.map((entry) => entry.username),
            workerMode,
            placedCount,
            failureCount,
            results
          };
        }
      }

      return {
        ok: true,
        action: "build_reference_path_chain",
        origin: {
          x: originX,
          y: originY,
          z: originZ
        },
        workers: workerBots.map((entry) => entry.username),
        workerMode,
        path: {
          segmentCount,
          segmentLength,
          pathWidth,
          totalLength: pathPlan.totalLength
        },
        placedCount,
        failureCount,
        results
      };
    } finally {
      await disconnectAuxiliaryBots(helperBots);
    }
  });
}

async function farmStoreFive(body) {
  return actionManager.run("farm_store_five", async (manager) => {
    const bot = requireBot();
    const originX = Math.floor(numberValue(body, "x"));
    const supportY = Math.floor(numberValue(body, "y"));
    const originZ = Math.floor(numberValue(body, "z"));
    const range = numberValue(body, "range", 4);
    const useDelayMs = numberValue(body, "useDelayMs", 150);
    const cropItem = stringValue(body, "cropItem", "wheat");
    const seedItem = stringValue(body, "seedItem", "wheat_seeds");
    const chestItem = stringValue(body, "chestItem", "chest");
    const hoeItem = stringValue(body, "hoeItem", "diamond_hoe");
    const boneMealItem = stringValue(body, "boneMealItem", "bone_meal");
    const waterItem = stringValue(body, "waterItem", "water_bucket");
    const groundItem = stringValue(body, "groundItem", "dirt");
    const prepareGround = boolValue(body, "prepareGround", true);
    const width = 5;
    const depth = 5;
    const cropY = supportY + 1;
    const waterY = supportY;
    const waterFloorY = supportY - 1;
    const centerX = originX + 2;
    const centerZ = originZ + 2;
    const chestAX = originX + width + 2;
    const chestAZ = originZ + 2;
    const chestAY = cropY;
    const cropPositions = [];
    const results = {
      supportPlaced: 0,
      tilled: 0,
      planted: 0,
      matured: 0,
      harvested: 0,
      wheatCount: 0,
      waterPlaced: false,
      waterMethod: "",
      chestPlaced: false,
      chestMerged: false,
      patternPlaced: false
    };

    await runBotCommand(bot, "/gamemode survival " + bot.username);
    await trimInventoryItem(bot, hoeItem, 1);
    await trimInventoryItem(bot, waterItem, 1);
    await ensureInventoryItem(bot, hoeItem, 1);
    await ensureInventoryItem(bot, seedItem, 64);
    await ensureInventoryItem(bot, boneMealItem, 64);
    await ensureInventoryItem(bot, chestItem, 2);
    await ensureInventoryItem(bot, waterItem, 1);
    if (prepareGround) {
      await ensureInventoryItem(bot, groundItem, width * depth + 2);
    }

    for (let dz = 0; dz < depth; dz += 1) {
      for (let dx = 0; dx < width; dx += 1) {
        const x = originX + dx;
        const z = originZ + dz;
        if (x === centerX && z === centerZ) {
          continue;
        }
        cropPositions.push({ x, z });
      }
    }

    if (prepareGround) {
      const supportTargets = [];
      for (let dz = 0; dz < depth; dz += 1) {
        for (let dx = 0; dx < width; dx += 1) {
          const x = originX + dx;
          const z = originZ + dz;
          if (x === centerX && z === centerZ) {
            continue;
          }
          supportTargets.push({ x, y: supportY, z });
        }
      }
      supportTargets.push({ x: centerX, y: waterFloorY, z: centerZ });
      supportTargets.push({ x: chestAX, y: supportY, z: chestAZ });
      supportTargets.push({ x: chestAX + 1, y: supportY, z: chestAZ });

      for (const supportTarget of supportTargets) {
        const supportResult = await ensureSupportBlockByHand(
          bot,
          supportTarget.x,
          supportTarget.y,
          supportTarget.z,
          groundItem,
          range,
          useDelayMs
        );
        if (supportResult.placed) {
          results.supportPlaced += 1;
        }
      }
    }

    await clearBlockIfNeeded(bot, centerX, waterY, centerZ, range, useDelayMs, ["water"]);

    const waterFloorBlock = bot.blockAt(new Vec3(centerX, waterFloorY, centerZ));
    if (!waterFloorBlock || isAir(waterFloorBlock)) {
      throw new Error("farm water floor missing at " + blockKey(centerX, waterFloorY, centerZ));
    }

    const waterResult = await placeWaterSourceByHand(bot, waterItem, centerX, waterY, centerZ, range, useDelayMs, inventoryOptions);
    results.waterPlaced = true;
    results.waterMethod = waterResult.method;

    for (const position of cropPositions) {
      if (manager.isCancelled()) {
        throw new Error("action cancelled");
      }

      const groundBlock = bot.blockAt(new Vec3(position.x, supportY, position.z));
      if (!groundBlock || isAir(groundBlock)) {
        throw new Error("farm support missing at " + blockKey(position.x, supportY, position.z));
      }

      let farmland = bot.blockAt(new Vec3(position.x, supportY, position.z));
      if (!farmland || farmland.name !== "farmland") {
        await rightClickBlockWithItem(bot, hoeItem, position.x, supportY, position.z, range, useDelayMs);
        farmland = bot.blockAt(new Vec3(position.x, supportY, position.z));
      }
      if (!farmland || farmland.name !== "farmland") {
        throw new Error("failed to till farmland at " + blockKey(position.x, supportY, position.z));
      }
      results.tilled += 1;

      let cropBlock = bot.blockAt(new Vec3(position.x, cropY, position.z));
      if (cropBlock && !isAir(cropBlock) && cropBlock.name !== cropItem) {
        await clearBlockIfNeeded(bot, position.x, cropY, position.z, range, useDelayMs);
        cropBlock = bot.blockAt(new Vec3(position.x, cropY, position.z));
      }
      if (isAir(cropBlock)) {
        await rightClickBlockWithItem(bot, seedItem, position.x, supportY, position.z, range, useDelayMs);
        cropBlock = bot.blockAt(new Vec3(position.x, cropY, position.z));
      }
      if (!cropBlock || cropBlock.name !== cropItem) {
        throw new Error("failed to plant crop at " + blockKey(position.x, cropY, position.z));
      }
      results.planted += 1;

      let attempts = 0;
      while (!isMatureCrop(cropBlock, cropItem) && attempts < 12) {
        await rightClickBlockWithItem(bot, boneMealItem, position.x, cropY, position.z, range, useDelayMs);
        cropBlock = bot.blockAt(new Vec3(position.x, cropY, position.z));
        attempts += 1;
      }
      if (!isMatureCrop(cropBlock, cropItem)) {
        throw new Error("failed to mature crop at " + blockKey(position.x, cropY, position.z));
      }
      results.matured += 1;
    }

    for (const position of cropPositions) {
      if (manager.isCancelled()) {
        throw new Error("action cancelled");
      }

      const cropBlock = bot.blockAt(new Vec3(position.x, cropY, position.z));
      if (cropBlock && cropBlock.name === cropItem) {
        await ensureNear(bot, position.x, cropY, position.z, range);
        await bot.dig(cropBlock, true);
        await sleep(useDelayMs);
        results.harvested += 1;
      }
    }

    const collectPoints = [
      { x: originX + 2, y: cropY, z: originZ + 2 },
      { x: originX, y: cropY, z: originZ },
      { x: originX + 4, y: cropY, z: originZ + 4 },
      { x: originX, y: cropY, z: originZ + 4 },
      { x: originX + 4, y: cropY, z: originZ }
    ];
    for (const point of collectPoints) {
      await ensureNear(bot, point.x, point.y, point.z, 1);
      await sleep(150);
    }

    await sleep(1000);
    results.wheatCount = countInventoryItem(bot, cropItem);
    if (results.wheatCount < buildFivePatternSlots().length) {
      throw new Error("not enough harvested wheat to form 5, count=" + String(results.wheatCount));
    }

    await clearBlockIfNeeded(bot, chestAX, chestAY, chestAZ, range, useDelayMs);
    await clearBlockIfNeeded(bot, chestAX + 1, chestAY, chestAZ, range, useDelayMs);
    await placeDoubleChestByHand(
      bot,
      { x: chestAX, y: chestAY, z: chestAZ, item: chestItem },
      { x: chestAX + 1, y: chestAY, z: chestAZ, item: chestItem },
      { range, placeDelayMs: useDelayMs }
    );
    results.chestPlaced = true;
    results.chestMerged = true;

    await ensureNear(bot, chestAX, chestAY, chestAZ, range);
    const chestBlock = bot.blockAt(new Vec3(chestAX, chestAY, chestAZ));
    if (!chestBlock) {
      throw new Error("chest block not found");
    }

    const container = await bot.openContainer(chestBlock);
    try {
      if (container.inventoryStart < 54) {
        throw new Error("double chest did not open as merged container");
      }
      const patternSlots = buildFivePatternSlots();
      const remainderSlot = firstEmptyContainerSlot(container, Math.max(...patternSlots) + 1);
      await arrangeItemsInChest(container, bot, cropItem, patternSlots, remainderSlot);
      results.patternPlaced = true;
    } finally {
      container.close();
    }

    return {
      ok: true,
      action: "farm_store_five",
      origin: {
        x: originX,
        y: supportY,
        z: originZ
      },
      results
    };
  });
}

async function fishCookEat(body) {
  return actionManager.run("fish_cook_eat", async (manager) => {
    const bot = requireBot();
    const manualOnly = boolValue(body, "manualOnly", true);
    const range = numberValue(body, "range", 4);
    const useDelayMs = numberValue(body, "useDelayMs", 200);
    const fishTimeoutMs = numberValue(body, "fishTimeoutMs", 45000);
    const fishAttempts = Math.max(1, Math.floor(numberValue(body, "fishAttempts", 8)));
    const searchRadius = numberValue(body, "searchRadius", 96);
    const fishingRodItem = stringValue(body, "fishingRodItem", "fishing_rod");
    const chestItem = stringValue(body, "chestItem", "chest");
    const furnaceItem = stringValue(body, "furnaceItem", "furnace");
    const fuelItem = stringValue(body, "fuelItem", "coal");
    const waterItem = stringValue(body, "waterItem", "water_bucket");
    const rawFishNames = ["cod", "salmon"];
    const cookedFishByRaw = {
      cod: "cooked_cod",
      salmon: "cooked_salmon"
    };
    const inventoryMode = manualOnly ? "creative_manual" : "";

    if (manualOnly && !isCreativeMode(bot)) {
      throw new Error("fish_cook_eat manual mode requires creative mode");
    }

    let originX;
    let originY;
    let originZ;
    if ("x" in body && "y" in body && "z" in body) {
      originX = Math.floor(numberValue(body, "x"));
      originY = Math.floor(numberValue(body, "y"));
      originZ = Math.floor(numberValue(body, "z"));
    } else {
      const found = findFlatBuildOrigin(bot, {
        width: 12,
        depth: 12,
        searchRadius
      });
      originX = found.x;
      originY = found.y;
      originZ = found.z;
    }

    const pondMinX = originX + 2;
    const pondMinZ = originZ + 2;
    const pondSize = 3;
    const chestX = originX + 7;
    const chestY = originY + 1;
    const chestZ = originZ + 2;
    const furnaceX = originX + 7;
    const furnaceY = originY + 1;
    const furnaceZ = originZ + 4;
    const fishingSpot = {
      x: pondMinX + 1,
      y: originY + 1,
      z: pondMinZ + pondSize + 1,
      lookX: pondMinX + 1.5,
      lookY: originY + 0.25,
      lookZ: pondMinZ + 1.5
    };
    const results = {
      pondDug: 0,
      waterPlaced: 0,
      fishAttempts: 0,
      caughtItem: "",
      caughtCounts: {},
      chestPlaced: false,
      storedFish: {},
      furnacePlaced: false,
      smeltedItem: "",
      ateCookedFish: false
    };

    function setProgress(message, extra) {
      manager.setProgress(message, {
        action: "fish_cook_eat",
        origin: {
          x: originX,
          y: originY,
          z: originZ
        },
        ...(extra || {})
      });
    }

    const inventoryOptions = {
      allowCommands: !manualOnly,
      inventoryMode
    };

    setProgress("preparing items");
    await ensureInventoryItem(bot, fishingRodItem, 1, inventoryOptions);
    await ensureInventoryItem(bot, chestItem, 1, inventoryOptions);
    await ensureInventoryItem(bot, furnaceItem, 1, inventoryOptions);
    await ensureInventoryItem(bot, fuelItem, 1, inventoryOptions);
    await ensureInventoryItem(bot, waterItem, 1, inventoryOptions);

    const baseFishCounts = Object.fromEntries(rawFishNames.map((itemName) => [itemName, countInventoryItem(bot, itemName)]));

    setProgress("digging pond");
    for (let dz = 0; dz < pondSize; dz += 1) {
      for (let dx = 0; dx < pondSize; dx += 1) {
        const x = pondMinX + dx;
        const z = pondMinZ + dz;
        const cleared = await clearBlockIfNeeded(bot, x, originY, z, range, useDelayMs);
        if (cleared.cleared) {
          results.pondDug += 1;
        }
      }
    }

    setProgress("filling pond");
    for (let dz = 0; dz < pondSize; dz += 1) {
      for (let dx = 0; dx < pondSize; dx += 1) {
        const x = pondMinX + dx;
        const z = pondMinZ + dz;
        const waterResult = await placeWaterSourceByHand(bot, waterItem, x, originY, z, range, useDelayMs, inventoryOptions);
        if (!waterResult.skipped) {
          results.waterPlaced += 1;
        }
      }
    }

    setProgress("fishing");
    const fishingResult = await fishUntilCookable(bot, {
      fishingSpot,
      maxAttempts: fishAttempts,
      castTimeoutMs: fishTimeoutMs,
      rawFishNames,
      rodItem: fishingRodItem,
      allowCommands: !manualOnly,
      inventoryMode
    });
    results.fishAttempts = fishingResult.attempts;
    results.caughtItem = fishingResult.caughtItem;
    results.caughtCounts = Object.fromEntries(rawFishNames.map((itemName) => [
      itemName,
      Math.max(0, (fishingResult.totals[itemName] || 0) - baseFishCounts[itemName])
    ]));

    const cookRawItem = rawFishNames.find((itemName) => results.caughtCounts[itemName] > 0) || "";
    if (!cookRawItem) {
      throw new Error("failed to catch cookable fish after " + String(results.fishAttempts) + " attempts");
    }

    setProgress("placing chest");
    await clearBlockIfNeeded(bot, chestX, chestY, chestZ, range, useDelayMs);
    await placeBlockByHand(bot, {
      x: chestX,
      y: chestY,
      z: chestZ,
      item: chestItem
    }, {
      range,
      placeDelayMs: useDelayMs,
      replace: false,
      allowCommands: !manualOnly,
      inventoryMode
    });
    results.chestPlaced = true;

    setProgress("storing fish");
    await ensureNear(bot, chestX, chestY, chestZ, range, {
      lookAtBlock: true,
      reach: Math.max(4.5, range)
    });
    const chestBlock = bot.blockAt(new Vec3(chestX, chestY, chestZ));
    if (!chestBlock || chestBlock.name !== "chest") {
      throw new Error("chest block not found at " + blockKey(chestX, chestY, chestZ));
    }

    const container = await bot.openContainer(chestBlock);
    try {
      for (const itemName of rawFishNames) {
        const caughtCount = results.caughtCounts[itemName];
        if (caughtCount > 0) {
          await depositContainerItem(container, bot, itemName, caughtCount);
          results.storedFish[itemName] = caughtCount;
        }
      }
      await withdrawContainerItem(container, bot, cookRawItem, 1);
    } finally {
      container.close();
      await sleep(150);
    }

    setProgress("placing furnace");
    await clearBlockIfNeeded(bot, furnaceX, furnaceY, furnaceZ, range, useDelayMs);
    await placeBlockByHand(bot, {
      x: furnaceX,
      y: furnaceY,
      z: furnaceZ,
      item: furnaceItem
    }, {
      range,
      placeDelayMs: useDelayMs,
      replace: false,
      allowCommands: !manualOnly,
      inventoryMode
    });
    results.furnacePlaced = true;

    setProgress("smelting fish");
    await ensureNear(bot, furnaceX, furnaceY, furnaceZ, range, {
      lookAtBlock: true,
      reach: Math.max(4.5, range)
    });
    const furnaceBlock = bot.blockAt(new Vec3(furnaceX, furnaceY, furnaceZ));
    if (!furnaceBlock || furnaceBlock.name !== furnaceItem) {
      throw new Error("furnace block not found at " + blockKey(furnaceX, furnaceY, furnaceZ));
    }

    const furnace = await bot.openFurnace(furnaceBlock);
    const cookedItem = cookedFishByRaw[cookRawItem];
    try {
      await furnace.putInput(bot.registry.itemsByName[cookRawItem].id, null, 1);
      await furnace.putFuel(bot.registry.itemsByName[fuelItem].id, null, 1);
      const output = await waitForFurnaceOutput(furnace, cookedItem, fishTimeoutMs);
      if (!output || output.name !== cookedItem) {
        throw new Error("furnace did not produce " + cookedItem);
      }
      await furnace.takeOutput();
    } finally {
      furnace.close();
      await sleep(150);
    }
    results.smeltedItem = cookedItem;

    setProgress("eating cooked fish");
    await waitForInventoryItemCount(bot, cookedItem, 1, 5000);
    await equipItemByName(bot, cookedItem);
    await bot.consume();
    results.ateCookedFish = true;

    return {
      ok: true,
      action: "fish_cook_eat",
      origin: {
        x: originX,
        y: originY,
        z: originZ
      },
      pond: {
        x: pondMinX,
        y: originY,
        z: pondMinZ,
        size: pondSize
      },
      chest: {
        x: chestX,
        y: chestY,
        z: chestZ
      },
      furnace: {
        x: furnaceX,
        y: furnaceY,
        z: furnaceZ
      },
      results
    };
  });
}

async function runAction(body) {
  const action = stringValue(body, "action");
  switch (action) {
    case "build_imperial_pagoda":
    case "build-imperial-pagoda":
    case "build_reference_pagoda":
    case "build-reference-pagoda":
    case "build_temple_pagoda":
    case "build-temple-pagoda":
      return buildImperialPagoda(body);
    case "build_rustic_balcony_house":
    case "build-rustic-balcony-house":
    case "build_picture_house":
    case "build-picture-house":
    case "build_reference_house":
    case "build-reference-house":
      return buildRusticBalconyHouse(body);
    case "build_decorated_two_story_house":
    case "build-decorated-two-story-house":
    case "build_two_story_house":
    case "build-two-story-house":
      return buildDecoratedTwoStoryHouse(body);
    case "build_reference_path_chain":
    case "build-reference-path-chain":
    case "build_path_chain":
    case "build-path-chain":
      return buildReferencePathChain(body);
    case "fish_cook_eat":
    case "fish-cook-eat":
    case "pond_fish_smelt_eat":
    case "pond-fish-smelt-eat":
      return fishCookEat(body);
    case "farm_store_five":
    case "farm-store-five":
      return farmStoreFive(body);
    case "place_blocks":
    case "place-blocks":
      return placeBlocks(body);
    case "build_small_house":
    case "build-small-house":
      return buildSmallHouse(body);
    case "plant_and_bonemeal":
    case "plant-and-bonemeal":
      return plantAndBonemeal(body);
    case "move_to":
    case "move-to":
      return moveTo(body);
    default:
      throw new Error("unsupported action: " + action);
  }
}

function getFullStatePayload() {
  if (isModClientDriver()) {
    return {
      ok: true,
      status: getStatusPayload(),
      players: getPlayersPayload(),
      inventory: getInventoryPayload(),
      chat: state.modCache.chat ? clone(state.modCache.chat) : { ok: true, messages: [], typed: [] },
      screen: normalizeModScreenPayload(state.modCache.screen),
      target: normalizeModTargetPayload(state.modCache.target, 6),
      container: normalizeModContainerPayload(state.modCache.container),
      action: actionManager.snapshot(),
      memory: worldMemory.snapshot(),
      agent: agentRuntime.snapshot()
    };
  }

  return {
    ok: true,
    status: getStatusPayload(),
    players: getPlayersPayload(),
    inventory: getInventoryPayload(),
    chat: chatHistory.get(-1, 20),
    action: actionManager.snapshot(),
    memory: worldMemory.snapshot(),
    agent: agentRuntime.snapshot()
  };
}

const server = http.createServer(async (request, response) => {
  if (request.method === "OPTIONS") {
    sendJson(response, 204, {});
    return;
  }

  try {
    const url = new URL(request.url, "http://127.0.0.1");
    if (url.pathname !== "/") {
      ensureToken(request);
    }

    let body = {};
    if (request.method === "POST") {
      body = await parseJsonBody(request);
    }

    if (request.method === "GET" && url.pathname === "/") {
      sendJson(response, 200, {
        ok: true,
        name: "codex-lan-bot",
        mode: "lan-bot",
        bindHost: config.bindHost,
        bindPort: config.bindPort
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/status") {
      sendJson(response, 200, await readStatusPayload());
      return;
    }

    if (request.method === "GET" && url.pathname === "/capabilities") {
      sendJson(response, 200, getCapabilitiesPayload());
      return;
    }

    if (request.method === "GET" && url.pathname === "/agent/status") {
      const id = url.searchParams.get("id") || undefined;
      sendJson(response, 200, agentRuntime.snapshot(id));
      return;
    }

    if (request.method === "GET" && url.pathname === "/agent/sessions") {
      sendJson(response, 200, agentRuntime.snapshot());
      return;
    }

    if (request.method === "GET" && url.pathname === "/agent/prompt") {
      const id = url.searchParams.get("id") || undefined;
      sendJson(response, 200, await agentPrompt({
        id
      }));
      return;
    }

    if (request.method === "GET" && url.pathname === "/full-state") {
      sendJson(response, 200, await readFullStatePayload());
      return;
    }

    if (request.method === "GET" && url.pathname === "/memory") {
      sendJson(response, 200, worldMemory.snapshot());
      return;
    }

    if (request.method === "GET" && url.pathname === "/chat") {
      const since = Number(url.searchParams.get("since") || "-1");
      const limit = Number(url.searchParams.get("limit") || "50");
      sendJson(response, 200, await readChatPayload(since, limit));
      return;
    }

    if (request.method === "GET" && url.pathname === "/players") {
      sendJson(response, 200, await readPlayersPayload());
      return;
    }

    if (request.method === "GET" && url.pathname === "/inventory") {
      sendJson(response, 200, await readInventoryPayload());
      return;
    }

    if (request.method === "GET" && url.pathname === "/screen") {
      sendJson(response, 200, await readScreenPayload());
      return;
    }

    if (request.method === "GET" && url.pathname === "/container") {
      sendJson(response, 200, await readContainerPayload());
      return;
    }

    if (request.method === "GET" && url.pathname === "/target") {
      sendJson(response, 200, await readTargetPayload(Number(url.searchParams.get("maxDistance") || "6")));
      return;
    }

    if (request.method === "GET" && url.pathname === "/block") {
      const x = Math.floor(Number(url.searchParams.get("x")));
      const y = Math.floor(Number(url.searchParams.get("y")));
      const z = Math.floor(Number(url.searchParams.get("z")));
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
        throw new Error("x, y and z query params are required");
      }
      sendJson(response, 200, await readBlockPayload(x, y, z));
      return;
    }

    if (request.method === "GET" && url.pathname === "/debug/fake-player") {
      sendJson(response, 200, await readFakePlayersPayload());
      return;
    }

    if (request.method === "GET" && url.pathname === "/action/status") {
      sendJson(response, 200, actionManager.snapshot());
      return;
    }

    if (request.method === "POST" && url.pathname === "/connect") {
      sendJson(response, 200, await connectBot(body));
      return;
    }

    if (request.method === "POST" && url.pathname === "/disconnect") {
      sendJson(response, 200, disconnectBot());
      return;
    }

    if (request.method === "POST" && url.pathname === "/chat") {
      sendJson(response, 200, await sendChat(body));
      return;
    }

    if (request.method === "POST" && url.pathname === "/agent/start") {
      sendJson(response, 200, await agentStart(body));
      return;
    }

    if (request.method === "POST" && url.pathname === "/agent/message") {
      sendJson(response, 200, await agentMessage(body));
      return;
    }

    if (request.method === "POST" && url.pathname === "/agent/plan") {
      sendJson(response, 200, await agentPlan(body));
      return;
    }

    if (request.method === "POST" && url.pathname === "/agent/autoplan") {
      sendJson(response, 200, await agentAutoplan(body));
      return;
    }

    if (request.method === "POST" && url.pathname === "/agent/run") {
      sendJson(response, 200, await agentRun(body));
      return;
    }

    if (request.method === "POST" && url.pathname === "/agent/step") {
      sendJson(response, 200, await agentStep(body));
      return;
    }

    if (request.method === "POST" && url.pathname === "/agent/stop") {
      sendJson(response, 200, await agentStop(body));
      return;
    }

    if (request.method === "POST" && url.pathname === "/memory/note") {
      sendJson(response, 200, await executeDirectCommand("memory_note", body, {
        scope: buildWorkflowScope("memory_note")
      }));
      return;
    }

    if (request.method === "POST" && url.pathname === "/memory/waypoint") {
      sendJson(response, 200, await executeDirectCommand("memory_waypoint", body, {
        scope: buildWorkflowScope("memory_waypoint")
      }));
      return;
    }

    if (request.method === "POST" && url.pathname === "/memory/context") {
      sendJson(response, 200, await executeDirectCommand("memory_context", body, {
        scope: buildWorkflowScope("memory_context")
      }));
      return;
    }

    if (request.method === "POST" && url.pathname === "/hotbar") {
      sendJson(response, 200, await setHotbar(body));
      return;
    }

    if (request.method === "POST" && url.pathname === "/equip") {
      sendJson(response, 200, await equipItem(body));
      return;
    }

    if (request.method === "POST" && url.pathname === "/move/to") {
      sendJson(response, 200, await moveTo(body));
      return;
    }

    if (request.method === "POST" && url.pathname === "/look/at") {
      sendJson(response, 200, await lookAt(body));
      return;
    }

    if (request.method === "POST" && url.pathname === "/use/item") {
      sendJson(response, 200, await useItem(body));
      return;
    }

    if (request.method === "POST" && url.pathname === "/input") {
      sendJson(response, 200, await setInputCommand(body));
      return;
    }

    if (request.method === "POST" && url.pathname === "/tap") {
      sendJson(response, 200, await tapKeyCommand(body));
      return;
    }

    if (request.method === "POST" && url.pathname === "/release-all") {
      sendJson(response, 200, await releaseAllCommand(body));
      return;
    }

    if (request.method === "POST" && url.pathname === "/interact/item") {
      sendJson(response, 200, await useItem(body));
      return;
    }

    if (request.method === "POST" && url.pathname === "/interact/block") {
      sendJson(response, 200, await interactBlockCommand(body));
      return;
    }

    if (request.method === "POST" && url.pathname === "/gui/click") {
      sendJson(response, 200, await guiClickCommand(body));
      return;
    }

    if (request.method === "POST" && url.pathname === "/gui/release") {
      sendJson(response, 200, await guiReleaseCommand(body));
      return;
    }

    if (request.method === "POST" && url.pathname === "/gui/scroll") {
      sendJson(response, 200, await guiScrollCommand(body));
      return;
    }

    if (request.method === "POST" && url.pathname === "/gui/key") {
      sendJson(response, 200, await guiKeyCommand(body));
      return;
    }

    if (request.method === "POST" && url.pathname === "/gui/type") {
      sendJson(response, 200, await guiTypeCommand(body));
      return;
    }

    if (request.method === "POST" && url.pathname === "/gui/click-widget") {
      sendJson(response, 200, await guiClickWidgetCommand(body));
      return;
    }

    if (request.method === "POST" && url.pathname === "/gui/close") {
      sendJson(response, 200, await guiCloseCommand(body));
      return;
    }

    if (request.method === "POST" && url.pathname === "/screenshot") {
      sendJson(response, 200, await screenshotCommand(body));
      return;
    }

    if (request.method === "POST" && url.pathname === "/debug/fake-player/spawn") {
      sendJson(response, 200, await debugFakePlayerSpawnCommand(body));
      return;
    }

    if (request.method === "POST" && url.pathname === "/debug/fake-player/move") {
      sendJson(response, 200, await debugFakePlayerMoveCommand(body));
      return;
    }

    if (request.method === "POST" && url.pathname === "/debug/fake-player/remove") {
      sendJson(response, 200, await debugFakePlayerRemoveCommand(body));
      return;
    }

    if (request.method === "POST" && url.pathname === "/place") {
      sendJson(response, 200, await placeItem(body));
      return;
    }

    if (request.method === "POST" && (url.pathname === "/control/run" || url.pathname === "/command/run")) {
      sendJson(response, 200, await runDirectControl(body));
      return;
    }

    if (request.method === "POST" && (url.pathname === "/workflow/run" || url.pathname === "/sequence/run")) {
      sendJson(response, 200, await runWorkflow(body));
      return;
    }

    if (request.method === "POST" && url.pathname === "/action/run") {
      sendJson(response, 200, await runAction(body));
      return;
    }

    if (request.method === "POST" && url.pathname === "/action/cancel") {
      sendJson(response, 200, actionManager.cancel());
      return;
    }

    sendJson(response, 404, {
      ok: false,
      error: "not found"
    });
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    const statusCode = message === "unauthorized" ? 401 : 400;
    sendJson(response, statusCode, {
      ok: false,
      error: message
    });
  }
});

realtimeHub = new RealtimeHub(server, {
  authenticate(request, url) {
    const headerToken = request.headers["x-auth-token"];
    const queryToken = url.searchParams.get("token");
    ensureProvidedToken(headerToken || queryToken || "");
  },
  getCapabilities() {
    return getCapabilitiesPayload();
  },
  onConnect(client) {
    realtimeHub.send(client.id, {
      type: "event",
      channel: "status",
      payload: getStatusPayload()
    });
    realtimeHub.send(client.id, {
      type: "event",
      channel: "agent",
      payload: agentRuntime.snapshot()
    });
    realtimeHub.send(client.id, {
      type: "event",
      channel: "memory",
      payload: {
        type: "memory",
        summary: worldMemory.summary()
      }
    });
  },
  onMessage(client, message) {
    return handleRealtimeMessage(client, message);
  }
});

server.listen(config.bindPort, config.bindHost, () => {
  logMessage("codex-lan-bot listening on http://" + config.bindHost + ":" + config.bindPort, "System");
  logMessage("config file: " + configPath, "System");
});
