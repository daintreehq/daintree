import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostMetricsSummary } from "../../../../shared/types/remoteHosts.js";
import type { AgentUsageReading } from "../../../../shared/types/ipc/agentUsage.js";
import { Lane } from "../../link/frames.js";
import { ControlKind, type LinkClientInfo } from "../../link/messages.js";
import type { LinkSession } from "../../link/session.js";
import {
  makeTempDir,
  openSessionPair,
  removeTempDir,
  waitFor,
} from "../../link/__tests__/linkTestUtils.js";
import {
  AgentStopChangePayloadSchema,
  AgentWaitingPayloadSchema,
  AttentionPayloadSchema,
  MAX_PROCESS_TERMINALS,
  MetricsLinkMethod,
  ProcessInventorySchema,
} from "../linkMethods.js";
import type { ProcessInventorySnapshot } from "../../../../shared/types/processes.js";
import { EmptyPayloadSchema } from "../../host/linkMethods.js";
import type {
  HostLinkActivity,
  HostWorktreeEntry,
} from "../../../../shared/types/ipc/hostMetrics.js";
import {
  ATTENTION_COOLDOWN_MS,
  installHostMetricsHostWith,
  installLinkActivityHost,
  installProcessInventoryHost,
  type MetricsHostDeps,
  type MetricsSessionSource,
  type WaitingEvent,
} from "../hostMetricsHost.js";
import type {
  AgentStopChangePayload,
  AgentWaitingPayload,
  AttentionPayload,
} from "../linkMethods.js";
import type { AgentStopChange } from "../agentStops.js";
import { SummaryLoop } from "../summaryLoop.js";

let dir: string;
const open: LinkSession[] = [];

beforeEach(async () => {
  dir = await makeTempDir();
});

afterEach(async () => {
  for (const session of open.splice(0)) session.close("test done");
  await removeTempDir(dir);
});

function summary(sampledAt: number): HostMetricsSummary {
  return {
    hostId: "local",
    sampledAt,
    platform: "linux",
    cpuPercent: 10,
    memoryPressure: "normal",
    memoryUsedBytes: 1,
    memoryTotalBytes: 2,
    swapUsedBytes: null,
    swapTotalBytes: null,
    thermal: null,
    cpuPressure: null,
    agentsObserved: { working: 1, waiting: 0, idle: 0 },
    projectCount: 1,
    worktreeCount: 1,
    driver: null,
    agentClis: [],
  };
}

type FakeCtx = { session: LinkSession; client: LinkClientInfo; sessionId: string };

