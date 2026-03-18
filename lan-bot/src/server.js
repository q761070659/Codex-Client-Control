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

async function ensureInventoryItem(bot, itemName, minimumCount) {
  const requiredCount = Math.max(1, Math.floor(minimumCount || 1));
  const current = bot.inventory.items()
    .filter((item) => item.name === itemName)
    .reduce((sum, item) => sum + item.count, 0);

  if (current >= requiredCount) {
    return current;
  }

  bot.chat("/give " + bot.username + " " + itemName + " " + String(Math.max(requiredCount, 64)));
  await sleep(400);

  const updated = bot.inventory.items()
    .filter((item) => item.name === itemName)
    .reduce((sum, item) => sum + item.count, 0);

  if (updated < requiredCount) {
    throw new Error("failed to obtain item: " + itemName);
  }

  return updated;
}

function getPlacementSupport(bot, x, y, z) {
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

  const support = getPlacementSupport(bot, x, y, z);
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

async function runAction(body) {
  const action = stringValue(body, "action");
  switch (action) {
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
