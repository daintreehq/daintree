import { beforeEach, describe, expect, it } from "vitest";
import { useTwoPaneSplitStore } from "../twoPaneSplitStore";
import type { WorktreeRatioEntry } from "../twoPaneSplitStore";

function entry(
  ratio: number,
  panels: [string | null, string | null] = [null, null]
): WorktreeRatioEntry {
  return { ratio, panels };
}

describe("twoPaneSplitStore", () => {
  beforeEach(() => {
    useTwoPaneSplitStore.setState({
      config: { enabled: true, defaultRatio: 0.5, preferPreview: false },
      ratioByWorktreeId: {},
    });
  });

  describe("commitRatioIfChanged", () => {
    it("stores ratio and panels when none exists", () => {
      useTwoPaneSplitStore.getState().commitRatioIfChanged("wt1", 0.7, ["a", "b"]);
      expect(useTwoPaneSplitStore.getState().ratioByWorktreeId["wt1"]).toEqual(
        entry(0.7, ["a", "b"])
      );
    });

    it("does not update store when ratio and panels are unchanged", () => {
      useTwoPaneSplitStore.setState({ ratioByWorktreeId: { wt1: entry(0.7, ["a", "b"]) } });
      const before = useTwoPaneSplitStore.getState().ratioByWorktreeId;
      useTwoPaneSplitStore.getState().commitRatioIfChanged("wt1", 0.7, ["a", "b"]);
      expect(useTwoPaneSplitStore.getState().ratioByWorktreeId).toBe(before);
    });

    it("updates when panels change even if ratio is the same", () => {
      useTwoPaneSplitStore.setState({ ratioByWorktreeId: { wt1: entry(0.7, ["a", "b"]) } });
      useTwoPaneSplitStore.getState().commitRatioIfChanged("wt1", 0.7, ["b", "a"]);
      expect(useTwoPaneSplitStore.getState().ratioByWorktreeId["wt1"]).toEqual(
        entry(0.7, ["b", "a"])
      );
    });

    it("no-ops when pendingRatio is null", () => {
      useTwoPaneSplitStore.getState().commitRatioIfChanged("wt1", null, ["a", "b"]);
      expect(useTwoPaneSplitStore.getState().ratioByWorktreeId["wt1"]).toBeUndefined();
    });

    it("clamps ratio to [0.2, 0.8]", () => {
      useTwoPaneSplitStore.getState().commitRatioIfChanged("wt1", 0.95, ["a", "b"]);
      expect(useTwoPaneSplitStore.getState().ratioByWorktreeId["wt1"]).toEqual(
        entry(0.8, ["a", "b"])
      );

      useTwoPaneSplitStore.getState().commitRatioIfChanged("wt1", 0.05, ["a", "b"]);
      expect(useTwoPaneSplitStore.getState().ratioByWorktreeId["wt1"]).toEqual(
        entry(0.2, ["a", "b"])
      );
    });

    it("no-ops when out-of-range value clamps to the already-stored value", () => {
      useTwoPaneSplitStore.setState({ ratioByWorktreeId: { wt1: entry(0.8, ["a", "b"]) } });
      const before = useTwoPaneSplitStore.getState().ratioByWorktreeId;
      useTwoPaneSplitStore.getState().commitRatioIfChanged("wt1", 0.95, ["a", "b"]);
      expect(useTwoPaneSplitStore.getState().ratioByWorktreeId).toBe(before);
    });
  });

  describe("no-op persistence invariants (relevant to issue #2638 transition)", () => {
    it("null commit after a successful commit leaves ratio intact", () => {
      useTwoPaneSplitStore.getState().commitRatioIfChanged("wt1", 0.65, ["a", "b"]);
      expect(useTwoPaneSplitStore.getState().ratioByWorktreeId["wt1"]).toEqual(
        entry(0.65, ["a", "b"])
      );

      useTwoPaneSplitStore.getState().commitRatioIfChanged("wt1", null, ["a", "b"]);
      expect(useTwoPaneSplitStore.getState().ratioByWorktreeId["wt1"]).toEqual(
        entry(0.65, ["a", "b"])
      );
    });

    it("ratio survives a null commit and is readable by getWorktreeRatio", () => {
      useTwoPaneSplitStore.getState().commitRatioIfChanged("wt1", 0.65, ["a", "b"]);
      useTwoPaneSplitStore.getState().commitRatioIfChanged("wt1", null, ["a", "b"]);

      expect(useTwoPaneSplitStore.getState().getWorktreeRatio("wt1")).toBe(0.65);
    });

    it("a non-null commit overwrites the previous stored ratio", () => {
      useTwoPaneSplitStore.getState().commitRatioIfChanged("wt1", 0.5, ["a", "b"]);
      useTwoPaneSplitStore.getState().commitRatioIfChanged("wt1", 0.7, ["a", "b"]);
      expect(useTwoPaneSplitStore.getState().ratioByWorktreeId["wt1"]).toEqual(
        entry(0.7, ["a", "b"])
      );

      useTwoPaneSplitStore.getState().commitRatioIfChanged("wt1", null, ["a", "b"]);
      expect(useTwoPaneSplitStore.getState().ratioByWorktreeId["wt1"]).toEqual(
        entry(0.7, ["a", "b"])
      );
    });

    it("does not affect other worktrees when one worktree commits null", () => {
      useTwoPaneSplitStore.setState({
        ratioByWorktreeId: { wt1: entry(0.65, ["a", "b"]), wt2: entry(0.4, ["c", "d"]) },
      });

      useTwoPaneSplitStore.getState().commitRatioIfChanged("wt1", null, ["a", "b"]);

      expect(useTwoPaneSplitStore.getState().ratioByWorktreeId["wt2"]).toEqual(
        entry(0.4, ["c", "d"])
      );
    });
  });

  describe("setWorktreeRatio", () => {
    it("always writes the clamped value with panels", () => {
      useTwoPaneSplitStore.setState({ ratioByWorktreeId: { wt1: entry(0.7, ["a", "b"]) } });
      const before = useTwoPaneSplitStore.getState().ratioByWorktreeId;

      useTwoPaneSplitStore.getState().commitRatioIfChanged("wt1", 0.7, ["a", "b"]);
      expect(useTwoPaneSplitStore.getState().ratioByWorktreeId).toBe(before);

      useTwoPaneSplitStore.getState().setWorktreeRatio("wt1", 0.7, ["a", "b"]);
      expect(useTwoPaneSplitStore.getState().ratioByWorktreeId).not.toBe(before);
      expect(useTwoPaneSplitStore.getState().ratioByWorktreeId["wt1"]).toEqual(
        entry(0.7, ["a", "b"])
      );
    });

    it("clamps the value to [0.2, 0.8]", () => {
      useTwoPaneSplitStore.getState().setWorktreeRatio("wt1", 0.1, ["a", "b"]);
      expect(useTwoPaneSplitStore.getState().ratioByWorktreeId["wt1"]?.ratio).toBe(0.2);

      useTwoPaneSplitStore.getState().setWorktreeRatio("wt1", 0.9, ["a", "b"]);
      expect(useTwoPaneSplitStore.getState().ratioByWorktreeId["wt1"]?.ratio).toBe(0.8);
    });
  });

  describe("resetWorktreeRatio", () => {
    it("removes the ratio for a specific worktree", () => {
      useTwoPaneSplitStore.setState({
        ratioByWorktreeId: { wt1: entry(0.65, ["a", "b"]), wt2: entry(0.4, ["c", "d"]) },
      });

      useTwoPaneSplitStore.getState().resetWorktreeRatio("wt1");

      expect(useTwoPaneSplitStore.getState().ratioByWorktreeId["wt1"]).toBeUndefined();
      expect(useTwoPaneSplitStore.getState().ratioByWorktreeId["wt2"]).toEqual(
        entry(0.4, ["c", "d"])
      );
    });

    it("getWorktreeRatio returns defaultRatio after reset", () => {
      useTwoPaneSplitStore.setState({ ratioByWorktreeId: { wt1: entry(0.65, ["a", "b"]) } });
      useTwoPaneSplitStore.getState().resetWorktreeRatio("wt1");

      const ratio = useTwoPaneSplitStore.getState().getWorktreeRatio("wt1");
      expect(ratio).toBe(0.5);
    });
  });

  describe("getWorktreeRatio", () => {
    it("returns stored ratio when available", () => {
      useTwoPaneSplitStore.setState({ ratioByWorktreeId: { wt1: entry(0.65, ["a", "b"]) } });
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
