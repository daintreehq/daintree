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

  it("takes its height from the title row instead of carrying one of its own", () => {
    // A fixed height has to guess at the title row's, and a mark that guesses
    // sits proud of the text at both ends — which is the bug this replaced.
    // `inset-y-0` derives it, so the tick cannot drift when the row's contents
    // change.
    const { tick } = renderTick("waiting");
    expect(
      [...tick.classList].filter((c) => /^h-/.test(c)),
      "a fixed height would stop the tick tracking the row"
    ).toEqual([]);
  });

  it("keeps a fixed gap, which is what makes the stretch safe", () => {
    // Segment heights follow the row and may land on fractions; the GAP is a
    // fixed 2px whatever the row does. That asymmetry is the whole reason the
    // encoding survives a content-derived height — a taller row costs a soft
    // segment end, never a closed gap, and the gaps are the entire signal in
    // forced colors.
    const { tick } = renderTick("complete");
    const gap = [...tick.classList].find((c) => /^gap-/.test(c));
    expect(gap, "the tick renders no gap at all").toBeDefined();
    expect(
      readScalePx(gap!),
      "the gap is too small to survive antialiasing"
    ).toBeGreaterThanOrEqual(2);
  });
});

/** A Tailwind spacing utility's value in px (`gap-0.5` -> 2). */
function readScalePx(className: string): number {
  const match = /-(\d+(?:\.\d+)?)$/.exec(className);
  if (match?.[1] === undefined) throw new Error(`not a scale utility: ${className}`);
  return Number(match[1]) * 4;
}
