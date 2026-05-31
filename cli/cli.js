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
//   5  PROTOCOL_MISMATCH — CLI/plugin versions out of sync; update the CLI

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { Bridge } from "./bridge.js";
import { buildIntegrationDoc } from "./integrate.js";

const WS_PORT = 3055;

const VERSION = "0.6.7";

// CLI subcommand → plugin-side RPC method name. Plugin still uses underscored
// names (announce_review_start, etc.) — we keep that wire format unchanged.
const SUBCOMMAND_TO_METHOD = {
  "announce-review-start": "announce_review_start",
  "announce-progress":     "announce_progress",
  "get-preferences":       "get_preferences",
  "get-selection":         "get_selection",
  "begin-and-scan":        "begin_and_scan",
  "highlight-nodes":       "highlight_nodes",
  "submit-report":         "submit_report",
  "is-cancelled":          "is_cancelled",
  "dismiss-review":        "dismiss_review",
  "create-swatch-frame":   "create_swatch_frame",
  // Internal tuning instruments — not user-facing, will be removed when
  // we're done analyzing ETA accuracy.
  "eta-stats":             "get_eta_stats",
  "eta-clear":             "clear_eta_stats",
};

// Per-method call timeout (ms). Instant UI/read RPCs get a short budget so a
// hung call fails fast instead of waiting out the bridge default. The heavy
// scan/submit/swatch methods keep the long default (CALL_TIMEOUT_MS = 55s).
const METHOD_TIMEOUT_MS = {
  get_selection:          8000,
  get_preferences:        8000,
  is_cancelled:           8000,
  announce_review_start:  8000,
  announce_progress:      8000,
  highlight_nodes:        8000,
  dismiss_review:         8000,
  get_eta_stats:          8000,
  clear_eta_stats:        8000,
  // begin_and_scan, submit_report, create_swatch_frame → bridge default (55s)
};

// Retry policy (safe subset — no idempotency keys). Keyed on the bridge error
// .code so we never replay a non-idempotent call that may have already run.
//
// - PRE_SEND codes: the call provably never reached the plugin, so retrying is
//   safe for ANY method (including submit_report / begin_and_scan).
// - POST_SEND codes: the plugin may have executed before the failure, so we
//   retry ONLY read-only/idempotent methods.
const PRE_SEND_RETRY_CODES  = new Set(["PLUGIN_NOT_CONNECTED", "SEND_FAILED", "BIND_FAILED"]);
const POST_SEND_RETRY_CODES = new Set(["TIMEOUT", "EMPTY_RESPONSE", "PLUGIN_DISCONNECTED"]);
const IDEMPOTENT_METHODS    = new Set(["get_selection", "get_preferences", "is_cancelled", "get_eta_stats"]);
// CANCELLED (user intent) and PROTOCOL_MISMATCH (deterministic) are never retried.

