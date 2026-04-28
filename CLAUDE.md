## figma-ai-score

This is a Figma plugin + a CLI binary (`figma-ai-score`) that reviews designs for AI programmability. As of v0.6.0 there is no MCP server — the host AI orchestrates the review by calling CLI subcommands via Bash.

- The CLI source lives in `cli/` (`cli.js` + `bridge.js` + `integrate.js`). It's bundled with Node.js into a self-contained .pkg via `installer/build-pkg.sh`.
- The Figma plugin (`plugin/`) auto-reconnects every 2s to a local WebSocket server on port 3055. Each CLI invocation binds the port, does one RPC, and exits.
- All review logic and rules are returned by `figma-ai-score get-preferences` in the `instructions` field — always call it first and follow what it says.
- A `figma-ai-score integrate [--tool ...]` subcommand prints integration markdown for any host AI tool (Claude Code, Cursor, Codex CLI, Gemini CLI, etc.). Postinstall uses it to regenerate `~/.claude/CLAUDE.md` block + `~/.claude/commands/ai-score.md` so `cli/integrate.js` is the single source of truth.

### Connecting to the plugin

When the user says "connect to ai score" — just run `figma-ai-score get-selection` to confirm the plugin is reachable. Report the connection status and stop. Do NOT start a review.

### Running a review

When the user asks to review, score, check, audit, or evaluate their design/designs/frames/selection — in any phrasing — treat it as a review request. **Your very first Bash invocation must be `figma-ai-score announce-review-start`** (no args, returns `{"ok":true}` instantly). That flips the Figma plugin UI into a "Preparing review…" state so the user sees feedback immediately. *Then* run `figma-ai-score get-preferences` and follow the `instructions` field it returns. The `/ai-score` slash command does the same thing.

### Plugin-not-connected (CLI exit code 2)

**Retry the same subcommand once after a brief pause (~1s) before alarming the user.** The plugin's WebSocket momentarily disconnects during normal reconnect cycles (~every 2s), and a single retry usually succeeds. Don't message the user about this; it's normal jitter.

If the retry also fails (the CLI still exits 2 with `{"error":"...","code":"PLUGIN_NOT_CONNECTED"}` on stderr), the most common cause is that the plugin isn't open in Figma yet. Tell the user:

> The AI Programmability Score plugin isn't open in Figma yet. Open it (Plugins menu → AI Programmability Score → Run), then try again.

### Other CLI errors

| Exit | Meaning | First response |
|---:|---|---|
| 1 | generic failure (bad args, plugin returned an error) | Read stderr — it's `{"error":"...","code":"..."}` JSON. |
| 2 | plugin not connected | Retry once after 1s; if still failing, ask user to open the plugin. |
| 3 | call timed out | Retry once. If persistent, the plugin may be stuck — ask user to close and reopen it. |
| 4 | unknown subcommand | A typo on your end. Run `figma-ai-score --help`. |

EADDRINUSE on port 3055: check `lsof -i :3055`. With the CLI architecture there's no long-lived server hogging the port, but a previous CLI invocation might still be releasing it. Wait ~2s and retry.

Do not retry in a loop without diagnosing first.

### If the `figma-ai-score` command isn't found

Run `which figma-ai-score`. If empty, either the install hasn't run yet, or `~/.local/bin` / `/usr/local/bin` isn't on PATH. Tell the user to add `export PATH="$HOME/.local/bin:$PATH"` to their shell rc and open a new shell.
