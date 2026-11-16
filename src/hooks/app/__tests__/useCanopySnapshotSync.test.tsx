// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { CanopySnapshot } from "@shared/types/ipc/canopy";
import { useCanopyStore } from "@/store/canopyStore";
import { __resetProjectViewCacheStateForTests } from "@/lib/viewCacheState";
import { useCanopySnapshotSync } from "../useCanopySnapshotSync";

function snapshot(mode: CanopySnapshot["mode"], sequence: number): CanopySnapshot {
  return {
    sequence,
    mode,
    activated: mode === "on",
    dispositions: [],
    seen: [],
    reads: [],
    scope: null,
    active: false,
    busy: false,
    refreshedAt: null,
    cards: [],
    glances: [],
    lastError: null,
    failedRuns: [],
  };
}

afterEach(() => {
  useCanopyStore.setState({ snapshot: null, mode: "unset", isOpen: false });
  delete (window as { electron?: unknown }).electron;
  __resetProjectViewCacheStateForTests();
});

describe("useCanopySnapshotSync", () => {
  it("reads Canopy once, then follows what main pushes, until it goes away", async () => {
    let push: (next: CanopySnapshot) => void = () => {};
    const unsubscribe = vi.fn();
    const canopy = {
      getSnapshot: vi.fn(async () => snapshot("on", 1)),
      onSnapshotUpdated: vi.fn((listener: (next: CanopySnapshot) => void) => {
        push = listener;
        return unsubscribe;
      }),
    };
    Object.defineProperty(window, "electron", {
      value: { canopy },
      configurable: true,
      writable: true,
    });

    const view = renderHook(() => useCanopySnapshotSync());
    await act(async () => {});
    expect(canopy.getSnapshot).toHaveBeenCalledTimes(1);
    expect(useCanopyStore.getState().mode).toBe("on");

    // Hidden from another view: this one hears it with no button of its own.
    act(() => push(snapshot("hidden", 2)));
    expect(useCanopyStore.getState().mode).toBe("hidden");

    view.unmount();
    expect(unsubscribe).toHaveBeenCalled();
  });

  it("reads Canopy afresh once a cached view is shown again, since main sends it nothing", async () => {
    let cache = () => {};
    let activate = () => {};
    let reveal = () => {};
    const app = {
      isViewCached: () => false,
      onViewCached: (listener: () => void) => {
        cache = listener;
        return () => {};
      },
      onViewWarmActivated: (listener: () => void) => {
        activate = listener;
        return () => {};
      },
      onViewRevealed: (listener: () => void) => {
        reveal = listener;
        return () => {};
      },
    };
    let sequence = 1;
    const canopy = {
      getSnapshot: vi.fn(async () => snapshot(sequence === 1 ? "on" : "hidden", sequence)),
      onSnapshotUpdated: vi.fn(() => () => {}),
    };
    Object.defineProperty(window, "electron", {
      value: { app, canopy },
      configurable: true,
      writable: true,
    });

    renderHook(() => useCanopySnapshotSync());
    await act(async () => {});
    expect(canopy.getSnapshot).toHaveBeenCalledTimes(1);

    // Shown without having been cached: nothing was missed.
    await act(async () => reveal());
    expect(canopy.getSnapshot).toHaveBeenCalledTimes(1);

    // Main lets the view out of its cache before it says so: the read on activation sees all it missed.
    act(() => cache());
    sequence = 2;
    await act(async () => activate());
    expect(canopy.getSnapshot).toHaveBeenCalledTimes(2);
    expect(useCanopyStore.getState().mode).toBe("hidden");
    await act(async () => reveal());
    expect(canopy.getSnapshot).toHaveBeenCalledTimes(2);

    // A return that only says it was revealed reads too.
    act(() => cache());
    await act(async () => reveal());
    expect(canopy.getSnapshot).toHaveBeenCalledTimes(3);
  });
});
