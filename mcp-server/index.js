#!/usr/bin/env node
// Single-process MCP server for AI Programmability Score.
//
// - stdio transport for Claude Code (MCP protocol)
// - embedded WebSocket server on 127.0.0.1:3055 for the Figma plugin
//
// No separate bridge needed. Claude Code spawns this process; the plugin
// connects to it directly over localhost.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { WebSocketServer } from "ws";
import { createServer } from "http";

const WS_PORT = Number(process.env.BRIDGE_PORT || 3055);
// Listen on both IPv4 and IPv6 loopback. The plugin's manifest requires
// `http://localhost:3055` (Figma rejects IP literals), and `localhost`
// resolves to either 127.0.0.1 or ::1 depending on the host's /etc/hosts
// ordering and DNS. Binding both avoids an "ERR_CONNECTION_REFUSED on
// some Macs" class of bug without opening the port to external interfaces.
const WS_HOSTS = ["127.0.0.1", "::1"];
const CALL_TIMEOUT_MS = 55_000; // stay under typical 60s MCP ceiling

function log(...args) {
  // stderr so it doesn't pollute stdio MCP transport
  console.error("[mcp]", ...args);
}

// ──────────────────────────────────────────────
// Embedded WS server — plugin connects here
// ──────────────────────────────────────────────

// One WebSocketServer in noServer mode, fed upgrades from two loopback
// HTTP servers (IPv4 + IPv6).
const wss = new WebSocketServer({ noServer: true });

function startLoopbackListener(host) {
  const shown = host.includes(":") ? `[${host}]` : host;
  // Holder so the SIGINT handler (and any other caller) can reach the
  // currently-bound http.Server across retry cycles.
  const holder = { srv: null, giveUp: false };

  const tryBind = (attempt = 0) => {
    if (holder.giveUp) return;
    const srv = createServer();
    holder.srv = srv;
    srv.on("upgrade", (req, socket, head) => {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
    });
    srv.on("error", (err) => {
      if (err.code === "EADDRINUSE") {
        // Port is taken — could be a stale server from a previous Claude
        // Code session that hasn't exited yet, or another tool using 3055.
        // Retry with exponential backoff so that, as soon as the squatter
        // releases the port, we grab it. Capped at 10s between tries.
        const delayMs = Math.min(10_000, 500 * 2 ** Math.min(attempt, 5));
        log(`${shown}:${WS_PORT} in use, retrying in ${delayMs}ms (attempt ${attempt + 1})`);
        try { srv.close(); } catch (_e) {}
        setTimeout(() => tryBind(attempt + 1), delayMs);
      } else if (err.code === "EAFNOSUPPORT" || err.code === "EADDRNOTAVAIL") {
        // This system doesn't have this address family configured
        // (e.g. IPv6 loopback disabled). The other listener still works.
        log(`skipping ${shown} listener: ${err.code}`);
        holder.giveUp = true;
      } else {
        log(`${shown} listener error:`, err?.message);
      }
    });
    srv.listen(WS_PORT, host, () => {
      log(`plugin WS listening on ws://${shown}:${WS_PORT}` + (attempt > 0 ? ` (after ${attempt} retr${attempt === 1 ? "y" : "ies"})` : ""));
    });
  };

  tryBind();
  return holder;
}

const httpHolders = WS_HOSTS.map(startLoopbackListener);

/** @type {import('ws').WebSocket | null} */
let pluginSocket = null;

const pending = new Map(); // id -> { resolve, reject, timer }
let nextId = 1;
let cancelled = false;

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

wss.on("connection", (ws) => {
  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    // Handshake
    if (msg.type === "hello" && msg.role === "plugin") {
      if (pluginSocket && pluginSocket !== ws) {
        try { pluginSocket.close(1000, "replaced"); } catch {}
      }
      pluginSocket = ws;
      log("plugin connected");
      safeSend(ws, { type: "event", name: "hello:ack" });
      return;
    }

    // Response to a pending tool call
    if (msg.type === "response") {
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) {
        p.reject(Object.assign(new Error(msg.error.message || "plugin error"), { code: msg.error.code }));
      } else {
        p.resolve(msg.result);
      }
      return;
    }

    // Events from the plugin
    if (msg.type === "event") {
      if (msg.name === "cancel") {
        cancelled = true;
        // Reject all pending calls immediately
        for (const [id, p] of pending) {
          clearTimeout(p.timer);
          p.resolve({ cancelled: true, reason: "user stopped review" });
        }
        pending.clear();
      }
    }
  });

  ws.on("close", () => {
    if (ws === pluginSocket) {
      pluginSocket = null;
      log("plugin disconnected");
      // Reject pending calls
      for (const [, p] of pending) {
        clearTimeout(p.timer);
        p.reject(new Error("plugin disconnected"));
      }
      pending.clear();
    }
  });

  ws.on("error", (err) => {
    log("socket error:", err?.message);
  });
});

// ──────────────────────────────────────────────
// RPC: call into the plugin from MCP tools
// ──────────────────────────────────────────────

const CANCEL_EXEMPT = new Set(["get_selection", "get_preferences"]);

