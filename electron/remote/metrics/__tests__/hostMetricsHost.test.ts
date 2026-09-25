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
import { AttentionPayloadSchema, MetricsLinkMethod } from "../linkMethods.js";
import {
  ATTENTION_COOLDOWN_MS,
  installHostMetricsHostWith,
  type MetricsHostDeps,
  type MetricsSessionSource,
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

class FakeServer implements MetricsSessionSource {
  sessions: Array<{ session: LinkSession; client: LinkClientInfo }> = [];
  private readonly listeners = new Set<
    (ctx: { session: LinkSession; client: LinkClientInfo }) => void
  >();
  onSession(listener: (ctx: { session: LinkSession; client: LinkClientInfo }) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  attach(session: LinkSession, clientId: string) {
    const ctx = {
      session,
      client: { clientId, clientName: clientId, platform: "darwin" as const },
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

function deps(overrides: Partial<MetricsHostDeps> = {}): MetricsHostDeps & {
  fireWaiting: (payload: AttentionPayload) => void;
} {
  let waiting: ((payload: AttentionPayload) => void) | null = null;
  let clock = 0;
  return {
    loop: { subscribe: () => () => {}, latest: () => null },
    listFleetTargets: async () => [],
    submitFleet: async () => {},
    listWorktrees: async () => [],
    onAgentWaiting(listener) {
      waiting = listener;
      return () => (waiting = null);
    },
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

  it("submits fleet prompts as the calling Shell", async () => {
    const server = new FakeServer();
    const submitFleet = vi.fn(async () => {});
    const dispose = installHostMetricsHostWith(server, deps({ submitFleet }));
    const p = await pair();
    server.attach(p.host, "shell-7");
    await p.client.call(MetricsLinkMethod.SUBMIT_FLEET, { terminalId: "t1", text: "go" });
    expect(submitFleet).toHaveBeenCalledWith("t1", "go", { kind: "remote", clientId: "shell-7" });
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
        listFleetTargets: async () => [
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
      })
    );
    const p = await pair();
    server.attach(p.host, "shell");
    const answer = await p.client.call(MetricsLinkMethod.LIST_FLEET_TARGETS, null);
    expect(answer).toEqual([
      {
        terminalId: "t1",
        title: "Claude",
        projectId: "p1",
        projectName: "app",
        agentId: "claude",
        agentState: "waiting",
      },
    ]);
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
    const payload: AttentionPayload = {
      kind: "waiting",
      terminalId: "t1",
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
    expect(heardA[0]).toEqual(payload);
    dispose();
  });
});
