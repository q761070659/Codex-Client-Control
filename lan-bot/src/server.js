"use strict";

const fs = require("fs");
const http = require("http");
const path = require("path");
const { URL } = require("url");

const mineflayer = require("mineflayer");
const mc = require("minecraft-protocol");
const { pathfinder, Movements, goals } = require("mineflayer-pathfinder");
const vec3Module = require("vec3");

const ChatHistory = require("./chat-history");
const ActionManager = require("./action-manager");
const { loadConfig, saveConfig } = require("./config");

const Vec3 = typeof vec3Module === "function" ? vec3Module : vec3Module.Vec3;
const AIR_BLOCKS = new Set(["air", "cave_air", "void_air"]);

const loaded = loadConfig(process.cwd());
const rootDir = loaded.rootDir;
const configPath = loaded.configPath;
const config = loaded.config;

const chatHistory = new ChatHistory();
const actionManager = new ActionManager();

const state = {
  bot: null,
  botOptions: null,
  connected: false,
  connecting: false,
  spawned: false,
  lastError: "",
  lastDisconnect: ""
};

actionManager.setCancelHook(() => {
  if (state.bot && state.bot.pathfinder) {
    try {
      state.bot.pathfinder.stop();
    } catch (error) {
      // ignore
    }
  }
});

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function nowIso() {
  return new Date().toISOString();
}

function logMessage(text, tag) {
  chatHistory.add(text, tag);
  const line = "[" + nowIso() + "] [" + tag + "] " + text;
  if (tag === "Error") {
    console.error(line);
    return;
  }
  console.log(line);
}

