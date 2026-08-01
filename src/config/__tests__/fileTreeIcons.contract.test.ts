import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, "../../..");
const INDEX_CSS = path.join(REPO_ROOT, "src/index.css");

// Issue #11596: the file-browser tree tints file icons with category-* hues so
// types separate at a glance. Those hues are tuned for restrained chroma, not
// for maximum contrast, so Increase Contrast repaints them monochrome — the
// glyph shapes already carry the type, and the hue is the expendable half.
// jsdom never evaluates media queries, so the rule is guarded here in source.

/** Bodies of every `@media (<query>)` block in a stylesheet, brace-matched. */
function readMediaBlocks(file: string, query: string): string {
  const content = fs.readFileSync(file, "utf8");
  const marker = `@media (${query})`;
  const blocks: string[] = [];

  let searchFrom = 0;
  for (;;) {
    const start = content.indexOf(marker, searchFrom);
    if (start === -1) break;

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

describe("file-tree icon contrast contract (#11596)", () => {
  it("repaints entry icons with the solid text token under Increase Contrast", () => {
    const block = readMediaBlocks(INDEX_CSS, "prefers-contrast: more");
    expect(block).toContain(".file-tree-entry-icon");
    // !important is load-bearing: the Tailwind `text-category-*` utility has
    // equal specificity (0,1,0) and would win on source order without it.
    expect(block).toMatch(/\.file-tree-entry-icon\s*\{[^}]*color:[^;}]*!important/);
  });

  it("leaves the icons opted in to forced-colors", () => {
    // These icons paint from `currentColor`, and forced-colors already forces
    // `color` to a system keyword — so no rule is needed there, but opting out
    // with `forced-color-adjust: none` would strand High Contrast users on the
    // category hues. Guard the absence.
    const block = readMediaBlocks(INDEX_CSS, "forced-colors: active");
    expect(block).not.toMatch(/\.file-tree-entry-icon\s*\{[^}]*forced-color-adjust:\s*none/);
  });

  it("keeps the two contrast blocks separate", () => {
    // macOS fires only prefers-contrast; Windows swaps in system colors via
    // forced-colors. Consolidating them silently drops one platform.
    const content = fs.readFileSync(INDEX_CSS, "utf8");
    expect(content).toContain("@media (prefers-contrast: more)");
    expect(content).toContain("@media (forced-colors: active)");
    expect(content).not.toMatch(/@media\s*\([^)]*prefers-contrast[^)]*\)\s*and\s*\(forced-colors/);
  });
});
