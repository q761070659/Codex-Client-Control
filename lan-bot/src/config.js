"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

function findMinecraftRoot(startDir) {
  let current = path.resolve(startDir);
  while (true) {
    if (path.basename(current).toLowerCase() === ".minecraft") {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return path.resolve(startDir);
    }
    current = parent;
  }
}

function defaultConfig() {
  return {
    bindHost: "127.0.0.1",
    bindPort: 47863,
    token: crypto.randomUUID(),
    agent: {
      maxSessions: 8,
      autoSaveDebounceMs: 200,
      systemPrompt: "You are Codex LAN Agent. Observe Minecraft state, remember important places and objects, and respond with compact JSON plans that use the available direct commands.",
      llm: {
        enabled: false,
        provider: "openai_compatible",
        baseUrl: "",
        model: "",
        apiKeyEnv: "OPENAI_API_KEY",
        headers: {}
      }
    },
    bot: {
      driver: "auto",
      host: "127.0.0.1",
      port: -1,
      username: "CodexLanBot",
      auth: "offline",
      version: "auto",
      connectTimeoutMs: 20000
    },
    modClient: {
      host: "",
      port: 0,
      token: "",
      configPath: "",
      bootstrapLogPath: ""
    }
  };
}

function resolveConfigInfo(startDir) {
  const rootDir = findMinecraftRoot(startDir);
  return {
    rootDir,
    configPath: path.join(rootDir, "config", "codex-lan-bot.json")
  };
}

function loadConfig(startDir) {
  const info = resolveConfigInfo(startDir);
  const defaults = defaultConfig();

  fs.mkdirSync(path.dirname(info.configPath), { recursive: true });

  if (!fs.existsSync(info.configPath)) {
    fs.writeFileSync(info.configPath, JSON.stringify(defaults, null, 2));
    return { ...info, config: defaults };
  }

  const raw = fs.readFileSync(info.configPath, "utf8").replace(/^\uFEFF/, "");
  const parsed = JSON.parse(raw);
  const config = {
    ...defaults,
    ...parsed,
    agent: {
      ...defaults.agent,
      ...(parsed.agent || {}),
      llm: {
        ...defaults.agent.llm,
        ...((parsed.agent && parsed.agent.llm) || {})
      }
    },
    bot: {
      ...defaults.bot,
      ...(parsed.bot || {})
    },
    modClient: {
      ...defaults.modClient,
      ...(parsed.modClient || {})
    }
  };

  if (!config.token) {
    config.token = crypto.randomUUID();
  }

  fs.writeFileSync(info.configPath, JSON.stringify(config, null, 2));
  return { ...info, config };
}

function saveConfig(configPath, config) {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
}

module.exports = {
  loadConfig,
  saveConfig
};
