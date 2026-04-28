# figma-ai-score

A Figma plugin + CLI that scores a frame for **AI Programmability** — how well a design is structured for AI tools to translate into clean, maintainable code. Reviews are orchestrated by your AI coding tool of choice; the plugin is a preferences panel + live selection mirror, the CLI is the bridge between the plugin and the AI.

Works with **Claude Code, Cursor, OpenAI Codex CLI, Gemini CLI, Windsurf**, and any other AI coding tool that can run shell commands.

## Architecture

```
   ┌────────────────────────┐                ┌──────────────────────┐
   │  Figma Plugin UI       │                │  Your AI tool        │
   │  - rule toggles        │                │  (Claude Code,       │
   │  - live selection      │                │   Cursor, Codex,     │
   │  - score + report card │                │   Gemini, …)         │
   └────────────┬───────────┘                └──────────┬───────────┘
                │                                       │ Bash
                │ WebSocket (localhost:3055)            │
                │                                       ▼
                │                              ┌─────────────────────┐
                └─────────────────────────────▶│  figma-ai-score CLI │
                                               │  (one-shot per call)│
                                               └─────────────────────┘
```

Every CLI invocation:
1. Binds 127.0.0.1:3055 briefly.
2. Lets the plugin reconnect (it auto-reconnects every ~2s).
3. Sends one RPC, receives one response.
4. Exits, releasing the port.

Nothing leaves the machine. The plugin only talks to `localhost`. The CLI binds to loopback only.

## Repo layout

```
cli/         # The figma-ai-score CLI (cli.js, bridge.js, integrate.js)
plugin/      # The Figma plugin (manifest.json, code.js, ui.html)
installer/   # build-pkg.sh + scripts/postinstall — produces figma-ai-score.pkg
docs/        # User-facing docs (manual-integration.md, etc.)
```

## Install

The canonical flow: open the plugin in Figma, click **"Copy install instructions"**, paste into your AI coding tool. The AI runs the install via `curl + pkgutil + bash postinstall`; no double-click, no Gatekeeper prompt.

For AI tools other than Claude Code, the install prompt has a self-integrate trailer that tells your AI to write the appropriate rules file. See [`docs/manual-integration.md`](./docs/manual-integration.md) for per-tool recipes if anything fumbles.

## Development

```bash
# Smoke-test the CLI against a live plugin
cd cli && npm install
node cli.js --version
node cli.js get-selection             # plugin must be open in Figma

# Build the .pkg
cd installer && ./build-pkg.sh        # produces ../figma-ai-score.pkg
```

The plugin id is `figma-ai-score-dev-local` (in `plugin/manifest.json`); import it once via Figma's **Plugins → Development → Import plugin from manifest…**.

## Subcommands

| Subcommand | Use |
|---|---|
| `figma-ai-score announce-review-start` | First call before a review (UI feedback). |
| `figma-ai-score get-preferences` | Returns enabled rules + the full review protocol in `instructions`. |
| `figma-ai-score get-selection` | Live selection from the plugin. |
| `figma-ai-score begin-review --node-ids id1,id2,…` | Lock the plugin into review state. |
| `figma-ai-score request-scan --node-id <id>` | Scan tree + `thumbnailPath` (JPEG file for vision rules). |
| `figma-ai-score highlight-nodes --node-ids …` | Flash nodes in Figma. |
| `figma-ai-score submit-report --report-file <path>` | Deliver the final report. |
| `figma-ai-score is-cancelled` | `{ cancelled: bool }`. |
| `figma-ai-score integrate [--tool ...]` | Print integration markdown for a host AI. |

All return JSON on stdout. Errors print JSON to stderr with non-zero exit codes (2 = plugin not connected, 3 = timeout, etc.).

## Releases

See the [releases page](https://github.com/roiberg/figma-ai-score/releases) for the latest `.pkg` and changelog.
