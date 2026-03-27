import { describe, expect, it } from "vitest";
import { computeChipState, type ComputeChipStateInput } from "../utils/computeChipState";

const base: ComputeChipStateInput = {
  waitingTerminalCount: 0,
  lifecycleStage: null,
  isComplete: false,
  hasActiveAgent: false,
};

describe("computeChipState", () => {
  describe("state triggers", () => {
    it("returns waiting when waitingTerminalCount > 0", () => {
      expect(computeChipState({ ...base, waitingTerminalCount: 1 })).toBe("waiting");
    });

    it('returns cleanup when lifecycleStage is "merged"', () => {
      expect(computeChipState({ ...base, lifecycleStage: "merged" })).toBe("cleanup");
    });

    it('returns cleanup when lifecycleStage is "ready-for-cleanup"', () => {
      expect(computeChipState({ ...base, lifecycleStage: "ready-for-cleanup" })).toBe("cleanup");
    });

    it("returns complete when isComplete is true", () => {
      expect(computeChipState({ ...base, isComplete: true })).toBe("complete");
    });

    it("returns null when no conditions are met", () => {
      expect(computeChipState(base)).toBeNull();
    });
  });

  describe("priority ordering", () => {
    it("cleanup beats waiting", () => {
      expect(computeChipState({ ...base, waitingTerminalCount: 1, lifecycleStage: "merged" })).toBe(
        "cleanup"
      );
    });

    it("complete beats waiting", () => {
      expect(computeChipState({ ...base, waitingTerminalCount: 1, isComplete: true })).toBe(
        "complete"
      );
    });

    it("cleanup beats complete", () => {
      expect(
        computeChipState({ ...base, lifecycleStage: "ready-for-cleanup", isComplete: true })
      ).toBe("cleanup");
    });

    it("cleanup beats complete and waiting combined", () => {
      expect(
        computeChipState({
          ...base,
          lifecycleStage: "merged",
          isComplete: true,
          waitingTerminalCount: 1,
        })
      ).toBe("cleanup");
    });
  });

  describe("complete with non-cleanup lifecycle", () => {
    it('returns complete when lifecycleStage is "in-review"', () => {
      expect(computeChipState({ ...base, lifecycleStage: "in-review", isComplete: true })).toBe(
        "complete"
      );
    });

    it('returns complete when "in-review", complete, and waiting are all present', () => {
      expect(
        computeChipState({
          ...base,
          lifecycleStage: "in-review",
          isComplete: true,
          waitingTerminalCount: 1,
        })
      ).toBe("complete");
    });
  });

  describe("active agent suppresses complete", () => {
    it("returns null when isComplete but hasActiveAgent", () => {
      expect(computeChipState({ ...base, isComplete: true, hasActiveAgent: true })).toBeNull();
    });

    it("cleanup beats hasActiveAgent", () => {
      expect(
        computeChipState({
          ...base,
          lifecycleStage: "merged",
          isComplete: true,
          hasActiveAgent: true,
        })
      ).toBe("cleanup");
    });

    it("returns waiting when isComplete, hasActiveAgent, and waitingTerminalCount > 0", () => {
      expect(
        computeChipState({
          ...base,
          isComplete: true,
          hasActiveAgent: true,
          waitingTerminalCount: 1,
        })
      ).toBe("waiting");
    });

    it("returns complete when isComplete and hasActiveAgent is false", () => {
      expect(computeChipState({ ...base, isComplete: true, hasActiveAgent: false })).toBe(
        "complete"
      );
    });
  });

  describe("null cases", () => {
    it('returns null when lifecycleStage is "in-review"', () => {
      expect(computeChipState({ ...base, lifecycleStage: "in-review" })).toBeNull();
    });

    it("returns null when all counts are zero and isComplete is false", () => {
      expect(computeChipState({ ...base, lifecycleStage: null })).toBeNull();
    });
  });
});
