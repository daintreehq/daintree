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

    it("no-ops when out-of-range value clamps to the already-stored value", () => {
      useTwoPaneSplitStore.setState({ ratioByWorktreeId: { wt1: 0.8 } });
      const before = useTwoPaneSplitStore.getState().ratioByWorktreeId;
      // 0.95 clamps to 0.8 which equals the stored value — should not update
      useTwoPaneSplitStore.getState().commitRatioIfChanged("wt1", 0.95);
      expect(useTwoPaneSplitStore.getState().ratioByWorktreeId).toBe(before);
    });
  });

  describe("no-op persistence invariants (relevant to issue #2638 transition)", () => {
    it("null commit after a successful commit leaves ratio intact", () => {
      useTwoPaneSplitStore.getState().commitRatioIfChanged("wt1", 0.65);
      expect(useTwoPaneSplitStore.getState().ratioByWorktreeId["wt1"]).toBe(0.65);

      // Unmount cleanup fires with null (no pending ratio) — must be a no-op
      useTwoPaneSplitStore.getState().commitRatioIfChanged("wt1", null);
      expect(useTwoPaneSplitStore.getState().ratioByWorktreeId["wt1"]).toBe(0.65);
    });

    it("ratio survives a null commit and is readable by getWorktreeRatio", () => {
      useTwoPaneSplitStore.getState().commitRatioIfChanged("wt1", 0.65);
      useTwoPaneSplitStore.getState().commitRatioIfChanged("wt1", null);

      expect(useTwoPaneSplitStore.getState().getWorktreeRatio("wt1")).toBe(0.65);
    });

    it("a non-null commit overwrites the previous stored ratio", () => {
      // Models the mid-drag unmount: cleanup flushes the current drag position
      useTwoPaneSplitStore.getState().commitRatioIfChanged("wt1", 0.5);
      useTwoPaneSplitStore.getState().commitRatioIfChanged("wt1", 0.7);
      expect(useTwoPaneSplitStore.getState().ratioByWorktreeId["wt1"]).toBe(0.7);

      // A subsequent null commit does not revert it
      useTwoPaneSplitStore.getState().commitRatioIfChanged("wt1", null);
      expect(useTwoPaneSplitStore.getState().ratioByWorktreeId["wt1"]).toBe(0.7);
    });

    it("does not affect other worktrees when one worktree commits null", () => {
      useTwoPaneSplitStore.setState({
        ratioByWorktreeId: { wt1: 0.65, wt2: 0.4 },
      });

      useTwoPaneSplitStore.getState().commitRatioIfChanged("wt1", null);

      expect(useTwoPaneSplitStore.getState().ratioByWorktreeId["wt2"]).toBe(0.4);
    });
  });

  describe("setWorktreeRatio", () => {
    it("always writes the clamped value, unlike commitRatioIfChanged which no-ops on equal", () => {
      useTwoPaneSplitStore.setState({ ratioByWorktreeId: { wt1: 0.7 } });
      const before = useTwoPaneSplitStore.getState().ratioByWorktreeId;

      // commitRatioIfChanged preserves reference when value is unchanged
      useTwoPaneSplitStore.getState().commitRatioIfChanged("wt1", 0.7);
      expect(useTwoPaneSplitStore.getState().ratioByWorktreeId).toBe(before);

      // setWorktreeRatio always produces a new object (used for swap inversion)
      useTwoPaneSplitStore.getState().setWorktreeRatio("wt1", 0.7);
      expect(useTwoPaneSplitStore.getState().ratioByWorktreeId).not.toBe(before);
      expect(useTwoPaneSplitStore.getState().ratioByWorktreeId["wt1"]).toBe(0.7);
    });

    it("clamps the value to [0.2, 0.8]", () => {
      useTwoPaneSplitStore.getState().setWorktreeRatio("wt1", 0.1);
      expect(useTwoPaneSplitStore.getState().ratioByWorktreeId["wt1"]).toBe(0.2);

      useTwoPaneSplitStore.getState().setWorktreeRatio("wt1", 0.9);
      expect(useTwoPaneSplitStore.getState().ratioByWorktreeId["wt1"]).toBe(0.8);
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
