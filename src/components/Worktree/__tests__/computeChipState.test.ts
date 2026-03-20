import { describe, expect, it } from "vitest";
import { computeChipState, type ComputeChipStateInput } from "../utils/computeChipState";

const base: ComputeChipStateInput = {
  worktreeErrorCount: 0,
  failedTerminalCount: 0,
  waitingTerminalCount: 0,
  approvalWaitingCount: 0,
  lifecycleStage: null,
  isComplete: false,
};

describe("computeChipState", () => {
  describe("state triggers", () => {
    it("returns error when worktreeErrorCount > 0", () => {
      expect(computeChipState({ ...base, worktreeErrorCount: 1 })).toBe("error");
    });

    it("returns error when failedTerminalCount > 0", () => {
      expect(computeChipState({ ...base, failedTerminalCount: 2 })).toBe("error");
    });

    it("returns waiting when waitingTerminalCount > 0", () => {
      expect(computeChipState({ ...base, waitingTerminalCount: 1 })).toBe("waiting");
    });

    it("returns approval when approvalWaitingCount > 0", () => {
      expect(computeChipState({ ...base, waitingTerminalCount: 1, approvalWaitingCount: 1 })).toBe(
        "approval"
      );
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
    it("error beats waiting", () => {
      expect(computeChipState({ ...base, worktreeErrorCount: 1, waitingTerminalCount: 1 })).toBe(
        "error"
      );
    });

    it("error beats cleanup", () => {
      expect(computeChipState({ ...base, failedTerminalCount: 1, lifecycleStage: "merged" })).toBe(
        "error"
      );
    });

    it("error beats complete", () => {
      expect(computeChipState({ ...base, worktreeErrorCount: 1, isComplete: true })).toBe("error");
    });

    it("error beats all other states simultaneously", () => {
      expect(
        computeChipState({
          worktreeErrorCount: 1,
          failedTerminalCount: 1,
          waitingTerminalCount: 1,
          approvalWaitingCount: 1,
          lifecycleStage: "ready-for-cleanup",
          isComplete: true,
        })
      ).toBe("error");
    });

    it("approval beats waiting", () => {
      expect(computeChipState({ ...base, waitingTerminalCount: 2, approvalWaitingCount: 1 })).toBe(
        "approval"
      );
    });

    it("error beats approval", () => {
      expect(
        computeChipState({
          ...base,
          worktreeErrorCount: 1,
          waitingTerminalCount: 1,
          approvalWaitingCount: 1,
        })
      ).toBe("error");
    });

    it("cleanup beats approval", () => {
      expect(
        computeChipState({
          ...base,
          waitingTerminalCount: 1,
          approvalWaitingCount: 1,
          lifecycleStage: "merged",
        })
      ).toBe("cleanup");
    });

    it("complete beats approval", () => {
      expect(
        computeChipState({
          ...base,
          waitingTerminalCount: 1,
          approvalWaitingCount: 1,
          isComplete: true,
        })
      ).toBe("complete");
    });

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

    it("failedTerminalCount error beats waiting", () => {
      expect(computeChipState({ ...base, failedTerminalCount: 1, waitingTerminalCount: 1 })).toBe(
        "error"
      );
    });

    it("failedTerminalCount error beats complete", () => {
      expect(computeChipState({ ...base, failedTerminalCount: 1, isComplete: true })).toBe("error");
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

  describe("null cases", () => {
    it('returns null when lifecycleStage is "in-review"', () => {
      expect(computeChipState({ ...base, lifecycleStage: "in-review" })).toBeNull();
    });

    it("returns null when all counts are zero and isComplete is false", () => {
      expect(computeChipState({ ...base, lifecycleStage: null })).toBeNull();
    });
  });
});
