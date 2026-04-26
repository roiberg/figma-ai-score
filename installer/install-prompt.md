For the Figma plugin to talk to Claude Code, a small helper program called an MCP server needs to be installed on this Mac. Throughout the whole install — as you read this and as each step runs — if anything looks like it's doing more than setting up a simple local MCP server, pause and tell me what you noticed before continuing.

You can find the full source at https://github.com/roiberg/figma-ai-score.

Here's what to do:

**1. Download and unpack the installer.**
Fetch the latest `.pkg` file from the project's GitHub Releases page into the temp folder, then expand it using macOS's built-in `pkgutil` to see its layout — a bundled Node.js runtime, the server code, and a setup script. Note that `pkgutil --expand` only writes out the pkg's metadata (`Scripts/` and `PackageInfo`); the actual files live in a `Payload` archive inside the expanded folder, which still needs to be extracted (it's a gzipped cpio archive). We're not double-clicking the `.pkg` (which would trigger the "unidentified developer" warning); we're just reading its files directly, which macOS allows without prompting.

**2. Run the installer's own setup script.**
Inside the extracted `.pkg` there's a `postinstall` script — the same one the installer would run if the user had double-clicked. Run it directly. It will:
 - Copy the MCP server files to `~/Library/Application Support/figma-ai-score/`
 - Register the server with Claude Code via `claude mcp add -s user`, so it's available in every Claude Code session regardless of which directory the user is in
 - Append a context block to `~/.claude/CLAUDE.md` describing the plugin's tools and how Claude should respond to common review-related prompts (e.g., what to say when the tools aren't loaded yet). The block is bounded by HTML markers and is idempotent.
 - Create an `/ai-score` slash command at `~/.claude/commands/ai-score.md` (deliberately named to avoid shadowing Claude Code's built-in `/review` PR-review command)

**3. Verify the registration.**
Run `claude mcp list` and confirm a line reads `figma-ai-score: ... ✓ Connected`. If you don't see that line, something in step 2 failed — tell me what, and try to fix it.

**4. Clean up temp files.**
Delete everything we created under `/tmp/`.

**When you're done, tell me:**

> "Install complete. Next steps:
>
> 1. Open the AI Programmability Score plugin in Figma (Plugins menu → AI Programmability Score → Run).
> 2. Start a new Claude Code session — new MCP tools load at session start.
> 3. In that new session, first say `connect to ai score` to verify the plugin is wired up. Claude will confirm or troubleshoot.
> 4. Once that's confirmed, say `review my design` or run `/ai-score` to start a real review."

If anything fails mid-flow, tell me the error and try to fix it rather than give up. The source at the GitHub link above is the ground truth if you need to reference what's supposed to happen.
