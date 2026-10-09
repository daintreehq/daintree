// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
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

describe("orders", () => {
  afterEach(() => window.localStorage.removeItem("daintree-canopy-order"));

  it("opens a view loaded later on the order last shown, to be placed afresh", async () => {
    useCanopyStore.getState().setOrder("all", { ids: ["b", "a"], rankedFor: 7, urgent: ["b"] });
    vi.resetModules();
    const { useCanopyStore: reloaded } = await import("../canopyStore");
    expect(reloaded.getState().orders.all).toEqual({
      ids: ["b", "a"],
      rankedFor: null,
      urgent: [],
    });
    expect(reloaded.getState().orders.project).toBeUndefined();
  });

  it("never drops the scope another view saved", async () => {
    vi.resetModules();
    const { useCanopyStore: other } = await import("../canopyStore");
    useCanopyStore.getState().setOrder("all", { ids: ["a", "b"], rankedFor: 1, urgent: [] });
    other.getState().setOrder("project", { ids: ["c"], rankedFor: 1, urgent: [] });
    vi.resetModules();
    const { useCanopyStore: reloaded } = await import("../canopyStore");
    expect(reloaded.getState().orders.all?.ids).toEqual(["a", "b"]);
    expect(reloaded.getState().orders.project?.ids).toEqual(["c"]);
  });
});
