import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostMetricsSummary } from "../../../../shared/types/remoteHosts.js";
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
import type { AttentionPayload } from "../linkMethods.js";
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
  attach(session: LinkSession, clientId: string, sessionId = `session-of-${clientId}`) {
    const ctx = {
      session,
      client: { clientId, clientName: clientId, platform: "darwin" as const },
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
} {
  let waiting: ((payload: WaitingEvent) => void) | null = null;
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
    notificationSettings: () => NO_QUIET_HOURS,
    shellDecides: () => false,
    now: () => (clock += 1000),
    fireWaiting: (payload) => waiting?.(payload),
    ...overrides,
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
    const payload: WaitingEvent = {
      kind: "waiting",
      terminalId: "t1",
      projectId: "p1",
      projectName: "app",
      agentName: "Claude",
    };
    d.fireWaiting(payload);
    clock += 1_000;
    d.fireWaiting(payload);
    await waitFor(() => heardA.length === 1 && heardB.length === 1);
    clock += ATTENTION_COOLDOWN_MS;
    d.fireWaiting(payload);
    await waitFor(() => heardA.length === 2);
    expect(heardA[0]).toEqual({ ...payload, quiet: false });
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
    const event = (terminalId: string): WaitingEvent => ({
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
    const event = (terminalId: string, projectId: string | null): WaitingEvent => ({
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
    const event: WaitingEvent = {
      kind: "waiting",
      terminalId: "t1",
      projectId: null,
      projectName: null,
      agentName: null,
    };

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
