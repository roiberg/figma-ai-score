// Sandbox side of the plugin. Has access to figma.* APIs.
// Cannot open sockets — that lives in ui.html. We speak to the UI via
// figma.ui.postMessage / figma.ui.onmessage.
//
// RPC shape (bridge -> UI -> here):
//   request:  { __rpc: true, id, method, params }
//   response: { __rpc: true, id, result? , error? }

console.log("[figma-ai-score] plugin loaded (build: image-fill-exempt, 2026-04-21)");
figma.showUI(__html__, { width: 653, height: 739, themeColors: true });

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
// review flow. Cleared by announce_review_start / begin_review; short-
// circuits subsequent RPCs with { cancelled: true } until cleared.
let cancelled = false;
const CANCEL_EXEMPT_METHODS = new Set([
  // Read-only methods that should still respond truthfully even after cancel.
  "get_selection", "get_preferences", "is_cancelled"
]);
const CANCEL_CLEARING_METHODS = new Set([
  // A new review cycle clears any stale cancel flag.
  "announce_review_start", "begin_review"
]);

// ── Full review protocol. Returned by get_preferences so any Claude ──
// ── session can run a review with zero external configuration.        ──
// ── Rule descriptions are injected dynamically — only enabled rules   ──
// ── appear in the instructions, so the AI is never confused by rules  ──
// ── that are toggled off.                                             ──

