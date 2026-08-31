/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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

function renderTick(
  state: WorktreeStatusTickState,
  variant?: "sidebar" | "grid",
  collapsed?: boolean
) {
  render(<WorktreeStatusTick state={state} variant={variant} collapsed={collapsed} />);
  const tick = screen.getByTestId("worktree-status-tick");
  const segments = screen.getAllByTestId("worktree-status-tick-segment");
  return { tick, segments };
}

/** A Tailwind size utility's value in px, read off whichever axis is asked for. */
function readAxis(tick: HTMLElement, axis: "h" | "w"): number {
  const size = [...tick.classList].find((c) => new RegExp(`^${axis}-\\d`).test(c));
  expect(size, `the tick declares no ${axis}: ${tick.className}`).toBeDefined();
  return readScalePx(size!);
}

/**
 * Every piece lands on a whole pixel at every count. A piece on a half pixel
 * blurs at 1x, and the blur closes the gaps — which are the entire encoding.
 * Read off what actually rendered, so retuning a slot or a gap has to keep the
 * arithmetic working rather than silently softening the mark.
 */
function expectWholePixelPieces(tick: HTMLElement, divisor: (count: number) => number) {
  const slot = readAxis(tick, "h");
  const gap = readVerticalGap(tick);
  for (const state of STATES) {
    const tracks = divisor(CHIP_SEGMENTS[state]);
    const piece = (slot - gap * (tracks - 1)) / tracks;
    expect(
      Number.isInteger(piece),
      `${state}: ${tracks} tracks of a ${slot}px slot are ${piece}px`
    ).toBe(true);
    expect(piece, `${state}: pieces too thin to read`).toBeGreaterThanOrEqual(2);
  }
}

/**
 * The gap in px on whichever axis is asked for. `gap-*` sets both, so the
 * collapsed grid's rows and columns are the same number — but reading them
 * separately is what makes an axis-scoped `gap-x-*`/`gap-y-*` show up as the
 * closed encoding it would be rather than passing on the other axis's value.
 */
