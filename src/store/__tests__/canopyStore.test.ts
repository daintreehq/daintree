import { describe, expect, it } from "vitest";
import type { CanopySnapshot } from "@shared/types/ipc/canopy";
import { isCanopyRead, useCanopyStore } from "../canopyStore";

const SPAWNED = 1_000;

describe("isCanopyRead", () => {
  it("is unread until the run is opened", () => {
    expect(isCanopyRead(undefined, SPAWNED, null)).toBe(false);
  });

  it("stays read until the screen is read anew after the run was opened", () => {
    const read = { spawnedAt: SPAWNED, at: 5_000 };
    expect(isCanopyRead(read, SPAWNED, { spawnedAt: SPAWNED, observedAt: 4_000 })).toBe(true);
    expect(isCanopyRead(read, SPAWNED, { spawnedAt: SPAWNED, observedAt: 6_000 })).toBe(false);
  });

  it("counts a run opened before its screen was ever read as read", () => {
    expect(isCanopyRead({ spawnedAt: SPAWNED, at: 5_000 }, SPAWNED, null)).toBe(true);
  });

  it("never carries a read over to a terminal respawned under the same id", () => {
    expect(isCanopyRead({ spawnedAt: SPAWNED, at: 5_000 }, SPAWNED + 1, null)).toBe(false);
  });
});

describe("applySnapshot", () => {
  it("never lets an older snapshot paint over a newer one", () => {
    const snapshot = (sequence: number, refreshedAt: number): CanopySnapshot => ({
      sequence,
      refreshedAt,
      activated: true,
      tier: "free",
      dispositions: [],
      seen: [],
      scope: null,
      active: false,
      busy: false,
      cards: [],
      glances: [],
      lastError: null,
      failedRuns: [],
    });
    useCanopyStore.setState({ snapshot: null, isOpen: false });
    useCanopyStore.getState().applySnapshot(snapshot(5, 500));
    useCanopyStore.getState().applySnapshot(snapshot(4, 400));
    expect(useCanopyStore.getState().snapshot?.refreshedAt).toBe(500);
    useCanopyStore.getState().applySnapshot(snapshot(6, 600));
    expect(useCanopyStore.getState().snapshot?.refreshedAt).toBe(600);
  });
});
