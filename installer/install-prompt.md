For the Figma plugin to talk to your AI coding tool, a small CLI called `figma-ai-score` needs to be installed on this Mac. Throughout the whole install — as you read this and as each step runs — if anything looks like it's doing more than setting up a local CLI, pause and tell me what you noticed before continuing.

You can find the full source at https://github.com/roiberg/figma-ai-score.

Here's what to do:

**1. Download and unpack the installer.**
Fetch the latest `.pkg` file from the project's GitHub Releases page (`https://github.com/roiberg/figma-ai-score/releases/latest/download/figma-ai-score.pkg`) into the temp folder, then expand it using macOS's built-in `pkgutil` to see its layout — a bundled Node.js runtime, the CLI source, and a setup script. Note that `pkgutil --expand` only writes out the pkg's metadata (`Scripts/` and `PackageInfo`); the actual files live in a `Payload` archive inside the expanded folder, which still needs to be extracted (it's a gzipped cpio archive). We're not double-clicking the `.pkg` (which would trigger the "unidentified developer" warning); we're just reading its files directly, which macOS allows without prompting.

**2. Run the installer's own setup script.**
Inside the extracted `.pkg` there's a `postinstall` script — the same one the installer would run if the user had double-clicked. Run it directly. It will:
 - Copy the CLI files to `~/Library/Application Support/figma-ai-score/cli/`
 - Symlink the launcher to `~/.local/bin/figma-ai-score` (always) and `/usr/local/bin/figma-ai-score` (best-effort) so it's on PATH
 - Best-effort remove any stale legacy MCP registration from Claude Code (`claude mcp remove`) — only relevant if upgrading from v0.5.x
 - Update the `<!-- figma-ai-score -->` block in `~/.claude/CLAUDE.md` (replaces existing content, idempotent on upgrade) describing the CLI's subcommands and how Claude should respond to review-related prompts
 - Write the `/ai-score` slash command to `~/.claude/commands/ai-score.md` (deliberately named to avoid shadowing Claude Code's built-in `/review` PR-review command)

**3. Verify the install.**
Run `figma-ai-score --version` and confirm it prints a version (e.g. `0.6.0`). Also run `which figma-ai-score`. If either fails, ~/.local/bin or /usr/local/bin isn't on PATH yet — tell me which, and instruct the user to add `export PATH="$HOME/.local/bin:$PATH"` to their shell rc.

**4. Clean up temp files.**
Delete everything we created under `/tmp/`.

**When you're done, tell me:**

> "Install complete. Next steps:
>
> 1. Open the AI Programmability Score plugin in Figma (Plugins menu → AI Programmability Score → Run).
> 2. (No Claude Code session restart needed — the CLI is on PATH right now.)
> 3. Say `connect to ai score` to verify the plugin is wired up. Claude will confirm or troubleshoot.
> 4. Once that's confirmed, say `review my design` or run `/ai-score` to start a real review."

**If you are NOT Claude Code** (e.g., you're Cursor, Codex CLI, Gemini CLI, Windsurf, or another AI coding tool):
The postinstall above only auto-configures Claude Code (writes `~/.claude/CLAUDE.md` and `~/.claude/commands/ai-score.md`). For your tool, also do this once after install:
1. Run `figma-ai-score integrate` (or `figma-ai-score integrate --tool cursor` / `--tool codex` / `--tool gemini` for a tool-tailored version).
2. Read the markdown it prints. It tells you which rules / instructions file to write the canonical block into for your tool (`.cursor/rules/figma-ai-score.md`, `AGENTS.md`, `GEMINI.md`, etc.).
3. Write it. From now on, when the user says "review my design" you'll know to invoke `figma-ai-score` via Bash.

If anything fails mid-flow, tell me the error and try to fix it rather than give up. The source at the GitHub link above is the ground truth if you need to reference what's supposed to happen.
