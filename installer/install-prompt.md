For the Figma plugin to talk to your AI coding tool, a small CLI called `figma-ai-score` needs to be installed on this Mac. This prompt is designed to be transparent about every change the install makes — read the disclosures below before running anything, and if anything looks like it's doing more than what's described, stop and tell me what you noticed.

Source code: https://github.com/roiberg/figma-ai-score (this prompt comes from `installer/install-prompt.md` in that repo).

## What this install does

Five things, all on the local Mac, no network calls beyond the one-time pkg download:

1. **Installs a self-contained CLI** at `~/Library/Application Support/figma-ai-score/cli/` (CLI source + bundled Node.js runtime + the `ws` npm dependency, ~30 MB). Nothing else gets installed system-wide.
2. **Symlinks the launcher** to `~/.local/bin/figma-ai-score` (always) and `/usr/local/bin/figma-ai-score` (best-effort, no sudo prompt — just `ln -sf` and ignored if not writable).
3. **Adds a documentation block** to `~/.claude/CLAUDE.md` between `<!-- figma-ai-score -->` markers, describing the CLI's subcommands so Claude Code knows what to do when you say "review my design." You can preview the exact contents before approving (see "Inspect first" below).
4. **Adds a `/ai-score` slash command** at `~/.claude/commands/ai-score.md` so you can run reviews with `/ai-score`. Same preview is available.
5. **Adds four entries to the `permissions.allow` array in `~/.claude/settings.json`** so Claude Code doesn't prompt on every review. The exact entries are:
   - `Bash(figma-ai-score:*)` — lets `figma-ai-score <subcommand>` run without a permission prompt. Does NOT cover any other command.
   - `Read(/var/folders/**/figma-ai-score-*/**)` — lets Claude read the JPEG thumbnails the CLI writes to `$TMPDIR` for visual rules. Scoped to `figma-ai-score-*` directories only.
   - `Read(/tmp/figma-ai-score-*)` — same, for legacy `/tmp` paths.
   - `Write(/tmp/figma-ai-score-*)` — lets Claude write the report JSON during a review.

   These are persistent grants. The merge is idempotent (never clobbers, never duplicates) and refuses to overwrite a malformed `settings.json` rather than corrupting it. The four entries are also published as `figma-ai-score integrate --tool claude-permissions` (single source of truth in `cli/integrate.js`).

That's the complete list. The install does NOT modify your shell rc, NOT write to `/etc/`, NOT install a LaunchAgent or daemon, NOT touch other AI tools' config files (see "If you are NOT Claude Code" below for that).

## Steps

**1. Download and extract.**
Stage the `.pkg` in one folder, then extract its Payload to the path the postinstall expects by default — `/tmp/figma-ai-score-pkg/`. Two cd steps so neither path needs an env var later:

```
# Download into one folder
mkdir -p /tmp/figma-ai-score-dl && cd /tmp/figma-ai-score-dl
curl -fsSL -o figma-ai-score.pkg https://github.com/roiberg/figma-ai-score/releases/latest/download/figma-ai-score.pkg
pkgutil --expand figma-ai-score.pkg expanded

# Extract the Payload (gzipped cpio) to /tmp/figma-ai-score-pkg —
# postinstall's default STAGE; produces cli/ inside it. No env var needed.
mkdir -p /tmp/figma-ai-score-pkg && cd /tmp/figma-ai-score-pkg
gunzip -c /tmp/figma-ai-score-dl/expanded/Payload | cpio -i
```

After this, you'll have:
- `/tmp/figma-ai-score-dl/expanded/Scripts/postinstall` — the install script you'll run in step 2.
- `/tmp/figma-ai-score-pkg/cli/` — the staged CLI (bundled Node runtime, `cli.js`, `bridge.js`, `integrate.js`, `launcher.sh`, `node_modules/ws`).

We're not invoking the pkg as a system installer (which is the path that runs Gatekeeper checks for unsigned packages); we're just reading its files. macOS doesn't gate that. The pkg is unsigned because it's a hobby project — the source linked above is the ground truth, and you can read every file before running anything.

