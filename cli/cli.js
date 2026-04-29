#!/usr/bin/env node
// figma-ai-score CLI — argv parsing, subcommand dispatch, JSON output.
//
// All subcommands except `integrate`, `--version`, `--help` connect to the
// Figma plugin over a localhost WebSocket (cli/bridge.js, Pattern B: ephemeral
// bind). Each invocation does ONE RPC and exits.
//
// Exit codes:
//   0  success (including {cancelled:true} which is a normal result)
//   1  generic failure (bad args, plugin returned error, JSON parse, etc.)
//   2  PLUGIN_NOT_CONNECTED — open the plugin in Figma
//   3  TIMEOUT
//   4  UNKNOWN_SUBCOMMAND

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { Bridge } from "./bridge.js";
import { buildIntegrationDoc } from "./integrate.js";

const WS_PORT = 3055;

const VERSION = "0.6.4";

// CLI subcommand → plugin-side RPC method name. Plugin still uses underscored
// names (announce_review_start, etc.) — we keep that wire format unchanged.
const SUBCOMMAND_TO_METHOD = {
  "announce-review-start": "announce_review_start",
  "get-preferences":       "get_preferences",
  "get-selection":         "get_selection",
  "begin-review":          "begin_review",
  "request-scan":          "request_scan",
  "highlight-nodes":       "highlight_nodes",
  "submit-report":         "submit_report",
  "is-cancelled":          "is_cancelled",
};

// ────────────────────────────────────────────────────────────
// Output helpers
// ────────────────────────────────────────────────────────────

function emitJson(obj) {
  process.stdout.write(JSON.stringify(obj, null, 2) + "\n");
}

function emitErr(code, message) {
  // Single-line JSON to stderr so a host AI can parse it without hunting.
  process.stderr.write(JSON.stringify({ error: message, code }) + "\n");
}

// ────────────────────────────────────────────────────────────
// Tiny flag parser. We have ~5 flag shapes total — adding a dep
// like commander would be silly. `--key value` and `--bool` only.
// ────────────────────────────────────────────────────────────

function parseFlags(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next == null || next.startsWith("--")) {
      flags[key] = true;
    } else {
      flags[key] = next;
      i++;
    }
  }
  return flags;
}

