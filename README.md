# figma-ai-score

A Figma plugin that gives a selected frame an **AI Programmability Score** — a measure of how well a design is built for AI-assisted development. All scoring is performed by the user's Claude Code (or any MCP-capable agent) running locally. The plugin is a preferences panel + live selection mirror; the agent is the brain.

## Architecture

```
    ┌─────────────────────┐         ┌──────────────────┐
    │  Figma Plugin UI    │         │  Claude Code     │
    │  - rule toggles     │         │  (the brain)     │
    │  - live selection   │         └────────┬─────────┘
    │  - stop / report    │                  │ MCP (stdio)
    └──────────┬──────────┘                  │
               │ WebSocket                   │
               ▼                             ▼
          ┌───────────────────────────────────────┐
          │   Local bridge server (127.0.0.1)     │
          │   - RPC relay + cancel flag           │
          └───────────────────────────────────────┘
```

Nothing leaves the machine. Bridge binds to `127.0.0.1`, MCP is stdio, plugin talks only to `localhost`.

## Rules (v1)

All weighted equally, toggleable per scan:

1. Every element is a component or part of a component
2. All colors bound to variables/styles
3. All typography bound to styles
4. All spacing bound to variables
5. All effects bound to styles

Claude applies the rules from a system prompt. Adding a rule = adding a toggle + one line of prompt, no plugin/bridge code change.

## Repo layout

```
bridge/       # Node WebSocket relay (localhost:3055)
mcp-server/   # MCP server, spawned by Claude Code
plugin/       # Figma plugin (manifest.json, code.js, ui.html)
```

## Setup

See [SETUP.md](./SETUP.md) once the first milestone is working.

## Status

v0 scaffold — bridge + MCP stub + plugin skeleton. Rule logic lives in the agent prompt; start with `get_selection` as the end-to-end smoke test.
