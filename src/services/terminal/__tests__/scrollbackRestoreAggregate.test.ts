import { describe, it, expect } from "vitest";
import {
  tallyScrollbackRestoreStates,
  type ScrollbackRestoreState,
} from "../scrollbackRestoreAggregate";

describe("tallyScrollbackRestoreStates", () => {
  it("returns all-zero for an empty set", () => {
    expect(tallyScrollbackRestoreStates([])).toEqual({
      pendingCount: 0,
      inProgressCount: 0,
      totalCount: 0,
    });
  });

  it("excludes 'none' terminals from every count", () => {
    const states: ScrollbackRestoreState[] = ["none", "none"];
    expect(tallyScrollbackRestoreStates(states)).toEqual({
      pendingCount: 0,
      inProgressCount: 0,
      totalCount: 0,
    });
  });

  it("counts 'done' toward total but not pending or in-progress", () => {
    const states: ScrollbackRestoreState[] = ["done", "done", "done"];
    const result = tallyScrollbackRestoreStates(states);
    expect(result.totalCount).toBe(3);
    expect(result.pendingCount).toBe(0);
    expect(result.inProgressCount).toBe(0);
  });

  it("tallies a mixed batch with total = sum of non-'none' states", () => {
    const states: ScrollbackRestoreState[] = ["none", "pending", "pending", "in-progress", "done"];
    const result = tallyScrollbackRestoreStates(states);
    expect(result.pendingCount).toBe(2);
    expect(result.inProgressCount).toBe(1);
    expect(result.totalCount).toBe(4);
    // The "N of M" done denominator is derivable: done = total - pending - inProgress.
    expect(result.totalCount - result.pendingCount - result.inProgressCount).toBe(1);
  });

  it("excludes 'lazy-pending' from every count (deferred restores never pin the indicator)", () => {
    const states: ScrollbackRestoreState[] = ["lazy-pending", "lazy-pending"];
    expect(tallyScrollbackRestoreStates(states)).toEqual({
      pendingCount: 0,
      inProgressCount: 0,
      totalCount: 0,
    });
  });

  it("counts an eager batch alongside ignored lazy-pending terminals", () => {
    const states: ScrollbackRestoreState[] = [
      "pending",
      "in-progress",
      "done",
      "lazy-pending",
      "lazy-pending",
    ];
    const result = tallyScrollbackRestoreStates(states);
    expect(result).toEqual({ pendingCount: 1, inProgressCount: 1, totalCount: 3 });
  });

  it("is order-independent", () => {
    const a = tallyScrollbackRestoreStates(["pending", "done", "in-progress"]);
    const b = tallyScrollbackRestoreStates(["done", "in-progress", "pending"]);
    expect(a).toEqual(b);
  });
});
