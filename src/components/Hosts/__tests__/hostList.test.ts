// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import type {
  HostConnectionState,
  HostListEntry,
  HostMetricsSummary,
} from "@shared/types/remoteHosts";
import type { RemoteHostsEvent } from "@shared/types/ipc/remoteHosts";
import type { HostMetricsEvent, HostMetricsSnapshot } from "@shared/types/ipc/hostMetrics";
import { useHostMetricsStore } from "@/store/hostMetricsStore";

vi.mock("@/lib/remoteHosts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/remoteHosts")>()),
  isRemoteShellSupported: () => true,
}));
vi.mock("@/utils/logger", () => ({ logWarn: vi.fn() }));

import {
  _resetHostListForTesting,
  getHostListSnapshot,
  useHostFigures,
  useHostList,
} from "../hostList";

function host(id: string): HostListEntry {
  return {
    descriptor: {
      id,
      name: id,
      connection: { kind: "ssh", target: `greg@${id}` },
      platform: "linux",
      arch: "x64",
      lastHandshake: null,
      lastSeenAt: null,
      addedAt: 1,
      notificationsEnabled: false,
      assistantControlEnabled: false,
    },
    connection: { status: "disconnected" },
    summary: null,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

let emit: ((event: RemoteHostsEvent) => void) | null = null;
const list = vi.fn<() => Promise<HostListEntry[]>>();
const isInUse = vi.fn(async () => true);
const getSnapshots = vi.fn<() => Promise<HostMetricsSnapshot[]>>();
const metricsListeners = new Set<(event: HostMetricsEvent) => void>();

function emitMetrics(event: HostMetricsEvent): void {
  for (const listener of [...metricsListeners]) listener(event);
}

beforeEach(() => {
  _resetHostListForTesting();
  useHostMetricsStore.getState().reset();
  list.mockReset();
  isInUse.mockReset().mockResolvedValue(true);
  getSnapshots.mockReset().mockResolvedValue([]);
  metricsListeners.clear();
  emit = null;
  Object.defineProperty(window, "electron", {
    configurable: true,
    writable: true,
    value: {
      remoteHosts: {
        list,
        isInUse,
        onEvent: (cb: (event: RemoteHostsEvent) => void) => {
          emit = cb;
          return () => {
            emit = null;
          };
        },
      },
      hostMetrics: {
        getSnapshots,
        onEvent: (cb: (event: HostMetricsEvent) => void) => {
          metricsListeners.add(cb);
          return () => {
            metricsListeners.delete(cb);
          };
        },
      },
    },
  });
});

afterEach(() => {
  cleanup();
  _resetHostListForTesting();
  Reflect.deleteProperty(window, "electron");
  Reflect.deleteProperty(document, "hidden");
});

const ids = (hosts: HostListEntry[]) => hosts.map((entry) => entry.descriptor.id);

describe("hostList", () => {
  it("keeps the hosts Remote Hosts announced when the read made before it started answers empty afterwards", async () => {
    const early = deferred<HostListEntry[]>();
    list.mockReturnValueOnce(early.promise);
    const { result } = renderHook(() => useHostList());
    expect(list).toHaveBeenCalledTimes(1);

    act(() => emit?.({ type: "hosts-changed", hosts: [host("studio-01")] }));
    expect(ids(result.current.hosts)).toEqual(["studio-01"]);

    await act(async () => {
      early.resolve([]);
      await early.promise;
    });
    expect(ids(result.current.hosts)).toEqual(["studio-01"]);
    expect(list).toHaveBeenCalledTimes(1);
  });

  it("drops a read from a subscription that ended, after the next one has its list", async () => {
    const stale = deferred<HostListEntry[]>();
    list.mockReturnValueOnce(stale.promise);
    const first = renderHook(() => useHostList());
    first.unmount();

    list.mockResolvedValueOnce([host("studio-01")]);
    const { result } = renderHook(() => useHostList());
    await act(async () => {
      await Promise.resolve();
    });
    expect(ids(result.current.hosts)).toEqual(["studio-01"]);

    await act(async () => {
      stale.resolve([]);
      await stale.promise;
    });
    expect(ids(result.current.hosts)).toEqual(["studio-01"]);
  });
});

const HANDSHAKE = {
  version: "1.0.0",
  commit: "abc",
  protocolVersion: 1,
  platform: "linux" as const,
  arch: "x64" as const,
};

function connected(rttMs: number, rttSampledAt: number): HostConnectionState {
  return { status: "connected", rttMs, rttSampledAt, handshake: { ...HANDSHAKE } };
}

function connectedHost(id: string): HostListEntry {
  return { ...host(id), connection: connected(5, 1) };
}

function summary(hostId: string, sampledAt: number): HostMetricsSummary {
  return {
    hostId,
    sampledAt,
    platform: "linux",
    cpuPercent: 5,
    memoryPressure: "normal",
    memoryUsedBytes: null,
    memoryTotalBytes: null,
    swapUsedBytes: null,
    swapTotalBytes: null,
    thermal: null,
    cpuPressure: null,
    agentsObserved: { working: 0, waiting: 0, idle: 0 },
    projectCount: 0,
    worktreeCount: 0,
    driver: null,
    agentClis: [],
  };
}

function counted<T>(hook: () => T) {
  const count = { renders: 0 };
  const view = renderHook(() => {
    count.renders += 1;
    return hook();
  });
  return { ...view, count };
}

async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  });
}

