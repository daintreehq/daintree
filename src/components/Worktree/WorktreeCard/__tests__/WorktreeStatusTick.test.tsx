/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import {
  CHIP_LABELS,
  CHIP_SEGMENTS,
  WorktreeStatusTick,
  type WorktreeStatusTickState,
} from "../WorktreeStatusTick";

/**
 * The card's status tick must not carry its meaning in colour alone
 * (WCAG SC 1.4.1). It is the only place on the card where `cleanup` and
 * `complete` are told apart at all, so if their fills were the whole
 * difference, nothing on screen would distinguish them for a reader who cannot
 * separate those two hues — and under `forced-colors`, where `.status-mark`
 * flattens every state to one system colour, for nobody at all.
 *
 * These assert the RULE — every state is distinguishable without hue — rather
 * than which count belongs to which state. The specific geometry is a design
 * decision and will move; that the states separate without colour is not.
 */
afterEach(cleanup);

/** Derived, not listed: a fourth state joins these tests by existing. */
function isState(key: string): key is WorktreeStatusTickState {
  return key in CHIP_SEGMENTS;
}
const STATES = Object.keys(CHIP_SEGMENTS).filter(isState);

/**
 * The vertical gap between segments, in px.
 *
 * Axis-scoped deliberately: `gap-x-*` satisfies a bare `/^gap-/` and leaves
 * the segments touching, which closes the encoding while every other
 * assertion here still passes.
 */
function readVerticalGap(tick: HTMLElement): number {
  const gap = [...tick.classList].find((c) => /^gap-(y-)?\d/.test(c));
  expect(gap, `no vertical gap on the tick: ${tick.className}`).toBeDefined();
  return readScalePx(gap!);
}

function renderTick(state: WorktreeStatusTickState) {
  render(<WorktreeStatusTick state={state} />);
  const tick = screen.getByTestId("worktree-status-tick");
  const segments = screen.getAllByTestId("worktree-status-tick-segment");
  return { tick, segments };
}

describe("WorktreeStatusTick", () => {
  it("gives every state a different number of segments", () => {
    const counts = STATES.map((state) => {
      const { segments } = renderTick(state);
      cleanup();
      return segments.length;
    });
    expect(new Set(counts).size, `states share a segment count: ${counts.join(" | ")}`).toBe(
      counts.length
    );
  });

  it("gives every state a different fill, so shape and colour agree rather than substitute", () => {
    const fills = STATES.map((state) => {
      const { segments } = renderTick(state);
      const fill = [...segments[0]!.classList].find((c) => c.startsWith("bg-"));
      cleanup();
      return fill;
    });
    expect(fills.every(Boolean), "a state renders no fill at all").toBe(true);
    expect(new Set(fills).size, `states share a fill: ${fills.join(" | ")}`).toBe(fills.length);
  });

  it("names every state, and names it the same way for the tooltip and the screen reader", () => {
    for (const state of STATES) {
      const { tick } = renderTick(state);
      expect(tick.getAttribute("role")).toBe("img");
      expect(tick.getAttribute("aria-label")).toBe(CHIP_LABELS[state]);
      cleanup();
    }
  });

  it("puts the forced-colors hook on every segment and never on the container", () => {
    // `.status-mark` is repainted to a single system colour in forced colors,
    // where hue is gone and the segment count is the entire distinction. On the
    // container that one repaint would fill the slot as a solid bar and take
    // the gaps — and the encoding — with it.
    for (const state of STATES) {
      const { tick, segments } = renderTick(state);
      expect(tick.classList.contains("status-mark"), `${state}: hook is on the container`).toBe(
        false
      );
      for (const segment of segments) {
        expect(segment.classList.contains("status-mark"), `${state}: segment missing hook`).toBe(
          true
        );
      }
      cleanup();
    }
  });

  it("keeps the gaps as real elements, so nothing but geometry has to survive forced colors", () => {
    // Sibling spans with a flex gap, not one element with a patterned
    // background: a background pattern is exactly what forced colors strips.
    const { segments } = renderTick("complete");
    expect(segments.length).toBeGreaterThan(1);
    for (const segment of segments) {
      expect(segment.tagName).toBe("SPAN");
      expect(segment.parentElement?.getAttribute("data-testid")).toBe("worktree-status-tick");
    }
  });

  it("carries its own fixed height rather than taking one from what it sits beside", () => {
    // The mark describes the CARD. Deriving its height from the title row —
    // which is what an `inset-y-0` inside the header does — made it start and
    // end exactly where the title does, and it read as punctuation on that
    // line instead of as a flag on the card.
    const { tick } = renderTick("waiting");
    const height = [...tick.classList].find((c) => /^h-\d/.test(c));
    expect(height, "the tick renders no height of its own").toBeDefined();
    expect(
      [...tick.classList].some((c) => c === "inset-y-0" || /^inset-y-/.test(c)),
      "the tick is stretching to its parent again"
    ).toBe(false);
  });

  it("cuts its slot into whole pixels at every segment count", () => {
    // A segment that lands on a half pixel blurs at 1x, and the blur closes
    // the gaps — which are the entire encoding. Read off what actually
    // rendered, so retuning the height or the gap has to keep the arithmetic
    // working rather than silently softening the mark.
    const { tick } = renderTick("waiting");
    const slot = readScalePx([...tick.classList].find((c) => /^h-\d/.test(c))!);
    const gap = readVerticalGap(tick);
    for (const state of STATES) {
      const count = CHIP_SEGMENTS[state];
      const segment = (slot - gap * (count - 1)) / count;
      expect(
        Number.isInteger(segment),
        `${state}: ${count} segments of a ${slot}px slot are ${segment}px`
      ).toBe(true);
      expect(segment, `${state}: segments too thin to read`).toBeGreaterThanOrEqual(2);
    }
  });

  it("stacks the segments along the slot with a gap wide enough to survive antialiasing", () => {
    // The gaps are the whole signal in forced colors, where the fills are all
    // one system colour — so they have to run ACROSS the mark, which is what
    // stacking the segments buys, and they have to be wide enough to still be
    // there after antialiasing.
    const { tick } = renderTick("complete");
    expect(
      tick.classList.contains("flex-col"),
      `the segments are not stacked along the slot: ${tick.className}`
    ).toBe(true);
    expect(
      readVerticalGap(tick),
      "the gap is too small to survive antialiasing"
    ).toBeGreaterThanOrEqual(2);
  });

  it("holds off the card's edges far enough that the inset outlines cannot reach it", () => {
    // Every full-card outline is inset 2px and continuous — the grid keyboard
    // cursor, the sidebar drop-target ring, the forced-colors row outline.
    // Drawn across the tick, one would bridge its gaps and flatten all three
    // states to a single bar for the reader who has nothing but the gaps left.
    const { tick } = renderTick("complete");
    for (const axis of [/^top-/, /^start-/]) {
      const inset = [...tick.classList].find((c) => axis.test(c));
      expect(inset, `the tick is not positioned on ${String(axis)}`).toBeDefined();
      expect(readScalePx(inset!), `${inset} sits under the 2px inset outlines`).toBeGreaterThan(2);
    }
  });
});

/** A Tailwind spacing utility's value in px (`gap-0.5` -> 2). */
function readScalePx(className: string): number {
  const match = /-(\d+(?:\.\d+)?)$/.exec(className);
  if (match?.[1] === undefined) throw new Error(`not a scale utility: ${className}`);
  return Number(match[1]) * 4;
}