const RULE_DESCRIPTIONS = {
  components: `### components (smart)
A design scores well when its structure decomposes into reusable components the way a developer would decompose it for code. Run the FOUR mechanical checks below AND ALSO the vision-based check below. A node that fails any check is an offender. Do not recurse into INSTANCE children (library internals are out of scope) and do not evaluate nodes the user has explicitly marked ignored (\`node.ignored === true\`). The root frame itself is exempt from THIS rule's component-orphan check (it's the canvas, not a component candidate). Other rules evaluate the root.

**Check 1 — Orphan raw layers.**
Every descendant must be a COMPONENT, COMPONENT_SET, or INSTANCE, OR have an ancestor (below the root) that is one of those types. A raw FRAME/GROUP/TEXT with no component-or-instance ancestor is an offender.

**Check 2 — Over-instancing (the "giant instance" problem).**
If the root has only 1 or 2 direct children and ONE of them is an INSTANCE whose subtree contains more than 80% of the root's total descendant count, flag that INSTANCE. Signal: the entire page is wrapped in a single bulky instance instead of being decomposed into meaningful components.

**Check 3 — Repeated siblings that should share a component.**
For each parent node, compare its direct children's structure signatures (type + immediate children types). If 3 or more siblings share the same signature AND they are NOT all instances of the same mainComponentId, flag each repeated sibling (2nd through Nth). Signal: these look like list items; extract a shared component.

**Check 4 — Semantic names that should be components.**
A layer whose name (case-insensitive, partial-match) contains any of: \`nav\`, \`navigation\`, \`header\`, \`footer\`, \`action bar\`, \`app bar\`, \`toolbar\`, \`tab bar\`, \`bottom sheet\`, \`sidebar\`, \`dialog\`, \`modal\`, \`card\`, \`list item\`, \`row\`, \`hero\`, \`banner\` — when it is a raw FRAME/GROUP (NOT an INSTANCE or COMPONENT), flag it.

**Vision check — structural expectations from the thumbnail.**
Look at the thumbnail of the frame. Enumerate EVERY distinct visual region that reads as a discrete UI element on its own (banners, search bars, filter rows, section containers, CTA blocks, list rows, cards, toolbars, etc.). Then cross-reference with the tree: for each such visual region, verify there's a corresponding INSTANCE node. If the region maps to a raw FRAME/GROUP instead, flag that node.

IMPORTANT — this check is INDEPENDENT of Check 1 (orphan raw layers). Even if the region's parent frame is already flagged as an orphan and will be rolled-up fixed, each visually-distinct child that would be its own component ALSO gets flagged here. A parent being raw does not absolve its children from being called out as component-worthy. Do NOT skim or skip children just because their parent has been flagged.

Be specific in the detail: reference what you see in the screenshot AND the node that should have been a component.

**Counting & scoring:**
- totalChecked = all designer-owned descendants that pass the scoping filters.
- offenderCount = number of UNIQUE nodes that failed at least one check.
- For each offender, combine failure reasons in the detail string.`,

  colors: `### colors
Every visible SOLID fill or stroke must have either a boundVariable (non-null) OR a fillStyleId/strokeStyleId (non-null). A raw hex color with no binding is an offender. Only SOLID fills/strokes are checked — IMAGE, VIDEO, and gradient fills are never flagged (they don't carry color tokens). Skip fills/strokes where \`visible\` is false. Don't recurse into INSTANCE children (library internals — designer can't fix from the instance side). Don't evaluate nodes the user marked ignored (\`node.ignored === true\`).

Note on COMPONENT_SET nodes: Figma automatically renders a dotted purple outline around a component set as a canvas affordance (the variant container marker). That isn't a real product style. Don't flag the dotted purple outline. But OTHER fills/strokes on a component set, if any, are evaluated normally — the user has the explicit ignore mechanism for case-by-case exclusions.

#### Token suggestions (attach \`suggestedTokens\` array to color offenders)

For every color offender, attempt to suggest a specific token from the DS catalog (provided in the scan response as \`designSystem: { variables: [...], numberVariables: [...], paintStyles: [...] }\`). Follow these rules:

1. **Skip the suggestion entirely if the node has \`hasMultipleFills: true\` (for fill offenders) or \`hasMultipleStrokes: true\` (for stroke offenders).** Multi-paint nodes have ambiguous intent; don't guess.
2. **Only suggest tokens whose \`color\` exactly matches the offender's hex value (including alpha).** No "close enough" matching for colors — colors are unlike dimensional tokens; non-exact color matches are almost never what the designer wants.
3. **If zero tokens match**: no suggestion. Leave the offender without \`suggestedTokens\`.
4. **If exactly one token matches**: suggest it as a 1-element array. The \`reason\` is "Exact color match."
5. **If multiple tokens match**: pick the MOST appropriate one based on the screenshot and the context of this specific use. Consider the layer's role (button background, surface, text color, etc.) and match it to the token's semantic name.
6. **Prefer semantic tokens over primitives when values are equal.** Primitives (e.g. \`colors/blue-500\`, \`primitives/neutral/100\`) are scale-style raw values; semantic tokens (e.g. \`colors/surface/primary\`, \`colors/brand/accent\`) encode intent. Variables marked \`isPrimitive: true\` in the catalog are primitives. When the semantic choice differs in value from what the designer drew, still prefer the closest-semantic-match if the value is equal; NEVER override an exact-value match to pick a semantic one with a different value.
7. **Prefer variables over paint styles** when both match — variables are the modern system.

**\`reason\` MUST be a single short sentence — 8 to 15 words.** State two things: (1) the color matches, (2) the token's role fits the layer's purpose. NEVER mention rejected tokens, NEVER quote competing token names, NEVER explain methodology ("chosen over…", "because semantic tokens are preferred…", "encodes intent"). Good:
- "Exact color match; surface role fits the canvas background."
- "Same color, and the button-background role fits this CTA."
- "Same color; semantic token preferred over the primitive scale value."
- "Exact match for the page surface."

Bad — these are too long or mention rejected tokens, do NOT write reasons in this style:
- "Canvas background role — chosen over other exact-value #ffffff tokens (on-primary, on-secondary, surface-container-*) because 'Surface' encodes the page/canvas intent."
- "Chosen over colors/neutral/100 (same value) because semantic tokens are preferred over primitives."

Also bad — too terse:
- "Same color; surface role." (under 6 words → fragmented; write a full short sentence instead)

Color offenders always get an array of length 0 or 1 in \`suggestedTokens\`. Multiple-candidate suggestions (above + below) are reserved for dimensional rules.

The \`suggestedTokens[i]\` object shape for color suggestions:
\`\`\`
{
  kind: "variable" | "style",  // which system the token belongs to
  id: string,                  // the variable or style id from the catalog
  name: string,                // display name (e.g. "colors/brand/primary")
  slot: "fill" | "stroke",     // which paint slot it binds to on the node
  reason: string               // one-sentence "why"
}
\`\`\``,

  typography: `### typography
Every TEXT node must have textStyleId set (non-null), OR have ALL of boundTypography.fontSize, boundTypography.fontFamily, boundTypography.fontWeight, and boundTypography.lineHeight bound (non-null). If neither condition is met, the text node is an offender. Skip TEXT nodes inside INSTANCE children.`,

  spacing: `### spacing
For every auto-layout node (\`node.autolayout\` is truthy), check \`itemSpacing\` — the gap between siblings. A node is an offender when ALL of these are true:
  1. \`itemSpacing\` is a non-zero number (zero is always fine).
  2. \`autolayout.bound.itemSpacing\` is null (no variable bound).
  3. The node has 2 or more children (with 0 or 1 children, itemSpacing has no visible effect — skip).

No hardcoded skips by name or type. The root frame, INSTANCE nodes, and COMPONENT_SET nodes ARE evaluated. The walker still doesn't recurse into INSTANCE *children* (library internals — designer can't fix from instance side) and skips nodes the user has explicitly marked ignored (\`node.ignored === true\`). Everything else is fair game; the user has the explicit ignore mechanism for case-by-case exclusions.

#### Token suggestions for spacing offenders

Use the FLOAT-typed entries in \`designSystem.numberVariables\`. For each offender:
- **Filter to spacing-appropriate tokens.** Look at variable name + collection name; prefer ones with "spacing", "gap", "space" in either. Reject tokens whose names hint at unrelated dimensions (font-size, line-height, border-radius, opacity).
- **Exact value match → 1 candidate.** Reason: "Exact value match."
- **No exact match → 2 candidates (above + below).** Find the highest token \`value < offender\` and the lowest \`value > offender\`. Push both. Reason: short — name the relation, e.g. "12px (one step down)" or "16px (one step up)". Under 8 words.
- **Tie-breakers when multiple exact matches**: prefer semantic over primitive. Same heuristic as colors.
- **No appropriate tokens at all** → empty \`suggestedTokens\` array.

The \`suggestedTokens[i]\` object shape for dimensional suggestions:
\`\`\`
{
  kind: "variable",            // dimensional suggestions are always variables
  id: string,                  // variable id from the catalog
  name: string,                // display name (e.g. "spacing/medium")
  slot: "itemSpacing",         // for the spacing rule, always this
  reason: string               // one-sentence "why"
}
\`\`\``,

  padding: `### padding
For every auto-layout node, check the four padding properties: \`paddingTop\`, \`paddingRight\`, \`paddingBottom\`, \`paddingLeft\`. A property is an offender when:
  1. Its numeric value is non-zero.
  2. Its corresponding \`autolayout.bound.<prop>\` is null.

Each failing property is its own offender entry (so a node with three unbound paddings produces three offender rows).

No hardcoded skips by name or type. Root frame, INSTANCE nodes, COMPONENT_SET nodes — all evaluated. Walker still doesn't recurse into INSTANCE children, and user-ignored nodes are skipped. The user marks specific nodes ignored when they don't want them flagged.

EXCEPTION — vertical paddings on fixed-height atoms. When a node has \`autolayout.sizingVertical === "FIXED"\` AND \`paddingTop === paddingBottom\`, those two paddings are derived from the fixed height (centering content) — not independent design decisions. Skip both \`paddingTop\` and \`paddingBottom\` on these nodes. Horizontal paddings on the same node still need to be bound (they ARE design decisions). Use the screenshot to confirm: button/chip/pill/input shapes visually reading as fixed-height atoms get this exemption.

#### Token suggestions for padding offenders

Use \`designSystem.numberVariables\`. For each offender:
- **Filter to padding-appropriate tokens.** Names/collections containing "padding" or "pad". Reject obvious mismatches.
- **Exact value match → 1 candidate.**
- **No exact match → 2 candidates (above + below).** Highest token below and lowest above the offender's value. Reason for each explains the gap.
- **Multiple exact matches → semantic preferred over primitive.**
- **No appropriate tokens at all** → empty array.

\`suggestedTokens[i].slot\` is the property name itself: \`"paddingTop"\` | \`"paddingRight"\` | \`"paddingBottom"\` | \`"paddingLeft"\`.`,

  size: `### size
For every eligible node (COMPONENT, COMPONENT_SET, INSTANCE), check whether its width and height are using a size token:
- **If the node has auto-layout**: check \`sizingHorizontal === "FIXED"\` (flag width) and \`sizingVertical === "FIXED"\` (flag height). Each FIXED axis whose corresponding \`sizeBound.width\` / \`sizeBound.height\` is null is an offender.
- **If the node is non-autolayout**: width and height are intrinsically fixed (no hug/fill). Treat both as FIXED — flag both if not bound.

Each failing axis is its own offender (so a non-autolayout component with neither width nor height bound produces two offenders).

ELIGIBILITY by type: ONLY COMPONENT, COMPONENT_SET, INSTANCE are evaluated. Plain FRAME and GROUP are NOT evaluated — they're typically layout scaffolding (root canvases like an iPhone frame, section wrappers, positioning shells) whose dimensions come from device or parent context, not from a token a designer should pick. Components and instances are the atoms (buttons, chips, avatars, icons, inputs) where size tokens earn their keep. Other types (TEXT, RECTANGLE, ELLIPSE, VECTOR, etc.) are shape primitives whose dimensions come from their geometry.

There is **no fixed-height-atom exemption for size**. A button at fixed height 39px is exactly the kind of node that should be tokenized to a "button-height" or "size-md" token. Flag it.

The walker doesn't recurse into INSTANCE children (library internals), and user-ignored nodes (\`node.ignored === true\`) are skipped.

#### Token suggestions for size offenders

Use \`designSystem.numberVariables\`. For each offender:
- **Filter to size-appropriate tokens.** Names/collections containing "size", "height", "width", "dim". Explicitly EXCLUDE tokens whose names hint at typography (font-size, line-height, letter-spacing) or radius (border-radius, radius).
- **Exact value match → 1 candidate.**
- **No exact match → 2 candidates (above + below).**
- **Multiple exact matches → semantic preferred over primitive.**
- **No appropriate tokens** → empty array.

\`suggestedTokens[i].slot\` is \`"width"\` or \`"height"\`.`,

  autolayout: `### auto layout
Every eligible container node should be using auto-layout. Eligible types: FRAME, GROUP, COMPONENT, COMPONENT_SET, INSTANCE. A container without auto-layout is an offender — the layout becomes brittle in code-generation contexts because positions are absolute, and changes to one element don't ripple through siblings.

This rule does NOT skip device chrome, COMPONENT_SET, or the INSTANCE node itself. The user has an explicit "ignore" mechanism in the plugin UI for case-by-case exclusions; rules don't bake in those exclusions. Skips:
- **Root frame** is exempt. Device canvases (iPhone, desktop, tablet artboards) are device-shaped containers, not layout decisions — their children carry the layout. Recurse into the root's children normally.
- Nodes the user has explicitly marked ignored (\`node.ignored === true\`).
- INSTANCE *children* (library internals — designer can't change them on the instance side). The instance node itself IS evaluated.
- Ineligible types (TEXT, RECTANGLE, ELLIPSE, VECTOR, etc.) — they can't be auto-layout by Figma's data model.

#### Smart (vision) check on top of the deterministic baseline

In addition to the boolean "is this node auto-layout?" check, use the screenshot to evaluate quality:
- **Pathologically structured auto-layout** that's technically present but useless — e.g. a single auto-layout wrapper containing 50 absolutely-positioned children. Flag with detail explaining the problem.
- **Auto-layout that's clearly wrong for the visual** — wrong direction (HORIZONTAL where the layout reads VERTICAL), incorrect alignment that would break in code-gen, mismatched paddings between siblings that look broken.
- **Decorative compositions** (illustrations, vector groups that aren't laid out) can be reasonable as non-autolayout if the visual structure clearly isn't grid-like. Use judgment: if this group's children would always render as a unit (an icon, a graphic), flag is unnecessary.

Detail format for offenders:
- "<type> isn't using auto layout." — for the deterministic case.
- "<type> uses auto layout but [vision-derived problem description]." — for the smart case.

No token suggestions for autolayout offenders — this rule isn't about token bindings.`,

  effects: `### effects
Every visible effect (in the effects array) must come from an effectStyleId (non-null on the node). If a node has visible effects but no effectStyleId, it is an offender. Don't recurse into INSTANCE children (library internals); don't evaluate user-ignored nodes. COMPONENT_SET, root, and INSTANCE nodes themselves are all evaluated normally; the user has the explicit ignore mechanism for case-by-case exclusions.`,

  naming: `### naming (smart)
Every designer-owned node should have a semantic, descriptive name that accurately reflects what the layer is. Run the two checks below on every designer-owned node, INCLUDING the root frame (a selected frame named "Frame 1" is itself a naming problem). Don't recurse into INSTANCE children (library internals). Don't evaluate user-ignored nodes (\`node.ignored === true\`).

**Check 1 — Mechanical patterns (regex).**
A node is an offender if its name matches any of:
  - Generic Figma defaults: \`^(Frame|Rectangle|Ellipse|Polygon|Star|Line|Vector|Group|Component|Instance|Text|Image) ?\\d*$\` (case-insensitive). Examples: "Frame 427", "Rectangle 12", "Vector".
  - Very short non-descriptive names: single character, purely numeric, fewer than 2 letters.
  - Placeholder names: "untitled", "new frame", "copy", "asdf", "test", "temp".

**Check 2 — Semantic accuracy (uses the thumbnail).**
Look at the thumbnail. For each designer-owned layer, judge whether its name actually describes what the layer visually represents. Flag names that are:
  - **Misleading**: the name suggests one thing but the layer contains something else (e.g., a layer named "Button" that is actually a text label, a layer named "Avatar" with a plain rectangle).
  - **Overly generic to the point of meaninglessness**: "Container 2", "Thing", "Stuff", "New", "Element" on layers that have a clear specific purpose in the screen.
  - **Obvious typos** that hurt codegen: "Hedaer" (likely "Header"), "Naviagtion" (likely "Navigation"). Only flag when the intended word is unambiguous.

Be specific in the detail: "Layer 'Hedaer' appears to be a header — rename to 'Header' (likely typo)." Do NOT flag style choices like lowercase/hyphen/underscore naming, and do NOT flag valid but unusual names; only flag clear problems.

**Auto-apply support — populate \`suggestedName\`.**
When flagging a naming offender AND you are confident about a single good replacement name, add a \`suggestedName\` field on the offender object (a sibling of nodeId, name, detail). The plugin UI will render a one-click "Rename to X" button. Only include \`suggestedName\` when:
- You have an unambiguous, descriptive replacement you'd genuinely recommend.
- The replacement matches what the layer actually contains (use the thumbnail).
- It's a reasonable Figma layer name (short, no trailing punctuation).
Omit the field entirely when the naming problem is real but the right replacement depends on context you don't have (e.g., a layer named "Stuff" where you can't tell what it represents).`
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
You are reviewing Figma designs for AI Programmability — how well they're structured for AI tools to convert into clean, maintainable code. Follow this protocol exactly.

## WHY THIS MATTERS
When AI tools translate Figma designs into code, the output quality depends heavily on how the Figma file is structured. A frame full of absolute-positioned layers named "Frame 427" produces messy code. A frame with semantic names, auto-layout, reusable components, and design tokens produces code close to production-ready.

## FLOW
0. Call announce_review_start IMMEDIATELY — as the very first tool, before anything else. It's a lightweight signal that makes the plugin UI show "Preparing review…" so the user sees feedback while you read these instructions. If you skip it, the UI looks frozen for ~10 seconds.
1. Call get_preferences — read enabledRules and these instructions. IMPORTANT: Call this at the START of every review, even if you reviewed earlier in this conversation. The user may have changed toggles between runs. Never reuse cached preferences from a previous review.
2. Call get_selection — read the selected frames. If capped is true, warn the user only the first 10 will be reviewed.
3. Call begin_review with the selected node ids.
4. For each selected frame, call request_scan with its nodeId.
5. Walk the returned tree and apply ONLY the enabled rules listed below.
6. Compute the score using proportional scoring (see below).
7. Call submit_report with the completed report.
8. If any tool returns { cancelled: true }, stop immediately and tell the user "Review cancelled."

## CRITICAL SCOPING RULES — READ BEFORE ANALYZING

### Explicit ignore — nodes marked as "ignored"
If the scan tree contains a node with \`"ignored": true\`, treat that node AND its entire subtree as excluded from the review. The designer explicitly marked this layer to be skipped (e.g., scaffolding, mockups, simulated browser chrome). Skip those nodes entirely — do not walk into them, do not include any of their descendants in totalChecked or offenders, and do not mention them in the report.

### Do NOT recurse into INSTANCE children
When you encounter a node with isInstance: true, evaluate the INSTANCE node itself (its name, its own fills/strokes/styles) but do NOT recurse into its children. The deep internals of a component instance (SVG vector paths, icon sub-elements, etc.) are defined in the component library — the designer doesn't control those. Only evaluate designer-owned layers.

### Root frame exemption
The root frame itself (the top-level scanned node) is exempt from the components rule — only its descendants are checked. For component sets, the root's own layoutMode is irrelevant (variant arrangement on canvas ≠ code output).

### Off-screen layers
Layers positioned outside visible frame bounds ARE still analyzed and scored, but note them in the detail so the designer is aware.

### Scrollable lists are NOT issues
Lists or scrollable content that extends beyond its container bounds is intentional (scroll prototyping). Do NOT flag as overflow, layout mismatch, or "extends beyond bounds."

### Repeated component instances are GOOD
The same component instance appearing multiple times (e.g., same icon in 12 button variants) is correct component reuse — exactly the pattern this review rewards. NEVER flag as duplication.

## ENABLED RULES
${disabledNote}
${rulesSection}

## SCORING
Use proportional scoring across the ${enabledNames.length} enabled rule${enabledNames.length === 1 ? "" : "s"} only: ${enabledNames.join(", ")}.
  rule_score = (totalChecked - offenderCount) / totalChecked * 100
  final_score = round(average of all enabled rule scores)
  perfect = true only if ALL enabled rules have zero offenders

If a rule has zero nodes to check (e.g. no TEXT nodes for typography), that rule scores 100.

Scoring must match issues — strict consistency:
- A rule scores 100 if and only if zero offenders.
- If a rule scores below 100, there MUST be offenders listed.
- Scores like 95 or 98 require specific evidence. "Feels like a small deduction" is NOT valid.

## REPORT FORMAT
submit_report expects:
{
  frames: [{
    nodeId, name,
    score: <number 0-100>,
    perfect: <boolean>,
    breakdown: {
      <ruleName>: {
        enabled: <boolean>,
        passed: <boolean — true if zero offenders>,
        offenders: [{ nodeId, name, detail }, ...] (max 30 per rule)
      }
    },
    issues: [{ rule, nodeId, name, detail }, ...] (top issues, max 20)
  }],
  generatedAt: <ISO timestamp>
}

Only include the ${enabledNames.length} enabled rule${enabledNames.length === 1 ? "" : "s"} (${enabledNames.join(", ")}) in the breakdown. For disabled rules, omit them entirely.

## ISSUE QUALITY RULES

### Every issue must be backed by evidence
Every issue you report MUST be traceable to specific data in the scan tree. If you cannot point to the exact node, fill, stroke, or style binding, you cannot report it. Inventing issues is worse than missing them — it destroys trust in the review.

### Only report confirmed, observable issues
If you cannot see something (e.g., inside an instance's children), do NOT create an issue telling the designer to "verify" or "inspect" it. That is not an issue — it is a limitation of the scan. Skip it entirely.

### No non-issues
If your issue ends with "no action needed," "minimal impact," or similar hedging — delete it. It's not an issue.

### No library speculation
Do not speculate about what "might" be inside a library component instance. You cannot see inside instances; do not guess.

### Be specific
Name exact layers and node IDs. Don't say "some layers have bad names" — say "'Frame 18231' should be renamed to something semantic."

### Forbidden words and phrases — must NOT appear in any detail string:
- No action required, No action needed, Minimal impact, Low impact, be aware that, verify that, note that, confirm that
- extends beyond, overflow, layout mismatch, outside container bounds (when about scrollable content)

## NOTES
- Limit offenders to 30 per rule to keep payloads manageable.
- **Detail strings must be short and plain (under ~10 words).** State the issue, don't explain the technical mechanism. Don't include hex values, node-property names like \`fillStyleId\`, or jargon like "bound variable". Don't give fix advice. Examples — good: "Fill does not use a token or style.", "Spacing not tokenized.", "Auto-layout missing on this frame.". Bad: "SOLID fill #FF0000 has no bound variable or style.", "boundVariable is null on the first paint."
- After submitting the report, briefly summarize the results to the user in chat — mention the score, which rules passed/failed, and top issues.
- If the scan data is too large for your context, use a sub-agent to process it in chunks. Instruct it to read the entire file and return only the rule results.
- Component set root layout is NEVER an issue. When the root is a COMPONENT_SET, its layoutMode is for variant arrangement on the canvas, not code output.
- Repeated use of the same component instance across variants is CORRECT and EXPECTED.
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
const MAX_SELECTION_AI = 3;
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

function pushSelection() {
  const sel = figma.currentPage.selection;
  const max = currentMaxSelection();
  const capped = sel.slice(0, max);
  const frames = capped.map(n => decorateFrameWithIgnored(
    { id: n.id, name: n.name, type: n.type },
    n
  ));
  figma.ui.postMessage({
    type: "selection",
    data: frames,
    total: sel.length,
    capped: sel.length > max,
    maxSelection: max,
    fileName: figma.root.name,
    pageName: figma.currentPage.name
  });
}
figma.on("selectionchange", pushSelection);
figma.on("currentpagechange", pushSelection);

// ------- UI messages (control + RPC) -------

figma.ui.onmessage = async (msg) => {
  if (!msg) return;

  if (!msg.__rpc) {
    if (msg.type === "set-cancelled") {
      // The UI's Stop button (and any future cancel UX) sets this flag.
      // Subsequent CLI RPCs short-circuit with { cancelled: true } until
      // the next announce_review_start / begin_review clears it.
      cancelled = !!msg.value;
      return;
    }
    if (msg.type === "ui-ready") {
      await loadPrefs();
      try {
        const m = await figma.clientStorage.getAsync("figma-ai-score.mode");
        if (m === "ai" || m === "simple") reviewMode = m;
      } catch (e) {}
      // Seed the UI with the persisted "Don't show the connect-success
      // card" flag — set per-user via figma.clientStorage so it travels
      // across files and sessions on this Figma account.
      try {
        const suppressed = await figma.clientStorage.getAsync("figma-ai-score.suppress-connect-success");
        figma.ui.postMessage({ type: "connect-success-suppressed", value: !!suppressed });
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
      return {
        enabledRules: prefs,
        scoringMethod: "proportional",
        instructions: buildInstructions(prefs)
      };
    }
    case "is_cancelled": {
      return { cancelled };
    }
    case "announce_review_start": {
      // Early signal — Claude is about to work on a review but hasn't
      // processed the big instructions string yet. Show a generic
      // "Preparing review…" state so the UI doesn't feel frozen.
      figma.ui.postMessage({ type: "review-starting" });
      return { ok: true };
    }
    case "begin_review": {
      const ids = Array.isArray(params.nodeIds) ? params.nodeIds : [];
      locked = true;
      lockedIds = ids;
      const names = ids.map(id => {
        const n = figma.getNodeById(id);
        return n ? n.name : "(missing)";
      });
      figma.ui.postMessage({ type: "locked", data: { nodeIds: ids, names } });
      return { ok: true, count: ids.length };
    }
    case "end_review": {
      locked = false;
      lockedIds = [];
      figma.ui.postMessage({ type: "unlocked" });
      return { ok: true };
    }
    case "request_scan": {
      // Resolve the node, preferring async (works in dynamic-page mode).
      let node = null;
      try {
        if (typeof figma.getNodeByIdAsync === "function") {
          node = await figma.getNodeByIdAsync(params.nodeId);
        }
      } catch (e) { /* fall through */ }
      if (!node) node = figma.getNodeById(params.nodeId);
      // Final fallback: iterate the current page's selection for a live SceneNode
      // with the matching id. This is guaranteed to give us a proper node object.
      if (!node || typeof node.exportAsync !== "function") {
        try {
          const sel = figma.currentPage.selection;
          for (const s of sel) {
            if (s && s.id === params.nodeId && typeof s.exportAsync === "function") {
              node = s;
              break;
            }
          }
        } catch (e) {}
      }
      if (!node) throw new Error("node not found: " + params.nodeId);
      const tree = extractNode(node);
      let thumbnail = null;
      let thumbError = null;
      try {
        console.log("[figma-ai-score] v2 request_scan. node type:", node.type, "has exportAsync:", typeof node.exportAsync);
        if (typeof node.exportAsync === "function") {
          const bytes = await node.exportAsync({
            format: "JPG",
            constraint: { type: "WIDTH", value: 384 }
          });
          thumbnail = bytesToBase64(bytes);
          console.log("[figma-ai-score] thumbnail exported:", bytes.length, "bytes,", thumbnail.length, "base64 chars");
        } else {
          thumbError = "node.exportAsync is not a function (type=" + node.type + ", keys=" + Object.keys(node || {}).slice(0, 20).join(",") + ")";
        }
      } catch (e) {
        thumbError = String(e && e.message || e);
        console.error("[figma-ai-score] thumbnail export failed:", e);
      }
      // DS catalog — used by Claude in Smart mode to suggest color tokens.
      // Simple mode doesn't come through here (it lints locally), it fetches
      // its own via the run-lint handler.
      let designSystem = null;
      try { designSystem = await getDesignSystem(); } catch (e) {
        console.warn("[figma-ai-score] getDesignSystem failed:", e && e.message);
      }
      return {
        fileName: figma.root.name,
        pageName: figma.currentPage.name,
        root: { id: node.id, name: node.name, type: node.type },
        tree,
        thumbnail,
        thumbError,
        designSystem
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
      figma.ui.postMessage({ type: "report", data: params.report });
      locked = false;
      lockedIds = [];
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

  // Check 1 (orphan) and Check 4 (semantic names) + totalChecked count
  const SEMANTIC_NAMES = /\b(navigation|nav|header|footer|action ?bar|app ?bar|toolbar|tab ?bar|bottom ?sheet|sidebar|dialog|modal|card|list ?item|row|hero|banner)\b/i;
  walkDesignerNodes(root, (node, isRoot, ancestors) => {
    if (isRoot) return;
    totalChecked++;
    const hasContainerAncestor = ancestors.some(a => a !== root && isComponentContainer(a));
    const isOrphan = !isComponentContainer(node) && !hasContainerAncestor;
    const isRawFrameGroup = (node.type === "FRAME" || node.type === "GROUP") && !isInstance(node) && node.type !== "COMPONENT" && node.type !== "COMPONENT_SET";
    const hasSemanticName = isRawFrameGroup && SEMANTIC_NAMES.test(node.name || "");
    if (hasSemanticName) {
      addOffense(node, "semantic", `"${node.name}" should be a reusable component.`);
    } else if (isOrphan) {
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
        // Suggest a token only when unambiguous: single fill on the node
        // AND exactly one matching token in the DS.
        if (hasDs && !node.hasMultipleFills) {
          const match = findTokensByColor(ds, f.color);
          if (match) {
            o.suggestedTokens = [Object.assign({}, match, {
              slot: "fill",
              reason: "Exact match."
            })];
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
          const match = findTokensByColor(ds, s.color);
          if (match) {
            o.suggestedTokens = [Object.assign({}, match, {
              slot: "stroke",
              reason: "Exact match."
            })];
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
//   - [single match] when there's exactly one DS token at the same value
//     (filtered to the rule-appropriate keyword set)
//   - []           when 0 or 2+ matches (Simple-mode safe failure)
// AI mode is responsible for the "above + below" path; that requires
// vision context Claude has and we don't.
function buildDimensionalSuggestion(ds, rule, slot, value) {
  if (!ds || !Array.isArray(ds.numberVariables) || !ds.numberVariables.length) return null;
  const filtered = filterDimensionTokensForRule(ds.numberVariables, rule);
  const match = findTokensByValue(filtered, value);
  if (!match) return null;
  return {
    kind: "variable",
    id: match.id,
    name: match.name,
    slot,                         // e.g. "paddingTop", "itemSpacing", "width"
    reason: "Exact match."
  };
}

// ── spacing rule — itemSpacing only ──
function lintSpacing(root, ds) {
  const offenders = [];
  let totalChecked = 0;
  walkDesignerNodes(root, (node) => {
    if (!node.autolayout) return;
    const al = node.autolayout;
    const b = al.bound || {};
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
// Keeps the fixed-height-atom exemption: when the node has FIXED vertical
// sizing AND paddingTop === paddingBottom, those vertical paddings are
// derived from centering content in the fixed height (not independent
// design decisions). Skip them.
function lintPadding(root, ds) {
  const offenders = [];
  let totalChecked = 0;
  walkDesignerNodes(root, (node) => {
    if (!node.autolayout) return;
    const al = node.autolayout;
    const b = al.bound || {};
    const skipVertical = al.sizingVertical === "FIXED" && al.paddingTop === al.paddingBottom;
    const props = ["paddingTop", "paddingRight", "paddingBottom", "paddingLeft"];
    const failedProps = [];
    for (const p of props) {
      if (skipVertical && (p === "paddingTop" || p === "paddingBottom")) continue;
      totalChecked++;
      const val = al[p];
      if (val === 0 || val === null || val === undefined) continue;
      if (!b[p]) failedProps.push(p);
    }
    if (!failedProps.length) return;
    // One offender per node per failed property.
    for (const p of failedProps) {
      const o = {
        nodeId: node.id,
        name: node.name,
        detail: `${p} ${al[p]}px is not using a padding token.`
      };
      const sug = buildDimensionalSuggestion(ds, "padding", p, al[p]);
      if (sug) o.suggestedTokens = [sug];
      offenders.push(o);
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
const NAMING_PLACEHOLDER_RE = /^(untitled|new\s+frame|copy|copy\s+\d+|asdf|test|temp|foo|bar|baz|placeholder)$/i;
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
function lintFrame(tree, enabledRules, ds) {
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

  // Strip internal fields
  const cleanBreakdown = {};
  for (const [k, v] of Object.entries(breakdown)) {
    cleanBreakdown[k] = { enabled: v.enabled, passed: v.passed, offenders: v.offenders };
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
    out.fills = node.fills.map(serializePaint);
    out.fillStyleId = node.fillStyleId || null;
    // Token-suggestion logic skips nodes with more than one fill (visible
    // or hidden) — the intent is ambiguous with multiple paints stacked.
    out.hasMultipleFills = node.fills.length > 1;
  }
  if ("strokes" in node && Array.isArray(node.strokes)) {
    out.strokes = node.strokes.map(serializePaint);
    out.strokeStyleId = node.strokeStyleId || null;
    out.hasMultipleStrokes = node.strokes.length > 1;
  }
  if ("effects" in node && Array.isArray(node.effects)) {
    out.effects = node.effects.map(serializeEffect);
    out.effectStyleId = node.effectStyleId || null;
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
    out.autolayout = {
      mode: node.layoutMode,
      paddingTop: node.paddingTop,
      paddingRight: node.paddingRight,
      paddingBottom: node.paddingBottom,
      paddingLeft: node.paddingLeft,
      itemSpacing: node.itemSpacing,
      bound: {
        paddingTop: boundVarId(node, "paddingTop"),
        paddingRight: boundVarId(node, "paddingRight"),
        paddingBottom: boundVarId(node, "paddingBottom"),
        paddingLeft: boundVarId(node, "paddingLeft"),
        itemSpacing: boundVarId(node, "itemSpacing")
      },
      // FIXED / HUG / FILL — used by the linter to detect fixed-height atoms
      // (buttons, chips, inputs) where vertical padding is derived, not tokenized.
      sizingVertical: ("layoutSizingVertical" in node) ? node.layoutSizingVertical : null,
      sizingHorizontal: ("layoutSizingHorizontal" in node) ? node.layoutSizingHorizontal : null
    };
  }

  // Dimensions — used by the size rule. We always extract width/height
  // and which side(s) are bound to a variable; the linter decides
  // whether to flag based on autolayout sizing mode (or non-autolayout).
  if (typeof node.width === "number") out.width = node.width;
  if (typeof node.height === "number") out.height = node.height;
  out.sizeBound = {
    width: boundVarId(node, "width"),
    height: boundVarId(node, "height")
  };

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
  // Returns [{ name: <libraryName>, collectionCount: <number> }] —
  // grouped by libraryName so the user picks a library, not a collection.
  if (!figma.teamLibrary || typeof figma.teamLibrary.getAvailableLibraryVariableCollectionsAsync !== "function") {
    console.warn("[figma-ai-score] figma.teamLibrary API not available in this Figma version.");
    return [];
  }
  let collections = [];
  try {
    collections = await figma.teamLibrary.getAvailableLibraryVariableCollectionsAsync();
  } catch (e) {
    console.warn("[figma-ai-score] getAvailableLibraryVariableCollectionsAsync failed:", e && e.message);
    return [];
  }
  console.log("[figma-ai-score] team-library variable collections found:", collections.length, collections.map(c => ({ libraryName: c.libraryName, name: c.name })));
  const byLib = new Map();
  for (const c of collections) {
    const n = c.libraryName || "Unknown library";
    byLib.set(n, (byLib.get(n) || 0) + 1);
  }
  const result = [];
  for (const [name, collectionCount] of byLib) result.push({ name, collectionCount });
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
  if (!figma.teamLibrary || typeof figma.teamLibrary.getAvailableLibraryVariableCollectionsAsync !== "function") {
    return { variables, numberVariables };
  }

  let collections = [];
  try {
    collections = await figma.teamLibrary.getAvailableLibraryVariableCollectionsAsync();
  } catch (e) {
    console.warn("[figma-ai-score] team-library collections fetch failed:", e && e.message);
    return { variables, numberVariables };
  }
  const selectedSet = new Set(selected);
  const matchingCollections = collections.filter(c => selectedSet.has(c.libraryName));
  if (!matchingCollections.length) return { variables, numberVariables };

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
// If `allMatches` is true, returns an array of all matches instead.
function findTokensByColor(ds, hex, opts) {
  opts = opts || {};
  const norm = (c) => (c || "").toLowerCase();
  const target = norm(hex);
  const varMatches = (ds.variables || [])
    .filter(v => norm(v.color) === target)
    .map(v => ({ kind: "variable", id: v.id, name: v.name, color: v.color, isPrimitive: v.isPrimitive, collectionName: v.collectionName }));
  const styleMatches = (ds.paintStyles || [])
    .filter(s => norm(s.color) === target)
    .map(s => ({ kind: "style", id: s.id, name: s.name, color: s.color }));
  if (opts.allMatches) return [...varMatches, ...styleMatches];
  // Prefer variable over style when both match (user's call).
  if (varMatches.length === 1 && styleMatches.length === 0) return varMatches[0];
  if (varMatches.length === 0 && styleMatches.length === 1) return styleMatches[0];
  // Variable AND style both exactly one each → prefer variable.
  if (varMatches.length === 1 && styleMatches.length === 1) return varMatches[0];
  return null; // 0 matches, or ambiguous
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
