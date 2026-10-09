import { describe, expect, it } from "vitest";
import { canopyPriorityTier, heldCanopyPriority } from "../canopyPriorityTier.js";
import { CANOPY_NEEDS_YOU_PRIORITY, CANOPY_URGENT_PRIORITY } from "../../types/ipc/canopy.js";

describe("heldCanopyPriority", () => {
  it("keeps the shown priority for a new score a point or two away in the same step", () => {
    expect(heldCanopyPriority(86, 88)).toBe(86);
    expect(heldCanopyPriority(50, 49)).toBe(50);
  });

  it("takes a new score that moves further, or into another step, however close", () => {
    expect(heldCanopyPriority(50, 53)).toBe(53);
    const belowUrgent = CANOPY_URGENT_PRIORITY - 1;
    expect(canopyPriorityTier(belowUrgent)).not.toBe(
      canopyPriorityTier(CANOPY_URGENT_PRIORITY + 1)
    );
    expect(heldCanopyPriority(belowUrgent, CANOPY_URGENT_PRIORITY + 1)).toBe(
      CANOPY_URGENT_PRIORITY + 1
    );
  });

  it("takes a new score across the needs-you floor, though the step is the same", () => {
    const below = CANOPY_NEEDS_YOU_PRIORITY - 2;
    expect(canopyPriorityTier(below)).toBe(canopyPriorityTier(CANOPY_NEEDS_YOU_PRIORITY));
    expect(heldCanopyPriority(below, CANOPY_NEEDS_YOU_PRIORITY)).toBe(CANOPY_NEEDS_YOU_PRIORITY);
    expect(heldCanopyPriority(CANOPY_NEEDS_YOU_PRIORITY, below)).toBe(below);
  });

  it("never holds a priority over none", () => {
    expect(heldCanopyPriority(1, 0)).toBe(0);
  });
});
