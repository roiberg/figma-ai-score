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
  radius: true,
  effects: true
};
const PREFS_KEY = "figma-ai-score.prefs.v1";

// ── ETA-vs-actual stats logging ──────────────────────────────────────────
// Internal-only instrumentation to compare estimateEta() against actual
// review wall time. Captures plugin-side work separately from AI thinking
// time so we can tell where variance is coming from. The log lives in
// figma.clientStorage and is dumped via the `eta-stats` CLI subcommand.
// Capped at the last MAX_ETA_LOG entries — old entries pushed out FIFO.
// THIS IS A TUNING INSTRUMENT, NOT A USER FEATURE — remove when done.
const ETA_LOG_KEY  = "figma-ai-score.eta-log.v1";
const MAX_ETA_LOG  = 100;
let _etaInFlight = null; // { startedAt, etaSeconds, frames, totalNodes, mode, pluginWorkMs }
function _resetEtaStats() { _etaInFlight = null; }
async function _appendEtaLogEntry(entry) {
  try {
    const existing = await figma.clientStorage.getAsync(ETA_LOG_KEY);
    const list = Array.isArray(existing) ? existing.slice() : [];
    list.push(entry);
    while (list.length > MAX_ETA_LOG) list.shift();
    await figma.clientStorage.setAsync(ETA_LOG_KEY, list);
  } catch (e) { /* swallow — stats logging must never break a real review */ }
}

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
  // Only the START of a new review cycle clears any stale cancel flag.
  // begin_and_scan is mid-review (the AI may call it many times across
  // multiple frames). Clearing on begin_and_scan would defeat the Stop
  // button: a click between frames would be silently undone by the next
  // begin_and_scan call.
  "announce_review_start"
]);

// ── Full review protocol. Returned by get_preferences so any Claude ──
// ── session can run a review with zero external configuration.        ──
// ── Rule descriptions are injected dynamically — only enabled rules   ──
// ── appear in the instructions, so the AI is never confused by rules  ──
// ── that are toggled off.                                             ──

