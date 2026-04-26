You are about to score the user's Figma design for AI programmability via the figma-ai-score MCP server. (This slash command is `/ai-score` — the figma-ai-score-specific review flow.)

## Steps

1. Call `announce_review_start` FIRST — as your very first action. It takes no arguments and returns instantly. This flips the Figma plugin UI into a "Preparing review…" state so the user sees feedback immediately (without it, the UI looks frozen for ~10 seconds while you read the instructions).
2. Call `get_preferences` — it returns `enabledRules` and an `instructions` field containing the complete review protocol. Read the instructions carefully and follow them exactly.
3. The instructions will tell you the rest of the flow: get selection, begin review, scan frames, apply rules, compute scores, and submit the report.
4. Follow the protocol from the instructions. Do not skip steps or invent rules beyond what the instructions specify.

That's it. Everything you need is inside `get_preferences`. Go.

## Troubleshooting

### If a tool call returns "Figma plugin is not connected"

**First, retry the same call once after a brief pause (~1s).** The plugin's WebSocket can momentarily disconnect during normal reconnect cycles (e.g., right after the MCP server starts, or after a Figma tab refresh). A single retry usually succeeds — the race is real and almost always brief. Don't message the user about this; it's normal jitter, not a problem they need to know about.

**If the retry also fails**, then the most common cause is that the plugin isn't open in Figma yet. Don't escalate to deeper diagnostics yet. Tell the user exactly this and stop:

> The AI Programmability Score plugin isn't open in Figma yet. Open it (in Figma: Plugins menu → AI Programmability Score → Run), then run `/ai-score` again. If it's already open and this still happens, let me know and I'll dig deeper.

Only escalate to stale-process diagnostics below if the user comes back saying the plugin IS open in Figma and the problem persists.

### Deeper diagnostics (only after the user confirms the plugin is open)

If a tool call still fails with "plugin is not connected", "EADDRINUSE", "timed out", or similar connection errors after the plugin is confirmed open:

1. Check for stale MCP server processes from previous sessions: `ps aux | grep "figma-ai-score/mcp-server" | grep -v grep`
2. Verify what's on the WebSocket port: `lsof -i :3055`
3. If stale processes exist, ask the user: "There are stale MCP server processes from a previous session blocking the connection. Can I kill them so this session can connect?"
4. Only after the user confirms, kill the stale processes and retry. The current session will automatically respawn its own MCP server.

Do NOT retry in a loop without diagnosing first.
