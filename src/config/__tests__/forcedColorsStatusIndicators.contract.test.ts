import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, "../../..");
const INDEX_CSS = path.join(REPO_ROOT, "src/index.css");
const TOOLBAR_CSS = path.join(REPO_ROOT, "src/styles/components/toolbar.css");
const SIDEBAR_CSS = path.join(REPO_ROOT, "src/styles/components/sidebar.css");

// Issue #8936: status indicators (toolbar pips, ActivityLight) and the
// SettingsSwitch toggle lose all state in forced-colors / Windows High Contrast
// mode because the UA strips background-color and box-shadow. The fix lives in
// `@media (forced-colors: active)` blocks using system-color keywords. These
// rules are invisible to jsdom rendering, so we guard them by asserting their
// presence (scoped to the forced-colors block) in CSS source — a regression in
// the cascade would silently re-break HC users otherwise.

function readForcedColorsBlocks(file: string): string {
  const content = fs.readFileSync(file, "utf8");
  const blocks: string[] = [];
  const marker = "@media (forced-colors: active)";

  let searchFrom = 0;
  for (;;) {
    const start = content.indexOf(marker, searchFrom);
    if (start === -1) break;

    // Walk braces from the block's opening `{` to its matching close so we only
    // assert on rules that actually live inside the forced-colors media query.
    const open = content.indexOf("{", start);
    if (open === -1) break;
    let depth = 0;
    let end = open;
    for (let i = open; i < content.length; i++) {
      if (content[i] === "{") depth++;
      else if (content[i] === "}") {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    blocks.push(content.slice(open, end + 1));
    searchFrom = end + 1;
  }

  return blocks.join("\n");
}

describe("forced-colors status-indicator contract (#8936)", () => {
  it("index.css repaints severity glyphs coloured on the SVG itself", () => {
    const block = readForcedColorsBlocks(INDEX_CSS);
    // Chromium forces an inherited currentColor but not a colour set on the
    // SVG, so both the marker and a status utility on the svg must be caught,
    // and !important must beat the banner glyph's inline colour.
    const rule = block.match(/([^{}]*)\{[^}]*color:\s*CanvasText\s*!important[^}]*\}/g) ?? [];
    const selectors = rule.join("\n");
    expect(selectors).toContain("[data-severity-glyph]");
    expect(selectors).toMatch(/svg\[class\*="-status-"\]/);
  });

  it("index.css repaints the ActivityLight active dot with CanvasText !important", () => {
    const block = readForcedColorsBlocks(INDEX_CSS);
    expect(block).toContain('[data-activity-active="true"]');
    // !important is load-bearing: it must beat the inline author background-color
    // the UA otherwise forces to Canvas. Removing it silently re-breaks the fix.
    expect(block).toMatch(
      /\[data-activity-active="true"\]\s*\{[^}]*background-color:\s*CanvasText[^}]*!important/
    );
  });

  // #11988: the notification inbox row's unread dot and thread-count chip are
  // both solid backgrounds, so forced colors pushed them to Canvas. The dot is
  // the more serious of the two — an unread row deliberately carries no border
  // and no background tint, and an untitled one has no title to embolden, so
  // losing the dot left that row with no unread indication at all.
  it("index.css repaints the inbox unread dot with CanvasText !important", () => {
    const block = readForcedColorsBlocks(INDEX_CSS);
    expect(block).toContain('[data-notification-unread="true"]');
    // !important for the same reason ActivityLight needs it: it has to beat the
    // background-color the UA otherwise forces to Canvas.
    expect(block).toMatch(
      /\[data-notification-unread="true"\]\s*\{[^}]*background-color:\s*CanvasText[^}]*!important/
    );
  });

  it("index.css gives the inbox thread-count chip a border in forced colors", () => {
    const block = readForcedColorsBlocks(INDEX_CSS);
    expect(block).toContain('[data-notification-count="true"]');
    // A border, not a background: borders survive the override, backgrounds do
    // not. Without it the count renders as a bare numeral running on from the
    // title instead of as a chip.
    expect(block).toMatch(/\[data-notification-count="true"\]\s*\{[^}]*border:[^}]*CanvasText/);
  });

  it("index.css gives the checked SettingsSwitch track a Highlight fill", () => {
    const block = readForcedColorsBlocks(INDEX_CSS);
    expect(block).toContain('[role="switch"][data-state="checked"]');
    expect(block).toMatch(/\[role="switch"\]\[data-state="checked"\]\s*\{[^}]*Highlight/);
  });

  it("index.css contrasts the switch thumb in both states", () => {
    const block = readForcedColorsBlocks(INDEX_CSS);
    expect(block).toMatch(/span\[data-state="checked"\]\s*\{[^}]*HighlightText/);
    expect(block).toMatch(/span\[data-state="unchecked"\]\s*\{[^}]*ButtonText/);
  });

  // #11262: the deleted-worktree row's separator moved from a `border-b` to a
  // painted element so the countdown could drain along the same 1px rule.
  // Borders survive forced-colors; backgrounds are forced to Canvas — so
  // without an explicit repaint the separator disappears for HC users, a
  // regression the old border didn't have.
  it("sidebar.css repaints the deleted-row separator and its countdown fill", () => {
    const block = readForcedColorsBlocks(SIDEBAR_CSS);
    expect(block).toMatch(/\.deleted-worktree-separator\s*\{[^}]*background-color:\s*CanvasText/);
    expect(block).toMatch(
      /\.deleted-worktree-countdown-fill\s*\{[^}]*background-color:\s*Highlight/
    );
  });

  it("toolbar.css repaints every pip type with CanvasText", () => {
    const block = readForcedColorsBlocks(TOOLBAR_CSS);
    // All pip selectors must share a rule whose body sets background-color.
    expect(block).toMatch(
      /\.toolbar-badge\b[\s\S]*\.toolbar-badge-chip\b[\s\S]*\.toolbar-overflow-badge\b[\s\S]*\.toolbar-problems-badge\b\s*\{[^}]*background-color:\s*CanvasText/
    );
  });
});

