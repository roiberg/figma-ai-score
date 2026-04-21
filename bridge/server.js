#!/usr/bin/env node
// Local WebSocket relay between the Figma plugin and the MCP server.
// Binds to 127.0.0.1 only. No external traffic.
//
// Protocol (JSON messages):
//   Client -> hello:       { type: "hello", role: "plugin" | "mcp" }
//   MCP -> plugin request: { type: "request", id, method, params }
//   Plugin -> MCP response:{ type: "response", id, result? , error? }
//   Either -> event:       { type: "event", name, data? }
//
// The bridge is deliberately dumb: it does not interpret methods,
// does not hold state beyond the two sockets + pending request ids.

import { WebSocketServer } from "ws";

const PORT = Number(process.env.BRIDGE_PORT || 3055);
const HOST = "127.0.0.1";

const wss = new WebSocketServer({ host: HOST, port: PORT });

/** @type {import('ws').WebSocket | null} */
let pluginSocket = null;
/** @type {import('ws').WebSocket | null} */
let mcpSocket = null;

function log(...args) {
  // stderr so it doesn't pollute any stdio clients
  console.error("[bridge]", ...args);
}

function safeSend(sock, obj) {
  if (!sock || sock.readyState !== sock.OPEN) return false;
  try {
    sock.send(JSON.stringify(obj));
    return true;
  } catch (e) {
    log("send failed:", e?.message);
    return false;
  }
}

wss.on("listening", () => {
  log(`listening on ws://${HOST}:${PORT}`);
});

wss.on("connection", (ws) => {
  let role = null;

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      log("non-JSON message dropped");
      return;
    }

    // Handshake
    if (msg.type === "hello") {
      role = msg.role;
      if (role === "plugin") {
        if (pluginSocket && pluginSocket !== ws) {
          try { pluginSocket.close(1000, "replaced"); } catch {}
        }
        pluginSocket = ws;
        log("plugin connected");
        safeSend(mcpSocket, { type: "event", name: "plugin:connected" });
      } else if (role === "mcp") {
        if (mcpSocket && mcpSocket !== ws) {
          try { mcpSocket.close(1000, "replaced"); } catch {}
        }
        mcpSocket = ws;
        log("mcp connected");
        safeSend(pluginSocket, { type: "event", name: "mcp:connected" });
      } else {
        log("unknown role:", role);
        ws.close(1002, "unknown role");
      }
      safeSend(ws, { type: "event", name: "hello:ack", data: { role } });
      return;
    }

    // Relay: MCP -> plugin (requests), plugin -> MCP (responses & events)
    if (role === "mcp") {
      if (msg.type === "request" || msg.type === "event") {
        if (!safeSend(pluginSocket, msg)) {
          // No plugin: fail the request immediately instead of hanging.
          if (msg.type === "request") {
            safeSend(ws, {
              type: "response",
              id: msg.id,
              error: { code: "PLUGIN_DISCONNECTED", message: "Figma plugin is not connected" }
            });
          }
        }
      }
    } else if (role === "plugin") {
      if (msg.type === "response" || msg.type === "event") {
        safeSend(mcpSocket, msg);
      }
    }
  });

  ws.on("close", () => {
    if (ws === pluginSocket) {
      pluginSocket = null;
      log("plugin disconnected");
      safeSend(mcpSocket, { type: "event", name: "plugin:disconnected" });
    } else if (ws === mcpSocket) {
      mcpSocket = null;
      log("mcp disconnected");
      safeSend(pluginSocket, { type: "event", name: "mcp:disconnected" });
    }
  });

  ws.on("error", (err) => {
    log("socket error:", err?.message);
  });
});

process.on("SIGINT", () => {
  log("shutting down");
  wss.close(() => process.exit(0));
});
