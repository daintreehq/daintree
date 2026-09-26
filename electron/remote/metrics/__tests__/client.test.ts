import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  HostAttentionEvent,
  HostMetricsEvent,
} from "../../../../shared/types/ipc/hostMetrics.js";
import type {
  HostConnectionState,
  HostDescriptor,
  HostMetricsSummary,
} from "../../../../shared/types/remoteHosts.js";
import { Lane } from "../../link/frames.js";
import { ControlKind } from "../../link/messages.js";
import type { LinkSession } from "../../link/session.js";
import {
  makeTempDir,
  openSessionPair,
  removeTempDir,
  waitFor,
} from "../../link/__tests__/linkTestUtils.js";
import { HostMetricsClient, type HostMetricsClientOptions } from "../client.js";
import { MetricsLinkMethod } from "../linkMethods.js";

let dir: string;
const open: LinkSession[] = [];

beforeEach(async () => {
  dir = await makeTempDir();
});

afterEach(async () => {
  for (const session of open.splice(0)) session.close("test done");
  await removeTempDir(dir);
});

function descriptor(id: string, notificationsEnabled = false): HostDescriptor {
  return {
    id,
    name: `name-${id}`,
    connection: { kind: "ssh", target: id },
    platform: "linux",
    arch: "x64",
    lastHandshake: null,
    lastSeenAt: null,
    addedAt: 0,
    notificationsEnabled,
  };
}

function summary(sampledAt: number, working = 0): HostMetricsSummary {
  return {
    hostId: "local",
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
    agentsObserved: { working, waiting: 0, idle: 0 },
    projectCount: 0,
    worktreeCount: 0,
    driver: null,
    agentClis: [],
  };
}

function harness(hosts: HostDescriptor[]) {
  let list = hosts;
  const registryListeners = new Set<() => void>();
  const sessionListeners = new Set<(hostId: string, session: LinkSession) => void>();
  const states = new Map<string, HostConnectionState>();
  const calls: Array<{ hostId: string; method: string; payload: unknown }> = [];
  const connect = vi.fn();
  const emitted: HostMetricsEvent[] = [];
  const attention: HostAttentionEvent[] = [];
  const localListeners = new Set<(summary: HostMetricsSummary) => void>();
  const hook: {
    call: ((hostId: string, method: string, payload: unknown) => Promise<unknown>) | null;
    down: Set<string>;
  } = { call: null, down: new Set() };
  const local = {
    listFleetTargets: vi.fn(async () => ({ targets: [], complete: true })),
    submitFleet: vi.fn(async () => {}),
    listWorktrees: vi.fn(async () => []),
  };
  const options: HostMetricsClientOptions = {
    manager: {
      connect,
      get: (hostId) =>
        list.some((h) => h.id === hostId) && !hook.down.has(hostId)
          ? {
              callHost: async (method, payload) => {
                calls.push({ hostId, method, payload });
                if (hook.call) return hook.call(hostId, method, payload);
                return method === MetricsLinkMethod.LIST_FLEET_TARGETS
                  ? {
                      targets: [
                        {
                          terminalId: "t1",
                          title: "Claude",
                          projectId: null,
                          projectName: null,
                          agentId: "claude",
                          agentState: "working",
                        },
                      ],
                      complete: false,
                    }
                  : null;
              },
            }
          : undefined,
      connectionState: (hostId) => states.get(hostId) ?? { status: "disconnected" },
      onSessionOpened(listener) {
        sessionListeners.add(listener);
        return () => sessionListeners.delete(listener);
      },
    },
    registry: {
      list: () => list,
      get: (hostId) => list.find((h) => h.id === hostId) ?? null,
      onChange(listener) {
        registryListeners.add(listener);
        return () => registryListeners.delete(listener);
      },
    },
    localLoop: {
      subscribe(listener) {
        localListeners.add(listener);
        return () => localListeners.delete(listener);
      },
    },
    emit: (event) => emitted.push(event),
    deliverAttention: (event) => {
      attention.push(event);
      return true;
    },
    local,
    ringSize: 3,
    fleetReconcileMs: 200,
  };
  const client = new HostMetricsClient(options);
  return {
    client,
    connect,
    emitted,
    attention,
    calls,
    local,
    states,
    localListeners,
    hook,
    setHosts(next: HostDescriptor[]) {
      list = next;
      for (const listener of registryListeners) listener();
    },
    openSession(hostId: string, session: LinkSession) {
      for (const listener of sessionListeners) listener(hostId, session);
    },
  };
}

