import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The sidebar's quick state filter and Pilot's filter bar are one control
// drawn twice: same glyphs, same active underline, and the same dimmed glyph
// for an empty bucket. The dimming step drifted once already — each bar spelled
// its own per-hue `text-<hue>/N` literals, one was retuned and the other kept
// the old alpha. Both now dim through one shared class whose step lives in
// `index.css`, beside the contrast-mode resets; this keeps it that way.
//
// Read from source because the thing being guarded is how the bars are
// written, not what either renders today.

const here = path.dirname(fileURLToPath(import.meta.url));
const BARS = [
  path.resolve(here, "../QuickStateFilterBar.tsx"),
  path.resolve(here, "../../Pilot/PilotFilterBar.tsx"),
];

const read = (file: string) => fs.readFileSync(file, "utf8");

/** The body of every top-level-or-nested `@media (<query>)` block in a stylesheet. */
function mediaBlocks(css: string, query: string): string[] {
  const blocks: string[] = [];
  let from = 0;
  for (;;) {
    const start = css.indexOf(`@media (${query})`, from);
    if (start === -1) return blocks;
    const open = css.indexOf("{", start);
    let depth = 0;
    let i = open;
    do {
      if (css[i] === "{") depth += 1;
      else if (css[i] === "}") depth -= 1;
      i += 1;
    } while (depth > 0 && i < css.length);
    blocks.push(css.slice(open, i));
    from = i;
  }
}

describe("quick state filter empty-glyph dimming", () => {
  it("dims an empty glyph through the shared class in both bars", () => {
    for (const bar of BARS) expect(read(bar)).toMatch(/EMPTY_BUCKET_GLYPH_CLASS/);
  });

  it("never spells a per-hue slash-alpha tone for a glyph in either bar", () => {
    const TONE_WITH_ALPHA =
      /"text-(?:state-[a-z]+|category-[a-z]+|status-[a-z]+|text-[a-z]+)\/\d+"/g;
    for (const bar of BARS) {
      expect(read(bar).match(TONE_WITH_ALPHA) ?? [], path.basename(bar)).toEqual([]);
    }
  });

  it("dims an empty glyph without hiding it, and restores it in both contrast modes", () => {
    const css = read(path.resolve(here, "../../../index.css"));
    const base = css.match(/\n\.quick-state-glyph-empty \{\s*opacity: ([\d.]+);/);
    expect(base, "no base dimming rule").not.toBeNull();
    const step = Number(base![1]);
    expect(step).toBeGreaterThan(0);
    expect(step).toBeLessThan(1);

    // Every mark at full strength when the user asked for more contrast, in
    // each of the two blocks the file keeps separate on purpose.
    for (const media of ["prefers-contrast: more", "forced-colors: active"]) {
      const resets = mediaBlocks(css, media).filter((block) =>
        /\.quick-state-glyph-empty \{\s*opacity: 1;/.test(block)
      );
      expect(resets, `@media (${media}) does not restore the glyph`).toHaveLength(1);
    }
  });

  it("keeps the selected segment visible under forced colors in both bars", () => {
    // The selection underline is a box-shadow, which forced colors removes.
    const css = read(path.resolve(here, "../../../index.css"));
    const redraws = mediaBlocks(css, "forced-colors: active").filter((block) =>
      /\[data-quick-state-segment\]\[aria-pressed="true"\]::after/.test(block)
    );
    expect(redraws).toHaveLength(1);
    expect(redraws[0]).toMatch(/\[data-quick-state-segment\]\[aria-checked="true"\]::after/);
    for (const bar of BARS) expect(read(bar)).toMatch(/data-quick-state-segment/);
  });
});
