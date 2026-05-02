// Sandbox side of the plugin. Has access to figma.* APIs.
// Cannot open sockets — that lives in ui.html. We speak to the UI via
// figma.ui.postMessage / figma.ui.onmessage.
//
// RPC shape (bridge -> UI -> here):
//   request:  { __rpc: true, id, method, params }
//   response: { __rpc: true, id, result? , error? }

console.log("[figma-ai-score] plugin loaded (build: image-fill-exempt, 2026-04-21)");
figma.showUI(__html__, { width: 653, height: 739, themeColors: true });

// ── Tab deduplication via clientStorage ─────────────────────────────────────
// figma.clientStorage is shared across all open Figma tabs for this plugin.
// Each tab claims an ownership slot on open and renews it every 2s. When
// another tab overwrites the slot, the previous owner yields and tells its UI
// to show the "Active in another tab" overlay.
const TAB_PRESENCE_KEY = "figma-ai-score.active-tab-id";
const myTabId = Math.random().toString(36).slice(2) + Date.now();
let _isTabOwner = true;

(async () => {
  try { await figma.clientStorage.setAsync(TAB_PRESENCE_KEY, myTabId); } catch (e) {}
})();

setInterval(async () => {
  try {
    const stored = await figma.clientStorage.getAsync(TAB_PRESENCE_KEY);
    const nowOwner = !stored || stored === myTabId;
    if (_isTabOwner && !nowOwner) {
      _isTabOwner = false;
      figma.ui.postMessage({ type: "tab-replaced" });
    } else if (!_isTabOwner && nowOwner) {
      _isTabOwner = true;
      figma.ui.postMessage({ type: "tab-reclaimed" });
    } else if (_isTabOwner) {
      await figma.clientStorage.setAsync(TAB_PRESENCE_KEY, myTabId);
    }
  } catch (e) {}
}, 2000);

const DEFAULT_RULES = {
  naming: true,
  components: true,
  autolayout: true,
  colors: true,
  typography: true,
  spacing: true,
  padding: true,
  size: true,
  effects: true
};
const PREFS_KEY = "figma-ai-score.prefs.v1";

let prefs = Object.assign({}, DEFAULT_RULES);
let locked = false;
let lockedIds = [];
// `cancelled` lives here in the plugin sandbox because CLI invocations are
// short-lived; only the plugin can carry the flag across the multi-call
// review flow. Cleared by announce_review_start / begin_and_scan; short-
// circuits subsequent RPCs with { cancelled: true } until cleared.
let cancelled = false;
const CANCEL_EXEMPT_METHODS = new Set([
  // Read-only methods that should still respond truthfully even after cancel.
  "get_selection", "get_preferences", "is_cancelled"
]);
const CANCEL_CLEARING_METHODS = new Set([
  // A new review cycle clears any stale cancel flag.
  "announce_review_start", "begin_and_scan"
]);

// ── Full review protocol. Returned by get_preferences so any Claude ──
// ── session can run a review with zero external configuration.        ──
// ── Rule descriptions are injected dynamically — only enabled rules   ──
// ── appear in the instructions, so the AI is never confused by rules  ──
// ── that are toggled off.                                             ──

const RULE_DESCRIPTIONS = {
  components: `### components (smart)
Pre-computed offenders cover Check 1 (orphan raw layers), Check 2 (over-instancing), Check 3 (repeated siblings) — pass through unchanged. ADD these from the thumbnail:

**Check 4 — Semantic-name structures.**
A raw FRAME/GROUP (NOT INSTANCE/COMPONENT) whose name (case-insensitive, partial match) contains any of: \`nav\`, \`navigation\`, \`header\`, \`footer\`, \`action bar\`, \`app bar\`, \`toolbar\`, \`tab bar\`, \`bottom sheet\`, \`sidebar\`, \`dialog\`, \`modal\`, \`card\`, \`list item\`, \`row\`, \`hero\`, \`banner\`. Skip Check 4 entirely if the root frame is itself a COMPONENT or COMPONENT_SET.

**Vision check — discrete UI regions.**
Enumerate every distinct visual region in the thumbnail (banners, search bars, filter rows, section containers, CTA blocks, list rows, cards, toolbars, etc.). For each, verify there's a corresponding INSTANCE node. If a region maps to a raw FRAME/GROUP, flag that node — INDEPENDENT of Check 1. An orphan parent does NOT absolve its visually-component-worthy children; do not skip children of flagged parents.

Be specific in the detail: reference what you see in the screenshot AND the node that should have been a component.`,

  colors: `### colors
Pre-computed. Copy each offender unchanged with one exception: token selection.

When an offender has \`_allTokenCandidates\`, that list contains every token that exactly matches the fill/stroke color. Use it (together with \`suggestedTokens\` which holds a pre-ranked shortlist) to pick the **single most semantically appropriate token** for this node. Use all available context to decide:
- **The thumbnail** (\`thumbnailPath\`) — look at the screenshot to understand the node's visual role (full-screen background → Surface, icon/text on a dark fill → on-primary, etc.)
- **The node name** — hints at intent
- **Standard token naming conventions** — "Surface" for screen backgrounds, "on-*" for content drawn on a colored surface, "primary"/"secondary" for key actions and their content

Replace \`suggestedTokens\` with an array containing only your chosen token, and drop \`_allTokenCandidates\` from the output.

If there is no \`_allTokenCandidates\` field, pass \`suggestedTokens\` through unchanged.`,

  typography: `### typography
Pre-computed. Pass through unchanged.`,

  spacing: `### spacing
Pre-computed (offenders + \`suggestedTokens\`). Pass through unchanged.`,

  padding: `### padding
Pre-computed. Each offender may carry \`suggestedTokens\` (un-tokenized padding) and/or \`zeroActions\` (fixed-axis padding with no visual effect). Pass both through unchanged.`,

  size: `### size
Pre-computed (offenders + \`suggestedTokens\`). Pass through unchanged.`,

  autolayout: `### auto layout
Pre-computed offenders cover the boolean "is this node auto-layout?" check. ADD from the thumbnail:
- **Pathological structure** — auto-layout that's technically present but useless (e.g. a single wrapper with 50 absolutely-positioned children).
- **Wrong direction** — HORIZONTAL where the layout reads VERTICAL (or vice versa); alignment that would break in code-gen; mismatched paddings between siblings that look broken.

Decorative compositions (illustrations, vector groups not laid out) can be reasonable as non-autolayout — use judgment.

Detail format:
- "<type> isn't using auto layout." — deterministic case.
- "<type> uses auto layout but [vision-derived problem]." — vision case.

**For every non-autolayout offender, compute an \`autolayoutSuggestion\`** using both the scan tree and the thumbnail:

Math (from scan tree children x/y/width/height):
- \`direction\`: HORIZONTAL if children vary more in x than y, VERTICAL otherwise.
- \`gap\`: median gap between consecutive children along the primary axis (round to nearest integer).
- \`paddingTop/Right/Bottom/Left\`: distance from frame edge to nearest child edge on each side.

Vision (from thumbnail) — **these fields are required in every suggestion**:
- \`primaryAxisSizingMode\`/\`counterAxisSizingMode\`: Determine each axis independently by looking at the thumbnail.
  - AUTO (hug): the frame wraps its content on that axis — its size is driven by children + padding.
  - FIXED: the frame has an explicit size on that axis that is independent of its content (e.g. a full-width banner, a fixed-height toolbar, a button that spans the container width).
  Never default blindly to AUTO — a frame that fills its parent's width should stay FIXED on the horizontal axis.
- \`primaryAxisAlignItems\`: MIN (start), CENTER, MAX (end), or SPACE_BETWEEN.
- \`counterAxisAlignItems\`: MIN, CENTER, or MAX.
- Per-child \`layoutGrow\`: 1 (fill container) if the child visually stretches to fill the frame on the primary axis; 0 otherwise.
- Per-child \`layoutAlign\`: STRETCH if the child fills the counter axis; INHERIT otherwise.

Output format (add to every non-autolayout offender):
\`\`\`
"autolayoutSuggestion": {
  "direction": "HORIZONTAL" | "VERTICAL",
  "gap": <number>,
  "paddingTop": <number>, "paddingRight": <number>, "paddingBottom": <number>, "paddingLeft": <number>,
  "primaryAxisSizingMode": "FIXED" | "AUTO",
  "counterAxisSizingMode": "FIXED" | "AUTO",
  "primaryAxisAlignItems": "MIN" | "CENTER" | "MAX" | "SPACE_BETWEEN",
  "counterAxisAlignItems": "MIN" | "CENTER" | "MAX",
  "children": [{ "nodeId": "...", "layoutGrow": 0|1, "layoutAlign": "INHERIT"|"STRETCH" }]
}
\`\`\`
Omit the \`children\` array if all children keep defaults (layoutGrow 0, layoutAlign INHERIT).`,

  effects: `### effects
Pre-computed. Pass through unchanged.`,

  naming: `### naming (smart)
Pre-computed offenders cover Check 1 (regex defaults + placeholders). ADD from the thumbnail (Check 2 — semantic accuracy):
- **Misleading**: name suggests one thing but the content is different (a "Button" that's plain text, an "Avatar" with a plain rectangle).
- **Meaningless on purposeful layers**: "Container 2", "Thing", "Stuff", "New", "Element" on layers with clear specific purpose.
- **Unambiguous typos**: "Hedaer" → "Header", "Naviagtion" → "Navigation". Only when the intended word is obvious.

Don't flag style choices (lowercase, hyphen, underscore) or valid-but-unusual names.

**suggestedName**: always add \`suggestedName\` to every naming offender — even when uncertain, make your best guess based on the thumbnail and the layer's content. Short, no trailing punctuation. There is no "omit when unsure" — a best guess is always more useful than nothing.`
};

function buildInstructions(enabledRules) {
  const enabledNames = Object.keys(enabledRules).filter(k => enabledRules[k]);
  const disabledNames = Object.keys(enabledRules).filter(k => !enabledRules[k]);

  const rulesSection = enabledNames.map(k => RULE_DESCRIPTIONS[k]).filter(Boolean).join("\n\n");

  let disabledNote = "";
  if (disabledNames.length > 0) {
    disabledNote = `\nThe following rules are DISABLED and must be completely ignored — do NOT check, score, or mention them: ${disabledNames.join(", ")}.\n`;
  }

  return `
You are reviewing Figma designs for AI Programmability — how well they're structured for AI tools to convert into clean code. Follow this protocol exactly.
${disabledNote}
## FLOW — execute in this exact order, no skipping

0. announce_review_start → use its \`selection.frames\` list (skip get_selection).
1. get_preferences → read \`instructions\` fully (you are reading them now). If \`designDoc.content\` is non-null, use it throughout.
2. For each frame at index i (1-based) of N total frames:
   a. **announce_progress --step analyzing** — MANDATORY before every scan.
   b. begin_and_scan --node-ids <id> --frame-index i --frame-count N
   c. Apply enabled rules to the scan result. Compute score.
3. **announce_progress --step submitting** — MANDATORY before submitting.
4. Write report JSON to a temp file, call submit_report --report-file <path>.

If any tool returns \`{ cancelled: true }\`, stop and say "Review cancelled."
If \`selection.capped\` is true, warn the user only the first 10 frames are reviewed.

## SCOPING (applies to ALL rules)
- **Ignored nodes**: \`"ignored": true\` excludes the node and its entire subtree. Don't walk in, don't count.
- **INSTANCE children**: evaluate the INSTANCE node itself (name, own fills/strokes/styles) but NOT its descendants — internals are library-defined.
- **Root frame**: exempt from the components rule (it's the canvas, not a component candidate). All other rules evaluate it.
- **Off-screen layers**: still scored; mention in detail so the designer knows.
- **Scrollable / overflow content**: NOT issues (intentional scroll prototyping).
- **Repeated component instances**: GOOD — same instance across variants is correct reuse, never flag.
- **COMPONENT_SET nodes are skipped entirely by**: colors, spacing, padding, autolayout, effects.

## PRE-COMPUTED LINT RESULTS
The scan response includes \`lintResults\` — deterministic offenders + token suggestions, computed server-side.

**Accept as final (no re-analysis):** colors, typography, spacing, padding, size, effects, naming (Check 1 regex), components (Checks 1-3), autolayout (presence check). Copy these offenders into the report unchanged — including any \`suggestedTokens\`, \`zeroActions\`, or \`suggestedName\` fields. They're already correct. Do NOT re-walk the tree for these — wastes time, identical results.

**Augment with vision** (use the thumbnail):
- naming: ADD semantic-accuracy + typo offenders (Check 2).
- components: ADD Check 4 (semantic-name structures) + Vision check (discrete UI regions).
- autolayout: ADD quality offenders (pathological structure, wrong direction).

**Scoring per rule**:
- Accept-as-final: use \`lintResults.<rule>._totalChecked\` and offender count directly.
- Augmented: \`score = (totalChecked - newOffenderCount) / totalChecked * 100\`.

## NODESTATS RULE-SKIPPING (faster than reading lintResults)
Check \`nodeStats\` first:
- \`nodeStats.text === 0\` → typography passes (\`_totalChecked: 0\`).
- \`nodeStats.autolayout === 0\` → spacing + padding pass.
- \`nodeStats.withEffects === 0\` → effects passes.

## ENABLED RULES
${rulesSection}

## SCORING
Proportional across the ${enabledNames.length} enabled rule${enabledNames.length === 1 ? "" : "s"}: ${enabledNames.join(", ")}.
- \`rule_score = (totalChecked - offenderCount) / totalChecked * 100\`
- \`final_score = round(average of enabled rule scores)\`
- \`perfect = true\` only if ALL enabled rules have zero offenders.
- A rule with zero nodes to check scores 100.

Strict consistency: rule scores 100 ⇔ zero offenders. < 100 requires offenders listed. "Feels like a small deduction" is invalid.

## REPORT FORMAT
submit_report expects:
\`\`\`
{
  frames: [{
    nodeId, name, score, perfect,
    breakdown: {
      <ruleName>: { enabled, passed, offenders: [{ nodeId, name, detail, ... }] (max 30) }
    },
    issues: [{ rule, nodeId, name, detail }] (max 20)
  }],
  generatedAt: <ISO timestamp>
}
\`\`\`
Only include the ${enabledNames.length} enabled rule${enabledNames.length === 1 ? "" : "s"} (${enabledNames.join(", ")}) in \`breakdown\`. Omit disabled rules entirely.

## ISSUE QUALITY
- Every issue must trace to specific scan-tree data. Never invent.
- Skip what you can't see (instance internals). Don't tell the designer to "verify" or "inspect" — that's not an issue.
- No hedging — "no action needed", "minimal impact" → delete the issue.
- Be specific: name exact layers and node IDs.
- **Detail strings**: short and plain (under ~10 words). State the issue, not the mechanism. No hex values, no property names (\`fillStyleId\`), no jargon ("bound variable"), no fix advice.
  Good: "Fill does not use a token or style." / "Spacing not tokenized." / "Auto-layout missing on this frame."
  Bad: "SOLID fill #FF0000 has no bound variable or style." / "boundVariable is null on the first paint."
- **Forbidden phrases** in details: "no action required/needed", "minimal impact", "low impact", "be aware that", "verify that", "confirm that", "extends beyond", "overflow", "layout mismatch", "outside container bounds".
- After submitting, briefly summarize to the user: score, rules passed/failed, top issues.

## GROUPING REPEATED OFFENDERS
When 3+ nodes share identical (rule + detail), collapse to one entry:
\`{ nodeId: "<first>", name: "<first>", detail: "<shared>", groupedCount: <total> }\`

## SCAN DATA FORMAT (sparse — absent means absent)
- No \`fills\`/\`strokes\`/\`effects\` key → empty.
- No \`sizeBound\` → neither width nor height is bound.
- \`autolayout.bound\` only lists props that ARE bound.
- \`hasMultipleFills\`, \`hasMultipleStrokes\`, \`hasVerticalFillChild\`, \`hasHorizontalFillChild\` only appear when \`true\`.

## COLOR SUGGESTIONS CAP
If a frame has more than 10 color offenders, drop \`suggestedTokens\` from all of them — wireframes with many unbound fills aren't actionable for token suggestions.
`;
}

async function loadPrefs() {
  try {
    const stored = await figma.clientStorage.getAsync(PREFS_KEY);
    if (stored && typeof stored === "object") {
      prefs = Object.assign({}, DEFAULT_RULES, stored);
    }
  } catch (e) { /* ignore */ }
}
async function savePrefs(p) {
  prefs = Object.assign({}, DEFAULT_RULES, p || {});
  try { await figma.clientStorage.setAsync(PREFS_KEY, prefs); } catch (e) {}
}

// ------- live selection mirror -------

