// @vitest-environment node
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Two layout rules the composer regressed on, pinned as rules rather than as
 * values so a future redesign restates them instead of churning them.
 *
 * 1. **The controls anchor to an edge of the canvas, never its midpoint.** The
 *    shell was `items-center`, so the `❯` and the trailing buttons tracked the
 *    middle of a growing draft — the attach target sat at a different height
 *    for every draft length, and in a bottom-pinned pane it slid upward as the
 *    user typed.
 *
 * 2. **Every control in the composer meets the WCAG 2.5.8 24px floor.** The
 *    stash button was 20px and the `❯` 20px tall, both crowded by neighbours
 *    close enough that the spacing exception cannot rescue them.
 *
 * Source enforcement rather than a rendering assertion, matching the sibling
 * `dropTargets` contract: standing up the whole bar, CodeMirror and its stores
 * to measure two buttons buys very little over reading the classes, and the
 * classes are where both defects actually lived.
 */

const BAR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "HybridInputBar.tsx");

function source(): string {
  return fs.readFileSync(BAR, "utf8");
}

/**
 * The file with `//` comments removed.
 *
 * Every rule below is about what the component *declares*, and the comments
 * beside those declarations necessarily name the utility that was replaced
 * ("`items-end` rather than `items-center`", "at `h-5 w-5` this was…"). Reading
 * them makes the contract fail on its own rationale, which is how the first
 * version of this test failed twice.
 */
function declarations(): string {
  return source().replace(/^[ \t]*\/\/.*$/gm, "");
}

/**
 * The declared height, in Tailwind steps, of every `<button>` the bar renders.
 *
 * Scoped to the span between each button's `className` and its `aria-label`,
 * which every one of them carries in that order. Two things are deliberately
 * out of that window: the icon glyphs nested inside the button (`h-3.5`, and
 * the `h-4 w-4` submit spinner), and any explanatory comment above the
 * `className` — a comment naming the old size is prose, not a declaration, and
 * reading it would make this test fail on its own documentation.
 *
 * Decimal utilities are excluded too: `h-3.5` must not read as `h-3`.
 */
function buttonHeights(text: string): number[] {
  return text
    .split("<button")
    .slice(1)
    .map((part) => {
      const region = part.slice(0, part.indexOf("aria-label"));
      const declaration = region.slice(region.indexOf("className"));
      const match = /\bh-(\d+)(?![\d.])/.exec(declaration);
      return match ? Number(match[1]) : null;
    })
    .filter((height): height is number => height !== null);
}

describe("HybridInputBar layout contract", () => {
  it("anchors the shell's controls to an edge, never the canvas midpoint", () => {
    const text = declarations();
    const shell = text.slice(text.indexOf("group/shell relative"));
    const classes = shell.slice(0, shell.indexOf("transition-["));

    expect(classes).toMatch(/\bitems-(end|start)\b/);
    expect(classes).not.toMatch(/\bitems-center\b/);
  });

  it("keeps every button target at or above the 24px floor", () => {
    // Tailwind's scale is 4px per step, so the WCAG 2.5.8 24px floor is `h-6`.
    // The composer's controls sit shoulder to shoulder, so the spacing
    // exception cannot rescue an undersized one.
    const FLOOR_STEPS = 6;
    const heights = buttonHeights(declarations());

    // The picker, attach and stash buttons. The mic declares its own size in
    // `VoiceInputButton.tsx`.
    expect(heights.length).toBeGreaterThanOrEqual(3);
    expect(heights.filter((height) => height < FLOOR_STEPS)).toEqual([]);
  });

  it("stacks the trailing controls on both a width and a wrap signal, not width alone", () => {
    const text = declarations();

    // A container-width condition...
    expect(text).toMatch(/@max-\[[^\]]+\]\/composer:/);
    // ...that is itself qualified by the multiline marker. Width alone put a
    // near-empty button row under every pane of a tiled fleet.
    expect(text).toMatch(/group-has-\[\[data-composer-multiline\]\]\/shell:/);
  });

  it("gives the canvas track a zero min-width so it can actually shrink", () => {
    // Flex items default to `min-width: auto`, which stops the canvas
    // shrinking past its longest unbreakable token.
    expect(declarations()).toMatch(/className="relative min-w-0 flex-1"/);
  });
});
