"use strict";

class ActionManager {
  constructor() {
    this.active = false;
    this.label = "Idle";
    this.state = "idle";
    this.message = "idle";
    this.error = "";
    this.details = null;
    this.startedAt = 0;
    this.cancelRequested = false;
    this.cancelHook = null;
  }

  setCancelHook(cancelHook) {
    this.cancelHook = typeof cancelHook === "function" ? cancelHook : null;
  }

  snapshot() {
    return {
      ok: true,
      active: this.active,
      isIdle: !this.active,
      current: this.label,
      state: this.state,
      label: this.label,
      message: this.message,
      error: this.error,
      details: this.details,
      startedAt: this.startedAt,
      cancelRequested: this.cancelRequested
    };
  }

  isCancelled() {
    return this.cancelRequested;
  }

  setProgress(message, details) {
    if (typeof message === "object" && typeof details === "undefined") {
      details = message;
      message = "";
    }

    if (typeof message === "string" && message.length > 0) {
      this.message = message;
    }
    if (typeof details !== "undefined") {
      this.details = details;
    }

    return this.snapshot();
  }

  async run(label, executor) {
    if (this.active) {
      throw new Error("another action is already running");
    }

    this.active = true;
    this.label = label;
    this.state = "running";
    this.message = "running";
    this.error = "";
    this.details = null;
    this.startedAt = Date.now();
    this.cancelRequested = false;

    try {
      const result = await executor(this);
      this.state = this.cancelRequested ? "cancelled" : "completed";
      this.message = this.cancelRequested ? "cancelled" : "completed";
      return result;
    } catch (error) {
      this.state = this.cancelRequested ? "cancelled" : "failed";
      this.message = this.cancelRequested ? "cancelled" : "failed";
      this.error = error && error.message ? error.message : String(error);
      throw error;
    } finally {
      this.active = false;
      this.label = "Idle";
      this.startedAt = 0;
      this.cancelRequested = false;
    }
  }

  cancel() {
    this.cancelRequested = true;
    this.state = "cancelled";
    this.message = "cancel requested";
    if (this.cancelHook) {
      this.cancelHook();
    }
    return this.snapshot();
  }
}

module.exports = ActionManager;