const RULE_DESCRIPTIONS = {
  components: `### components (smart)
Pre-computed offenders cover Check 1 (orphan raw layers), Check 2 (over-instancing), Check 3 (repeated siblings).

**Hard rule: never flag a node that lives inside a COMPONENT_SET.** Its children are variants by definition. If the root frame IS a COMPONENT_SET, return zero offenders.

---

**Check 1 roll-up (apply before passing through Check 1 results).**
The lint emits one offender per raw node — every TEXT, RECTANGLE, inner FRAME, etc. Most are internals of a single future component, not separate candidates. Collapse them:

1. Use the thumbnail to identify discrete UI regions (empty states, cards, list rows, toolbars, dialogs, etc.).
2. For each region, keep ONE offender — the outermost raw FRAME/GROUP that wraps it.
3. Drop everything that would become an internal once that wrapper is promoted:
   - Raw TEXT / VECTOR / RECTANGLE / ELLIPSE descendants of any kept offender.
   - Raw FRAME/GROUP descendants that are purely structural sub-layout of the same region (e.g. a Stack or inner column inside an Empty state container).
4. Keep a nested raw FRAME only when it represents a *separate* component-worthy region inside a generic shell — e.g. a Search row and a Filters row inside a generic "Page content" wrapper. The shell is not the component; the rows are. In that case drop the shell and keep the rows.

Rule of thumb: **one offender per future component.** If promoting node X absorbs node Y, drop Y.

Worked example — "Empty state" screen:
- Raw nodes: Empty state (FRAME) → Stack (FRAME) → "No recipes yet" (TEXT), "Click Add recipes…" (TEXT)
- Correct output: one offender — Stack (or Empty state if that's the discrete region).
- Wrong output: three offenders (Stack + both texts) — the texts are Stack's internals.

**Check 3 exception:** Drop any Check 3 offender where all flagged siblings are INSTANCE nodes sharing the same \`mainComponentId\`. Repeated instances of the same component is correct reuse, not a signal to extract anything.

---

ADD these from the thumbnail:

**Check 4 — Semantic-name structures.**
A raw FRAME/GROUP (NOT INSTANCE/COMPONENT) whose name (case-insensitive, partial match) contains any of: \`nav\`, \`navigation\`, \`header\`, \`footer\`, \`action bar\`, \`app bar\`, \`toolbar\`, \`tab bar\`, \`bottom sheet\`, \`sidebar\`, \`dialog\`, \`modal\`, \`card\`, \`list item\`, \`row\`, \`hero\`, \`banner\`. Skip Check 4 entirely if the root frame is itself a COMPONENT or COMPONENT_SET.

**Vision check — discrete UI regions.**
Enumerate every distinct visual region in the thumbnail (banners, search bars, filter rows, section containers, CTA blocks, list rows, cards, toolbars, etc.). For each, verify there's a corresponding INSTANCE node. If a region maps to a raw FRAME/GROUP, flag that node — INDEPENDENT of Check 1. An orphan parent does NOT absolve its visually-component-worthy children; do not skip children of flagged parents.

After all checks, dedup the final offender list by nodeId.

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
Pre-computed (offenders + \`suggestedTokens\`). Pass through, but apply one filter before including an offender:

**Drop any COMPONENT master flagged for width if it is a fill-parent component.** A fill-parent component (snackbar, app bar, banner, divider, full-width card, etc.) stretches to fill whatever container it is placed in — its pixel width on the canvas is a canvas-editing artefact, not a fixed design decision. Use the component name and thumbnail to judge:
- If the component clearly spans the full frame width with no breathing room on either side → fill-parent → drop the width offender.
- If the component has a self-contained fixed width (button, chip, avatar, icon, badge, FAB, dialog, bottom sheet with a fixed width) → fixed → keep the offender.
- When ambiguous, look at the thumbnail: does the component hug its content or span wall-to-wall?

Height offenders on COMPONENT masters follow the same logic: a full-height side drawer's height is not a design token candidate.

All other offenders (INSTANCE, FRAME) pass through unchanged.`,

  radius: `### radius
Pre-computed (offenders + \`suggestedTokens\`). Pass through unchanged. Each offender represents a node with one or more hardcoded corner radii; \`suggestedTokens\` may contain per-corner bindings.`,

  autolayout: `### auto layout
Pre-computed offenders cover the boolean "is this node auto-layout?" check. ADD from the thumbnail:
- **Pathological structure** — auto-layout that's technically present but useless (e.g. a single wrapper with 50 absolutely-positioned children).
- **Wrong direction** — HORIZONTAL where the layout reads VERTICAL (or vice versa); alignment that would break in code-gen; mismatched paddings between siblings that look broken.

**Never flag these — auto-layout adds no value and there's no reflow scenario:**
- INSTANCE nodes (auto-layout is inherited from the main component; can't be toggled locally).
- Icon / shape wrappers — frames whose only non-excluded child is a single VECTOR, BOOLEAN_OPERATION, RECTANGLE, ELLIPSE, POLYGON, STAR, or LINE. The wrapper has nothing to reflow.
- Decorative compositions (illustrations, vector groups not laid out) — use judgment.

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
- **Role mismatch — name should describe the layer's own role, not the parent's.** A child layer that duplicates its component / frame ancestor's name conveys nothing about what THAT layer is. Walk every TEXT / VECTOR / RECTANGLE / inner FRAME inside a COMPONENT or COMPONENT_SET and check: does the name describe this specific layer's role, or is it a copy of the wider component's name?
  - TEXT "Button" inside a Button component → flag; the role is \`Label\` (or \`Title\` / \`Text\`).
  - VECTOR "Avatar" inside an Avatar component → flag; the role is \`Image\` / \`Initials\` / \`Photo\`.
  - FRAME "Card" inside a Card component → flag; the role is \`Header\` / \`Body\` / \`Media\`.
  Always emit a \`suggestedName\` for these.
- **Meaningless on purposeful layers**: "Container 2", "Thing", "Stuff", "New", "Element" on layers with clear specific purpose.
- **Unambiguous typos**: "Hedaer" → "Header", "Naviagtion" → "Navigation". Only when the intended word is obvious.

Don't flag style choices (lowercase, hyphen, underscore) or valid-but-unusual names.

**suggestedName**: every naming offender carries a pre-computed \`suggestedName\` derived from the layer's structural content (TEXT content, single-shape children, autolayout direction). **Always look at the thumbnail before passing a suggestedName through.** The pre-computed value is structural — it describes layout shape, not purpose. Replace it with a semantic name (Product info, Book gallery, Thumbnail list, Search bar, Empty state) whenever the visual role is identifiable from the thumbnail. Pass through unchanged only when the layer truly has no identifiable semantic role.

**Anti-pattern — layout words are never acceptable final names:** "Stack", "Row", "Column", "Group", "Frame", "Container", "Wrapper", "Inner" describe structure, not purpose. If you are about to emit one of these as a suggestedName, look at the thumbnail harder and find the semantic role. There is almost always one.

When overriding, write a short, semantic name with no trailing punctuation. Never strip the field — if no \`suggestedName\` was pre-computed, write your own best guess.

**Variant property naming (COMPONENT_SET / COMPONENT only).** Each component-set carries a \`componentPropertyDefinitions\` object: \`{ "<displayName>": { type, variantOptions?, rawKey }, ... }\`. The deterministic lint already flags \`Property 1\` / \`Property 2\` / etc. (Figma defaults). Smart-mode work:

1. **Enrich every pre-flagged property offender with a \`suggestedName\`.** The deterministic offender carries \`propertyKey\` and \`detail\` but no name suggestion. Look at \`variantOptions\` and the thumbnail to infer the right semantic name — e.g., values \`Small/Big\` → \`Size\`; \`Light/Dark\` → \`Theme\`; \`Default/Hover/Pressed\` → \`State\`. If ambiguous, write your best concise guess. NEVER leave the field empty on a property offender — the UI uses it to render the rename button.

2. **ADD smart-mode offenders** for any property where the NAME or the VALUES aren't semantic:
- **Bad property names** (not caught by regex): \`Stuff\`, \`Type1\`, \`Variant\`, \`Group\`, \`Option\`, \`Text\` for non-text-content, single letters. Good: \`Size\`, \`State\`, \`Tone\`, \`Density\`, \`With color\`, \`Number\`.
- **Bad variant values**: \`a\` / \`b\`, \`v1\` / \`v2\`, \`default\` / \`variant2\`. Good: \`Small\` / \`Big\`, \`Yes\` / \`No\`, \`Primary\` / \`Secondary\` / \`Tertiary\`.
- **Name/value mismatch**: a property called \`Size\` whose values are \`Yes\` / \`No\` — the name doesn't describe what varies.

Each property offender shape (deterministic OR smart-mode) — push one offender on the COMPONENT_SET:
\`{ nodeId: <component-set-id>, name, detail: '...', propertyKey: <rawKey from componentPropertyDefinitions>, suggestedName: '<new semantic name>' }\`

The \`propertyKey\` is the rawKey from \`componentPropertyDefinitions[displayName].rawKey\` — it has a hash suffix Figma uses internally (e.g. \`"Property 1#5678:0"\`). The UI uses it to call \`editComponentProperty()\`. Without it the rename button won't appear.`
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
Task: Score Figma frames for AI Programmability (code-generation readiness).
${disabledNote}
## FLOW
0. announce_review_start → use returned \`selection.frames\` (skip get_selection).
1. get_preferences → read \`instructions\`. If \`designDoc.content\` non-null, use throughout.
2. For each frame i of N (1-based):
   a. announce_progress --step analyzing  (required before every scan)
   b. begin_and_scan --node-ids <id> --frame-index i --frame-count N
   c. Apply enabled rules. Compute score.
3. announce_progress --step submitting  (required before submit)
4. Write report JSON to temp file → submit_report --report-file <path>

Abort on \`{cancelled: true}\` with "Review cancelled."
Warn user if \`selection.capped\` (only first 10 frames reviewed).

## SCOPING (all rules)
- \`ignored: true\` → exclude node and entire subtree.
- INSTANCE: evaluate node itself only; not descendants.
- Root frame: exempt from components rule; evaluated by all others.
- Off-screen: scored; mention in detail.
- Scrollable / overflow: not an issue.
- Repeated INSTANCE siblings of same component: correct reuse, never flag.
- COMPONENT_SET: skipped by colors, spacing, padding, autolayout, effects, radius, size.

## DESIGN SYSTEM HEALTH CHECK
If \`designSystem.numberVariables\` is still empty after the scan (the plugin already retried once automatically), note in the report that token suggestions are unavailable for this frame — likely the token library is not selected in the plugin settings — and continue.

## PRE-COMPUTED LINT RESULTS
The scan response includes \`lintResults\` — deterministic offenders + token suggestions, computed server-side.

**Accept as final (no re-analysis):** colors, typography, spacing, padding, size, effects, naming (Check 1 regex), components (Checks 1-3), autolayout (presence check). Copy these offenders into the report unchanged — including any \`suggestedTokens\`, \`zeroActions\`, or \`suggestedName\` fields. They're already correct. Do NOT re-walk the tree for these — wastes time, identical results.

**Pre-computed \`informational\` arrays** (instance-only issues): each rule in lintResults may carry an \`informational\` array containing instance issues whose fix lives on the master component (the user can't fix them on the instance). Copy these to the rule's \`informational\` field in the report verbatim. They DO count toward the score — \`_offenderCount\` and \`_totalChecked\` already include them. Each instance counts independently (no master-level dedup). The UI renders them in a separate "Instances with issues" section with no fix actions, but they still affect the score because a screen built from broken components really is broken. Never move an entry between \`offenders\` and \`informational\`; the lint already classified them.

**Critical — \`suggestedName\` on naming offenders is REQUIRED**: every naming offender in \`lintResults\` already has a pre-computed \`suggestedName\`. You MUST preserve it in the report. The UI renders the "Rename to" button from this field — a naming offender without \`suggestedName\` shows no action button. If \`lintResults\` has the field, copy it exactly. If you are adding a new Check 2 offender that \`lintResults\` didn't pre-compute, write your own best-guess semantic name. Never emit a naming offender with \`suggestedName\` absent or set to \`null\`.

**Critical — \`suggestedTokens\` format**: the field is an array of OBJECTS, not strings. Each entry has the shape \`{ id, name, kind, slot, value?, reason? }\`. NEVER replace these objects with bare strings (\`["spacing-xl"]\` is wrong — the UI renders \`.name\` and would show "undefined"). Copy the entries verbatim as you received them in \`lintResults\`.

**Augment with vision** (use the thumbnail):
- naming: ADD semantic-accuracy + typo offenders (Check 2).
- components: ADD Check 4 (semantic-name structures) + Vision check (discrete UI regions).
- autolayout: ADD quality offenders (pathological structure, wrong direction).

**Saturation mode — read this first.** If \`lintResults.saturated\` is \`true\`, the frame has more than 50 pre-computed offenders. The lint has already capped each rule to its top 7 actionable issues; the rest are elided. In this mode:
- **Skip ALL vision augmentation** — no Check 2 naming, no Check 4 components, no autolayout quality vision, no suggestedName enrichment. The capped offenders are enough; finding 5 more issues won't change the verdict. Pass pre-computed suggestedName values through unchanged.
- Copy the capped offenders into the report unchanged.
- The UI shows a banner with the original counts (\`originalOffenderCounts\`) automatically; you do NOT need to enumerate elided offenders in your prose.
- Keep your message short: name the worst 2-3 rules by count, recommend fixing the highlighted issues, and note that re-running after fixes will surface the next batch.

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
- **Saturation override**: if \`lintResults.saturated\` is \`true\`, set \`final_score = 0\` regardless of the proportional calculation (individual rule scores remain proportional — only the top-level \`final_score\` is overridden to 0). A frame with 50+ unresolved issues is in crisis — a proportional score makes it look "decent" when it isn't.
- A rule with zero nodes to check scores 100.

Strict consistency: a rule scores 100 if and only if both \`offenders\` and \`informational\` are empty (offenderCount = 0). < 100 requires offenders listed. "Feels like a small deduction" is invalid.

## REPORT FORMAT
submit_report expects:
\`\`\`
{
  frames: [{
    nodeId, name, score, perfect,
    saturated,                 // copy from lintResults.saturated (default false)
    originalOffenderCounts,    // copy from lintResults.originalOffenderCounts (only when saturated)
    breakdown: {
      <ruleName>: {
        enabled, passed,
        offenders:    [{ nodeId, name, detail, suggestedTokens?, suggestedName?, ... }] (max 30),
        informational: [{ nodeId, name, rule, detail }] (max 30, instance-only, no fix actions in UI; DO count toward the score via _offenderCount)
      }
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
- **No \`tooltip\` field needed** on offenders. The UI looks up a per-rule tooltip by rule key. The detail string already carries any dynamic context (specific values, sides affected). Don't write tooltips — they will be discarded.
- After submitting, briefly summarize to the user: score, rules passed/failed, top issues.

## DO NOT GROUP OFFENDERS
Each affected node must be its OWN entry in the offenders array, even when many nodes share the same rule + detail (e.g. 7 instances of the same padding issue → 7 entries, not 1). The user needs every nodeId to select / highlight / fix each instance individually. Never collapse with \`groupedCount\` or any similar shorthand — the UI does not render such fields and grouped entries silently drop the other nodes.

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
        const scale = node.width > 0 ? Math.min(1.0, 160 / node.width) : 1.0;
        const bytes = await node.exportAsync({ format: "JPG", constraint: { type: "SCALE", value: scale } });
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
      // Cancelled reviews don't get logged — drop any in-flight timer so a
      // later announce_review_start starts fresh and we never accidentally
      // attribute the AI's give-up time to the next review.
      if (cancelled) _resetEtaStats();
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
      // Also surface localEnabled so the UI can reflect the synthetic
      // "Local" row's checkbox state without a separate fetch.
      try {
        const libs = await listAvailableLibraries();
        const selected = await getSelectedTokenLibraries();
        const localEnabled = await getLocalVariablesEnabled();
        figma.ui.postMessage({ type: "libraries-result", libraries: libs, selected, localEnabled });
      } catch (e) {
        console.warn("[figma-ai-score] get-libraries failed:", e && e.message);
        figma.ui.postMessage({ type: "libraries-result", libraries: [], selected: [], localEnabled: true });
      }
      return;
    }
    if (msg.type === "set-token-libraries") {
      try {
        const libraries = Array.isArray(msg.libraries) ? msg.libraries.filter(s => typeof s === "string") : [];
        await figma.clientStorage.setAsync("figma-ai-score.token-libraries", libraries);
        _invalidateDesignSystemCache();
      } catch (e) {
        console.warn("[figma-ai-score] couldn't persist token libraries:", e && e.message);
      }
      return;
    }
    if (msg.type === "set-local-variables-enabled") {
      // Toggles the synthetic "Local" row in the Token-libraries panel.
      // Invalidate the DS cache so the next review re-extracts (or skips)
      // local variables according to the new flag.
      try {
        await setLocalVariablesEnabled(!!msg.enabled);
        _invalidateDesignSystemCache();
      } catch (e) {
        console.warn("[figma-ai-score] couldn't persist local-variables-enabled:", e && e.message);
      }
      return;
    }
    if (msg.type === "get-token-categories") {
      // Reply-once guard: belt-and-suspenders so the UI ALWAYS gets a
      // response no matter what code path errors below. Without this, a
      // synchronous throw before postMessage would leave the UI stuck on
      // its loading spinner.
      let _replied = false;
      // Echo reqId so the UI can drop stale results when concurrent
      // requests overlap (open-Libraries vs libraries-result-arrives).
      const reqId = typeof msg.reqId === "number" ? msg.reqId : null;
      const reply = (collections, partialError) => {
        if (_replied) return;
        _replied = true;
        try {
          figma.ui.postMessage({ type: "token-categories-result", reqId, collections, partialError: partialError || null });
        } catch (e) {
          console.warn("[figma-ai-score] token-categories postMessage failed:", e && e.message);
        }
      };
      try {
        const { buckets, errors } = await listTokenCollectionsLight();
        const overrides = await getTokenCategoryOverrides();
        const collections = buckets.map(b => ({
          key: b.key,
          collectionName: b.collectionName,
          libraryName: b.libraryName,
          tokenCount: b.tokens.length,
          autoCategories: autoDetectCollectionCategories(b.tokens),
          override: Array.isArray(overrides[b.key]) ? overrides[b.key] : null
        }));
        collections.sort((a, b) => {
          const aLib = a.libraryName || "";
          const bLib = b.libraryName || "";
          if (aLib !== bLib) return aLib.localeCompare(bLib);
          return a.collectionName.localeCompare(b.collectionName);
        });
        reply(collections, errors && errors.length ? errors[0] : null);
      } catch (e) {
        console.warn("[figma-ai-score] get-token-categories unexpected failure:", e && e.message);
        reply([], (e && e.message) || "unexpected error");
      }
      return;
    }
    if (msg.type === "set-token-category") {
      // categories: array of category strings, OR null/undefined to clear
      // the override (back to auto-detection).
      try {
        if (typeof msg.key === "string") {
          const value = (msg.categories === null || msg.categories === undefined)
            ? null
            : msg.categories;
          await setTokenCategoryOverride(msg.key, value);
        }
      } catch (e) {
        console.warn("[figma-ai-score] set-token-category failed:", e && e.message);
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
        const result = lintFrame(tree, lintRules, ds, { mode: "simple" });
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
        // Throw on bad inputs so the UI's "Renaming…" button doesn't get
        // stuck waiting for a rename-done that will never come.
        if (!node) throw new Error("node not found");
        if (typeof msg.newName !== "string" || !msg.newName.trim()) {
          throw new Error("newName missing or empty");
        }
        node.name = msg.newName;
        figma.ui.postMessage({ type: "rename-done", nodeId: msg.nodeId, newName: msg.newName });
      } catch (e) {
        figma.ui.postMessage({ type: "rename-failed", nodeId: msg.nodeId, error: String(e && e.message || e) });
      }
      return;
    }
    if (msg.type === "rename-component-property") {
      // Rename a variant/component property on a COMPONENT_SET or COMPONENT.
      // The Figma API for this is editComponentProperty(rawKey, { name }),
      // NOT setting `node.name`. The rawKey carries the hash suffix Figma
      // uses internally (e.g. "Property 1#5678:0").
      try {
        let node = null;
        if (typeof figma.getNodeByIdAsync === "function") {
          try { node = await figma.getNodeByIdAsync(msg.nodeId); } catch (e) {}
        }
        if (!node) node = figma.getNodeById(msg.nodeId);
        if (!node) throw new Error("node not found");
        if (typeof node.editComponentProperty !== "function") {
          throw new Error("node does not support editComponentProperty");
        }
        if (typeof msg.propertyKey !== "string" || !msg.propertyKey) throw new Error("propertyKey missing");
        if (typeof msg.newName !== "string" || !msg.newName.trim()) throw new Error("newName missing");
        node.editComponentProperty(msg.propertyKey, { name: msg.newName });
        figma.ui.postMessage({
          type: "rename-component-property-done",
          nodeId: msg.nodeId,
          oldPropertyKey: msg.propertyKey,
          newName: msg.newName,
        });
      } catch (e) {
        figma.ui.postMessage({
          type: "rename-component-property-failed",
          nodeId: msg.nodeId,
          propertyKey: msg.propertyKey,
          error: String(e && e.message || e)
        });
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
          "itemSpacing", "width", "height",
          "cornerRadius", "topLeftRadius", "topRightRadius", "bottomLeftRadius", "bottomRightRadius"
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
      // Zero out one or more layout dimensional props. Used to clean up:
      //   • padding on fixed-axis frames (no visual effect in code output)
      //   • itemSpacing on single-child auto-layout (no siblings to space)
      // Despite the name, this handler accepts itemSpacing too — the
      // event name kept "zero-padding" for backwards compat.
      try {
        const { nodeId, props } = msg;
        if (!Array.isArray(props) || !props.length) return;
        let node = null;
        if (typeof figma.getNodeByIdAsync === "function") {
          try { node = await figma.getNodeByIdAsync(nodeId); } catch (e) {}
        }
        if (!node) node = figma.getNodeById(nodeId);
        if (!node) throw new Error("node not found");
        const ALLOWED = new Set([
          "paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
          "itemSpacing",
        ]);
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
      // Start ETA-vs-actual timing for this review. If a previous timer is
      // still in flight (e.g. the AI errored mid-review without cancelling),
      // drop it — only completed reviews end up in the log.
      _resetEtaStats();
      // Skip timing entirely if the selection is empty — the AI bails
      // immediately and there's no real review to measure.
      if (selSummary.frames.length > 0) {
        let _etaTotalNodes = 0;
        try {
          for (const f of selSummary.frames) {
            const n = figma.getNodeById(f.id);
            if (n) _etaTotalNodes += shallowCountNodes(n);
          }
        } catch (e) {}
        _etaInFlight = {
          startedAt: Date.now(),
          etaSeconds: estimateEtaSecondsRaw(_etaTotalNodes),
          frames: selSummary.frames.length,
          totalNodes: _etaTotalNodes,
          mode: "smart",
          pluginWorkMs: 0,
        };
      }
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
      const _scanStartedAt = Date.now();
      const _phaseTimings = {};
      const _markPhase = (label, t0) => { _phaseTimings[label] = Date.now() - t0; };
      // Quiet mode: caller is inspecting (not running a user-facing review).
      // Skip lock state, banner, and progress messages so the plugin UI
      // doesn't flip into "Reviewing…" for what's really a backend probe.
      // Scan output is unchanged.
      const quiet = params.quiet === true;
      // Lock phase
      const ids = Array.isArray(params.nodeIds) ? params.nodeIds : [];
      // NB: do NOT clear `cancelled` here. begin_and_scan runs mid-review;
      // a Stop click between frames must persist so subsequent begin_and_scan
      // calls short-circuit. The flag is cleared only on announce_review_start.
      const names = ids.map(id => {
        const n = figma.getNodeById(id);
        return n ? n.name : "(missing)";
      });
      if (!quiet) {
        locked = true;
        lockedIds = ids;
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
      }

      // Scan phase: extract tree, export thumbnail, lint.
      const scanNodeId = ids[0];
      if (!scanNodeId) return { locked: !quiet, ok: true, count: ids.length };
      let node = null;
      try {
        if (typeof figma.getNodeByIdAsync === "function") node = await figma.getNodeByIdAsync(scanNodeId);
      } catch (e) {}
      if (!node) node = figma.getNodeById(scanNodeId);
      if (!node) return { locked: !quiet, error: "node not found: " + scanNodeId };
      const _t0Extract = Date.now();
      const tree = extractNode(node);
      _markPhase("extract", _t0Extract);
      // Design system + lint run BEFORE thumbnail export so we can skip the
      // export entirely for saturated frames (vision is skipped for those).
      let designSystem = null;
      const _t0Ds = Date.now();
      try { designSystem = await getDesignSystem(); } catch (e) {}
      // If the first call threw (library API timeout or permission error),
      // retry once. Do NOT retry a valid-but-empty result — it's already
      // cached and a second call returns the same empty value instantly.
      if (!designSystem) {
        try { designSystem = await getDesignSystem(); } catch (e) {}
      }
      _markPhase("designSystem", _t0Ds);
      if (designSystem && Array.isArray(designSystem.variables) && designSystem.variables.length) {
        const frameHexes = extractFrameHexColors(tree);
        designSystem.variables = designSystem.variables.filter(v => v.color && frameHexes.has(v.color));
      }
      let lintResults = null;
      const _t0Lint = Date.now();
      try { lintResults = lintFrame(tree, prefs, designSystem, { keepInternalFields: true, mode: "ai" }); } catch (e) {}
      _markPhase("lint", _t0Lint);
      // Skip thumbnail export for saturated frames — vision augmentation is
      // skipped for those anyway, so the image would never be used.
      // For non-saturated frames, use a dynamic scale constraint: cap width at
      // 320px but never upscale (small components export at their native size).
      let thumbnail = null;
      let thumbError = null;
      const _t0Thumb = Date.now();
      if (!(lintResults && lintResults.saturated)) {
        try {
          if (typeof node.exportAsync === "function") {
            const scale = node.width > 0 ? Math.min(1.0, 320 / node.width) : 1.0;
            const bytes = await node.exportAsync({ format: "JPG", constraint: { type: "SCALE", value: scale } });
            thumbnail = bytesToBase64(bytes);
          }
        } catch (e) { thumbError = String(e && e.message || e); }
      }
      _markPhase("thumbnail", _t0Thumb);
      const nodeStats = computeNodeStats(tree);
      if (!quiet) {
        figma.ui.postMessage({ type: "eta-update", eta: estimateEta(nodeStats.total) });
        // Accumulate plugin-side work for ETA stats. Skip in quiet mode —
        // inspection calls would pollute the ETA dataset with non-review work.
        if (_etaInFlight) {
          _etaInFlight.pluginWorkMs += Date.now() - _scanStartedAt;
          _etaInFlight.phaseTimings = _phaseTimings;
        }
      }
      // Phase timings are surfaced in eta-stats entries — no console noise.
      // Slim the tree before sending: every per-node field consumed only by
      // the (already-completed) lint pass — fills/strokes/effects/styleIds/
      // boundTypography/sizeBound/radii/autolayout.bound — is dropped.
      // Cuts the AI-bound payload by ~50-70% on typical screens.
      const slimTree = slimTreeForAI(tree);
      return {
        locked: !quiet,
        fileName: figma.root.name,
        pageName: figma.currentPage.name,
        root: { id: node.id, name: node.name, type: node.type },
        tree: slimTree,
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
      const rpt = params.report;
      if (!rpt || !Array.isArray(rpt.frames) || rpt.frames.length === 0) {
        return { ok: false, error: "Invalid report format: expected { frames: [...] }. Check that the report JSON matches the schema in get_preferences instructions." };
      }
      for (let i = 0; i < rpt.frames.length; i++) {
        const f = rpt.frames[i];
        if (!f.nodeId) return { ok: false, error: "frames[" + i + "] is missing nodeId." };
        if (typeof f.score !== "number") return { ok: false, error: "frames[" + i + "] is missing a numeric score." };
        if (!f.breakdown || typeof f.breakdown !== "object" || Object.keys(f.breakdown).length === 0) {
          return { ok: false, error: "frames[" + i + "] is missing breakdown. The report must include a breakdown object with per-rule results (offenders, informational, passed, enabled). See the schema in get_preferences instructions." };
        }
      }
      figma.ui.postMessage({ type: "ai-progress", message: "Submitting report…" });
      figma.ui.postMessage({ type: "analyzing-done" });
      figma.ui.postMessage({ type: "report", data: rpt });
      locked = false;
      lockedIds = [];
      // Finalize ETA stats for this review.
      if (_etaInFlight) {
        const actualMs = Date.now() - _etaInFlight.startedAt;
        _appendEtaLogEntry({
          ts:            new Date().toISOString(),
          mode:          _etaInFlight.mode,
          frames:        _etaInFlight.frames,
          totalNodes:    _etaInFlight.totalNodes,
          etaSeconds:    _etaInFlight.etaSeconds,
          actualMs,
          pluginWorkMs:  _etaInFlight.pluginWorkMs,
          aiThinkingMs:  Math.max(0, actualMs - _etaInFlight.pluginWorkMs),
          phaseTimings:  _etaInFlight.phaseTimings || null,
          cancelled:     false,
        });
        _resetEtaStats();
      }
      return { ok: true };
    }
    case "dismiss_review": {
      // Called by the AI when it cannot proceed (e.g. no frames selected).
      // Dismisses the reviewing overlay without submitting a report.
      locked = false;
      lockedIds = [];
      cancelled = false;
      figma.ui.postMessage({ type: "unlocked" });
      // Reset ETA timing so the next review starts fresh. Don't log this as
      // an entry — pre-flight bails (no frames selected) shouldn't pollute
      // the dataset.
      _resetEtaStats();
      return { ok: true };
    }
    case "get_eta_stats": {
      // Internal tuning instrument — dumps the captured log of estimated
      // vs actual review durations. Surfaced by the `eta-stats` CLI
      // subcommand. Not a user feature.
      let log = [];
      try { log = (await figma.clientStorage.getAsync(ETA_LOG_KEY)) || []; } catch (e) {}
      // Compute headline stats so the dump is immediately useful.
      const completed = log.filter(e => !e.cancelled && typeof e.etaSeconds === "number");
      const summary = (() => {
        if (!completed.length) return null;
        const ratios = completed.map(e => (e.actualMs / 1000) / e.etaSeconds);
        const avg = ratios.reduce((a, b) => a + b, 0) / ratios.length;
        const sorted = ratios.slice().sort((a, b) => a - b);
        const median = sorted[Math.floor(sorted.length / 2)];
        const aiShare = completed.reduce((a, e) => a + (e.aiThinkingMs / e.actualMs), 0) / completed.length;
        return {
          n: completed.length,
          avgActualOverEta: Number(avg.toFixed(2)),
          medianActualOverEta: Number(median.toFixed(2)),
          avgAiShareOfActual: Number(aiShare.toFixed(2)),
        };
      })();
      return { entries: log, summary };
    }
    case "clear_eta_stats": {
      // Wipe the log — for when you want a fresh dataset.
      try { await figma.clientStorage.deleteAsync(ETA_LOG_KEY); } catch (e) {}
      return { ok: true };
    }
    case "create_swatch_frame": {
      // Build a reference swatch sheet from a flat array of design tokens.
      // Each token: { group, name, hex, alpha?, alias? }. Tokens are grouped
      // by `group` (first-occurrence order preserved). The frame is placed at
      // the current viewport center on the current page (or the named page
      // when `pageName` is provided), with each token rendered as a row:
      // colored swatch + token name + hex + alias arrow. Pure auto-layout.
      const tokens = params.tokens;
      if (!Array.isArray(tokens) || !tokens.length) {
        throw new Error("tokens must be a non-empty array of {group, name, hex, alpha?, alias?}");
      }
      const title = (typeof params.title === "string" && params.title) ? params.title : "Semantic tokens";
      if (params.pageName) {
        const page = figma.root.children.find(p => p.name === params.pageName || p.id === params.pageName);
        if (!page) throw new Error("Page not found: " + params.pageName);
        if (typeof figma.setCurrentPageAsync === "function") await figma.setCurrentPageAsync(page);
      }
      // Font load: prefer Inter, fall back to Roboto.
      let fontFamily = "Inter";
      let boldStyle = "Semi Bold";
      try {
        await figma.loadFontAsync({ family: "Inter", style: "Regular" });
        await figma.loadFontAsync({ family: "Inter", style: "Semi Bold" });
      } catch (e) {
        fontFamily = "Roboto";
        boldStyle = "Medium";
        await figma.loadFontAsync({ family: "Roboto", style: "Regular" });
        await figma.loadFontAsync({ family: "Roboto", style: "Medium" });
      }
      function hexToRgb(hex) {
        const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex || "");
        if (!m) return { r: 0.5, g: 0.5, b: 0.5 };
        return { r: parseInt(m[1], 16) / 255, g: parseInt(m[2], 16) / 255, b: parseInt(m[3], 16) / 255 };
      }
      function makeText(content, size, weight) {
        const t = figma.createText();
        t.fontName = { family: fontFamily, style: weight === "bold" ? boldStyle : "Regular" };
        t.characters = String(content);
        t.fontSize = size;
        return t;
      }
      // Group by `group` field; first-occurrence order.
      const groups = {}; const order = [];
      for (const tok of tokens) {
        const g = tok.group || "Tokens";
        if (!groups[g]) { groups[g] = []; order.push(g); }
        groups[g].push(tok);
      }
      const root = figma.createFrame();
      root.name = title;
      root.layoutMode = "VERTICAL";
      root.primaryAxisSizingMode = "AUTO";
      root.counterAxisSizingMode = "FIXED";
      root.resize(640, root.height);
      root.itemSpacing = 32;
      root.paddingTop = 40; root.paddingBottom = 40; root.paddingLeft = 40; root.paddingRight = 40;
      root.fills = [{ type: "SOLID", color: { r: 1, g: 1, b: 1 } }];
      root.cornerRadius = 16;
      root.strokes = [{ type: "SOLID", color: { r: 0.9, g: 0.9, b: 0.9 } }];
      root.strokeWeight = 1;

      const titleText = makeText(title, 24, "bold");
      titleText.layoutAlign = "STRETCH";
      root.appendChild(titleText);
      const subtitle = makeText(tokens.length + " tokens across " + order.length + " group" + (order.length === 1 ? "" : "s"), 12, "regular");
      subtitle.fills = [{ type: "SOLID", color: { r: 0.45, g: 0.45, b: 0.47 } }];
      subtitle.layoutAlign = "STRETCH";
      root.appendChild(subtitle);

      for (const groupName of order) {
        const section = figma.createFrame();
        section.name = groupName;
        section.layoutMode = "VERTICAL";
        section.primaryAxisSizingMode = "AUTO";
        section.counterAxisSizingMode = "FIXED";
        section.layoutAlign = "STRETCH";
        section.itemSpacing = 8;
        section.paddingTop = 12; section.paddingBottom = 12;
        section.fills = [];

        const header = makeText(groupName, 14, "bold");
        header.layoutAlign = "STRETCH";
        section.appendChild(header);

        for (const tok of groups[groupName]) {
          const row = figma.createFrame();
          row.name = tok.name || "(unnamed)";
          row.layoutMode = "HORIZONTAL";
          row.primaryAxisSizingMode = "FIXED";
          row.counterAxisSizingMode = "AUTO";
          row.layoutAlign = "STRETCH";
          row.counterAxisAlignItems = "CENTER";
          row.itemSpacing = 12;
          row.paddingTop = 8; row.paddingBottom = 8; row.paddingLeft = 8; row.paddingRight = 12;
          row.cornerRadius = 8;
          row.fills = [{ type: "SOLID", color: { r: 0.98, g: 0.98, b: 0.98 } }];

          const swatch = figma.createRectangle();
          swatch.resize(40, 40);
          swatch.cornerRadius = 6;
          swatch.fills = [{
            type: "SOLID",
            color: hexToRgb(tok.hex),
            opacity: typeof tok.alpha === "number" ? tok.alpha : 1
          }];
          swatch.strokes = [{ type: "SOLID", color: { r: 0.85, g: 0.85, b: 0.87 } }];
          swatch.strokeWeight = 1;
          row.appendChild(swatch);

          const meta = figma.createFrame();
          meta.layoutMode = "VERTICAL";
          meta.primaryAxisSizingMode = "AUTO";
          meta.counterAxisSizingMode = "AUTO";
          meta.layoutGrow = 1;
          meta.itemSpacing = 2;
          meta.fills = [];

          const nameText = makeText(tok.name || "(unnamed)", 12, "bold");
          meta.appendChild(nameText);

          const parts = [];
          if (tok.hex) parts.push(tok.alpha != null && tok.alpha !== 1 ? tok.hex + " · " + Math.round(tok.alpha * 100) + "%" : tok.hex);
          if (tok.alias) parts.push("→ " + tok.alias);
          if (parts.length) {
            const detail = makeText(parts.join("   "), 10, "regular");
            detail.fills = [{ type: "SOLID", color: { r: 0.45, g: 0.45, b: 0.47 } }];
            meta.appendChild(detail);
          }
          row.appendChild(meta);
          section.appendChild(row);
        }
        root.appendChild(section);
      }

      // Park at viewport center; select + zoom.
      const vp = figma.viewport.center;
      root.x = Math.round(vp.x - root.width / 2);
      root.y = Math.round(vp.y - root.height / 2);
      figma.currentPage.appendChild(root);
      figma.currentPage.selection = [root];
      figma.viewport.scrollAndZoomIntoView([root]);
      return {
        ok: true,
        nodeId: root.id,
        page: figma.currentPage.name,
        groups: order,
        totalTokens: tokens.length,
      };
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
// Raw ETA in seconds (for logging — see _etaStats below). Same formula as
// Piecewise ETA model — fit against measured data after the saturation cap
// landed (which capped the 400+ node worst case from ~13min to ~5min).
//
//   0-50   nodes: ~55s flat (AI startup + a tiny vision pass)
//   50-200 nodes: 55s + 0.4s/node beyond 50
//   200+   nodes: 115s + 0.85s/node beyond 200 (output dominates here, but
//                                                saturation caps it at ~50)
//
// Anchors:
//   3 nodes  → 55s  (measured ~51s)
//   105      → 77s  (measured ~63s)
//   423      → 305s (measured ~296s)
function estimateEtaSecondsRaw(totalNodes) {
  if (!totalNodes) return null;
  if (totalNodes <= 50) return 55;
  if (totalNodes <= 200) return 55 + Math.round((totalNodes - 50) * 0.4);
  return 115 + Math.round((totalNodes - 200) * 0.85);
}
function estimateEta(totalNodes) {
  const raw = estimateEtaSecondsRaw(totalNodes);
  if (raw == null) return null;
  const secs = Math.ceil(raw / 30) * 30; // round up to multiple of 30
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
    // Skip COMPONENT_SET — its children are variants of one component by
    // definition, so identical structure is the correct, intended pattern,
    // not duplication. Flagging them would tell users to "extract a shared
    // component" out of the variants of a component, which is nonsense.
    if (node.type === "COMPONENT_SET") return;
    const groups = new Map();
    for (const c of node.children) {
      if (isExcluded(c)) continue;
      const sig = structSig(c);
      if (!groups.has(sig)) groups.set(sig, []);
      groups.get(sig).push(c);
    }
    for (const kids of groups.values()) {
      if (kids.length < 3) continue;
      for (let i = 1; i < kids.length; i++) {
        // Skip INSTANCE siblings — they're already instances of a shared
        // component by definition. "Extract a shared component" makes no
        // sense as a suggestion on an instance, regardless of whether the
        // 3 siblings share one master or three different masters (the latter
        // would be a component-consolidation problem, not a layer-extraction
        // one — different message, not this rule).
        if (isInstance(kids[i])) continue;
        addOffense(kids[i], "repeated", `Sibling ${i + 1} of ${kids.length} with matching structure — extract a shared component.`);
      }
    }
  });

  // Check 3b: name-based duplicate siblings.
  // Three or more direct sibling raw FRAMEs/GROUPs sharing a name almost
  // always mean "this should be a separate component" — even when their
  // internal structures differ slightly (e.g. one variant has an extra
  // inline indicator). Catches cases Check 3 misses due to structSig
  // sensitivity. Naming intent is a stronger signal than exact structure.
  walkDesignerNodes(root, (node) => {
    if (!node.children || node.children.length < 3) return;
    if (node.type === "COMPONENT_SET") return; // variants share names by design
    const byName = new Map();
    for (const c of node.children) {
      if (isExcluded(c)) continue;
      // Raw layers only — INSTANCE is already shared; COMPONENT/COMPONENT_SET
      // shouldn't be wrapped again.
      if (isComponentContainer(c)) continue;
      if (c.type !== "FRAME" && c.type !== "GROUP") continue;
      const name = (c.name || "").trim();
      if (!name) continue;
      if (!byName.has(name)) byName.set(name, []);
      byName.get(name).push(c);
    }
    for (const [name, kids] of byName.entries()) {
      if (kids.length < 3) continue;
      for (let i = 1; i < kids.length; i++) {
        addOffense(kids[i], "repeated", `Sibling ${i + 1} of ${kids.length} named "${name}" — extract a shared component.`);
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
  // Instance-only issues. Surfaced read-only at the bottom of the report
  // ("Instances with issues — not affecting the score"). No suggestedTokens
  // / zeroActions because fixing on the instance creates an override; the
  // real fix lives on the master component.
  const informational = [];
  let totalChecked = 0;
  const hasDs = ds && ((ds.variables || []).length > 0 || (ds.paintStyles || []).length > 0);
  walkDesignerNodes(root, (node) => {
    // COMPONENT_SET is a canvas-only variant container — it never renders in
    // code. Its purple dotted outline is a Figma affordance, not a real style.
    // Skip fills and strokes entirely.
    if (node.type === "COMPONENT_SET") return;
    const isInst = isInstance(node);
    // Only SOLID fills can be tokenized. Image/video/gradient fills are skipped
    // (they don't carry color tokens). A layer with only an image fill and no
    // SOLID fill produces nothing to check.
    for (const f of (node.fills || [])) {
      if (f.type !== "SOLID" || f.visible === false) continue;
      totalChecked++;
      if (!f.boundVariable && !node.fillStyleId) {
        if (isInst) {
          informational.push({
            nodeId: node.id,
            name: node.name,
            rule: "colors",
            detail: `Fill does not use a token or style.`,
          });
          continue;
        }
        const o = {
          nodeId: node.id,
          name: node.name,
          detail: `Fill does not use a token or style.`,
        };
        // Suggest token(s) for exact color matches. When multiple tokens share
        // the same value, rank by semantic fit and show the top 3 — Simple mode
        // displays these as pick buttons. All candidates are stored in
        // _allTokenCandidates so AI mode can make a more informed single choice.
        if (hasDs && !node.hasMultipleFills) {
          // Filter by scope: only tokens whose scopes match this node's fill
          // slot (TEXT_FILL for text, FRAME_FILL for frames/components,
          // SHAPE_FILL for shapes) are eligible. ALL_FILLS and ALL_SCOPES
          // are universal. Stops "Surface" being suggested for an icon stroke,
          // or "on-primary" for a card background.
          const all = findTokensByColor(ds, f.color, { slot: "fill", nodeType: node.type });
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
        if (isInst) {
          informational.push({
            nodeId: node.id,
            name: node.name,
            rule: "colors",
            detail: `Stroke does not use a token or style.`,
          });
          continue;
        }
        const o = {
          nodeId: node.id,
          name: node.name,
          detail: `Stroke does not use a token or style.`,
        };
        if (hasDs && !node.hasMultipleStrokes) {
          const all = findTokensByColor(ds, s.color, { slot: "stroke", nodeType: node.type });
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
  // Instance issues (informational) DO count toward the score now — the
  // user's reasoning: a broken master used 20 times across a screen really
  // does break the screen 20 times, regardless of where the fix lives.
  // _offenderCount = offenders + informational so the rule_score formula
  // ((total - offenders) / total) sees the full picture.
  return {
    enabled: true,
    passed: offenders.length === 0 && informational.length === 0,
    offenders: offenders.slice(0, 30),
    informational: informational.slice(0, 30),
    _totalChecked: totalChecked,
    _offenderCount: offenders.length + informational.length
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
  const filtered = filterDimensionTokensForRule(ds.numberVariables, rule, ds.categoryOverrides);
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
  const informational = [];
  let totalChecked = 0;
  walkDesignerNodes(root, (node, _isRoot, ancestors) => {
    if (!node.autolayout) return;
    // COMPONENT_SET padding/spacing is canvas-only variant arrangement — not code output.
    if (node.type === "COMPONENT_SET") return;
    // COMPONENT children of a COMPONENT_SET are variants — exempt them only when
    // the COMPONENT_SET is NESTED inside a larger design (canvas noise). When the
    // user selects the COMPONENT_SET directly as the scan root, they are auditing
    // the design system itself, so variants ARE checked.
    const parent = ancestors[ancestors.length - 1];
    if (node.type === "COMPONENT" && parent && parent.type === "COMPONENT_SET" && ancestors.length > 1) return;
    const al = node.autolayout;
    const b = al.bound || {};
    // "Auto" gap = SPACE_BETWEEN mode — algorithmically distributed, no fixed value to tokenize.
    if (al.primaryAxisAlignItems === "SPACE_BETWEEN") return;
    const val = al.itemSpacing;
    if (val === 0 || val === null || val === undefined) return; // zero is fine
    const isInst = isInstance(node);
    totalChecked++;
    if (b.itemSpacing) return; // already bound
    if (isInst) {
      // Instance: surface read-only. Don't include the single-child-noise
      // case here — extractNode doesn't expand instance children so we
      // can't reliably tell, and even if we could, the cleanup belongs on
      // the master.
      informational.push({
        nodeId: node.id,
        name: node.name,
        rule: "spacing",
        detail: `itemSpacing ${val}px is not using a spacing token.`,
      });
      return;
    }
    // Single-child noise check: a non-zero gap on an auto-layout frame with
    // only one child has no visual effect (gap is between siblings) — flag
    // it for cleanup. Critical: only fire this when we can actually count
    // children. extractNode() does NOT populate `children` on INSTANCE
    // nodes (library internals are intentionally not expanded) and stops
    // expansion at maxDepth — so `node.children === undefined` means
    // "unknown count," which we must not treat as zero. Without this guard
    // every auto-layout INSTANCE got falsely flagged as single-child.
    if (Array.isArray(node.children) && node.children.length < 2) {
      offenders.push({
        nodeId: node.id,
        name: node.name,
        detail: `Gap value has no effect — only one child.`,
        zeroActions: [{ label: "Clear gap", props: ["itemSpacing"] }],
      });
      return;
    }
    const o = {
      nodeId: node.id,
      name: node.name,
      detail: `itemSpacing ${val}px is not using a spacing token.`,
    };
    const sug = buildDimensionalSuggestion(ds, "spacing", "itemSpacing", val);
    if (sug) o.suggestedTokens = [sug];
    offenders.push(o);
  });
  return {
    enabled: true,
    passed: offenders.length === 0 && informational.length === 0,
    offenders: offenders.slice(0, 30),
    informational: informational.slice(0, 30),
    _totalChecked: totalChecked,
    _offenderCount: offenders.length + informational.length
  };
}

// ── padding rule — paddingTop/Right/Bottom/Left ──
function lintPadding(root, ds) {
  const offenders = [];
  const informational = [];
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

  walkDesignerNodes(root, (node, _isRoot, ancestors) => {
    if (!node.autolayout) return;
    // COMPONENT_SET padding is canvas-only variant arrangement — not code output.
    if (node.type === "COMPONENT_SET") return;
    // COMPONENT children of a COMPONENT_SET are variants — exempt them only when
    // the COMPONENT_SET is NESTED inside a larger design (canvas noise). When the
    // user selects the COMPONENT_SET directly as the scan root, they are auditing
    // the design system itself, so variants ARE checked.
    const parent = ancestors[ancestors.length - 1];
    if (node.type === "COMPONENT" && parent && parent.type === "COMPONENT_SET" && ancestors.length > 1) return;
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

    // failedProps: paddings that are visually applied but not tokenized.
    // Paddings being ignored (in zeroSet) are NOT included here — there's
    // no point suggesting a token for a value Figma is currently dropping.
    // The fix options for ignored paddings are "clear" (zeroAction) or
    // "switch axis to hug" (hugAction) — see below.
    const zeroSet = new Set([...zeroVerticalProps, ...zeroHorizontalProps]);
    const failedProps = [];
    for (const p of ["paddingTop", "paddingRight", "paddingBottom", "paddingLeft"]) {
      const val = al[p];
      if (val === 0 || val === null || val === undefined) continue;
      if (b[p]) continue; // already bound to a token
      if (zeroSet.has(p)) continue; // ignored — handled by zero/hug actions
      failedProps.push(p);
    }

    // Count one check per node (not per prop) and one offender per node.
    const isInst = isInstance(node);
    totalChecked++;
    const hasZeroIssue = zeroVerticalProps.length > 0 || zeroHorizontalProps.length > 0;
    if (!failedProps.length && !hasZeroIssue) return;
    // Instance branch: surface read-only with no fix actions; the fix
    // belongs on the master component. We still describe failedProps
    // (which paddings are not tokenized) but skip the zero-action branch
    // entirely — even surfacing the "ignored due to fixed axis" details
    // would imply an actionable cleanup, and there is none here.
    if (isInst) {
      if (!failedProps.length) return;
      const sides = failedProps.map(p => p.replace("padding", "").toLowerCase());
      const sideList = sides.length === 1
        ? sides[0]
        : sides.slice(0, -1).join(", ") + " and " + sides[sides.length - 1];
      informational.push({
        nodeId: node.id,
        name: node.name,
        rule: "padding",
        detail: `${sideList} padding not tokenized.`,
      });
      return;
    }

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

    const _paddingDetail = detailParts.join(" ");
    const o = {
      nodeId:  node.id,
      name:    node.name,
      detail:  _paddingDetail,
    };

    // One suggestion per failing-and-visible padding prop. We deliberately
    // skip ignored paddings (zeroSet): no point binding a token to a value
    // Figma is currently dropping. The fix for those is the zero action
    // (clear them) — the user explicitly preferred this over double-action
    // suggestions that mixed "tokenize" with "clear."
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
    passed: offenders.length === 0 && informational.length === 0,
    offenders: offenders.slice(0, 30),
    informational: informational.slice(0, 30),
    _totalChecked: totalChecked,
    _offenderCount: offenders.length + informational.length
  };
}

// ── size rule — fixed dimensions ──
// "Design-system-shaped" value: integer on a 4px grid in a reasonable range.
// Used by lintSize to decide whether to flag a fixed dimension that has no
// matching DS token. Round values like 32 / 36 / 40 / 48 are likely deliberate
// design steps (a missing token's worth flagging so the designer can either
// add a token or step to an adjacent one). Irregular values like 115 are
// almost always content-driven (a button width = text + padding) and flagging
// them adds noise.
function looksLikeGridValue(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return false;
  if (!Number.isInteger(value)) return false;
  if (value > 256) return false; // beyond typical component dimensions
  return value % 4 === 0;
}

// Flags any FIXED width/height that isn't bound to a variable.
// - Auto-layout child: sizingHorizontal/Vertical === "FIXED" → check that axis.
// - Non-autolayout eligible nodes (FRAME/GROUP/COMPONENT/INSTANCE):
//   width and height are intrinsically FIXED (no hug/fill). Check both.
function lintSize(root, ds) {
  const offenders = [];
  const informational = [];
  let totalChecked = 0;
  walkDesignerNodes(root, (node, _isRoot, ancestors) => {
    // Eligible types:
    // - COMPONENT, COMPONENT_SET, INSTANCE: always checked — atoms like buttons,
    //   chips, avatars, icons where size tokens earn their keep.
    // - FRAME with autolayout: checked ONLY when an exact DS token match exists.
    //   This catches auto-layout frames whose fixed axis matches a design token
    //   (e.g. a 48px icon wrapper with a "size-48" token) while silently skipping
    //   scaffolding (device canvases, section wrappers, positioning shells) whose
    //   dimensions don't match any token in the design system.
    // Plain FRAMEs without autolayout and GROUP nodes are excluded — they are
    // almost always device/page scaffolding with no useful token binding.
    // COMPONENT_SET is a canvas-only variant container — its size is the bounding
    // box of all variants arranged for editing, not a rendered dimension. Never flag it.
    const eligibleTypes = new Set(["COMPONENT", "INSTANCE", "FRAME"]);
    if (!eligibleTypes.has(node.type)) return;
    // COMPONENT children of a COMPONENT_SET are variants — exempt them only when
    // the COMPONENT_SET is NESTED inside a larger design (canvas noise). When the
    // user selects the COMPONENT_SET directly as the scan root, they are auditing
    // the design system itself, so variants ARE checked.
    const parent = ancestors[ancestors.length - 1];
    if (node.type === "COMPONENT" && parent && parent.type === "COMPONENT_SET" && ancestors.length > 1) return;
    const isFrame = node.type === "FRAME";
    const isInst = isInstance(node);
    const sb = node.sizeBound || {};
    const al = node.autolayout;
    // Plain FRAMEs without autolayout are scaffolding — skip entirely.
    if (isFrame && !al) return;
    let hCheck = false, vCheck = false;
    if (al) {
      hCheck = al.sizingHorizontal === "FIXED";
      vCheck = al.sizingVertical === "FIXED";
      // Also honour the node's OWN axis sizing — primaryAxisSizingMode "AUTO"
      // (or counterAxisSizingMode "AUTO") means the corresponding visual axis
      // hugs its content, so its size is content-driven, not a fixed design
      // value. This catches top-level hug frames where layoutSizing* defaults
      // to FIXED for lack of a parent auto-layout context.
      // Axis mapping depends on layoutMode:
      //   VERTICAL   layout → primary axis = vertical, counter axis = horizontal
      //   HORIZONTAL layout → primary axis = horizontal, counter axis = vertical
      const isVert = al.mode === "VERTICAL";
      const widthMode  = isVert ? al.counterAxisSizingMode : al.primaryAxisSizingMode;
      const heightMode = isVert ? al.primaryAxisSizingMode : al.counterAxisSizingMode;
      if (widthMode  === "AUTO") hCheck = false;
      if (heightMode === "AUTO") vCheck = false;
    } else {
      // Non-autolayout COMPONENT/COMPONENT_SET/INSTANCE: dimensions are intrinsically fixed.
      hCheck = true;
      vCheck = true;
    }
    // Constraints-based stretch: the node's size on that axis is driven by its
    // parent frame, not a standalone design decision — skip it.
    // LEFT_RIGHT = pin to both sides (stretches); SCALE = scale with parent.
    const con = node.constraints || {};
    if (con.horizontal === "LEFT_RIGHT" || con.horizontal === "SCALE") hCheck = false;
    if (con.vertical   === "TOP_BOTTOM" || con.vertical   === "SCALE") vCheck = false;
    // Fill-parent COMPONENT masters: a Bottom sheet / Snackbar / App bar /
    // Banner etc. stretches to fill its container when placed in a design.
    // Its canvas width/height is a Figma-editing artefact, not a fixed design
    // decision worth tokenizing. Skip the size check entirely on COMPONENT
    // and INSTANCE nodes whose name matches a known fill-parent pattern.
    // This is the deterministic counterpart of the AI-mode instruction —
    // simple-mode reviews don't run vision, so they need a pattern fallback.
    if (node.type === "COMPONENT" || node.type === "INSTANCE") {
      if (FILL_PARENT_NAME_RE.test(node.name || "")) {
        hCheck = false;
        vCheck = false;
      }
    }
    if (hCheck) {
      totalChecked++;
      if (!sb.width && typeof node.width === "number") {
        if (isInst) {
          informational.push({
            nodeId: node.id,
            name: node.name,
            rule: "size",
            detail: `width ${node.width}px is not using a size token.`,
          });
        } else {
          const sug = buildDimensionalSuggestion(ds, "size", "width", node.width);
          // Flag when the value is "design-system-shaped" — either a DS token
          // exists for it (one-click bind), OR the value is on a 4px grid (a
          // standard design-decision step like 32, 36, 40 — the user might
          // want a new token for it). Skip otherwise: irregular values like
          // 115px are usually content-driven (button width = text + padding),
          // and flagging them with no actionable fix just clutters the report.
          if (!sug && !looksLikeGridValue(node.width)) {
            totalChecked--; // undo the check — this isn't a real candidate
          } else {
            const o = {
              nodeId: node.id,
              name: node.name,
              detail: `width ${node.width}px is not using a size token.`,
            };
            if (sug) o.suggestedTokens = [sug];
            offenders.push(o);
          }
        }
      }
    }
    if (vCheck) {
      totalChecked++;
      if (!sb.height && typeof node.height === "number") {
        if (isInst) {
          informational.push({
            nodeId: node.id,
            name: node.name,
            rule: "size",
            detail: `height ${node.height}px is not using a size token.`,
          });
        } else {
          const sug = buildDimensionalSuggestion(ds, "size", "height", node.height);
          // Same policy as width: flag when token matches OR value is on a
          // 4px design grid (likely a deliberate step missing from the DS).
          if (!sug && !looksLikeGridValue(node.height)) {
            totalChecked--; // undo the check — this isn't a real candidate
          } else {
            const o = {
              nodeId: node.id,
              name: node.name,
              detail: `height ${node.height}px is not using a size token.`,
            };
            if (sug) o.suggestedTokens = [sug];
            offenders.push(o);
          }
        }
      }
    }
  });
  return {
    enabled: true,
    passed: offenders.length === 0 && informational.length === 0,
    offenders: offenders.slice(0, 30),
    informational: informational.slice(0, 30),
    _totalChecked: totalChecked,
    _offenderCount: offenders.length + informational.length
  };
}

// ── radius rule ──
// Flags hardcoded corner radii on any node that has corners. Uses
// `node.radii` (populated by extractNode from cornerRadius / *Radius fields).
// A corner is considered failing when value > 0 AND not bound to a variable.
// Sharp (0) corners are intentional — never flagged.
function lintRadius(root, ds) {
  const offenders = [];
  const informational = [];
  let totalChecked = 0;
  walkDesignerNodes(root, (node) => {
    if (!node.radii) return;
    // COMPONENT_SET is a canvas-only variant container — skip.
    if (node.type === "COMPONENT_SET") return;
    const r = node.radii;
    const bound = r.bound || {};
    const isInst = isInstance(node);

    const cornerKeys = ["topLeftRadius","topRightRadius","bottomLeftRadius","bottomRightRadius"];
    // Count every corner that exists as a checked unit, regardless of whether
    // it ends up in `failing`. Sharp (0) and bound corners are passing checks;
    // they belong in the denominator alongside the failing corners.
    let cornersOnNode = 0;
    const failing = [];
    for (const k of cornerKeys) {
      const val = r[k];
      if (typeof val !== "number") continue; // corner doesn't exist on this node type
      cornersOnNode++;
      if (val === 0) continue;               // sharp — passing
      if (bound[k]) continue;                // already token-bound — passing
      failing.push({ slot: k, value: val });
    }
    totalChecked += cornersOnNode;
    if (!failing.length) return;

    const values = [...new Set(failing.map(f => f.value))];
    const allFour = failing.length === cornerKeys.length;
    let detail;
    if (allFour && values.length === 1) {
      detail = `corner radius ${values[0]}px is not using a token.`;
    } else if (values.length === 1) {
      detail = `${failing.length} corner${failing.length !== 1 ? "s" : ""} at ${values[0]}px not using a token.`;
    } else {
      detail = `corner radii (${values.join(", ")}px) not using tokens.`;
    }

    if (isInst) {
      informational.push({
        nodeId: node.id,
        name: node.name,
        rule: "radius",
        detail,
      });
      return;
    }

    const o = {
      nodeId: node.id,
      name: node.name,
      detail,
    };
    // Build per-corner suggestions; dedupe so we don't render four identical
    // buttons when all four corners share the same value.
    const sugs = [];
    const seen = new Set();
    for (const f of failing) {
      const sug = buildDimensionalSuggestion(ds, "radius", f.slot, f.value);
      if (!sug) continue;
      const key = sug.id + ":" + f.slot;
      if (seen.has(key)) continue;
      seen.add(key);
      sugs.push(sug);
    }
    if (sugs.length) o.suggestedTokens = sugs;
    offenders.push(o);
  });
  return {
    enabled: true,
    passed: offenders.length === 0 && informational.length === 0,
    offenders: offenders.slice(0, 30),
    informational: informational.slice(0, 30),
    _totalChecked: totalChecked,
    _offenderCount: offenders.length + informational.length
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
  // INSTANCE is intentionally NOT eligible: an instance's auto-layout is
  // inherited from its main component. You can't toggle it locally on the
  // instance — flagging it would produce a "fix" the user can't apply.
  // The right place to fix a non-auto-layout library component is the main,
  // and that lives outside this scan's scope.
  const eligibleTypes = new Set(["FRAME", "GROUP", "COMPONENT", "COMPONENT_SET"]);
  // Leaf shapes whose presence means there's nothing to reflow — a frame
  // whose ONLY non-excluded child is one of these is an icon/shape wrapper,
  // not a layout decision. Skip it.
  const SHAPE_LEAF_TYPES = new Set([
    "VECTOR", "BOOLEAN_OPERATION", "RECTANGLE", "ELLIPSE", "POLYGON", "STAR", "LINE"
  ]);
  function isSingleShapeWrapper(node) {
    const kids = (node.children || []).filter(c => !isExcluded(c));
    return kids.length === 1 && SHAPE_LEAF_TYPES.has(kids[0].type);
  }
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
      // Icon / shape wrappers: a frame whose only child is a primitive shape
      // has no reflow scenario. Auto-layout adds no programmability value
      // here — the same code is generated either way.
      if (isSingleShapeWrapper(node)) {
        // Still recurse; the wrapper itself doesn't get checked or counted.
        if (node.children) for (const c of node.children) recurse(c, false);
        return;
      }
      totalChecked++;
      // Auto-layout means `node.autolayout` is truthy in our extracted shape.
      if (!node.autolayout) {
        offenders.push({
          nodeId: node.id,
          name: node.name,
          detail: `${node.type.toLowerCase()} isn't using auto layout.`,
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
        detail: `${visible.length} effect${visible.length === 1 ? "" : "s"} not using an effect style.`,
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
// Most type-words match with optional digits ("Frame", "Frame 1", "Rectangle 5").
// Exception: "Vector" alone is a plausible intentional name for an SVG /
// illustration layer, so we only flag the numbered variants ("Vector 1",
// "Vector 12") which are unambiguous Figma auto-imports. Smart mode can still
// flag a misleading bare "Vector" via the Check 2 semantic-accuracy review.
const NAMING_DEFAULT_RE = /^(?:(?:frame|rectangle|ellipse|polygon|star|line|group|component|instance|text|image)\s*\d*|vector\s*\d+)$/i;
const NAMING_PLACEHOLDER_RE = /^(untitled|new\s+frame|copy|copy\s+\d+|asdf|test|temp|foo|bar|baz|placeholder|thing|stuff|element|new|item)$/i;
// Default name Figma assigns to component-set variant properties before the
// designer renames them: "Property 1", "Property_2", "property-3", etc.
const NAMING_DEFAULT_VARIANT_PROP_RE = /^property[\s_-]?\d+$/i;

// Component name patterns that strongly indicate "fill-parent" semantics —
// the component stretches to fill its container when placed. Their canvas
// dimensions are editing artefacts, not design decisions to tokenize.
// Matches anywhere in the name, case-insensitive. Used by the size rule's
// simple-mode fallback (smart mode does the same judgment via thumbnail).
const FILL_PARENT_NAME_RE = /\b(snackbar|toast|app[\s_-]?bar|top[\s_-]?bar|bottom[\s_-]?bar|bottom[\s_-]?sheet|nav(?:igation)?[\s_-]?bar|tab[\s_-]?bar|toolbar|action[\s_-]?bar|sidebar|side[\s_-]?nav|drawer|banner|divider|header|footer|modal|dialog)\b/i;
// Cheap heuristic name suggester. Used to pre-fill `suggestedName` on naming
// offenders so the AI either accepts our guess or overrides via vision —
// either way it writes fewer tokens. Vision is still better than this for
// non-obvious cases; we only handle easy structural patterns.
const SHAPE_LEAF_TYPES_FOR_NAMING = new Set([
  "VECTOR", "BOOLEAN_OPERATION", "ELLIPSE", "RECTANGLE", "POLYGON", "STAR", "LINE"
]);
function suggestNameHeuristic(node) {
  if (!node) return null;
  // TEXT with non-empty content: first 2-3 words make a sensible label.
  if (node.type === "TEXT" && typeof node.characters === "string") {
    const words = node.characters.trim().split(/\s+/).filter(Boolean).slice(0, 3).join(" ");
    if (words) return words.length > 24 ? words.slice(0, 24) : words;
  }
  const kids = Array.isArray(node.children)
    ? node.children.filter(c => !c.ignored)
    : [];
  // Single shape child → icon wrapper.
  if (kids.length === 1 && SHAPE_LEAF_TYPES_FOR_NAMING.has(kids[0].type)) return "Icon";
  // Single text child → name after the text content.
  if (kids.length === 1 && kids[0].type === "TEXT") {
    const sub = suggestNameHeuristic(kids[0]);
    if (sub) return sub;
  }
  // Auto-layout container with multiple children: hint at the direction.
  if (kids.length >= 2 && node.autolayout && node.autolayout.mode) {
    return node.autolayout.mode === "HORIZONTAL" ? "Row" : "Stack";
  }
  return null;
}

function lintNaming(root, { mode = "simple" } = {}) {
  const offenders = [];
  let totalChecked = 0;
  // Heuristic name suggestions are only useful in AI mode — the AI can vet
  // them against the thumbnail and override garbage. In simple mode the
  // suggestion is the only fix offered, and a bad suggestion (e.g. "Text" → "Text")
  // shows up as a one-click "fix" that doesn't fix anything. So in simple
  // mode we just flag the issue and let the user pick a real name in Figma.
  const wantSuggestions = mode === "ai";
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
      const o = { nodeId: node.id, name: node.name, detail: reason };
      if (wantSuggestions) {
        const suggested = suggestNameHeuristic(node);
        // Only attach a suggestion if it's actually a fix:
        //   - different from the current name (case-insensitive)
        //   - wouldn't itself trigger any of the same lint regexes
        // Avoids the absurd "Rename to 'Text'" loop where a TEXT layer named
        // "Text" with content "Text" suggests its own name back.
        if (suggested) {
          const sTrim = suggested.trim();
          const isSelfRename = sTrim.toLowerCase() === name.toLowerCase();
          const isStillBad =
            NAMING_DEFAULT_RE.test(sTrim) ||
            NAMING_PLACEHOLDER_RE.test(sTrim) ||
            (/^[^A-Za-z]*$/.test(sTrim) || sTrim.length < 2);
          if (!isSelfRename && !isStillBad) o.suggestedName = suggested;
        }
      }
      offenders.push(o);
    }
    // Variant property naming (COMPONENT_SET / COMPONENT). Counts each
    // property as a separate check so the score reflects how many were
    // examined. Deterministic flag here is the "Property N" default;
    // semantic quality (e.g. "Stuff" / "Variant" / unclear values) is
    // for the AI smart-mode review to add via vision.
    if (node.componentPropertyDefinitions) {
      for (const propName of Object.keys(node.componentPropertyDefinitions)) {
        totalChecked++;
        if (NAMING_DEFAULT_VARIANT_PROP_RE.test(propName.trim())) {
          const def = node.componentPropertyDefinitions[propName];
          offenders.push({
            nodeId: node.id,
            name: node.name,
            detail: `Variant property "${propName}" uses a Figma default name.`,
            // propertyKey lets the rename action target this specific property
            // via editComponentProperty(). The AI is expected to ALSO add a
            // suggestedName based on the variant values + thumbnail; without
            // suggestedName the UI shows the offender but no rename button.
            propertyKey: def && def.rawKey,
          });
        }
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

// ── orchestrator ──
function lintFrame(tree, enabledRules, ds, { keepInternalFields = false, mode = "simple" } = {}) {
  const breakdown = {};
  if (enabledRules.naming) breakdown.naming = lintNaming(tree, { mode });
  if (enabledRules.components) breakdown.components = lintComponents(tree);
  if (enabledRules.autolayout) breakdown.autolayout = lintAutolayoutSimple(tree);
  if (enabledRules.colors) breakdown.colors = lintColors(tree, ds);
  if (enabledRules.typography) breakdown.typography = lintTypography(tree);
  if (enabledRules.spacing) breakdown.spacing = lintSpacing(tree, ds);
  if (enabledRules.padding) breakdown.padding = lintPadding(tree, ds);
  if (enabledRules.size) breakdown.size = lintSize(tree, ds);
  if (enabledRules.radius) breakdown.radius = lintRadius(tree, ds);
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
  const proportionalScore = ruleScores.length === 0 ? 100 : Math.round(ruleScores.reduce((a, b) => a + b, 0) / ruleScores.length);
  const perfect = Object.values(breakdown).every(r => r.offenders.length === 0 && (r.informational || []).length === 0);

  // ── Saturation cap ──
  // When a frame has too many issues, the AI ends up writing a 50-100KB JSON
  // report — output tokens dominate review time and a 280-issue dump isn't
  // actionable for the designer anyway. Cap each rule to its top-N most
  // impactful offenders ("actionable" = has suggestedTokens or suggestedName)
  // and tell the AI to skip vision augmentation. Original counts surface in
  // the report banner so the user knows how much was elided.
  const SATURATION_THRESHOLD = 50;
  const SATURATION_PER_RULE_CAP = 7;
  const SATURATION_INFO_CAP = 5;
  const totalOffenders = Object.values(breakdown).reduce((sum, r) => sum + (r._offenderCount || 0), 0);
  let saturated = false;
  const originalOffenderCounts = {};
  if (totalOffenders > SATURATION_THRESHOLD) {
    saturated = true;
    for (const [k, r] of Object.entries(breakdown)) {
      originalOffenderCounts[k] = r._offenderCount || 0;
      // Stable sort: offenders with suggestedTokens or suggestedName float to
      // the top — these are the ones where the user can act with a fix button.
      // Falls back to original order otherwise.
      const sorted = (r.offenders || [])
        .map((o, i) => ({ o, i, actionable: ((o.suggestedTokens && o.suggestedTokens.length) || o.suggestedName) ? 1 : 0 }))
        .sort((a, b) => (b.actionable - a.actionable) || (a.i - b.i))
        .map(x => x.o);
      r.offenders = sorted.slice(0, SATURATION_PER_RULE_CAP);
      r.informational = (r.informational || []).slice(0, SATURATION_INFO_CAP);
    }
  }

  // Strip internal fields (unless caller wants them for pre-computed results)
  const cleanBreakdown = {};
  for (const [k, v] of Object.entries(breakdown)) {
    if (keepInternalFields) {
      cleanBreakdown[k] = { enabled: v.enabled, passed: v.passed, offenders: v.offenders, informational: v.informational || [], _totalChecked: v._totalChecked, _offenderCount: v._offenderCount };
    } else {
      cleanBreakdown[k] = { enabled: v.enabled, passed: v.passed, offenders: v.offenders, informational: v.informational || [] };
    }
  }

  // When saturated, force the score to 0. A frame with 50+ unresolved issues
  // is in crisis — surfacing a proportional 67/100 makes it look "decent" when
  // it isn't, and undersells the urgency the saturation banner is trying to
  // convey. Zero makes the message unambiguous.
  const finalScore = saturated ? 0 : proportionalScore;

  return {
    score: finalScore,
    perfect,
    breakdown: cleanBreakdown,
    issues: topIssues.slice(0, 20),
    saturated,
    originalOffenderCounts: saturated ? originalOffenderCounts : undefined,
    totalOffenders,
  };
}

// ------- extraction -------

// Full-depth tree extraction. The lint pass walks this tree; truncating at a
// shallow depth would silently exclude deep layers from scoring. The AI-bound
// tree is separately depth-capped via slimTreeForAI(maxDepth=12) to keep the
// AI input bounded; the lint sees everything.
//
// `maxDepth` is kept as a guardrail against pathological designs (deeply
// recursive graphs would blow the stack), but at 64 it's far above any real
// design tree.
function extractNode(node, depth = 0, maxDepth = 64) {
  const out = { id: node.id, name: node.name, type: node.type };

  // Mark nodes explicitly excluded via plugin data flag (ground truth for
  // "ignore in review" toggling from the UI).
  try {
    if (typeof node.getPluginData === "function" && node.getPluginData(IGNORE_PDATA_KEY) === "1") {
      out.ignored = true;
    }
  } catch (e) {}

  if (node.type === "COMPONENT" || node.type === "COMPONENT_SET") {
    out.isComponent = true;
    // Capture variant / component-property definitions for the naming rule.
    // Figma keys variant property names with a unique suffix ("Size#1234:0");
    // we strip it so the lint can match against the display name.
    try {
      const defs = node.componentPropertyDefinitions;
      if (defs && typeof defs === "object") {
        const simplified = {};
        for (const rawKey of Object.keys(defs)) {
          const def = defs[rawKey];
          const displayName = rawKey.split("#")[0];
          simplified[displayName] = {
            type: def.type, // VARIANT | BOOLEAN | TEXT | INSTANCE_SWAP
            variantOptions: Array.isArray(def.variantOptions) ? def.variantOptions.slice() : undefined,
            rawKey, // pass through so editComponentProperty() can target this prop at rename time
          };
        }
        if (Object.keys(simplified).length) out.componentPropertyDefinitions = simplified;
      }
    } catch (e) {}
  }
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
    // Internal axis sizing — describes how the node's OWN auto-layout decides
    // its size on each axis (FIXED vs AUTO/hug). Distinct from layoutSizing*
    // which is about how the node behaves within its PARENT's auto-layout —
    // for a top-level scanned frame, layoutSizing* defaults to FIXED even when
    // the node visually hugs its content, so we need the internal axes too.
    const pas = ("primaryAxisSizingMode" in node) ? node.primaryAxisSizingMode : null;
    const cas = ("counterAxisSizingMode" in node) ? node.counterAxisSizingMode : null;
    if (pas !== null) al.primaryAxisSizingMode = pas;
    if (cas !== null) al.counterAxisSizingMode = cas;
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
  // Constraints — used by the size rule to skip axes whose size is driven by
  // the parent (LEFT_RIGHT / SCALE stretch) rather than a fixed design decision.
  if (node.constraints) {
    out.constraints = {
      horizontal: node.constraints.horizontal,
      vertical:   node.constraints.vertical,
    };
  }

  // Corner radii — for the radius rule. Captures per-corner numeric values
  // (Figma exposes them whether or not corners are uniform). Bound variables
  // are tracked separately so the rule can tell "value=8 + bound" (passing)
  // from "value=8 + unbound" (offender).
  if ("topLeftRadius" in node || "cornerRadius" in node) {
    const r = {};
    for (const k of ["topLeftRadius","topRightRadius","bottomLeftRadius","bottomRightRadius"]) {
      if (typeof node[k] === "number") r[k] = node[k];
    }
    const bound = {};
    for (const k of ["topLeftRadius","topRightRadius","bottomLeftRadius","bottomRightRadius"]) {
      const v = boundVarId(node, k);
      if (v) bound[k] = v;
    }
    if (Object.keys(bound).length) r.bound = bound;
    if (Object.keys(r).length) out.radii = r;
  }

  // Stop recursion at INSTANCE boundaries — their children are library
  // internals the designer doesn't control, and skipping them shrinks
  // typical scan payloads from megabytes to kilobytes.
  if ("children" in node && depth < maxDepth && !out.isInstance) {
    out.children = node.children.map(c => extractNode(c, depth + 1, maxDepth));
  }

  return out;
}

// Strip every per-node field that was consumed only by the plugin's lint pass
// (which has already run by the time this is called) — fills, strokes, effects,
// styleIds, boundTypography, sizeBound, radii, autolayout.bound, etc. The AI
// keeps everything it needs for vision augmentation: id/name/type, the
// component/instance flags, ignored markers, characters (TEXT), bounds, and
// a slimmed autolayout block. Recursive — INSTANCE children are absent here
// already because extractNode skips them.
//
// Caps depth at SLIM_MAX_DEPTH so the AI-bound payload stays bounded on
// pathologically deep designs. The lint pass, run earlier on the full tree,
// already saw the deeper nodes — they're just elided from the AI tree.
const SLIM_MAX_DEPTH = 12;
function slimTreeForAI(node, depth = 0) {
  if (!node || typeof node !== "object") return node;
  const slim = {
    id: node.id,
    name: node.name,
    type: node.type,
  };
  if (node.isComponent) slim.isComponent = true;
  if (node.isInstance) slim.isInstance = true;
  // Carry variant property definitions through to the AI so smart-mode
  // naming can evaluate semantic quality of property names + values.
  if (node.componentPropertyDefinitions) slim.componentPropertyDefinitions = node.componentPropertyDefinitions;
  if (node.mainComponentId) slim.mainComponentId = node.mainComponentId;
  if (node.ignored) slim.ignored = true;
  if (node.ignoredInherited) slim.ignoredInherited = true;
  if (typeof node.characters === "string") slim.characters = node.characters;
  if (typeof node.width === "number") slim.width = node.width;
  if (typeof node.height === "number") slim.height = node.height;
  if (typeof node.x === "number") slim.x = node.x;
  if (typeof node.y === "number") slim.y = node.y;
  if (node.autolayout && typeof node.autolayout === "object") {
    const al = node.autolayout;
    const slimAl = {
      mode: al.mode,
      paddingTop: al.paddingTop,
      paddingRight: al.paddingRight,
      paddingBottom: al.paddingBottom,
      paddingLeft: al.paddingLeft,
      itemSpacing: al.itemSpacing,
    };
    if (al.primaryAxisAlignItems) slimAl.primaryAxisAlignItems = al.primaryAxisAlignItems;
    if (al.counterAxisAlignItems) slimAl.counterAxisAlignItems = al.counterAxisAlignItems;
    if (al.sizingHorizontal) slimAl.sizingHorizontal = al.sizingHorizontal;
    if (al.sizingVertical) slimAl.sizingVertical = al.sizingVertical;
    if (al.primaryAxisSizingMode) slimAl.primaryAxisSizingMode = al.primaryAxisSizingMode;
    if (al.counterAxisSizingMode) slimAl.counterAxisSizingMode = al.counterAxisSizingMode;
    slim.autolayout = slimAl;
  }
  if (Array.isArray(node.children) && depth < SLIM_MAX_DEPTH) {
    slim.children = node.children.map(c => slimTreeForAI(c, depth + 1));
  } else if (Array.isArray(node.children) && node.children.length) {
    // Mark elision so the AI knows the tree was truncated here, not "no
    // children." A future bullet on the report banner could surface this.
    slim.childrenTruncated = node.children.length;
  }
  return slim;
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
  if (/\bprimitive(s)?\b|\braw\b|\bcore\b|\btonal\b|\bpalette(s)?\b|\bscale(s)?\b|\bref(erence)?\b|\bbase\b/.test(hay)) return true;
  // Single-segment palette name like "blue-500", "gray-100".
  const lastSeg = (variableName || "").split("/").pop() || "";
  if (/^[a-z]+-?\d{1,4}$/i.test(lastSeg)) return true;
  // Slash-separated palette/level — "neutrals/40", "clay/96", "blue/500".
  // The leading group is a palette name; the trailing group is a numeric step.
  if (/^[a-z]+\/\d{1,4}(\/[a-z0-9_-]+)?$/i.test(variableName || "")) return true;
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

// Race a promise against a timeout. The wrapped promise resolves to
// { ok: true, value } on success, { ok: false, reason } on rejection or
// timeout. Never rejects — callers can branch on `.ok` cleanly without
// try/catch around every await. Critical for the categories panel: a
// single hung Figma API call would otherwise leave the panel forever
// stuck on "Loading…" because no try/catch fires on a never-resolving
// promise.
function withTimeout(promise, ms, label) {
  return new Promise((resolve) => {
    let settled = false;
    const t = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ ok: false, reason: `timeout (${label || "task"} after ${ms}ms)` });
    }, ms);
    Promise.resolve(promise).then(
      (value) => { if (settled) return; settled = true; clearTimeout(t); resolve({ ok: true, value }); },
      (err)   => { if (settled) return; settled = true; clearTimeout(t); resolve({ ok: false, reason: (err && err.message) || String(err) }); }
    );
  });
}