function setHidden(hidden: boolean): void {
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
  act(() => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
}

describe("host status and host figures", () => {
  it("leaves a status subscriber unrendered by a link's ping and by a summary", async () => {
    list.mockResolvedValue([connectedHost("studio-01")]);
    const status = counted(() => useHostList());
    const figures = counted(() => useHostFigures());
    await settle();
    expect(ids(status.result.current.hosts)).toEqual(["studio-01"]);
    const before = status.count.renders;

    act(() =>
      emit?.({ type: "connection-changed", hostId: "studio-01", connection: connected(9, 2) })
    );
    expect(figures.result.current.hosts[0]?.connection).toMatchObject({ rttMs: 9 });
    act(() => emitMetrics({ type: "summary", summary: summary("studio-01", 10) }));
    act(() => emitMetrics({ type: "summary", summary: summary("local", 11) }));
    expect(figures.result.current.hosts[0]?.summary?.sampledAt).toBe(10);
    expect(figures.result.current.localSummary?.sampledAt).toBe(11);
    expect(useHostMetricsStore.getState().history.get("studio-01")?.[0]?.sampledAt).toBe(10);

    expect(status.count.renders).toBe(before);
    expect(status.result.current.hosts[0]?.connection).toMatchObject({ rttMs: null });
    expect(status.result.current.hosts[0]?.summary).toBeNull();
    expect(status.result.current.localSummary).toBeNull();
  });

  it("renders a status subscriber when the link's state itself changes", async () => {
    list.mockResolvedValue([connectedHost("studio-01")]);
    const status = counted(() => useHostList());
    await settle();
    const before = status.count.renders;

    const quiet: HostConnectionState = { ...connected(5, 1), quietSince: 1_000 };
    act(() => emit?.({ type: "connection-changed", hostId: "studio-01", connection: quiet }));
    expect(status.count.renders).toBe(before + 1);
    expect(status.result.current.hosts[0]?.connection).toMatchObject({ quietSince: 1_000 });

    act(() =>
      emit?.({
        type: "connection-changed",
        hostId: "studio-01",
        connection: { status: "disconnected" },
      })
    );
    expect(status.count.renders).toBe(before + 2);
    expect(status.result.current.hosts[0]?.connection.status).toBe("disconnected");
  });

  it("follows no summaries until something shows figures, and lets them go when it closes", async () => {
    list.mockResolvedValue([connectedHost("studio-01")]);
    getSnapshots.mockResolvedValue([
      { hostId: "studio-01", history: [summary("studio-01", 3)] },
      { hostId: "local", history: [summary("local", 4)] },
    ]);
    const status = counted(() => useHostList());
    await settle();
    expect(metricsListeners.size).toBe(0);
    expect(isInUse).not.toHaveBeenCalled();
    expect(getSnapshots).not.toHaveBeenCalled();
    const before = status.count.renders;

    const figures = renderHook(() => useHostFigures());
    await settle();
    expect(metricsListeners.size).toBe(1);
    expect(figures.result.current.hosts[0]?.summary?.sampledAt).toBe(3);
    expect(figures.result.current.localSummary?.sampledAt).toBe(4);
    expect(useHostMetricsStore.getState().history.get("studio-01")).toHaveLength(1);

    figures.unmount();
    expect(metricsListeners.size).toBe(0);
    expect(useHostMetricsStore.getState().history.size).toBe(0);
    expect(getHostListSnapshot().hosts[0]?.summary).toBeNull();
    expect(getHostListSnapshot().localSummary).toBeNull();
    expect(status.count.renders).toBe(before);
  });

  it("follows nothing while disabled, as a closed switcher stays mounted", async () => {
    list.mockResolvedValue([connectedHost("studio-01")]);
    const closed = counted(() => useHostFigures(false));
    await settle();
    const before = closed.count.renders;
    act(() =>
      emit?.({ type: "connection-changed", hostId: "studio-01", connection: connected(9, 2) })
    );
    expect(metricsListeners.size).toBe(0);
    expect(closed.count.renders).toBe(before);
  });

  it("stops following while the view can't be seen and catches up when it can", async () => {
    list.mockResolvedValue([connectedHost("studio-01")]);
    getSnapshots.mockResolvedValue([{ hostId: "studio-01", history: [summary("studio-01", 3)] }]);
    const figures = renderHook(() => useHostFigures());
    await settle();
    expect(getSnapshots).toHaveBeenCalledTimes(1);

    setHidden(true);
    expect(metricsListeners.size).toBe(0);
    expect(figures.result.current.hosts[0]?.summary).toBeNull();

    getSnapshots.mockResolvedValue([{ hostId: "studio-01", history: [summary("studio-01", 8)] }]);
    setHidden(false);
    await settle();
    expect(metricsListeners.size).toBe(1);
    expect(getSnapshots).toHaveBeenCalledTimes(2);
    expect(figures.result.current.hosts[0]?.summary?.sampledAt).toBe(8);
  });

  it("keeps a summary pushed while the seed was in flight over the older one it brings", async () => {
    list.mockResolvedValue([connectedHost("studio-01")]);
    const seed = deferred<HostMetricsSnapshot[]>();
    getSnapshots.mockReturnValue(seed.promise);
    const figures = renderHook(() => useHostFigures());
    await settle();

    act(() => emitMetrics({ type: "summary", summary: summary("studio-01", 5) }));
    await act(async () => {
      seed.resolve([{ hostId: "studio-01", history: [summary("studio-01", 3)] }]);
      await seed.promise;
    });
    expect(figures.result.current.hosts[0]?.summary?.sampledAt).toBe(5);
    expect(
      useHostMetricsStore
        .getState()
        .history.get("studio-01")
        ?.map((entry) => entry.sampledAt)
    ).toEqual([5, 3]);
  });

  it("drops a seed that lands after the last figures consumer closed", async () => {
    list.mockResolvedValue([connectedHost("studio-01")]);
    const seed = deferred<HostMetricsSnapshot[]>();
    getSnapshots.mockReturnValue(seed.promise);
    const figures = renderHook(() => useHostFigures());
    await settle();
    figures.unmount();

    await act(async () => {
      seed.resolve([{ hostId: "studio-01", history: [summary("studio-01", 3)] }]);
      await seed.promise;
    });
    expect(getHostListSnapshot().hosts[0]?.summary).toBeNull();
    expect(useHostMetricsStore.getState().history.size).toBe(0);
  });
});
