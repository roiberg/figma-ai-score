// One-shot WebSocket bridge between the CLI and the Figma plugin.
//
// The plugin connects outward to ws://localhost:3055 (browser API constraint;
// it can't listen). So the CLI plays the role of WS *server*: it binds 3055,
// waits for the plugin to (re)connect, does ONE RPC, and exits.
//
// No long-lived broker. Each CLI invocation owns the port for its lifetime,
// then releases it on exit. The plugin's auto-reconnect loop (every 2s on
// close — see plugin/ui.html:2444) re-establishes the link on the next call.

import { WebSocketServer } from "ws";
import { createServer } from "node:http";

const WS_PORT = Number(process.env.BRIDGE_PORT || 3055);
// Bind both loopback families. The plugin manifest uses `ws://localhost:3055`
// which can resolve to either; binding both avoids ERR_CONNECTION_REFUSED on
// Macs where /etc/hosts orders ::1 ahead of 127.0.0.1.
const WS_HOSTS = ["127.0.0.1", "::1"];

const CONNECT_TIMEOUT_MS = 3_000;   // grace for plugin to reconnect
const CALL_TIMEOUT_MS    = 55_000;  // upper bound for any reasonable plugin response
const BIND_RETRY_MAX     = 5;       // EADDRINUSE backoff
const BIND_RETRY_BASE_MS = 200;

export class Bridge {
  constructor() {
    this.wss = new WebSocketServer({ noServer: true });
    /** @type {import('node:http').Server[]} */
    this.servers = [];
    /** @type {import('ws').WebSocket | null} */
    this.pluginSocket = null;
    /** @type {Map<number, {resolve:Function, reject:Function, timer:NodeJS.Timeout}>} */
    this.pending = new Map();
    this.nextId = 1;
    this._connectResolve = null;
    this._closed = false;
  }

  async start() {
    // Resolve as soon as a plugin sends `hello`; reject after the timeout.
    const connected = new Promise(resolve => { this._connectResolve = resolve; });
    this._wireConnection();

    // Bind the listener(s). Capture per-host failures so we can craft a
    // specific error if every family fails. Different libc errnos point to
    // very different user actions (sandbox vs. stale process), and the
    // generic "couldn't bind" message we used to throw was confusing
    // enough to send testers down the wrong rabbit hole.
    const bindErrors = [];
    await Promise.all(WS_HOSTS.map(h =>
      this._bindHost(h).catch(err => { bindErrors.push(err); })
    ));
    if (this.servers.length === 0) {
      throw this._buildBindError(bindErrors);
    }

    const winner = await Promise.race([
      connected,
      new Promise(resolve => setTimeout(() => resolve("__timeout__"), CONNECT_TIMEOUT_MS)),
    ]);
    if (winner === "__timeout__") {
      const err = new Error(`Figma plugin is not connected. Open the AI Programmability Score plugin in Figma.`);
      err.code = "PLUGIN_NOT_CONNECTED";
      throw err;
    }
  }

  _bindHost(host) {
    return new Promise((resolve, reject) => {
      let attempts = 0;
      const tryBind = () => {
        const srv = createServer();
        const cleanup = () => {
          srv.removeAllListeners();
          try { srv.close(); } catch {}
        };
        srv.on("upgrade", (req, socket, head) => {
          this.wss.handleUpgrade(req, socket, head, ws => this.wss.emit("connection", ws, req));
        });
        srv.on("error", err => {
          if (err.code === "EADDRINUSE" && attempts < BIND_RETRY_MAX) {
            attempts++;
            cleanup();
            setTimeout(tryBind, BIND_RETRY_BASE_MS * Math.pow(2, attempts - 1));
          } else if (err.code === "EAFNOSUPPORT" || err.code === "EADDRNOTAVAIL") {
            // Family unavailable on this host (e.g. ::1 disabled). Skip silently.
            cleanup();
            resolve();
          } else {
            cleanup();
            reject(err);
          }
        });
        srv.listen(WS_PORT, host, () => {
          this.servers.push(srv);
          resolve();
        });
      };
      tryBind();
    });
  }