// Lightweight token-collection enumeration for the UI categories panel.
// Returns { buckets, errors } where buckets is one entry per (libraryName,
// collectionName) and errors is the list of failures we tolerated (timed-
// out or rejected library collections, etc.) so the UI can surface a
// recoverable message.
//
// Robustness guarantees:
//   - every Figma API call is wrapped in withTimeout (5s default)
//   - one slow/hanging collection never blocks the others (Promise.allSettled
//     over per-task awaits)
//   - the function ALWAYS returns within ~5s no matter what Figma does
//
// Critically: NO importVariableByKeyAsync calls. That step is the bottleneck
// (~20s per toggle on big libraries). We only need token names + collection
// name + library name for the auto-detect regexes.
const TOKEN_CATEGORIES_API_TIMEOUT_MS = 5000;
async function listTokenCollectionsLight() {
  const buckets = new Map();
  const errors = [];
  function pushToken(libraryName, collectionName, name) {
    const key = tokenCollectionKey(libraryName, collectionName);
    let b = buckets.get(key);
    if (!b) {
      b = { key, collectionName: collectionName || "(unnamed)", libraryName: libraryName || null, tokens: [] };
      buckets.set(key, b);
    }
    b.tokens.push({ name, collectionName, libraryName });
  }

  // ── Local FLOAT variables ──
  // getLocalVariablesAsync gives us the variables; we then need each one's
  // collection name. We resolve all collection IDs in parallel (allSettled
  // + timeout each) so a single sluggish lookup can't strand the rest.
  // Skip entirely when the user has unchecked the Local row in Token libraries.
  const localEnabled = await getLocalVariablesEnabled();
  if (localEnabled && figma.variables && typeof figma.variables.getLocalVariablesAsync === "function") {
    const localsRes = await withTimeout(
      figma.variables.getLocalVariablesAsync("FLOAT"),
      TOKEN_CATEGORIES_API_TIMEOUT_MS,
      "getLocalVariablesAsync(FLOAT)"
    );
    if (!localsRes.ok) {
      errors.push("Local FLOAT variables: " + localsRes.reason);
    } else {
      const locals = localsRes.value || [];
      // Resolve unique collection IDs once.
      const uniqueCollIds = Array.from(new Set(locals.map(v => v.variableCollectionId)));
      const collNameById = new Map();
      const collResults = await Promise.allSettled(uniqueCollIds.map(async (id) => {
        const r = await withTimeout(
          (typeof figma.variables.getVariableCollectionByIdAsync === "function"
            ? figma.variables.getVariableCollectionByIdAsync(id)
            : Promise.resolve(figma.variables.getVariableCollectionById(id))),
          TOKEN_CATEGORIES_API_TIMEOUT_MS,
          "getVariableCollectionByIdAsync"
        );
        return { id, ok: r.ok, name: r.ok && r.value ? r.value.name : null, reason: r.reason };
      }));
      for (const cr of collResults) {
        if (cr.status === "fulfilled" && cr.value.ok) {
          collNameById.set(cr.value.id, cr.value.name);
        } else if (cr.status === "fulfilled" && !cr.value.ok) {
          errors.push("Local collection lookup: " + cr.value.reason);
        }
      }
      for (const v of locals) {
        pushToken(null, collNameById.get(v.variableCollectionId) || null, v.name);
      }
    }
  }

  // ── Library FLOAT variables ──
  let selected = [];
  try { selected = await getSelectedTokenLibraries(); } catch (e) {}
  if (selected.length && figma.teamLibrary && typeof figma.teamLibrary.getAvailableLibraryVariableCollectionsAsync === "function") {
    const collsRes = await withTimeout(
      figma.teamLibrary.getAvailableLibraryVariableCollectionsAsync(),
      TOKEN_CATEGORIES_API_TIMEOUT_MS,
      "getAvailableLibraryVariableCollectionsAsync"
    );
    if (!collsRes.ok) {
      errors.push("Library collections: " + collsRes.reason);
    } else {
      const selectedSet = new Set(selected);
      const matching = (collsRes.value || []).filter(c => selectedSet.has(c.libraryName) || selectedSet.has(c.name));
      // allSettled — one bad/timed-out collection no longer wipes out the
      // others. Each per-collection fetch also has its own timeout so a
      // single slow library doesn't block the user past ~5s total.
      const settled = await Promise.allSettled(matching.map(async (coll) => {
        const r = await withTimeout(
          figma.teamLibrary.getVariablesInLibraryCollectionAsync(coll.key),
          TOKEN_CATEGORIES_API_TIMEOUT_MS,
          `getVariablesInLibraryCollectionAsync(${coll.libraryName || coll.name})`
        );
        if (!r.ok) {
          errors.push(`${coll.libraryName || coll.name} → ${coll.name}: ${r.reason}`);
          return;
        }
        for (const it of (r.value || [])) {
          if (it.resolvedType !== "FLOAT") continue;
          pushToken(coll.libraryName || null, coll.name, it.name);
        }
      }));
      // allSettled itself never rejects, but a `then` callback could throw —
      // guard against that propagating.
      for (const s of settled) {
        if (s.status === "rejected") errors.push("Unexpected: " + ((s.reason && s.reason.message) || String(s.reason)));
      }
    }
  }

  return { buckets: Array.from(buckets.values()), errors };
}

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

  // ── Source 3: local file variables ──────────────────────────────
  // Synthetic "Local" entry alongside the team libraries. Counts the
  // FLOAT and COLOR variables defined directly in this file (not via
  // any library). Surfaced so the user can include/exclude them like
  // any other library.
  try {
    let localColors = 0;
    let localNumbers = 0;
    if (figma.variables && typeof figma.variables.getLocalVariablesAsync === "function") {
      try { localColors  = (await figma.variables.getLocalVariablesAsync("COLOR")).length; } catch (e) {}
      try { localNumbers = (await figma.variables.getLocalVariablesAsync("FLOAT")).length; } catch (e) {}
    }
    if (localColors || localNumbers) {
      // Pin Local to the top of the list — most users think of it as the
      // "this file" baseline before reaching for team libraries.
      result.unshift({
        name: LOCAL_LIBRARY_KEY,
        displayName: "Local variables",
        kind: "local",
        collectionCount: 1, // sentinel — UI doesn't render this
        colorCount:  localColors,
        numberCount: localNumbers
      });
    }
  } catch (e) {
    console.warn("[figma-ai-score] local variable enumeration failed:", e && e.message);
  }

  return result;
}

