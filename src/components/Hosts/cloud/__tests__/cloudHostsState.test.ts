// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudHostsSnapshot } from "@shared/types/cloudHosts";
import type { RemoteHostsEvent } from "@shared/types/ipc/remoteHosts";
import { _resetCloudHostsStateForTesting, useCloudHosts } from "../cloudHostsState";
import { provider } from "./cloudProviderFixtures";

vi.mock("@/lib/remoteHosts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/remoteHosts")>()),
  isRemoteShellSupported: () => true,
}));

vi.mock("@/utils/logger", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/utils/logger")>()),
  logWarn: vi.fn(),
}));

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function snapshotNamed(name: string): CloudHostsSnapshot {
  return { providers: [provider({ name })], accounts: [], hosts: [] };
}

const windowWithElectron = window as unknown as { electron?: unknown };

type Outcome = { snapshot: CloudHostsSnapshot } | { error: Error };

type EventListener = (event: RemoteHostsEvent) => void;

function stubCloud() {
  const listeners = new Set<EventListener>();
  const registered: EventListener[] = [];
  const reads: Deferred<CloudHostsSnapshot>[] = [];
  windowWithElectron.electron = {
    remoteHosts: {
      onEvent: (listener: EventListener) => {
        listeners.add(listener);
        registered.push(listener);
        return () => listeners.delete(listener);
      },
    },
    cloudHosts: {
      getSnapshot: () => {
        const read = deferred<CloudHostsSnapshot>();
        reads.push(read);
        return read.promise;
      },
    },
  };
  const deliver = (event: RemoteHostsEvent, to: Iterable<EventListener> = [...listeners]) =>
    act(() => {
      for (const listener of to) listener(event);
    });
  const push = (snapshot: CloudHostsSnapshot) => deliver({ type: "cloud-changed", snapshot });
  const settle = async (index: number, outcome: Outcome) => {
    const read = reads[index];
    if (!read) throw new Error(`No read #${index} was made`);
    await act(async () => {
      if ("snapshot" in outcome) read.resolve(outcome.snapshot);
      else read.reject(outcome.error);
      await read.promise.catch(() => {});
    });
  };
  return { reads, registered, deliver, push, settle, listeners };
}

beforeEach(() => {
  _resetCloudHostsStateForTesting();
});

afterEach(() => {
  cleanup();
  _resetCloudHostsStateForTesting();
  delete windowWithElectron.electron;
});

