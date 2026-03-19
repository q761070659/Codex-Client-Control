"use strict";

class ActionManager {
  constructor() {
    this.listeners = new Set();
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
    const snapshot = this.snapshot();
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch (error) {
        // ignore listener errors
      }
    }
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

    this.emit();
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
    this.emit();

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
      this.emit();
      this.active = false;
      this.label = "Idle";
      this.startedAt = 0;
      this.cancelRequested = false;
      this.emit();
    }
  }

  cancel() {
    this.cancelRequested = true;
    this.state = "cancelled";
    this.message = "cancel requested";
    if (this.cancelHook) {
      this.cancelHook();
    }
    this.emit();
    return this.snapshot();
  }
}

module.exports = ActionManager;