class FakeServer implements MetricsSessionSource {
  sessions: FakeCtx[] = [];
  private readonly listeners = new Set<(ctx: FakeCtx) => void>();
  onSession(listener: (ctx: FakeCtx) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  attach(
    session: LinkSession,
    clientId: string,
    sessionId = `session-of-${clientId}`,
    client: Partial<LinkClientInfo> = {}
  ) {
    const ctx = {
      session,
      client: { clientId, clientName: clientId, platform: "darwin" as const, ...client },
      sessionId,
    };
    this.sessions.push(ctx);
    for (const listener of this.listeners) listener(ctx);
  }
}

async function pair() {
  const p = await openSessionPair(dir);
  open.push(p.host, p.client);
  return p;
}

const NO_QUIET_HOURS = {
  enabled: true,
  waitingEnabled: true,
  quietHoursEnabled: false,
  quietHoursStartMin: 0,
  quietHoursEndMin: 0,
  quietHoursWeekdays: [],
};

function deps(overrides: Partial<MetricsHostDeps> = {}): MetricsHostDeps & {
  fireWaiting: (payload: WaitingEvent) => void;
  fireStop: (change: AgentStopChange) => void;
} {
  let waiting: ((payload: WaitingEvent) => void) | null = null;
  let stops: ((change: AgentStopChange) => void) | null = null;
  let clock = 0;
  return {
    loop: { subscribe: () => () => {}, latest: () => null },
    listFleetTargets: async () => ({ targets: [], complete: true }),
    submitFleet: async () => {},
    listWorktrees: async () => [],
    onWorktreesMaybeChanged: () => () => {},
    onProjectsChanged: () => () => {},
    restartTerminals: async () => ({
      projects: [],
      complete: true,
      operations: 0,
      terminalIds: [],
    }),
    onAgentWaiting(listener) {
      waiting = listener;
      return () => (waiting = null);
    },
    onAgentStopChanges(listener) {
      stops = listener;
      return () => (stops = null);
    },
    notificationSettings: () => NO_QUIET_HOURS,
    shellDecides: () => false,
    acceptsRemoteControl: () => true,
    now: () => (clock += 1000),
    fireWaiting: (payload) => waiting?.(payload),
    fireStop: (change) => stops?.(change),
    ...overrides,
  };
}

/** One of this host's agents stopping work to wait, as its own bus reports it. */
function waitingEvent(
  base: Omit<WaitingEvent, "previousState" | "seen">,
  overrides: {
    previousState?: WaitingEvent["previousState"];
    seen?: Partial<AgentWaitingPayload>;
  } = {}
): WaitingEvent {
  return {
    ...base,
    previousState: overrides.previousState ?? "working",
    seen: {
      terminalId: base.terminalId,
      projectId: base.projectId,
      worktreeId: null,
      incarnation: 1,
      agentIncarnation: 0,
      waitingReason: "approval",
      refined: false,
      seenAt: 1_000,
      ...overrides.seen,
    },
  };
}

describe("installHostMetricsHostWith", () => {
  it("streams every sample to every attached Shell, bound to a window or not", async () => {
    const server = new FakeServer();
    let sampledAt = 0;
    const loop = new SummaryLoop({ sample: async () => summary(++sampledAt) }, 20);
    const a = await pair();
    const b = await pair();
    server.attach(a.host, "shell-a");
    const dispose = installHostMetricsHostWith(server, deps({ loop }));
    server.attach(b.host, "shell-b");

    const seenA: number[] = [];
    const seenB: number[] = [];
    a.client.on(Lane.CONTROL, ControlKind.HOST_SUMMARY, (body) => seenA.push(body.sampledAt));
    b.client.on(Lane.CONTROL, ControlKind.HOST_SUMMARY, (body) => seenB.push(body.sampledAt));

    await waitFor(() => seenA.length >= 3 && seenB.length >= 3);
    dispose();
    // One frame per sample, in order, to each Shell.
    expect(seenA).toEqual([...seenA].sort((x, y) => x - y));
    expect(new Set(seenA).size).toBe(seenA.length);
    expect(seenB.every((at) => seenA.includes(at))).toBe(true);
    const settled = seenA.length;
    await new Promise((resolve) => setTimeout(resolve, 80));
    // Nothing samples once the listener leaves.
    expect(seenA.length).toBe(settled);
  });

  it("samples nothing while no Shell is attached", async () => {
    const server = new FakeServer();
    const subscribe = vi.fn(() => () => {});
    const dispose = installHostMetricsHostWith(
      server,
      deps({ loop: { subscribe, latest: () => null } })
    );
    expect(subscribe).not.toHaveBeenCalled();
    const p = await pair();
    server.attach(p.host, "shell");
    expect(subscribe).toHaveBeenCalledTimes(1);
    dispose();
  });

  it("watches this host's agent usage only while it samples for a Shell (#17318)", async () => {
    const server = new FakeServer();
    const release = vi.fn();
    const watchAgentUsage = vi.fn(() => release);
    let listener: ((summary: HostMetricsSummary) => void) | null = null;
    const dispose = installHostMetricsHostWith(
      server,
      deps({
        watchAgentUsage,
        loop: {
          subscribe: (next) => {
            listener = next;
            return () => (listener = null);
          },
          latest: () => null,
        },
      })
    );
    expect(watchAgentUsage).not.toHaveBeenCalled();
    const p = await pair();
    server.attach(p.host, "shell");
    const q = await pair();
    server.attach(q.host, "shell-2");
    expect(watchAgentUsage).toHaveBeenCalledTimes(1);
    // The last Shell gone, the next sample stops the loop and lets the watch go.
    server.sessions = [];
    listener!(summary(1));
    expect(release).toHaveBeenCalledTimes(1);
    dispose();
    expect(release).toHaveBeenCalledTimes(1);
  });

  describe("agent usage tracking (#17981)", () => {
    const READING: AgentUsageReading = {
      agentId: "codex",
      accountNames: ["Work"],
      isDefault: true,
      windowDurationMins: 300,
      usedPercent: 40,
      resetsAt: null,
      observedAt: 1,
    };

    function usageLoop() {
      let listener: ((next: HostMetricsSummary) => void) | null = null;
      let latest: HostMetricsSummary | null = null;
      return {
        loop: {
          subscribe: (next: (summary: HostMetricsSummary) => void) => {
            listener = next;
            return () => (listener = null);
          },
          latest: () => latest,
        },
        seed(next: HostMetricsSummary) {
          latest = next;
        },
        sample(next: HostMetricsSummary) {
          latest = next;
          listener?.(next);
        },
      };
    }

    const withUsage = (sampledAt: number): HostMetricsSummary => ({
      ...summary(sampledAt),
      agentUsage: [READING],
    });

    /** Per frame received, whether it carried usage. */
    function usageFrames(client: LinkSession): boolean[] {
      const seen: boolean[] = [];
      client.on(Lane.CONTROL, ControlKind.HOST_SUMMARY, (body) =>
        seen.push(body.agentUsage !== undefined)
      );
      return seen;
    }

    /** Per frame received, the usage it carried; absent when none. */
    function usageBodies(client: LinkSession): Array<AgentUsageReading[] | undefined> {
      const seen: Array<AgentUsageReading[] | undefined> = [];
      client.on(Lane.CONTROL, ControlKind.HOST_SUMMARY, (body) => seen.push(body.agentUsage));
      return seen;
    }

    it("reads nothing for a Shell that said either way in its HELLO until it confirms as its session opens", async () => {
      const server = new FakeServer();
      const watchAgentUsage = vi.fn(() => vi.fn());
      const samples = usageLoop();
      samples.seed(withUsage(1));
      const dispose = installHostMetricsHostWith(
        server,
        deps({ watchAgentUsage, loop: samples.loop })
      );
      const p = await pair();
      const seen = usageFrames(p.client);
      // It may have turned tracking off between its HELLO and now.
      server.attach(p.host, "shell", undefined, { agentUsage: true });
      await waitFor(() => seen.length === 1);
      expect(seen).toEqual([false]);
      expect(watchAgentUsage).not.toHaveBeenCalled();

      await p.client.call(MetricsLinkMethod.AGENT_USAGE_DEMAND, { enabled: true });
      expect(watchAgentUsage).toHaveBeenCalledTimes(1);
      samples.sample(withUsage(2));
      await waitFor(() => seen.length === 2);
      expect(seen).toEqual([false, true]);
      dispose();
    });

    it("starts no usage watch for a Shell that doesn't track usage, and sends it none", async () => {
      const server = new FakeServer();
      const watchAgentUsage = vi.fn(() => vi.fn());
      const samples = usageLoop();
      samples.seed(withUsage(1));
      const dispose = installHostMetricsHostWith(
        server,
        deps({ watchAgentUsage, loop: samples.loop })
      );
      const p = await pair();
      const seen = usageFrames(p.client);
      server.attach(p.host, "shell", undefined, { agentUsage: false });
      samples.sample(withUsage(2));
      await waitFor(() => seen.length === 2);
      // The cached frame handed over on attach carries none either.
      expect(seen).toEqual([false, false]);
      expect(watchAgentUsage).not.toHaveBeenCalled();
      dispose();
    });

    it("shares one watch between Shells that disagree, and sends usage only where it's tracked", async () => {
      const server = new FakeServer();
      const release = vi.fn();
      const watchAgentUsage = vi.fn(() => release);
      const samples = usageLoop();
      const dispose = installHostMetricsHostWith(
        server,
        deps({ watchAgentUsage, loop: samples.loop })
      );
      const legacy = await pair();
      const off = await pair();
      const seenLegacy = usageBodies(legacy.client);
      const seenOff = usageBodies(off.client);
      // A Shell from before the switch never says, and keeps getting usage.
      server.attach(legacy.host, "legacy");
      server.attach(off.host, "off", undefined, { agentUsage: false });
      expect(watchAgentUsage).toHaveBeenCalledTimes(1);
      samples.sample(withUsage(1));
      await waitFor(() => seenLegacy.length === 1 && seenOff.length === 1);
      expect(seenLegacy).toEqual([[READING]]);
      expect(seenOff).toEqual([undefined]);

      await off.client.call(MetricsLinkMethod.AGENT_USAGE_DEMAND, { enabled: true });
      await legacy.client.call(MetricsLinkMethod.AGENT_USAGE_DEMAND, { enabled: false });
      expect(watchAgentUsage).toHaveBeenCalledTimes(1);
      expect(release).not.toHaveBeenCalled();
      samples.sample(withUsage(2));
      await waitFor(() => seenLegacy.length === 2 && seenOff.length === 2);
      expect(seenLegacy).toEqual([[READING], undefined]);
      expect(seenOff).toEqual([undefined, [READING]]);

      // The last Shell that wanted it turning off lets the watch go at once.
      await off.client.call(MetricsLinkMethod.AGENT_USAGE_DEMAND, { enabled: false });
      expect(release).toHaveBeenCalledTimes(1);
      await expect(
        off.client.call(MetricsLinkMethod.AGENT_USAGE_DEMAND, { enabled: "no" })
      ).rejects.toThrow();
      dispose();
      expect(release).toHaveBeenCalledTimes(1);
    });

    it("lets the watch go when the last Shell that tracks usage leaves", async () => {
      const server = new FakeServer();
      const release = vi.fn();
      const watchAgentUsage = vi.fn(() => release);
      const samples = usageLoop();
      const dispose = installHostMetricsHostWith(
        server,
        deps({ watchAgentUsage, loop: samples.loop })
      );
      const on = await pair();
      const off = await pair();
      const other = await pair();
      server.attach(on.host, "on", undefined, { agentUsage: true });
      server.attach(off.host, "off", undefined, { agentUsage: false });
      server.attach(other.host, "other", undefined, { agentUsage: false });
      await on.client.call(MetricsLinkMethod.AGENT_USAGE_DEMAND, { enabled: true });
      expect(watchAgentUsage).toHaveBeenCalledTimes(1);
      // A Shell that never wanted it leaving changes nothing.
      off.host.close("gone");
      await waitFor(() => !off.host.isOpen);
      expect(release).not.toHaveBeenCalled();
      on.host.close("gone");
      await waitFor(() => release.mock.calls.length === 1);
      dispose();
      expect(release).toHaveBeenCalledTimes(1);
    });

    it("reads usage for no Shell while the host's own switch is off, and picks up when it's on", async () => {
      const server = new FakeServer();
      const release = vi.fn();
      const watchAgentUsage = vi.fn(() => release);
      const samples = usageLoop();
      let hostOn = false;
      let changed: (() => void) | null = null;
      const dispose = installHostMetricsHostWith(
        server,
        deps({
          watchAgentUsage,
          loop: samples.loop,
          agentUsageTracking: () => hostOn,
          onAgentUsageTrackingChanged: (listener) => {
            changed = listener;
            return () => (changed = null);
          },
        })
      );
      samples.seed(withUsage(0));
      const p = await pair();
      const seen = usageFrames(p.client);
      server.attach(p.host, "shell");
      samples.sample(withUsage(1));
      await waitFor(() => seen.length === 2);
      // The cached frame handed over on attach carries none either.
      expect(seen).toEqual([false, false]);
      expect(watchAgentUsage).not.toHaveBeenCalled();

      hostOn = true;
      changed!();
      expect(watchAgentUsage).toHaveBeenCalledTimes(1);
      samples.sample(withUsage(2));
      await waitFor(() => seen.length === 3);
      expect(seen).toEqual([false, false, true]);

      hostOn = false;
      changed!();
      expect(release).toHaveBeenCalledTimes(1);
      samples.sample(withUsage(3));
      await waitFor(() => seen.length === 4);
      expect(seen).toEqual([false, false, true, false]);
      dispose();
      expect(changed).toBe(null);
    });
  });

  it("hands a Shell that attaches later the latest summary straight away", async () => {
    const server = new FakeServer();
    const latest = summary(42);
    const dispose = installHostMetricsHostWith(
      server,
      deps({ loop: { subscribe: () => () => {}, latest: () => latest } })
    );
    const p = await pair();
    const seen: number[] = [];
    p.client.on(Lane.CONTROL, ControlKind.HOST_SUMMARY, (body) => seen.push(body.sampledAt));
    server.attach(p.host, "late");
    await waitFor(() => seen.length === 1);
    expect(seen).toEqual([42]);
    dispose();
  });

  it("stamps each frame with the sample's age and the newest ping it followed (#14462)", async () => {
    const server = new FakeServer();
    const latest = summary(42);
    const ageOf = vi.fn((s: HostMetricsSummary) => (s === latest ? 600_000 : null));
    const dispose = installHostMetricsHostWith(
      server,
      deps({ loop: { subscribe: () => () => {}, latest: () => latest, ageOf } })
    );
    const p = await pair();
    const seen: unknown[] = [];
    p.client.on(Lane.CONTROL, ControlKind.HOST_SUMMARY, (body) => seen.push(body.timing));
    p.client.ping();
    p.client.ping();
    await waitFor(() => p.host.peerPingNonce === 1);
    server.attach(p.host, "late");
    await waitFor(() => seen.length === 1);
    // A cached sample handed to a Shell that just attached carries its real age, not zero.
    expect(seen).toEqual([{ sampleAgeMs: 600_000, afterPing: 1 }]);
    dispose();
  });

  it("stamps every live sample for each Shell with that Shell's own newest ping", async () => {
    const server = new FakeServer();
    let publish: ((summary: HostMetricsSummary) => void) | null = null;
    let age = 10;
    const dispose = installHostMetricsHostWith(
      server,
      deps({
        loop: {
          subscribe: (listener) => {
            publish = listener;
            return () => (publish = null);
          },
          latest: () => null,
          ageOf: () => age,
        },
      })
    );
    const a = await pair();
    const b = await pair();
    const seenA: unknown[] = [];
    const seenB: unknown[] = [];
    a.client.on(Lane.CONTROL, ControlKind.HOST_SUMMARY, (body) => seenA.push(body.timing));
    b.client.on(Lane.CONTROL, ControlKind.HOST_SUMMARY, (body) => seenB.push(body.timing));
    a.client.ping();
    for (let i = 0; i < 3; i += 1) b.client.ping();
    await waitFor(() => a.host.peerPingNonce === 0 && b.host.peerPingNonce === 2);
    server.attach(a.host, "a");
    server.attach(b.host, "b");
    publish!(summary(1));
    await waitFor(() => seenA.length === 1 && seenB.length === 1);
    a.client.ping();
    await waitFor(() => a.host.peerPingNonce === 1);
    age = 20;
    publish!(summary(2));
    await waitFor(() => seenA.length === 2 && seenB.length === 2);
    expect(seenA).toEqual([
      { sampleAgeMs: 10, afterPing: 0 },
      { sampleAgeMs: 20, afterPing: 1 },
    ]);
    expect(seenB).toEqual([
      { sampleAgeMs: 10, afterPing: 2 },
      { sampleAgeMs: 20, afterPing: 2 },
    ]);
    dispose();
  });

  it("names no ping before the Shell sent one, and no age from a loop that can't say", async () => {
    const server = new FakeServer();
    const dispose = installHostMetricsHostWith(
      server,
      deps({ loop: { subscribe: () => () => {}, latest: () => summary(42) } })
    );
    const p = await pair();
    const seen: unknown[] = [];
    p.client.on(Lane.CONTROL, ControlKind.HOST_SUMMARY, (body) => seen.push(body.timing));
    server.attach(p.host, "late");
    await waitFor(() => seen.length === 1);
    expect(seen).toEqual([{ sampleAgeMs: null, afterPing: null }]);
    dispose();
  });

  it("submits fleet prompts as the calling session, never the client id its HELLO claimed", async () => {
    const server = new FakeServer();
    const submitFleet = vi.fn(async () => {});
    const dispose = installHostMetricsHostWith(server, deps({ submitFleet }));
    const p = await pair();
    server.attach(p.host, "shell-7", "sess-abc");
    await p.client.call(MetricsLinkMethod.SUBMIT_FLEET, { terminalId: "t1", text: "go" });
    expect(submitFleet).toHaveBeenLastCalledWith(
      "t1",
      "go",
      { kind: "remote", sessionId: "sess-abc" },
      null
    );
    await p.client.call(MetricsLinkMethod.SUBMIT_FLEET, {
      terminalId: "t1",
      text: "go",
      opId: "op-1",
    });
    expect(submitFleet).toHaveBeenLastCalledWith(
      "t1",
      "go",
      { kind: "remote", sessionId: "sess-abc" },
      "op-1"
    );
    await expect(
      p.client.call(MetricsLinkMethod.SUBMIT_FLEET, { terminalId: "t1", text: "go", opId: "a b" })
    ).rejects.toBeTruthy();
    await expect(
      p.client.call(MetricsLinkMethod.SUBMIT_FLEET, { terminalId: "t1", text: "" })
    ).rejects.toBeTruthy();
    dispose();
  });

  it("lists targets and worktrees without the host's own id", async () => {
    const server = new FakeServer();
    const dispose = installHostMetricsHostWith(
      server,
      deps({
        listFleetTargets: async () => ({
          targets: [
            {
              hostId: "local",
              terminalId: "t1",
              title: "Claude",
              projectId: "p1",
              projectName: "app",
              agentId: "claude",
              agentState: "waiting",
            },
          ],
          complete: false,
        }),
      })
    );
    const p = await pair();
    server.attach(p.host, "shell");
    const answer = await p.client.call(MetricsLinkMethod.LIST_FLEET_TARGETS, null);
    expect(answer).toEqual({
      targets: [
        {
          terminalId: "t1",
          title: "Claude",
          projectId: "p1",
          projectName: "app",
          agentId: "claude",
          agentState: "waiting",
        },
      ],
      complete: false,
    });
    dispose();
  });

  it("tells every Shell once per burst of changes to what its worktree list shows", async () => {
    const server = new FakeServer();
    const entry: HostWorktreeEntry = {
      hostId: "local",
      projectId: "p1",
      projectName: "app",
      worktreeId: "/srv/app-feature",
      name: "app-feature",
      branch: "feature/a",
      path: "/srv/app-feature",
      isMainWorktree: false,
      modifiedCount: 1,
      lastActivityAt: null,
      observed: { band: "running", agentState: "working" },
    };
    let current = [entry];
    let poke: () => void = () => {};
    const dispose = installHostMetricsHostWith(
      server,
      deps({
        listWorktrees: async () => current,
        onWorktreesMaybeChanged: (listener) => {
          poke = listener;
          return () => (poke = () => {});
        },
        worktreesChangedDelayMs: 5,
      })
    );
    const a = await pair();
    const b = await pair();
    server.attach(a.host, "a");
    server.attach(b.host, "b");
    let heardA = 0;
    let heardB = 0;
    a.client.registerCallHandler(MetricsLinkMethod.WORKTREES_CHANGED, EmptyPayloadSchema, () => {
      heardA++;
      return null;
    });
    b.client.registerCallHandler(MetricsLinkMethod.WORKTREES_CHANGED, EmptyPayloadSchema, () => {
      heardB++;
      return null;
    });

    poke();
    poke();
    await waitFor(() => heardA === 1 && heardB === 1);

    current = [{ ...entry, observed: { band: "needs-you", agentState: "waiting" } }];
    poke();
    await waitFor(() => heardA === 2 && heardB === 2);

    dispose();
  });

  it("tells every attached Shell when its projects change, and never for agent activity", async () => {
    const server = new FakeServer();
    let projectsChanged: (() => void) | null = null;
    let worktreesChanged: () => void = () => {};
    const dispose = installHostMetricsHostWith(
      server,
      deps({
        listWorktrees: async () => [],
        onWorktreesMaybeChanged: (listener) => {
          worktreesChanged = listener;
          return () => (worktreesChanged = () => {});
        },
        onProjectsChanged: (listener) => {
          projectsChanged = listener;
          return () => (projectsChanged = null);
        },
        worktreesChangedDelayMs: 5,
      })
    );
    const a = await pair();
    const b = await pair();
    server.attach(a.host, "a");
    server.attach(b.host, "b");
    let heardA = 0;
    let heardB = 0;
    a.client.registerCallHandler(MetricsLinkMethod.PROJECTS_CHANGED, EmptyPayloadSchema, () => {
      heardA++;
      return null;
    });
    b.client.registerCallHandler(MetricsLinkMethod.PROJECTS_CHANGED, EmptyPayloadSchema, () => {
      heardB++;
      return null;
    });

    worktreesChanged();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(heardA + heardB).toBe(0);

    projectsChanged!();
    await waitFor(() => heardA === 1 && heardB === 1);

    dispose();
    expect(projectsChanged).toBeNull();
  });

  it("catches a list change no worktree event announced on the next sample", async () => {
    const server = new FakeServer();
    let tick: ((summary: HostMetricsSummary) => void) | null = null;
    let current: HostWorktreeEntry[] = [];
    const dispose = installHostMetricsHostWith(
      server,
      deps({
        loop: {
          subscribe: (listener) => {
            tick = listener;
            return () => (tick = null);
          },
          latest: () => null,
        },
        listWorktrees: async () => current,
        worktreesChangedDelayMs: 5,
      })
    );
    const p = await pair();
    server.attach(p.host, "shell");
    let heard = 0;
    p.client.registerCallHandler(MetricsLinkMethod.WORKTREES_CHANGED, EmptyPayloadSchema, () => {
      heard++;
      return null;
    });
    tick!(summary(1));
    await waitFor(() => heard === 1);

    // A project opened: its worktrees arrive with no worktree event of their own.
    current = [
      {
        hostId: "local",
        projectId: "p2",
        projectName: "other",
        worktreeId: "/srv/other",
        name: "other",
        branch: "main",
        path: "/srv/other",
        isMainWorktree: true,
        modifiedCount: null,
        lastActivityAt: null,
        observed: null,
      },
    ];
    tick!(summary(2));
    await waitFor(() => heard === 2);
    dispose();
  });

  it("announces a waiting agent to every Shell, once per cooldown", async () => {
    const server = new FakeServer();
    let clock = 0;
    const d = deps({ now: () => clock });
    const dispose = installHostMetricsHostWith(server, d);
    const a = await pair();
    const b = await pair();
    server.attach(a.host, "a");
    server.attach(b.host, "b");
    const heardA: AttentionPayload[] = [];
    const heardB: AttentionPayload[] = [];
    a.client.registerCallHandler(MetricsLinkMethod.ATTENTION, AttentionPayloadSchema, (p) => {
      heardA.push(p);
      return null;
    });
    b.client.registerCallHandler(MetricsLinkMethod.ATTENTION, AttentionPayloadSchema, (p) => {
      heardB.push(p);
      return null;
    });
    const payload = waitingEvent({
      kind: "waiting",
      terminalId: "t1",
      projectId: "p1",
      projectName: "app",
      agentName: "Claude",
    });
    d.fireWaiting(payload);
    clock += 1_000;
    d.fireWaiting(payload);
    await waitFor(() => heardA.length === 1 && heardB.length === 1);
    clock += ATTENTION_COOLDOWN_MS;
    d.fireWaiting(payload);
    await waitFor(() => heardA.length === 2);
    expect(heardA[0]).toEqual({
      kind: "waiting",
      terminalId: "t1",
      projectId: "p1",
      projectName: "app",
      agentName: "Claude",
      quiet: false,
    });
    dispose();
  });

  it("sends every Shell each agent's wait, refinements too, past every alert choice (#16188)", async () => {
    const server = new FakeServer();
    let accepts = true;
    const d = deps({
      // This host's own waiting notifications are off, and each Shell leaves it to the host.
      notificationSettings: () => ({ ...NO_QUIET_HOURS, waitingEnabled: false }),
      acceptsRemoteControl: () => accepts,
      now: () => 0,
    });
    const dispose = installHostMetricsHostWith(server, d);
    const a = await pair();
    const b = await pair();
    const older = await pair();
    server.attach(a.host, "a");
    server.attach(b.host, "b");
    // A Shell from before the event refuses it, which this host ignores.
    server.attach(older.host, "older");
    const heard: Record<string, AgentWaitingPayload[]> = { a: [], b: [] };
    const paged: AttentionPayload[] = [];
    for (const [name, p] of [
      ["a", a],
      ["b", b],
    ] as const) {
      p.client.registerCallHandler(
        MetricsLinkMethod.AGENT_WAITING,
        AgentWaitingPayloadSchema,
        (body) => {
          heard[name]!.push(body);
          return null;
        }
      );
      p.client.registerCallHandler(MetricsLinkMethod.ATTENTION, AttentionPayloadSchema, (body) => {
        paged.push(body);
        return null;
      });
    }
    const base = { kind: "waiting", projectId: "p1", projectName: null, agentName: null } as const;
    d.fireWaiting(
      waitingEvent({ ...base, terminalId: "t1" }, { seen: { waitingReason: "prompt" } })
    );
    // Inside any cooldown, and refined while it already waited.
    d.fireWaiting(
      waitingEvent(
        { ...base, terminalId: "t1" },
        { previousState: "waiting", seen: { waitingReason: "approval", refined: true } }
      )
    );
    await waitFor(() => heard.a!.length === 2 && heard.b!.length === 2);
    expect(heard.a!.map((body) => [body.waitingReason, body.refined])).toEqual([
      ["prompt", false],
      ["approval", true],
    ]);
    expect(heard.a![1]).toEqual({
      terminalId: "t1",
      projectId: "p1",
      worktreeId: null,
      incarnation: 1,
      agentIncarnation: 0,
      waitingReason: "approval",
      refined: true,
      seenAt: 1_000,
    });

    // A host that takes no assistants' work sends its agents' waits to none.
    accepts = false;
    d.fireWaiting(waitingEvent({ ...base, terminalId: "t2" }));
    accepts = true;
    d.fireWaiting(waitingEvent({ ...base, terminalId: "t3" }));
    await waitFor(() => heard.a!.length === 3);
    expect(heard.a!.map((body) => body.terminalId)).toEqual(["t1", "t1", "t3"]);
    // The person's own notice still follows this host's choices: off here.
    expect(paged).toEqual([]);
    dispose();
  });

  it("keeps the person's cooldown while every wait still reaches the watches, in order", async () => {
    const server = new FakeServer();
    const d = deps({ shellDecides: () => true, now: () => 0 });
    const dispose = installHostMetricsHostWith(server, d);
    const a = await pair();
    server.attach(a.host, "a");
    const order: string[] = [];
    a.client.registerCallHandler(
      MetricsLinkMethod.AGENT_WAITING,
      AgentWaitingPayloadSchema,
      (b) => {
        order.push(`wait:${b.seenAt}`);
        return null;
      }
    );
    a.client.registerCallHandler(MetricsLinkMethod.ATTENTION, AttentionPayloadSchema, () => {
      order.push("page");
      return null;
    });
    const base = { kind: "waiting", projectId: null, projectName: null, agentName: null } as const;
    // Two stops of one agent inside its cooldown.
    d.fireWaiting(waitingEvent({ ...base, terminalId: "t1" }, { seen: { seenAt: 1 } }));
    d.fireWaiting(waitingEvent({ ...base, terminalId: "t1" }, { seen: { seenAt: 2 } }));
    await waitFor(() => order.length === 3);
    expect(order).toEqual(["wait:1", "page", "wait:2"]);
    dispose();
  });

  it("pages a person only for an agent that stopped working, never for a refined reason", async () => {
    const server = new FakeServer();
    const d = deps({ shellDecides: () => true, now: () => 0 });
    const dispose = installHostMetricsHostWith(server, d);
    const a = await pair();
    server.attach(a.host, "a");
    const paged: string[] = [];
    a.client.registerCallHandler(MetricsLinkMethod.ATTENTION, AttentionPayloadSchema, (body) => {
      paged.push(body.terminalId);
      return null;
    });
    const base = { kind: "waiting", projectId: null, projectName: null, agentName: null } as const;
    d.fireWaiting(waitingEvent({ ...base, terminalId: "refined" }, { previousState: "waiting" }));
    d.fireWaiting(waitingEvent({ ...base, terminalId: "idle" }, { previousState: "idle" }));
    d.fireWaiting(waitingEvent({ ...base, terminalId: "stopped" }, { previousState: "directing" }));
    await waitFor(() => paged.length === 1);
    expect(paged).toEqual(["stopped"]);
    dispose();
  });

  it("judges a waiting agent by its own settings only for a Shell that leaves it to this host", async () => {
    const server = new FakeServer();
    let clock = new Date(2026, 8, 25, 12, 0).getTime();
    let settings = { ...NO_QUIET_HOURS, waitingEnabled: false };
    const d = deps({
      now: () => clock,
      notificationSettings: () => settings,
      shellDecides: (clientId) => clientId === "mac",
    });
    const dispose = installHostMetricsHostWith(server, d);
    const legacy = await pair();
    const mac = await pair();
    server.attach(legacy.host, "legacy");
    server.attach(mac.host, "mac");
    const heard: AttentionPayload[] = [];
    const heardByMac: AttentionPayload[] = [];
    legacy.client.registerCallHandler(
      MetricsLinkMethod.ATTENTION,
      AttentionPayloadSchema,
      (body) => {
        heard.push(body);
        return null;
      }
    );
    mac.client.registerCallHandler(MetricsLinkMethod.ATTENTION, AttentionPayloadSchema, (body) => {
      heardByMac.push(body);
      return null;
    });
    const event = (terminalId: string): WaitingEvent =>
      waitingEvent({
        kind: "waiting",
        terminalId,
        projectId: null,
        projectName: null,
        agentName: null,
      });

    // Waiting notifications off on this host: nothing reaches a Shell that left it to the host.
    d.fireWaiting(event("off"));
    settings = { ...NO_QUIET_HOURS, enabled: false };
    d.fireWaiting(event("disabled"));

    // This host's quiet hours cover noon: that Shell is told to keep it quiet.
    settings = {
      ...NO_QUIET_HOURS,
      quietHoursEnabled: true,
      quietHoursStartMin: 11 * 60,
      quietHoursEndMin: 13 * 60,
    };
    d.fireWaiting(event("quiet"));
    await waitFor(() => heard.length === 1);
    expect(heard[0]).toMatchObject({ terminalId: "quiet", quiet: true });

    // Outside them it is announced normally.
    clock = new Date(2026, 8, 25, 14, 0).getTime();
    d.fireWaiting(event("loud"));
    await waitFor(() => heard.length === 2);
    expect(heard[1]).toMatchObject({ terminalId: "loud", quiet: false });
    expect(heard.some((body) => body.terminalId === "off" || body.terminalId === "disabled")).toBe(
      false
    );

    // The Shell that decides for itself hears every one, unjudged.
    await waitFor(() => heardByMac.length === 4);
    expect(heardByMac.map((body) => [body.terminalId, body.quiet])).toEqual([
      ["off", false],
      ["disabled", false],
      ["quiet", false],
      ["loud", false],
    ]);
    dispose();
  });

  it("judges a waiting agent for that Shell under its own project's overrides", async () => {
    const server = new FakeServer();
    const asked: Array<string | null> = [];
    const d = deps({
      notificationSettings: (projectId) => {
        asked.push(projectId);
        return projectId === "muted"
          ? { ...NO_QUIET_HOURS, waitingEnabled: false }
          : NO_QUIET_HOURS;
      },
    });
    const dispose = installHostMetricsHostWith(server, d);
    const legacy = await pair();
    server.attach(legacy.host, "legacy");
    const heard: string[] = [];
    legacy.client.registerCallHandler(
      MetricsLinkMethod.ATTENTION,
      AttentionPayloadSchema,
      (body) => {
        heard.push(body.terminalId);
        return null;
      }
    );
    const event = (terminalId: string, projectId: string | null): WaitingEvent =>
      waitingEvent({
        kind: "waiting",
        terminalId,
        projectId,
        projectName: null,
        agentName: null,
      });

    d.fireWaiting(event("in-muted", "muted"));
    d.fireWaiting(event("in-other", "other"));
    d.fireWaiting(event("in-none", null));

    await waitFor(() => heard.length === 2);
    expect(heard).toEqual(["in-other", "in-none"]);
    expect(asked).toEqual(["muted", "other", null]);
    dispose();
  });

  it("keeps each Shell's reminder cooldown apart from another's", async () => {
    const server = new FakeServer();
    let clock = new Date(2026, 8, 25, 12, 0).getTime();
    let settings = { ...NO_QUIET_HOURS, waitingEnabled: false };
    const d = deps({
      now: () => clock,
      notificationSettings: () => settings,
      shellDecides: (clientId) => clientId === "mac",
    });
    const dispose = installHostMetricsHostWith(server, d);
    const legacy = await pair();
    const mac = await pair();
    server.attach(legacy.host, "legacy");
    server.attach(mac.host, "mac");
    const heard = { legacy: 0, mac: 0 };
    for (const [name, p] of [
      ["legacy", legacy],
      ["mac", mac],
    ] as const) {
      p.client.registerCallHandler(MetricsLinkMethod.ATTENTION, AttentionPayloadSchema, () => {
        heard[name]++;
        return null;
      });
    }
    const event = waitingEvent({
      kind: "waiting",
      terminalId: "t1",
      projectId: null,
      projectName: null,
      agentName: null,
    });

    // Only the Shell that decides for itself hears it while this host has waiting off.
    d.fireWaiting(event);
    await waitFor(() => heard.mac === 1);
    // Turned on here, and the agent waits again inside the window: the Shell
    // this host held it back from hears now; the other is still cooling down.
    settings = NO_QUIET_HOURS;
    clock += 1_000;
    d.fireWaiting(event);
    await waitFor(() => heard.legacy === 1);
    expect(heard.mac).toBe(1);
    dispose();
  });
});

describe("agent stops (#17933)", () => {
  function hear(p: { client: LinkSession }): AgentStopChangePayload[] {
    const heard: AgentStopChangePayload[] = [];
    p.client.registerCallHandler(
      MetricsLinkMethod.AGENT_STOP_CHANGED,
      AgentStopChangePayloadSchema,
      (body) => {
        heard.push(body);
        return null;
      }
    );
    return heard;
  }

  it("tells every Shell that reads them, summary-only too, with facts and its own ping", async () => {
    const server = new FakeServer();
    const d = deps({ now: () => 5_000, acceptsRemoteControl: () => false });
    const dispose = installHostMetricsHostWith(server, d);
    const a = await pair();
    const b = await pair();
    const heardA = hear(a);
    const heardB = hear(b);
    b.client.ping();
    b.client.ping();
    await waitFor(() => b.host.peerPingNonce === 1);
    server.attach(a.host, "a", undefined, { agentStopChanges: true });
    server.attach(b.host, "b", undefined, { agentStopChanges: true });

    d.fireStop({ terminalId: "t1", projectId: "p1", state: "completed", seenAt: 4_200 });
    d.fireStop({ terminalId: "t1", projectId: "p1", state: null, seenAt: 4_900 });
    await waitFor(() => heardA.length === 2 && heardB.length === 2);
    expect(heardA).toEqual([
      {
        terminalId: "t1",
        projectId: "p1",
        state: "completed",
        seenAt: 4_200,
        ageMs: 800,
        afterPing: null,
      },
      {
        terminalId: "t1",
        projectId: "p1",
        state: null,
        seenAt: 4_900,
        ageMs: 100,
        afterPing: null,
      },
    ]);
    // Each Shell's frame names that Shell's own newest ping.
    expect(heardB.map((body) => body.afterPing)).toEqual([1, 1]);
    dispose();
  });

  it("sends none to a Shell whose HELLO doesn't say it reads them, so nothing is refused", async () => {
    const server = new FakeServer();
    const d = deps();
    const dispose = installHostMetricsHostWith(server, d);
    const older = await pair();
    const declined = await pair();
    const current = await pair();
    const heardCurrent = hear(current);
    const sent = [vi.spyOn(older.host, "call"), vi.spyOn(declined.host, "call")];
    server.attach(older.host, "older");
    server.attach(declined.host, "declined", undefined, { agentStopChanges: false });
    server.attach(current.host, "current", undefined, { agentStopChanges: true });

    d.fireStop({ terminalId: "t1", projectId: null, state: "exited", seenAt: 0 });
    await waitFor(() => heardCurrent.length === 1);
    for (const spy of sent) {
      expect(
        spy.mock.calls.filter(([method]) => method === MetricsLinkMethod.AGENT_STOP_CHANGED)
      ).toEqual([]);
    }
    dispose();
  });

  it("holds nothing for a Shell whose link is down, and sends nothing after it's disposed", async () => {
    const server = new FakeServer();
    const d = deps();
    const dispose = installHostMetricsHostWith(server, d);
    const gone = await pair();
    const live = await pair();
    const heardLive = hear(live);
    server.attach(gone.host, "gone", undefined, { agentStopChanges: true });
    server.attach(live.host, "live", undefined, { agentStopChanges: true });
    gone.host.close("link down");
    await waitFor(() => gone.client.isClosed);
    const sentOnGone = vi.spyOn(gone.host, "call");

    d.fireStop({ terminalId: "t1", projectId: null, state: "completed", seenAt: 0 });
    await waitFor(() => heardLive.length === 1);
    expect(sentOnGone).not.toHaveBeenCalled();

    dispose();
    d.fireStop({ terminalId: "t2", projectId: null, state: "completed", seenAt: 0 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(heardLive.map((body) => body.terminalId)).toEqual(["t1"]);
  });
});

describe("installLinkActivityHost", () => {
  const activity: HostLinkActivity = {
    observedAt: 1,
    listeningSince: 1,
    version: "0.46.0",
    commit: "abc",
    events: [],
    eventsTruncated: false,
    drivers: [],
    attached: [],
  };

  it("answers sessions attached before and after it, reading afresh each time", async () => {
    const server = new FakeServer();
    const before = await pair();
    server.attach(before.host, "early");
    let reads = 0;
    const dispose = installLinkActivityHost(server, () => ({ ...activity, observedAt: ++reads }));
    const after = await pair();
    server.attach(after.host, "late");

    expect(await before.client.call(MetricsLinkMethod.LINK_ACTIVITY, null)).toMatchObject({
      observedAt: 1,
    });
    expect(await after.client.call(MetricsLinkMethod.LINK_ACTIVITY, null)).toMatchObject({
      observedAt: 2,
    });
    dispose();
  });

  it("stops wiring new sessions once disposed", async () => {
    const server = new FakeServer();
    installLinkActivityHost(server, () => activity)();
    const p = await pair();
    server.attach(p.host, "late");
    await expect(p.client.call(MetricsLinkMethod.LINK_ACTIVITY, null)).rejects.toMatchObject({
      code: "UNSUPPORTED",
    });
  });
});

describe("installProcessInventoryHost", () => {
  const snapshot = (terminalCount: number): ProcessInventorySnapshot => ({
    terminals: Array.from({ length: terminalCount }, (_, index) => ({
      id: `t${index}`,
      projectId: null,
      projectName: null,
      cwd: "/home",
      isAssistantTerminal: false,
      spawnedAt: 1,
      isTrashed: false,
      rootPid: null,
      sample: null,
    })),
    closedTerminalProcesses: [],
    cleanup: null,
    plugins: [],
    complete: true,
    samplesAvailable: true,
    sampledAt: 3,
  });

  it("answers sessions with no view bound, before and after it, reading afresh and bounded", async () => {
    const server = new FakeServer();
    const before = await pair();
    server.attach(before.host, "early");
    const read = vi.fn(async () => snapshot(MAX_PROCESS_TERMINALS + 5));
    const dispose = installProcessInventoryHost(server, read);
    const after = await pair();
    server.attach(after.host, "late");
    expect(read).not.toHaveBeenCalled();

    for (const p of [before, after]) {
      const answer = ProcessInventorySchema.parse(
        await p.client.call(MetricsLinkMethod.PROCESS_INVENTORY, null)
      );
      expect(answer.terminals).toHaveLength(MAX_PROCESS_TERMINALS);
      expect(answer.truncated).toBe(true);
    }
    expect(read).toHaveBeenCalledTimes(2);
    dispose();
  });

  it("stops wiring new sessions once disposed", async () => {
    const server = new FakeServer();
    installProcessInventoryHost(server, async () => snapshot(1))();
    const p = await pair();
    server.attach(p.host, "late");
    await expect(p.client.call(MetricsLinkMethod.PROCESS_INVENTORY, null)).rejects.toMatchObject({
      code: "UNSUPPORTED",
    });
  });
});
