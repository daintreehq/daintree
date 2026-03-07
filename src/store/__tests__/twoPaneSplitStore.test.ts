import { beforeEach, describe, expect, it } from "vitest";
import { useTwoPaneSplitStore } from "../twoPaneSplitStore";

describe("twoPaneSplitStore", () => {
  beforeEach(() => {
    useTwoPaneSplitStore.setState({
      config: { enabled: true, defaultRatio: 0.5, preferPreview: false },
      ratioByWorktreeId: {},
    });
  });

  describe("commitRatioIfChanged", () => {
    it("stores ratio when none exists", () => {
      useTwoPaneSplitStore.getState().commitRatioIfChanged("wt1", 0.7);
      expect(useTwoPaneSplitStore.getState().ratioByWorktreeId["wt1"]).toBe(0.7);
    });

    it("does not update store when ratio is unchanged", () => {
      useTwoPaneSplitStore.setState({ ratioByWorktreeId: { wt1: 0.7 } });
      const before = useTwoPaneSplitStore.getState().ratioByWorktreeId;
      useTwoPaneSplitStore.getState().commitRatioIfChanged("wt1", 0.7);
      expect(useTwoPaneSplitStore.getState().ratioByWorktreeId).toBe(before);
    });

    it("no-ops when pendingRatio is null", () => {
      useTwoPaneSplitStore.getState().commitRatioIfChanged("wt1", null);
      expect(useTwoPaneSplitStore.getState().ratioByWorktreeId["wt1"]).toBeUndefined();
    });

    it("clamps ratio to [0.2, 0.8]", () => {
      useTwoPaneSplitStore.getState().commitRatioIfChanged("wt1", 0.95);
      expect(useTwoPaneSplitStore.getState().ratioByWorktreeId["wt1"]).toBe(0.8);

      useTwoPaneSplitStore.getState().commitRatioIfChanged("wt1", 0.05);
      expect(useTwoPaneSplitStore.getState().ratioByWorktreeId["wt1"]).toBe(0.2);
    });
  });

  describe("2-pane to 3-pane transition (issue #2638)", () => {
    it("preserves stored ratio across mode transitions", () => {
      // Simulate: user resizes in two-pane mode, ratio gets committed
      useTwoPaneSplitStore.getState().commitRatioIfChanged("wt1", 0.65);
      expect(useTwoPaneSplitStore.getState().ratioByWorktreeId["wt1"]).toBe(0.65);

      // Simulate: third panel added — TwoPaneSplitLayout unmounts with no pending ratio
      // commitRatioIfChanged(worktreeId, null) should be a no-op
      useTwoPaneSplitStore.getState().commitRatioIfChanged("wt1", null);
      expect(useTwoPaneSplitStore.getState().ratioByWorktreeId["wt1"]).toBe(0.65);
    });

    it("restores saved ratio when returning to two-pane mode", () => {
      // Commit a custom ratio
      useTwoPaneSplitStore.getState().commitRatioIfChanged("wt1", 0.65);

      // Third panel added (no-op commit)
      useTwoPaneSplitStore.getState().commitRatioIfChanged("wt1", null);

      // Third panel removed — ratio should still be 0.65
      const ratio = useTwoPaneSplitStore.getState().getWorktreeRatio("wt1");
      expect(ratio).toBe(0.65);
    });

    it("mid-drag transition flushes pending ratio once and does not corrupt state", () => {
      // Simulate: user is mid-drag at 0.7 when third panel is added
      // The cleanup effect fires once on unmount and commits the drag position
      useTwoPaneSplitStore.getState().commitRatioIfChanged("wt1", 0.7);

      // State should reflect the in-progress drag position
      expect(useTwoPaneSplitStore.getState().ratioByWorktreeId["wt1"]).toBe(0.7);

      // Subsequent no-op commit (null) should not change anything
      useTwoPaneSplitStore.getState().commitRatioIfChanged("wt1", null);
      expect(useTwoPaneSplitStore.getState().ratioByWorktreeId["wt1"]).toBe(0.7);
    });

    it("does not affect other worktrees during transition", () => {
      useTwoPaneSplitStore.setState({
        ratioByWorktreeId: { wt1: 0.65, wt2: 0.4 },
      });

      // wt1 transitions (no pending ratio)
      useTwoPaneSplitStore.getState().commitRatioIfChanged("wt1", null);

      // wt2 should be unaffected
      expect(useTwoPaneSplitStore.getState().ratioByWorktreeId["wt2"]).toBe(0.4);
    });
  });

  describe("resetWorktreeRatio", () => {
    it("removes the ratio for a specific worktree", () => {
      useTwoPaneSplitStore.setState({ ratioByWorktreeId: { wt1: 0.65, wt2: 0.4 } });

      useTwoPaneSplitStore.getState().resetWorktreeRatio("wt1");

      expect(useTwoPaneSplitStore.getState().ratioByWorktreeId["wt1"]).toBeUndefined();
      expect(useTwoPaneSplitStore.getState().ratioByWorktreeId["wt2"]).toBe(0.4);
    });

    it("getWorktreeRatio returns defaultRatio after reset", () => {
      useTwoPaneSplitStore.setState({ ratioByWorktreeId: { wt1: 0.65 } });
      useTwoPaneSplitStore.getState().resetWorktreeRatio("wt1");

      const ratio = useTwoPaneSplitStore.getState().getWorktreeRatio("wt1");
      expect(ratio).toBe(0.5); // defaultRatio
    });
  });

  describe("getWorktreeRatio", () => {
    it("returns stored ratio when available", () => {
      useTwoPaneSplitStore.setState({ ratioByWorktreeId: { wt1: 0.65 } });
      expect(useTwoPaneSplitStore.getState().getWorktreeRatio("wt1")).toBe(0.65);
    });

    it("returns defaultRatio when no stored ratio", () => {
      expect(useTwoPaneSplitStore.getState().getWorktreeRatio("wt-unknown")).toBe(0.5);
    });

    it("returns defaultRatio for null worktreeId", () => {
      expect(useTwoPaneSplitStore.getState().getWorktreeRatio(null)).toBe(0.5);
    });
  });
});
