import { describe, it, expect } from "vitest";
import {
  addToWorktreeIndex,
  removeFromWorktreeIndex,
  transferBetweenWorktreeIndex,
  buildWorktreeIndex,
  collectUngroupedCandidateIds,
  panelMatchesWorktreeScope,
  NO_WORKTREE,
  type PanelIdsByWorktreeId,
} from "../worktreeIndex";

describe("worktreeIndex", () => {
  describe("addToWorktreeIndex", () => {
    it("creates a new bucket when worktree has no entries yet", () => {
      const next = addToWorktreeIndex({}, "wt-A", "panel-1");
      expect(next).toEqual({ "wt-A": ["panel-1"] });
    });

    it("appends to an existing bucket", () => {
      const next = addToWorktreeIndex({ "wt-A": ["panel-1"] }, "wt-A", "panel-2");
      expect(next).toEqual({ "wt-A": ["panel-1", "panel-2"] });
    });

    it("uses the __none__ bucket for undefined worktreeId", () => {
      const next = addToWorktreeIndex({}, undefined, "panel-1");
      expect(next).toEqual({ __none__: ["panel-1"] });
    });

    it("uses the __none__ bucket for null worktreeId", () => {
      const next = addToWorktreeIndex({}, null, "panel-1");
      expect(next).toEqual({ __none__: ["panel-1"] });
    });

    it("returns the same index reference when the panel is already present", () => {
      const before: PanelIdsByWorktreeId = { "wt-A": ["panel-1"] };
      const after = addToWorktreeIndex(before, "wt-A", "panel-1");
      expect(after).toBe(before);
    });

    it("preserves reference stability for unaffected buckets", () => {
      const wtBBucket = ["panel-2"];
      const before: PanelIdsByWorktreeId = { "wt-A": ["panel-1"], "wt-B": wtBBucket };
      const after = addToWorktreeIndex(before, "wt-A", "panel-3");
      expect(after["wt-B"]).toBe(wtBBucket);
      expect(after["wt-A"]).not.toBe(before["wt-A"]);
    });

    it("splices directly after the anchor when one is given (#12095)", () => {
      const next = addToWorktreeIndex(
        { "wt-A": ["panel-1", "panel-2", "panel-3"] },
        "wt-A",
        "copy",
        "panel-1"
      );
      expect(next).toEqual({ "wt-A": ["panel-1", "copy", "panel-2", "panel-3"] });
    });

    it("appends when the anchor is the last entry", () => {
      const next = addToWorktreeIndex({ "wt-A": ["panel-1"] }, "wt-A", "copy", "panel-1");
      expect(next).toEqual({ "wt-A": ["panel-1", "copy"] });
    });

    it("falls back to appending when the anchor is not in the bucket", () => {
      const next = addToWorktreeIndex({ "wt-A": ["panel-1"] }, "wt-A", "copy", "elsewhere");
      expect(next).toEqual({ "wt-A": ["panel-1", "copy"] });
    });

    it("keeps other buckets reference-stable across an anchored insert", () => {
      const wtBBucket = ["panel-2"];
      const before: PanelIdsByWorktreeId = { "wt-A": ["panel-1"], "wt-B": wtBBucket };
      const after = addToWorktreeIndex(before, "wt-A", "copy", "panel-1");
      expect(after["wt-B"]).toBe(wtBBucket);
    });

    it("creates the bucket when anchored into an empty index", () => {
      const next = addToWorktreeIndex({}, "wt-A", "copy", "panel-1");
      expect(next).toEqual({ "wt-A": ["copy"] });
    });
  });

  describe("removeFromWorktreeIndex", () => {
    it("removes a panel from its bucket", () => {
      const next = removeFromWorktreeIndex({ "wt-A": ["panel-1", "panel-2"] }, "wt-A", "panel-1");
      expect(next).toEqual({ "wt-A": ["panel-2"] });
    });

    it("deletes the bucket when the last panel is removed", () => {
      const next = removeFromWorktreeIndex({ "wt-A": ["panel-1"] }, "wt-A", "panel-1");
      expect(next).toEqual({});
    });

    it("returns the same index reference when the panel is not in the bucket", () => {
      const before: PanelIdsByWorktreeId = { "wt-A": ["panel-1"] };
      const after = removeFromWorktreeIndex(before, "wt-A", "panel-99");
      expect(after).toBe(before);
    });

    it("returns the same index reference when the bucket does not exist", () => {
      const before: PanelIdsByWorktreeId = { "wt-A": ["panel-1"] };
      const after = removeFromWorktreeIndex(before, "wt-Z", "panel-1");
      expect(after).toBe(before);
    });

    it("preserves reference stability for unaffected buckets", () => {
      const wtBBucket = ["panel-2"];
      const before: PanelIdsByWorktreeId = {
        "wt-A": ["panel-1", "panel-3"],
        "wt-B": wtBBucket,
      };
      const after = removeFromWorktreeIndex(before, "wt-A", "panel-1");
      expect(after["wt-B"]).toBe(wtBBucket);
    });

    it("handles the __none__ bucket via undefined worktreeId", () => {
      const next = removeFromWorktreeIndex(
        { __none__: ["panel-1", "panel-2"] },
        undefined,
        "panel-1"
      );
      expect(next).toEqual({ __none__: ["panel-2"] });
    });
  });

  describe("transferBetweenWorktreeIndex", () => {
    it("moves a panel from one worktree's bucket to another", () => {
      const next = transferBetweenWorktreeIndex({ "wt-A": ["panel-1"] }, "wt-A", "wt-B", "panel-1");
      expect(next).toEqual({ "wt-B": ["panel-1"] });
    });

    it("returns the same index reference when source and destination are the same", () => {
      const before: PanelIdsByWorktreeId = { "wt-A": ["panel-1"] };
      const after = transferBetweenWorktreeIndex(before, "wt-A", "wt-A", "panel-1");
      expect(after).toBe(before);
    });

    it("treats undefined and null as the same bucket key (__none__)", () => {
      const before: PanelIdsByWorktreeId = { __none__: ["panel-1"] };
      const after = transferBetweenWorktreeIndex(before, undefined, null, "panel-1");
      expect(after).toBe(before);
    });

    it("transfers from a defined worktree to __none__", () => {
      const next = transferBetweenWorktreeIndex(
        { "wt-A": ["panel-1"] },
        "wt-A",
        undefined,
        "panel-1"
      );
      expect(next).toEqual({ __none__: ["panel-1"] });
    });

    it("preserves reference stability for unaffected buckets across a transfer", () => {
      const wtCBucket = ["panel-99"];
      const before: PanelIdsByWorktreeId = {
        "wt-A": ["panel-1"],
        "wt-B": ["panel-2"],
        "wt-C": wtCBucket,
      };
      const after = transferBetweenWorktreeIndex(before, "wt-A", "wt-B", "panel-1");
      expect(after["wt-C"]).toBe(wtCBucket);
    });
  });

  describe("panelMatchesWorktreeScope", () => {
    it("matches exact worktree ids at both locations", () => {
      expect(panelMatchesWorktreeScope("wt-A", "wt-A", "dock")).toBe(true);
      expect(panelMatchesWorktreeScope("wt-A", "wt-A", "grid")).toBe(true);
    });

    it("rejects mismatched concrete worktree ids at both locations", () => {
      expect(panelMatchesWorktreeScope("wt-A", "wt-B", "dock")).toBe(false);
      expect(panelMatchesWorktreeScope("wt-A", "wt-B", "grid")).toBe(false);
    });

    it("includes a global panel in a concrete worktree's dock but not its grid (#11289)", () => {
      expect(panelMatchesWorktreeScope(undefined, "wt-A", "dock")).toBe(true);
      expect(panelMatchesWorktreeScope(undefined, "wt-A", "grid")).toBe(false);
    });

    it("matches a global panel against an empty scope at both locations", () => {
      expect(panelMatchesWorktreeScope(undefined, undefined, "dock")).toBe(true);
      expect(panelMatchesWorktreeScope(undefined, null, "grid")).toBe(true);
    });

    it("rejects a scoped panel against an empty scope", () => {
      expect(panelMatchesWorktreeScope("wt-A", undefined, "dock")).toBe(false);
      expect(panelMatchesWorktreeScope("wt-A", null, "grid")).toBe(false);
    });

    it("normalizes a null panel worktreeId like undefined", () => {
      expect(panelMatchesWorktreeScope(null, "wt-A", "dock")).toBe(true);
      expect(panelMatchesWorktreeScope(null, "wt-A", "grid")).toBe(false);
      expect(panelMatchesWorktreeScope(null, undefined, "grid")).toBe(true);
    });
  });

  describe("buildWorktreeIndex", () => {
    it("groups panel ids by worktreeId", () => {
      const index = buildWorktreeIndex(["p1", "p2", "p3"], {
        p1: { worktreeId: "wt-A" },
        p2: { worktreeId: "wt-A" },
        p3: { worktreeId: "wt-B" },
      });
      expect(index).toEqual({ "wt-A": ["p1", "p2"], "wt-B": ["p3"] });
    });

    it("groups missing worktreeId under __none__", () => {
      const index = buildWorktreeIndex(["p1"], { p1: {} });
      expect(index).toEqual({ __none__: ["p1"] });
    });

    it("skips ids missing from panelsById", () => {
      const index = buildWorktreeIndex(["p1", "p-missing"], { p1: { worktreeId: "wt-A" } });
      expect(index).toEqual({ "wt-A": ["p1"] });
    });

    it("preserves the order of panelIds within each bucket", () => {
      const index = buildWorktreeIndex(["p3", "p1", "p2"], {
        p1: { worktreeId: "wt-A" },
        p2: { worktreeId: "wt-A" },
        p3: { worktreeId: "wt-A" },
      });
      expect(index["wt-A"]).toEqual(["p3", "p1", "p2"]);
    });
  });

  describe("collectUngroupedCandidateIds", () => {
    it("returns the committed list untouched when no id is pending", () => {
      const panelIds = ["a", "b"];
      const result = collectUngroupedCandidateIds(panelIds, { "wt-a": ["a", "b"] }, "wt-a");

      // Same array reference — the common path must not allocate.
      expect(result).toBe(panelIds);
    });

    it("appends ids the worktree index knows about but panelIds has not revealed", () => {
      // #9649: during a spawn batch the index is written eagerly while panelIds
      // only appends at flush, so the pending panel must still surface.
      const result = collectUngroupedCandidateIds(["a"], { "wt-a": ["a", "pending"] }, "wt-a");

      expect(result).toEqual(["a", "pending"]);
    });

    it("orders pending ids active-worktree-first, then global", () => {
      // The dock renders global panels alongside the active worktree's, so the
      // two buckets both contribute pending ids. Insertion order of the index
      // object must not decide their relative position (#11873).
      const index: PanelIdsByWorktreeId = {
        [NO_WORKTREE]: ["global-committed", "global-pending"],
        "wt-a": ["local-committed", "local-pending"],
      };

      expect(
        collectUngroupedCandidateIds(["global-committed", "local-committed"], index, "wt-a")
      ).toEqual(["global-committed", "local-committed", "local-pending", "global-pending"]);
    });

    it("ignores buckets for other worktrees when scoped", () => {
      const index: PanelIdsByWorktreeId = {
        "wt-a": ["a", "a-pending"],
        "wt-b": ["b-pending"],
      };

      expect(collectUngroupedCandidateIds(["a"], index, "wt-a")).toEqual(["a", "a-pending"]);
    });

    it("scans every bucket when unscoped", () => {
      const index: PanelIdsByWorktreeId = {
        "wt-a": ["a", "a-pending"],
        "wt-b": ["b-pending"],
      };

      expect(collectUngroupedCandidateIds(["a"], index, undefined)).toEqual([
        "a",
        "a-pending",
        "b-pending",
      ]);
    });

    it("never repeats an id already committed to panelIds", () => {
      const result = collectUngroupedCandidateIds(
        ["a", "b"],
        { "wt-a": ["a", "b"], [NO_WORKTREE]: ["b"] },
        "wt-a"
      );

      expect(result).toEqual(["a", "b"]);
    });
  });
});
