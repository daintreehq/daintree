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

function renderTick(state: WorktreeStatusTickState, variant?: "sidebar" | "grid") {
  render(<WorktreeStatusTick state={state} variant={variant} />);
  const tick = screen.getByTestId("worktree-status-tick");
  const segments = screen.getAllByTestId("worktree-status-tick-segment");
  return { tick, segments };
}

/** The tick's corner inset in px, read off whichever axis is asked for. */
function readInset(tick: HTMLElement, axis: "top-" | "start-"): number {
  const inset = [...tick.classList].find((c) => c.startsWith(axis));
  expect(inset, `the tick is not positioned on ${axis}: ${tick.className}`).toBeDefined();
  return readScalePx(inset!);
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

  it("sits flush in the corner of a card with no radius to clear", () => {
    // The mark's whole job is to be outside the content, on the card's corner.
    // Held off the edge it is a mark floating NEAR a corner, which is a
    // different and weaker statement. The sidebar card is square and
    // full-bleed, so there is nothing there to clear and nothing to spend an
    // inset on.
    const { tick } = renderTick("complete", "sidebar");
    for (const axis of ["top-", "start-"] as const) {
      expect(readInset(tick, axis), `${axis} is holding the mark off a square corner`).toBe(0);
    }
  });

  it("clears the rounded card's corner arc, which is the only reason an inset exists", () => {
    // The overview cell is `rounded-lg overflow-hidden`, so its arc clips
    // whatever sits inside it — and it eats the mark from the TOP, taking the
    // first segment and with it the count that separates the states. A mark
    // inset `i` on both axes survives when its top-left corner falls inside a
    // clip arc of radius `r`: (r - i)*sqrt(2) <= r.
    //
    // `r` is the cell's radius less its 1px border. `--radius-lg` is 10px at
    // `--theme-radius-scale: 1`, and the largest built-in scale is 1.05.
    const LARGEST_BUILT_IN_CLIP_RADIUS = 10 * 1.05 - 1;
    const minimumClearance = LARGEST_BUILT_IN_CLIP_RADIUS * (1 - 1 / Math.SQRT2);

    const { tick } = renderTick("complete", "grid");
    for (const axis of ["top-", "start-"] as const) {
      expect(
        readInset(tick, axis),
        `${axis} lets the cell's corner arc reach the mark's first segment`
      ).toBeGreaterThanOrEqual(minimumClearance);
    }
  });

  it("spends that inset only on the card that has a radius", () => {
    // The two variants must not drift into the same number: if the grid's
    // clearance is ever copied onto the sidebar, the flush corner is silently
    // gone, and if the sidebar's flush corner is copied onto the grid, the
    // clipping is silently back.
    const grid = readInset(renderTick("complete", "grid").tick, "start-");
    cleanup();
    const sidebar = readInset(renderTick("complete", "sidebar").tick, "start-");
    expect(grid, "both cards are using the same inset").toBeGreaterThan(sidebar);
  });

  it("outranks the full-card overlays it now shares an edge with", () => {
    // The border flash, the input receipt and sidebar.css's drop-target ring
    // are all `z-20`, `inset-0`, and later in the tree than the mark — so at
    // equal z-index they paint over it. Each is a CONTINUOUS line on the very
    // edge the mark is now flush against, and a continuous line over a
    // segmented one bridges the gaps rather than tinting them, flattening
    // every state to a single bar.
    const { tick } = renderTick("complete", "sidebar");
    const layer = [...tick.classList].find((c) => /^z-\d+$/.test(c));
    expect(layer, `the tick declares no stacking layer: ${tick.className}`).toBeDefined();
    expect(
      Number(layer!.slice(2)),
      `${layer} lets the z-20 card overlays paint across the mark`
    ).toBeGreaterThan(20);
  });
});

/** A Tailwind spacing utility's value in px (`gap-0.5` -> 2). */
function readScalePx(className: string): number {
  const match = /-(\d+(?:\.\d+)?)$/.exec(className);
  if (match?.[1] === undefined) throw new Error(`not a scale utility: ${className}`);
  return Number(match[1]) * 4;
}
