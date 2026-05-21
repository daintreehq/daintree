// @vitest-environment jsdom
// Contract test for the autoScroll config passed to the main DndContext in
// DndProvider. Mirrors the useMemo expression so we can assert the threshold
// shape (horizontal disabled, narrow vertical band) and the reduced-motion
// acceleration branch. Following the same harness pattern as
// DndProvider.dropAnimation.test.ts and DndProvider.cancelDrop.test.ts.
import { describe, expect, it } from "vitest";

// ── Branch replica (mirrors autoScroll useMemo in DndProvider.tsx) ──

type AutoScrollConfig = {
  threshold: { x: number; y: number };
  acceleration: number;
  canScroll: (el: Element) => boolean;
};

/**
 * Mirrors the useMemo body for the main DndContext's autoScroll prop.
 * `prefersReducedMotion` is the return value of framer-motion's
 * useReducedMotion(): boolean | null. Falsy values (false, null, undefined)
 * use the standard acceleration; true halves it.
 */
function autoScrollConfig(prefersReducedMotion: boolean | null): AutoScrollConfig {
  return {
    threshold: { x: 0, y: 0.08 },
    acceleration: prefersReducedMotion ? 5 : 10,
    canScroll: (el: Element) => el.scrollHeight > el.clientHeight,
  };
}

// ── Tests ────────────────────────────────────────────────

describe("DndContext autoScroll config", () => {
  it("disables horizontal autoscroll on the vertical sidebar", () => {
    // x:0 prevents accidental horizontal autoscroll — there is no horizontal
    // scroll axis in the worktree sidebar, so any horizontal scroll trigger
    // is always unintended pointer drift.
    expect(autoScrollConfig(false).threshold.x).toBe(0);
    expect(autoScrollConfig(true).threshold.x).toBe(0);
  });

  it("uses a narrow vertical autoscroll band (8% of container)", () => {
    // dnd-kit 6 threshold is fractional (0–1) × container size. 0.08 is a
    // ~40px band on a ~500px viewport — comparable to Atlassian/Muuri/Qt's
    // absolute 40px convention and dramatically tighter than the 0.2 default.
    expect(autoScrollConfig(false).threshold.y).toBe(0.08);
    expect(autoScrollConfig(true).threshold.y).toBe(0.08);
  });

  it("uses the standard acceleration when reduced motion is not requested", () => {
    expect(autoScrollConfig(false).acceleration).toBe(10);
  });

  it("treats a null reduced-motion result as the standard branch (SSR-safe default)", () => {
    // useReducedMotion() returns null before the matchMedia query resolves.
    // Null should not trip the reduced branch — the standard acceleration is
    // the safer default for users who haven't opted in.
    expect(autoScrollConfig(null).acceleration).toBe(10);
  });

  it("halves acceleration when the user prefers reduced motion", () => {
    // CSS prefers-reduced-motion has no effect on JS-driven autoscroll, so
    // we have to honor the preference manually. Halving acceleration keeps
    // autoscroll functional but takes the edge off the velocity ramp.
    expect(autoScrollConfig(true).acceleration).toBe(5);
  });

  describe("canScroll filter", () => {
    // Defensive against a future horizontally-scrollable ancestor: with
    // threshold.x = 0, dnd-kit's getScrollDirectionAndSpeed divides by zero
    // and produces Infinity scroll speed when a horizontally-scrollable
    // ancestor exists and is not pinned at its right edge. Filtering to
    // vertically-overflowing ancestors only sidesteps that path entirely.
    const { canScroll } = autoScrollConfig(false);

    function fakeElement(scrollHeight: number, clientHeight: number): Element {
      return { scrollHeight, clientHeight } as unknown as Element;
    }

    it("accepts ancestors with vertical overflow", () => {
      expect(canScroll(fakeElement(800, 400))).toBe(true);
    });

    it("rejects ancestors without vertical overflow", () => {
      expect(canScroll(fakeElement(400, 400))).toBe(false);
    });

    it("rejects horizontally-only-scrollable ancestors (the divide-by-zero guard)", () => {
      // clientHeight === scrollHeight means no vertical overflow even if the
      // ancestor scrolls horizontally — skip it so threshold.x = 0 never
      // produces Infinity speed.
      expect(canScroll(fakeElement(200, 200))).toBe(false);
    });
  });
});