  _buildBindError(errors) {
    // EPERM/EACCES on bind() means a sandbox is blocking listening sockets,
    // not that the port is taken. Codex CLI's `network_access: false` mode
    // is the most common offender — but any sandbox that disables `bind()`
    // (App Sandbox profiles, container seccomp policies) lands here.
    const codes = errors.map(e => e && e.code).filter(Boolean);
    const sandboxBlocked = codes.includes("EPERM") || codes.includes("EACCES");
    const portInUse = codes.includes("EADDRINUSE");

    let message;
    if (sandboxBlocked) {
      message =
        `Couldn't bind localhost:${WS_PORT} — Operation not permitted.\n` +
        `This usually means your AI tool's sandbox is blocking network access.\n` +
        `In Codex CLI: grant network permission for this session and retry.\n` +
        `In other sandboxed tools: allow the CLI to listen on localhost.`;
    } else if (portInUse) {
      message =
        `Port ${WS_PORT} is already in use by another process.\n` +
        `Find and stop the holder: \`lsof -nP -iTCP:${WS_PORT} -sTCP:LISTEN\`.\n` +
        `If it's a stale figma-ai-score from an earlier run, kill that PID and retry.`;
    } else {
      const detail = codes.length ? ` (${codes.join(", ")})` : "";
      message = `Couldn't bind any loopback listener on port ${WS_PORT}${detail}.`;
    }
    const err = new Error(message);
    err.code = "BIND_FAILED";
    err.causes = codes;
    return err;
  }

  _wireConnection() {
    this.wss.on("connection", ws => {
      ws.on("message", raw => {
        let msg;
        try { msg = JSON.parse(raw.toString()); } catch { return; }

        // Handshake: plugin announcing itself.
        if (msg.type === "hello" && msg.role === "plugin") {
          // If a previous plugin was already connected (rare race during a
          // multi-tab scenario), close the old one to avoid ambiguous routing.
          if (this.pluginSocket && this.pluginSocket !== ws) {
            try { this.pluginSocket.close(1000, "replaced"); } catch {}
          }
          this.pluginSocket = ws;
          try { ws.send(JSON.stringify({ type: "event", name: "hello:ack" })); } catch {}
          if (this._connectResolve) {
            this._connectResolve("connected");
            this._connectResolve = null;
          }
          return;
        }

        // Response to a pending RPC call.
        if (msg.type === "response") {
          const p = this.pending.get(msg.id);
          if (!p) return;
          this.pending.delete(msg.id);
          clearTimeout(p.timer);
          if (msg.error) {
            const e = new Error(msg.error.message || "plugin error");
            e.code = msg.error.code || "PLUGIN_ERROR";
            p.reject(e);
          } else {
            p.resolve(msg.result);
          }
          return;
        }

        // Async events (e.g. "cancel") are handled plugin-side now; the
        // bridge just transports.
      });

      ws.on("close", () => {
        if (ws === this.pluginSocket) {
          this.pluginSocket = null;
          for (const [, p] of this.pending) {
            clearTimeout(p.timer);
            p.reject(Object.assign(new Error("plugin disconnected mid-call"), { code: "PLUGIN_DISCONNECTED" }));
          }
          this.pending.clear();
        }
      });

      ws.on("error", () => { /* socket-level errors swallowed; pending calls already rejected */ });
    });
  }

  /**
   * Send an RPC to the plugin and await one response.
   * Throws Error with .code = TIMEOUT | PLUGIN_NOT_CONNECTED | PLUGIN_DISCONNECTED | PLUGIN_ERROR
   */
  async call(method, params = {}) {
    if (!this.pluginSocket || this.pluginSocket.readyState !== this.pluginSocket.OPEN) {
      const err = new Error("Plugin is not connected.");
      err.code = "PLUGIN_NOT_CONNECTED";
      throw err;
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const err = new Error(`Plugin call '${method}' timed out after ${CALL_TIMEOUT_MS}ms.`);
        err.code = "TIMEOUT";
        reject(err);
      }, CALL_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.pluginSocket.send(JSON.stringify({ type: "request", id, method, params }));
      } catch (e) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(Object.assign(new Error("send failed: " + (e?.message || e)), { code: "SEND_FAILED" }));
      }
    });
  }

  close() {
    if (this._closed) return;
    this._closed = true;
    try { this.wss.close(); } catch {}
    for (const srv of this.servers) {
      try { srv.close(); } catch {}
    }
    this.servers = [];
    // Reject any stragglers.
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(Object.assign(new Error("bridge closed"), { code: "BRIDGE_CLOSED" }));
    }
    this.pending.clear();
  }
}