function readGap(tick: HTMLElement, axis: "x" | "y"): number {
  const gap = [...tick.classList].find((c) => new RegExp(`^gap-(${axis}-)?\\d`).test(c));
  expect(gap, `no ${axis} gap on the tick: ${tick.className}`).toBeDefined();
  return readScalePx(gap!);
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
    expectWholePixelPieces(tick, (count) => count);
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

/**
 * The collapsed row is a single line, and a 16px bar down the side of it reads
 * as a rail the row hangs off rather than as a mark on a card. The square is
 * the answer, and the thing it must not quietly cost is the segment count —
 * the only channel that separates `cleanup` from `complete` anywhere, and the
 * only channel of any kind once forced colors has taken the hue.
 */
describe("WorktreeStatusTick — collapsed", () => {
  it("is square, and smaller than the bar it replaces", () => {
    const { tick } = renderTick("complete", "sidebar", true);
    const height = readAxis(tick, "h");
    const width = readAxis(tick, "w");
    expect(height, `not square: ${height}px tall, ${width}px wide`).toBe(width);
    cleanup();
    const bar = readAxis(renderTick("complete", "sidebar").tick, "h");
    expect(height, "the collapsed mark is no shorter than the bar").toBeLessThan(bar);
  });

  it("still gives every state a different number of segments", () => {
    const counts = STATES.map((state) => {
      const { segments } = renderTick(state, "sidebar", true);
      cleanup();
      return segments.length;
    });
    expect(new Set(counts).size, `states share a segment count: ${counts.join(" | ")}`).toBe(
      counts.length
    );
  });

  it("keeps the forced-colors hook on every segment and never on the container", () => {
    for (const state of STATES) {
      const { tick, segments } = renderTick(state, "sidebar", true);
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

  it("keeps the pieces as real sibling elements, which is what forced colors leaves alone", () => {
    const { segments } = renderTick("complete", "sidebar", true);
    expect(segments.length).toBeGreaterThan(1);
    for (const segment of segments) {
      expect(segment.tagName).toBe("SPAN");
      expect(segment.parentElement?.getAttribute("data-testid")).toBe("worktree-status-tick");
    }
  });

  it("cuts its square into whole pixels on both axes", () => {
    // Two tracks each way whatever the state, because the states differ by how
    // many cells they fill rather than by how finely the slot is divided —
    // which is what lets the square be 6px instead of the 10px three stacked
    // segments would have needed. Asserted once per axis rather than once per
    // state: the tracks do not vary with the state, and a loop over states
    // here would repeat one sum three times under three different labels.
    const { tick } = renderTick("waiting", "sidebar", true);
    expect(tick.classList.contains("grid"), `not a grid: ${tick.className}`).toBe(true);
    for (const [axis, size] of [
      ["y", readAxis(tick, "h")],
      ["x", readAxis(tick, "w")],
    ] as const) {
      const gap = readGap(tick, axis);
      const track = (size - gap) / 2;
      expect(
        Number.isInteger(track),
        `${axis}: two tracks of a ${size}px slot are ${track}px`
      ).toBe(true);
      expect(track, `${axis}: tracks too thin to read`).toBeGreaterThanOrEqual(2);
      expect(gap, `${axis}: the gap is too small to survive antialiasing`).toBeGreaterThanOrEqual(
        2
      );
    }
  });

  it("lays the pieces out without letting any two of them share a cell", () => {
    // The count only reads as a count while the pieces occupy DIFFERENT cells.
    // Pinning them with explicit `col-start-*`/`row-start-*` would stack three
    // spans on one corner: the sibling-element and segment-count assertions
    // above would all still pass, and forced colors would render one square
    // where it should render three. Auto-placement in reading order is what
    // keeps them apart, so nothing may override it.
    const cells = 4;
    for (const state of STATES) {
      const { segments } = renderTick(state, "sidebar", true);
      const covered = segments.reduce((total, segment) => {
        const cols = segment.classList.contains("col-span-2") ? 2 : 1;
        const rows = segment.classList.contains("row-span-2") ? 2 : 1;
        for (const placement of segment.classList) {
          expect(
            /^(col|row)-start-/.test(placement),
            `${state}: ${placement} pins a piece instead of letting it flow`
          ).toBe(false);
        }
        return total + cols * rows;
      }, 0);
      expect(covered, `${state}: its pieces cover ${covered} of ${cells} cells`).toBe(
        state === "complete" ? CHIP_SEGMENTS[state] : cells
      );
      expect(covered, `${state}: its pieces need more cells than the grid has`).toBeLessThanOrEqual(
        cells
      );
      cleanup();
    }
  });

  it("spends less ink the less the state wants, and less than the bar at every state", () => {
    // The point of the issue: the mark got quieter. Measured off the rendered
    // spans, so a span class going missing shows up as ink that stopped
    // descending rather than as nothing at all.
    const inkOf = (state: WorktreeStatusTickState, collapsed: boolean) => {
      const { tick, segments } = renderTick(state, "sidebar", collapsed);
      const slot = readAxis(tick, "h");
      const across = readAxis(tick, "w");
      const gap = readVerticalGap(tick);
      const area = segments.reduce((total, segment) => {
        const cols = segment.classList.contains("col-span-2") || !collapsed ? across : 2;
        const rows = segment.classList.contains("row-span-2")
          ? slot
          : collapsed
            ? 2
            : (slot - gap * (segments.length - 1)) / segments.length;
        return total + cols * rows;
      }, 0);
      cleanup();
      return area;
    };

    const collapsedInk = STATES.map((state) => inkOf(state, true));
    expect(collapsedInk, `collapsed ink does not descend: ${collapsedInk.join(" | ")}`).toEqual(
      [...collapsedInk].sort((a, b) => b - a)
    );
    for (const [index, state] of STATES.entries()) {
      expect(
        collapsedInk[index]!,
        `${state}: the collapsed mark is not quieter than the bar`
      ).toBeLessThan(inkOf(state, false));
    }
  });

  it("stays flush in the sidebar corner", () => {
    const { tick } = renderTick("complete", "sidebar", true);
    for (const axis of ["top-", "start-"] as const) {
      expect(readInset(tick, axis), `${axis} is holding the mark off a square corner`).toBe(0);
    }
  });

  it("still outranks the full-card overlays it shares an edge with", () => {
    const { tick } = renderTick("complete", "sidebar", true);
    const layer = [...tick.classList].find((c) => /^z-\d+$/.test(c));
    expect(layer, `the tick declares no stacking layer: ${tick.className}`).toBeDefined();
    expect(
      Number(layer!.slice(2)),
      `${layer} lets the z-20 card overlays paint across the mark`
    ).toBeGreaterThan(20);
  });
});

/**
 * The square only reaches a collapsed row if the card asks for it, and nothing
 * that renders the tick directly can see that it stopped. Dropping the prop at
 * the call site would leave every test above green while the shipped rows kept
 * the bar — so the hand-off is asserted where it is made.
 */
describe("WorktreeStatusTick — the card's call site", () => {
  it("hands the row's collapsed state to the mark", () => {
    const source = readFileSync(resolve(__dirname, "../../WorktreeCard.tsx"), "utf-8");
    const call = source.match(/<WorktreeStatusTick[\s\S]*?\/>/);
    expect(call?.[0], "WorktreeCard no longer renders the status tick").toBeDefined();
    expect(call![0], `the tick is rendered without the row's collapsed state: ${call![0]}`).toMatch(
      /collapsed=\{effectiveIsCollapsed\}/
    );
  });
});

/** A Tailwind spacing utility's value in px (`gap-0.5` -> 2). */
function readScalePx(className: string): number {
  const match = /-(\d+(?:\.\d+)?)$/.exec(className);
  if (match?.[1] === undefined) throw new Error(`not a scale utility: ${className}`);
  return Number(match[1]) * 4;
}
