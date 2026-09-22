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
 * The file with comments removed — `//` lines and `{/* … *\/}` JSX blocks.
 *
 * Every rule below is about what the component *declares*, and the comments
 * beside those declarations necessarily name the utility that was replaced
 * ("`items-end` rather than `items-center`", "at `h-5 w-5` this was…"). Reading
 * them makes the contract fail on its own rationale, which is how the first
 * version of this test failed twice. A commented-out `className` would
 * otherwise satisfy a positive match too.
 */
function declarations(): string {
  return source()
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");
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

  it("moves only the trailing group to a rail, and only when wrapped AND narrow", () => {
    const text = declarations();
    const track = /className="[^"]*\bflex-1\b[^"]*"/.exec(text)?.[0] ?? "";
    const trailing = /className="[^"]*\bpr-1\.5\b[^"]*"/.exec(text)?.[0] ?? "";

    // One compound condition on ONE ancestor. Two chained group variants
    // (`group-data-[…]/shell:group-has-[…]/shell:`) are each satisfied by any
    // ancestor carrying that name, so a second `.group/shell` up the tree
    // could satisfy one half each; a single `group-[…]/shell` selector cannot.
    // Wrapped alone put a rail under a three-line draft in an 1800px pane,
    // where the icon column costs 3% and the rail costs a row. Narrow alone
    // would double the height of every one-line composer in a tiled fleet.
    const rail = /group-\[\[data-composer-narrow\]:has\(\[data-composer-multiline\]\)\]\/shell:/;
    expect(trailing).toMatch(new RegExp(rail.source + "basis-full"));
    // The canvas answers the same condition (for its stand-in right inset),
    // so the two can never disagree about which arrangement is showing. The
    // utility it applies is its own business.
    expect(track).toMatch(rail);
    // The canvas stays on the picker's row: it never reorders and never takes
    // a row of its own, so the text column does not shift and the `❯` keeps
    // pointing at the line being typed.
    expect(track).not.toMatch(/\border-/);
    expect(track).not.toMatch(/\bbasis-full\b/);
    expect(text).not.toMatch(/@max-\[[^\]]+\]\/composer:/);
  });

  it("measures the content-sized inner trailing group, never the rail wrapper", () => {
    // The wrapper takes a full basis on the rail, so its width would be the
    // whole row and "narrow" would confirm itself. The ref must sit on an
    // inner group that is sized by its buttons alone: no basis, no growth, no
    // width utility — any of those would make it fill the rail too.
    const text = declarations();
    const inner = /<div ref=\{trailingGroupRef\} className="([^"]*)"/.exec(text)?.[1] ?? "";

    expect(inner).toMatch(/\bshrink-0\b/);
    expect(inner).not.toMatch(/\bbasis-/);
    expect(inner).not.toMatch(/\b(flex-1|grow|flex-grow)\b/);
    expect(inner).not.toMatch(/\bw-(full|screen|\[|\d)/);
  });

  it("gives the canvas track a zero min-width so it can actually shrink", () => {
    // Flex items default to `min-width: auto`, which stops the canvas
    // shrinking past its longest unbreakable token. Matched on the track's
    // distinguishing pair rather than its whole class string, so adding an
    // unrelated utility to it does not fail this.
    const track = /className="[^"]*\bflex-1\b[^"]*"/.exec(declarations())?.[0] ?? "";

    expect(track).toMatch(/\bmin-w-0\b/);
  });

  it("holds the canvas track at the control height so one line stays centred", () => {
    // A single-line canvas is 20px beside 24px controls, so bottom anchoring
    // alone drops it 2px. The track carries the control height instead.
    const track = /className="[^"]*\bflex-1\b[^"]*"/.exec(declarations())?.[0] ?? "";

    expect(track).toMatch(/\bmin-h-6\b/);
    expect(track).toMatch(/\bitems-center\b/);
  });
});