const MAX_SELECTION_SIMPLE = 10;
const MAX_SELECTION_AI = 1;
let reviewMode = "simple";
function currentMaxSelection() {
  return reviewMode === "ai" ? MAX_SELECTION_AI : MAX_SELECTION_SIMPLE;
}

function selectionSummary() {
  const sel = figma.currentPage.selection;
  const max = currentMaxSelection();
  const capped = sel.slice(0, max);
  return {
    frames: capped.map(n => ({ id: n.id, name: n.name, type: n.type })),
    total: sel.length,
    capped: sel.length > max
  };
}
// Returns { ignored, inherited, sourceName }.
// inherited=true means the flag lives on a master component, not the node itself.
function ignoredStateLive(node) {
  if (!node) return { ignored: false, inherited: false, sourceName: null };
  try {
    if (typeof node.getPluginData === "function" && node.getPluginData(IGNORE_PDATA_KEY) === "1") {
      return { ignored: true, inherited: false, sourceName: null };
    }
  } catch (e) {}
  try {
    if (node.type === "INSTANCE" && node.mainComponent) {
      const main = node.mainComponent;
      if (typeof main.getPluginData === "function" && main.getPluginData(IGNORE_PDATA_KEY) === "1") {
        return { ignored: true, inherited: true, sourceName: main.name || "master component" };
      }
      if (main.parent && main.parent.type === "COMPONENT_SET" && typeof main.parent.getPluginData === "function" && main.parent.getPluginData(IGNORE_PDATA_KEY) === "1") {
        return { ignored: true, inherited: true, sourceName: main.parent.name || "component set" };
      }
    }
  } catch (e) {}
  return { ignored: false, inherited: false, sourceName: null };
}
function isNodeIgnoredLive(node) { return ignoredStateLive(node).ignored; }

function collectIgnoredInside(rootNode) {
  const found = [];
  function recurse(node) {
    if (!node) return;
    const state = ignoredStateLive(node);
    if (state.ignored) {
      found.push({ id: node.id, name: node.name, type: node.type, inherited: state.inherited, sourceName: state.sourceName });
      return; // Don't descend into ignored subtrees
    }
    if (node.type === "INSTANCE") return;
    if (node.children) for (const c of node.children) recurse(c);
  }
  if (rootNode.children) for (const c of rootNode.children) recurse(c);
  return found;
}

function decorateFrameWithIgnored(frame, node) {
  const state = ignoredStateLive(node);
  const inside = state.ignored ? [] : collectIgnoredInside(node);
  return Object.assign({}, frame, {
    ignored: state.ignored,
    ignoredInherited: state.inherited,
    ignoredSourceName: state.sourceName,
    ignoredInside: inside
  });
}

async function pushSelection() {
  const sel = figma.currentPage.selection;
  const max = currentMaxSelection();
  const capped = sel.slice(0, max);
  const frames = capped.map(n => decorateFrameWithIgnored(
    { id: n.id, name: n.name, type: n.type },
    n
  ));

  // With exactly 1 frame selected, export a thumbnail for the selection preview.
  // Shown in both Simple and AI modes.
  let thumbnail = null;
  if (capped.length === 1) {
    const node = capped[0];
    try {
      if (typeof node.exportAsync === "function") {
        const bytes = await node.exportAsync({ format: "JPG", constraint: { type: "SCALE", value: 1 } });
        thumbnail = bytesToBase64(bytes);
      }
    } catch (e) {
      // Thumbnail is best-effort — don't block selection update.
    }
  }

  // 1. Send selection immediately so the UI snaps without waiting for node counting.
  figma.ui.postMessage({
    type: "selection",
    data: frames,
    total: sel.length,
    capped: sel.length > max,
    maxSelection: max,
    fileName: figma.root.name,
    pageName: figma.currentPage.name,
    thumbnail,
  });

  // 2. Yield to let Figma process other work, then count nodes and send ETA
  //    separately. shallowCountNodes does many cross-thread .children accesses
  //    so keeping it off the hot path prevents UI jank on large selections.
  if (capped.length > 0) {
    await new Promise(r => setTimeout(r, 0));
    let totalNodes = 0;
    for (const n of capped) totalNodes += shallowCountNodes(n);
    // If we hit the cap the formula would be meaningless — use the fixed label.
    const eta = totalNodes >= SHALLOW_COUNT_CAP
      ? "More than 5 minutes"
      : estimateEta(totalNodes);
    if (eta) figma.ui.postMessage({ type: "selection-eta", eta });
  }
}
figma.on("selectionchange", pushSelection);
figma.on("currentpagechange", pushSelection);

// ------- UI messages (control + RPC) -------

figma.ui.onmessage = async (msg) => {
  if (!msg) return;

  if (!msg.__rpc) {
    if (msg.type === "reclaim-tab") {
      try { await figma.clientStorage.setAsync(TAB_PRESENCE_KEY, myTabId); } catch (e) {}
      _isTabOwner = true;
      figma.ui.postMessage({ type: "tab-reclaimed" });
      return;
    }
    if (msg.type === "set-cancelled") {
      // The UI's Stop button (and any future cancel UX) sets this flag.
      // Subsequent CLI RPCs short-circuit with { cancelled: true } until
      // the next announce_review_start / begin_and_scan clears it.
      cancelled = !!msg.value;
      return;
    }
    if (msg.type === "ui-ready") {
      await loadPrefs();
      try {
        const m = await figma.clientStorage.getAsync("figma-ai-score.mode");
        if (m === "ai" || m === "simple") reviewMode = m;
        figma.ui.postMessage({ type: "saved-mode", mode: reviewMode });
      } catch (e) {}
      // Seed the UI with the persisted "Don't show the connect-success
      // card" flag — set per-user via figma.clientStorage so it travels
      // across files and sessions on this Figma account.
      try {
        const suppressed = await figma.clientStorage.getAsync("figma-ai-score.suppress-connect-success");
        figma.ui.postMessage({ type: "connect-success-suppressed", value: !!suppressed });
      } catch (e) {}
      // Seed the "has ever installed" flag — flips to true the first time
      // we see a successful WS handshake on this Figma account, and stays
      // true forever. The UI uses this to decide whether to show the
      // install banner: if the user has ever installed, we trust the install
      // and always show the full UI in AI mode (current connection state is
      // ignored — the AI surfaces real CLI errors directly).
      try {
        const hasEver = await figma.clientStorage.getAsync("figma-ai-score.has-ever-installed");
        figma.ui.postMessage({ type: "has-ever-installed", value: !!hasEver });
      } catch (e) {}
      try {
        const libsSeen = await figma.clientStorage.getAsync("figma-ai-score.libraries-seen");
        figma.ui.postMessage({ type: "libraries-seen-result", value: !!libsSeen });
      } catch (e) {}
      try {
        const rulesCollapsed = await figma.clientStorage.getAsync("figma-ai-score.rules-collapsed");
        figma.ui.postMessage({ type: "rules-collapsed-result", value: !!rulesCollapsed });
      } catch (e) {}
      figma.ui.postMessage({ type: "prefs", data: prefs });
      pushSelection();
      return;
    }
    if (msg.type === "set-connect-success-suppressed") {
      try {
        await figma.clientStorage.setAsync("figma-ai-score.suppress-connect-success", !!msg.value);
      } catch (e) {
        console.warn("[figma-ai-score] couldn't persist connect-success suppression:", e && e.message);
      }
      return;
    }
    if (msg.type === "set-rules-collapsed") {
      try {
        await figma.clientStorage.setAsync("figma-ai-score.rules-collapsed", !!msg.value);
      } catch (e) {}
      return;
    }
    if (msg.type === "set-libraries-seen") {
      try {
        await figma.clientStorage.setAsync("figma-ai-score.libraries-seen", true);
      } catch (e) {}
      return;
    }
    if (msg.type === "set-has-ever-installed") {
      try {
        await figma.clientStorage.setAsync("figma-ai-score.has-ever-installed", !!msg.value);
      } catch (e) {
        console.warn("[figma-ai-score] couldn't persist has-ever-installed:", e && e.message);
      }
      return;
    }
    if (msg.type === "set-prefs") {
      await savePrefs(msg.data);
      figma.ui.postMessage({ type: "prefs", data: prefs });
      return;
    }
    if (msg.type === "get-libraries") {
      // Enumerate libraries enabled in this file (via Assets > Libraries)
      // and report which ones the user has picked as their tokens source.
      try {
        const libs = await listAvailableLibraries();
        const selected = await getSelectedTokenLibraries();
        figma.ui.postMessage({ type: "libraries-result", libraries: libs, selected });
      } catch (e) {
        console.warn("[figma-ai-score] get-libraries failed:", e && e.message);
        figma.ui.postMessage({ type: "libraries-result", libraries: [], selected: [] });
      }
      return;
    }
    if (msg.type === "set-token-libraries") {
      try {
        const libraries = Array.isArray(msg.libraries) ? msg.libraries.filter(s => typeof s === "string") : [];
        await figma.clientStorage.setAsync("figma-ai-score.token-libraries", libraries);
      } catch (e) {
        console.warn("[figma-ai-score] couldn't persist token libraries:", e && e.message);
      }
      return;
    }
    if (msg.type === "get-design-doc") {
      try {
        const doc = await figma.clientStorage.getAsync("figma-ai-score.design-doc") || null;
        figma.ui.postMessage({ type: "design-doc-result", doc });
      } catch (e) {
        figma.ui.postMessage({ type: "design-doc-result", doc: null });
      }
      return;
    }
    if (msg.type === "set-design-doc") {
      try {
        if (msg.doc && msg.doc.content) {
          await figma.clientStorage.setAsync("figma-ai-score.design-doc", { filename: msg.doc.filename || "design.md", content: msg.doc.content });
        } else {
          await figma.clientStorage.deleteAsync("figma-ai-score.design-doc");
        }
      } catch (e) {
        console.warn("[figma-ai-score] couldn't persist design doc:", e && e.message);
      }
      return;
    }
    if (msg.type === "set-mode") {
      reviewMode = msg.mode === "ai" ? "ai" : "simple";
      try { await figma.clientStorage.setAsync("figma-ai-score.mode", reviewMode); } catch (e) {}
      pushSelection(); // Re-cap selection with new limit
      return;
    }
    if (msg.type === "suggestion-check") {
      const lastAt = (await figma.clientStorage.getAsync("last-suggestion-at")) || 0;
      figma.ui.postMessage({ type: "suggestion-check-result", lastAt });
      return;
    }
    if (msg.type === "suggestion-sent") {
      await figma.clientStorage.setAsync("last-suggestion-at", Date.now());
      return;
    }
    if (msg.type === "set-ignored") {
      try {
        const node = await figma.getNodeByIdAsync(msg.nodeId);
        if (!node || typeof node.setPluginData !== "function") return;
        node.setPluginData(IGNORE_PDATA_KEY, msg.ignored ? "1" : "");
        pushSelection();
      } catch (e) {}
      return;
    }
    if (msg.type === "run-lint") {
      const summary = selectionSummary();
      if (summary.frames.length === 0) {
        figma.ui.postMessage({
          type: "report",
          data: { frames: [], generatedAt: new Date().toISOString(), empty: true }
        });
        return;
      }
      // In Simple mode we run the naive versions of every enabled rule, including naming.
      const lintRules = Object.assign({}, prefs);
      // Fetch the DS catalog once per review — it's the same for every frame.
      // Used by lintColors to suggest a token when a color offender has an
      // unambiguous exact match.
      let ds = null;
      try { ds = await getDesignSystem(); } catch (e) {
        console.warn("[figma-ai-score] getDesignSystem (run-lint) failed:", e && e.message);
      }
      const frameReports = [];
      for (const f of summary.frames) {
        const node = figma.getNodeById(f.id);
        if (!node) continue;
        const tree = extractNode(node);
        const result = lintFrame(tree, lintRules, ds);
        frameReports.push({
          nodeId: f.id,
          name: f.name,
          score: result.score,
          perfect: result.perfect,
          breakdown: result.breakdown,
          issues: result.issues
        });
      }
      figma.ui.postMessage({
        type: "report",
        data: {
          frames: frameReports,
          generatedAt: new Date().toISOString(),
          mode: "simple"
        }
      });
      return;
    }
    if (msg.type === "rename-node") {
      try {
        let node = null;
        if (typeof figma.getNodeByIdAsync === "function") {
          node = await figma.getNodeByIdAsync(msg.nodeId);
        }
        if (!node) node = figma.getNodeById(msg.nodeId);
        if (!node || typeof msg.newName !== "string" || !msg.newName.trim()) return;
        node.name = msg.newName;
        figma.ui.postMessage({ type: "rename-done", nodeId: msg.nodeId, newName: msg.newName });
      } catch (e) {
        figma.ui.postMessage({ type: "rename-failed", nodeId: msg.nodeId, error: String(e && e.message || e) });
      }
      return;
    }
    if (msg.type === "apply-token") {
      // Bind a token to a node. The slot determines whether we're binding
      // a color paint or a node property:
      //   - "fill" / "stroke" → bind variable/style to the first paint of
      //     that array (single-paint nodes only — guaranteed by suggestion
      //     logic).
      //   - "paddingTop" / "paddingRight" / "paddingBottom" / "paddingLeft"
      //     / "itemSpacing" / "width" / "height" → bind variable to the
      //     node property directly via setBoundVariable.
      try {
        const { nodeId, slot, kind, tokenId } = msg;
        let node = null;
        if (typeof figma.getNodeByIdAsync === "function") {
          try { node = await figma.getNodeByIdAsync(nodeId); } catch (e) {}
        }
        if (!node) node = figma.getNodeById(nodeId);
        if (!node) throw new Error("node not found");

        const PAINT_SLOTS = new Set(["fill", "stroke"]);
        const NODE_PROP_SLOTS = new Set([
          "paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
          "itemSpacing", "width", "height"
        ]);

        if (PAINT_SLOTS.has(slot)) {
          // Color path (existing behaviour).
          if (kind === "style") {
            if (slot === "fill") node.fillStyleId = tokenId;
            else node.strokeStyleId = tokenId;
          } else if (kind === "variable") {
            const variable = typeof figma.variables.getVariableByIdAsync === "function"
              ? await figma.variables.getVariableByIdAsync(tokenId)
              : figma.variables.getVariableById(tokenId);
            if (!variable) throw new Error("variable not found");
            const prop = slot === "fill" ? "fills" : "strokes";
            const paints = [...(node[prop] || [])];
            if (paints.length === 0) throw new Error("no paints on this node to bind");
            paints[0] = figma.variables.setBoundVariableForPaint(paints[0], "color", variable);
            node[prop] = paints;
          } else {
            throw new Error("unknown kind: " + kind);
          }
        } else if (NODE_PROP_SLOTS.has(slot)) {
          // Dimensional path. Only variables apply (no styles for numbers).
          if (kind !== "variable") throw new Error("dimensional tokens must be variables, got: " + kind);
          const variable = typeof figma.variables.getVariableByIdAsync === "function"
            ? await figma.variables.getVariableByIdAsync(tokenId)
            : figma.variables.getVariableById(tokenId);
          if (!variable) throw new Error("variable not found");
          // setBoundVariable is the modern API; if the property isn't
          // writable in the current sizing mode (e.g. width on a HUG axis),
          // Figma throws — surface that as a clear error.
          node.setBoundVariable(slot, variable);
        } else {
          throw new Error("unknown slot: " + slot);
        }
        figma.ui.postMessage({ type: "apply-token-done", nodeId, slot });
      } catch (e) {
        figma.ui.postMessage({
          type: "apply-token-failed",
          nodeId: msg.nodeId,
          slot: msg.slot,
          error: (e && e.message) ? e.message : String(e)
        });
      }
      return;
    }
    if (msg.type === "apply-autolayout") {
      try {
        const { nodeId, suggestion: s } = msg;
        let node = null;
        if (typeof figma.getNodeByIdAsync === "function") {
          try { node = await figma.getNodeByIdAsync(nodeId); } catch (e) {}
        }
        if (!node) node = figma.getNodeById(nodeId);
        if (!node) throw new Error("node not found");
        const AL_TYPES = new Set(["FRAME", "COMPONENT", "INSTANCE"]);
        if (!AL_TYPES.has(node.type)) throw new Error("node type cannot have auto layout: " + node.type);

        // Apply direction first — Figma requires this before padding/gap props.
        node.layoutMode = s.direction === "VERTICAL" ? "VERTICAL" : "HORIZONTAL";

        if (typeof s.gap          === "number") node.itemSpacing          = Math.max(0, Math.round(s.gap));
        const hasPadding =
          typeof s.paddingTop    === "number" ||
          typeof s.paddingRight  === "number" ||
          typeof s.paddingBottom === "number" ||
          typeof s.paddingLeft   === "number";
        if (typeof s.paddingTop    === "number") node.paddingTop    = Math.max(0, Math.round(s.paddingTop));
        if (typeof s.paddingRight  === "number") node.paddingRight  = Math.max(0, Math.round(s.paddingRight));
        if (typeof s.paddingBottom === "number") node.paddingBottom = Math.max(0, Math.round(s.paddingBottom));
        if (typeof s.paddingLeft   === "number") node.paddingLeft   = Math.max(0, Math.round(s.paddingLeft));

        const VALID_PRIMARY = new Set(["MIN", "CENTER", "MAX", "SPACE_BETWEEN"]);
        const VALID_COUNTER = new Set(["MIN", "CENTER", "MAX"]);
        const VALID_SIZING  = new Set(["FIXED", "AUTO"]);
        if (s.primaryAxisAlignItems && VALID_PRIMARY.has(s.primaryAxisAlignItems)) node.primaryAxisAlignItems = s.primaryAxisAlignItems;
        if (s.counterAxisAlignItems && VALID_COUNTER.has(s.counterAxisAlignItems)) node.counterAxisAlignItems = s.counterAxisAlignItems;
        // Trust the AI's vision-derived sizing mode. If omitted, default to AUTO
        // (hug) rather than leaving whatever the frame had before.
        node.primaryAxisSizingMode = (s.primaryAxisSizingMode && VALID_SIZING.has(s.primaryAxisSizingMode))
          ? s.primaryAxisSizingMode : "AUTO";
        node.counterAxisSizingMode = (s.counterAxisSizingMode && VALID_SIZING.has(s.counterAxisSizingMode))
          ? s.counterAxisSizingMode : "AUTO";

        // Per-child overrides
        if (Array.isArray(s.children)) {
          for (const spec of s.children) {
            let child = null;
            if (typeof figma.getNodeByIdAsync === "function") {
              try { child = await figma.getNodeByIdAsync(spec.nodeId); } catch (e) {}
            }
            if (!child) child = figma.getNodeById(spec.nodeId);
            if (!child) continue;
            if (typeof spec.layoutGrow === "number") child.layoutGrow = spec.layoutGrow === 1 ? 1 : 0;
            const VALID_ALIGN = new Set(["INHERIT", "STRETCH", "CENTER", "MIN", "MAX"]);
            if (spec.layoutAlign && VALID_ALIGN.has(spec.layoutAlign)) child.layoutAlign = spec.layoutAlign;
          }
        }

        figma.ui.postMessage({ type: "apply-autolayout-done", nodeId });
      } catch (e) {
        figma.ui.postMessage({
          type: "apply-autolayout-failed",
          nodeId: msg.nodeId,
          error: (e && e.message) ? e.message : String(e)
        });
      }
      return;
    }
    if (msg.type === "zero-padding") {
      // Zero out one or more padding props (used to clean up padding on
      // fixed-size axes where padding has no visual effect in code output).
      try {
        const { nodeId, props } = msg;
        if (!Array.isArray(props) || !props.length) return;
        let node = null;
        if (typeof figma.getNodeByIdAsync === "function") {
          try { node = await figma.getNodeByIdAsync(nodeId); } catch (e) {}
        }
        if (!node) node = figma.getNodeById(nodeId);
        if (!node) throw new Error("node not found");
        const ALLOWED = new Set(["paddingTop", "paddingRight", "paddingBottom", "paddingLeft"]);
        for (const prop of props) {
          if (ALLOWED.has(prop)) node[prop] = 0;
        }
        figma.ui.postMessage({ type: "zero-padding-done", nodeId, props });
      } catch (e) {
        figma.ui.postMessage({
          type: "zero-padding-failed",
          nodeId: msg.nodeId,
          error: (e && e.message) ? e.message : String(e)
        });
      }
      return;
    }
    if (msg.type === "select-node") {
      try {
        const node = await figma.getNodeByIdAsync(msg.nodeId);
        if (!node) return;
        if ("setCurrentPageAsync" in figma && node.parent) {
          // Find the page that owns the node
          let p = node.parent;
          while (p && p.type !== "PAGE") p = p.parent;
          if (p && p !== figma.currentPage) {
            await figma.setCurrentPageAsync(p);
          }
        }
        figma.currentPage.selection = [node];
        figma.viewport.scrollAndZoomIntoView([node]);
      } catch (e) {
        // ignore — node may have been deleted or is in a locked state
      }
      return;
    }
    if (msg.type === "create-component") {
      try {
        const offenderNode = figma.getNodeById(msg.nodeId);
        const frameNode    = figma.getNodeById(msg.frameNodeId);
        if (!offenderNode || !frameNode) {
          figma.ui.postMessage({ type: "create-component-result", ok: false, nodeId: msg.nodeId, error: "Node not found" });
          return;
        }
        const variants     = findVariantCandidates(offenderNode);
        const isVariantSet = variants.length > 1;
        const baseName     = offenderNode.name.split("/")[0].trim();
        // Measure the total canvas width the new item will occupy
        const INNER_GAP    = 24;
        const neededWidth  = isVariantSet
          ? variants.reduce((s, n) => s + n.width, 0) + INNER_GAP * (variants.length - 1) + 80
          : offenderNode.width;
        // Make room next to the reviewed frame and get the placement position
        const pos = makeRoomNextToFrame(frameNode, neededWidth);
        // Helper: replace a node in-place with an instance of a component.
        function replaceWithInstance(sourceNode, comp) {
          try {
            const parent = sourceNode.parent;
            if (!parent) return;
            const idx = Array.from(parent.children).indexOf(sourceNode);
            const instance = comp.createInstance();
            instance.x = sourceNode.x;
            instance.y = sourceNode.y;
            // Insert instance at the same slot, then remove the original.
            if (idx >= 0) parent.insertChild(idx, instance);
            else parent.appendChild(instance);
            sourceNode.remove();
          } catch (e) {
            // Non-critical — component was still created successfully.
          }
        }

        let ds = null;
        try { ds = await getDesignSystem(); } catch (e) {}

        if (isVariantSet) {
          // Create one component per variant, place them temporarily
          const components = [];
          let cx = pos.x;
          for (const v of variants) {
            const comp = nodeToComponent(v);
            comp.name  = variantNameForNode(v, baseName);
            comp.x     = cx;
            comp.y     = pos.y;
            figma.currentPage.appendChild(comp);
            await copyBoundVariables(v, comp);
            await autoApplyDimensionalTokens(comp, ds);
            components.push(comp);
            cx += v.width + INNER_GAP;
          }
          // Combine into a component set; Figma handles internal layout
          const set  = figma.combineAsVariants(components, figma.currentPage);
          set.name   = baseName;
          set.x      = pos.x;
          set.y      = pos.y;
          // Replace the offender with an instance of its corresponding variant
          const offenderIdx = variants.findIndex(v => v.id === offenderNode.id);
          const masterComp  = components[offenderIdx >= 0 ? offenderIdx : 0];
          replaceWithInstance(offenderNode, masterComp);
          figma.viewport.scrollAndZoomIntoView([set]);
          figma.ui.postMessage({ type: "create-component-result", ok: true, nodeId: msg.nodeId, variantCount: variants.length });
        } else {
          const comp = nodeToComponent(offenderNode);
          comp.x     = pos.x;
          comp.y     = pos.y;
          figma.currentPage.appendChild(comp);
          await copyBoundVariables(offenderNode, comp);
          await autoApplyDimensionalTokens(comp, ds);
          // Replace the original frame with an instance of the new component
          replaceWithInstance(offenderNode, comp);
          figma.viewport.scrollAndZoomIntoView([comp]);
          figma.ui.postMessage({ type: "create-component-result", ok: true, nodeId: msg.nodeId, variantCount: 0 });
        }
      } catch (e) {
        figma.ui.postMessage({ type: "create-component-result", ok: false, nodeId: msg.nodeId, error: String(e && e.message || e) });
      }
      return;
    }
    if (msg.type === "export-image") {
      try {
        const bytes = await buildExportPng(msg.report);
        figma.ui.postMessage({ type: "export-image-result", bytes: Array.from(bytes) });
      } catch (e) {
        console.error("[figma-ai-score] export failed:", e);
        figma.ui.postMessage({
          type: "export-image-result",
          error: (e && e.message) ? e.message : String(e)
        });
      }
      return;
    }
    return;
  }

  const { id, method, params } = msg;
  try {
    if (CANCEL_CLEARING_METHODS.has(method)) cancelled = false;
    let result;
    if (cancelled && !CANCEL_EXEMPT_METHODS.has(method)) {
      // Short-circuit — every RPC after a cancel returns
      // { cancelled: true } so the host AI's instructions
      // ("If any tool returns { cancelled: true }, stop immediately")
      // keep working without needing a separate poll.
      result = { cancelled: true, reason: "user stopped review" };
    } else {
      result = await handleRpc(method, params || {});
    }
    figma.ui.postMessage({ __rpc: true, id, result });
  } catch (err) {
    figma.ui.postMessage({
      __rpc: true, id,
      error: { message: (err && err.message) ? err.message : String(err) }
    });
  }
};

