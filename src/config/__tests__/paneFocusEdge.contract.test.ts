import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const INDEX_CSS = path.resolve(TEST_DIR, "../../index.css");

// A focused grid pane shows one edge, however its focus arrived. A terminal's
// focus lives in xterm, so its root only ever shows the selected border; a
// non-PTY pane's root takes DOM focus and gets a focus-visible ring. The ring
// must replace the border rather than stack on it — the focus ink is
// translucent on most themes, and two layers of it paint a stronger edge on a
// file browser than on the terminal beside it.

/** Top-level (unnested) declaration blocks whose selector list names `selector`. */
function topLevelBlocks(css: string, selector: string): string[] {
  const blocks: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < css.length; i += 1) {
    const ch = css[i];
    if (ch === "{") {
      if (depth === 0) {
        const prelude = css
          .slice(start, i)
          .replace(/\/\*[\s\S]*?\*\//g, "")
          .trim();
        const selectors = prelude.split(",").map((s) => s.trim());
        if (selectors.includes(selector)) {
          const end = css.indexOf("}", i);
          blocks.push(css.slice(i + 1, end));
        }
      }
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0) start = i + 1;
    } else if (ch === ";" && depth === 0) {
      start = i + 1;
    }
  }
  return blocks;
}

describe("pane focus edge", () => {
  const css = fs.readFileSync(INDEX_CSS, "utf8");

  it("draws a focused root's ring in place of its border, not on top of it", () => {
    const [ring] = topLevelBlocks(css, ".terminal-selected:focus-visible");
    expect(ring, "no top-level .terminal-selected:focus-visible rule").toBeDefined();
    const [selected] = topLevelBlocks(css, ".terminal-selected");
    expect(selected).toBeDefined();

    // The ring is the border's own ink…
    const borderInk = /border-color:\s*([\s\S]*?);/.exec(selected!)?.[1]?.replace(/\s+/g, "");
    const ringInk = /outline:\s*1px solid\s*([\s\S]*?);/.exec(ring!)?.[1]?.replace(/\s+/g, "");
    expect(ringInk).toBe(borderInk);
    // …and the border steps aside while it shows.
    expect(ring).toMatch(/border-color:\s*transparent/);
  });

  it("keeps a focused root's ring inside the pane in forced-colors mode", () => {
    // The global forced-colors `*:focus-visible` rule offsets every ring outward
    // with !important; the pane's ring has to win that back or a focused file
    // browser's edge sits outside the pane while a terminal's sits inside.
    const start = css.indexOf("@media (forced-colors: active)");
    expect(start).toBeGreaterThan(-1);
    const forced = css.slice(start);
    expect(forced).toMatch(
      /\.terminal-selected:focus-visible\s*\{[^}]*outline-offset:\s*-2px\s*!important/
    );
  });
});
