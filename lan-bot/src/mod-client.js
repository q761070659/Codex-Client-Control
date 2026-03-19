"use strict";

const fs = require("fs");
const http = require("http");
const path = require("path");

function parseProperties(text) {
  const result = {};
  for (const rawLine of String(text || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith("!")) {
      continue;
    }

    const separatorIndex = line.search(/[:=]/);
    if (separatorIndex < 0) {
      result[line] = "";
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    const value = line.slice(separatorIndex + 1).trim();
    if (key) {
      result[key] = value;
    }
  }
  return result;
}

function readPropertiesFile(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    return {};
  }
  return parseProperties(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""));
}

function toPositiveInt(...values) {
  for (const value of values) {
    const parsed = Number(value);
    if (Number.isInteger(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return 0;
}

function firstNonEmptyString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return "";
}

function fileModifiedMs(filePath) {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch (error) {
    return 0;
  }
}

function listDetectedConfigCandidates(rootDir) {
  const candidates = [];
  const rootConfigPath = path.join(rootDir, "config", "codex-client-control.properties");
  if (fs.existsSync(rootConfigPath)) {
    candidates.push({
      configPath: rootConfigPath,
      bootstrapLogPath: path.join(rootDir, "codex-client-control-bootstrap.log"),
      modifiedMs: fileModifiedMs(rootConfigPath)
    });
  }

  const versionsDir = path.join(rootDir, "versions");
  if (!fs.existsSync(versionsDir)) {
    return candidates;
  }

  for (const entry of fs.readdirSync(versionsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const versionDir = path.join(versionsDir, entry.name);
    const configPath = path.join(versionDir, "config", "codex-client-control.properties");
    if (!fs.existsSync(configPath)) {
      continue;
    }

    candidates.push({
      configPath,
      bootstrapLogPath: path.join(versionDir, "codex-client-control-bootstrap.log"),
      modifiedMs: fileModifiedMs(configPath)
    });
  }

  candidates.sort((left, right) => right.modifiedMs - left.modifiedMs);
  return candidates;
}

function detectModClientLocation(rootDir, preferredConfigPath) {
  if (preferredConfigPath) {
    return {
      configPath: preferredConfigPath,
      bootstrapLogPath: path.join(path.dirname(path.dirname(preferredConfigPath)), "codex-client-control-bootstrap.log")
    };
  }

  const candidates = listDetectedConfigCandidates(rootDir);
  return candidates.length > 0 ? candidates[0] : null;
}

function normalizeOverrides(override) {
  if (!override || typeof override !== "object" || Array.isArray(override)) {
    return {};
  }
  return override;
}

function resolveModClientOptions(rootDir, configured, override) {
  const safeConfigured = normalizeOverrides(configured);
  const safeOverride = normalizeOverrides(override);
  const detected = detectModClientLocation(rootDir, firstNonEmptyString(safeOverride.configPath, safeConfigured.configPath));
  const properties = detected ? readPropertiesFile(detected.configPath) : {};

  const host = firstNonEmptyString(
    safeOverride.host,
    safeConfigured.host,
    properties.host,
    "127.0.0.1"
  );
  const port = toPositiveInt(
    safeOverride.port,
    safeConfigured.port,
    properties.port
  );
  const token = firstNonEmptyString(
    safeOverride.token,
    safeConfigured.token,
    properties.token
  );
  const configPath = firstNonEmptyString(
    safeOverride.configPath,
    safeConfigured.configPath,
    detected ? detected.configPath : ""
  );
  const bootstrapLogPath = firstNonEmptyString(
    safeOverride.bootstrapLogPath,
    safeConfigured.bootstrapLogPath,
    detected ? detected.bootstrapLogPath : ""
  );

  if (!port) {
    throw new Error("mod-client port is not configured");
  }
  if (!token) {
    throw new Error("mod-client token is not configured");
  }

  return {
    host,
    port,
    token,
    configPath,
    bootstrapLogPath
  };
}

function createModClient(rootDir, configured, override) {
  const options = resolveModClientOptions(rootDir, configured, override);
  const keepAliveAgent = new http.Agent({
    keepAlive: true,
    keepAliveMsecs: 1000,
    maxSockets: 4
  });

  async function request(method, pathname, body, query) {
    const url = new URL("http://" + options.host + ":" + String(options.port) + pathname);
    const search = query && typeof query === "object" ? query : {};
    for (const [key, value] of Object.entries(search)) {
      if (typeof value === "undefined" || value === null || value === "") {
        continue;
      }
      url.searchParams.set(key, String(value));
    }

    const payload = typeof body === "undefined" ? null : Buffer.from(JSON.stringify(body), "utf8");

    return new Promise((resolve, reject) => {
      const requestOptions = {
        method,
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        agent: keepAliveAgent,
        headers: {
          "X-Auth-Token": options.token,
          "Accept": "application/json"
        }
      };

      if (payload) {
        requestOptions.headers["Content-Type"] = "application/json; charset=utf-8";
        requestOptions.headers["Content-Length"] = payload.length;
      }

      const req = http.request(requestOptions, (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let parsed = {};
          if (text.length > 0) {
            try {
              parsed = JSON.parse(text);
            } catch (error) {
              reject(new Error("invalid mod-client response from " + pathname));
              return;
            }
          }

          if ((res.statusCode || 500) >= 400) {
            const message = parsed && parsed.error ? parsed.error : ("mod-client request failed: " + pathname);
            const failure = new Error(message);
            failure.statusCode = res.statusCode || 500;
            reject(failure);
            return;
          }

          resolve(parsed);
        });
      });

      req.setTimeout(5000, () => {
        req.destroy(new Error("mod-client request timed out: " + pathname));
      });
      req.on("error", reject);

      if (payload) {
        req.write(payload);
      }
      req.end();
    });
  }

  return {
    options,
    close() {
      keepAliveAgent.destroy();
    },
    request,
    status() {
      return request("GET", "/status");
    },
    fullState() {
      return request("GET", "/full-state");
    },
    readChat(params) {
      return request("GET", "/chat", undefined, params);
    },
    screen() {
      return request("GET", "/screen");
    },
    target(params) {
      return request("GET", "/target", undefined, params);
    },
    container() {
      return request("GET", "/container");
    },
    players() {
      return request("GET", "/players");
    },
    inventory() {
      return request("GET", "/inventory");
    },
    sendChat(message) {
      return request("POST", "/chat", { message });
    },
    look(payload) {
      return request("POST", "/look", payload || {});
    },
    hotbar(slot) {
      return request("POST", "/hotbar", { slot });
    },
    input(payload) {
      return request("POST", "/input", payload || {});
    },
    tap(key, durationMs) {
      return request("POST", "/tap", {
        key,
        durationMs
      });
    },
    releaseAll() {
      return request("POST", "/release-all", {});
    },
    interactItem(hand) {
      return request("POST", "/interact/item", {
        hand
      });
    },
    interactBlock(payload) {
      return request("POST", "/interact/block", payload || {});
    },
    guiClose() {
      return request("POST", "/gui/close", {});
    },
    guiClick(payload) {
      return request("POST", "/gui/click", payload || {});
    },
    guiRelease(payload) {
      return request("POST", "/gui/release", payload || {});
    },
    guiScroll(payload) {
      return request("POST", "/gui/scroll", payload || {});
    },
    guiKey(payload) {
      return request("POST", "/gui/key", payload || {});
    },
    guiType(text) {
      return request("POST", "/gui/type", {
        text
      });
    },
    guiClickWidget(payload) {
      return request("POST", "/gui/click-widget", payload || {});
    },
    screenshot(name) {
      return request("POST", "/screenshot", name ? { name } : {});
    },
    listFakePlayers() {
      return request("GET", "/debug/fake-player");
    },
    spawnFakePlayer(payload) {
      return request("POST", "/debug/fake-player/spawn", payload || {});
    },
    moveFakePlayer(payload) {
      return request("POST", "/debug/fake-player/move", payload || {});
    },
    removeFakePlayer(name) {
      return request("POST", "/debug/fake-player/remove", {
        name
      });
    }
  };
}

module.exports = {
  createModClient,
  resolveModClientOptions
};