function requireBot() {
  if (!state.bot || !state.connected || !state.spawned) {
    throw new Error("bot is not connected");
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

async function resolveConnectOptions(body) {
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

function cleanupBot(bot) {
  if (state.bot !== bot) {
    return;
  }
  state.bot = null;
  state.connected = false;
  state.connecting = false;
  state.spawned = false;
}

function attachBotListeners(bot, options) {
  bot.loadPlugin(pathfinder);

  bot.once("login", () => {
    state.connected = true;
    state.botOptions = options;
    logMessage("logged in as " + bot.username, "System");
  });

  bot.once("spawn", () => {
    state.spawned = true;
    logMessage("spawned in world", "System");
  });

  bot.on("messagestr", (message) => {
    if (typeof message === "string" && message.length > 0) {
      chatHistory.add(message, "Chat");
    }
  });

  bot.on("whisper", (username, message) => {
    chatHistory.add("[whisper] <" + username + "> " + message, "Chat");
  });

  bot.on("error", (error) => {
    state.lastError = error && error.message ? error.message : String(error);
    logMessage(state.lastError, "Error");
  });

  bot.on("kicked", (reason) => {
    const text = typeof reason === "string" ? reason : JSON.stringify(reason);
    state.lastDisconnect = text;
    logMessage("kicked: " + text, "Error");
  });

  bot.on("end", (reason) => {
    state.lastDisconnect = reason || "connection ended";
    logMessage("disconnected: " + state.lastDisconnect, "System");
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

async function connectBot(body) {
  if (state.connecting) {
    throw new Error("connection already in progress");
  }
  if (state.bot && state.connected) {
    return getStatusPayload();
  }

  const options = await resolveConnectOptions(body);
  const createOptions = buildCreateOptions(options);

  state.connecting = true;
  state.lastError = "";
  state.lastDisconnect = "";

  const bot = mineflayer.createBot(createOptions);
  state.bot = bot;
  attachBotListeners(bot, options);

  try {
    await waitForBotSpawn(bot, options.connectTimeoutMs);
  } catch (error) {
    cleanupBot(bot);
    throw error;
  } finally {
    state.connecting = false;
  }

  config.bot = {
    ...config.bot,
    ...options
  };
  saveConfig(configPath, config);
  return getStatusPayload();
}

function disconnectBot() {
  if (!state.bot) {
    return {
      ok: true,
      disconnected: true
    };
  }
  const bot = state.bot;
  actionManager.cancel();
  bot.quit("codex disconnect");
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
  if (!state.bot || !state.connected || !state.spawned) {
    return {
      ok: true,
      connected: false,
      selectedHotbarSlot: 0,
      items: []
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
  if (!state.bot || !state.connected || !state.spawned) {
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
  if (!state.bot || !state.connected || !state.spawned) {
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

  let properties = {};
  if (typeof block.getProperties === "function") {
    properties = block.getProperties() || {};
  }

  return {
    ok: true,
    connected: true,
    block: {
      x,
      y,
      z,
      name: block.name,
      displayName: block.displayName || block.name,
      stateId: block.stateId,
      type: block.type,
      isAir: isAir(block),
      properties
    }
  };
}

function getStatusPayload() {
  const payload = {
    ok: true,
    mode: "lan-bot",
    connected: Boolean(state.bot && state.connected && state.spawned),
    connecting: state.connecting,
    bot: {
      username: state.botOptions ? state.botOptions.username : config.bot.username,
      host: state.botOptions ? state.botOptions.host : config.bot.host,
      port: state.botOptions ? state.botOptions.port : config.bot.port,
      auth: state.botOptions ? state.botOptions.auth : config.bot.auth,
      version: state.botOptions ? state.botOptions.version : config.bot.version
    },
    action: actionManager.snapshot()
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
  payload.health = Number(bot.health.toFixed(2));
  payload.food = bot.food;
  payload.dimension = bot.game.dimension;
  payload.gamemode = bot.game.gameMode;
  payload.selectedHotbarSlot = typeof bot.quickBarSlot === "number" ? bot.quickBarSlot + 1 : 0;
  payload.heldItem = itemPayload(bot.heldItem);
  return payload;
}

async function sendChat(body) {
  const bot = requireBot();
  const message = stringValue(body, "message");
  chatHistory.addTyped(message);
  bot.chat(message);
  return {
    ok: true,
    sent: true
  };
}

async function setHotbar(body) {
  const bot = requireBot();
  const slot = numberValue(body, "slot");
  const zeroBasedSlot = Math.floor(slot) - 1;
  if (zeroBasedSlot < 0 || zeroBasedSlot > 8) {
    throw new Error("slot must be between 1 and 9");
  }
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

async function ensureNear(bot, x, y, z, range) {
  const distance = bot.entity.position.distanceTo(new Vec3(x, y, z));
  if (distance <= range) {
    return;
  }

  const movements = new Movements(bot);
  movements.allowSprinting = true;
  bot.pathfinder.setMovements(movements);
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

  if (current >= requiredCount) {
    return current;
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
      await ensureNear(bot, x + offset.dx, y, z + offset.dz, 1);
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

async function placeBlockByHand(bot, placement, options) {
  const x = placement.x;
  const y = placement.y;
  const z = placement.z;
  const item = placement.item;
  const range = options.range;
  const placeDelayMs = options.placeDelayMs;
  const replace = options.replace;
  const preferredSupport = placement.preferredSupport || options.preferredSupport || null;
  const skipInventoryCheck = Boolean(options.skipInventoryCheck);
  const inventoryOptions = options.commandBot ? { commandBot: options.commandBot } : null;
  const placeOptions = {
    ...(placement.placeOptions || {}),
    ...(options.placeOptions || {})
  };

  if (!skipInventoryCheck) {
    await ensureInventoryItem(bot, item, 1, inventoryOptions);
  }

  const targetPos = new Vec3(x, y, z);
  const existing = bot.blockAt(targetPos);
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

  if (!isAir(existing)) {
    if (!replace) {
      throw new Error("target occupied at " + blockKey(x, y, z) + " by " + existing.name);
    }
    await ensureNear(bot, x, y, z, range);
    await bot.dig(existing, true);
    await sleep(150);
  }

  const supports = getPlacementSupportCandidates(bot, x, y, z, preferredSupport);
  if (supports.length === 0) {
    throw new Error("no support block near " + blockKey(x, y, z));
  }

  await ensureNear(bot, x, y, z, range);

  let lastError = null;
  for (const support of supports) {
    await ensureNear(bot, x, y, z, range);
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
}

async function clearBlockIfNeeded(bot, x, y, z, range, delayMs) {
  const position = new Vec3(x, y, z);
  const block = bot.blockAt(position);
  if (isAir(block)) {
    return {
      cleared: false,
      finalBlock: "air"
    };
  }

  await ensureNear(bot, x, y, z, range);
  await bot.dig(block, true);
  await sleep(delayMs);
  return {
    cleared: true,
    finalBlock: "air"
  };
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

async function placeWaterSourceByHand(bot, itemName, x, y, z, range, delayMs) {
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

  try {
    await ensureInventoryItem(bot, itemName, 1);
    await ensureNear(bot, x, y, z, range);
    await equipItemByName(bot, itemName);
    try {
      if (typeof bot._placeBlockWithOptions === "function") {
        await bot._placeBlockWithOptions(supportBlock, new Vec3(0, 1, 0), {
          delta: new Vec3(0.5, 1, 0.5),
          forceLook: true,
          swingArm: "right"
        });
      } else {
        await bot.activateBlock(supportBlock, new Vec3(0, 1, 0), new Vec3(0.5, 1, 0.5));
      }
    } catch (error) {
      const placedAfterError = bot.blockAt(targetPos);
      if (!placedAfterError || placedAfterError.name !== "water") {
        throw error;
      }
    }

    for (let attempt = 0; attempt < 12; attempt += 1) {
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
          method: "bucket"
        };
      }
    }
  } catch (error) {
    // fall through to ice fallback
  }

  const iceItem = "ice";
  await ensureInventoryItem(bot, iceItem, 1);
  await placeBlockByHand(bot, { x, y, z, item: iceItem }, {
    range,
    placeDelayMs: delayMs,
    replace: false
  });

  const iceBlock = bot.blockAt(targetPos);
  if (!iceBlock || iceBlock.name !== iceItem) {
    throw new Error("failed to place ice at " + blockKey(x, y, z));
  }

  await ensureNear(bot, x, y, z, range);
  await bot.dig(iceBlock, true);
  for (let attempt = 0; attempt < 12; attempt += 1) {
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
        method: "ice"
      };
    }
  }

  throw new Error("failed to place water at " + blockKey(x, y, z));
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

async function moveTo(body) {
  return actionManager.run("move_to", async () => {
    const bot = requireBot();
    const x = numberValue(body, "x");
    const y = numberValue(body, "y");
    const z = numberValue(body, "z");
    const range = numberValue(body, "range", 1);

    await ensureNear(bot, x, y, z, range);
    return {
      ok: true,
      x,
      y,
      z,
      range
    };
  });
}

async function lookAt(body) {
  const bot = requireBot();
  const x = numberValue(body, "x");
  const y = numberValue(body, "y");
  const z = numberValue(body, "z");
  const force = boolValue(body, "force", true);

  await bot.lookAt(new Vec3(x, y, z), force);
  return {
    ok: true,
    lookedAt: { x, y, z }
  };
}

async function useItem(body) {
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

    const waterResult = await placeWaterSourceByHand(bot, waterItem, centerX, waterY, centerZ, range, useDelayMs);
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
  return {
    ok: true,
    status: getStatusPayload(),
    players: getPlayersPayload(),
    inventory: getInventoryPayload(),
    chat: chatHistory.get(-1, 20),
    action: actionManager.snapshot()
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
      sendJson(response, 200, getStatusPayload());
      return;
    }

    if (request.method === "GET" && url.pathname === "/full-state") {
      sendJson(response, 200, getFullStatePayload());
      return;
    }

    if (request.method === "GET" && url.pathname === "/chat") {
      const since = Number(url.searchParams.get("since") || "-1");
      const limit = Number(url.searchParams.get("limit") || "50");
      sendJson(response, 200, chatHistory.get(since, limit));
      return;
    }

    if (request.method === "GET" && url.pathname === "/players") {
      sendJson(response, 200, getPlayersPayload());
      return;
    }

    if (request.method === "GET" && url.pathname === "/inventory") {
      sendJson(response, 200, getInventoryPayload());
      return;
    }

    if (request.method === "GET" && url.pathname === "/block") {
      const x = Math.floor(Number(url.searchParams.get("x")));
      const y = Math.floor(Number(url.searchParams.get("y")));
      const z = Math.floor(Number(url.searchParams.get("z")));
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
        throw new Error("x, y and z query params are required");
      }
      sendJson(response, 200, getBlockPayload(x, y, z));
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

    if (request.method === "POST" && url.pathname === "/place") {
      sendJson(response, 200, await placeItem(body));
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

server.listen(config.bindPort, config.bindHost, () => {
  logMessage("codex-lan-bot listening on http://" + config.bindHost + ":" + config.bindPort, "System");
  logMessage("config file: " + configPath, "System");
});