async function handleRpc(method, params) {
  switch (method) {
    case "get_selection": {
      var summary = selectionSummary();
      return {
        frames: summary.frames,
        total: summary.total,
        capped: summary.capped,
        maxSelection: currentMaxSelection(),
        fileName: figma.root.name,
        pageName: figma.currentPage.name
      };
    }
    case "get_preferences": {
      figma.ui.postMessage({ type: "ai-progress", message: "Reading preferences…" });
      let designDoc = null;
      try {
        designDoc = await figma.clientStorage.getAsync("figma-ai-score.design-doc") || null;
      } catch (e) {}
      return {
        enabledRules: prefs,
        scoringMethod: "proportional",
        instructions: buildInstructions(prefs),
        designDoc: designDoc ? { filename: designDoc.filename, content: designDoc.content } : null
      };
    }
    case "is_cancelled": {
      return { cancelled };
    }
    case "announce_progress": {
      // Mid-review progress update from the AI. The AI picks from a fixed set
      // of step keys; the plugin owns the display text so the AI can't inject
      // arbitrary copy (including frame names).
      const STEP_LABELS = {
        "starting":             "Starting…",
        "reading-preferences":  "Reading preferences…",
        "analyzing":            "Analyzing…",
        "submitting":           "Submitting report…",
      };
      const label = STEP_LABELS[params.step] || STEP_LABELS[params.message] || "";
      if (label) figma.ui.postMessage({ type: "ai-progress", message: label });
      return { ok: true };
    }
    case "announce_review_start": {
      // Early signal — Claude is about to work on a review but hasn't
      // processed the big instructions string yet. Show a generic
      // "Preparing review…" state so the UI doesn't feel frozen.
      // Also switch to Smart tab so the user sees the review in the right place
      // regardless of which tab was active when Claude started.
      // Read the current selection here so the UI can show frame names immediately
      // (without waiting for a separate get_selection call).
      reviewMode = "ai";
      try { await figma.clientStorage.setAsync("figma-ai-score.mode", "ai"); } catch (e) {}
      const selSummary = selectionSummary();
      // Only show the reviewing overlay when there are frames to work on.
      // If the selection is empty the AI will bail out immediately and there
      // is nothing to dismiss — skipping the postMessage means the overlay
      // never appears, even if the installed CLI doesn't have dismiss-review.
      if (selSummary.frames.length > 0) {
        figma.ui.postMessage({
          type: "review-starting",
          switchMode: "ai",
          names: selSummary.frames.map(f => f.name)
        });
      }
      return {
        ok: true,
        selection: {
          frames: selSummary.frames,
          total: selSummary.total,
          capped: selSummary.capped,
          maxSelection: currentMaxSelection(),
          fileName: figma.root.name,
          pageName: figma.currentPage.name
        }
      };
    }
    case "begin_and_scan": {
      // Lock phase
      const ids = Array.isArray(params.nodeIds) ? params.nodeIds : [];
      cancelled = false;
      locked = true;
      lockedIds = ids;
      const names = ids.map(id => {
        const n = figma.getNodeById(id);
        return n ? n.name : "(missing)";
      });
      figma.ui.postMessage({ type: "locked", data: { nodeIds: ids, names } });
      // Auto-fire banner messages — works regardless of whether the AI
      // calls announce_progress. ai-progress sets the progress line text;
      // scan-progress sets the bold title (frame name + index) and arms
      // the fun-sentence ticker in the UI.
      figma.ui.postMessage({ type: "ai-progress", message: "Analyzing." });
      figma.ui.postMessage({
        type: "scan-progress",
        frameName: names[0] || null,
        frameIndex: typeof params.frameIndex === "number" ? params.frameIndex : null,
        frameCount: typeof params.frameCount === "number" ? params.frameCount : null,
      });

      // Scan phase: extract tree, export thumbnail, lint.
      const scanNodeId = ids[0];
      if (!scanNodeId) return { locked: true, ok: true, count: ids.length };
      let node = null;
      try {
        if (typeof figma.getNodeByIdAsync === "function") node = await figma.getNodeByIdAsync(scanNodeId);
      } catch (e) {}
      if (!node) node = figma.getNodeById(scanNodeId);
      if (!node) return { locked: true, error: "node not found: " + scanNodeId };
      const tree = extractNode(node);
      let thumbnail = null;
      let thumbError = null;
      try {
        if (typeof node.exportAsync === "function") {
          const bytes = await node.exportAsync({ format: "JPG", constraint: { type: "WIDTH", value: 384 } });
          thumbnail = bytesToBase64(bytes);
        }
      } catch (e) { thumbError = String(e && e.message || e); }
      let designSystem = null;
      try { designSystem = await getDesignSystem(); } catch (e) {}
      if (designSystem && Array.isArray(designSystem.variables) && designSystem.variables.length) {
        const frameHexes = extractFrameHexColors(tree);
        designSystem.variables = designSystem.variables.filter(v => v.color && frameHexes.has(v.color));
      }
      let lintResults = null;
      try { lintResults = lintFrame(tree, prefs, designSystem, { keepInternalFields: true }); } catch (e) {}
      const nodeStats = computeNodeStats(tree);
      figma.ui.postMessage({ type: "eta-update", eta: estimateEta(nodeStats.total) });
      return {
        locked: true,
        fileName: figma.root.name,
        pageName: figma.currentPage.name,
        root: { id: node.id, name: node.name, type: node.type },
        tree,
        thumbnail,
        thumbError,
        designSystem,
        lintResults,
        nodeStats,
      };
    }
    case "highlight_nodes": {
      const ids = Array.isArray(params.nodeIds) ? params.nodeIds : [];
      const nodes = ids
        .map(id => figma.getNodeById(id))
        .filter(n => !!n && "visible" in n);
      if (nodes.length) {
        try { figma.currentPage.selection = nodes; } catch (e) {}
        try { figma.viewport.scrollAndZoomIntoView(nodes); } catch (e) {}
      }
      return { ok: true, found: nodes.length };
    }
    case "submit_report": {
      figma.ui.postMessage({ type: "ai-progress", message: "Submitting report…" });
      figma.ui.postMessage({ type: "analyzing-done" });
      figma.ui.postMessage({ type: "report", data: params.report });
      locked = false;
      lockedIds = [];
      return { ok: true };
    }
    case "dismiss_review": {
      // Called by the AI when it cannot proceed (e.g. no frames selected).
      // Dismisses the reviewing overlay without submitting a report.
      locked = false;
      lockedIds = [];
      cancelled = false;
      figma.ui.postMessage({ type: "unlocked" });
      return { ok: true };
    }
    default:
      throw new Error("unknown method: " + method);
  }
}

// ------- linter (deterministic Simple review) -------

const IGNORE_PDATA_KEY = "figma-ai-score-ignored";

function isExplicitlyIgnored(node) {
  // Ground truth is the plugin-data flag, read at extractNode time into `node.ignored`.
  return !!(node && node.ignored === true);
}
// Single source of truth for "should this node be skipped by the rules?"
// User-marked ignore is the only escape — we don't auto-skip nodes by name
// (status bars, iPhone frames, etc.). If a designer doesn't want a node
// flagged, they ignore it explicitly via the eye toggle in the selection
// list; that travels with the file via plugin data.
function isExcluded(node) {
  return isExplicitlyIgnored(node);
}
function isInstance(node) {
  return !!(node && (node.type === "INSTANCE" || node.isInstance === true));
}
function isComponentContainer(node) {
  return isInstance(node) || node.type === "COMPONENT" || node.type === "COMPONENT_SET";
}

// Walk designer-owned descendants. Skips user-ignored nodes only (no
// hardcoded name-based skips like device chrome — user marks specific
// nodes ignored via the eye toggle in the selection list). Does NOT
// descend into INSTANCE children (library internals — designer can't
// fix from the instance side). Calls visit(node, isRoot, ancestors).
function walkDesignerNodes(root, visit) {
  const ancestors = [];
  (function recurse(node, isRoot) {
    if (!node || isExcluded(node)) return;
    visit(node, isRoot, ancestors);
    if (!isRoot && isInstance(node)) return;
    if (!node.children) return;
    ancestors.push(node);
    for (const c of node.children) recurse(c, false);
    ancestors.pop();
  })(root, true);
}