describe("HostMetricsClient", () => {
  it("dials each known host once for summaries, even with no window bound to it", () => {
    const h = harness([descriptor("studio-01"), descriptor("studio-02")]);
    h.client.start();
    expect(h.connect.mock.calls.map(([id]) => id)).toEqual(["studio-01", "studio-02"]);
    // A registry change (an observation, a rename) doesn't re-dial a host the user disconnected.
    h.setHosts([descriptor("studio-01"), descriptor("studio-02")]);
    expect(h.connect).toHaveBeenCalledTimes(2);
    h.setHosts([descriptor("studio-01"), descriptor("studio-02"), descriptor("studio-03")]);
    expect(h.connect).toHaveBeenLastCalledWith("studio-03");
    h.client.dispose();
  });

  it("samples this machine only while another host exists", () => {
    const h = harness([]);
    h.client.start();
    expect(h.localListeners.size).toBe(0);
    h.setHosts([descriptor("studio-01")]);
    expect(h.localListeners.size).toBe(1);
    for (const listener of h.localListeners) listener(summary(5));
    expect(h.client.latest("local")?.sampledAt).toBe(5);
    h.setHosts([]);
    expect(h.localListeners.size).toBe(0);
    expect(h.client.latest("local")).toBeNull();
    h.client.dispose();
  });

  it("keeps a bounded ring per host, stamped with this Shell's id for it", async () => {
    const h = harness([descriptor("studio-01")]);
    h.client.start();
    const p = await openSessionPair(dir);
    open.push(p.host, p.client);
    h.openSession("studio-01", p.client);
    for (let i = 1; i <= 5; i += 1) {
      p.host.post({ lane: Lane.CONTROL, kind: ControlKind.HOST_SUMMARY, body: summary(i, i) });
    }
    await waitFor(() => h.emitted.length === 5);
    const [snapshot] = h.client.getSnapshots();
    expect(snapshot!.hostId).toBe("studio-01");
    expect(snapshot!.history.map((s) => s.sampledAt)).toEqual([5, 4, 3]);
    expect(snapshot!.history.every((s) => s.hostId === "studio-01")).toBe(true);
    // The working count reaches the update gate only while the link is up.
    expect(h.client.workingAgents("studio-01")).toBeNull();
    h.states.set("studio-01", {
      status: "connected",
      rttMs: 3,
      handshake: { version: "1", commit: "c", protocolVersion: 1, platform: "linux", arch: "x64" },
    });
    expect(h.client.workingAgents("studio-01")).toBe(5);
    h.client.dispose();
  });

  it("presents attention only for hosts the user opted in to", async () => {
    const h = harness([descriptor("quiet"), descriptor("loud", true)]);
    h.client.start();
    const quiet = await openSessionPair(dir);
    const loud = await openSessionPair(dir);
    open.push(quiet.host, quiet.client, loud.host, loud.client);
    h.openSession("quiet", quiet.client);
    h.openSession("loud", loud.client);
    const payload = {
      kind: "waiting",
      terminalId: "t1",
      projectName: "app",
      agentName: "Claude",
      quiet: true,
    };
    await quiet.host.call(MetricsLinkMethod.ATTENTION, payload);
    await loud.host.call(MetricsLinkMethod.ATTENTION, payload);
    expect(h.attention).toEqual([
      {
        type: "attention",
        hostId: "loud",
        hostName: "name-loud",
        kind: "waiting",
        terminalId: "t1",
        projectName: "app",
        agentName: "Claude",
        quiet: true,
      },
    ]);
    h.client.dispose();
  });

  it("gives the update gate unknown, not zero, when the host couldn't observe every agent", async () => {
    const h = harness([descriptor("studio-01")]);
    h.client.start();
    const p = await openSessionPair(dir);
    open.push(p.host, p.client);
    h.openSession("studio-01", p.client);
    h.states.set("studio-01", {
      status: "connected",
      rttMs: 3,
      handshake: { version: "1", commit: "c", protocolVersion: 1, platform: "linux", arch: "x64" },
    });
    p.host.post({
      lane: Lane.CONTROL,
      kind: ControlKind.HOST_SUMMARY,
      body: { ...summary(1, 0), agentsObserved: null, projectCount: null, worktreeCount: null },
    });
    await waitFor(() => h.emitted.length === 1);
    expect(h.client.latest("studio-01")?.agentsObserved).toBeNull();
    expect(h.client.workingAgents("studio-01")).toBeNull();
    h.client.dispose();
  });

  it("routes fleet reads and submits to the named host, or to this machine for local", async () => {
    const h = harness([descriptor("studio-01")]);
    h.client.start();
    const list = await h.client.listFleetTargets({ hostId: "studio-01" });
    expect(list.targets).toEqual([
      expect.objectContaining({ hostId: "studio-01", terminalId: "t1" }),
    ]);
    // The host's own word on completeness crosses the link unchanged.
    expect(list.complete).toBe(false);
    await h.client.submitFleet({ hostId: "studio-01", terminalId: "t1", text: "hello" });
    expect(h.calls.at(-1)).toEqual({
      hostId: "studio-01",
      method: MetricsLinkMethod.SUBMIT_FLEET,
      payload: { terminalId: "t1", text: "hello", opId: null },
    });
    await h.client.submitFleet({ hostId: "local", terminalId: "t9", text: "here", opId: "op-9" });
    expect(h.local.submitFleet).toHaveBeenCalledWith("t9", "here", { kind: "local" }, "op-9");
    await expect(
      h.client.submitFleet({ hostId: "nowhere", terminalId: "t1", text: "x" })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      h.client.submitFleet({ hostId: "studio-01", terminalId: "t1", text: "" })
    ).rejects.toMatchObject({ code: "VALIDATION" });
    h.client.dispose();
  });

  it("asks again under the same opId when a submit's answer is lost, once the host is back", async () => {
    const h = harness([descriptor("studio-01")]);
    h.client.start();
    let attempts = 0;
    h.hook.call = async () => {
      attempts += 1;
      if (attempts === 1) {
        // The link dropped after the request went out: the host may have run it.
        h.hook.down.add("studio-01");
        setTimeout(() => {
          h.hook.down.delete("studio-01");
          h.openSession("studio-01", {
            on: () => () => {},
            registerCallHandler: () => {},
          } as unknown as LinkSession);
        }, 10);
        throw Object.assign(new Error("Link closed"), { code: "OUTCOME_UNKNOWN" });
      }
      return null;
    };
    await h.client.submitFleet({
      hostId: "studio-01",
      terminalId: "t1",
      text: "hello",
      opId: "op-1",
    });
    const submits = h.calls.filter((c) => c.method === MetricsLinkMethod.SUBMIT_FLEET);
    expect(submits.map((c) => c.payload)).toEqual([
      { terminalId: "t1", text: "hello", opId: "op-1" },
      { terminalId: "t1", text: "hello", opId: "op-1" },
    ]);
    h.client.dispose();
  });

  it("keeps the outcome unknown when the re-ask fails on this side of the link", async () => {
    const h = harness([descriptor("studio-01")]);
    h.client.start();
    let attempts = 0;
    h.hook.call = async () => {
      attempts += 1;
      if (attempts === 1) {
        h.hook.down.add("studio-01");
        setTimeout(() => {
          h.hook.down.delete("studio-01");
          h.openSession("studio-01", {
            on: () => () => {},
            registerCallHandler: () => {},
          } as unknown as LinkSession);
        }, 10);
        throw Object.assign(new Error("Link closed"), { code: "OUTCOME_UNKNOWN" });
      }
      // A full send queue never reached the host: it says nothing about the first send.
      throw Object.assign(new Error("Link send queue is full"), { code: "RATE_LIMITED" });
    };
    await expect(
      h.client.submitFleet({ hostId: "studio-01", terminalId: "t1", text: "x", opId: "op-4" })
    ).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
    expect(attempts).toBe(2);
    h.client.dispose();
  });

  it("reports the outcome unknown when the host doesn't come back, and never re-asks without an opId", async () => {
    const h = harness([descriptor("studio-01")]);
    h.client.start();
    h.hook.call = async () => {
      h.hook.down.add("studio-01");
      throw Object.assign(new Error("Link closed"), { code: "OUTCOME_UNKNOWN" });
    };
    await expect(
      h.client.submitFleet({ hostId: "studio-01", terminalId: "t1", text: "x", opId: "op-2" })
    ).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
    h.hook.down.delete("studio-01");
    h.calls.length = 0;
    await expect(
      h.client.submitFleet({ hostId: "studio-01", terminalId: "t1", text: "x" })
    ).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
    expect(h.calls).toHaveLength(1);
    // A refusal is an answer: it is not asked again.
    h.hook.down.delete("studio-01");
    h.calls.length = 0;
    h.hook.call = async () => {
      throw Object.assign(new Error("driven"), { code: "DRIVEN_ELSEWHERE" });
    };
    await expect(
      h.client.submitFleet({ hostId: "studio-01", terminalId: "t1", text: "x", opId: "op-3" })
    ).rejects.toMatchObject({ code: "DRIVEN_ELSEWHERE" });
    expect(h.calls).toHaveLength(1);
    h.client.dispose();
  });

  it("drops a host's history when its SSH target changes to another machine", () => {
    const h = harness([descriptor("studio-01")]);
    h.client.start();
    h.client.record("studio-01", summary(1));
    h.setHosts([{ ...descriptor("studio-01"), name: "renamed" }]);
    expect(h.client.latest("studio-01")?.sampledAt).toBe(1);
    h.setHosts([{ ...descriptor("studio-01"), connection: { kind: "ssh", target: "elsewhere" } }]);
    expect(h.client.latest("studio-01")).toBeNull();
    expect(h.connect).toHaveBeenCalledTimes(1);
    h.client.dispose();
  });
});