function isRetryable(code, method) {
  if (PRE_SEND_RETRY_CODES.has(code)) return true;
  if (POST_SEND_RETRY_CODES.has(code) && IDEMPOTENT_METHODS.has(method)) return true;
  return false;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ────────────────────────────────────────────────────────────
// Output helpers
// ────────────────────────────────────────────────────────────

function emitJson(obj) {
  if (obj === undefined) {
    emitErr("EMPTY_RESPONSE", "plugin returned empty response — reopen the plugin and try again");
    process.exit(1);
  }
  process.stdout.write(JSON.stringify(obj, null, 2) + "\n");
}

function emitErr(code, message, hint) {
  // Single-line JSON to stderr so a host AI can parse it without hunting.
  const payload = { error: message, code };
  if (hint) payload.hint = hint;
  process.stderr.write(JSON.stringify(payload) + "\n");
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
  announce-progress --step <key>          Post a progress update. Keys: starting, reading-preferences, scanning, visual-analysis, scoring, submitting.
  get-preferences                         Returns enabledRules + the full review instructions.
  get-selection                           Returns the live selection from the plugin.
  begin-and-scan --node-ids id1,id2,...   Lock + scan in one call.
                  [--frame-index N]       Optional 1-based index of this frame in the review.
                  [--frame-count N]       Optional total number of frames being reviewed.
                  | --node-ids-file <path|->
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
    case "announce-progress": {
      // Must match the plugin's announce_progress STEP_LABELS keys (code.js).
      // "analyzing" is a backward-compat alias for "scanning".
      const VALID_STEPS = ["starting", "reading-preferences", "scanning", "analyzing", "visual-analysis", "scoring", "submitting"];
      const step = typeof flags["step"] === "string" ? flags["step"].trim() : "";
      if (!step) {
        const err = new Error(`Missing --step for announce-progress. Valid values: ${VALID_STEPS.join(", ")}`);
        err.code = "BAD_ARGS";
        throw err;
      }
      if (!VALID_STEPS.includes(step)) {
        const err = new Error(`Unknown --step "${step}". Valid values: ${VALID_STEPS.join(", ")}`);
        err.code = "BAD_ARGS";
        throw err;
      }
      return { step };
    }
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
    case "begin-and-scan": {
      let nodeIds = [];
      if (typeof flags["node-ids"] === "string") {
        nodeIds = flags["node-ids"].split(",").map(s => s.trim()).filter(Boolean);
      } else if (typeof flags["node-ids-file"] === "string") {
        const path = flags["node-ids-file"];
        const txt = path === "-" ? await readStdinAsync() : readFileSync(path, "utf8");
        nodeIds = txt.split(/[\s,]+/).map(s => s.trim()).filter(Boolean);
      }
      if (!nodeIds.length) {
        const err = new Error(`Missing --node-ids for begin-and-scan.`);
        err.code = "BAD_ARGS";
        throw err;
      }
      const params = { nodeIds };
      if (flags["frame-index"] !== undefined) params.frameIndex = parseInt(flags["frame-index"], 10);
      if (flags["frame-count"] !== undefined) params.frameCount = parseInt(flags["frame-count"], 10);
      // --quiet: backend probe / inspection. Skips the lock + "Reviewing…"
      // banner so a CLI scan for debugging doesn't make the plugin look like
      // it's stuck in a review. Scan output is unchanged.
      if (flags.quiet === true) params.quiet = true;
      return params;
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
    case "create-swatch-frame": {
      if (typeof flags["tokens-file"] !== "string") {
        const err = new Error("Missing --tokens-file for create-swatch-frame (use - for stdin).");
        err.code = "BAD_ARGS";
        throw err;
      }
      const path = flags["tokens-file"];
      const txt = path === "-" ? await readStdinAsync() : readFileSync(path, "utf8");
      let tokens;
      try { tokens = JSON.parse(txt); }
      catch (e) {
        const err = new Error("Couldn't parse tokens JSON: " + e.message);
        err.code = "BAD_INPUT";
        throw err;
      }
      if (!Array.isArray(tokens)) {
        const err = new Error("tokens-file must be a JSON array of {group, name, hex, alpha?, alias?} objects.");
        err.code = "BAD_INPUT";
        throw err;
      }
      const params = { tokens };
      if (typeof flags.title === "string") params.title = flags.title;
      if (typeof flags["page-name"] === "string") params.pageName = flags["page-name"];
      return params;
    }
    default:
      return {};
  }
}

// ────────────────────────────────────────────────────────────
// Thumbnail unpack — begin_and_scan returns a base64 JPEG; we
// write it to a temp file so the host AI can use its native
// image-reading capability (Read in Claude Code, etc.).
// ────────────────────────────────────────────────────────────

function unpackThumbnail(result, params) {
  if (!result || typeof result !== "object" || typeof result.thumbnail !== "string") {
    return result;
  }
  const dir = join(tmpdir(), `figma-ai-score-${process.pid}`);
  try { mkdirSync(dir, { recursive: true }); } catch {}
  const firstNodeId = params.nodeId || (Array.isArray(params.nodeIds) ? params.nodeIds[0] : null) || "scan";
  const safeId = String(firstNodeId).replace(/[^a-zA-Z0-9_-]/g, "_");
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
    // Capture the plugin's advertised method list before closing — the
    // protocol-compat check below uses it to detect stale CLI ↔ fresh plugin
    // (or vice versa) mismatches that the WS handshake alone wouldn't catch.
    const pluginMethods = bridge.pluginMethods;
    bridge.close();
    return {
      name: "plugin-reachable",
      ok: true,
      detail: `handshake in ${Date.now() - start}ms`,
      pluginMethods,
    };
  } catch (e) {
    bridge.close();
    let hint;
    if (e.code === "PLUGIN_NOT_CONNECTED") {
      hint = "Open the AI Programmability readiness plugin in Figma (Plugins menu → AI Programmability readiness → Run).";
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
  let reachable = null;
  if (bindV4.ok || bindV6.ok) {
    reachable = await checkPluginReachable();
    checks.push(reachable);
  } else {
    checks.push({
      name: "plugin-reachable",
      ok: false,
      detail: "skipped — neither loopback family could bind",
      hint: "Resolve the bind failure(s) above first.",
    });
  }

  // Protocol-compat: compare what this CLI calls against what the plugin
  // advertises. Catches stale CLI / fresh plugin (or the reverse) BEFORE
  // mid-review — which `plugin-reachable` alone misses (a successful WS
  // handshake says nothing about whether the RPC vocabulary lines up).
  if (reachable && reachable.ok) {
    if (Array.isArray(reachable.pluginMethods)) {
      const cliMethods = Object.values(SUBCOMMAND_TO_METHOD);
      const missing   = cliMethods.filter(m => !reachable.pluginMethods.includes(m));
      // pluginMethods is removed from the user-facing reachable check —
      // it's an implementation detail, only meaningful here.
      delete reachable.pluginMethods;
      if (missing.length === 0) {
        checks.push({
          name: "protocol-compat",
          ok: true,
          detail: `all ${cliMethods.length} CLI methods supported by plugin`,
        });
      } else {
        checks.push({
          name: "protocol-compat",
          ok: false,
          detail: `plugin missing methods this CLI calls: ${missing.join(", ")}`,
          hint: "The plugin in Figma is older than this CLI. Reload the plugin in Figma (close and reopen it).",
        });
      }
    } else {
      delete reachable.pluginMethods;
      // Plugin connected but didn't send a methods list — it's a pre-handshake
      // build (older than this CLI). The CLI can still call it, but if a method
      // has been removed plugin-side, it'll fail mid-RPC.
      checks.push({
        name: "protocol-compat",
        ok: false,
        detail: "plugin did not advertise its method list (pre-handshake build)",
        hint: "Update the plugin in Figma to a build that sends `methods` in its hello message.",
      });
    }
  } else {
    checks.push({
      name: "protocol-compat",
      ok: false,
      detail: "skipped — plugin not reachable",
      hint: "Resolve the plugin-reachable failure above first.",
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

  // Bind + RPC, with a bounded internal retry. The plugin's WebSocket blips
  // every ~2s during normal reconnect cycles, so a fresh invocation can land in
  // the gap and fail with PLUGIN_NOT_CONNECTED; one retry almost always catches
  // the next reconnect. Each attempt uses a FRESH Bridge — close() leaves the
  // old one dead (servers shut, pending rejected). See isRetryable() for which
  // (code, method) pairs are safe to replay.
  const timeoutMs = METHOD_TIMEOUT_MS[method];
  const MAX_ATTEMPTS = 3;
  let result, lastErr, pluginVersion = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const bridge = new Bridge();
    try {
      await bridge.start();
      result = await bridge.call(method, params, timeoutMs ? { timeoutMs } : undefined);
      pluginVersion = bridge.pluginVersion;
      bridge.close();
      lastErr = null;
      break;
    } catch (e) {
      bridge.close();
      lastErr = e;
      if (attempt < MAX_ATTEMPTS && isRetryable(e.code, method)) {
        // Short backoff. Also covers BIND_FAILED, where the previous attempt's
        // port may not have fully released yet on some OSes.
        await sleep(300 * attempt);
        continue;
      }
      break;
    }
  }

  if (lastErr) {
    const e = lastErr;
    const HINT_CODES = new Set(["PLUGIN_NOT_CONNECTED", "TIMEOUT", "PLUGIN_DISCONNECTED", "BIND_FAILED"]);
    const hint = HINT_CODES.has(e.code) ? "Run figma-ai-score doctor" : undefined;
    if (e.code === "CANCELLED") {
      // User clicked Stop while this call was in flight. Treated as a normal
      // result (exit 0 with {cancelled: true}) — same shape the AI's
      // instructions already handle for sandbox-side cancels.
      emitJson({ cancelled: true, reason: "user stopped review" });
      return 0;
    }
    // announce_progress is a fire-and-forget UI poke. A slow/timed-out progress
    // banner must NOT abort the review — degrade to a non-fatal warning (exit 0).
    // (announce_review_start stays fatal: it returns the selection the flow needs.)
    if (e.code === "TIMEOUT" && method === "announce_progress") {
      emitJson({ ok: true, warning: "announce_progress timed out (non-fatal)" });
      return 0;
    }
    if (e.code === "PLUGIN_NOT_CONNECTED") { emitErr("PLUGIN_NOT_CONNECTED", e.message, hint); return 2; }
    if (e.code === "TIMEOUT")              { emitErr("TIMEOUT", e.message, hint); return 3; }
    if (e.code === "PROTOCOL_MISMATCH")    { emitErr("PROTOCOL_MISMATCH", e.message); return 5; }
    emitErr(e.code || "FAILURE", e.message || String(e), hint);
    return 1;
  }

  if (subcommand === "begin-and-scan") {
    result = unpackThumbnail(result, params);
  }

  // Version-skew notice — only on announce-review-start (first call of a
  // review) so it's surfaced once, up front. The plugin advertises its version
  // in the handshake; if it differs from this CLI's, one side is stale. Most
  // dangerous case: plugin newer than CLI (the CLI silently runs old behavior
  // because nothing rejects an unknown-but-uncalled method).
  if (subcommand === "announce-review-start" && pluginVersion && pluginVersion !== VERSION
      && result && typeof result === "object") {
    const cmp = compareVersions(VERSION, pluginVersion);
    result.versionNotice = cmp < 0
      ? `Your figma-ai-score CLI (${VERSION}) is OLDER than the Figma plugin (${pluginVersion}). Some features may not work correctly. Tell the user to reinstall the CLI: copy the install instructions from the plugin's "Copy install instructions" button and run them.`
      : `The Figma plugin (${pluginVersion}) is older than your figma-ai-score CLI (${VERSION}). Tell the user to update the plugin in Figma to the latest build (re-import the plugin folder).`;
  }

  emitJson(result);
  return 0;
}

// Compare dotted numeric versions. Returns -1 if a<b, 1 if a>b, 0 if equal.
// Non-numeric / missing segments treated as 0. Good enough for "0.6.7" forms.
function compareVersions(a, b) {
  const pa = String(a).split(".").map(n => parseInt(n, 10) || 0);
  const pb = String(b).split(".").map(n => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return 0;
}

main().then(code => process.exit(code)).catch(err => {
  emitErr("FATAL", err && err.message || String(err));
  process.exit(1);
});
