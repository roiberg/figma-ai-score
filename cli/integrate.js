// Canonical integration prose for figma-ai-score.
//
// Single source of truth: postinstall regenerates ~/.claude/commands/ai-score.md
// and the CLAUDE.md block from this file by invoking the just-installed CLI
// (`figma-ai-score integrate --tool claude`). The same function powers the
// `integrate` subcommand for users on other AI tools (Cursor, Codex, Gemini).

const SUPPORTED_TOOLS = new Set([
  // Slash-command form for ~/.claude/commands/ai-score.md
  "claude",
  // Compact reference block (between <!-- figma-ai-score --> markers)
  // for ~/.claude/CLAUDE.md
  "claude-md",
  "cursor",
  "codex",
  "gemini"
]);

/**
 * Return the integration markdown for a host AI tool.
 * @param {{ tool?: string|null, version?: string }} opts
 * @returns {string} markdown
 */
export function buildIntegrationDoc({ tool = null, version = "" } = {}) {
  const t = tool && SUPPORTED_TOOLS.has(tool) ? tool : null;
  if (t === "claude")    return claudeSlashCommand(version);
  if (t === "claude-md") return claudeMdBlock(version);
  if (t === "cursor")    return cursorRules(version);
  if (t === "codex")     return codexAgentsBlock(version);
  if (t === "gemini")    return geminiBlock(version);
  return universalDoc(version);
}

// ────────────────────────────────────────────────────────────
// Shared body — the review protocol and troubleshooting that
// every host integration carries verbatim. Differences between
// tools are only in the framing (front-matter, file hints).
// ────────────────────────────────────────────────────────────

function reviewProtocolBody() {
  return `## When to invoke

- The user says "review", "score", "check", "audit", or "evaluate" their design / frame / selection in any phrasing → start a review (steps below).
- The user says "connect to ai score" → just run \`figma-ai-score get-selection\` to confirm the plugin is reachable. Report the connection status and stop. Do NOT start a review.

## Review steps

1. **First action: \`figma-ai-score announce-review-start\`** (no args; returns instantly). This flips the plugin UI into "Preparing review…" so the user sees feedback. Without it the plugin looks frozen for ~10s while you read the instructions.
2. Run \`figma-ai-score get-preferences\`. The JSON response contains \`enabledRules\` and an \`instructions\` field with the complete review protocol. Read those instructions fully and follow them exactly. They tell you which rules to apply and how to score.
3. Run \`figma-ai-score get-selection\` to learn what frames the user wants reviewed. If \`capped\` is true, warn the user only the first \`maxSelection\` are scored.
4. Run \`figma-ai-score begin-review --node-ids id1,id2,…\`.
5. For each frame, run \`figma-ai-score request-scan --node-id <id>\`. The response includes a \`thumbnailPath\` — see "Vision-based rules" below.
6. Walk the tree, apply ONLY the enabled rules, compute scores per the instructions.
7. Write the final report to a temp file (use the \`Write\` tool), then run \`figma-ai-score submit-report --report-file <path>\`. Inline JSON via flags is not supported — the report is too large for shell-quoting.

If any subcommand returns \`{ "cancelled": true }\` in its JSON output, stop the review immediately and tell the user "Review cancelled."

## Vision-based rules

\`request-scan\` writes a JPEG thumbnail of the frame to a system temp dir (path varies; macOS is \`/var/folders/.../figma-ai-score-<pid>/<nodeId>.jpg\`) and returns its absolute path as \`thumbnailPath\`. When AI-mode rules call for visual judgment (the \`naming\` semantic-accuracy check, the \`components\` vision check, \`autolayout\` quality, etc.), use your tool's image-reading capability on that path. Do NOT try to interpret the path string itself — open the file.

## Output format

Every subcommand prints JSON on stdout. On error, JSON is written to stderr in the form \`{"error": "...", "code": "..."}\` and the process exits non-zero:

| Exit | Meaning |
|---:|---|
| 0 | success |
| 1 | generic failure |
| 2 | plugin not connected (open the plugin in Figma) |
| 3 | call timed out |
| 4 | unknown subcommand |

## Troubleshooting

### Exit code 2 / "PLUGIN_NOT_CONNECTED"

The plugin must be open in Figma. **Retry the same call once after a brief pause (~1s) before alarming the user** — momentary disconnects during reconnect cycles are normal jitter; they almost always succeed on retry. If the retry also fails, tell the user exactly:

> The AI Programmability Score plugin isn't open in Figma yet. Open it (Plugins menu → AI Programmability Score → Run), then try again.

### Other errors

- **EADDRINUSE on 3055**: a previous CLI invocation may still hold the port. Wait ~2s and retry. If persistent, check \`lsof -i :3055\` and ask the user before killing.
- **Timeouts (exit 3)**: same retry-once policy as above.

Don't loop on retries. One retry per call, then surface the message to the user.
`;
}

// ────────────────────────────────────────────────────────────
// Per-tool wrappers
// ────────────────────────────────────────────────────────────

function claudeSlashCommand(version) {
  // This is the body of ~/.claude/commands/ai-score.md.
  // Claude Code reads it when the user types /ai-score.
  return `You are about to score the user's Figma design for AI programmability via the figma-ai-score CLI. (This slash command is \`/ai-score\`.)

The CLI is \`figma-ai-score\` on PATH. All steps below are Bash invocations.

${reviewProtocolBody()}
`;
}

