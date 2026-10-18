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

  it("ignores events it has no use for", () => {
    const before = useRemoteHostsStore.getState();
    before.applyEvent({ type: "resync-required", hostId: "studio", reason: "overflow" });
    expect(useRemoteHostsStore.getState().hosts).toBe(before.hosts);
  });
});
