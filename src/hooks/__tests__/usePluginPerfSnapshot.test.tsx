// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { PluginPerfSnapshot } from "@shared/types/pluginMetrics";

const getPerfSnapshots = vi.hoisted(() => vi.fn<() => Promise<PluginPerfSnapshot[]>>());
const unsubscribe = vi.hoisted(() => vi.fn());
const listeners = vi.hoisted(() => [] as Array<(snapshots: PluginPerfSnapshot[]) => void>);
const onPerfSnapshotsChanged = vi.hoisted(() =>
  vi.fn((cb: (snapshots: PluginPerfSnapshot[]) => void) => {
    listeners.push(cb);
    return unsubscribe;
  })
);

vi.mock("@/clients/pluginClient", () => ({
  pluginClient: { getPerfSnapshots, onPerfSnapshotsChanged },
}));

const { usePluginPerfSnapshot } = await import("../usePluginPerfSnapshot");

function snapshot(pluginId: string, activationMs: number): PluginPerfSnapshot {
  return {
    pluginId,
    isolation: "worker",
    activation: { lastMs: activationMs, count: 1, at: 1 },
    viewLoads: [],
    viewCommits: null,
    invokes: {
      count: 0,
      p50Ms: 0,
      p95Ms: 0,
      maxMs: 0,
      lastMs: 0,
      errors: 0,
      timeouts: 0,
      oversized: 0,
    },
    pushes: { messages: 0, bytes: 0, perSecond: 0, bytesPerSecond: 0, oversized: 0 },
    longFrames: { count: 0, totalBlockingMs: 0, lastAt: null },
    workerMemory: null,
    overBudget: [],
    since: 1,
  };
}

beforeEach(() => {
  listeners.length = 0;
  vi.clearAllMocks();
});

describe("usePluginPerfSnapshot", () => {
  it("reads the initial state and keeps only the requested plugin", async () => {
    getPerfSnapshots.mockResolvedValue([snapshot("other", 5), snapshot("acme.demo", 42)]);
    const { result } = renderHook(() => usePluginPerfSnapshot("acme.demo"));
    await act(async () => {});
    expect(result.current?.activation?.lastMs).toBe(42);
  });

  it("follows pushes while mounted and unsubscribes on unmount", async () => {
    getPerfSnapshots.mockResolvedValue([]);
    const { result, unmount } = renderHook(() => usePluginPerfSnapshot("acme.demo"));
    await act(async () => {});
    expect(result.current).toBeNull();
    expect(onPerfSnapshotsChanged).toHaveBeenCalledTimes(1);

    act(() => listeners[0]!([snapshot("acme.demo", 7)]));
    expect(result.current?.activation?.lastMs).toBe(7);

    unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("never lets a slow initial read overwrite a newer push", async () => {
    let resolveInitial: (value: PluginPerfSnapshot[]) => void = () => {};
    getPerfSnapshots.mockReturnValue(
      new Promise((resolve) => {
        resolveInitial = resolve;
      })
    );
    const { result } = renderHook(() => usePluginPerfSnapshot("acme.demo"));
    act(() => listeners[0]!([snapshot("acme.demo", 99)]));
    await act(async () => resolveInitial([snapshot("acme.demo", 1)]));
    expect(result.current?.activation?.lastMs).toBe(99);
  });

  it("reads a missing metrics bridge as no snapshot", async () => {
    onPerfSnapshotsChanged.mockImplementationOnce(() => {
      throw new TypeError("not a function");
    });
    getPerfSnapshots.mockRejectedValue(new Error("no bridge"));
    const { result } = renderHook(() => usePluginPerfSnapshot("acme.demo"));
    await act(async () => {});
    expect(result.current).toBeNull();
  });
});