function claudeMdBlock(version) {
  // Compact reference for ~/.claude/CLAUDE.md, wrapped in idempotent markers.
  // Postinstall replaces between markers (not skip) so upgrades pick up the
  // current content automatically.
  return `<!-- figma-ai-score -->
## figma-ai-score

A Figma plugin + CLI that reviews designs for AI programmability. The CLI is \`figma-ai-score\` on PATH (no MCP, no session restart needed). Subcommands all return JSON on stdout; on error, JSON is written to stderr with a non-zero exit code.

Subcommands:
- \`figma-ai-score announce-review-start\` — call FIRST whenever the user asks for a review (UI feedback).
- \`figma-ai-score get-preferences\` — returns enabledRules + a long \`instructions\` field with the full review protocol. Always call this and follow what it says.
- \`figma-ai-score get-selection\` — returns the live Figma selection.
- \`figma-ai-score begin-review --node-ids id1,id2,…\` — locks the plugin into review state.
- \`figma-ai-score request-scan --node-id <id>\` — returns the scan tree + a \`thumbnailPath\` (JPEG file). Use \`Read\` on that path for AI-mode visual rules.
- \`figma-ai-score highlight-nodes --node-ids id1,id2,…\` — flashes nodes in Figma.
- \`figma-ai-score submit-report --report-file <path>\` — delivers the final report. Write the JSON to a temp file with \`Write\`, then call this.
- \`figma-ai-score is-cancelled\` — returns \`{ cancelled: bool }\`. Other subcommands also short-circuit with \`{ cancelled: true }\` once cancel is set.

### Connecting

When the user says "connect to ai score" — run \`figma-ai-score get-selection\` to confirm the plugin is reachable. Report status and stop. Don't start a review.

### Running a review

When the user asks to review/score/check/audit/evaluate their design / frame / selection in any phrasing — run \`figma-ai-score announce-review-start\` FIRST, then call \`figma-ai-score get-preferences\` and follow the \`instructions\` field exactly. The \`/ai-score\` slash command runs the same flow.

### Plugin-not-connected (exit code 2)

The CLI exits 2 with \`{"error":"...","code":"PLUGIN_NOT_CONNECTED"}\` on stderr when the Figma plugin isn't open. **Retry the same call once after ~1s before alarming the user** — momentary disconnects during reconnect cycles are normal jitter; the retry usually succeeds. If the retry also fails, tell the user to open the AI Programmability Score plugin in Figma; don't try to restart anything yourself.
<!-- figma-ai-score -->
`;
}

function cursorRules(version) {
  // .cursor/rules/figma-ai-score.md — Cursor auto-loads files in this dir.
  // Front-matter \`alwaysApply: true\` makes the rule active across all chats
  // in the workspace.
  return `---
description: figma-ai-score CLI integration — review Figma designs for AI programmability
alwaysApply: true
---

# figma-ai-score (Cursor integration)

The user has installed the figma-ai-score CLI (v${version}) on PATH. It talks to a Figma plugin over localhost:3055 and returns scan data + token suggestions for designs.

${reviewProtocolBody()}
`;
}

function codexAgentsBlock(version) {
  // Append to AGENTS.md (project-root or ~/.codex/AGENTS.md).
  // Codex reads AGENTS.md on every invocation.
  return `# figma-ai-score (Codex CLI integration)

The user has installed the figma-ai-score CLI (v${version}) on PATH. It talks to a Figma plugin over localhost:3055 and returns scan data + token suggestions for designs.

${reviewProtocolBody()}
`;
}

function geminiBlock(version) {
  // Append to GEMINI.md (project-root or ~/.gemini/GEMINI.md).
  return `# figma-ai-score (Gemini CLI integration)

The user has installed the figma-ai-score CLI (v${version}) on PATH. It talks to a Figma plugin over localhost:3055 and returns scan data + token suggestions for designs.

${reviewProtocolBody()}
`;
}

function universalDoc(version) {
  // Tool-agnostic. Tells the host AI to figure out where to put it.
  return `# figma-ai-score integration

The user has installed the figma-ai-score CLI (v${version}) on PATH. It talks to a Figma plugin over localhost:3055 and returns scan data + token suggestions.

## Set yourself up

Identify which AI coding tool you are running inside (Claude Code, Cursor, OpenAI Codex CLI, Gemini CLI, Windsurf, etc.). Then write the canonical block below to the appropriate rules / instructions file for that tool, so it loads on every session:

| Tool | File |
|---|---|
| Claude Code | \`~/.claude/commands/ai-score.md\` (a slash command) AND/OR a \`<!-- figma-ai-score -->\`-bracketed block in \`~/.claude/CLAUDE.md\` |
| Cursor | \`.cursor/rules/figma-ai-score.md\` (project-level) |
| OpenAI Codex CLI | \`AGENTS.md\` at project root, or \`~/.codex/AGENTS.md\` global |
| Gemini CLI | \`GEMINI.md\` at project root, or \`~/.gemini/GEMINI.md\` global |
| Windsurf | \`.windsurfrules\` at project root |
| Other | Your tool's documented rules / instructions file |

If you'd rather get a tool-tailored version of this doc (with the right front-matter and file hint), run:

\`\`\`
figma-ai-score integrate --tool claude
figma-ai-score integrate --tool cursor
figma-ai-score integrate --tool codex
figma-ai-score integrate --tool gemini
\`\`\`

## Canonical block

The block below is what should end up in your tool's rules file:

---

${reviewProtocolBody()}
---

After writing, verify by running \`figma-ai-score get-selection\` while the AI Programmability Score plugin is open in Figma. You should see a JSON response with the current selection.
`;
}

// CLI entry isn't here — cli.js imports buildIntegrationDoc and prints the result.
