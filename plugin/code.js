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
  components: true,
  colors: true,
  typography: true,
  spacing: true,
  effects: true,
  naming: true
};
const PREFS_KEY = "figma-ai-score.prefs.v1";

let prefs = Object.assign({}, DEFAULT_RULES);
let locked = false;
let lockedIds = [];

// ── Full review protocol. Returned by get_preferences so any Claude ──
// ── session can run a review with zero external configuration.        ──
// ── Rule descriptions are injected dynamically — only enabled rules   ──
// ── appear in the instructions, so the AI is never confused by rules  ──
// ── that are toggled off.                                             ──

const RULE_DESCRIPTIONS = {
  components: `### components (smart)
A design scores well when its structure decomposes into reusable components the way a developer would decompose it for code. Run the FOUR mechanical checks below AND ALSO the vision-based check below. A node that fails any check is an offender. Skip device chrome nodes and do not recurse into INSTANCE children (library internals are out of scope). The root frame itself is exempt from all checks.

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
Every visible SOLID fill or stroke must have either a boundVariable (non-null) OR a fillStyleId/strokeStyleId (non-null). A raw hex color with no binding is an offender. Only SOLID fills/strokes are checked — IMAGE, VIDEO, and gradient fills are never flagged (they don't carry color tokens). Skip fills/strokes where visible is false. Skip nodes inside INSTANCE children (library internals). Skip device chrome nodes.

IMPORTANT — Size tokens are NEVER an issue. The team does not use Figma variables for width, height, or any dimensional values. Do NOT flag missing size tokens. Do NOT suggest "adding sizing variables" or "binding width/height to tokens." This is an absolute rule.`,

  typography: `### typography
Every TEXT node must have textStyleId set (non-null), OR have ALL of boundTypography.fontSize, boundTypography.fontFamily, boundTypography.fontWeight, and boundTypography.lineHeight bound (non-null). If neither condition is met, the text node is an offender. Skip TEXT nodes inside INSTANCE children.`,

  spacing: `### spacing
For every node that has an autolayout property, check each of its spacing properties (paddingTop, paddingRight, paddingBottom, paddingLeft, itemSpacing). A property is an offender only when ALL of these are true:
  1. Its numeric value is non-zero (zero values are always fine — 0px has nothing to tokenize).
  2. Its corresponding bound (e.g. bound.paddingTop) is null.
If a node has any such offending property, the node is an offender. Properties with a value of 0 are ALWAYS fine regardless of their bound status. Spacing tokens (gap, padding) ARE expected — spacing ≠ sizing.

SKIP the following — they are NEVER spacing offenders:
- The root frame and component set roots.
- INSTANCE nodes. An instance's padding/itemSpacing is defined by the library component it was created from — the designer cannot bind those values on the instance itself. Evaluate the library component, not the instance.
- **Vertical padding on fixed-height atoms** (buttons, chips, inputs, pills, tags). When a node has \`autolayout.sizingVertical === "FIXED"\` AND \`paddingTop === paddingBottom\`, those two paddings are derived from the element's fixed height and a centered content — they're not independent design decisions and shouldn't be tokenized. Skip \`paddingTop\` and \`paddingBottom\` on these nodes. Horizontal paddings on the same node still need to be bound (they ARE design decisions — how much breathing room around the content). In vision mode, use the screenshot to confirm: button/chip/pill/input shapes visually reading as fixed-height atoms get this exemption.`,

  effects: `### effects
Every visible effect (in the effects array) must come from an effectStyleId (non-null on the node). If a node has visible effects but no effectStyleId, it is an offender. Skip nodes inside INSTANCE children.`,

  naming: `### naming (smart)
Every designer-owned node should have a semantic, descriptive name that accurately reflects what the layer is. Run the two checks below on every designer-owned node, INCLUDING the root frame (a selected frame named "Frame 1" is itself a naming problem). Skip nodes inside INSTANCE children and skip device chrome.

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
1. Call get_preferences — read enabledRules and these instructions. IMPORTANT: Call this at the START of every review, even if you reviewed earlier in this conversation. The user may have changed toggles between runs. Never reuse cached preferences from a previous review.
2. Call get_selection — read the selected frames. If capped is true, warn the user only the first 10 will be reviewed.
3. Call begin_review with the selected node ids.
4. For each selected frame, call request_scan with its nodeId.
5. Walk the returned tree and apply ONLY the enabled rules listed below.
6. Compute the score using proportional scoring (see below).
7. Call submit_report with the completed report.
8. If any tool returns { cancelled: true }, stop immediately and tell the user "Review cancelled."

## CRITICAL SCOPING RULES — READ BEFORE ANALYZING

### Exclude device/system chrome entirely
Mobile status bars, browser chrome, device frames, home indicators, notch elements, and similar system UI elements are NOT part of the designer's actual UI. Skip any node whose name matches: status-bar, status bar, iPhone, Android, Notch, home-indicator, home indicator, Network Signal, WiFi, Battery, Time / Light, Time / Dark, Indicator /, URL bar, browser-chrome.
HARD RULE: These elements must NEVER appear in the report under any category, for any reason. Do not mention them, do not flag issues on them, do not count them in scores.

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
- iPhone, Notch, Status Icons, Status Bar, status-bar, Network Signal, WiFi, Battery, Time / Light, Time / Dark, Indicator, home-indicator
- No action required, No action needed, Minimal impact, Low impact, be aware that, verify that, note that, confirm that
- extends beyond, overflow, layout mismatch, outside container bounds (when about scrollable content)
- sizing variables, sizing tokens, tokenize width, tokenize height, bind width, bind height, size token, dimensional tokens

## NOTES
- Limit offenders to 30 per rule to keep payloads manageable.
- The detail string should explain the violation, e.g. "SOLID fill #FF0000 has no bound variable or style".
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
    if (msg.type === "ui-ready") {
      await loadPrefs();
      try {
        const m = await figma.clientStorage.getAsync("figma-ai-score.mode");
        if (m === "ai" || m === "simple") reviewMode = m;
      } catch (e) {}
      figma.ui.postMessage({ type: "prefs", data: prefs });
      pushSelection();
      return;
    }
    if (msg.type === "set-prefs") {
      await savePrefs(msg.data);
      figma.ui.postMessage({ type: "prefs", data: prefs });
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
      const frameReports = [];
      for (const f of summary.frames) {
        const node = figma.getNodeById(f.id);
        if (!node) continue;
        const tree = extractNode(node);
        const result = lintFrame(tree, lintRules);
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
    return;
  }

  const { id, method, params } = msg;
  try {
    const result = await handleRpc(method, params || {});
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
      return {
        fileName: figma.root.name,
        pageName: figma.currentPage.name,
        root: { id: node.id, name: node.name, type: node.type },
        tree,
        thumbnail,
        thumbError
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

const DEVICE_CHROME_RE = /status[- ]bar|\biphone\b|\bandroid\b|\bnotch\b|home[- ]indicator|network signal|\bwifi\b|\bbattery\b|time \/ light|time \/ dark|indicator \/|url bar|browser[- ]chrome/i;
const IGNORE_PDATA_KEY = "figma-ai-score-ignored";

function isDeviceChrome(node) {
  return !!(node && node.name && DEVICE_CHROME_RE.test(node.name));
}
function isExplicitlyIgnored(node) {
  // Ground truth is the plugin-data flag, read at extractNode time into `node.ignored`.
  return !!(node && node.ignored === true);
}
function isExcluded(node) {
  return isDeviceChrome(node) || isExplicitlyIgnored(node);
}
function isInstance(node) {
  return !!(node && (node.type === "INSTANCE" || node.isInstance === true));
}
function isComponentContainer(node) {
  return isInstance(node) || node.type === "COMPONENT" || node.type === "COMPONENT_SET";
}

// Walk designer-owned descendants. Skips device chrome. Does NOT descend into
// INSTANCE children (library internals). Calls visit(node, isRoot, ancestors).
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
function lintColors(root) {
  const offenders = [];
  let totalChecked = 0;
  walkDesignerNodes(root, (node) => {
    // Only SOLID fills can be tokenized. Image/video/gradient fills are skipped
    // (they don't carry color tokens). A layer with only an image fill and no
    // SOLID fill produces nothing to check.
    for (const f of (node.fills || [])) {
      if (f.type !== "SOLID" || f.visible === false) continue;
      totalChecked++;
      if (!f.boundVariable && !node.fillStyleId) {
        offenders.push({ nodeId: node.id, name: node.name, detail: `Fill ${f.color || ""} is not using a color token or style.` });
      }
    }
    for (const s of (node.strokes || [])) {
      if (s.type !== "SOLID" || s.visible === false) continue;
      totalChecked++;
      if (!s.boundVariable && !node.strokeStyleId) {
        offenders.push({ nodeId: node.id, name: node.name, detail: `Stroke ${s.color || ""} is not using a color token or style.` });
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

// ── spacing rule (per-property zero-pass) ──
function lintSpacing(root) {
  const offenders = [];
  let totalChecked = 0;
  walkDesignerNodes(root, (node, isRoot) => {
    if (isRoot) return;
    if (!node.autolayout) return;
    if (isInstance(node)) return;
    if (node.type === "COMPONENT_SET") return;
    totalChecked++;
    const al = node.autolayout;
    const b = al.bound || {};
    // Fixed-height atom exemption: buttons, chips, inputs — when height is
    // fixed and top == bottom padding, those paddings are derived from
    // height (content-centered), not an independent design decision.
    const skipVertical = al.sizingVertical === "FIXED" && al.paddingTop === al.paddingBottom;
    const props = ["paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "itemSpacing"];
    const failed = [];
    for (const p of props) {
      if (skipVertical && (p === "paddingTop" || p === "paddingBottom")) continue;
      const val = al[p];
      if (val === 0 || val === null || val === undefined) continue; // zero is fine
      if (!b[p]) failed.push(p);
    }
    if (failed.length) {
      offenders.push({
        nodeId: node.id,
        name: node.name,
        detail: `${failed.join(", ")} not using a spacing token.`
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
function lintFrame(tree, enabledRules) {
  const breakdown = {};
  if (enabledRules.components) breakdown.components = lintComponents(tree);
  if (enabledRules.colors) breakdown.colors = lintColors(tree);
  if (enabledRules.typography) breakdown.typography = lintTypography(tree);
  if (enabledRules.spacing) breakdown.spacing = lintSpacing(tree);
  if (enabledRules.effects) breakdown.effects = lintEffects(tree);
  if (enabledRules.naming) breakdown.naming = lintNaming(tree);

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
  }
  if ("strokes" in node && Array.isArray(node.strokes)) {
    out.strokes = node.strokes.map(serializePaint);
    out.strokeStyleId = node.strokeStyleId || null;
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