// #12000: forty-odd status marks across the app were an empty span whose only
// visual was a background colour, so forced colors rendered every one of them as
// nothing. The fix is one shared `.status-mark` hook repainted in the same block
// — but a rule with no emitter is as silent a regression as an emitter with no
// rule, so both halves are guarded here.
describe("forced-colors shared status-mark contract (#12000)", () => {
  it("index.css repaints the shared status mark with CanvasText !important", () => {
    const block = readForcedColorsBlocks(INDEX_CSS);
    // !important for the reason ActivityLight needs it: it has to beat the
    // author background the UA otherwise forces to Canvas.
    expect(block).toMatch(/\.status-mark\s*\{[^}]*background-color:\s*CanvasText[^}]*!important/);
  });

  // Canvas and ButtonFace are the same colour in the stock high-contrast themes,
  // so dropping this rule looks harmless in testing and only breaks for users on
  // a palette that separates them.
  it("repaints marks inside a control with ButtonText, the pair that matches ButtonFace", () => {
    const block = readForcedColorsBlocks(INDEX_CSS);
    expect(block).toMatch(
      /button\s+\.status-mark,[\s\S]{0,80}?\.status-mark\s*\{[^}]*background-color:\s*ButtonText[^}]*!important/
    );
  });

  it("does not reach for forced-color-adjust, which would opt out of the user's palette", () => {
    const block = readForcedColorsBlocks(INDEX_CSS);
    const rule = block.match(/\.status-mark\s*\{([^}]*)\}/);
    expect(rule).not.toBeNull();
    expect(rule?.[1]).not.toMatch(/forced-color-adjust/);
  });

  // The plugin dot is the sharpest case: `host.setPanelBadge` lets a plugin ask
  // for a bare dot with no adjacent text, so without the hook a forced-colors
  // user sees nothing where the plugin reported something.
  it("is actually emitted: the plugin panel dot carries the class the rule targets", () => {
    const badges = fs.readFileSync(
      path.join(REPO_ROOT, "src/components/Panel/PluginPanelBadges.tsx"),
      "utf8"
    );
    // Bound to the className the dot branch actually builds, not a loose
    // substring — a passing mention in a comment would prove nothing.
    expect(badges).toMatch(/className=\{`[^`]*\bstatus-mark\b[^`]*\$\{DOT_COLOR\[/);
  });

  // Whatever `DOT_COLOR` resolves to is still a background, so the hook stays
  // load-bearing; if that map ever stops painting backgrounds this assertion
  // should be revisited rather than deleted.
  it("still needs the hook: the plugin dot is painted as a background, not a glyph", () => {
    const badges = fs.readFileSync(
      path.join(REPO_ROOT, "src/components/Panel/PluginPanelBadges.tsx"),
      "utf8"
    );
    const map = badges.match(/const DOT_COLOR[^=]*=\s*\{([^}]*)\}/);
    expect(map).not.toBeNull();
    const values = [...(map?.[1] ?? "").matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
    expect(values.length).toBeGreaterThan(0);
    expect(values.every((v) => v.startsWith("bg-"))).toBe(true);
  });
});

// A 2px ButtonText border is the forced-colours marker for "this is the one
// that matters" (destructive, a notification's primary action). The block also
// pins every other button back to 1px with a selector at (0,1,1), which outranks
// a bare attribute hook at (0,1,0) — so any hook the pin-back does not exempt is
// silently flattened to match its neighbours.
describe("forced-colors heavier-border hooks survive the 1px pin-back", () => {
  // The hooks that land on buttons. Hooks on non-button elements (the segmented
  // thumb is a span) are out of the pin-back's reach and need no exemption.
  const BUTTON_HOOKS = ['[data-variant="destructive"]', '[data-notification-action="primary"]'];

  it("exempts every button hook that asserts a 2px ButtonText border", () => {
    const blocks = readForcedColorsBlocks(INDEX_CSS).replace(/'/g, '"');
    const pin = blocks.match(/html\s*:where\([^)]*\):not\(([^)]*)\)\s*\{\s*border-width:\s*1px/);
    expect(pin).not.toBeNull();
    for (const hook of BUTTON_HOOKS) {
      const escaped = hook.replace(/[[\]"]/g, "\\$&");
      expect(blocks).toMatch(
        new RegExp(`${escaped}\\s*\\{[^}]*border:\\s*2px\\s+solid\\s+ButtonText`)
      );
      expect(pin![1]).toContain(hook);
    }
  });

  it("is emitted by the grid bar for its notification actions", () => {
    const bar = fs.readFileSync(
      path.join(REPO_ROOT, "src/components/Terminal/GridNotificationBar.tsx"),
      "utf8"
    );
    expect(bar).toMatch(/data-notification-action=\{/);
  });
});

// #11981: a destructive button is distinguished from Cancel only by its fill,
// and forced-colors replaces every fill with a system colour — so the two
// render as identical pills and nothing marks which one destroys. The fallback
// is a heavier border (stroke weight is one of the few things the UA leaves
// alone) keyed off `data-variant`, which `Button` emits. Both halves are
// guarded: a rule with no emitter, or an emitter with no rule, is a silent
// regression for High Contrast users.
describe("forced-colors destructive button distinction (#11981)", () => {
  it("keeps a heavier border on the destructive variant inside the forced-colors block", () => {
    const blocks = readForcedColorsBlocks(INDEX_CSS);
    const rule =
      /button\[data-variant=["']destructive["']\]\s*\{[^}]*border:\s*2px\s+solid\s+ButtonText/;
    expect(blocks).toMatch(rule);
  });

  it("does not use outline for that distinction — the focus ring owns outline and would win", () => {
    const blocks = readForcedColorsBlocks(INDEX_CSS);
    const match = blocks.match(/button\[data-variant=["']destructive["']\]\s*\{([^}]*)\}/);
    expect(match).not.toBeNull();
    expect(match?.[1]).not.toMatch(/outline\s*:/);
  });

  it("is actually emitted: Button renders the data-variant attribute the rule targets", () => {
    const button = fs.readFileSync(path.join(REPO_ROOT, "src/components/ui/button.tsx"), "utf8");
    expect(button).toMatch(/data-variant=\{/);
  });

  // The destructive focus ring used to be `focus-visible:outline-destructive`,
  // which resolves through the same variable chain as `bg-destructive` — a
  // focus indicator in exactly the colour of the thing it indicates.
  it("does not paint the destructive focus ring in the button's own fill colour", () => {
    const button = fs.readFileSync(path.join(REPO_ROOT, "src/components/ui/button.tsx"), "utf8");
    expect(button).not.toMatch(/focus-visible:outline-destructive/);
  });
});

describe("forced-colors stroked agent-state glyphs", () => {
  // Inherit, not a named system colour: the parent's forced ink is the pair
  // the UA already matched to that surface, which a role cannot tell us.
  it("hands the stroked state circles their parent's forced ink, not their state hue", () => {
    const block = readForcedColorsBlocks(INDEX_CSS);
    expect(block).toMatch(/\[data-agent-state-glyph\]\s*\{[^}]*color:\s*inherit/);
    expect(block).not.toMatch(/\[data-agent-state-glyph\][^{]*\{[^}]*(CanvasText|ButtonText)/);
  });

  it("is actually emitted by every stroked circle", () => {
    const source = fs.readFileSync(
      path.join(REPO_ROOT, "src/components/icons/AgentStateCircles.tsx"),
      "utf8"
    );
    const svgs = source.match(/<svg\s[\s\S]*?>/g) ?? [];
    expect(svgs.length).toBeGreaterThan(0);
    for (const svg of svgs) expect(svg).toContain("data-agent-state-glyph");
  });
});

describe("forced-colors resource glyphs", () => {
  // The CPU line and the amber/red band marks carry their hue on the svg
  // itself, so without the hook the hue survives onto the forced canvas.
  it("hands resource glyphs their parent's forced ink, not their band hue", () => {
    const block = readForcedColorsBlocks(INDEX_CSS);
    expect(block).toMatch(/\[data-resource-glyph\]\s*\{[^}]*color:\s*inherit/);
  });

  it("is actually emitted wherever a resource readout tints a glyph", () => {
    for (const file of [
      "src/components/Terminal/TerminalResourceSparkline.tsx",
      "src/components/Terminal/TerminalHeaderContent.tsx",
      "src/components/Project/ProjectResourceBadge.tsx",
    ]) {
      const source = fs.readFileSync(path.join(REPO_ROOT, file), "utf8");
      const tinted = source.match(
        /<(svg|Icon|TriangleAlert|OctagonAlert)\s[^>]*text-status-[^>]*>/g
      );
      const hooked = source.match(
        /<(svg|Icon|TriangleAlert|OctagonAlert)\s[^>]*data-resource-glyph[^>]*>/g
      );
      expect(hooked?.length ?? 0, file).toBeGreaterThan(0);
      for (const tag of tinted ?? []) expect(tag, file).toContain("data-resource-glyph");
    }
  });
});
