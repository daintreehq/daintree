import { beforeEach, describe, expect, it } from "vitest";
import type { HostListEntry, HostMetricsSummary } from "@shared/types/remoteHosts";
import { useRemoteHostsStore } from "../remoteHostsStore";

const host: HostListEntry = {
  descriptor: {
    id: "studio",
    name: "studio",
    connection: { kind: "ssh", target: "studio" },
    platform: null,
    arch: null,
    lastHandshake: null,
    lastSeenAt: null,
    addedAt: 0,
    notificationsEnabled: false,
    assistantControlEnabled: false,
  },
  connection: { status: "disconnected" },
  summary: null,
};

function report(hostId: string, sampledAt: number): HostMetricsSummary {
  return {
    hostId,
    sampledAt,
    platform: "linux",
    cpuPercent: null,
    memoryPressure: null,
    memoryUsedBytes: null,
    memoryTotalBytes: null,
    swapUsedBytes: null,
    swapTotalBytes: null,
    thermal: null,
    cpuPressure: null,
    agentsObserved: null,
    projectCount: null,
    worktreeCount: null,
    driver: null,
    agentClis: [],
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => useRemoteHostsStore.getState().reset());

describe("remoteHostsStore", () => {
  it("replaces the list on hosts-changed and patches one host's connection", () => {
    const store = useRemoteHostsStore.getState();
    store.applyEvent({ type: "hosts-changed", hosts: [host] });
    store.applyEvent({
      type: "connection-changed",
      hostId: "studio",
      connection: { status: "connecting", attempt: 2 },
    });
    const state = useRemoteHostsStore.getState();
    expect(state.loaded).toBe(true);
    expect(state.hosts[0]!.connection).toEqual({ status: "connecting", attempt: 2 });
  });

  it("follows an install from progress to its settled outcome", () => {
    const store = useRemoteHostsStore.getState();
    store.trackInstall("op-1", { kind: "ssh", target: "studio" });
    store.applyEvent({
      type: "install-progress",
      opId: "op-1",
      connection: { kind: "ssh", target: "studio" },
      progress: {
        opId: "op-1",
        kind: "host-update",
        fraction: 0.5,
        stage: "copying",
        message: "Copying the build to the host",
        at: 1,
      },
    });
    expect(useRemoteHostsStore.getState().installs["op-1"]).toMatchObject({
      connection: { kind: "ssh", target: "studio" },
      progress: { stage: "copying" },
      outcome: null,
    });
    store.applyEvent({
      type: "install-settled",
      opId: "op-1",
      connection: { kind: "ssh", target: "studio" },
      outcome: { status: "cancelled", settledAt: 2 },
    });
    expect(useRemoteHostsStore.getState().installs["op-1"]).toMatchObject({
      progress: { stage: "copying" },
      outcome: { status: "cancelled" },
    });
  });

  it("takes each host's reports as they arrive, and drops them when its link goes", () => {
    const store = useRemoteHostsStore.getState();
    store.applyEvent({ type: "hosts-changed", hosts: [host] });
    const summary = report("studio", 5);
    store.applySummary(summary);
    store.applySummary(report("elsewhere", 6));
    expect(useRemoteHostsStore.getState().hosts.map((h) => h.summary)).toEqual([summary]);

    store.applyEvent({
      type: "connection-changed",
      hostId: "studio",
      connection: {
        status: "connected",
        rttMs: 1,
        handshake: {
          version: "1",
          commit: "c",
          protocolVersion: 1,
          platform: "linux",
          arch: "x64",
        },
      },
    });
    expect(useRemoteHostsStore.getState().hosts[0]!.summary).toBe(summary);
    store.applyEvent({
      type: "connection-changed",
      hostId: "studio",
      connection: { status: "unreachable", lastSeenAt: 5, detail: null },
    });
    expect(useRemoteHostsStore.getState().hosts[0]!.summary).toBeNull();
  });

  it("takes a read's list, or says why it couldn't", async () => {
    const store = useRemoteHostsStore.getState();
    await store.loadHosts(async () => {
      throw new Error("socket closed");
    });
    expect(useRemoteHostsStore.getState()).toMatchObject({
      hosts: [],
      loaded: true,
      loadError: "socket closed",
    });

    await store.loadHosts(async () => [host]);
    expect(useRemoteHostsStore.getState()).toMatchObject({
      hosts: [host],
      loaded: true,
      loadError: null,
    });
  });

  it("keeps a list that landed while a read was out over that read's older answer", async () => {
    const early = deferred<HostListEntry[]>();
    const store = useRemoteHostsStore.getState();
    const loading = store.loadHosts(() => early.promise);
    store.applyEvent({ type: "hosts-changed", hosts: [host] });
    early.resolve([]);
    await loading;
    expect(useRemoteHostsStore.getState().hosts).toEqual([host]);
  });

  it("drops an older read's failure once a newer list landed", async () => {
    const early = deferred<HostListEntry[]>();
    const store = useRemoteHostsStore.getState();
    const loading = store.loadHosts(() => early.promise);
    store.applyEvent({ type: "hosts-changed", hosts: [host] });
    early.reject(new Error("socket closed"));
    await loading;
    expect(useRemoteHostsStore.getState()).toMatchObject({ hosts: [host], loadError: null });
  });

  it("lets the newest of two reads win, whichever answers last", async () => {
    const older = deferred<HostListEntry[]>();
    const store = useRemoteHostsStore.getState();
    const first = store.loadHosts(() => older.promise);
    await store.loadHosts(async () => [host]);
    older.resolve([]);
    await first;
    expect(useRemoteHostsStore.getState().hosts).toEqual([host]);

    store.reset();
    const stale = deferred<HostListEntry[]>();
    const newest = deferred<HostListEntry[]>();
    const staleLoad = store.loadHosts(() => stale.promise);
    const newestLoad = store.loadHosts(() => newest.promise);
    stale.resolve([host]);
    await staleLoad;
    expect(useRemoteHostsStore.getState()).toMatchObject({ hosts: [], loaded: false });
    newest.resolve([]);
    await newestLoad;
    expect(useRemoteHostsStore.getState()).toMatchObject({ hosts: [], loaded: true });
  });

  it("keeps a list it was handed over the answer of a read made before it", async () => {
    const early = deferred<HostListEntry[]>();
    const store = useRemoteHostsStore.getState();
    const loading = store.loadHosts(() => early.promise);
    store.setHosts([host]);
    early.reject(new Error("socket closed"));
    await loading;
    expect(useRemoteHostsStore.getState()).toMatchObject({ hosts: [host], loadError: null });
  });

  it("never lets a read from before a whole list or a reset land over a read made after it", async () => {
    const other: HostListEntry = { ...host, descriptor: { ...host.descriptor, id: "bigbox" } };
    const invalidators = [
      () => useRemoteHostsStore.getState().applyEvent({ type: "hosts-changed", hosts: [] }),
      () => useRemoteHostsStore.getState().setHosts([]),
      () => useRemoteHostsStore.getState().reset(),
    ];
    for (const invalidate of invalidators) {
      // Run once first, so an invalidator that rewound the epoch would hand the later read the stale one's.
      invalidate();
      const early = deferred<HostListEntry[]>();
      const loading = useRemoteHostsStore.getState().loadHosts(() => early.promise);
      invalidate();
      await useRemoteHostsStore.getState().loadHosts(async () => [other]);
      early.resolve([host]);
      await loading;
      expect(useRemoteHostsStore.getState().hosts).toEqual([other]);
    }
  });

  it("drops a read made before a reset", async () => {
    const early = deferred<HostListEntry[]>();
    const loading = useRemoteHostsStore.getState().loadHosts(() => early.promise);
    useRemoteHostsStore.getState().reset();
    early.resolve([host]);
    await loading;
    expect(useRemoteHostsStore.getState()).toMatchObject({ hosts: [], loaded: false });
  });

  it("ignores events it has no use for", () => {
    const before = useRemoteHostsStore.getState();
    before.applyEvent({ type: "resync-required", hostId: "studio", reason: "overflow" });
    expect(useRemoteHostsStore.getState().hosts).toBe(before.hosts);
  });
});
