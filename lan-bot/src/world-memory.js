"use strict";

const fs = require("fs");
const path = require("path");

function nowIso() {
  return new Date().toISOString();
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function limitArray(array, maxItems) {
  if (!Array.isArray(array)) {
    return [];
  }
  if (array.length <= maxItems) {
    return array;
  }
  return array.slice(array.length - maxItems);
}

function blockKey(x, y, z) {
  return String(x) + "," + String(y) + "," + String(z);
}

function toFiniteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

class WorldMemory {
  constructor(filePath) {
    this.filePath = filePath;
    this.listeners = new Set();
    this.saveTimer = null;
    this.state = this.defaultState();
    this.load();
  }

  subscribe(listener) {
    if (typeof listener !== "function") {
      return () => {};
    }
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit() {
    const event = {
      type: "memory",
      summary: this.summary()
    };
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        // ignore listener errors
      }
    }
  }

  defaultState() {
    return {
      version: 1,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      bot: {
        connected: false,
        dimension: "",
        gamemode: "",
        username: "",
        position: null,
        yaw: 0,
        pitch: 0,
        health: 0,
        food: 0,
        heldItem: null
      },
      lastAction: null,
      taskContext: {},
      waypoints: {},
      players: {},
      blocks: {},
      containers: {},
      furnaces: {},
      notes: [],
      observations: [],
      actions: []
    };
  }

  load() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    if (!fs.existsSync(this.filePath)) {
      this.saveNow();
      return;
    }

    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8").replace(/^\uFEFF/, ""));
      this.state = {
        ...this.defaultState(),
        ...parsed,
        bot: {
          ...this.defaultState().bot,
          ...(parsed.bot || {})
        },
        taskContext: {
          ...(parsed.taskContext || {})
        },
        waypoints: {
          ...(parsed.waypoints || {})
        },
        players: {
          ...(parsed.players || {})
        },
        blocks: {
          ...(parsed.blocks || {})
        },
        containers: {
          ...(parsed.containers || {})
        },
        furnaces: {
          ...(parsed.furnaces || {})
        },
        notes: Array.isArray(parsed.notes) ? parsed.notes : [],
        observations: Array.isArray(parsed.observations) ? parsed.observations : [],
        actions: Array.isArray(parsed.actions) ? parsed.actions : []
      };
    } catch (error) {
      this.state = this.defaultState();
      this.addNote("memory file reset after parse failure", "system");
    }
  }

  touch() {
    this.state.updatedAt = nowIso();
    this.scheduleSave();
    this.emit();
  }

  scheduleSave() {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
    }
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.saveNow();
    }, 200);
  }

  saveNow() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(this.state, null, 2));
  }

  snapshot() {
    return clone({
      ok: true,
      memory: this.state
    });
  }

  summary() {
    return {
      updatedAt: this.state.updatedAt,
      waypointCount: Object.keys(this.state.waypoints).length,
      playerCount: Object.keys(this.state.players).length,
      blockCount: Object.keys(this.state.blocks).length,
      containerCount: Object.keys(this.state.containers).length,
      furnaceCount: Object.keys(this.state.furnaces).length,
      noteCount: this.state.notes.length,
      lastAction: this.state.lastAction
    };
  }

  setBotStatus(status) {
    const connected = Boolean(status && status.connected && status.inWorld);
    this.state.bot = {
      connected,
      dimension: connected ? String(status.dimension || "") : "",
      gamemode: connected ? String(status.gamemode || "") : "",
      username: status && status.bot ? String(status.bot.username || "") : "",
      position: connected ? {
        x: toFiniteNumber(status.x),
        y: toFiniteNumber(status.y),
        z: toFiniteNumber(status.z)
      } : null,
      yaw: toFiniteNumber(status && status.yaw),
      pitch: toFiniteNumber(status && status.pitch),
      health: toFiniteNumber(status && status.health),
      food: toFiniteNumber(status && status.food),
      heldItem: status && status.heldItem ? clone(status.heldItem) : null
    };
    this.touch();
  }

  setPlayers(payload) {
    if (!payload || !Array.isArray(payload.players)) {
      return;
    }

    const next = {};
    for (const player of payload.players) {
      if (!player || !player.name) {
        continue;
      }
      next[player.name] = {
        ...clone(player),
        seenAt: nowIso()
      };
    }
    this.state.players = next;
    this.touch();
  }

  rememberBlock(block, source = "scan") {
    if (!block || !Number.isFinite(block.x) || !Number.isFinite(block.y) || !Number.isFinite(block.z)) {
      return;
    }

    const key = blockKey(block.x, block.y, block.z);
    if (block.isAir) {
      delete this.state.blocks[key];
      this.touch();
      return;
    }

    this.state.blocks[key] = {
      x: block.x,
      y: block.y,
      z: block.z,
      name: block.name || "",
      displayName: block.displayName || block.name || "",
      stateId: toFiniteNumber(block.stateId, -1),
      type: toFiniteNumber(block.type, -1),
      properties: clone(block.properties || {}),
      source,
      seenAt: nowIso()
    };
    this.trimKeyedCollection(this.state.blocks, 512);
    this.touch();
  }

  rememberContainer(record) {
    if (!record || !Number.isFinite(record.x) || !Number.isFinite(record.y) || !Number.isFinite(record.z)) {
      return;
    }

    const key = blockKey(record.x, record.y, record.z);
    this.state.containers[key] = {
      x: record.x,
      y: record.y,
      z: record.z,
      name: record.name || "container",
      title: record.title || "",
      slots: clone(record.slots || []),
      source: record.source || "container",
      seenAt: nowIso()
    };
    this.trimKeyedCollection(this.state.containers, 128);
    this.touch();
  }

  rememberFurnace(record) {
    if (!record || !Number.isFinite(record.x) || !Number.isFinite(record.y) || !Number.isFinite(record.z)) {
      return;
    }

    const key = blockKey(record.x, record.y, record.z);
    this.state.furnaces[key] = {
      x: record.x,
      y: record.y,
      z: record.z,
      name: record.name || "furnace",
      input: clone(record.input || null),
      fuel: clone(record.fuel || null),
      output: clone(record.output || null),
      source: record.source || "furnace",
      seenAt: nowIso()
    };
    this.trimKeyedCollection(this.state.furnaces, 128);
    this.touch();
  }

  addNote(text, tag = "note", extra) {
    if (typeof text !== "string" || text.length === 0) {
      return null;
    }

    const note = {
      text,
      tag,
      addedAt: nowIso()
    };
    if (typeof extra !== "undefined") {
      note.extra = clone(extra);
    }

    this.state.notes.push(note);
    this.state.notes = limitArray(this.state.notes, 160);
    this.touch();
    return note;
  }

  addObservation(kind, payload) {
    if (typeof kind !== "string" || kind.length === 0) {
      return null;
    }

    const observation = {
      kind,
      payload: clone(payload || {}),
      addedAt: nowIso()
    };
    this.state.observations.push(observation);
    this.state.observations = limitArray(this.state.observations, 200);
    this.touch();
    return observation;
  }

  setWaypoint(name, payload) {
    if (typeof name !== "string" || name.length === 0) {
      throw new Error("waypoint name is required");
    }

    const position = payload && payload.position ? payload.position : payload;
    const waypoint = {
      name,
      position: {
        x: toFiniteNumber(position.x),
        y: toFiniteNumber(position.y),
        z: toFiniteNumber(position.z)
      },
      note: payload && payload.note ? String(payload.note) : "",
      updatedAt: nowIso()
    };

    if (payload && payload.dimension) {
      waypoint.dimension = String(payload.dimension);
    }

    this.state.waypoints[name] = waypoint;
    this.touch();
    return clone(waypoint);
  }

  updateContext(patch) {
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
      return clone(this.state.taskContext);
    }

    this.state.taskContext = {
      ...this.state.taskContext,
      ...clone(patch)
    };
    this.touch();
    return clone(this.state.taskContext);
  }

  setLastAction(snapshot) {
    if (!snapshot || typeof snapshot !== "object") {
      return;
    }

    this.state.lastAction = {
      ...clone(snapshot),
      updatedAt: nowIso()
    };

    const label = snapshot.label || snapshot.current || "Idle";
    if (label !== "Idle" || snapshot.state === "failed" || snapshot.state === "completed" || snapshot.state === "cancelled") {
      this.state.actions.push({
        label,
        state: snapshot.state || "idle",
        message: snapshot.message || "",
        error: snapshot.error || "",
        details: clone(snapshot.details || null),
        updatedAt: nowIso()
      });
      this.state.actions = limitArray(this.state.actions, 120);
    }

    this.touch();
  }

  reset() {
    this.state = this.defaultState();
    this.touch();
  }

  trimKeyedCollection(collection, maxItems) {
    const entries = Object.entries(collection);
    if (entries.length <= maxItems) {
      return;
    }

    entries
      .sort((left, right) => String(left[1].seenAt || "").localeCompare(String(right[1].seenAt || "")))
      .slice(0, entries.length - maxItems)
      .forEach(([key]) => {
        delete collection[key];
      });
  }
}

module.exports = WorldMemory;
