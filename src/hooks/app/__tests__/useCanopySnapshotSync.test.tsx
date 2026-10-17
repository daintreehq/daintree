// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { CanopySnapshot } from "@shared/types/ipc/canopy";
import { useCanopyStore } from "@/store/canopyStore";
import { useCanopySnapshotSync } from "../useCanopySnapshotSync";

function snapshot(mode: CanopySnapshot["mode"], sequence: number): CanopySnapshot {
  return {
    sequence,
    mode,
    activated: mode === "on",
    tier: "free",
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
});