// Sentinel name used in the Token-libraries list to represent the file's
// local (non-library) variables. Stored in clientStorage like any other
// library selection so the UI can surface a checkbox alongside the
// team libraries.
const LOCAL_LIBRARY_KEY = "__local__";
const LOCAL_VARS_ENABLED_KEY = "figma-ai-score.local-variables-enabled";

// Local variables default to enabled (true) for both fresh installs and
// existing users who never see the toggle. Returns true unless the user
// has explicitly unchecked the Local row.
async function getLocalVariablesEnabled() {
  try {
    const v = await figma.clientStorage.getAsync(LOCAL_VARS_ENABLED_KEY);
    return v === false ? false : true;
  } catch (e) { return true; }
}
async function setLocalVariablesEnabled(enabled) {
  try {
    await figma.clientStorage.setAsync(LOCAL_VARS_ENABLED_KEY, !!enabled);
  } catch (e) {
    console.warn("[figma-ai-score] couldn't persist local-variables-enabled:", e && e.message);
  }
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
        scopes: Array.isArray(v.scopes) && v.scopes.length ? v.scopes.slice() : ["ALL_SCOPES"],
        hiddenFromPublishing: v.hiddenFromPublishing === true,
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

// Session cache for the extracted design system. The expensive part is
// importVariableByKeyAsync (one round trip per library variable, capped at
// 1000) plus paint-style enumeration. None of that changes between reviews
// in the same plugin session unless the user changes their library
// selection, design-doc, or prefs that affect the DS — at those points we
// invalidate the cache via _invalidateDesignSystemCache().
let _dsCache = null;            // { value, key }
let _dsCacheInFlight = null;    // promise — coalesces concurrent calls
function _invalidateDesignSystemCache() { _dsCache = null; _dsCacheInFlight = null; }
async function _designSystemCacheKey() {
  // Cache key is the selected-libraries list. If the user toggles a library
  // checkbox, the key changes and we re-extract. Local variables are not
  // captured in the key — they don't change mid-session in any way that
  // would make the cache stale (Figma reloads the plugin if the user edits
  // local variables in the variable editor).
  try {
    const libs = await getSelectedTokenLibraries();
    return JSON.stringify(libs.slice().sort());
  } catch (e) { return ""; }
}
async function getDesignSystem() {
  const key = await _designSystemCacheKey();
  let cachedValue;
  if (_dsCache && _dsCache.key === key) {
    cachedValue = _dsCache.value;
  } else if (_dsCacheInFlight) {
    cachedValue = await _dsCacheInFlight;
  } else {
    _dsCacheInFlight = (async () => {
      const value = await _getDesignSystemUncached();
      _dsCache = { value, key };
      _dsCacheInFlight = null;
      return value;
    })();
    cachedValue = await _dsCacheInFlight;
  }
  // Category overrides change cheaply (one clientStorage read) and the user
  // can toggle them without re-extracting variables. Always fetch fresh.
  // NB: Figma's plugin sandbox doesn't support object spread (...obj). Use
  // Object.assign for shallow copies of plain DS objects.
  const categoryOverrides = await getTokenCategoryOverrides();
  return Object.assign({}, cachedValue, { categoryOverrides });
}
async function _getDesignSystemUncached() {
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

  // User-toggleable: when "Local" is unchecked in Token libraries, skip the
  // entire local-variable + paint-style block. Team-library data still flows.
  const localEnabled = await getLocalVariablesEnabled();

  // ── Color variables ──
  if (localEnabled) try {
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
          // scopes restrict where a token is allowed (FRAME_FILL, SHAPE_FILL,
          // TEXT_FILL, STROKE_COLOR, ALL_FILLS, ALL_SCOPES, EFFECT_COLOR, …).
          // Default to ALL_SCOPES when absent — matches Figma's own default.
          scopes: Array.isArray(v.scopes) && v.scopes.length ? v.scopes.slice() : ["ALL_SCOPES"],
          // hiddenFromPublishing is the user's explicit "not for direct use"
          // signal (typical for primitive palette tokens that exist only as
          // aliases for semantic tokens).
          hiddenFromPublishing: v.hiddenFromPublishing === true,
          collectionName: coll ? coll.name : null,
          isPrimitive: isPrimitiveTokenName(v.name, coll ? coll.name : null)
        });
      }
    }
  } catch (e) {
    console.warn("[figma-ai-score] variables enumeration failed:", e && e.message);
  }

  // ── Number (FLOAT) variables — used by padding/spacing/size rules ──
  if (localEnabled) try {
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
  if (localEnabled) try {
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

  // categoryOverrides is layered on by the caching wrapper (getDesignSystem).
  return { variables, numberVariables, paintStyles };
}

// Find tokens (variable preferred over style when both match).
// Returns { kind: "variable"|"style", id, name, color, isPrimitive? } or null.
// Returns an array of all tokens whose resolved color matches `hex`.
// Sets of node types that take frame-style fills vs shape-style fills.
// Paint scopes in Figma are: FRAME_FILL, SHAPE_FILL, TEXT_FILL, STROKE_COLOR,
// EFFECT_COLOR, plus the umbrellas ALL_FILLS and ALL_SCOPES.
const FRAME_FILL_NODE_TYPES = new Set(["FRAME", "COMPONENT", "COMPONENT_SET", "INSTANCE", "SECTION"]);
const SHAPE_FILL_NODE_TYPES = new Set(["RECTANGLE", "ELLIPSE", "POLYGON", "STAR", "LINE", "VECTOR", "BOOLEAN_OPERATION"]);

// Returns the set of scope strings that are valid for this slot/nodeType.
// A token matching ANY of these scopes can be suggested.
function allowedColorScopes(slot, nodeType) {
  if (slot === "stroke") return new Set(["STROKE_COLOR", "ALL_SCOPES"]);
  if (slot === "fill") {
    if (nodeType === "TEXT") return new Set(["TEXT_FILL", "ALL_FILLS", "ALL_SCOPES"]);
    if (FRAME_FILL_NODE_TYPES.has(nodeType)) return new Set(["FRAME_FILL", "ALL_FILLS", "ALL_SCOPES"]);
    if (SHAPE_FILL_NODE_TYPES.has(nodeType)) return new Set(["SHAPE_FILL", "ALL_FILLS", "ALL_SCOPES"]);
    // Fallback: anything goes (rare node types).
    return new Set(["FRAME_FILL", "SHAPE_FILL", "TEXT_FILL", "ALL_FILLS", "ALL_SCOPES"]);
  }
  // Unknown slot — be permissive.
  return new Set(["ALL_SCOPES"]);
}

// True when the token's scopes intersect the allowed set, OR the token has no
// scopes recorded (paint styles, library variables without scope metadata).
function tokenInScope(token, allowed) {
  if (!token.scopes || !token.scopes.length) return true;
  for (const s of token.scopes) if (allowed.has(s)) return true;
  return false;
}

function findTokensByColor(ds, hex, { slot, nodeType } = {}) {
  const norm = (c) => (c || "").toLowerCase();
  const target = norm(hex);
  const allowed = slot ? allowedColorScopes(slot, nodeType) : null;
  const varMatches = (ds.variables || [])
    .filter(v => norm(v.color) === target)
    // Hidden-from-publishing tokens are explicitly not for direct use — the
    // designer's signal that this is a primitive that should only be reached
    // via a semantic alias. Never suggest them.
    .filter(v => !v.hiddenFromPublishing)
    .filter(v => !allowed || tokenInScope(v, allowed))
    .map(v => ({ kind: "variable", id: v.id, name: v.name, color: v.color, isPrimitive: v.isPrimitive, collectionName: v.collectionName, scopes: v.scopes }));
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
//   -2  if marked as a primitive token (prefer semantic over primitives)
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
    // Penalize primitives strongly — semantic tokens (e.g. surface/primary)
    // should always win over raw palette tokens (clay/40, blue-500) when both
    // have the matching value. -10 is big enough to overcome the per-segment
    // length penalty below for any realistic name (semantic names rarely
    // exceed 5 path segments).
    if (t.isPrimitive) s -= 10;
    s -= parts.length; // prefer shorter names
    return s;
  }
  return candidates
    .map(t => ({ t, s: score(t) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, max)
    .map(x => x.t);
}

// Filter numeric tokens to those relevant for a given dimensional rule.
//
// padding / spacing: keyword allowlist — these rules are specific enough that
//   a token named "elevation-4" or "radius-sm" matching the same px value
//   would be a genuinely misleading suggestion. Keep the allowlist narrow.
//
// size: NO keyword allowlist — only a rejectlist of obvious non-size tokens
//   (typography, radius). Rationale: design systems name their dimensional
//   scale in wildly different ways ("spacing", "primitive/size", "t-shirt",
//   "numeric/48", …). An allowlist that doesn't know your naming convention
//   produces false negatives (no fix button) which are worse than false
//   positives (wrong-category button), because the exact value match is
//   already a strong gate. If exactly one token in the DS is worth 48px and
//   it's named "spacing-6xl", that IS the right suggestion for a 48px frame.
// Which categories does each lint rule accept? Used by filterDimensionTokensForRule
// to gate tokens by their override (or auto-detected) categories array.
const RULE_ACCEPTED_CATEGORIES = {
  padding: ["spacing"],
  spacing: ["spacing"],
  size:    ["size"],
  radius:  ["radius"],
  // Future rules will add: "font-size", "font-weight", "line-height",
  // "letter-spacing", "paragraph-spacing", "stroke-weight", "opacity".
};

// Token-category overrides let users override the auto-detection per
// collection. Stored shape: { "<libraryName||local>::<collectionName>": [category, ...] }.
// An empty array means "used by no rule." Absence of a key means "no override —
// fall back to auto-detection." Persisted in clientStorage so it follows the
// user across files.
//
// Legacy values (single strings: "spacing"/"size"/"both"/"radius"/"ignore")
// are migrated to arrays on read so we don't need a one-shot migration step.
const TOKEN_CATEGORIES_KEY = "figma-ai-score.token-categories";
function tokenCollectionKey(libraryName, collectionName) {
  return (libraryName || "local") + "::" + (collectionName || "");
}
function normalizeCategoriesValue(v) {
  // Array (new format): keep as-is, dedupe, drop unknowns.
  if (Array.isArray(v)) {
    const valid = new Set([
      "spacing","size","radius","stroke-weight",
      "font-size","font-weight","line-height","letter-spacing","paragraph-spacing",
      "opacity"
    ]);
    return Array.from(new Set(v.filter(s => typeof s === "string" && valid.has(s))));
  }
  // Legacy string format → array.
  if (typeof v === "string") {
    if (v === "both") return ["spacing", "size"];
    if (v === "ignore") return [];
    if (v === "auto" || v === "other") return null; // null = clear override
    return [v];
  }
  return null;
}
async function getTokenCategoryOverrides() {
  try {
    const raw = await figma.clientStorage.getAsync(TOKEN_CATEGORIES_KEY);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const out = {};
    for (const [k, v] of Object.entries(raw)) {
      const norm = normalizeCategoriesValue(v);
      if (norm !== null) out[k] = norm;
    }
    return out;
  } catch (e) { return {}; }
}
async function setTokenCategoryOverride(key, categories) {
  try {
    const map = await getTokenCategoryOverrides();
    if (categories === null || categories === undefined) {
      // null clears the override → falls back to auto-detection.
      delete map[key];
    } else {
      const norm = normalizeCategoriesValue(categories);
      // If the input couldn't be normalized, treat as a clear.
      if (norm === null) delete map[key];
      else map[key] = norm;
    }
    await figma.clientStorage.setAsync(TOKEN_CATEGORIES_KEY, map);
  } catch (e) {
    console.warn("[figma-ai-score] couldn't persist token category:", e && e.message);
  }
}
// Per-category keyword patterns. Tested against the full haystack
// (name + collection name + library name) so a "Radiuses" collection
// with tokens named "sm"/"md"/"lg" is correctly recognized even though
// the individual token names don't contain "radius".
const CATEGORY_PATTERNS = {
  radius:              /radius|radii|corner|rounded/i,
  "font-size":         /font[-_\/ ]?size|fontsize|text[-_\/ ]?size/i,
  "font-weight":       /font[-_\/ ]?weight|fontweight/i,
  "line-height":       /line[-_\/ ]?height|lineheight|leading/i,
  "letter-spacing":    /letter[-_\/ ]?spacing|tracking/i,
  "paragraph-spacing": /paragraph[-_\/ ]?spacing|para[-_\/ ]?spacing/i,
  "stroke-weight":     /stroke[-_\/ ]?weight|border[-_\/ ]?weight|border[-_\/ ]?width/i,
  opacity:             /opacity|alpha/i,
  spacing:             /spacing|gap|space|padding|pad/i,
};
// Tokens whose haystack matches this regex are NEVER candidates for the
// generic "size" rule (typography, radius, opacity, etc).
const SIZE_REJECT_RE = /font[-_\/ ]?size|line[-_\/ ]?height|letter[-_\/ ]?spacing|font[-_\/ ]?weight|radius|radii|border[-_\/ ]?radius|elevation|shadow|opacity|z[-_\/ ]?index/i;

function tokenHaystack(t) {
  return ((t.name || "") + " " + (t.collectionName || "") + " " + (t.libraryName || "")).toLowerCase();
}

// Classify a single token by its haystack — the most specific category wins.
// Returns one of: "radius", "font-size", "font-weight", "line-height",
// "letter-spacing", "paragraph-spacing", "stroke-weight", "opacity",
// "spacing", "size", "ignore".
function classifyTokenHaystack(hay) {
  // Specific categories first. Order matters — radius before "spacing" since
  // a token named "corner-padding" is more useful as a radius hint than spacing.
  for (const cat of [
    "radius","font-size","font-weight","line-height","letter-spacing",
    "paragraph-spacing","stroke-weight","opacity"
  ]) {
    if (CATEGORY_PATTERNS[cat].test(hay)) return cat;
  }
  if (CATEGORY_PATTERNS.spacing.test(hay)) return "spacing";
  if (!SIZE_REJECT_RE.test(hay)) return "size";
  return "ignore";
}

// Auto-detect which categories a collection belongs to. Returns an array
// (possibly empty). Per-token classification with majority vote for specific
// categories (radius/typography/etc.) so a single misnamed token can't hijack
// a "Numbers" collection. Spacing+size co-presence yields ["spacing","size"]
// because that's the unified-scale convention.
function autoDetectCollectionCategories(tokens) {
  if (!tokens || !tokens.length) return [];
  const buckets = tokens.map(t => classifyTokenHaystack(tokenHaystack(t)));
  const SPECIFIC = [
    "radius","font-size","font-weight","line-height","letter-spacing",
    "paragraph-spacing","stroke-weight","opacity"
  ];
  // Specific category needs at least half the tokens to agree.
  const half = Math.ceil(buckets.length / 2);
  for (const cat of SPECIFIC) {
    const n = buckets.filter(b => b === cat).length;
    if (n >= half) return [cat];
  }
  const out = [];
  if (buckets.includes("spacing")) out.push("spacing");
  if (buckets.includes("size")) out.push("size");
  return out;
}

// Filter numeric tokens for a dimensional rule.
//
// 1. Each rule has a list of categories it accepts (RULE_ACCEPTED_CATEGORIES).
// 2. Each token belongs to a collection that has either an override-array
//    (user-set) or auto-detected categories. If the intersection with the
//    rule's accepted-categories list is non-empty, the token is eligible.
// 3. With an override the rejectlist is NOT applied — the user has explicitly
//    declared intent and we trust them. Without an override the auto-detected
//    categories already encode the rejectlist (radius/typography never auto-
//    classify as size), so the token is gated cleanly either way.
function filterDimensionTokensForRule(numberVariables, rule, overrides) {
  overrides = overrides || {};
  const accepted = RULE_ACCEPTED_CATEGORIES[rule] || [];
  if (!accepted.length) return [];
  // Cache per-collection category arrays so we don't re-classify each token
  // when several share a collection. Auto-detection requires the full token
  // list per collection, so we partition first.
  const collTokens = new Map();
  for (const v of (numberVariables || [])) {
    const k = tokenCollectionKey(v.libraryName, v.collectionName);
    if (!collTokens.has(k)) collTokens.set(k, []);
    collTokens.get(k).push(v);
  }
  const collCategories = new Map();
  for (const [k, toks] of collTokens) {
    const override = overrides[k];
    collCategories.set(k, Array.isArray(override) ? override : autoDetectCollectionCategories(toks));
  }
  const out = [];
  for (const v of (numberVariables || [])) {
    const k = tokenCollectionKey(v.libraryName, v.collectionName);
    const cats = collCategories.get(k) || [];
    if (!cats.some(c => accepted.includes(c))) continue;
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
  "spacing", "padding", "size", "radius",
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
  radius: "Radius",
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
