import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, "../../..");
const INDEX_CSS = path.join(REPO_ROOT, "src/index.css");
const TOOLBAR_CSS = path.join(REPO_ROOT, "src/styles/components/toolbar.css");

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
  it("index.css repaints the ActivityLight active dot with CanvasText", () => {
    const block = readForcedColorsBlocks(INDEX_CSS);
    expect(block).toContain('[data-activity-active="true"]');
    expect(block).toMatch(/\[data-activity-active="true"\]\s*\{[^}]*CanvasText/);
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

  it("toolbar.css repaints badge pips with CanvasText", () => {
    const block = readForcedColorsBlocks(TOOLBAR_CSS);
    expect(block).toContain(".toolbar-badge");
    expect(block).toContain(".toolbar-overflow-badge");
    expect(block).toContain(".toolbar-problems-badge");
    expect(block).toContain("CanvasText");
  });

  it("toolbar.css replaces the stripped overflow ring with an outline", () => {
    const block = readForcedColorsBlocks(TOOLBAR_CSS);
    expect(block).toContain('[data-severity="warning"]');
    expect(block).toContain('[data-severity="info"]');
    expect(block).toMatch(/outline:\s*1px solid CanvasText/);
    expect(block).toMatch(/outline-offset:\s*-1px/);
  });
});
