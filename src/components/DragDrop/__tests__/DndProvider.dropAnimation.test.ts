// @vitest-environment jsdom
// Contract test for DragOverlay dropAnimation config in DndProvider.
// Mirrors the inline ternary expression rendered for the DragOverlay's
// dropAnimation prop so we can assert success and cancel branches use
// the right motion tokens. Following the same harness pattern as
// DndProvider.cancelDrop.test.ts and DndProvider.trashDrop.test.ts.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  EASE_OUT_EXPO,
  EASE_SNAPPY,
  PANEL_RESTORE_DURATION,
  UI_ANIMATION_DURATION,
  getUiAnimationDuration,
} from "@/lib/animationUtils";

// ── Branch replica (mirrors dropAnimation prop in DndProvider.tsx) ──

type DropAnimationConfig = {
  duration: number;
  easing: string;
  sideEffects: null;
};

/**
 * Mirrors the inline ternary at the DragOverlay's dropAnimation prop.
 * Must call getUiAnimationDuration() at invocation time so it reads the
 * live `document.body.dataset.performanceMode` flag.
 */
function dropAnimation(
  isCancelDrop: boolean,
  prefersReducedMotion = false
): DropAnimationConfig | null {
  if (prefersReducedMotion) return null;
  return isCancelDrop
    ? { duration: PANEL_RESTORE_DURATION, easing: EASE_OUT_EXPO, sideEffects: null }
    : { duration: getUiAnimationDuration(), easing: EASE_SNAPPY, sideEffects: null };
}

// ── Tests ────────────────────────────────────────────────

describe("DragOverlay dropAnimation config", () => {
  afterEach(() => {
    delete document.body.dataset.performanceMode;
  });

  // dnd-kit runs the drop animation through WAAPI, which CSS reduced-motion
  // rules never reach — so the OS preference has to disable it here, for the
  // snap-back as well as the settle, the same way it already skips the entry
  // spring.
  it("disables the travelling ghost entirely under reduced motion", () => {
    expect(dropAnimation(false, true)).toBeNull();
    expect(dropAnimation(true, true)).toBeNull();
  });

  // The replica above cannot see the real prop, so pin the gate at the source:
  // the DragOverlay's dropAnimation must short-circuit on the same reduced-motion
  // flag the entry spring already reads.
  it("wires the reduced-motion gate onto the real DragOverlay", () => {
    const source = readFileSync(resolve(__dirname, "../DndProvider.tsx"), "utf8");
    expect(source).toMatch(/dropAnimation=\{(?:\s|\/\/[^\n]*)*prefersReducedMotion\s*\?\s*null/);
  });

  it("uses Tier 1 snap motion (150ms EASE_SNAPPY) on successful drops", () => {
    const result = dropAnimation(false);
    expect(result).toEqual({
      duration: UI_ANIMATION_DURATION,
      easing: EASE_SNAPPY,
      sideEffects: null,
    });
  });

  it("uses Tier 3 panel motion (200ms EASE_OUT_EXPO) on cancelled drops", () => {
    const result = dropAnimation(true);
    expect(result).toEqual({
      duration: PANEL_RESTORE_DURATION,
      easing: EASE_OUT_EXPO,
      sideEffects: null,
    });
  });

  describe("Escape cancellation", () => {
    // handleDragCancel sets isCancelDrop=true so Escape gets the same
    // snap-back settle as cancelDrop-rejected drops (issue #8019).
    it("uses Tier 3 snap-back when Escape sets isCancelDrop", () => {
      const isCancelDrop = true; // handleDragCancel → setIsCancelDrop(true)
      expect(dropAnimation(isCancelDrop)).toEqual({
        duration: PANEL_RESTORE_DURATION,
        easing: EASE_OUT_EXPO,
        sideEffects: null,
      });
    });

    it("restores snappy tier on the next drag after handleDragStart resets the flag", () => {
      const afterReset = false; // handleDragStart → setIsCancelDrop(false)
      expect(dropAnimation(afterReset)).toEqual({
        duration: UI_ANIMATION_DURATION,
        easing: EASE_SNAPPY,
        sideEffects: null,
      });
    });

    it("keeps the snap-back settle in performance mode (semantic motion, not decoration)", () => {
      document.body.dataset.performanceMode = "true";
      // The cancel branch intentionally keeps PANEL_RESTORE_DURATION even in
      // performance mode: the settle is a meaning-bearing cue for "put it back",
      // not decorative motion, so it is not zeroed like the success branch.
      expect(dropAnimation(true)).toEqual({
        duration: PANEL_RESTORE_DURATION,
        easing: EASE_OUT_EXPO,
        sideEffects: null,
      });
    });
  });

  it("returns a non-null config with duration 0 in performance mode", () => {
    document.body.dataset.performanceMode = "true";
    const result = dropAnimation(false);
    // Non-null keeps dnd-kit's animation lifecycle alive (avoids unmount flash);
    // duration 0 makes the motion functionally instant.
    expect(result).toEqual({
      duration: 0,
      easing: EASE_SNAPPY,
      sideEffects: null,
    });
  });
});
