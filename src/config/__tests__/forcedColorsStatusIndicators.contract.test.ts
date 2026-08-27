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
