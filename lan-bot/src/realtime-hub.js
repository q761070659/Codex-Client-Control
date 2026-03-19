"use strict";

const crypto = require("crypto");
const { URL } = require("url");

function randomId() {
  return crypto.randomUUID();
}

function encodeFrame(opcode, payloadBuffer) {
  const payload = Buffer.isBuffer(payloadBuffer) ? payloadBuffer : Buffer.from(payloadBuffer || "");
  let header = null;

  if (payload.length < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x80 | opcode;
    header[1] = payload.length;
  } else if (payload.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }

  return Buffer.concat([header, payload]);
}

function textFrame(text) {
  return encodeFrame(0x1, Buffer.from(String(text), "utf8"));
}

function pongFrame(payload) {
  return encodeFrame(0xA, payload || Buffer.alloc(0));
}

function closeFrame() {
  return encodeFrame(0x8, Buffer.alloc(0));
}

class RealtimeHub {
  constructor(server, options) {
    this.server = server;
    this.options = options || {};
    this.clients = new Map();
    this.server.on("upgrade", (request, socket) => {
      this.handleUpgrade(request, socket);
    });
  }

  snapshot() {
    return {
      ok: true,
      count: this.clients.size,
      clients: Array.from(this.clients.values()).map((client) => ({
        id: client.id,
        subscriptions: Array.from(client.subscriptions.values()),
        connectedAt: client.connectedAt
      }))
    };
  }

  handleUpgrade(request, socket) {
    try {
      const url = new URL(request.url, "http://127.0.0.1");
      if (url.pathname !== "/ws") {
        socket.destroy();
        return;
      }

      if (typeof this.options.authenticate === "function") {
        this.options.authenticate(request, url);
      }

      const key = request.headers["sec-websocket-key"];
      if (!key) {
        socket.destroy();
        return;
      }

      const accept = crypto
        .createHash("sha1")
        .update(String(key) + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11", "utf8")
        .digest("base64");

      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\n" +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        "Sec-WebSocket-Accept: " + accept + "\r\n" +
        "\r\n"
      );

      const client = {
        id: randomId(),
        socket,
        buffer: Buffer.alloc(0),
        subscriptions: new Set(["status", "action", "agent", "memory", "chat", "log", "response"]),
        connectedAt: new Date().toISOString()
      };
      this.clients.set(client.id, client);

      socket.on("data", (chunk) => {
        this.handleSocketData(client, chunk);
      });
      socket.on("error", () => {
        this.removeClient(client.id);
      });
      socket.on("close", () => {
        this.removeClient(client.id);
      });
      socket.on("end", () => {
        this.removeClient(client.id);
      });

      this.send(client.id, {
        type: "hello",
        clientId: client.id,
        subscriptions: Array.from(client.subscriptions.values()),
        capabilities: typeof this.options.getCapabilities === "function"
          ? this.options.getCapabilities()
          : {}
      });

      if (typeof this.options.onConnect === "function") {
        this.options.onConnect(client);
      }
    } catch (error) {
      socket.destroy();
    }
  }

  removeClient(clientId) {
    const client = this.clients.get(clientId);
    if (!client) {
      return;
    }

    this.clients.delete(clientId);
    try {
      client.socket.destroy();
    } catch (error) {
      // ignore close errors
    }

    if (typeof this.options.onDisconnect === "function") {
      this.options.onDisconnect(client);
    }
  }

  handleSocketData(client, chunk) {
    client.buffer = Buffer.concat([client.buffer, chunk]);

    while (client.buffer.length >= 2) {
      const first = client.buffer[0];
      const second = client.buffer[1];
      const opcode = first & 0x0f;
      const masked = (second & 0x80) !== 0;
      let payloadLength = second & 0x7f;
      let offset = 2;

      if (payloadLength === 126) {
        if (client.buffer.length < 4) {
          return;
        }
        payloadLength = client.buffer.readUInt16BE(2);
        offset = 4;
      } else if (payloadLength === 127) {
        if (client.buffer.length < 10) {
          return;
        }
        payloadLength = Number(client.buffer.readBigUInt64BE(2));
        offset = 10;
      }

      const maskLength = masked ? 4 : 0;
      if (client.buffer.length < offset + maskLength + payloadLength) {
        return;
      }

      let payload = client.buffer.slice(offset + maskLength, offset + maskLength + payloadLength);
      if (masked) {
        const mask = client.buffer.slice(offset, offset + 4);
        const unmasked = Buffer.alloc(payload.length);
        for (let index = 0; index < payload.length; index += 1) {
          unmasked[index] = payload[index] ^ mask[index % 4];
        }
        payload = unmasked;
      }

      client.buffer = client.buffer.slice(offset + maskLength + payloadLength);

      if (opcode === 0x8) {
        try {
          client.socket.write(closeFrame());
        } catch (error) {
          // ignore write errors
        }
        this.removeClient(client.id);
        return;
      }

      if (opcode === 0x9) {
        try {
          client.socket.write(pongFrame(payload));
        } catch (error) {
          this.removeClient(client.id);
        }
        continue;
      }

      if (opcode !== 0x1) {
        continue;
      }

      let message = null;
      try {
        message = JSON.parse(payload.toString("utf8"));
      } catch (error) {
        this.send(client.id, {
          type: "error",
          ok: false,
          error: "invalid websocket json"
        });
        continue;
      }

      this.handleMessage(client, message);
    }
  }

  async handleMessage(client, message) {
    try {
      if (message && message.type === "subscribe") {
        const channels = Array.isArray(message.channels) ? message.channels : [];
        client.subscriptions = new Set(channels.length > 0 ? channels : ["status", "action", "agent", "memory", "chat", "log", "response"]);
        this.send(client.id, {
          type: "subscribed",
          ok: true,
          subscriptions: Array.from(client.subscriptions.values()),
          requestId: message.id || null
        });
        return;
      }

      if (message && message.type === "ping") {
        this.send(client.id, {
          type: "pong",
          ok: true,
          requestId: message.id || null,
          time: new Date().toISOString()
        });
        return;
      }

      if (typeof this.options.onMessage !== "function") {
        this.send(client.id, {
          type: "error",
          ok: false,
          error: "websocket handler unavailable",
          requestId: message && message.id ? message.id : null
        });
        return;
      }

      const result = await this.options.onMessage(client, message);
      this.send(client.id, {
        type: "response",
        ok: true,
        requestId: message && message.id ? message.id : null,
        responseType: message && message.type ? message.type : "",
        result
      });
    } catch (error) {
      this.send(client.id, {
        type: "error",
        ok: false,
        requestId: message && message.id ? message.id : null,
        error: error && error.message ? error.message : String(error)
      });
    }
  }

  send(clientId, payload) {
    const client = this.clients.get(clientId);
    if (!client) {
      return false;
    }

    try {
      client.socket.write(textFrame(JSON.stringify(payload)));
      return true;
    } catch (error) {
      this.removeClient(clientId);
      return false;
    }
  }

  broadcast(channel, payload) {
    for (const client of this.clients.values()) {
      if (!client.subscriptions.has(channel) && !client.subscriptions.has("*")) {
        continue;
      }
      this.send(client.id, {
        type: "event",
        channel,
        payload
      });
    }
  }
}

module.exports = RealtimeHub;
