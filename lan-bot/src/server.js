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

async function connectBot(body) {
  if (state.connecting) {
    throw new Error("connection already in progress");
  }
  if (state.bot && state.connected) {
    return getStatusPayload();
  }

  const options = await resolveConnectOptions(body);
  const createOptions = {
    host: options.host,
    port: options.port,
    username: options.username,
    auth: options.auth
  };

  if (options.version && options.version !== "auto") {
    createOptions.version = options.version;
  }

  state.connecting = true;
  state.lastError = "";
  state.lastDisconnect = "";

  const bot = mineflayer.createBot(createOptions);
  state.bot = bot;
  attachBotListeners(bot, options);

  try {
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
        reject(new Error("connect timeout after " + options.connectTimeoutMs + "ms"));
      }, options.connectTimeoutMs);

      bot.once("spawn", onSpawn);
      bot.once("error", onError);
      bot.once("end", onEnd);
    });
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

async function ensureInventoryItem(bot, itemName, minimumCount) {
  const requiredCount = Math.max(1, Math.floor(minimumCount || 1));
  const stackSize = getItemStackSize(bot, itemName);
  let current = countInventoryItem(bot, itemName);

  if (current >= requiredCount) {
    return current;
  }

  let stalledBatches = 0;
  while (current < requiredCount && stalledBatches < 3) {
    const missing = requiredCount - current;
    const giveCount = Math.max(1, Math.min(missing, stackSize));
    const previous = current;
    await runBotCommand(bot, "/give " + bot.username + " " + itemName + " " + String(giveCount));

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

function getPlacementSupport(bot, x, y, z, preferredSupport) {
  if (preferredSupport &&
    preferredSupport.position &&
    preferredSupport.face &&
    preferredSupport.position.x + preferredSupport.face.x === x &&
    preferredSupport.position.y + preferredSupport.face.y === y &&
    preferredSupport.position.z + preferredSupport.face.z === z) {
    const preferredBlock = bot.blockAt(preferredSupport.position);
    if (!isAir(preferredBlock)) {
      return {
        block: preferredBlock,
        face: preferredSupport.face
      };
    }
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
    const block = bot.blockAt(candidate.support);
    if (!isAir(block)) {
      return {
        block,
        face: candidate.face
      };
    }
  }

  return null;
}

async function placeBlockByHand(bot, placement, options) {
  const x = placement.x;
  const y = placement.y;
  const z = placement.z;
  const item = placement.item;
  const range = options.range;
  const placeDelayMs = options.placeDelayMs;
  const replace = options.replace;
  const preferredSupport = options.preferredSupport || null;

  await ensureInventoryItem(bot, item, 1);

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

  const support = getPlacementSupport(bot, x, y, z, preferredSupport);
  if (!support) {
    throw new Error("no support block near " + blockKey(x, y, z));
  }

  await ensureNear(bot, x, y, z, range);
  await equipItemByName(bot, item);
  await bot.lookAt(new Vec3(x + 0.5, y + 0.5, z + 0.5), true);
  try {
    await bot.placeBlock(support.block, support.face);
  } catch (error) {
    await sleep(placeDelayMs);
    const afterError = bot.blockAt(targetPos);
    if (!afterError || afterError.name !== item) {
      throw error;
    }
  }
  await sleep(placeDelayMs);

  const placed = bot.blockAt(targetPos);
  if (!placed || placed.name !== item) {
    throw new Error("place verification failed at " + blockKey(x, y, z) + ", got " + (placed ? placed.name : "air"));
  }

  return {
    x,
    y,
    z,
    item,
    placed: true,
    skipped: false,
    finalBlock: placed.name
  };
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
      finalBlock: existing.name
    };
  }

  if (!isAir(existing)) {
    throw new Error("water target occupied at " + blockKey(x, y, z) + " by " + existing.name);
  }

  const supportBlock = bot.blockAt(new Vec3(x, y - 1, z));
  if (!supportBlock || isAir(supportBlock)) {
    throw new Error("water support missing at " + blockKey(x, y - 1, z));
  }

  await ensureInventoryItem(bot, itemName, 1);
  await ensureNear(bot, x, y, z, range);
  await equipItemByName(bot, itemName);
  await bot.activateBlock(supportBlock, new Vec3(0, 1, 0), new Vec3(0.5, 1, 0.5));

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
        finalBlock: placed.name
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
  const firstPos = new Vec3(firstPlacement.x, firstPlacement.y, firstPlacement.z);
  const secondPos = new Vec3(secondPlacement.x, secondPlacement.y, secondPlacement.z);
  const preferredSupport = {
    position: firstPos,
    face: new Vec3(
      secondPlacement.x - firstPlacement.x,
      secondPlacement.y - firstPlacement.y,
      secondPlacement.z - firstPlacement.z
    )
  };

  await placeBlockByHand(bot, firstPlacement, {
    range,
    placeDelayMs,
    replace: false
  });

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const secondBlock = bot.blockAt(secondPos);
    if (!secondBlock || secondBlock.name !== secondPlacement.item) {
      await placeBlockByHand(bot, secondPlacement, {
        range,
        placeDelayMs,
        replace: false,
        preferredSupport
      });
    }

    if (await isDoubleChestContainer(bot, firstPlacement.x, firstPlacement.y, firstPlacement.z, range)) {
      return {
        placed: true,
        merged: true
      };
    }

    const retryBlock = bot.blockAt(secondPos);
    if (retryBlock && retryBlock.name === secondPlacement.item) {
      await ensureNear(bot, secondPlacement.x, secondPlacement.y, secondPlacement.z, range);
      await bot.dig(retryBlock, true);
      await sleep(placeDelayMs);
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

  await ensureNear(bot, x, y, z, numberValue(body, "range", 4));
  await equipItemByName(bot, itemName);

  const support = bot.blockAt(new Vec3(x, y - 1, z));
  if (!support || isAir(support)) {
    throw new Error("support block missing at " + x + "," + (y - 1) + "," + z);
  }

  await bot.lookAt(new Vec3(x + 0.5, y + 0.5, z + 0.5), true);
  await bot.placeBlock(support, new Vec3(0, 1, 0));
  await sleep(200);

  const placed = bot.blockAt(new Vec3(x, y, z));
  return {
    ok: true,
    placed: placed ? placed.name : ""
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
          supportTargets.push({ x: originX + dx, y: supportY, z: originZ + dz });
        }
      }
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

    const centerSupport = bot.blockAt(new Vec3(centerX, supportY, centerZ));
    if (!centerSupport || isAir(centerSupport)) {
      throw new Error("farm center support missing at " + blockKey(centerX, supportY, centerZ));
    }

    await clearBlockIfNeeded(bot, centerX, cropY, centerZ, range, useDelayMs, ["water"]);
    await placeWaterSourceByHand(bot, waterItem, centerX, cropY, centerZ, range, useDelayMs);
    results.waterPlaced = true;

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
