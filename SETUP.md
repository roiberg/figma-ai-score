# Setup

For end users:

1. In Figma, open the AI Programmability Score plugin (Plugins menu → AI Programmability Score → Run).
2. Click **"Copy install instructions"** in the plugin's setup banner.
3. Paste into your AI coding tool (Claude Code, Cursor, Codex CLI, Gemini CLI, …). The AI handles the rest — download the .pkg from GitHub Releases, extract it, run the postinstall.
4. Done. No session restart needed.

For other AI coding tools the install prompt has a self-integrate trailer. If your AI doesn't auto-set-up, see [`docs/manual-integration.md`](./docs/manual-integration.md) for per-tool rules-file recipes.

## Development setup

To work on the CLI / plugin / installer locally:

```bash
git clone https://github.com/roiberg/figma-ai-score
cd figma-ai-score

# Smoke-test the CLI against a live plugin
cd cli && npm install
node cli.js --version
node cli.js get-selection           # plugin must be running in Figma

# Build the macOS .pkg
cd ../installer && ./build-pkg.sh   # output: ../figma-ai-score.pkg
```

Import the plugin once into the Figma desktop app via **Plugins → Development → Import plugin from manifest…** pointing at `plugin/manifest.json`. The plugin id is `figma-ai-score-dev-local`.

Port 3055 (loopback only) is used for the plugin↔CLI WebSocket. If something else on your machine binds it, override with `BRIDGE_PORT=3056 node cli.js …` and update `plugin/ui.html`'s `BRIDGE_URL`.
