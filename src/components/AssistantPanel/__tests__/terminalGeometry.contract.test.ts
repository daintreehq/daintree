import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * The panel's geometry has to behave like a terminal's, and two rules carry that.
 *
 * Both are stated as RELATIONSHIPS rather than as numbers on purpose. Every figure in
 * this stylesheet is a design decision that will be revisited — the gutter, the leading,
 * the mark column — and a test asserting `0.85em` would have to be edited in lockstep
 * with the thing it claims to protect, which makes it worth nothing. What must not
 * change is that the panel scales with the terminal, and that grid content is denser
 * than prose.
 */

const CSS = readFileSync(path.join(__dirname, "..", "assistant-panel.css"), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  ""
);

/**
 * One `prop: value;` declaration per entry, comments already stripped, and with the
 * inside of every `var()` removed.
 *
 * A custom property's FALLBACK is allowed to be absolute and in one place has to be:
 * `var(--assistant-font-size, 12px)` is the first paint before the terminal's real size
 * hydrates, and the alternative to a px there is inheriting the browser's 16px and
 * rendering the whole rail a third larger than the pane beside it. What the rules below
 * are looking for is an absolute unit written as the VALUE, so the fallback is not a
 * hole in them — it is a different thing that happens to contain a number.
 */
function declarations(): { prop: string; value: string }[] {
  const out: { prop: string; value: string }[] = [];
  for (const match of CSS.matchAll(/([a-z-]+)\s*:\s*([^;{}]+);/g)) {
    const prop = match[1] ?? "";
    const value = match[2] ?? "";
    out.push({ prop: prop.trim(), value: value.replace(/var\([^)]*\)/g, "var()").trim() });
  }
  return out;
}

describe("assistant panel geometry tracks the terminal font", () => {
  /**
   * The panel is sized from `--assistant-font-size`, a live user setting pushed in from
   * the terminal. Anything measured in `px` or `rem` holds still while the text around
   * it grows, so the rail stops matching the pane beside it the moment somebody changes
   * their type size — which is the entire reason this surface uses `em` at all.
   *
   * Hairlines and focus rings are exempt and named as such: a 1px rule is one device
   * pixel by intent, and scaling it would only blur it.
   */
  const SCALES_WITH_TYPE = [
    "padding",
    "padding-top",
    "padding-bottom",
    "padding-left",
    "padding-right",
    "padding-inline",
    "padding-block",
    "margin",
    "margin-top",
    "margin-bottom",
    "margin-left",
    "margin-right",
    "margin-inline",
    "margin-block",
    "gap",
    "row-gap",
    "column-gap",
    "min-height",
    "height",
    "font-size",
  ];

  it("never sizes spacing or type in px", () => {
    const offenders = declarations()
      .filter((d) => SCALES_WITH_TYPE.includes(d.prop))
      .filter((d) => /(?:^|[\s(])-?[\d.]+px/.test(d.value))
      .map((d) => `${d.prop}: ${d.value}`);
    expect(offenders).toEqual([]);
  });

  it("never sizes spacing or type in rem", () => {
    // `rem` is pinned to the document root, so it is a `px` wearing a relative unit's
    // clothing as far as this panel is concerned.
    const offenders = declarations()
      .filter((d) => SCALES_WITH_TYPE.includes(d.prop))
      .filter((d) => /(?:^|[\s(])-?[\d.]+rem/.test(d.value))
      .map((d) => `${d.prop}: ${d.value}`);
    expect(offenders).toEqual([]);
  });
});

describe("grid content is denser than prose", () => {
  function lineHeightOf(selector: string): number {
    const block = CSS.match(
      new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`)
    );
    if (!block) throw new Error(`no rule found for ${selector}`);
    const lh = block[1]!.match(/line-height:\s*([\d.]+)\s*;/);
    if (!lh) throw new Error(`no line-height in ${selector}`);
    return Number(lh[1]);
  }

  /**
   * A fenced block is a character GRID — an ASCII tree, a table, a diagram, the output
   * of any tool that draws one — and prose leading leaves gaps between the rows of it
   * that break every vertical stroke. This is the same reason the terminal beside the
   * panel runs its own grid at 1.0; the panel takes prose's licence for prose only.
   *
   * The assertion is the ordering, not either figure: prose may be loosened and the
   * fence may be tightened, but a fence set looser than the paragraph above it is the
   * defect, whatever the numbers are.
   */
  it("sets fenced code tighter than paragraph prose", () => {
    expect(lineHeightOf(".assistant-prose pre")).toBeLessThan(lineHeightOf(".assistant-prose"));
  });

  /**
   * And sets it on the element that can actually enforce it.
   *
   * This is the check that was missing, and its absence is why the first attempt at the
   * rule above shipped doing nothing. The leading was declared on `.assistant-prose pre
   * code`, which is INLINE: the `pre` establishes the line box, its own strut is
   * inherited at the prose value, and no line-height on the inline content can pull the
   * pitch below it. Rendered spacing did not move by a pixel while a test comparing
   * declarations reported the fix had landed.
   *
   * jsdom has no layout, so the pitch itself cannot be measured here. What can be
   * asserted is the structural fact the bug turned on: the tighter value belongs on the
   * block.
   */
  it("declares that leading on the pre, which owns the line box", () => {
    expect(() => lineHeightOf(".assistant-prose pre")).not.toThrow();
  });
});