async function call(method, params = {}) {
  if (cancelled && !CANCEL_EXEMPT.has(method)) return { cancelled: true, reason: "user stopped review" };
  if (!pluginSocket || pluginSocket.readyState !== pluginSocket.OPEN) {
    throw new Error("Figma plugin is not connected. Open the AI Programmability Score plugin in Figma.");
  }
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Plugin call '${method}' timed out after ${CALL_TIMEOUT_MS}ms. Is the plugin still open?`));
    }, CALL_TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer });
    pluginSocket.send(JSON.stringify({ type: "request", id, method, params }));
  });
}

// ──────────────────────────────────────────────
// MCP server (stdio transport for Claude Code)
// ──────────────────────────────────────────────

const server = new McpServer({
  name: "figma-ai-score",
  version: "0.1.0"
});

function toolResult(obj) {
  return { content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] };
}

server.registerTool(
  "get_selection",
  {
    title: "Get current Figma selection",
    description: "Returns the live selection in the Figma plugin: node ids, names, types, page + file names. Use this to learn what the user wants reviewed before calling request_scan.",
    inputSchema: {}
  },
  async () => {
    const res = await call("get_selection");
    return toolResult(res);
  }
);

server.registerTool(
  "get_preferences",
  {
    title: "Get review preferences and instructions",
    description: "Returns enabled rules AND full review instructions from the plugin. The response contains an 'instructions' field with the complete review protocol — read and follow it exactly. Call this AFTER announce_review_start so the user sees a loading state while you read the instructions.",
    inputSchema: {}
  },
  async () => {
    const res = await call("get_preferences");
    return toolResult(res);
  }
);

server.registerTool(
  "announce_review_start",
  {
    title: "Announce that a review is starting",
    description: "Lightweight first call that tells the Figma plugin UI to show a 'Preparing review…' state while Claude reads the full instructions and processes the selection. MUST be the very first tool called when the user asks for a review — before get_preferences, before anything else. Without this, the plugin UI looks frozen for ~10 seconds while Claude is processing the big instructions string.",
    inputSchema: {}
  },
  async () => {
    // A new review cycle always clears any stale cancel flag from a
    // previous review (matches begin_review's behaviour).
    cancelled = false;
    const res = await call("announce_review_start");
    return toolResult(res);
  }
);

server.registerTool(
  "begin_review",
  {
    title: "Begin a review",
    description: "Clears any previous cancel flag and tells the plugin to enter its locked/reviewing state with the given frame ids. Call this first, before request_scan.",
    inputSchema: {
      nodeIds: z.array(z.string()).describe("Figma node ids to lock for review")
    }
  },
  async ({ nodeIds }) => {
    cancelled = false;
    const res = await call("begin_review", { nodeIds });
    return toolResult(res);
  }
);

server.registerTool(
  "request_scan",
  {
    title: "Extract a frame's review data",
    description: "For a single Figma node id, returns its full subtree with the data needed to judge the programmability rules: for each descendant node — type, componentId/mainComponentId, fills (+ boundVariables & styleId), strokes, effects (+ boundVariables & styleId), textStyleId + typography boundVariables, paddings/itemSpacing (+ boundVariables), plus a base64 PNG thumbnail of the root. The agent applies rule logic over this data.",
    inputSchema: {
      nodeId: z.string().describe("Figma node id to scan")
    }
  },
  async ({ nodeId }) => {
    const res = await call("request_scan", { nodeId });
    // If a thumbnail came back, surface it as a proper image content block
    // (so Claude can actually see it). The rest of the scan tree goes as text.
    if (res && typeof res === "object" && res.thumbnail) {
      const { thumbnail, ...rest } = res;
      return {
        content: [
          { type: "image", data: thumbnail, mimeType: "image/jpeg" },
          { type: "text", text: JSON.stringify(rest, null, 2) }
        ]
      };
    }
    return toolResult(res);
  }
);

server.registerTool(
  "highlight_nodes",
  {
    title: "Flash offending nodes on the Figma canvas",
    description: "Visually highlights the given node ids in Figma so the designer can see them. Purely cosmetic.",
    inputSchema: {
      nodeIds: z.array(z.string())
    }
  },
  async ({ nodeIds }) => {
    const res = await call("highlight_nodes", { nodeIds });
    return toolResult(res);
  }
);

server.registerTool(
  "submit_report",
  {
    title: "Send the final review report to the plugin",
    description: "Delivers the completed review (score, issues, breakdown) to the plugin so it can render + offer export. Also unlocks the plugin UI.",
    inputSchema: {
      report: z.object({
        frames: z.array(z.object({
          nodeId: z.string(),
          name: z.string(),
          score: z.number(),
          perfect: z.boolean(),
          breakdown: z.record(z.object({
            enabled: z.boolean(),
            passed: z.boolean(),
            offenders: z.array(z.object({
              nodeId: z.string(),
              name: z.string(),
              detail: z.string(),
              suggestedName: z.string().optional()
            }))
          })),
          issues: z.array(z.object({
            rule: z.string(),
            nodeId: z.string(),
            name: z.string(),
            detail: z.string()
          }))
        })),
        generatedAt: z.string().describe("ISO timestamp")
      })
    }
  },
  async ({ report }) => {
    const res = await call("submit_report", { report });
    return toolResult(res);
  }
);

server.registerTool(
  "is_cancelled",
  {
    title: "Check if the user requested cancel",
    description: "Returns { cancelled: boolean }. Every other tool also short-circuits with { cancelled: true } when the flag is set — you rarely need to call this directly.",
    inputSchema: {}
  },
  async () => toolResult({ cancelled })
);

// ──────────────────────────────────────────────
// Boot
// ──────────────────────────────────────────────

(async () => {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log("MCP ready (stdio + WS)");
})().catch((err) => {
  console.error("[mcp] fatal:", err);
  process.exit(1);
});

process.on("SIGINT", () => {
  log("shutting down");
  // Stop any pending rebind attempts and close the currently-bound servers.
  for (const h of httpHolders) h.giveUp = true;
  wss.close();
  Promise.all(httpHolders.map(h =>
    new Promise(r => h.srv ? h.srv.close(() => r()) : r())
  )).finally(() => process.exit(0));
});
