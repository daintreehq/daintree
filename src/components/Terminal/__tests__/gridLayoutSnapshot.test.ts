import { describe, it, expect, beforeEach } from "vitest";
import {
  getGridLayoutSnapshot,
  setGridLayoutSnapshot,
  subscribeGridLayoutSnapshot,
} from "../gridLayoutSnapshot";

// The snapshot is `useGridNavigation`'s authoritative source for column counts
// after #8857. These tests guard the subscribe-and-deduplicate contract that
// `useSyncExternalStore` relies on — a stale read or a missed listener call
// would re-introduce the drift bug.
describe("gridLayoutSnapshot", () => {
  beforeEach(() => {
    setGridLayoutSnapshot({ gridCols: 1, gridItemCount: 0, fleetGridCols: 1 });
  });

  it("returns the latest snapshot after set", () => {
    setGridLayoutSnapshot({ gridCols: 3, gridItemCount: 9, fleetGridCols: 2 });
    expect(getGridLayoutSnapshot()).toEqual({
      gridCols: 3,
      gridItemCount: 9,
      fleetGridCols: 2,
    });
  });

  it("notifies subscribers when any field changes", () => {
    let calls = 0;
    const unsubscribe = subscribeGridLayoutSnapshot(() => {
      calls += 1;
    });

    setGridLayoutSnapshot({ gridCols: 2, gridItemCount: 0, fleetGridCols: 1 });
    setGridLayoutSnapshot({ gridCols: 2, gridItemCount: 4, fleetGridCols: 1 });
    setGridLayoutSnapshot({ gridCols: 2, gridItemCount: 4, fleetGridCols: 3 });

    unsubscribe();
    expect(calls).toBe(3);
  });

  it("skips notifications when the snapshot is structurally unchanged", () => {
    let calls = 0;
    const unsubscribe = subscribeGridLayoutSnapshot(() => {
      calls += 1;
    });

    setGridLayoutSnapshot({ gridCols: 2, gridItemCount: 4, fleetGridCols: 1 });
    setGridLayoutSnapshot({ gridCols: 2, gridItemCount: 4, fleetGridCols: 1 });

    unsubscribe();
    expect(calls).toBe(1);
  });

  it("stops notifying after unsubscribe", () => {
    let calls = 0;
    const unsubscribe = subscribeGridLayoutSnapshot(() => {
      calls += 1;
    });

    setGridLayoutSnapshot({ gridCols: 2, gridItemCount: 4, fleetGridCols: 1 });
    unsubscribe();
    setGridLayoutSnapshot({ gridCols: 3, gridItemCount: 9, fleetGridCols: 1 });

    expect(calls).toBe(1);
  });
});