function readStdinAsync() {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", chunk => { data += chunk; });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

// ────────────────────────────────────────────────────────────
// Help
// ────────────────────────────────────────────────────────────

function printHelp() {
  process.stdout.write(`figma-ai-score v${VERSION} — review Figma designs for AI programmability

Usage:
  figma-ai-score <subcommand> [flags]

Subcommands (all return JSON on stdout):
  announce-review-start                   Tell the plugin a review is starting (call this FIRST).
  get-preferences                         Returns enabledRules + the full review instructions.
  get-selection                           Returns the live selection from the plugin.
  begin-review --node-ids id1,id2,...     Lock the plugin into review state.
                  | --node-ids-file <path|->
  request-scan --node-id <id>             Returns the scan tree + a thumbnailPath (PNG).
  highlight-nodes --node-ids id1,id2,...  Flash the given nodes in Figma.
  submit-report --report-file <path|->    Deliver the final report (use - for stdin).
  is-cancelled                            Returns { cancelled: bool }.
  integrate [--tool <name>]               Print the integration doc for a host AI.
                                          tool: claude | cursor | codex | gemini
                                          (claude-md, claude-permissions are
                                          internal — used by postinstall.)
  doctor                                  Run runtime checks (PATH, bind, plugin reachable).
                                          Exits non-zero if any check fails.

Flags:
  --version, -v                           Print version.
  --help, -h                              Show this help.

Exit codes:
  0  success
  1  generic failure
  2  plugin is not connected
  3  call timed out
  4  unknown subcommand

The CLI talks to the figma-ai-score Figma plugin over localhost:3055. The plugin
must be open in Figma for any subcommand other than 'integrate', '--version',
or '--help' to succeed.
`);
}

// ────────────────────────────────────────────────────────────
// Per-subcommand param builders
// ────────────────────────────────────────────────────────────

async function buildParams(subcommand, flags) {
  switch (subcommand) {
    case "begin-review":
    case "highlight-nodes": {
      let nodeIds = [];
      if (typeof flags["node-ids"] === "string") {
        nodeIds = flags["node-ids"].split(",").map(s => s.trim()).filter(Boolean);
      } else if (typeof flags["node-ids-file"] === "string") {
        const path = flags["node-ids-file"];
        const txt = path === "-" ? await readStdinAsync() : readFileSync(path, "utf8");
        nodeIds = txt.split(/[\s,]+/).map(s => s.trim()).filter(Boolean);
      }
      if (!nodeIds.length) {
        const err = new Error(`Missing --node-ids for ${subcommand}.`);
        err.code = "BAD_ARGS";
        throw err;
      }
      return { nodeIds };
    }
    case "request-scan": {
      if (typeof flags["node-id"] !== "string") {
        const err = new Error("Missing --node-id for request-scan.");
        err.code = "BAD_ARGS";
        throw err;
      }
      return { nodeId: flags["node-id"] };
    }
    case "submit-report": {
      if (typeof flags["report-file"] !== "string") {
        const err = new Error("Missing --report-file for submit-report (use - for stdin).");
        err.code = "BAD_ARGS";
        throw err;
      }
      const path = flags["report-file"];
      const txt = path === "-" ? await readStdinAsync() : readFileSync(path, "utf8");
      let report;
      try { report = JSON.parse(txt); }
      catch (e) {
        const err = new Error("Couldn't parse report JSON: " + e.message);
        err.code = "BAD_REPORT";
        throw err;
      }
      return { report };
    }
    default:
      return {};
  }
}

// ────────────────────────────────────────────────────────────
// Thumbnail unpack — request_scan returns a base64 PNG; we
// write it to a temp file so the host AI can use its native
// image-reading capability (Read in Claude Code, etc.).
// ────────────────────────────────────────────────────────────

function unpackThumbnail(result, params) {
  if (!result || typeof result !== "object" || typeof result.thumbnail !== "string") {
    return result;
  }
  const dir = join(tmpdir(), `figma-ai-score-${process.pid}`);
  try { mkdirSync(dir, { recursive: true }); } catch {}
  const safeId = String(params.nodeId || "scan").replace(/[^a-zA-Z0-9_-]/g, "_");
  // The plugin emits JPEG (small + good enough for vision rules). Match the
  // extension so file-readers can sniff confidently.
  const path = join(dir, `${safeId}.jpg`);
  try {
    writeFileSync(path, Buffer.from(result.thumbnail, "base64"));
  } catch (e) {
    // If the write fails, leave the base64 in so the caller still has data.
    return result;
  }
  const { thumbnail, ...rest } = result;
  return { ...rest, thumbnailPath: path };
}

// ────────────────────────────────────────────────────────────
// `doctor` — runtime diagnostic.
//
// This subcommand exists because the failure modes for review-time problems
// look identical from a user's seat ("the review didn't run") but resolve to
// very different fixes. Codex CLI sandbox blocking bind() looks the same as
// a stale node holding the port, which looks the same as the plugin not
// being open. Doctor runs each check independently and labels each result
// with a specific actionable hint.
//
// Output is JSON like every other subcommand, so the host AI can parse and
// summarize it. Exit code is 0 if all checks pass, 1 otherwise.
// ────────────────────────────────────────────────────────────

function checkOnPath() {
  return new Promise(resolve => {
    let stdout = "";
    let proc;
    try {
      proc = spawn("which", ["figma-ai-score"]);
    } catch (e) {
      resolve({ name: "cli-on-path", ok: false, detail: "couldn't run `which`", hint: e.message });
      return;
    }
    proc.stdout.on("data", d => { stdout += d.toString(); });
    proc.on("error", e => {
      resolve({ name: "cli-on-path", ok: false, detail: "couldn't run `which`", hint: e.message });
    });
    proc.on("close", code => {
      const path = stdout.trim();
      if (code === 0 && path) {
        resolve({ name: "cli-on-path", ok: true, detail: path });
      } else {
        resolve({
          name: "cli-on-path",
          ok: false,
          detail: "figma-ai-score is not on PATH",
          hint: `Add ~/.local/bin to PATH: \`export PATH="$HOME/.local/bin:$PATH"\` in your shell rc.`,
        });
      }
    });
  });
}

function checkBind(host) {
  // Try to listen on host:WS_PORT, immediately close on success. Surfaces
  // the libc errno (EPERM, EADDRINUSE, EAFNOSUPPORT) so we can map it to a
  // hint instead of dumping a generic node error.
  return new Promise(resolve => {
    const srv = createServer();
    srv.on("error", err => {
      try { srv.close(); } catch {}
      if (err.code === "EAFNOSUPPORT" || err.code === "EADDRNOTAVAIL") {
        // Family unavailable on this host (e.g. ::1 disabled) — not a failure.
        resolve({
          name: `bind-${host}`,
          ok: true,
          detail: `${host} family unavailable on this host (skipped)`,
        });
        return;
      }
      let hint;
      if (err.code === "EPERM" || err.code === "EACCES") {
        hint = "Your AI tool's sandbox is blocking bind() on localhost. In Codex CLI, grant network permission for this session and retry.";
      } else if (err.code === "EADDRINUSE") {
        hint = `Another process holds the port. Find it with \`lsof -nP -iTCP:${WS_PORT} -sTCP:LISTEN\` and stop it.`;
      }
      resolve({
        name: `bind-${host}`,
        ok: false,
        detail: `${err.code || "ERROR"}: ${err.message}`,
        ...(hint ? { hint } : {}),
      });
    });
    srv.listen(WS_PORT, host, () => {
      srv.close(() => {
        resolve({ name: `bind-${host}`, ok: true, detail: `bound ${host}:${WS_PORT}` });
      });
    });
  });
}

async function checkPluginReachable() {
  const bridge = new Bridge();
  const start = Date.now();
  try {
    await bridge.start();
    bridge.close();
    return {
      name: "plugin-reachable",
      ok: true,
      detail: `handshake in ${Date.now() - start}ms`,
    };
  } catch (e) {
    bridge.close();
    let hint;
    if (e.code === "PLUGIN_NOT_CONNECTED") {
      hint = "Open the AI Programmability Score plugin in Figma (Plugins menu → AI Programmability Score → Run).";
    } else if (e.code === "BIND_FAILED") {
      hint = "Couldn't stand up the bridge — see the bind checks above for the specific cause.";
    }
    return {
      name: "plugin-reachable",
      ok: false,
      detail: e.message,
      ...(hint ? { hint } : {}),
    };
  }
}

async function runDoctor() {
  const checks = [];
  checks.push(await checkOnPath());

  // Bind tests run sequentially (not parallel) so we don't race ourselves
  // for the same port.
  const bindV4 = await checkBind("127.0.0.1");
  checks.push(bindV4);
  const bindV6 = await checkBind("::1");
  checks.push(bindV6);

  // Plugin-reachable is only meaningful if at least one bind worked. If both
  // binds failed, the bridge can't even stand up, so handshake will fail
  // with the same root cause — skip it to keep the report uncluttered.
  if (bindV4.ok || bindV6.ok) {
    checks.push(await checkPluginReachable());
  } else {
    checks.push({
      name: "plugin-reachable",
      ok: false,
      detail: "skipped — neither loopback family could bind",
      hint: "Resolve the bind failure(s) above first.",
    });
  }

  const ok = checks.every(c => c.ok);
  emitJson({ ok, checks });
  return ok ? 0 : 1;
}

// ────────────────────────────────────────────────────────────
// Main
// ────────────────────────────────────────────────────────────

async function main() {
  const argv = process.argv.slice(2);
  const subcommand = argv[0];

  if (!subcommand || subcommand === "--help" || subcommand === "-h" || subcommand === "help") {
    printHelp();
    return 0;
  }
  if (subcommand === "--version" || subcommand === "-v") {
    process.stdout.write(VERSION + "\n");
    return 0;
  }
  if (subcommand === "integrate") {
    const flags = parseFlags(argv.slice(1));
    const tool = typeof flags.tool === "string" ? flags.tool : null;
    process.stdout.write(buildIntegrationDoc({ tool, version: VERSION }));
    return 0;
  }
  if (subcommand === "doctor") {
    return await runDoctor();
  }

  const method = SUBCOMMAND_TO_METHOD[subcommand];
  if (!method) {
    emitErr("UNKNOWN_SUBCOMMAND", `Unknown subcommand: ${subcommand}. Run 'figma-ai-score --help'.`);
    return 4;
  }

  const flags = parseFlags(argv.slice(1));
  let params;
  try {
    params = await buildParams(subcommand, flags);
  } catch (e) {
    emitErr(e.code || "BAD_ARGS", e.message || String(e));
    return 1;
  }

  const bridge = new Bridge();
  let result;
  try {
    await bridge.start();
    result = await bridge.call(method, params);
  } catch (e) {
    bridge.close();
    if (e.code === "PLUGIN_NOT_CONNECTED") {
      emitErr("PLUGIN_NOT_CONNECTED", e.message);
      return 2;
    }
    if (e.code === "TIMEOUT") {
      emitErr("TIMEOUT", e.message);
      return 3;
    }
    emitErr(e.code || "FAILURE", e.message || String(e));
    return 1;
  }
  bridge.close();

  if (subcommand === "request-scan") {
    result = unpackThumbnail(result, params);
  }

  emitJson(result);
  return 0;
}

main().then(code => process.exit(code)).catch(err => {
  emitErr("FATAL", err && err.message || String(err));
  process.exit(1);
});
