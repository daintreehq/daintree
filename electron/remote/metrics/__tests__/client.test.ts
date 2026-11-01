import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  HostAttentionEvent,
  HostMetricsEvent,
  HostWorktreeEntry,
} from "../../../../shared/types/ipc/hostMetrics.js";
import type {
  HostConnectionState,
  HostDescriptor,
  HostMetricsSummary,
} from "../../../../shared/types/remoteHosts.js";
import type { ProcessInventorySnapshot } from "../../../../shared/types/processes.js";
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
import { resetHostNoticeBudget } from "../../hybrid/hostNoticeBudget.js";

let dir: string;
const open: LinkSession[] = [];

beforeEach(async () => {
  resetHostNoticeBudget();
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
    assistantControlEnabled: false,
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

function inventoryAnswer() {
  return {
    terminals: [],
    closedTerminalProcesses: [],
    cleanup: null,
    plugins: [],
    complete: true,
    samplesAvailable: true,
    sampledAt: 9,
    truncated: false,
  };
}

function harness(hosts: HostDescriptor[], extra: Partial<HostMetricsClientOptions> = {}) {
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
    listWorktrees: vi.fn(async (): Promise<HostWorktreeEntry[]> => []),
    processInventory: vi.fn(async (): Promise<ProcessInventorySnapshot> => ({
      terminals: [],
      closedTerminalProcesses: [],
      cleanup: null,
      plugins: [],
      complete: true,
      samplesAvailable: true,
      sampledAt: 5,
    })),
    worktreesHeard: null as (() => void) | null,
    onWorktreesMaybeChanged(listener: () => void) {
      local.worktreesHeard = listener;
      return () => {
        local.worktreesHeard = null;
      };
    },
    projectsHeard: null as (() => void) | null,
    onProjectsChanged(listener: () => void) {
      local.projectsHeard = listener;
      return () => {
        local.projectsHeard = null;
      };
    },
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
      localClient: { clientId: "launch-me", clientName: "greg-mbp" },
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
    worktreesChangedDelayMs: 5,
    ...extra,
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
  it("reads a host's link activity, names this launch, and shows its words as plain text", async () => {
    const h = harness([descriptor("studio")]);
    h.hook.call = async () => ({
      observedAt: 10,
      listeningSince: 1,
      version: "0.46.0",
      commit: "abc",
      events: [
        {
          kind: "link-dropped",
          at: 9,
          clientId: "launch-me",
          clientName: "greg\u202e-mbp",
          sessionId: "s1",
          reason: "socket\nclosed",
          by: "transport",
        },
      ],
      eventsTruncated: false,
      drivers: [
        {
          projectId: "p1",
          projectName: "dain\u200btree",
          holder: {
            leaseId: 1,
            endpointId: "s1:e1",
            clientId: "launch-me",
            clientName: "greg-mbp",
            isHostLocal: false,
            acquiredAt: 2,
          },
          state: "away",
          awayUntil: 25,
        },
      ],
      attached: [],
      unknownField: true,
    });
    const result = await h.client.linkActivity({ hostId: "studio" });
    expect(h.calls).toEqual([
      { hostId: "studio", method: MetricsLinkMethod.LINK_ACTIVITY, payload: null },
    ]);
    expect(result).toMatchObject({
      supported: true,
      self: { clientId: "launch-me", clientName: "greg-mbp" },
      activity: {
        events: [{ clientName: "greg-mbp", reason: "socket closed" }],
        drivers: [{ projectName: "daintree", state: "away", awayUntil: 25 }],
      },
    });
    expect(result.supported && result.activity).not.toHaveProperty("unknownField");
  });

  it("never asks this machine's own link activity over a link", async () => {
    const h = harness([descriptor("studio")]);
    await expect(h.client.linkActivity({ hostId: "local" })).rejects.toMatchObject({
      code: "VALIDATION",
    });
    expect(h.calls).toEqual([]);
  });

  it("says a host from before link activity can't report it, and passes other failures on", async () => {
    const h = harness([descriptor("old")]);
    h.hook.call = async () => {
      throw Object.assign(new Error("Unknown method"), { code: "UNSUPPORTED" });
    };
    await expect(h.client.linkActivity({ hostId: "old" })).resolves.toEqual({ supported: false });

    h.hook.call = async () => ({ observedAt: "soon" });
    await expect(h.client.linkActivity({ hostId: "old" })).rejects.toMatchObject({
      code: "INTERNAL",
    });

    h.hook.down.add("old");
    await expect(h.client.linkActivity({ hostId: "old" })).rejects.toMatchObject({
      code: "HOST_DISCONNECTED",
    });
  });

  it("reads a host's process inventory over its link and shows its words as plain text", async () => {
    const h = harness([descriptor("studio")]);
    h.hook.call = async () => ({
      terminals: [
        {
          id: "t1",
          projectId: "p1",
          projectName: "dain\u200btree",
          kind: "terminal",
          title: "build\u202e\nwatch",
          cwd: "/srv/daintree",
          detectedAgentId: "agent-from-the-future",
          isAssistantTerminal: false,
          spawnedAt: 1,
          isTrashed: false,
          rootPid: 40,
          sample: {
            cpuPercent: 250,
            memoryKb: 10,
            processCount: 12,
            members: [{ pid: 41, comm: "no\nde", cpuPercent: 1, memoryKb: 2, argv: ["x"] }],
          },
          agentTree: "a-shape-from-the-future",
          env: { SECRET: "1" },
        },
      ],
      closedTerminalProcesses: [],
      cleanup: null,
      plugins: [],
      complete: true,
      samplesAvailable: true,
      sampledAt: 9,
      truncated: false,
    });
    const result = await h.client.processInventory({ hostId: "studio" });
    expect(h.calls).toEqual([
      { hostId: "studio", method: MetricsLinkMethod.PROCESS_INVENTORY, payload: null },
    ]);
    if (!result.supported) throw new Error("expected an inventory");
    const [terminal] = result.inventory.terminals;
    expect(terminal).toMatchObject({
      title: "build watch",
      projectName: "daintree",
      cwd: "/srv/daintree",
      agentTree: "unknown",
      sample: { cpuPercent: 250, processCount: 12, members: [{ pid: 41, comm: "no de" }] },
    });
    expect(terminal.detectedAgentId).toBeUndefined();
    expect(terminal).not.toHaveProperty("env");
    expect(terminal.sample?.members[0]).not.toHaveProperty("argv");
  });

  it("leaves out a row it can't read and says the list is incomplete", async () => {
    const h = harness([descriptor("studio")]);
    h.hook.call = async () => ({
      ...inventoryAnswer(),
      plugins: [
        {
          source: "plugin-worker",
          id: "w1",
          pluginId: "acme",
          label: null,
          pid: 7,
          spawnedAt: null,
          sample: null,
        },
        { source: "plugin-from-the-future", id: "w2" },
      ],
    });
    const result = await h.client.processInventory({ hostId: "studio" });
    expect(result).toMatchObject({
      supported: true,
      inventory: { plugins: [{ id: "w1" }], truncated: true },
    });
    if (result.supported) expect(result.inventory.plugins).toHaveLength(1);
  });

  it("answers this machine's own process inventory without a link", async () => {
    const h = harness([descriptor("studio")]);
    await expect(h.client.processInventory({ hostId: "local" })).resolves.toMatchObject({
      supported: true,
      inventory: { sampledAt: 5, truncated: false },
    });
    expect(h.local.processInventory).toHaveBeenCalledTimes(1);
    expect(h.calls).toEqual([]);
  });

  it("says a host from before process inventory can't report it, and passes other failures on", async () => {
    const h = harness([descriptor("old")]);
    h.hook.call = async () => {
      throw Object.assign(new Error("Unknown method"), { code: "UNSUPPORTED" });
    };
    await expect(h.client.processInventory({ hostId: "old" })).resolves.toEqual({
      supported: false,
    });

    h.hook.call = async () => ({ ...inventoryAnswer(), terminals: new Array(501).fill(null) });
    await expect(h.client.processInventory({ hostId: "old" })).rejects.toMatchObject({
      code: "INTERNAL",
    });
    h.hook.call = async () => ({ ...inventoryAnswer(), sampledAt: "soon" });
    await expect(h.client.processInventory({ hostId: "old" })).rejects.toMatchObject({
      code: "INTERNAL",
    });

    h.hook.down.add("old");
    await expect(h.client.processInventory({ hostId: "old" })).rejects.toMatchObject({
      code: "HOST_DISCONNECTED",
    });
    await expect(h.client.processInventory({ hostId: "nowhere" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("dials only hosts whose notifications are on, once each", () => {
    const h = harness([descriptor("studio-01", true), descriptor("studio-02")]);
    h.client.start();
    // A saved host with nothing that needs it stays not connected.
    expect(h.connect.mock.calls.map(([id]) => id)).toEqual(["studio-01"]);
    // A registry change (an observation, a rename) doesn't re-dial a host the user disconnected.
    h.setHosts([descriptor("studio-01", true), descriptor("studio-02")]);
    expect(h.connect).toHaveBeenCalledTimes(1);
    h.setHosts([descriptor("studio-01", true), descriptor("studio-02"), descriptor("studio-03")]);
    expect(h.connect).toHaveBeenCalledTimes(1);
    // Turning notifications on needs the light connection, so that dials it.
    h.setHosts([descriptor("studio-01", true), descriptor("studio-02", true)]);
    expect(h.connect).toHaveBeenLastCalledWith("studio-02");
    expect(h.connect).toHaveBeenCalledTimes(2);
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
    expect(h.client.observedAgents("studio-01")).toBeNull();
    h.states.set("studio-01", {
      status: "connected",
      rttMs: 3,
      handshake: { version: "1", commit: "c", protocolVersion: 1, platform: "linux", arch: "x64" },
    });
    expect(h.client.observedAgents("studio-01")).toEqual({ working: 5, waiting: 0 });
    h.client.dispose();
  });

  it("keeps a frame's timing beside its summary, bounded by the ping it followed (#14462)", async () => {
    const h = harness([descriptor("studio-01")]);
    h.client.start();
    // This Shell's pings, dated an hour back on its own clocks.
    const longAgo = { wall: Date.now() - 3_600_000, mono: performance.now() - 3_600_000 };
    const p = await openSessionPair(dir, {}, { clock: () => longAgo });
    open.push(p.host, p.client);
    h.openSession("studio-01", p.client);
    p.client.ping();
    await waitFor(() => p.host.peerPingNonce === 0);
    const post = (timing: object) =>
      p.host.post({
        lane: Lane.CONTROL,
        kind: ControlKind.HOST_SUMMARY,
        body: { ...summary(1), timing } as never,
      });

    post({ sampleAgeMs: 200, afterPing: 0 });
    await waitFor(() => h.emitted.length === 1);
    const held = h.client.latest("studio-01")!;
    expect(held).not.toHaveProperty("timing");
    expect(JSON.stringify(h.emitted)).not.toContain("timing");
    // However quick the trip looked, the frame can be as old as the ping it followed.
    const receipt = h.client.receiptOf(held)!;
    expect(receipt.hostAgeMs).toBe(200);
    expect(receipt.maxAgeMs).toBeGreaterThanOrEqual(3_600_200);

    post({ sampleAgeMs: 200, afterPing: 7 });
    await waitFor(() => h.emitted.length === 2);
    expect(h.client.receiptOf(h.client.latest("studio-01")!)).toMatchObject({
      hostAgeMs: 200,
      maxAgeMs: null,
    });
    expect(h.client.receiptOf(summary(1))).toBeNull();
    h.client.dispose();
  });

  it("bounds a frame after a reconnect or host restart by the new session's pings alone", async () => {
    const h = harness([descriptor("studio-01")]);
    h.client.start();
    const longAgo = { wall: Date.now() - 3_600_000, mono: performance.now() - 3_600_000 };
    const before = await openSessionPair(dir, {}, { clock: () => longAgo });
    open.push(before.host, before.client);
    h.openSession("studio-01", before.client);
    before.client.ping();
    await waitFor(() => before.host.peerPingNonce === 0);
    before.host.post({
      lane: Lane.CONTROL,
      kind: ControlKind.HOST_SUMMARY,
      body: { ...summary(500), timing: { sampleAgeMs: 0, afterPing: 0 } } as never,
    });
    await waitFor(() => h.emitted.length === 1);
    const old = h.client.latest("studio-01")!;
    before.client.close("reconnecting");

    // The restarted host numbers from zero again, and its clock reads earlier.
    const now = { wall: Date.now(), mono: performance.now() };
    const after = await openSessionPair(dir, {}, { clock: () => now });
    open.push(after.host, after.client);
    h.openSession("studio-01", after.client);
    after.client.ping();
    await waitFor(() => after.host.peerPingNonce === 0);
    after.host.post({
      lane: Lane.CONTROL,
      kind: ControlKind.HOST_SUMMARY,
      body: { ...summary(1), timing: { sampleAgeMs: 50, afterPing: 0 } } as never,
    });
    await waitFor(() => h.emitted.length === 2);
    const fresh = h.client.latest("studio-01")!;
    expect(fresh.sampledAt).toBe(1);
    const bound = h.client.receiptOf(fresh)!.maxAgeMs!;
    expect(bound).toBeGreaterThanOrEqual(50);
    expect(bound).toBeLessThan(3_600_000);
    // The summary from before keeps the bound its own session gave it.
    expect(h.client.receiptOf(old)!.maxAgeMs).toBeGreaterThanOrEqual(3_600_000);
    // And each is known by the session it came on (#15736).
    expect(h.client.cameOn(fresh, after.client)).toBe(true);
    expect(h.client.cameOn(old, after.client)).toBe(false);
    h.client.dispose();
  });

  it("tells which link each summary came on, keeping the history across a reconnect (#15736)", () => {
    const h = harness([descriptor("studio-01")]);
    const before = { pingSentAt: () => null } as unknown as LinkSession;
    const after = { pingSentAt: () => null } as unknown as LinkSession;
    h.client.record("studio-01", summary(1, 3), before);
    const first = h.client.latest("studio-01")!;
    h.client.record("studio-01", summary(2, 3), before);
    const old = h.client.latest("studio-01")!;
    // Every summary one link brings is that link's.
    expect(h.client.cameOn(first, before)).toBe(true);
    expect(h.client.cameOn(old, before)).toBe(true);
    // Reconnected, or with no link open at all, it is what an earlier link brought.
    expect(h.client.cameOn(old, after)).toBe(false);
    expect(h.client.cameOn(old, null)).toBe(false);

    h.client.record("studio-01", summary(3, 1), after);
    const fresh = h.client.latest("studio-01")!;
    expect(h.client.cameOn(fresh, after)).toBe(true);
    expect(h.client.cameOn(old, after)).toBe(false);
    expect(h.client.getSnapshots()).toEqual([
      { hostId: "studio-01", history: [fresh, old, first] },
    ]);

    // One that came on no link, as this machine's own do, can't be told either way.
    h.client.record("studio-01", summary(4));
    expect(h.client.cameOn(h.client.latest("studio-01")!, after)).toBeNull();
    expect(h.client.cameOn(summary(5), after)).toBeNull();
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
      projectId: "p1",
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
        projectId: "p1",
        projectName: "app",
        agentName: "Claude",
        quiet: true,
      },
    ]);
    h.client.dispose();
  });

  it("carries the host's project id, a null one, and none from a host that predates it", async () => {
    const h = harness([descriptor("loud", true)]);
    h.client.start();
    const loud = await openSessionPair(dir);
    open.push(loud.host, loud.client);
    h.openSession("loud", loud.client);
    const base = { kind: "waiting", projectName: "app", agentName: null, quiet: false };
    await loud.host.call(MetricsLinkMethod.ATTENTION, {
      ...base,
      terminalId: "a",
      projectId: "p9",
    });
    await loud.host.call(MetricsLinkMethod.ATTENTION, {
      ...base,
      terminalId: "b",
      projectId: null,
    });
    await loud.host.call(MetricsLinkMethod.ATTENTION, { ...base, terminalId: "c" });
    expect(h.attention.map((e) => e.projectId)).toEqual(["p9", null, null]);
    h.client.dispose();
  });

  it("tells every view a host's worktree list changed, whether or not its notifications are on", async () => {
    const h = harness([descriptor("quiet")]);
    h.client.start();
    const quiet = await openSessionPair(dir);
    open.push(quiet.host, quiet.client);
    h.openSession("quiet", quiet.client);
    await quiet.host.call(MetricsLinkMethod.WORKTREES_CHANGED, null);
    expect(h.emitted).toContainEqual({ type: "worktrees", hostId: "quiet" });
    h.client.dispose();
  });

  it("tells every view a host's projects changed, apart from its worktrees", async () => {
    const h = harness([descriptor("quiet")]);
    h.client.start();
    const quiet = await openSessionPair(dir);
    open.push(quiet.host, quiet.client);
    h.openSession("quiet", quiet.client);
    await quiet.host.call(MetricsLinkMethod.PROJECTS_CHANGED, null);
    expect(h.emitted).toContainEqual({ type: "projects", hostId: "quiet" });
    expect(h.emitted.some((event) => event.type === "worktrees")).toBe(false);
    h.client.dispose();
  });

  it("follows this machine's projects only while another host exists", () => {
    const h = harness([]);
    h.client.start();
    expect(h.local.projectsHeard).toBeNull();

    h.setHosts([descriptor("a")]);
    h.local.projectsHeard?.();
    expect(h.emitted).toEqual([{ type: "projects", hostId: "local" }]);

    h.setHosts([]);
    expect(h.local.projectsHeard).toBeNull();

    // Followed again once another host is back, and let go on dispose.
    h.setHosts([descriptor("a")]);
    h.local.projectsHeard?.();
    expect(h.emitted).toEqual([
      { type: "projects", hostId: "local" },
      { type: "projects", hostId: "local" },
    ]);
    h.client.dispose();
    expect(h.local.projectsHeard).toBeNull();
  });

  it("follows this machine's worktree list only while another host exists", async () => {
    const h = harness([]);
    h.client.start();
    expect(h.local.worktreesHeard).toBeNull();

    h.setHosts([descriptor("a")]);
    expect(h.local.worktreesHeard).not.toBeNull();
    h.local.worktreesHeard?.();
    await waitFor(() => h.emitted.some((event) => event.type === "worktrees"));
    expect(h.emitted.filter((event) => event.type === "worktrees")).toEqual([
      { type: "worktrees", hostId: "local" },
    ]);

    h.setHosts([]);
    expect(h.local.worktreesHeard).toBeNull();
    h.client.dispose();
  });

  it("reads a host's worktrees from before observations as observing nothing, never idle", async () => {
    const h = harness([descriptor("old")]);
    h.hook.call = async () => [
      {
        projectId: "p1",
        projectName: "app",
        worktreeId: "/srv/app",
        name: "app",
        branch: "main",
        path: "/srv/app",
        isMainWorktree: true,
        modifiedCount: null,
        lastActivityAt: null,
      },
    ];
    const entries = await h.client.listWorktrees({ hostId: "old" });
    expect(entries).toEqual([
      expect.objectContaining({ hostId: "old", worktreeId: "/srv/app", observed: null }),
    ]);
    expect(entries[0]).not.toHaveProperty("runs");
  });

  it("keeps each agent a host observed in a worktree, with the terminal a switch can focus", async () => {
    const h = harness([descriptor("new")]);
    h.hook.call = async () => [
      {
        projectId: "p1",
        projectName: "app",
        worktreeId: "/srv/app",
        name: "app",
        branch: "main",
        path: "/srv/app",
        isMainWorktree: true,
        modifiedCount: null,
        lastActivityAt: null,
        observed: { band: "needs-you", agentState: "waiting" },
        runs: [
          { terminalId: "t2", band: "needs-you", agentState: "waiting", extra: "dropped" },
          { terminalId: "t1", band: "running", agentState: "working" },
        ],
      },
    ];
    const [entry] = await h.client.listWorktrees({ hostId: "new" });
    expect(entry?.runs).toEqual([
      { terminalId: "t2", band: "needs-you", agentState: "waiting" },
      { terminalId: "t1", band: "running", agentState: "working" },
    ]);
  });

  it("holds a host's attention to its notice budget and shows its names as plain text", async () => {
    const h = harness([descriptor("loud", true)]);
    h.client.start();
    const loud = await openSessionPair(dir);
    open.push(loud.host, loud.client);
    h.openSession("loud", loud.client);
    for (let i = 0; i < 8; i++) {
      await loud.host.call(MetricsLinkMethod.ATTENTION, {
        kind: "waiting",
        terminalId: `t${i}`,
        projectName: "\u202eppa",
        agentName: null,
        quiet: false,
      });
    }
    expect(h.attention).toHaveLength(6);
    expect(h.attention[0]).toMatchObject({ projectName: "ppa", agentName: null });
    h.client.dispose();
  });

  it("judges a host's waiting agent by this machine's choices, before its notice budget (#14701)", async () => {
    let policy: "silent" | "quiet" | "announce" = "silent";
    const h = harness([descriptor("loud", true)], { waitingPolicy: () => policy });
    h.client.start();
    const loud = await openSessionPair(dir);
    open.push(loud.host, loud.client);
    h.openSession("loud", loud.client);
    const attend = (terminalId: string, quiet = false) =>
      loud.host.call(MetricsLinkMethod.ATTENTION, {
        kind: "waiting",
        terminalId,
        projectName: null,
        agentName: null,
        quiet,
      });

    // Waiting alerts off here: nothing shows, and none of the host's share is spent.
    for (let i = 0; i < 8; i++) await attend(`off-${i}`);
    expect(h.attention).toEqual([]);

    policy = "quiet";
    await attend("quiet");
    policy = "announce";
    await attend("loud");
    // An older host that judged it quiet by its own hours still can't make it loud.
    await attend("host-quiet", true);
    expect(h.attention.map((e) => [e.terminalId, e.quiet])).toEqual([
      ["quiet", true],
      ["loud", false],
      ["host-quiet", true],
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
    expect(h.client.observedAgents("studio-01")).toBeNull();
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

  it("tells summary listeners of each recorded summary without dialling anything (#14463)", () => {
    const h = harness([descriptor("studio-01")]);
    h.client.start();
    const heard: string[] = [];
    const off = h.client.onSummary((hostId) => heard.push(hostId));
    const offThrowing = h.client.onSummary(() => {
      throw new Error("listener broke");
    });
    h.client.record("studio-01", summary(1));
    offThrowing();
    off();
    h.client.record("studio-01", summary(2));
    expect(heard).toEqual(["studio-01"]);
    expect(h.client.latest("studio-01")?.sampledAt).toBe(2);
    expect(h.connect).not.toHaveBeenCalled();
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
    // Notifications are off: nothing here dials it, before or after.
    expect(h.connect).not.toHaveBeenCalled();
    h.client.dispose();
  });
});
