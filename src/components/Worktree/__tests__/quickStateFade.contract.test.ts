import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The sidebar's quick state filter and Pilot's filter bar are one control
// drawn twice: same glyphs, same active underline, and the same dimmed glyph
// for an empty bucket. The dimming step drifted once already — each bar spelled
// its own per-hue `text-<hue>/N` literals, one was retuned and the other kept
// the old alpha. Both now dim through one shared class whose step lives in
// `index.css`, where it can differ by colour mode; this keeps it that way.
//
// Read from source because the thing being guarded is how the bars are
// written, not what either renders today.

const here = path.dirname(fileURLToPath(import.meta.url));
const BARS = [
  path.resolve(here, "../QuickStateFilterBar.tsx"),
  path.resolve(here, "../../Pilot/PilotFilterBar.tsx"),
];

const read = (file: string) => fs.readFileSync(file, "utf8");

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

  it("gives light themes the lighter step, since their hues start with less headroom", () => {
    const css = read(path.resolve(here, "../../../index.css"));
    const step = (selector: RegExp) => {
      const match = css.match(selector);
      expect(match, `no rule for ${selector}`).not.toBeNull();
      return Number(match![1]);
    };
    const dark = step(/\n\.quick-state-glyph-empty \{\s*opacity: ([\d.]+);/);
    const light = step(
      /:root\[data-color-mode="light"\] \.quick-state-glyph-empty \{\s*opacity: ([\d.]+);/
    );
    expect(dark).toBeLessThan(1);
    expect(light).toBeGreaterThan(dark);
    expect(light).toBeLessThan(1);
  });
});