function countDescendants(root) {
  let c = 0;
  walkDesignerNodes(root, (_n, isRoot) => { if (!isRoot) c++; });
  return c;
}

// Returns the Set of hex color strings used in fills/strokes across the tree.
// Used to pre-filter DS color variables — safe because color suggestions require
// exact hex matches only (no nearest-neighbor needed).
function extractFrameHexColors(tree) {
  const hexes = new Set();
  walkDesignerNodes(tree, (node) => {
    for (const f of (node.fills || [])) {
      if (f.type === "SOLID" && f.visible !== false && f.color) hexes.add(f.color);
    }
    for (const s of (node.strokes || [])) {
      if (s.type === "SOLID" && s.visible !== false && s.color) hexes.add(s.color);
    }
  });
  return hexes;
}

// ── Create-component helpers ───────────────────────────────────────────────

// State/variant words used to detect sibling variants by name similarity.
const VARIANT_STATE_WORDS = new Set([
  "default","hover","active","disabled","pressed","focus","focused",
  "selected","loading","error","success","warning","on","off",
  "primary","secondary","tertiary","outlined","filled","text","ghost",
  "small","medium","large","xl","xs","sm","md","lg",
  "dark","light","checked","unchecked","open","closed","expanded","collapsed",
]);

// Return the set of variant siblings for `node`. A "variant" is:
//   (a) a sibling with the same base name (before the first "/"), OR
//   (b) a sibling with the same name stem (removing state words) and similar size.
// Returns [node] when no variants are found.
function findVariantCandidates(node) {
  const parent = node.parent;
  if (!parent || parent.type === "PAGE") return [node];
  const eligibleTypes = new Set(["FRAME","GROUP","COMPONENT","RECTANGLE","ELLIPSE"]);
  const siblings = (parent.children || []).filter(n => eligibleTypes.has(n.type));
  if (siblings.length < 2) return [node];

  const nodeName = node.name;
  const baseSlash = nodeName.split("/")[0].trim().toLowerCase();

  // Words in the name that are NOT state/variant words form the "stem"
  function stem(name) {
    return name.toLowerCase().split(/[\s\-_\/]+/)
      .filter(w => w.length > 0 && !VARIANT_STATE_WORDS.has(w))
      .join(" ");
  }
  const nodeStem = stem(nodeName);
  const sameSize = (a, b) =>
    Math.abs(a.width  - b.width)  <= Math.max(a.width  * 0.15, 4) &&
    Math.abs(a.height - b.height) <= Math.max(a.height * 0.15, 4);

  const found = siblings.filter(n => {
    if (n.id === node.id) return true; // always include the node itself
    const nBase = n.name.split("/")[0].trim().toLowerCase();
    // (a) Same slash-base name → strong signal
    if (nBase === baseSlash) return true;
    // (b) Same non-state stem + similar size → weaker but useful
    const nStem = stem(n.name);
    if (nStem && nStem === nodeStem && sameSize(node, n)) return true;
    return false;
  });

  // Deduplicate while preserving order, put the original node first
  const seen = new Set();
  const result = [node];
  seen.add(node.id);
  for (const n of found) {
    if (!seen.has(n.id)) { seen.add(n.id); result.push(n); }
  }
  return result.length > 1 ? result : [node];
}