describe("useCloudHosts against a provider push", () => {
  it("keeps a pushed snapshot when the first read lands later with older data", async () => {
    const cloud = stubCloud();
    const { result } = renderHook(() => useCloudHosts());
    const fresh = snapshotNamed("Fresh");

    cloud.push(fresh);
    await cloud.settle(0, { snapshot: snapshotNamed("Stale") });

    expect(result.current.snapshot).toBe(fresh);
    expect(result.current.loadError).toBeNull();
  });

  it("keeps a pushed snapshot when the first read fails after it", async () => {
    const cloud = stubCloud();
    const { result } = renderHook(() => useCloudHosts());
    const fresh = snapshotNamed("Fresh");

    cloud.push(fresh);
    await cloud.settle(0, { error: new Error("ipc down") });

    expect(result.current.snapshot).toBe(fresh);
    expect(result.current.loaded).toBe(true);
    expect(result.current.loadError).toBeNull();
  });

  it("keeps a pushed snapshot when a Retry read lands later with older data", async () => {
    const cloud = stubCloud();
    const { result } = renderHook(() => useCloudHosts());
    await cloud.settle(0, { error: new Error("ipc down") });
    expect(result.current.loadError).not.toBeNull();

    void result.current.refresh();
    const fresh = snapshotNamed("Fresh");
    cloud.push(fresh);
    await cloud.settle(1, { snapshot: snapshotNamed("Stale") });

    expect(result.current.snapshot).toBe(fresh);
    expect(result.current.loadError).toBeNull();
  });

  it("keeps a pushed snapshot when a Retry read fails after it", async () => {
    const cloud = stubCloud();
    const { result } = renderHook(() => useCloudHosts());
    await cloud.settle(0, { error: new Error("ipc down") });

    void result.current.refresh();
    const fresh = snapshotNamed("Fresh");
    cloud.push(fresh);
    await cloud.settle(1, { error: new Error("ipc down again") });

    expect(result.current.snapshot).toBe(fresh);
    expect(result.current.loadError).toBeNull();
  });

  it("keeps the newer of two overlapping Retry reads when the older lands last", async () => {
    const cloud = stubCloud();
    const { result } = renderHook(() => useCloudHosts());
    await cloud.settle(0, { error: new Error("ipc down") });

    void result.current.refresh();
    void result.current.refresh();
    const newer = snapshotNamed("Newer");
    await cloud.settle(2, { snapshot: newer });
    await cloud.settle(1, { snapshot: snapshotNamed("Older") });

    expect(result.current.snapshot).toBe(newer);
    expect(result.current.loadError).toBeNull();
  });

  it("keeps the newer Retry read's answer when the older one fails last", async () => {
    const cloud = stubCloud();
    const { result } = renderHook(() => useCloudHosts());
    await cloud.settle(0, { error: new Error("ipc down") });

    void result.current.refresh();
    void result.current.refresh();
    const newer = snapshotNamed("Newer");
    await cloud.settle(2, { snapshot: newer });
    await cloud.settle(1, { error: new Error("ipc down again") });

    expect(result.current.snapshot).toBe(newer);
    expect(result.current.loadError).toBeNull();
  });

  it("applies the older Retry read when it lands first, then the newer one", async () => {
    const cloud = stubCloud();
    const { result } = renderHook(() => useCloudHosts());
    await cloud.settle(0, { error: new Error("ipc down") });

    void result.current.refresh();
    void result.current.refresh();
    const older = snapshotNamed("Older");
    const newer = snapshotNamed("Newer");
    await cloud.settle(1, { snapshot: older });
    expect(result.current.snapshot).toBe(older);
    expect(result.current.loadError).toBeNull();

    await cloud.settle(2, { snapshot: newer });
    expect(result.current.snapshot).toBe(newer);
  });

  it("shows an older read's answer that lands after a newer Retry failed, keeping the failure", async () => {
    const cloud = stubCloud();
    const { result } = renderHook(() => useCloudHosts());
    await cloud.settle(0, { snapshot: snapshotNamed("First") });

    void result.current.refresh();
    void result.current.refresh();
    const older = snapshotNamed("Older");
    await cloud.settle(2, { error: new Error("ipc down") });
    await cloud.settle(1, { snapshot: older });

    expect(result.current.snapshot).toBe(older);
    expect(result.current.loadError).toBe("Couldn't read cloud accounts");
  });

  it("drops an older read's answer that lands after a push and a newer Retry's failure", async () => {
    const cloud = stubCloud();
    const { result } = renderHook(() => useCloudHosts());
    await cloud.settle(0, { snapshot: snapshotNamed("First") });

    void result.current.refresh();
    const pushed = snapshotNamed("Pushed");
    cloud.push(pushed);
    void result.current.refresh();
    await cloud.settle(2, { error: new Error("ipc down") });
    await cloud.settle(1, { snapshot: snapshotNamed("Older") });

    expect(result.current.snapshot).toBe(pushed);
    expect(result.current.loadError).toBe("Couldn't read cloud accounts");
  });

  it("keeps an older read's answer when a newer Retry fails after it", async () => {
    const cloud = stubCloud();
    const { result } = renderHook(() => useCloudHosts());
    await cloud.settle(0, { snapshot: snapshotNamed("First") });

    void result.current.refresh();
    void result.current.refresh();
    const older = snapshotNamed("Older");
    await cloud.settle(1, { snapshot: older });
    await cloud.settle(2, { error: new Error("ipc down") });

    expect(result.current.snapshot).toBe(older);
    expect(result.current.loadError).toBe("Couldn't read cloud accounts");
  });

  it("shows the failure of a read nothing newer has answered, and Retry clears it", async () => {
    const cloud = stubCloud();
    const { result } = renderHook(() => useCloudHosts());

    await cloud.settle(0, { error: new Error("ipc down") });
    expect(result.current.loaded).toBe(true);
    expect(result.current.loadError).toBe("Couldn't read cloud accounts");

    void result.current.refresh();
    const answer = snapshotNamed("Answer");
    await cloud.settle(1, { snapshot: answer });
    expect(result.current.snapshot).toBe(answer);
    expect(result.current.loadError).toBeNull();
  });

  it("ignores a read that lands after the last reader left", async () => {
    const cloud = stubCloud();
    const { result, unmount } = renderHook(() => useCloudHosts());
    const fresh = snapshotNamed("Fresh");
    await cloud.settle(0, { snapshot: fresh });

    void result.current.refresh();
    unmount();
    expect(cloud.listeners.size).toBe(0);
    await cloud.settle(1, { snapshot: snapshotNamed("Late") });

    const again = renderHook(() => useCloudHosts());
    expect(again.result.current.snapshot).toBe(fresh);
  });

  it.each<[string, Outcome]>([
    ["answer", { snapshot: snapshotNamed("Old") }],
    ["failure", { error: new Error("ipc down") }],
  ])(
    "drops an ended subscription's read %s and push while its replacement's read is pending",
    async (_label, outcome) => {
      const cloud = stubCloud();
      const first = renderHook(() => useCloudHosts());
      first.unmount();
      const { result } = renderHook(() => useCloudHosts());
      expect(cloud.listeners.size).toBe(1);
      expect(cloud.reads).toHaveLength(2);

      await cloud.settle(0, outcome);
      const retired = cloud.registered[0];
      if (!retired) throw new Error("The first subscription never listened");
      cloud.deliver({ type: "cloud-changed", snapshot: snapshotNamed("Retired") }, [retired]);
      expect(result.current.loaded).toBe(false);
      expect(result.current.loadError).toBeNull();

      const current = snapshotNamed("Current");
      await cloud.settle(1, { snapshot: current });
      expect(result.current.snapshot).toBe(current);

      const pushed = snapshotNamed("Pushed");
      cloud.push(pushed);
      expect(result.current.snapshot).toBe(pushed);
    }
  );

  it("leaves a pending read alone when another kind of host event arrives", async () => {
    const cloud = stubCloud();
    const { result } = renderHook(() => useCloudHosts());

    cloud.deliver({ type: "host-forgotten", hostId: "studio-01" } as RemoteHostsEvent);
    const answer = snapshotNamed("Answer");
    await cloud.settle(0, { snapshot: answer });

    expect(result.current.snapshot).toBe(answer);
    expect(result.current.loaded).toBe(true);
  });
});
