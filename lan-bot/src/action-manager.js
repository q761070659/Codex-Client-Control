"use strict";

class ActionManager {
  constructor() {
    this.active = false;
    this.label = "Idle";
    this.state = "idle";
    this.message = "idle";
    this.error = "";
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
      startedAt: this.startedAt,
      cancelRequested: this.cancelRequested
    };
  }

  isCancelled() {
    return this.cancelRequested;
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
