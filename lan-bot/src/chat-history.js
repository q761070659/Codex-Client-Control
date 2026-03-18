"use strict";

class ChatHistory {
  constructor(maxMessages = 500) {
    this.maxMessages = maxMessages;
    this.startedAt = Date.now();
    this.nextSequence = 1;
    this.messages = [];
    this.recentTyped = [];
  }

  add(text, tag = "System") {
    if (typeof text !== "string" || text.length === 0) {
      return null;
    }

    const entry = {
      sequence: this.nextSequence++,
      addedTime: Date.now() - this.startedAt,
      text,
      tag
    };

    this.messages.push(entry);
    if (this.messages.length > this.maxMessages) {
      this.messages.splice(0, this.messages.length - this.maxMessages);
    }
    return entry;
  }

  addTyped(text) {
    if (typeof text !== "string" || text.length === 0) {
      return;
    }
    this.recentTyped.push(text);
    if (this.recentTyped.length > 20) {
      this.recentTyped.splice(0, this.recentTyped.length - 20);
    }
  }

  get(since = -1, limit = 50) {
    const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(200, Math.floor(limit))) : 50;
    const selected = this.messages.filter((entry) => entry.sequence > since);
    const trimmed = selected.slice(Math.max(0, selected.length - safeLimit));
    const latest = this.messages.length > 0 ? this.messages[this.messages.length - 1].sequence : 0;

    return {
      ok: true,
      messages: trimmed,
      recentTyped: this.recentTyped.slice(),
      latestSequence: latest
    };
  }
}

module.exports = ChatHistory;
