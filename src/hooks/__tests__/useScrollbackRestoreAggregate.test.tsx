// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { renderHook, act } from "@testing-library/react";
import {
  __testing as terminalServiceTesting,
  register as registerTerminalService,
} from "@/services/terminal/terminalInstanceServiceAccessor";
import { makeSurface } from "@/services/terminal/paintFabric/__tests__/fakePaintPlane";
import { useScrollbackRestoreAggregate } from "../useScrollbackRestoreAggregate";

const listeners = new Set<() => void>();
let counts = { pendingCount: 2, inProgressCount: 1, totalCount: 4 };

const service = Object.assign(makeSurface("primary").surface.plane, {
  subscribeScrollbackRestoreState: (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  getScrollbackRestorePendingCount: () => counts.pendingCount,
  getScrollbackRestoreInProgressCount: () => counts.inProgressCount,
  getScrollbackRestoreTotalCount: () => counts.totalCount,
});

function notify() {
  for (const listener of [...listeners]) listener();
}

describe("useScrollbackRestoreAggregate", () => {
  beforeEach(() => {
    listeners.clear();
    counts = { pendingCount: 2, inProgressCount: 1, totalCount: 4 };
    terminalServiceTesting.reset();
  });

  it("reads all zeros while the terminal service is unloaded", () => {
    const { result } = renderHook(() => useScrollbackRestoreAggregate());
    expect(result.current).toEqual({ pendingCount: 0, inProgressCount: 0, totalCount: 0 });
    expect(listeners.size).toBe(0);
  });

  it("reports the service's counts once it is ready, without a service event", () => {
    const { result } = renderHook(() => useScrollbackRestoreAggregate());

    act(() => registerTerminalService(service));
    expect(result.current).toEqual({ pendingCount: 2, inProgressCount: 1, totalCount: 4 });
    expect(listeners.size).toBeGreaterThan(0);

    counts = { pendingCount: 0, inProgressCount: 0, totalCount: 4 };
    act(() => notify());
    expect(result.current).toEqual({ pendingCount: 0, inProgressCount: 0, totalCount: 4 });
  });

  it("subscribes immediately when the service is already loaded", () => {
    registerTerminalService(service);
    const { result, unmount } = renderHook(() => useScrollbackRestoreAggregate());
    expect(result.current.totalCount).toBe(4);
    expect(listeners.size).toBeGreaterThan(0);

    unmount();
    expect(listeners.size).toBe(0);
  });

  it("leaves no listener behind when unmounted before ready", () => {
    const { unmount } = renderHook(() => useScrollbackRestoreAggregate());
    unmount();

    registerTerminalService(service);
    expect(listeners.size).toBe(0);
  });
});
