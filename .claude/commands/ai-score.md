You are about to score the user's Figma design for AI programmability via the figma-ai-score CLI. (This slash command is `/ai-score`.)

The CLI is `figma-ai-score` on PATH. All steps below are Bash invocations.

## When to invoke

- The user says "review", "score", "check", "audit", or "evaluate" their design / frame / selection in any phrasing → start a review (steps below).
- The user says "connect to ai score" → just run `figma-ai-score get-selection` to confirm the plugin is reachable. Report the connection status and stop. Do NOT start a review.

## Review steps

1. **`figma-ai-score announce-review-start`** — FIRST, always. Returns instantly and flips the plugin UI to "Preparing…". The response includes `selection` (current frames) — use it instead of calling `get-selection` separately.
   - **If `selection.frames` is empty**: tell the user "No frame selected — please select a frame in Figma and try again." Do NOT proceed.
2. **`figma-ai-score get-preferences`** — read `enabledRules` and the full `instructions` field. Follow the instructions exactly.
3. For each frame (i of N):
   - **`figma-ai-score begin-and-scan --node-ids <id> --frame-index i --frame-count N`** — returns scan tree, lintResults, nodeStats, thumbnailPath.
   - Read `thumbnailPath` for the enabled vision rules. If `lintResults.saturated` is true, use the thumbnail only to enrich the offenders already shown (e.g. add `suggestedName` to capped naming offenders) — don't hunt for new ones.
   - **`figma-ai-score announce-progress --step scoring`** — the ONE progress call to make, right before computing scores.
   - Apply rules and compute score.
4. Write the final report JSON to **exactly `/tmp/figma-ai-score-report.json`** (use the `Write` tool — this exact path is pre-approved in the permission allowlist, so do NOT pick a different path or you'll trigger an approval prompt), then **`figma-ai-score submit-report --report-file /tmp/figma-ai-score-report.json`**.

The plugin posts its own progress for every other step (initialising, reading preferences, scanning, visual review, submitting) straight from the RPC handlers — do NOT call `announce-progress` for those. Extra CLI calls only add latency and reconnect surface. `scoring` is the only step the plugin can't detect, so it's the only one you announce. (`announce-progress` accepts `--step` values `starting`, `reading-preferences`, `scanning`, `visual-analysis`, `scoring`, `submitting`; arbitrary strings are rejected.)

**Run each `figma-ai-score` subcommand as its own standalone Bash call.** Do NOT chain with `&&`/`||`/`;`, do NOT pipe, do NOT redirect (`>`, `>>`, heredocs) — write the report file with the Write tool, never `cat >`. Compound, piped, or redirected commands can't match the pre-approved `Bash(figma-ai-score:*)` / `Write(/tmp/figma-ai-score-*)` allowlist, so they prompt for permission every time (with no "always allow"). One simple command per call stays silent.

If any subcommand returns `{ "cancelled": true }` in its JSON output, stop the review immediately and tell the user "Review cancelled."

## Vision-based rules

`begin-and-scan` writes a JPEG thumbnail of the frame to a system temp dir (path varies; macOS is `/var/folders/.../figma-ai-score-<pid>/<nodeId>.jpg`) and returns its absolute path as `thumbnailPath`. When AI-mode rules call for visual judgment (the `naming` semantic-accuracy check, the `components` vision check, `autolayout` quality, etc.), use your tool's image-reading capability on that path. Do NOT try to interpret the path string itself — open the file.

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

> The AI Programmability readiness plugin isn't open in Figma yet. Open it (Plugins menu → AI Programmability readiness → Run), then try again.

### BIND_FAILED

If a call fails with `{"code":"BIND_FAILED"}`, **read the message** — the CLI distinguishes the two real causes:

- **"Operation not permitted"** → your sandbox is blocking `bind()` on localhost. Most common in Codex CLI before network access has been granted for the session. Ask the user to grant network access; don't loop on retries.
- **"Port 3055 is already in use"** → another process holds the port. The CLI message includes the `lsof` invocation to identify the holder.

### Other errors

- **Timeouts (exit 3)**: same retry-once policy as PLUGIN_NOT_CONNECTED.

When in doubt, run `figma-ai-score doctor`. It runs each runtime check independently (CLI on PATH, can bind 127.0.0.1, can bind ::1, plugin reachable) and labels each result with a specific actionable hint. Treat its output as authoritative — don't second-guess it.

Don't loop on retries. One retry per call, then surface the message to the user.

