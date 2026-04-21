# Setup (personal / local)

Two things to set up, once. Everything stays on `127.0.0.1`.

## 1. Install + register the MCP server

```bash
cd /Users/royish/Desktop/figma-ai-score/mcp-server
npm install
```

Then register it with Claude Code:

```bash
claude mcp add figma-ai-score node /Users/royish/Desktop/figma-ai-score/mcp-server/index.js
```

Restart Claude Code. The MCP server runs automatically whenever Claude needs it — it also hosts the WebSocket that the plugin connects to. No separate bridge to start.

## 2. Load the Figma plugin

In the Figma desktop app:

1. **Plugins → Development → Import plugin from manifest…**
2. Pick `/Users/royish/Desktop/figma-ai-score/plugin/manifest.json`
3. Run it: **Plugins → Development → AI Programmability Score**

The plugin opens. You should see **Claude: connected** (green pill) once you've used any MCP tool in Claude Code at least once in this session (Claude spawns the MCP server lazily on first tool call).

## 3. Try it

1. In Figma: select one or more frames.
2. In Claude Code: say **"review my designs"**.

Claude will:
- Read your selection and rule preferences from the plugin
- Lock the plugin UI ("Reviewing N frames…")
- Extract each frame's node tree + thumbnail
- Apply the enabled rules
- Send the report back — plugin shows score + breakdown, unlocks, enables Export

## Stop mid-review

Hit **Stop review** in the plugin. Every subsequent tool call Claude makes returns `{ cancelled: true }` and Claude exits its loop.

## Reviewer prompt

Save this as a Claude Code slash command or paste it into your session:

```
You are reviewing Figma frames for AI programmability. When the user says
"review my designs":

1. Call get_preferences and get_selection.
2. Call begin_review with the selection's node ids.
3. For each selected frame: call request_scan and walk the returned tree.
   Apply the enabled rules:
     - components: every node must be a COMPONENT / COMPONENT_SET /
       INSTANCE, OR have an ancestor that is one.
     - colors: every visible SOLID fill/stroke must have either a
       boundVariable OR a fillStyleId/strokeStyleId set. Raw hex fails.
     - typography: every TEXT node must have textStyleId set, OR all of
       boundTypography.{fontSize, fontFamily, fontWeight, lineHeight}
       bound.
     - spacing: for every autolayout frame, each of paddingTop/Right/
       Bottom/Left/itemSpacing must have a bound variable id.
     - effects: every visible effect must come from an effectStyleId.
   Collect offenders per rule with {nodeId, name, detail}.
4. Score = round(100 * (passed_rules / enabled_rules)). Perfect = all
   enabled rules passed with zero offenders.
5. Call submit_report with {frames: [...], generatedAt: now}.
6. If any tool returns {cancelled: true}, stop and tell the user
   "Review cancelled."
```

## Troubleshooting

- **Plugin shows Claude: disconnected** — Claude Code spawns the MCP server lazily. Say anything that triggers a tool (e.g. "what's selected in Figma?") and the pill should flip green.
- **`Plugin call ... timed out`** — the plugin UI is closed, or the frame is too large. Reopen the plugin and retry.
- **Port conflict on 3055** — start Claude with `BRIDGE_PORT=3056` and update `BRIDGE_URL` in `plugin/ui.html` + `plugin/manifest.json`'s `allowedDomains`.
