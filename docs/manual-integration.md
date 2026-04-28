# Manual integration for non-Claude-Code tools

If your AI coding tool didn't auto-set itself up after `figma-ai-score integrate`, here's the recipe.

The CLI is `figma-ai-score` on PATH. It exposes 9 subcommands, all of which print JSON to stdout. Run `figma-ai-score --help` to see them. The standard review flow is:

```
figma-ai-score announce-review-start
figma-ai-score get-preferences           # read .instructions, follow it exactly
figma-ai-score get-selection
figma-ai-score begin-review --node-ids id1,id2,…
figma-ai-score request-scan --node-id <id>     # for each frame; thumbnailPath returned
figma-ai-score submit-report --report-file <path>
```

## Cursor

1. In your project root, create `.cursor/rules/figma-ai-score.md`.
2. Paste the output of `figma-ai-score integrate --tool cursor` into it.
3. Cursor auto-loads `.cursor/rules/*.md` on every chat in that workspace.

For workspace-wide setup, put the file in the workspace's user-rules location instead.

## OpenAI Codex CLI

1. Append the output of `figma-ai-score integrate --tool codex` to `AGENTS.md` at your repo root, OR to `~/.codex/AGENTS.md` for global use.
2. Codex reads `AGENTS.md` on every invocation.

## Gemini CLI

1. Append the output of `figma-ai-score integrate --tool gemini` to `GEMINI.md` at your repo root, OR to `~/.gemini/GEMINI.md` for global use.

## Windsurf

1. Append the universal output of `figma-ai-score integrate` to `.windsurfrules` at your repo root.

## Claude Code (manual fallback)

The `.pkg` postinstall already does this automatically. If you ever need to redo it manually:

1. Run `figma-ai-score integrate --tool claude` and write the output to `~/.claude/commands/ai-score.md` (this is the slash command).
2. Run `figma-ai-score integrate --tool claude-md` and append the output to `~/.claude/CLAUDE.md` (the block is bracketed by `<!-- figma-ai-score -->` markers and is idempotent — paste once, then re-paste to update on upgrade).

## Anything else

Run `figma-ai-score integrate` (no flags) for the universal version. It explains the pattern and emits a canonical block you can drop into whatever rules / instructions file your tool uses.

## Verifying

After integration, test by running this in your tool's chat:

> connect to ai score

The AI should run `figma-ai-score get-selection` via Bash and report the connection status. If it does, you're set up. If not, the AI's rules file isn't being loaded — check the file location and your tool's documentation for rules-file conventions.
