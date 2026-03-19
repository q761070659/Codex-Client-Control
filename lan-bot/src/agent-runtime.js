"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

function nowIso() {
  return new Date().toISOString();
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function trimArray(array, limit) {
  if (!Array.isArray(array)) {
    return [];
  }
  if (array.length <= limit) {
    return array;
  }
  return array.slice(array.length - limit);
}

function extractJsonBlock(text) {
  if (typeof text !== "string") {
    throw new Error("llm response is not text");
  }

  const fencedMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = fencedMatch ? fencedMatch[1] : text;
  const firstBrace = raw.indexOf("{");
  const firstBracket = raw.indexOf("[");
  let start = -1;
  if (firstBrace >= 0 && firstBracket >= 0) {
    start = Math.min(firstBrace, firstBracket);
  } else {
    start = Math.max(firstBrace, firstBracket);
  }
  if (start < 0) {
    throw new Error("llm response did not contain json");
  }

  const candidate = raw.slice(start).trim();
  for (let index = candidate.length; index > 0; index -= 1) {
    const slice = candidate.slice(0, index).trim();
    try {
      return JSON.parse(slice);
    } catch (error) {
      continue;
    }
  }

  throw new Error("failed to parse llm json");
}

class AgentRuntime {
  constructor(filePath, options) {
    this.filePath = filePath;
    this.listeners = new Set();
    this.options = {
      maxSessions: options && Number.isFinite(options.maxSessions) ? options.maxSessions : 8,
      autoSaveDebounceMs: options && Number.isFinite(options.autoSaveDebounceMs) ? options.autoSaveDebounceMs : 200,
      systemPrompt: options && options.systemPrompt ? String(options.systemPrompt) : "",
      llm: clone((options && options.llm) || {})
    };
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
      type: "agent",
      snapshot: this.snapshot()
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
      currentSessionId: "",
      sessions: {}
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
        sessions: parsed.sessions || {}
      };
    } catch (error) {
      this.state = this.defaultState();
      this.saveNow();
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
    }, this.options.autoSaveDebounceMs);
  }

  saveNow() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(this.state, null, 2));
  }

  listSessions() {
    return Object.values(this.state.sessions)
      .sort((left, right) => String(right.updatedAt || "").localeCompare(String(left.updatedAt || "")))
      .map((session) => clone(this.summarizeSession(session)));
  }

  summarizeSession(session) {
    return {
      id: session.id,
      label: session.label,
      goal: session.goal,
      mode: session.mode,
      status: session.status,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      stepCount: Array.isArray(session.plan) ? session.plan.length : 0,
      completedSteps: Array.isArray(session.results) ? session.results.filter((entry) => entry.ok).length : 0,
      messageCount: Array.isArray(session.messages) ? session.messages.length : 0,
      lastError: session.lastError || "",
      autoExecute: Boolean(session.autoExecute)
    };
  }

  snapshot(id) {
    if (id) {
      return {
        ok: true,
        session: clone(this.requireSession(id))
      };
    }

    return {
      ok: true,
      currentSessionId: this.state.currentSessionId || "",
      sessions: this.listSessions()
    };
  }

  requireSession(id) {
    const sessionId = id || this.state.currentSessionId;
    if (!sessionId || !this.state.sessions[sessionId]) {
      throw new Error("agent session not found");
    }
    return this.state.sessions[sessionId];
  }

  setCurrent(id) {
    const session = this.requireSession(id);
    this.state.currentSessionId = session.id;
    this.touch();
    return clone(this.summarizeSession(session));
  }

  createSession(input) {
    const id = input && input.id ? String(input.id) : crypto.randomUUID();
    const session = {
      id,
      label: input && input.label ? String(input.label) : "agent-session",
      goal: input && input.goal ? String(input.goal) : "",
      mode: input && input.mode ? String(input.mode) : "llm_bridge",
      status: "idle",
      autoExecute: Boolean(input && input.autoExecute),
      systemPrompt: input && input.systemPrompt ? String(input.systemPrompt) : this.options.systemPrompt,
      metadata: clone((input && input.metadata) || {}),
      createdAt: nowIso(),
      updatedAt: nowIso(),
      lastRunAt: "",
      lastError: "",
      messages: [],
      plan: [],
      results: []
    };

    this.state.sessions[id] = session;
    this.state.currentSessionId = id;
    this.pruneSessions();
    this.touch();
    return clone(session);
  }

  pruneSessions() {
    const sessions = Object.values(this.state.sessions)
      .sort((left, right) => String(right.updatedAt || "").localeCompare(String(left.updatedAt || "")));
    if (sessions.length <= this.options.maxSessions) {
      return;
    }
    for (const session of sessions.slice(this.options.maxSessions)) {
      delete this.state.sessions[session.id];
    }
  }

  addMessage(id, input) {
    const session = this.requireSession(id);
    const message = {
      role: input && input.role ? String(input.role) : "user",
      content: input && input.content ? String(input.content) : "",
      source: input && input.source ? String(input.source) : "",
      addedAt: nowIso()
    };
    if (!message.content) {
      throw new Error("message content is required");
    }
    session.messages.push(message);
    session.messages = trimArray(session.messages, 80);
    session.updatedAt = nowIso();
    this.touch();
    return clone(message);
  }

  setPlan(id, steps, options) {
    const session = this.requireSession(id);
    session.plan = Array.isArray(steps) ? clone(steps) : [];
    if (!options || options.clearResults !== false) {
      session.results = [];
    }
    session.lastError = "";
    session.updatedAt = nowIso();
    this.touch();
    return clone(session.plan);
  }

  appendPlan(id, steps) {
    const session = this.requireSession(id);
    session.plan.push(...clone(Array.isArray(steps) ? steps : []));
    session.plan = trimArray(session.plan, 200);
    session.updatedAt = nowIso();
    this.touch();
    return clone(session.plan);
  }

  clearPlan(id) {
    return this.setPlan(id, [], {
      clearResults: true
    });
  }

  clearResults(id) {
    const session = this.requireSession(id);
    session.results = [];
    session.lastError = "";
    session.updatedAt = nowIso();
    this.touch();
    return clone(session.results);
  }

  markRunning(id) {
    const session = this.requireSession(id);
    session.status = "running";
    session.lastRunAt = nowIso();
    session.lastError = "";
    session.updatedAt = nowIso();
    this.touch();
  }

  markIdle(id) {
    const session = this.requireSession(id);
    session.status = "idle";
    session.updatedAt = nowIso();
    this.touch();
  }

  markStopped(id) {
    const session = this.requireSession(id);
    session.status = "stopped";
    session.updatedAt = nowIso();
    this.touch();
  }

  markCompleted(id) {
    const session = this.requireSession(id);
    session.status = "completed";
    session.updatedAt = nowIso();
    this.touch();
  }

  markFailed(id, error) {
    const session = this.requireSession(id);
    session.status = "failed";
    session.lastError = error ? String(error) : "";
    session.updatedAt = nowIso();
    this.touch();
  }

  appendResults(id, entries) {
    const session = this.requireSession(id);
    session.results.push(...clone(Array.isArray(entries) ? entries : []));
    session.results = trimArray(session.results, 200);
    session.updatedAt = nowIso();
    this.touch();
    return clone(session.results);
  }

  resetSession(id) {
    const session = this.requireSession(id);
    session.status = "idle";
    session.lastError = "";
    session.plan = [];
    session.results = [];
    session.updatedAt = nowIso();
    this.touch();
    return clone(session);
  }

  removeSession(id) {
    const session = this.requireSession(id);
    delete this.state.sessions[session.id];
    if (this.state.currentSessionId === session.id) {
      this.state.currentSessionId = "";
    }
    this.touch();
    return {
      ok: true,
      removed: session.id
    };
  }

  buildPromptPayload(id, context) {
    const session = this.requireSession(id);
    const responseContract = {
      thoughts: "short string",
      plan: [
        {
          saveAs: "optional_name",
          command: "move_to",
          args: {
            x: 0,
            y: 0,
            z: 0,
            range: 1
          }
        }
      ],
      notes: [
        "optional memory notes"
      ]
    };

    return {
      ok: true,
      session: clone(session),
      systemPrompt: session.systemPrompt || this.options.systemPrompt,
      responseContract,
      capabilities: clone(context.capabilities || {}),
      world: clone(context.world || {}),
      memory: clone(context.memory || {}),
      instructions: [
        "Think in short steps.",
        "Prefer direct commands over high-level actions.",
        "Use saveAs when later steps need earlier outputs.",
        "Return compact JSON only."
      ]
    };
  }

  llmConfigured() {
    const llm = this.options.llm || {};
    if (!llm.enabled) {
      return false;
    }
    if (!llm.baseUrl || !llm.model) {
      return false;
    }
    if (llm.apiKeyEnv && !process.env[llm.apiKeyEnv]) {
      return false;
    }
    return true;
  }

  async requestPlan(id, context) {
    if (!this.llmConfigured()) {
      throw new Error("agent llm is not configured");
    }

    const session = this.requireSession(id);
    const llm = this.options.llm;
    const payload = this.buildPromptPayload(session.id, context);
    const messages = [
      {
        role: "system",
        content: payload.systemPrompt
      },
      {
        role: "user",
        content: JSON.stringify(payload, null, 2)
      }
    ];

    const headers = {
      "Content-Type": "application/json",
      ...(llm.headers || {})
    };
    if (llm.apiKeyEnv && process.env[llm.apiKeyEnv]) {
      headers.Authorization = "Bearer " + process.env[llm.apiKeyEnv];
    }

    const response = await fetch(String(llm.baseUrl).replace(/\/$/, "") + "/chat/completions", {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: llm.model,
        temperature: 0.2,
        response_format: {
          type: "json_object"
        },
        messages
      })
    });

    const text = await response.text();
    if (!response.ok) {
      throw new Error("llm request failed: " + response.status + " " + text);
    }

    const json = JSON.parse(text);
    const content = json &&
      json.choices &&
      json.choices[0] &&
      json.choices[0].message &&
      json.choices[0].message.content;
    const parsed = extractJsonBlock(content);

    if (parsed.notes && Array.isArray(parsed.notes)) {
      for (const note of parsed.notes) {
        this.addMessage(session.id, {
          role: "assistant",
          source: "llm_note",
          content: String(note)
        });
      }
    }

    if (!Array.isArray(parsed.plan)) {
      throw new Error("llm response did not contain plan array");
    }

    this.addMessage(session.id, {
      role: "assistant",
      source: "llm_planner",
      content: typeof parsed.thoughts === "string" && parsed.thoughts ? parsed.thoughts : "planner response"
    });
    this.setPlan(session.id, parsed.plan, {
      clearResults: true
    });

    return {
      ok: true,
      session: clone(this.requireSession(session.id)),
      llmResponse: parsed
    };
  }
}

module.exports = AgentRuntime;
