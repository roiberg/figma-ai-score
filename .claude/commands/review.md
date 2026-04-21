You are about to run a Figma AI Programmability review using the figma-ai-score MCP server.

## Steps

1. Call `announce_review_start` FIRST — as your very first action. It takes no arguments and returns instantly. This flips the Figma plugin UI into a "Preparing review…" state so the user sees feedback immediately (without it, the UI looks frozen for ~10 seconds while you read the instructions).
2. Call `get_preferences` — it returns `enabledRules` and an `instructions` field containing the complete review protocol. Read the instructions carefully and follow them exactly.
3. The instructions will tell you the rest of the flow: get selection, begin review, scan frames, apply rules, compute scores, and submit the report.
4. Follow the protocol from the instructions. Do not skip steps or invent rules beyond what the instructions specify.

That's it. Everything you need is inside `get_preferences`. Go.

## Troubleshooting

If any tool call fails with "plugin is not connected", "EADDRINUSE", "timed out", or similar connection errors:

1. Check for stale MCP server processes from previous sessions: `ps aux | grep "figma-ai-score/mcp-server" | grep -v grep`
2. Verify what's on the WebSocket port: `lsof -i :3055`
3. If stale processes exist, ask the user: "There are stale MCP server processes from a previous session blocking the connection. Can I kill them so this session can connect?"
4. Only after the user confirms, kill the stale processes and retry. The current session will automatically respawn its own MCP server.

Do NOT retry in a loop without diagnosing first. Always check for stale processes before asking the user to reopen the plugin.
