You are about to score the user's Figma design for AI programmability via the figma-ai-score CLI. (This slash command is `/ai-score`.)

The CLI is `figma-ai-score` on PATH. All steps below are Bash invocations.

## When to invoke

- The user says "review", "score", "check", "audit", or "evaluate" their design / frame / selection in any phrasing → start a review (steps below).
- The user says "connect to ai score" → just run `figma-ai-score get-selection` to confirm the plugin is reachable. Report the connection status and stop. Do NOT start a review.

## Review steps

1. **First action: `figma-ai-score announce-review-start`** (no args; returns instantly). This flips the plugin UI into "Preparing review…" so the user sees feedback. Without it the plugin looks frozen for ~10s while you read the instructions.
2. Run `figma-ai-score get-preferences`. The JSON response contains `enabledRules` and an `instructions` field with the complete review protocol. Read those instructions fully and follow them exactly. They tell you which rules to apply and how to score.
3. Run `figma-ai-score get-selection` to learn what frames the user wants reviewed. If `capped` is true, warn the user only the first `maxSelection` are scored.
4. Run `figma-ai-score begin-review --node-ids id1,id2,…`.
5. For each frame, run `figma-ai-score request-scan --node-id <id>`. The response includes a `thumbnailPath` — see "Vision-based rules" below.
6. Walk the tree, apply ONLY the enabled rules, compute scores per the instructions.
7. Write the final report to a temp file (use the `Write` tool), then run `figma-ai-score submit-report --report-file <path>`. Inline JSON via flags is not supported — the report is too large for shell-quoting.

If any subcommand returns `{ "cancelled": true }` in its JSON output, stop the review immediately and tell the user "Review cancelled."

## Vision-based rules

`request-scan` writes a JPEG thumbnail of the frame to a system temp dir (path varies; macOS is `/var/folders/.../figma-ai-score-<pid>/<nodeId>.jpg`) and returns its absolute path as `thumbnailPath`. When AI-mode rules call for visual judgment (the `naming` semantic-accuracy check, the `components` vision check, `autolayout` quality, etc.), use your tool's image-reading capability on that path. Do NOT try to interpret the path string itself — open the file.

## Output format

Every subcommand prints JSON on stdout. On error, JSON is written to stderr in the form `{"error": "...", "code": "..."}` and the process exits non-zero:

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

- **EADDRINUSE on 3055**: a previous CLI invocation may still hold the port. Wait ~2s and retry. If persistent, check `lsof -i :3055` and ask the user before killing.
- **Timeouts (exit 3)**: same retry-once policy as above.

Don't loop on retries. One retry per call, then surface the message to the user.

