## figma-ai-score

This is a Figma plugin + MCP server that reviews designs for AI programmability.

- The MCP server (`mcp-server/index.js`) exposes 7 tools: `get_preferences`, `get_selection`, `begin_review`, `request_scan`, `highlight_nodes`, `submit_report`, `is_cancelled`.
- The Figma plugin (`plugin/`) connects to the MCP server over localhost WebSocket.
- All review logic and rules are returned by `get_preferences` in the `instructions` field — always call it first and follow what it says.

### Connecting to the plugin

When the user says "connect to ai score" — just call `get_selection` to wake up the MCP server and confirm the plugin is connected. Report the connection status and stop. Do NOT start a review.

### Running a review

When the user asks to review, score, check, audit, or evaluate their design/designs/frames/selection — in any phrasing — treat it as a review request. **Your very first action must be calling `announce_review_start`** (it takes no arguments, returns `{ok:true}` instantly). That flips the Figma plugin UI into a "Preparing review…" state so the user sees feedback immediately. *Then* call `get_preferences` and follow the instructions it returns. Do not skip `announce_review_start` — without it the plugin UI looks frozen for ~10 seconds while you're reading instructions. The `/ai-score` slash command does the same thing.

### If the figma-ai-score tools aren't available in this session

**Default assumption: the tools ARE available.** Always attempt `get_selection` or `get_preferences` first when the user asks. Do not preemptively tell the user anything about sessions or installation.

Only use the canned message below if ALL of these are true:
1. You actually tried invoking a figma-ai-score tool (e.g. `get_selection`)
2. The attempt failed because the tool does not exist in your toolbelt — not because the plugin is disconnected, not because of a timeout, not because of any runtime error
3. You can confirm via `claude mcp list` (Bash) that `figma-ai-score` is registered on disk

Only then, say exactly:

> "All is ready. Please start a new Claude Code session and try again — the tools will be available there."

Do not attempt workarounds (restarting the server, re-running `claude mcp add`, etc.) — those won't change the running session's tool registry.

If the tool call fails with "plugin is not connected", that's a different situation — see "Connection errors" below.

### Connection errors

If any tool call fails with "plugin is not connected", "EADDRINUSE", "timed out", or similar:

1. Check for stale MCP server processes from previous sessions: `ps aux | grep "figma-ai-score/mcp-server" | grep -v grep`
2. Verify what's on the WebSocket port: `lsof -i :3055`
3. If stale processes exist, ask the user: "There are stale MCP server processes from a previous session blocking the connection. Can I kill them so this session can connect?"
4. Only after the user confirms, kill the stale processes and retry. The current session will automatically respawn its own MCP server.

Do not retry in a loop without diagnosing first. Always check for stale processes before asking the user to reopen the plugin.