// Derive a "Property=Value" component name for combineAsVariants.
// "Button"           → "Variant=Default"
// "Button/Hover"     → "Variant=Hover"
// "Button/Size=L/State=Hover" → "Size=L, State=Hover"
function variantNameForNode(node, baseName) {
  const raw = node.name;
  const after = raw.slice(baseName.length).replace(/^\//, "").trim();
  if (!after) return "Variant=Default";
  if (after.includes("=")) return after.replace(/\//g, ", "); // already structured
  return "Variant=" + after;
}

// Copy visual + layout properties from a source FrameNode into a destination.
const FRAME_COPY_PROPS = [
  "fills","strokes","effects","opacity","blendMode","clipsContent",
  "cornerRadius","topLeftRadius","topRightRadius","bottomLeftRadius","bottomRightRadius",
  "strokeWeight","strokeAlign",
  "paddingLeft","paddingRight","paddingTop","paddingBottom","itemSpacing",
  "layoutMode","primaryAxisAlignItems","counterAxisAlignItems",
  "primaryAxisSizingMode","counterAxisSizingMode",
  "layoutWrap","counterAxisSpacing",
];
function copyFrameProps(src, dst) {
  for (const p of FRAME_COPY_PROPS) {
    try {
      const v = src[p];
      if (v === undefined) continue;
      // Arrays (fills / strokes / effects) must be cloned, not shared
      dst[p] = Array.isArray(v) ? v.map(x => Object.assign({}, x)) : v;
    } catch (e) { /* skip read-only or unsupported props */ }
  }
  // Force fixed sizing so the component doesn't shrink to 0
  try { dst.primaryAxisSizingMode   = "FIXED"; } catch (e) {}
  try { dst.counterAxisSizingMode   = "FIXED"; } catch (e) {}
}

// Transfer any already-bound variables (paddingTop, itemSpacing, height, etc.)
// from a source node directly onto the new component. This preserves bindings
// applied by autolayout / token suggestions BEFORE "Create component" was
// clicked, which copyFrameProps misses (it copies raw numeric values only).
async function copyBoundVariables(src, dst) {
  const bv = src.boundVariables;
  if (!bv || typeof bv !== "object") return;
  const DIMENSIONAL_SLOTS = new Set([
    "paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
    "itemSpacing", "width", "height",
  ]);
  for (const [slot, alias] of Object.entries(bv)) {
    if (!DIMENSIONAL_SLOTS.has(slot)) continue;
    if (!alias || alias.type !== "VARIABLE_ALIAS" || !alias.id) continue;
    try {
      const variable = typeof figma.variables.getVariableByIdAsync === "function"
        ? await figma.variables.getVariableByIdAsync(alias.id)
        : figma.variables.getVariableById(alias.id);
      if (variable) dst.setBoundVariable(slot, variable);
    } catch (e) {}
  }
}

// After creating a component, bind dimensional tokens (padding, height,
// itemSpacing) for any slot whose value has an exact unambiguous token match.
// Errors per-slot are silently swallowed so a missing token never blocks
// component creation.
async function autoApplyDimensionalTokens(node, ds) {
  if (!ds) return;
  async function getVar(id) {
    try {
      return typeof figma.variables.getVariableByIdAsync === "function"
        ? await figma.variables.getVariableByIdAsync(id)
        : figma.variables.getVariableById(id);
    } catch (e) { return null; }
  }
  // Padding
  for (const slot of ["paddingTop", "paddingRight", "paddingBottom", "paddingLeft"]) {
    try {
      const val = node[slot];
      if (!val) continue;
      const sug = buildDimensionalSuggestion(ds, "padding", slot, val);
      if (!sug) continue;
      const variable = await getVar(sug.id);
      if (variable) node.setBoundVariable(slot, variable);
    } catch (e) {}
  }
  // Height (counterAxisSizingMode is already FIXED from copyFrameProps)
  try {
    const sug = buildDimensionalSuggestion(ds, "size", "height", node.height);
    if (sug) {
      const variable = await getVar(sug.id);
      if (variable) node.setBoundVariable("height", variable);
    }
  } catch (e) {}
  // Width (primaryAxisSizingMode is FIXED from copyFrameProps)
  try {
    const sug = buildDimensionalSuggestion(ds, "size", "width", node.width);
    if (sug) {
      const variable = await getVar(sug.id);
      if (variable) node.setBoundVariable("width", variable);
    }
  } catch (e) {}
  // itemSpacing — only when auto-layout has 2+ children (gap has visual effect)
  try {
    if (node.layoutMode && node.layoutMode !== "NONE" && (node.children || []).length >= 2) {
      const val = node.itemSpacing;
      if (val > 0) {
        const sug = buildDimensionalSuggestion(ds, "spacing", "itemSpacing", val);
        if (sug) {
          const variable = await getVar(sug.id);
          if (variable) node.setBoundVariable("itemSpacing", variable);
        }
      }
    }
  } catch (e) {}
}

// Convert a raw node into a new COMPONENT with the same visual content.
function nodeToComponent(sourceNode) {
  const comp = figma.createComponent();
  comp.name = sourceNode.name;
  try { comp.resize(sourceNode.width, sourceNode.height); } catch (e) {}
  copyFrameProps(sourceNode, comp);
  for (const child of (sourceNode.children || [])) {
    try { comp.appendChild(child.clone()); } catch (e) {}
  }
  return comp;
}

// Ensure there is at least GAP + neededWidth + GAP of clear space to the right
// of `frameNode` by shifting same-level siblings to the right if necessary.
// Returns the { x, y } position where the new item should be placed.
function makeRoomNextToFrame(frameNode, neededWidth) {
  const GAP       = 200;
  const frameRight = frameNode.x + frameNode.width;
  const container = frameNode.parent || figma.currentPage;
  const siblings  = (container.children || []).filter(n => n.id !== frameNode.id);

  // Nodes whose left edge is at or to the right of the frame
  const rightOf = siblings.filter(n => n.x >= frameRight - 10);
  if (rightOf.length === 0) {
    return { x: frameRight + GAP, y: frameNode.y };
  }

  const closestX  = Math.min(...rightOf.map(n => n.x));
  const available = closestX - frameRight;
  const needed    = GAP + neededWidth + GAP;

  if (available < needed) {
    const shift = needed - available;
    for (const n of rightOf) n.x += shift;
  }

  return { x: frameRight + GAP, y: frameNode.y };
}

function computeNodeStats(tree) {
  const stats = { total: 0, text: 0, instance: 0, autolayout: 0, withFills: 0, withStrokes: 0, withEffects: 0 };
  walkDesignerNodes(tree, (node) => {
    stats.total++;
    if (node.type === "TEXT") stats.text++;
    if (node.isInstance) stats.instance++;
    if (node.autolayout) stats.autolayout++;
    if (node.fills && node.fills.length > 0) stats.withFills++;
    if (node.strokes && node.strokes.length > 0) stats.withStrokes++;
    if (node.effects && node.effects.length > 0) stats.withEffects++;
  });
  return stats;
}

// Fast node counter for ETA estimation — iterative (no call-stack risk) with
// an early exit at 800 nodes. The ETA formula hits 5 minutes at exactly 800
// nodes; counting beyond that risks freezing Figma on huge master artboards.
const SHALLOW_COUNT_CAP = 800;
function shallowCountNodes(node) {
  let n = 0;
  const stack = [node];
  while (stack.length > 0) {
    if (n >= SHALLOW_COUNT_CAP) return n;
    const cur = stack.pop();
    n++;
    if (cur.children) for (const c of cur.children) stack.push(c);
  }
  return n;
}

// Estimate review duration from total node count.
// Formula: base 20s + 0.35s per node.
// Always ceiling-rounds to the nearest 30-second boundary so we never
// under-promise (e.g. 45 raw seconds → "About 1 minute").
// Anything ≥ 5 minutes is shown as "More than 5 minutes".
function estimateEta(totalNodes) {
  if (!totalNodes) return null;
  const raw = 20 + Math.round(totalNodes * 0.35);
  const secs = Math.ceil(raw / 30) * 30; // minimum 30, always a multiple of 30
  if (secs < 60) return "About 30 seconds";
  const mins = secs / 60;
  if (mins >= 5) return "More than 5 minutes";
  return Number.isInteger(mins)
    ? `About ${mins} minute${mins === 1 ? "" : "s"}`
    : `About ${mins} minutes`;
}

// ── components rule (4 checks) ──
// Each offender gets a single concise `detail`. When multiple checks fire on the
// same node, we pick the most informative reason (priority: giant > repeated >
// semantic > orphan) rather than concatenate.
function lintComponents(root) {
  const seen = new Map(); // nodeId -> { nodeId, name, reasons: { kind -> text } }
  const PRIORITY = ["giant", "repeated", "semantic", "orphan"]; // high → low
  const addOffense = (node, kind, reason) => {
    if (!seen.has(node.id)) seen.set(node.id, { nodeId: node.id, name: node.name, reasons: {} });
    seen.get(node.id).reasons[kind] = reason;
  };

  let totalChecked = 0;

  // Check 2: giant instance
  const rootKids = (root.children || []).filter(c => !isExcluded(c));
  const totalDesc = countDescendants(root);
  if (rootKids.length >= 1 && rootKids.length <= 2 && totalDesc > 0) {
    for (const kid of rootKids) {
      if (!isInstance(kid)) continue;
      const subCount = 1 + countDescendants(kid);
      if (subCount > totalDesc * 0.8) {
        addOffense(kid, "giant", `One instance wraps ${subCount} of ${totalDesc} descendants — decompose it.`);
      }
    }
  }

  // Check 1 (orphan) + totalChecked count
  // If the root itself is a COMPONENT or COMPONENT_SET, its contents are already
  // inside a component — orphan check doesn't apply.
  // NOTE: Check 4 (semantic names) is intentionally simple-mode-only removed —
  // it's a name-pattern heuristic, not real intent detection. Without vision it
  // produces too many false positives. It lives in AI mode only (see RULE_DESCRIPTIONS).
  const rootIsComponent = root.type === "COMPONENT" || root.type === "COMPONENT_SET";
  walkDesignerNodes(root, (node, isRoot, ancestors) => {
    if (isRoot) return;
    totalChecked++;
    if (rootIsComponent) return; // inside a component — nothing to flag here
    const hasContainerAncestor = ancestors.some(a => a !== root && isComponentContainer(a));
    const isOrphan = !isComponentContainer(node) && !hasContainerAncestor;
    if (isOrphan) {
      addOffense(node, "orphan", `Raw ${node.type} — should be wrapped in a component.`);
    }
  });

  // Check 3: repeated siblings
  function structSig(n) {
    if (!n) return "?";
    const kids = (n.children || []).filter(c => !isExcluded(c)).map(c => c.type).join(",");
    return `${n.type}[${kids}]`;
  }
  walkDesignerNodes(root, (node) => {
    if (!node.children || node.children.length < 3) return;
    const groups = new Map();
    for (const c of node.children) {
      if (isExcluded(c)) continue;
      const sig = structSig(c);
      if (!groups.has(sig)) groups.set(sig, []);
      groups.get(sig).push(c);
    }
    for (const kids of groups.values()) {
      if (kids.length < 3) continue;
      const mainIds = new Set(kids.map(k => k.mainComponentId || null));
      const allSameInstance = kids.every(isInstance) && mainIds.size === 1 && !mainIds.has(null);
      if (allSameInstance) continue;
      for (let i = 1; i < kids.length; i++) {
        addOffense(kids[i], "repeated", `Sibling ${i + 1} of ${kids.length} with matching structure — extract a shared component.`);
      }
    }
  });

  const offenders = [];
  for (const o of seen.values()) {
    // Pick the single most informative reason
    let chosen = null;
    for (const kind of PRIORITY) {
      if (o.reasons[kind]) { chosen = o.reasons[kind]; break; }
    }
    offenders.push({ nodeId: o.nodeId, name: o.name, detail: chosen || "Component issue." });
  }
  return {
    enabled: true,
    passed: offenders.length === 0,
    offenders: offenders.slice(0, 30),
    _totalChecked: totalChecked,
    _offenderCount: offenders.length
  };
}

// ── colors rule ──
function lintColors(root, ds) {
  const offenders = [];
  let totalChecked = 0;
  const hasDs = ds && ((ds.variables || []).length > 0 || (ds.paintStyles || []).length > 0);
  walkDesignerNodes(root, (node) => {
    // COMPONENT_SET is a canvas-only variant container — it never renders in
    // code. Its purple dotted outline is a Figma affordance, not a real style.
    // Skip fills and strokes entirely.
    if (node.type === "COMPONENT_SET") return;
    // Only SOLID fills can be tokenized. Image/video/gradient fills are skipped
    // (they don't carry color tokens). A layer with only an image fill and no
    // SOLID fill produces nothing to check.
    for (const f of (node.fills || [])) {
      if (f.type !== "SOLID" || f.visible === false) continue;
      totalChecked++;
      if (!f.boundVariable && !node.fillStyleId) {
        const o = {
          nodeId: node.id,
          name: node.name,
          detail: `Fill does not use a token or style.`
        };
        // Suggest token(s) for exact color matches. When multiple tokens share
        // the same value, rank by semantic fit and show the top 3 — Simple mode
        // displays these as pick buttons. All candidates are stored in
        // _allTokenCandidates so AI mode can make a more informed single choice.
        if (hasDs && !node.hasMultipleFills) {
          const all = findTokensByColor(ds, f.color);
          if (all.length > 0) {
            const top = rankColorCandidates(all, node.name);
            o.suggestedTokens = top.map(m => Object.assign({}, m, { slot: "fill", reason: "Exact match." }));
            if (all.length > top.length) {
              o._allTokenCandidates = all.map(m => Object.assign({}, m, { slot: "fill" }));
            }
          }
        }
        offenders.push(o);
      }
    }
    for (const s of (node.strokes || [])) {
      if (s.type !== "SOLID" || s.visible === false) continue;
      totalChecked++;
      if (!s.boundVariable && !node.strokeStyleId) {
        const o = {
          nodeId: node.id,
          name: node.name,
          detail: `Stroke does not use a token or style.`
        };
        if (hasDs && !node.hasMultipleStrokes) {
          const all = findTokensByColor(ds, s.color);
          if (all.length > 0) {
            const top = rankColorCandidates(all, node.name);
            o.suggestedTokens = top.map(m => Object.assign({}, m, { slot: "stroke", reason: "Exact match." }));
            if (all.length > top.length) {
              o._allTokenCandidates = all.map(m => Object.assign({}, m, { slot: "stroke" }));
            }
          }
        }
        offenders.push(o);
      }
    }
  });
  return {
    enabled: true,
    passed: offenders.length === 0,
    offenders: offenders.slice(0, 30),
    _totalChecked: totalChecked,
    _offenderCount: offenders.length
  };
}

// ── typography rule ──
function lintTypography(root) {
  const offenders = [];
  let totalChecked = 0;
  walkDesignerNodes(root, (node) => {
    if (node.type !== "TEXT") return;
    totalChecked++;
    if (node.textStyleId) return;
    const bt = node.boundTypography || {};
    if (bt.fontSize && bt.fontFamily && bt.fontWeight && bt.lineHeight) return;
    offenders.push({ nodeId: node.id, name: node.name, detail: `Text is not using a text style or typography tokens.` });
  });
  return {
    enabled: true,
    passed: offenders.length === 0,
    offenders: offenders.slice(0, 30),
    _totalChecked: totalChecked,
    _offenderCount: offenders.length
  };
}

// ── Helpers shared by padding/spacing/size suggestion logic ──
// Build the suggestedTokens array for a numeric offender. Returns either:
//   - a single match object when there's exactly one DS token at the same value
//     (filtered to the rule-appropriate keyword set)
//   - null when 0 or 2+ matches
function buildDimensionalSuggestion(ds, rule, slot, value) {
  if (!ds || !Array.isArray(ds.numberVariables) || !ds.numberVariables.length) return null;
  const filtered = filterDimensionTokensForRule(ds.numberVariables, rule);
  const match = findTokensByValue(filtered, value);
  if (!match) return null;
  return {
    kind: "variable",
    id: match.id,
    name: match.name,
    value: match.value,
    slot,
    reason: "Exact match."
  };
}

// ── spacing rule — itemSpacing only ──
function lintSpacing(root, ds) {
  const offenders = [];
  let totalChecked = 0;
  walkDesignerNodes(root, (node) => {
    if (!node.autolayout) return;
    // COMPONENT_SET padding/spacing is canvas-only variant arrangement — not code output.
    if (node.type === "COMPONENT_SET") return;
    const al = node.autolayout;
    const b = al.bound || {};
    // "Auto" gap = SPACE_BETWEEN mode — algorithmically distributed, no fixed value to tokenize.
    if (al.primaryAxisAlignItems === "SPACE_BETWEEN") return;
    // itemSpacing has no visible effect when there are fewer than 2
    // children — it's purely a gap between siblings. Don't flag it in
    // that case even if the value is hardcoded.
    const childCount = (node.children || []).length;
    if (childCount < 2) return;
    totalChecked++;
    const val = al.itemSpacing;
    if (val === 0 || val === null || val === undefined) return; // zero is fine
    if (b.itemSpacing) return; // already bound
    const o = {
      nodeId: node.id,
      name: node.name,
      detail: `itemSpacing ${val}px is not using a spacing token.`
    };
    const sug = buildDimensionalSuggestion(ds, "spacing", "itemSpacing", val);
    if (sug) o.suggestedTokens = [sug];
    offenders.push(o);
  });
  return {
    enabled: true,
    passed: offenders.length === 0,
    offenders: offenders.slice(0, 30),
    _totalChecked: totalChecked,
    _offenderCount: offenders.length
  };
}

// ── padding rule — paddingTop/Right/Bottom/Left ──
function lintPadding(root, ds) {
  const offenders = [];
  let totalChecked = 0;

  // Returns true when padding on an axis can be safely zeroed without changing
  // the visual layout.  Requires gravity (alignment) to be either:
  //   • pointing AWAY from the non-zero side  (only one side non-zero), or
  //   • CENTER with symmetric padding         (both sides equal → zeroing both
  //                                             keeps the center position).
  // Any other combination means the padding visually positions children, so it
  // should be tokenized, not cleared.
  //   paddingMin = top / left value   paddingMax = bottom / right value
  //   gravity = "MIN" | "CENTER" | "MAX"  (other values → false)
  function isZeroSafe(paddingMin, paddingMax, gravity) {
    if (!paddingMin && !paddingMax) return false;
    if (paddingMin > 0 && paddingMax === 0) return gravity === "MAX";
    if (paddingMin === 0 && paddingMax > 0) return gravity === "MIN";
    // Both non-zero: safe only if equal and centered (zeroing both preserves center).
    return paddingMin === paddingMax && gravity === "CENTER";
  }

  walkDesignerNodes(root, (node) => {
    if (!node.autolayout) return;
    // COMPONENT_SET padding is canvas-only variant arrangement — not code output.
    if (node.type === "COMPONENT_SET") return;
    const al = node.autolayout;
    const b  = al.bound || {};

    const topPad   = al.paddingTop    || 0;
    const botPad   = al.paddingBottom || 0;
    const leftPad  = al.paddingLeft   || 0;
    const rightPad = al.paddingRight  || 0;

    // Which alignment value applies to each axis depends on layout direction:
    //   VERTICAL layout  → primary = vertical, counter = horizontal
    //   HORIZONTAL layout → primary = horizontal, counter = vertical
    const primaryAlign = al.primaryAxisAlignItems  || null;
    const counterAlign = al.counterAxisAlignItems  || null;
    const isVerticalLayout = al.mode === "VERTICAL";
    const vAlign = isVerticalLayout ? primaryAlign : counterAlign; // top/bottom axis
    const hAlign = isVerticalLayout ? counterAlign : primaryAlign; // left/right axis

    // An axis qualifies for zeroing only when:
    //   1. The frame is FIXED on that axis.
    //   2. No direct child fills that axis (a fill-child's size depends on padding).
    //   3. The gravity (alignment) confirms padding has no visual effect (isZeroSafe).
    const canZeroVertical   = al.sizingVertical   === "FIXED" && !al.hasVerticalFillChild   && isZeroSafe(topPad,  botPad,   vAlign);
    const canZeroHorizontal = al.sizingHorizontal === "FIXED" && !al.hasHorizontalFillChild && isZeroSafe(leftPad, rightPad, hAlign);

    // Collect props to offer the clear action for.
    const zeroVerticalProps = [];
    if (canZeroVertical) {
      if (topPad > 0) zeroVerticalProps.push("paddingTop");
      if (botPad > 0) zeroVerticalProps.push("paddingBottom");
    }
    const zeroHorizontalProps = [];
    if (canZeroHorizontal) {
      if (leftPad  > 0) zeroHorizontalProps.push("paddingLeft");
      if (rightPad > 0) zeroHorizontalProps.push("paddingRight");
    }

    // Props to tokenize: non-zero, un-bound, NOT being offered as zero-action.
    const zeroSet = new Set([...zeroVerticalProps, ...zeroHorizontalProps]);
    const failedProps = [];
    for (const p of ["paddingTop", "paddingRight", "paddingBottom", "paddingLeft"]) {
      if (zeroSet.has(p)) continue; // handled by zero action
      const val = al[p];
      if (val === 0 || val === null || val === undefined) continue;
      if (!b[p]) failedProps.push(p);
    }

    // Count one check per node (not per prop) and one offender per node.
    totalChecked++;
    const hasZeroIssue = zeroVerticalProps.length > 0 || zeroHorizontalProps.length > 0;
    if (!failedProps.length && !hasZeroIssue) return;

    // Build detail from all issues on this node.
    const detailParts = [];
    if (failedProps.length) {
      const sides = failedProps.map(p => p.replace("padding", "").toLowerCase());
      const sideList = sides.length === 1
        ? sides[0]
        : sides.slice(0, -1).join(", ") + " and " + sides[sides.length - 1];
      detailParts.push(`${sideList} padding not tokenized.`);
    }
    // Format only the sides actually being zeroed: "Top", "Bottom", or "Top and bottom".
    const sideLabel = (props, reason) => {
      const map = { paddingTop: "Top", paddingBottom: "bottom", paddingLeft: "Left", paddingRight: "right" };
      const names = props.map(p => map[p]);
      // Capitalize the first one; lowercase any subsequent ones (only 1 or 2 ever).
      names[0] = names[0][0].toUpperCase() + names[0].slice(1);
      const joined = names.length === 1 ? names[0] : `${names[0]} and ${names[1]}`;
      return `${joined} padding ignored (${reason}).`;
    };
    if (zeroVerticalProps.length)   detailParts.push(sideLabel(zeroVerticalProps,   "fixed height"));
    if (zeroHorizontalProps.length) detailParts.push(sideLabel(zeroHorizontalProps, "fixed width"));

    const o = {
      nodeId: node.id,
      name:   node.name,
      detail: detailParts.join(" "),
    };

    // One suggestion per failing non-zero-action prop.
    if (failedProps.length) {
      const sugs = failedProps.map(p => buildDimensionalSuggestion(ds, "padding", p, al[p])).filter(Boolean);
      if (sugs.length) o.suggestedTokens = sugs;
    }

    // One-click zero actions for safe-to-clear fixed-axis paddings.
    const zeroActions = [];
    if (zeroVerticalProps.length)   zeroActions.push({ label: "Clear vertical padding",   props: zeroVerticalProps });
    if (zeroHorizontalProps.length) zeroActions.push({ label: "Clear horizontal padding", props: zeroHorizontalProps });
    if (zeroActions.length) o.zeroActions = zeroActions;

    offenders.push(o);
  });
  return {
    enabled: true,
    passed: offenders.length === 0,
    offenders: offenders.slice(0, 30),
    _totalChecked: totalChecked,
    _offenderCount: offenders.length
  };
}

// ── size rule — fixed dimensions ──
// Flags any FIXED width/height that isn't bound to a variable.
// - Auto-layout child: sizingHorizontal/Vertical === "FIXED" → check that axis.
// - Non-autolayout eligible nodes (FRAME/GROUP/COMPONENT/INSTANCE):
//   width and height are intrinsically FIXED (no hug/fill). Check both.
function lintSize(root, ds) {
  const offenders = [];
  let totalChecked = 0;
  walkDesignerNodes(root, (node) => {
    // Only flag size on atom-like nodes: COMPONENT, COMPONENT_SET, INSTANCE.
    // Plain FRAME/GROUP at fixed sizes are usually layout scaffolding (root
    // canvases like an iPhone frame, section wrappers, positioning shells)
    // whose dimensions come from device/parent context, not from a token a
    // designer should pick. Components and instances are the atoms (buttons,
    // chips, avatars, icons) where size tokens earn their keep.
    const eligibleTypes = new Set(["COMPONENT", "COMPONENT_SET", "INSTANCE"]);
    if (!eligibleTypes.has(node.type)) return;
    const sb = node.sizeBound || {};
    const al = node.autolayout;
    let hCheck = false, vCheck = false;
    if (al) {
      hCheck = al.sizingHorizontal === "FIXED";
      vCheck = al.sizingVertical === "FIXED";
    } else {
      // Non-autolayout: dimensions are intrinsically fixed.
      hCheck = true;
      vCheck = true;
    }
    if (hCheck) {
      totalChecked++;
      if (!sb.width && typeof node.width === "number") {
        const o = {
          nodeId: node.id,
          name: node.name,
          detail: `width ${node.width}px is not using a size token.`
        };
        const sug = buildDimensionalSuggestion(ds, "size", "width", node.width);
        if (sug) o.suggestedTokens = [sug];
        offenders.push(o);
      }
    }
    if (vCheck) {
      totalChecked++;
      if (!sb.height && typeof node.height === "number") {
        const o = {
          nodeId: node.id,
          name: node.name,
          detail: `height ${node.height}px is not using a size token.`
        };
        const sug = buildDimensionalSuggestion(ds, "size", "height", node.height);
        if (sug) o.suggestedTokens = [sug];
        offenders.push(o);
      }
    }
  });
  return {
    enabled: true,
    passed: offenders.length === 0,
    offenders: offenders.slice(0, 30),
    _totalChecked: totalChecked,
    _offenderCount: offenders.length
  };
}

// ── auto-layout rule (Simple mode — deterministic) ──
// Flags eligible container nodes (FRAME/GROUP/COMPONENT/COMPONENT_SET/
// INSTANCE) that aren't using auto-layout. Walks ALL nodes — no name-based
// device-chrome skip; the user marks specific nodes ignored if they don't
// want them flagged. INSTANCE children are still skipped (designer can't
// fix them on the instance side).
function lintAutolayoutSimple(root) {
  const offenders = [];
  let totalChecked = 0;
  const eligibleTypes = new Set(["FRAME", "GROUP", "COMPONENT", "COMPONENT_SET", "INSTANCE"]);
  (function recurse(node, isRoot) {
    if (!node) return;
    if (isExplicitlyIgnored(node)) return;
    // Skip the root frame: device canvases (iPhone, desktop, tablet artboards)
    // are device-shaped containers, not layout decisions. Their children are
    // the layout. Forcing auto-layout on the canvas itself would just make
    // designers wrap everything in a useless single-child auto-layout to
    // silence the rule. Nested FRAME/GROUP scaffolding still gets evaluated.
    if (isRoot) {
      if (node.children) for (const c of node.children) recurse(c, false);
      return;
    }
    if (eligibleTypes.has(node.type)) {
      // COMPONENT_SET layout is canvas-only variant arrangement — not code output.
      if (node.type === "COMPONENT_SET") {
        if (node.children) for (const c of node.children) recurse(c, false);
        return;
      }
      totalChecked++;
      // Auto-layout means `node.autolayout` is truthy in our extracted shape.
      if (!node.autolayout) {
        offenders.push({
          nodeId: node.id,
          name: node.name,
          detail: `${node.type.toLowerCase()} isn't using auto layout.`
        });
      }
    }
    // Don't recurse into INSTANCE children — library internals.
    if (!isRoot && isInstance(node)) return;
    if (!node.children) return;
    for (const c of node.children) recurse(c, false);
  })(root, true);
  return {
    enabled: true,
    passed: offenders.length === 0,
    offenders: offenders.slice(0, 30),
    _totalChecked: totalChecked,
    _offenderCount: offenders.length
  };
}

// ── effects rule ──
function lintEffects(root) {
  const offenders = [];
  let totalChecked = 0;
  walkDesignerNodes(root, (node) => {
    // COMPONENT_SET is a canvas-only variant container — never renders in code.
    if (node.type === "COMPONENT_SET") return;
    const visible = (node.effects || []).filter(e => e.visible !== false);
    if (visible.length === 0) return;
    totalChecked++;
    if (!node.effectStyleId) {
      offenders.push({
        nodeId: node.id,
        name: node.name,
        detail: `${visible.length} effect${visible.length === 1 ? "" : "s"} not using an effect style.`
      });
    }
  });
  return {
    enabled: true,
    passed: offenders.length === 0,
    offenders: offenders.slice(0, 30),
    _totalChecked: totalChecked,
    _offenderCount: offenders.length
  };
}

// ── naming rule (naive — regex for defaults, short/placeholder names) ──
const NAMING_DEFAULT_RE = /^(frame|rectangle|ellipse|polygon|star|line|vector|group|component|instance|text|image)\s*\d*$/i;
const NAMING_PLACEHOLDER_RE = /^(untitled|new\s+frame|copy|copy\s+\d+|asdf|test|temp|foo|bar|baz|placeholder|thing|stuff|element|new|item)$/i;
function lintNaming(root) {
  const offenders = [];
  let totalChecked = 0;
  walkDesignerNodes(root, (node /* isRoot — not skipped for naming */) => {
    totalChecked++;
    const name = (node.name || "").trim();
    let reason = null;
    if (!name) {
      reason = "Layer has no name.";
    } else if (NAMING_DEFAULT_RE.test(name)) {
      reason = `"${name}" is a Figma default — rename to something semantic.`;
    } else if (NAMING_PLACEHOLDER_RE.test(name)) {
      reason = `"${name}" is a placeholder name — rename to something semantic.`;
    } else if (/^[^A-Za-z]*$/.test(name) || name.length < 2) {
      // purely non-letter (numeric/symbols) or single char
      reason = `"${name}" is too short or non-descriptive.`;
    }
    if (reason) {
      offenders.push({ nodeId: node.id, name: node.name, detail: reason });
    }
  });
  return {
    enabled: true,
    passed: offenders.length === 0,
    offenders: offenders.slice(0, 30),
    _totalChecked: totalChecked,
    _offenderCount: offenders.length
  };
}

// ── orchestrator ──
function lintFrame(tree, enabledRules, ds, { keepInternalFields = false } = {}) {
  const breakdown = {};
  if (enabledRules.naming) breakdown.naming = lintNaming(tree);
  if (enabledRules.components) breakdown.components = lintComponents(tree);
  if (enabledRules.autolayout) breakdown.autolayout = lintAutolayoutSimple(tree);
  if (enabledRules.colors) breakdown.colors = lintColors(tree, ds);
  if (enabledRules.typography) breakdown.typography = lintTypography(tree);
  if (enabledRules.spacing) breakdown.spacing = lintSpacing(tree, ds);
  if (enabledRules.padding) breakdown.padding = lintPadding(tree, ds);
  if (enabledRules.size) breakdown.size = lintSize(tree, ds);
  if (enabledRules.effects) breakdown.effects = lintEffects(tree);

  const ruleScores = [];
  const topIssues = [];
  for (const [rule, r] of Object.entries(breakdown)) {
    const total = r._totalChecked;
    const off = r._offenderCount;
    const score = total === 0 ? 100 : ((total - off) / total) * 100;
    ruleScores.push(score);
    for (const o of r.offenders.slice(0, 3)) {
      topIssues.push({ rule, nodeId: o.nodeId, name: o.name, detail: o.detail });
    }
  }
  const finalScore = ruleScores.length === 0 ? 100 : Math.round(ruleScores.reduce((a, b) => a + b, 0) / ruleScores.length);
  const perfect = Object.values(breakdown).every(r => r.offenders.length === 0);

  // Strip internal fields (unless caller wants them for pre-computed results)
  const cleanBreakdown = {};
  for (const [k, v] of Object.entries(breakdown)) {
    if (keepInternalFields) {
      cleanBreakdown[k] = { enabled: v.enabled, passed: v.passed, offenders: v.offenders, _totalChecked: v._totalChecked, _offenderCount: v._offenderCount };
    } else {
      cleanBreakdown[k] = { enabled: v.enabled, passed: v.passed, offenders: v.offenders };
    }
  }

  return { score: finalScore, perfect, breakdown: cleanBreakdown, issues: topIssues.slice(0, 20) };
}

// ------- extraction -------

function extractNode(node, depth = 0, maxDepth = 8) {
  const out = { id: node.id, name: node.name, type: node.type };

  // Mark nodes explicitly excluded via plugin data flag (ground truth for
  // "ignore in review" toggling from the UI).
  try {
    if (typeof node.getPluginData === "function" && node.getPluginData(IGNORE_PDATA_KEY) === "1") {
      out.ignored = true;
    }
  } catch (e) {}

  if (node.type === "COMPONENT" || node.type === "COMPONENT_SET") out.isComponent = true;
  if (node.type === "INSTANCE") {
    out.isInstance = true;
    try {
      const main = node.mainComponent;
      if (main) {
        out.mainComponentId = main.id;
        // Inheritance: if the master component (or its parent COMPONENT_SET)
        // is flagged, the instance is treated as ignored too.
        if (!out.ignored && typeof main.getPluginData === "function" && main.getPluginData(IGNORE_PDATA_KEY) === "1") {
          out.ignored = true;
          out.ignoredInherited = true;
        }
        if (!out.ignored && main.parent && main.parent.type === "COMPONENT_SET" && typeof main.parent.getPluginData === "function" && main.parent.getPluginData(IGNORE_PDATA_KEY) === "1") {
          out.ignored = true;
          out.ignoredInherited = true;
        }
      } else {
        out.mainComponentId = null;
      }
    } catch (e) {}
  }

  if ("fills" in node && Array.isArray(node.fills)) {
    const fills = node.fills.map(serializePaint);
    if (fills.length > 0) {
      out.fills = fills;
      out.fillStyleId = node.fillStyleId || null; // null = not styled; AI needs this
      if (node.fills.length > 1) out.hasMultipleFills = true; // omit when false
    }
    // No fills → omit fills/fillStyleId/hasMultipleFills entirely (saves space)
  }
  if ("strokes" in node && Array.isArray(node.strokes)) {
    const strokes = node.strokes.map(serializePaint);
    if (strokes.length > 0) {
      out.strokes = strokes;
      out.strokeStyleId = node.strokeStyleId || null;
      if (node.strokes.length > 1) out.hasMultipleStrokes = true;
    }
  }
  if ("effects" in node && Array.isArray(node.effects)) {
    const effects = node.effects.map(serializeEffect);
    if (effects.length > 0) {
      out.effects = effects;
      out.effectStyleId = node.effectStyleId || null;
    }
  }

  if (node.type === "TEXT") {
    out.textStyleId = node.textStyleId || null;
    out.boundTypography = boundTypographyVars(node);
    if (typeof node.characters === "string") {
      out.characters = node.characters.length > 120
        ? node.characters.slice(0, 117) + "..."
        : node.characters;
    }
  }

  if ("layoutMode" in node && node.layoutMode && node.layoutMode !== "NONE") {
    const al = {
      mode: node.layoutMode,
      paddingTop: node.paddingTop,
      paddingRight: node.paddingRight,
      paddingBottom: node.paddingBottom,
      paddingLeft: node.paddingLeft,
      itemSpacing: node.itemSpacing,
    };
    const pai = ("primaryAxisAlignItems" in node) ? node.primaryAxisAlignItems : null;
    if (pai !== null) al.primaryAxisAlignItems = pai;
    const cai = ("counterAxisAlignItems" in node) ? node.counterAxisAlignItems : null;
    if (cai !== null) al.counterAxisAlignItems = cai;
    // bound: only include properties that ARE bound — absent = unbound.
    const bound = {};
    for (const k of ["paddingTop","paddingRight","paddingBottom","paddingLeft","itemSpacing"]) {
      const v = boundVarId(node, k);
      if (v) bound[k] = v;
    }
    if (Object.keys(bound).length) al.bound = bound;
    const sv = ("layoutSizingVertical" in node) ? node.layoutSizingVertical : null;
    const sh = ("layoutSizingHorizontal" in node) ? node.layoutSizingHorizontal : null;
    if (sv !== null) al.sizingVertical = sv;
    if (sh !== null) al.sizingHorizontal = sh;
    // Flag if any direct child fills a given axis — padding on that axis
    // constrains the fill-child's size, so it's NOT safe to zero it.
    if (Array.isArray(node.children) && node.children.length) {
      if (node.children.some(c => c.layoutSizingVertical   === "FILL")) al.hasVerticalFillChild   = true;
      if (node.children.some(c => c.layoutSizingHorizontal === "FILL")) al.hasHorizontalFillChild = true;
    }
    out.autolayout = al;
  }

  // Dimensions + position — width/height for size rule; x/y for autolayout math.
  if (typeof node.width  === "number") out.width  = node.width;
  if (typeof node.height === "number") out.height = node.height;
  if (typeof node.x      === "number") out.x      = node.x;
  if (typeof node.y      === "number") out.y      = node.y;
  // sizeBound: only include when at least one dimension is bound (absent = neither bound).
  const sbW = boundVarId(node, "width");
  const sbH = boundVarId(node, "height");
  if (sbW || sbH) out.sizeBound = { width: sbW, height: sbH };

  // Stop recursion at INSTANCE boundaries — their children are library
  // internals the designer doesn't control, and skipping them shrinks
  // typical scan payloads from megabytes to kilobytes.
  if ("children" in node && depth < maxDepth && !out.isInstance) {
    out.children = node.children.map(c => extractNode(c, depth + 1, maxDepth));
  }

  return out;
}

function boundVarId(node, key) {
  try {
    const bv = node.boundVariables;
    return (bv && bv[key] && bv[key].id) ? bv[key].id : null;
  } catch (e) { return null; }
}
function serializePaint(p) {
  const bv = p.boundVariables || {};
  return {
    type: p.type,
    visible: p.visible !== false,
    color: p.type === "SOLID" && p.color ? rgbToHex(p.color, p.opacity) : null,
    boundVariable: bv.color && bv.color.id ? bv.color.id : null
  };
}
function serializeEffect(e) {
  return {
    type: e.type,
    visible: e.visible !== false,
    boundVariables: e.boundVariables ? Object.keys(e.boundVariables) : []
  };
}
function boundTypographyVars(node) {
  const keys = ["fontSize", "fontFamily", "fontStyle", "fontWeight", "lineHeight", "letterSpacing", "paragraphSpacing"];
  const out = {};
  const bv = node.boundVariables || {};
  for (const k of keys) out[k] = (bv[k] && bv[k].id) ? bv[k].id : null;
  return out;
}
function rgbToHex(c, opacity) {
  const h = v => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, "0");
  let s = "#" + h(c.r) + h(c.g) + h(c.b);
  if (typeof opacity === "number" && opacity < 1) s += h(opacity);
  return s;
}

// ──────────────────────────────────────────────────────────────────
// Design System catalog — local color variables + paint styles.
// Feeds the color-token suggestion feature (Simple and Smart modes).
//
// - Variables are resolved to their concrete hex value using the
//   collection's default mode. One-hop alias resolution (a semantic
//   token aliasing a primitive both show the same hex).
// - Paint styles: only SOLID-fill styles included; gradients / images
//   can't be bound as color tokens.
// - isPrimitive: a heuristic hint ("primitives", "raw", scale numerics
//   like blue-500). Simple mode doesn't use this — it only cares about
//   exact matches. Smart mode uses it as a tie-breaker, preferring
//   semantic tokens over primitives when values are equal.
// ──────────────────────────────────────────────────────────────────
function isPrimitiveTokenName(variableName, collectionName) {
  const hay = ((variableName || "") + " " + (collectionName || "")).toLowerCase();
  if (/\bprimitive(s)?\b|\braw\b|\bcore\b|\bbase\b/.test(hay)) return true;
  // Leaf segment like "blue-500", "gray-100" — classic primitive scale.
  const lastSeg = (variableName || "").split("/").pop() || "";
  if (/^[a-z]+-?\d{2,4}$/i.test(lastSeg)) return true;
  return false;
}

// ─── Team-library variable support ────────────────────────────────
// Designers usually keep their tokens in a separate library file. We
// can't read other files' local variables, but Figma's teamLibrary API
// lets us enumerate variable collections from libraries that have been
// enabled in this file (Assets > Libraries) and import individual
// variables by key. The user picks which library/libraries hold their
// tokens via Settings; we cache the choice in clientStorage and only
// import variables from those libraries on review.
// ──────────────────────────────────────────────────────────────────

async function listAvailableLibraries() {
  // Returns [{ name, kind, collectionCount, colorCount, numberCount }]
  //   kind: "library"   — proper team library (multi-collection grouping)
  //   kind: "collection" — fallback for libraries the team API misses (e.g. MVP);
  //                        each collection appears separately because Figma doesn't
  //                        expose a libraryName for these locally-imported variables
  const result = [];
  const seenCollectionIds = new Set(); // collection IDs covered by team API (excluded from fallback)
  const teamVarKeys = new Set();       // variable keys covered by team API (used to exclude in fallback)

  // ── Source 1: team library API (preferred — gives library names + grouping) ──
  if (figma.teamLibrary && typeof figma.teamLibrary.getAvailableLibraryVariableCollectionsAsync === "function") {
    let collections = [];
    try {
      collections = await figma.teamLibrary.getAvailableLibraryVariableCollectionsAsync();
    } catch (e) {
      console.warn("[figma-ai-score] getAvailableLibraryVariableCollectionsAsync failed:", e && e.message);
    }
    console.log("[figma-ai-score] team-library variable collections found:", collections.length, collections.map(function(c) { return { libraryName: c.libraryName, name: c.name }; }));
    const byLib = new Map();
    for (const c of collections) {
      const n = c.libraryName || "Unknown library";
      if (!byLib.has(n)) byLib.set(n, { collectionCount: 0, colorCount: 0, numberCount: 0, keys: [] });
      const entry = byLib.get(n);
      entry.collectionCount++;
      entry.keys.push(c.key);
    }
    // Fetch all collections in parallel to avoid sequential round-trips.
    var allFetches = [];
    for (const pair of byLib) {
      var entry = pair[1];
      for (const key of entry.keys) {
        allFetches.push({ entry: entry, key: key });
      }
    }
    await Promise.all(allFetches.map(async function(item) {
      try {
        const vars = await figma.teamLibrary.getVariablesInLibraryCollectionAsync(item.key);
        for (const v of vars) {
          if (v.key) teamVarKeys.add(v.key);
          if (v.resolvedType === "COLOR") item.entry.colorCount++;
          else if (v.resolvedType === "FLOAT") item.entry.numberCount++;
        }
      } catch (e) {}
    }));
    for (const pair of byLib) {
      var name = pair[0];
      var stats = pair[1];
      result.push({ name: name, kind: "library", collectionCount: stats.collectionCount, colorCount: stats.colorCount, numberCount: stats.numberCount });
    }
    console.log("[figma-ai-score] team API covered", teamVarKeys.size, "variable keys across", seenCollectionIds.size, "collection IDs");
  }

  // ── Source 2: node-walk fallback (catches libraries the team API misses) ──
  // Walks only 2 levels deep (page → frame → direct children) to avoid
  // freezing on large pages. Enough to detect which libraries are in use.
  try {
    const seenVarIds = new Set();
    function collectBoundVarsShallow(node) {
      if (node.boundVariables) {
        const slots = Object.values(node.boundVariables);
        for (const slot of slots) {
          const items = Array.isArray(slot) ? slot : [slot];
          for (const ref of items) {
            if (ref && ref.id) seenVarIds.add(ref.id);
          }
        }
      }
    }
    for (const frame of figma.currentPage.children) {
      collectBoundVarsShallow(frame);
      if (frame.children) {
        for (const child of frame.children) {
          collectBoundVarsShallow(child);
        }
      }
    }

    // Group by collection ID
    const byColl = new Map(); // collId → { name, colorCount, numberCount, varNames }
    for (const varId of seenVarIds) {
      try {
        const v = figma.variables.getVariableById(varId);
        if (!v) continue;
        // Skip variables already covered by the team API (matched by key).
        // We can't use seenCollectionIds here because getLocalVariableCollections()
        // only returns file-local collections, not imported ones.
        if (v.key && teamVarKeys.has(v.key)) continue;
        if (seenCollectionIds.has(v.variableCollectionId)) continue;
        if (!byColl.has(v.variableCollectionId)) {
          const coll = figma.variables.getVariableCollectionById(v.variableCollectionId);
          if (!coll || !coll.remote) continue; // only fallback for remote (library) variables
          byColl.set(v.variableCollectionId, { name: coll.name, colorCount: 0, numberCount: 0, varNames: [] });
        }
        const entry = byColl.get(v.variableCollectionId);
        entry.varNames.push(v.resolvedType + ":" + v.name);
        if (v.resolvedType === "COLOR") entry.colorCount++;
        else if (v.resolvedType === "FLOAT") entry.numberCount++;
      } catch (e) {}
    }
    // Debug: log every variable found per collection so counts can be verified
    for (const pair of byColl) {
      var collDebugId = pair[0];
      var collDebugEntry = pair[1];
      console.log("[figma-ai-score] fallback collection '" + collDebugEntry.name + "' (" + collDebugId + "):", collDebugEntry.varNames);
    }
    if (byColl.size > 0) {
      // Aggregate all fallback collections under a single entry — Figma doesn't expose
      // the parent library name for these, so we can't split them by library.
      let libIndex = 1;
      // Bump the index past any "Library #N" names already in result (shouldn't happen,
      // but defensive in case the user has a real library named "Library #1").
      while (result.some(r => r.name === `Library #${libIndex}`)) libIndex++;
      const collVals = Array.from(byColl.values());
      const totalColors = collVals.reduce(function(s, e) { return s + e.colorCount; }, 0);
      const totalNumbers = collVals.reduce(function(s, e) { return s + e.numberCount; }, 0);
      const collectionIds = Array.from(byColl.keys());
      const collectionNames = collVals.map(function(e) { return e.name; });
      result.push({
        name: "Library #" + libIndex,
        kind: "collection",
        collectionCount: byColl.size,
        colorCount: totalColors,
        numberCount: totalNumbers,
        collectionIds: collectionIds,
        collectionNames: collectionNames
      });
      console.log("[figma-ai-score] fallback collections (via node walk):", byColl.size, "collections aggregated as 'Library #" + libIndex + "':", collectionNames);
    }
  } catch (e) {
    console.warn("[figma-ai-score] node-walk fallback failed:", e && e.message);
  }

  result.sort((a, b) => a.name.localeCompare(b.name));
  return result;
}

async function getSelectedTokenLibraries() {
  try {
    const v = await figma.clientStorage.getAsync("figma-ai-score.token-libraries");
    if (Array.isArray(v)) return v.filter(s => typeof s === "string");
  } catch (e) {}
  return [];
}

// Pull library variables (COLOR + FLOAT) from the user's selected
// libraries. Returns { variables: [...], numberVariables: [...] } in
// the same shape as the local enumeration. Each variable is imported
// into this file via importVariableByKeyAsync so its `.id` is a stable
// reference we can later bind via setBoundVariable.
async function getLibraryDesignSystem(getColl) {
  const variables = [];
  const numberVariables = [];
  const selected = await getSelectedTokenLibraries();
  if (!selected.length) return { variables, numberVariables };

  const selectedSet = new Set(selected);
  const seenCollIds = new Set(); // tracks collections covered by the team API path

  let collections = [];
  if (figma.teamLibrary && typeof figma.teamLibrary.getAvailableLibraryVariableCollectionsAsync === "function") {
    try {
      collections = await figma.teamLibrary.getAvailableLibraryVariableCollectionsAsync();
    } catch (e) {
      console.warn("[figma-ai-score] team-library collections fetch failed:", e && e.message);
    }
  }
  // Match by library name (proper libraries) OR by collection name (fallback collections).
  const matchingCollections = collections.filter(c => selectedSet.has(c.libraryName) || selectedSet.has(c.name));

  // Step 1: list variable metadata across all matching collections.
  const allMeta = []; // [{ key, name, resolvedType, libraryName, collectionName }]
  await Promise.all(matchingCollections.map(async (coll) => {
    try {
      const items = await figma.teamLibrary.getVariablesInLibraryCollectionAsync(coll.key);
      for (const it of items) {
        if (it.resolvedType !== "COLOR" && it.resolvedType !== "FLOAT") continue;
        allMeta.push({
          key: it.key,
          name: it.name,
          resolvedType: it.resolvedType,
          libraryName: coll.libraryName,
          collectionName: coll.name
        });
      }
    } catch (e) {
      console.warn("[figma-ai-score] getVariablesInLibraryCollectionAsync failed for", coll.name, e && e.message);
    }
  }));

  // Soft cap to avoid runaway imports on huge DS files.
  const CAP = 1000;
  const meta = allMeta.slice(0, CAP);

  // Step 2: import each variable so we can read its value and later bind.
  // Run in parallel — Figma's import API handles this fine.
  const imported = await Promise.all(meta.map(async (m) => {
    try {
      const v = await figma.variables.importVariableByKeyAsync(m.key);
      return { meta: m, variable: v };
    } catch (e) {
      return null;
    }
  }));

  for (const entry of imported) {
    if (!entry) continue;
    const { meta: m, variable: v } = entry;
    const coll = await getColl(v.variableCollectionId);
    const modeId = coll && coll.defaultModeId;
    let raw = v.valuesByMode && modeId ? v.valuesByMode[modeId] : null;
    if (raw && typeof raw === "object" && raw.type === "VARIABLE_ALIAS") {
      try {
        const referenced = typeof figma.variables.getVariableByIdAsync === "function"
          ? await figma.variables.getVariableByIdAsync(raw.id)
          : figma.variables.getVariableById(raw.id);
        if (referenced && referenced.valuesByMode) {
          const refColl = await getColl(referenced.variableCollectionId);
          const refModeId = refColl && refColl.defaultModeId;
          raw = refModeId ? referenced.valuesByMode[refModeId] : null;
        }
      } catch (e) { raw = null; }
    }
    if (m.resolvedType === "COLOR") {
      if (!raw || typeof raw !== "object" || !("r" in raw)) continue;
      const hex = rgbToHex(raw, typeof raw.a === "number" ? raw.a : undefined);
      variables.push({
        id: v.id,
        name: v.name,
        color: hex,
        collectionName: m.collectionName,
        libraryName: m.libraryName,
        isPrimitive: isPrimitiveTokenName(v.name, m.collectionName)
      });
    } else if (m.resolvedType === "FLOAT") {
      if (typeof raw !== "number") continue;
      numberVariables.push({
        id: v.id,
        name: v.name,
        value: raw,
        collectionName: m.collectionName,
        libraryName: m.libraryName,
        isPrimitive: isPrimitiveTokenName(v.name, m.collectionName)
      });
    }
    // Mark this collection as covered so the fallback skips it
    if (v && v.variableCollectionId) seenCollIds.add(v.variableCollectionId);
  }

  // ── Fallback: walk current page for remote collections selected by name ──
  // Catches libraries that the team API doesn't expose (e.g. MVP). Uses
  // bound variables already in the file as a partial catalog.
  try {
    const seenVarIds = new Set();
    function collectBoundVars(node) {
      if (node.boundVariables) {
        const slots = Object.values(node.boundVariables);
        for (const slot of slots) {
          const items = Array.isArray(slot) ? slot : [slot];
          for (const ref of items) {
            if (ref && ref.id) seenVarIds.add(ref.id);
          }
        }
      }
      if (node.children) node.children.forEach(collectBoundVars);
    }
    figma.currentPage.children.forEach(collectBoundVars);

    // Build a set of variable keys already imported via the team API path,
    // so we can skip them in the fallback (seenCollIds alone isn't enough
    // because imported variables get new local IDs that don't map back easily).
    const importedVarIds = new Set();
    for (const entry of imported) {
      if (entry && entry.variable && entry.variable.id) importedVarIds.add(entry.variable.id);
    }

    for (const varId of seenVarIds) {
      try {
        const v = figma.variables.getVariableById(varId);
        if (!v) continue;
        if (seenCollIds.has(v.variableCollectionId)) continue;
        if (importedVarIds.has(v.id)) continue; // already handled by team API path
        const coll = await getColl(v.variableCollectionId);
        if (!coll || !coll.remote) continue;
        // Accept if the user selected this collection by name (legacy) OR selected
        // any "Library #N" aggregated group (which covers all fallback collections).
        const selectedAsGroup = Array.from(selectedSet).some(function(s) { return /^Library #\d+$/.test(s); });
        if (!selectedSet.has(coll.name) && !selectedAsGroup) continue;
        const modeId = coll.defaultModeId;
        let raw = v.valuesByMode && modeId ? v.valuesByMode[modeId] : null;
        if (raw && typeof raw === "object" && raw.type === "VARIABLE_ALIAS") {
          try {
            const referenced = typeof figma.variables.getVariableByIdAsync === "function"
              ? await figma.variables.getVariableByIdAsync(raw.id)
              : figma.variables.getVariableById(raw.id);
            if (referenced && referenced.valuesByMode) {
              const refColl = await getColl(referenced.variableCollectionId);
              const refModeId = refColl && refColl.defaultModeId;
              raw = refModeId ? referenced.valuesByMode[refModeId] : null;
            }
          } catch (e) { raw = null; }
        }
        if (v.resolvedType === "COLOR") {
          if (!raw || typeof raw !== "object" || !("r" in raw)) continue;
          const hex = rgbToHex(raw, typeof raw.a === "number" ? raw.a : undefined);
          variables.push({
            id: v.id,
            name: v.name,
            color: hex,
            collectionName: coll.name,
            libraryName: coll.name,
            isPrimitive: isPrimitiveTokenName(v.name, coll.name)
          });
        } else if (v.resolvedType === "FLOAT") {
          if (typeof raw !== "number") continue;
          numberVariables.push({
            id: v.id,
            name: v.name,
            value: raw,
            collectionName: coll.name,
            libraryName: coll.name,
            isPrimitive: isPrimitiveTokenName(v.name, coll.name)
          });
        }
      } catch (e) {}
    }
  } catch (e) {
    console.warn("[figma-ai-score] design-system fallback failed:", e && e.message);
  }

  return { variables, numberVariables };
}

async function getDesignSystem() {
  const variables = [];
  const numberVariables = [];
  const paintStyles = [];
  // Shared collection cache across both COLOR and FLOAT enumerations.
  const collCache = new Map();
  async function getColl(id) {
    let c = collCache.get(id);
    if (c) return c;
    try {
      if (typeof figma.variables.getVariableCollectionByIdAsync === "function") {
        c = await figma.variables.getVariableCollectionByIdAsync(id);
      } else if (typeof figma.variables.getVariableCollectionById === "function") {
        c = figma.variables.getVariableCollectionById(id);
      }
    } catch (_e) {}
    if (c) collCache.set(id, c);
    return c;
  }

  // ── Color variables ──
  try {
    if (figma.variables && typeof figma.variables.getLocalVariablesAsync === "function") {
      const vars = await figma.variables.getLocalVariablesAsync("COLOR");
      for (const v of vars) {
        const coll = await getColl(v.variableCollectionId);
        const modeId = coll && coll.defaultModeId;
        let raw = v.valuesByMode && modeId ? v.valuesByMode[modeId] : null;
        // One-hop alias resolution — a semantic token that aliases a primitive.
        if (raw && raw.type === "VARIABLE_ALIAS") {
          try {
            const referenced = typeof figma.variables.getVariableByIdAsync === "function"
              ? await figma.variables.getVariableByIdAsync(raw.id)
              : figma.variables.getVariableById(raw.id);
            if (referenced && referenced.valuesByMode) {
              const refColl = await getColl(referenced.variableCollectionId);
              const refModeId = refColl && refColl.defaultModeId;
              raw = refModeId ? referenced.valuesByMode[refModeId] : null;
            }
          } catch (e) { raw = null; }
        }
        if (!raw || typeof raw !== "object" || !("r" in raw)) continue;
        // Note: variable color objects are {r,g,b,a}; rgbToHex accepts
        // opacity as a separate arg, so pass raw.a.
        const hex = rgbToHex(raw, typeof raw.a === "number" ? raw.a : undefined);
        variables.push({
          id: v.id,
          name: v.name,
          color: hex,
          collectionName: coll ? coll.name : null,
          isPrimitive: isPrimitiveTokenName(v.name, coll ? coll.name : null)
        });
      }
    }
  } catch (e) {
    console.warn("[figma-ai-score] variables enumeration failed:", e && e.message);
  }

  // ── Number (FLOAT) variables — used by padding/spacing/size rules ──
  try {
    if (figma.variables && typeof figma.variables.getLocalVariablesAsync === "function") {
      const vars = await figma.variables.getLocalVariablesAsync("FLOAT");
      for (const v of vars) {
        const coll = await getColl(v.variableCollectionId);
        const modeId = coll && coll.defaultModeId;
        let raw = v.valuesByMode && modeId ? v.valuesByMode[modeId] : null;
        // One-hop alias resolution.
        if (raw && typeof raw === "object" && raw.type === "VARIABLE_ALIAS") {
          try {
            const referenced = typeof figma.variables.getVariableByIdAsync === "function"
              ? await figma.variables.getVariableByIdAsync(raw.id)
              : figma.variables.getVariableById(raw.id);
            if (referenced && referenced.valuesByMode) {
              const refColl = await getColl(referenced.variableCollectionId);
              const refModeId = refColl && refColl.defaultModeId;
              raw = refModeId ? referenced.valuesByMode[refModeId] : null;
            }
          } catch (e) { raw = null; }
        }
        if (typeof raw !== "number") continue;
        numberVariables.push({
          id: v.id,
          name: v.name,
          value: raw,
          collectionName: coll ? coll.name : null,
          isPrimitive: isPrimitiveTokenName(v.name, coll ? coll.name : null)
        });
      }
    }
  } catch (e) {
    console.warn("[figma-ai-score] number-variable enumeration failed:", e && e.message);
  }

  // ── Paint styles (the older style system) ──
  try {
    let styles = [];
    if (typeof figma.getLocalPaintStylesAsync === "function") {
      styles = await figma.getLocalPaintStylesAsync();
    } else if (typeof figma.getLocalPaintStyles === "function") {
      styles = figma.getLocalPaintStyles();
    }
    for (const s of styles) {
      const paints = s.paints || [];
      const solid = paints.find(p => p && p.type === "SOLID" && p.color);
      if (!solid) continue;
      paintStyles.push({
        id: s.id,
        name: s.name,
        color: rgbToHex(solid.color, solid.opacity)
      });
    }
  } catch (e) {
    console.warn("[figma-ai-score] paint-style enumeration failed:", e && e.message);
  }

  // ── Library variables (user-selected DS libraries) ──
  try {
    const lib = await getLibraryDesignSystem(getColl);
    for (const v of lib.variables) variables.push(v);
    for (const v of lib.numberVariables) numberVariables.push(v);
  } catch (e) {
    console.warn("[figma-ai-score] library DS enumeration failed:", e && e.message);
  }

  return { variables, numberVariables, paintStyles };
}

// Find tokens (variable preferred over style when both match).
// Returns { kind: "variable"|"style", id, name, color, isPrimitive? } or null.
// Returns an array of all tokens whose resolved color matches `hex`.
function findTokensByColor(ds, hex) {
  const norm = (c) => (c || "").toLowerCase();
  const target = norm(hex);
  const varMatches = (ds.variables || [])
    .filter(v => norm(v.color) === target)
    .map(v => ({ kind: "variable", id: v.id, name: v.name, color: v.color, isPrimitive: v.isPrimitive, collectionName: v.collectionName }));
  const styleMatches = (ds.paintStyles || [])
    .filter(s => norm(s.color) === target)
    .map(s => ({ kind: "style", id: s.id, name: s.name, color: s.color }));
  return [...varMatches, ...styleMatches];
}

// Rank color token candidates by semantic fit for a given node name.
// Returns the top `max` candidates (default 3) so the UI stays readable.
// Scoring:
//   +10 per token-name word that appears in the node name
//   +5  if the collection is named "main" (primary design system tokens)
//   +2  if marked as a primitive token
//   -1  per path segment (prefer simpler / shorter token names)
function rankColorCandidates(candidates, nodeName, max) {
  if (!candidates || candidates.length === 0) return [];
  max = max || 1;
  if (candidates.length <= max) return candidates;
  const nodeWords = new Set(
    (nodeName || "").toLowerCase().split(/[\s\-_\/]+/).filter(w => w.length > 2)
  );
  function score(t) {
    let s = 0;
    const parts = (t.name || "").toLowerCase().split(/[\s\-_\/]+/);
    for (const w of parts) if (nodeWords.has(w)) s += 10;
    if ((t.collectionName || t.name || "").toLowerCase().startsWith("main")) s += 5;
    if (t.isPrimitive) s += 2;
    s -= parts.length; // prefer shorter names
    return s;
  }
  return candidates
    .map(t => ({ t, s: score(t) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, max)
    .map(x => x.t);
}

// Heuristic filter: which FLOAT variables are "appropriate" for a given
// dimensional rule. Searches keywords in variable name + collection name.
// Imperfect (a team's "layout/inset/m" wouldn't match "padding") — but
// "no suggestion" is a safe failure mode. AI mode uses the catalog as-is
// and lets Claude decide; this filter is for Simple-mode determinism only.
const DIMENSION_RULE_KEYWORDS = {
  padding: ["padding", "pad"],
  spacing: ["spacing", "gap", "space"],
  // "size" excludes "font-size" / "line-height" by inspecting word boundaries
  // in the post-filter step rather than the keywords themselves.
  size: ["size", "height", "width", "dim"]
};
function filterDimensionTokensForRule(numberVariables, rule) {
  const keywords = DIMENSION_RULE_KEYWORDS[rule];
  if (!keywords) return [];
  const out = [];
  for (const v of (numberVariables || [])) {
    const hay = ((v.name || "") + " " + (v.collectionName || "")).toLowerCase();
    const matches = keywords.some(k => hay.includes(k));
    if (!matches) continue;
    // For "size", reject obvious non-size dimension tokens whose names
    // hint they're typography or radius, etc.
    if (rule === "size") {
      if (/font[-_/ ]?size|line[-_/ ]?height|letter[-_/ ]?spacing|font[-_/ ]?weight|radius|border[-_/ ]?radius/i.test(v.name)) continue;
    }
    out.push(v);
  }
  return out;
}

// Find a numeric token (FLOAT variable) by value.
// - exactly one exact match (Simple mode happy path) → returns that match
// - 0 or 2+ exact matches → returns null (ambiguous)
// - opts.neighbors → returns { exact, below, above }:
//     exact: same as above (or null)
//     below: the token with the highest value strictly less than target
//     above: the token with the lowest value strictly greater than target
//   When the target sits between two tokens, both fields are populated;
//   AI mode renders both as candidate suggestions.
function findTokensByValue(numberVariables, targetValue, opts) {
  opts = opts || {};
  const list = (numberVariables || []);
  const exact = list.filter(v => v.value === targetValue);
  if (opts.neighbors) {
    const below = list
      .filter(v => v.value < targetValue)
      .sort((a, b) => b.value - a.value)[0] || null;
    const above = list
      .filter(v => v.value > targetValue)
      .sort((a, b) => a.value - b.value)[0] || null;
    return {
      exact: exact.length === 1 ? exact[0] : null,
      below,
      above
    };
  }
  return exact.length === 1 ? exact[0] : null;
}
function bytesToBase64(bytes) {
  // Pure-JS base64 encoder. Figma's plugin sandbox doesn't provide btoa().
  const CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const len = bytes.length;
  let result = "";
  for (let i = 0; i < len; i += 3) {
    const b1 = bytes[i];
    const b2 = i + 1 < len ? bytes[i + 1] : 0;
    const b3 = i + 2 < len ? bytes[i + 2] : 0;
    const n = (b1 << 16) | (b2 << 8) | b3;
    result += CHARS[(n >> 18) & 0x3F];
    result += CHARS[(n >> 12) & 0x3F];
    result += i + 1 < len ? CHARS[(n >> 6) & 0x3F] : "=";
    result += i + 2 < len ? CHARS[n & 0x3F] : "=";
  }
  return result;
}

// ──────────────────────────────────────────────────────────────────
// PNG report export — build report as Figma nodes, export via Figma's
// own renderer. No SVG, no canvas, no tainting.
//
// Palette + layout values come from the `ai-score-export-template`
// frame the designer built in Figma (file Website, node 1785:127529)
// and its score-circle component set (node 1787:127553). Keep this
// in sync when the template is updated.
// ──────────────────────────────────────────────────────────────────

const EXPORT_PALETTE = {
  perfect: { bg: "#E9F7EA", accent: "#366A39" },
  good:    { bg: "#EFEBFC", accent: "#835BF3" },
  warn:    { bg: "#FEF7E4", accent: "#BB892A" },
  bad:     { bg: "#FAEAEB", accent: "#B64540" }
};
const EXPORT_ROW_BG        = "#F5F5F5";
const EXPORT_ROW_DIVIDER   = "rgba(0,0,0,0.15)";
const EXPORT_TEXT_PRIMARY  = "rgba(0,0,0,0.87)";
const EXPORT_TEXT_SECONDARY = "rgba(0,0,0,0.7)";
const EXPORT_TEXT_MUTED    = "rgba(0,0,0,0.5)";
const EXPORT_CARD_WIDTH    = 730;
const EXPORT_CONTENT_WIDTH = 698; // 730 - 16*2 padding
const EXPORT_SCORE_CIRCLE_SIZE = 186;
const EXPORT_RULE_ORDER = [
  "naming", "components", "autolayout",
  "colors", "typography",
  "spacing", "padding", "size",
  "effects"
];
const EXPORT_RULE_LABELS = {
  naming: "Naming",
  components: "Components",
  autolayout: "Auto layout",
  colors: "Colors",
  typography: "Typography",
  spacing: "Spacing",
  padding: "Padding",
  size: "Size",
  effects: "Effects"
};

// Try Poppins first (what the template uses), fall back to Inter.
async function loadExportFont() {
  const weights = ["Regular", "Medium", "SemiBold", "Bold"];
  for (const family of ["Poppins", "Inter"]) {
    try {
      for (const style of weights) {
        await figma.loadFontAsync({ family, style });
      }
      return family;
    } catch (_e) {
      // Next family
    }
  }
  throw new Error(
    "Neither Poppins nor Inter is available for export. " +
    "Install one of these fonts and retry."
  );
}

function parseExportColor(spec) {
  if (spec.startsWith("rgba") || spec.startsWith("rgb")) {
    const m = spec.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+))?\s*\)/);
    return {
      color: { r: +m[1] / 255, g: +m[2] / 255, b: +m[3] / 255 },
      opacity: m[4] !== undefined ? parseFloat(m[4]) : 1
    };
  }
  const h = spec.replace("#", "");
  return {
    color: {
      r: parseInt(h.substring(0, 2), 16) / 255,
      g: parseInt(h.substring(2, 4), 16) / 255,
      b: parseInt(h.substring(4, 6), 16) / 255
    },
    opacity: 1
  };
}

function exportFill(colorSpec) {
  const { color, opacity } = parseExportColor(colorSpec);
  return { type: "SOLID", color, opacity };
}

function makeText(family, style, size, color, content, align) {
  const t = figma.createText();
  t.fontName = { family, style };
  t.fontSize = size;
  t.characters = String(content);
  t.fills = [exportFill(color)];
  if (align) t.textAlignHorizontal = align;
  return t;
}

// Text with width fixed → auto-wraps height.
function makeWrappedText(family, style, size, color, content, width, align) {
  const t = makeText(family, style, size, color, content, align);
  t.textAutoResize = "HEIGHT";
  t.resize(width, t.height);
  return t;
}

function scoreLevelFor(score, perfect) {
  if (perfect) return "perfect";
  if (score >= 80) return "good";
  if (score >= 50) return "warn";
  return "bad";
}

// Build the colored progress ring as a native Figma EllipseNode using
// arcData — more reliable than createNodeFromSvg (which wraps in a
// frame that can obscure siblings).
// Returns an EllipseNode sized SIZE × SIZE positioned at (0,0).
function buildProgressRing(score, strokeColor) {
  const SIZE = EXPORT_SCORE_CIRCLE_SIZE;
  const pct = Math.max(0, Math.min(100, score)) / 100;
  const e = figma.createEllipse();
  e.name = "progress-stroke";
  e.resize(SIZE, SIZE);
  e.fills = [exportFill(strokeColor)];
  e.strokes = [];
  // Figma angle convention: 0 = 3 o'clock (east), angles increase
  // clockwise. We want the progress to START at 12 o'clock (north)
  // and sweep clockwise, so startingAngle = -π/2.
  const start = -Math.PI / 2;
  // When pct=1, endingAngle must not equal startingAngle (that's
  // how Figma detects a full arc vs empty arc — use exactly +2π).
  e.arcData = {
    startingAngle: start,
    endingAngle: start + 2 * Math.PI * pct,
    innerRadius: 0.92   // thin ring; tune if too thin/thick
  };
  return e;
}

function buildScoreCircle(frame, family) {
  const level = scoreLevelFor(frame.score, frame.perfect);
  const style = EXPORT_PALETTE[level];
  const SIZE = EXPORT_SCORE_CIRCLE_SIZE;

  // Outer filled circle (no auto-layout — children overlap).
  const outer = figma.createFrame();
  outer.name = "score-circle";
  outer.resize(SIZE, SIZE);
  outer.cornerRadius = SIZE; // pill → full circle
  outer.fills = [exportFill(style.bg)];
  outer.clipsContent = true;

  // Number (big) + denom, stacked vertically and centered as a group.
  const num = makeText(family, "Bold", 60, style.accent, String(frame.score));
  const denom = makeText(family, "Medium", 22, EXPORT_TEXT_MUTED, "Out of 100");

  outer.appendChild(num);
  outer.appendChild(denom);
  const gap = 2;
  const stackH = num.height + gap + denom.height;
  num.x = (SIZE - num.width) / 2;
  denom.x = (SIZE - denom.width) / 2;
  num.y = (SIZE - stackH) / 2;
  denom.y = num.y + num.height + gap;

  // Progress ring on top.
  const ring = buildProgressRing(frame.score, style.accent);
  outer.appendChild(ring);
  ring.x = 0;
  ring.y = 0;

  return outer;
}

function buildPerfectBadge(family) {
  const W = 143, H = 46;
  const f = figma.createFrame();
  f.name = "perfect-badge";
  f.resize(W, H);
  f.cornerRadius = H;
  f.fills = [exportFill("#E9F7EA")];
  f.strokes = [exportFill("#366A39")];
  f.strokeWeight = 2;
  f.clipsContent = true;

  const t = makeText(family, "Medium", 24, "#366A39", "PERFECT");
  f.appendChild(t);
  t.x = (W - t.width) / 2;
  t.y = (H - t.height) / 2;

  return f;
}

function buildFrameName(name, family, maxWidth) {
  const t = makeText(family, "Bold", 32, EXPORT_TEXT_PRIMARY, name, "CENTER");
  t.textAutoResize = "HEIGHT";
  t.resize(maxWidth, t.height);
  return t;
}

function buildTopSection(frame, family) {
  const section = figma.createFrame();
  section.name = "top-section";
  section.fills = [];
  section.layoutMode = "VERTICAL";
  section.counterAxisAlignItems = "CENTER";
  section.itemSpacing = 8;
  section.resize(EXPORT_CONTENT_WIDTH, 100);
  // Sizing modes AFTER resize so resize doesn't clobber them.
  section.primaryAxisSizingMode = "AUTO";
  section.counterAxisSizingMode = "FIXED";

  const container = figma.createFrame();
  container.name = "score + frame name";
  container.fills = [];
  container.layoutMode = "VERTICAL";
  container.counterAxisAlignItems = "CENTER";
  container.itemSpacing = 16;
  container.resize(EXPORT_CONTENT_WIDTH, 100);
  container.primaryAxisSizingMode = "AUTO";
  container.counterAxisSizingMode = "FIXED";

  container.appendChild(buildScoreCircle(frame, family));
  container.appendChild(buildFrameName(frame.name, family, EXPORT_CONTENT_WIDTH));
  section.appendChild(container);

  if (frame.perfect) section.appendChild(buildPerfectBadge(family));

  return section;
}

function buildPassingRuleRow(ruleName, family) {
  const row = figma.createFrame();
  row.name = "rule-row";
  row.fills = [exportFill(EXPORT_ROW_BG)];
  row.clipsContent = true;
  row.cornerRadius = 8;
  row.layoutMode = "HORIZONTAL";
  row.counterAxisAlignItems = "CENTER";
  row.itemSpacing = 16;
  row.paddingLeft = 16;
  row.paddingRight = 16;
  row.resize(EXPORT_CONTENT_WIDTH, 49);
  row.primaryAxisSizingMode = "FIXED";
  row.counterAxisSizingMode = "FIXED";

  const name = makeText(family, "Medium", 24, EXPORT_TEXT_PRIMARY, EXPORT_RULE_LABELS[ruleName] || ruleName);
  row.appendChild(name);
  name.layoutGrow = 1;

  const result = makeText(family, "SemiBold", 20, "#366A39", "Pass");
  row.appendChild(result);

  return row;
}

function buildOffenderItem(offender, family) {
  const item = figma.createFrame();
  item.name = "offender-item";
  item.fills = [];
  item.layoutMode = "VERTICAL";
  item.itemSpacing = 8;
  item.paddingLeft = 24;
  item.paddingRight = 24;
  item.paddingTop = 4;
  item.paddingBottom = 4;
  item.resize(EXPORT_CONTENT_WIDTH, 100);
  item.primaryAxisSizingMode = "AUTO";
  item.counterAxisSizingMode = "FIXED";

  const innerWidth = EXPORT_CONTENT_WIDTH - 24 * 2;

  const layerName = makeWrappedText(family, "Medium", 26, EXPORT_TEXT_PRIMARY, offender.name || "(unnamed)", innerWidth);
  item.appendChild(layerName);

  const detail = makeWrappedText(family, "Regular", 22, EXPORT_TEXT_SECONDARY, offender.detail || "", innerWidth);
  item.appendChild(detail);

  return item;
}

function buildFailingRuleRow(ruleName, offenders, family) {
  const row = figma.createFrame();
  row.name = "failing-rule-row";
  row.fills = [exportFill(EXPORT_ROW_BG)];
  row.cornerRadius = 8;
  row.layoutMode = "VERTICAL";
  row.itemSpacing = 8;
  row.paddingBottom = 8;
  row.resize(EXPORT_CONTENT_WIDTH, 100);
  row.primaryAxisSizingMode = "AUTO";
  row.counterAxisSizingMode = "FIXED";

  // Header (same shape as a passing rule-row but red count + bottom divider)
  const header = figma.createFrame();
  header.name = "header";
  header.fills = [];
  header.layoutMode = "HORIZONTAL";
  header.counterAxisAlignItems = "CENTER";
  header.itemSpacing = 16;
  header.paddingLeft = 16;
  header.paddingRight = 16;
  header.resize(EXPORT_CONTENT_WIDTH, 49);
  header.primaryAxisSizingMode = "FIXED";
  header.counterAxisSizingMode = "FIXED";
  header.strokes = [exportFill(EXPORT_ROW_DIVIDER)];
  header.strokeAlign = "INSIDE";
  header.strokeTopWeight = 0;
  header.strokeLeftWeight = 0;
  header.strokeRightWeight = 0;
  header.strokeBottomWeight = 1;

  const name = makeText(family, "Medium", 24, EXPORT_TEXT_PRIMARY, EXPORT_RULE_LABELS[ruleName] || ruleName);
  header.appendChild(name);
  name.layoutGrow = 1;

  const count = offenders.length;
  const countStr = count + " issue" + (count === 1 ? "" : "s");
  const countText = makeText(family, "SemiBold", 20, "#B64540", countStr);
  header.appendChild(countText);

  row.appendChild(header);

  // Offender items + dividers between them
  for (let i = 0; i < offenders.length; i++) {
    row.appendChild(buildOffenderItem(offenders[i], family));
    if (i < offenders.length - 1) {
      const divider = figma.createRectangle();
      divider.name = "divider";
      divider.resize(EXPORT_CONTENT_WIDTH, 1);
      divider.fills = [exportFill(EXPORT_ROW_DIVIDER)];
      row.appendChild(divider);
    }
  }

  return row;
}

function buildIssuesList(breakdown, family) {
  const list = figma.createFrame();
  list.name = "issues-list";
  list.fills = [];
  list.layoutMode = "VERTICAL";
  list.itemSpacing = 4;
  list.resize(EXPORT_CONTENT_WIDTH, 100);
  list.primaryAxisSizingMode = "AUTO";
  list.counterAxisSizingMode = "FIXED";

  for (const rule of EXPORT_RULE_ORDER) {
    const r = (breakdown || {})[rule];
    if (!r || r.enabled === false) continue;
    if (r.passed) {
      list.appendChild(buildPassingRuleRow(rule, family));
    } else {
      list.appendChild(buildFailingRuleRow(rule, r.offenders || [], family));
    }
  }

  return list;
}

function buildFrameCard(frame, family) {
  const card = figma.createFrame();
  card.name = "frame-card";
  card.fills = [];
  card.layoutMode = "VERTICAL";
  card.counterAxisAlignItems = "CENTER";
  card.itemSpacing = 32;
  card.resize(EXPORT_CONTENT_WIDTH, 100);
  card.primaryAxisSizingMode = "AUTO";
  card.counterAxisSizingMode = "FIXED";

  card.appendChild(buildTopSection(frame, family));
  card.appendChild(buildIssuesList(frame.breakdown || {}, family));

  return card;
}

async function buildExportPng(report) {
  if (!report || !report.frames || report.frames.length === 0) {
    throw new Error("Empty report — nothing to export.");
  }
  console.log("[figma-ai-score export] building for", report.frames.length, "frame(s)");
  const family = await loadExportFont();
  console.log("[figma-ai-score export] using font:", family);

  const root = figma.createFrame();
  root.name = "AI Programmability Report";
  root.fills = [exportFill("#FFFFFF")];
  root.layoutMode = "VERTICAL";
  root.counterAxisAlignItems = "CENTER";
  root.paddingTop = 40;
  root.paddingBottom = 40;
  root.paddingLeft = 16;
  root.paddingRight = 16;
  root.itemSpacing = 48;
  // Resize THEN set sizing modes — resize() sometimes clobbers modes.
  root.resize(EXPORT_CARD_WIDTH, 100);
  root.primaryAxisSizingMode = "AUTO";
  root.counterAxisSizingMode = "FIXED";

  for (const f of report.frames) {
    const card = buildFrameCard(f, family);
    root.appendChild(card);
    console.log("[figma-ai-score export] appended card:", f.name, "→", card.width + "x" + card.height);
  }

  figma.currentPage.appendChild(root);
  // Park it far off-canvas so the user never sees the temp frame
  root.x = -99999;
  root.y = -99999;
  console.log("[figma-ai-score export] root on canvas, size:", root.width + "x" + root.height);

  try {
    const bytes = await root.exportAsync({
      format: "PNG",
      constraint: { type: "SCALE", value: 2 }
    });
    console.log("[figma-ai-score export] exported", bytes.length, "bytes");
    return bytes;
  } finally {
    try { root.remove(); } catch (_e) {}
  }
}