## Inspect first (optional)

Now that step 1 has produced the staged CLI, you can preview every change the postinstall is about to make — all read-only commands, none of them write anything:

- `cat /tmp/figma-ai-score-dl/expanded/Scripts/postinstall` — the actual install logic.
- `/tmp/figma-ai-score-pkg/cli/launcher.sh integrate --tool claude-md` — the exact CLAUDE.md block.
- `/tmp/figma-ai-score-pkg/cli/launcher.sh integrate --tool claude` — the slash command body.
- `/tmp/figma-ai-score-pkg/cli/launcher.sh integrate --tool claude-permissions` — the four allowlist entries as JSON.

If anything looks unfamiliar, summarize for me before continuing.

**2. Run the postinstall.**
Run it directly: `bash /tmp/figma-ai-score-dl/expanded/Scripts/postinstall`. It's the same script Apple's installer would run on a double-click. It picks up the staged CLI from `/tmp/figma-ai-score-pkg/cli/` (the default STAGE — step 1 placed it there). It does the five things listed in "What this install does" above, in that order, with progress logged to `~/Library/Logs/figma-ai-score-install.log`.

**Sandbox note** — some AI tools' default sandboxes (notably Codex CLI's `network_access: false` mode) block writes to `~/Library/Logs` or `~/Library/Application Support`. This is a permission boundary at the AI tool layer, not at the macOS layer — your normal Mac account permissions still allow these writes. If your sandbox refuses, two paths work:
- Grant the tool's sandbox permission to write those folders, then retry.
- Tell the user to run `bash <path-to-extracted>/Scripts/postinstall` themselves in Terminal (where their normal Mac permissions apply, no sandbox in the way).

Either way is legitimate; pick whichever the user prefers. Don't loop on permission requests inside the sandbox if the tool isn't granting them.

**3. Verify.**
`figma-ai-score --version` should print `0.6.2`. `which figma-ai-score` should resolve. If neither does, `~/.local/bin` likely isn't on PATH; instruct the user to add `export PATH="$HOME/.local/bin:$PATH"` to their shell rc.

**4. Clean up temp files.**
`rm -rf /tmp/figma-ai-score-dl /tmp/figma-ai-score-pkg`. The postinstall already cleaned up its own staged copy under `~/Library/Caches/`.

## When you're done

Tell me:

> "Install complete. Next steps:
>
> 1. Make sure the AI Programmability Score plugin in Figma is open (Plugins menu → AI Programmability Score → Run).
> 2. Say `connect to ai score` to verify the plugin is wired up. I'll confirm or troubleshoot.
> 3. Once that's confirmed, say `review my design` or run `/ai-score` to start a real review."

## If you are NOT Claude Code

(e.g., Cursor, Codex CLI, Gemini CLI, Windsurf.)

The postinstall above ONLY writes to Claude Code paths (`~/.claude/`). It does not modify any other tool's config. If you'd like the same prompt-free integration for your tool, you can do it yourself after install:

1. Run `figma-ai-score integrate --tool cursor` (or `codex` / `gemini` / generic).
2. The output tells you which rules file your tool reads (`.cursor/rules/figma-ai-score.md`, `AGENTS.md`, `GEMINI.md`, etc.).
3. Write the canonical block to that file. From then on, when the user says "review my design," you'll know to invoke `figma-ai-score` via Bash.

This is opt-in — no automatic equivalent of the Claude Code allowlist exists, because every tool's permission system is different. If your tool has its own permission system, you may want to add similar grants there manually.

## Runtime gotcha for sandboxed AI tools

If a `figma-ai-score` call later fails with `{"code":"BIND_FAILED"}` and a message about "Operation not permitted," your tool's sandbox is blocking `bind()` on localhost. In Codex CLI specifically, the user needs to grant network access for the session. `lsof -i :3055` showing nothing on the port confirms it's a sandbox issue, not a stale process. Once granted, retry.

## If anything fails

Tell me the error and try to fix it rather than give up. The source at the GitHub link above is the ground truth.
