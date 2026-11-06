import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LaneWake } from "../../../services/mcp-server/terminalNotify.js";
import { HostCallRuntime, type ObservedHost, type OpenRun } from "../HostCallRuntime.js";
import type { HostWatchListener } from "../HostWatches.js";
import type { AgentWaitingListener } from "../../metrics/agentWaiting.js";
import type { AgentDirectory } from "../../../../shared/types/agentDirectory.js";
import type { AgentsAnswer } from "../linkMethods.js";
import type { HostWatchResult } from "../../../../shared/types/hostControl.js";

const RUN: OpenRun = {
  projectId: "proj-1",
  slot: 0,
  sessionId: "a",
  terminalId: "t-a",
  launchGeneration: 1,
};

describe("HostCallRuntime host.watch (#14463)", () => {
  let runs: Map<string, OpenRun>;
  let hosts: ObservedHost[];
  let listener: HostWatchListener | null;
  let queued: LaneWake[];
  let connect: ReturnType<typeof vi.fn<(hostId: string, timeoutMs: number) => Promise<unknown>>>;
  let runtime: HostCallRuntime;

  beforeEach(() => {
    vi.useFakeTimers();
    runs = new Map([["a", { ...RUN }]]);
    hosts = [
      {
        hostId: "studio",
        name: "studio-01",
        connection: { status: "disconnected" },
        lastSeenAt: null,
        summary: null,
      },
    ];
    listener = null;
    queued = [];
    connect = vi.fn(async () => undefined);
    runtime = new HostCallRuntime({
      getSessionLane: (id) => (runs.has(id) ? { projectId: "proj-1", slot: 0 } : null),
      callerRun: (id) => runs.get(id) ?? null,
      client: () => null,
      hosts: () => hosts,
      inLocalView: () => true,
      controlEnabled: () => true,
      connect,
      queueNotice: (_lane, wake) => queued.push(wake),
      watchHosts: (next) => {
        listener = next;
        return () => {
          listener = null;
        };
      },
      newId: () => "1",
    });
  });

  afterEach(() => {
    runtime.dispose();
    vi.useRealTimers();
  });

  const arm = (helpSessionId = "a") =>
    runtime.watch(helpSessionId, { operation: "arm", hostId: "studio", connection: "connected" });

  it("arms for the calling run only, and refuses a session with no run here", async () => {
    await expect(arm("stranger")).resolves.toMatchObject({ ok: false, code: "NOT_ELIGIBLE" });
    expect(listener).toBeNull();
    const armed = await arm();
    expect(armed).toMatchObject({ ok: true, value: { outcome: "ok", armed: true } });
    expect(listener).not.toBeNull();
  });

  it("never dials the host it watches", async () => {
    await expect(arm()).resolves.toMatchObject({ ok: true, value: { armed: true } });
    vi.advanceTimersByTime(60 * 60_000);
    expect(connect).not.toHaveBeenCalled();
  });

  it("lets go of what it heard when the session ends, is relaunched, or the runtime goes", async () => {
    await arm();
    runtime.endHelpSession("a");
    expect(listener).toBeNull();

    await arm();
    expect(listener).not.toBeNull();
    runtime.retireWatches("a");
    expect(listener).toBeNull();

    await arm();
    expect(listener).not.toBeNull();
    runtime.dispose();
    expect(listener).toBeNull();
    expect(queued).toEqual([]);
  });
});

describe("HostCallRuntime host.watch on agents (#16188)", () => {
  const WAITING: AgentDirectory = {
    coverage: "ok",
    observedAt: 1,
    complete: true,
    omitted: 0,
    entries: [
      {
        state: "live",
        role: "worker",
        subject: {
          hostId: "local",
          scope: { kind: "project", projectId: "p1" },
          terminalId: "t-1",
          incarnation: 2,
        },
        agentId: "claude",
        agentState: "waiting",
        waitingReason: "approval",
        since: 10,
        label: null,
        attached: null,
        handback: null,
      },
    ],
  };
  const host = (hostId: string, connected: boolean): ObservedHost => ({
    hostId,
    name: `${hostId}-name`,
    connection: (connected
      ? { status: "connected", rttMs: 3 }
      : { status: "disconnected" }) as ObservedHost["connection"],
    lastSeenAt: null,
    summary: null,
  });

  let agentListener: AgentWaitingListener | null;
  let answers: Map<string, AgentsAnswer | Error>;
  let agents: ReturnType<typeof vi.fn<(hostId: string) => Promise<AgentsAnswer>>>;
  let dialingAgents: ReturnType<typeof vi.fn>;
  let connect: ReturnType<typeof vi.fn<(hostId: string, timeoutMs: number) => Promise<unknown>>>;
  let runtime: HostCallRuntime;

  beforeEach(() => {
    agentListener = null;
    dialingAgents = vi.fn();
    answers = new Map<string, AgentsAnswer | Error>([
      ["fresh", { status: "done", directory: WAITING, waitingEvents: true }],
      ["older", { status: "done", directory: { ...WAITING, entries: [] } }],
      ["ancient", Object.assign(new Error("no"), { code: "UNSUPPORTED" })],
      ["shy", { status: "refused", reason: "control-off" }],
    ]);
    agents = vi.fn(async (hostId: string) => {
      const answer = answers.get(hostId);
      if (answer instanceof Error) throw answer;
      if (!answer) throw new Error("unreachable");
      return answer;
    });
    connect = vi.fn(async () => undefined);
    runtime = new HostCallRuntime({
      getSessionLane: () => ({ projectId: "proj-1", slot: 0 }),
      callerRun: () => RUN,
      client: () =>
        ({
          relayCall: vi.fn(),
          throwawayCall: vi.fn(),
          // host.list's read, which may touch or dial a link: an arm never uses it.
          agents: dialingAgents,
          agentsOnOpenLink: agents,
        }) as never,
      hosts: () => [
        host("fresh", true),
        host("older", true),
        host("ancient", true),
        host("shy", true),
        host("down", false),
      ],
      inLocalView: () => true,
      controlEnabled: () => true,
      connect,
      queueNotice: () => {},
      watchHosts: () => () => {},
      watchAgents: (next) => {
        agentListener = next;
        return () => {
          agentListener = null;
        };
      },
      local: {
        name: () => "this Mac",
        projects: async () => [],
        relayCall: vi.fn(),
        agents: async () => ({ ...WAITING, entries: [] }),
      },
      newId: () => "1",
    });
  });

  afterEach(() => {
    runtime.dispose();
  });

  it("reads only links already up, names who waits there, and says how each host is heard", async () => {
    const armed = await runtime.watch("a", { operation: "arm", agentsWaiting: true });
    expect(armed).toMatchObject({ ok: true, value: { outcome: "ok", armed: true } });
    const value = (armed as { ok: true; value: HostWatchResult }).value;
    expect(value.agents?.matches).toEqual([
      {
        hostId: "fresh",
        projectId: "p1",
        worktreeId: null,
        terminalId: "t-1",
        incarnation: 2,
        agentIncarnation: null,
        waitingReason: "approval",
        seenAt: 10,
      },
    ]);
    expect(value.agents?.hosts.map((entry) => [entry.hostId, entry.hears])).toEqual([
      ["local", "events"],
      ["fresh", "events"],
      ["older", "older-host"],
      ["ancient", "older-host"],
      ["shy", "host-refused"],
      ["down", "link-down"],
    ]);
    expect(agents.mock.calls.map(([hostId]) => hostId)).toEqual([
      "fresh",
      "older",
      "ancient",
      "shy",
    ]);
    expect(connect).not.toHaveBeenCalled();
    expect(dialingAgents).not.toHaveBeenCalled();
    expect(agentListener).not.toBeNull();

    // Only an arm on agents reads them: a link watch never does.
    await expect(
      runtime.watch("a", { operation: "arm", hostId: "down", connection: "connected" })
    ).resolves.toMatchObject({ ok: true, value: { armed: true } });
    expect(agents).toHaveBeenCalledTimes(4);
  });

  it("lets go of what it heard when the session ends", async () => {
    await runtime.watch("a", { operation: "arm", agentsWaiting: true, hostId: "local" });
    expect(agents).not.toHaveBeenCalled();
    expect(agentListener).not.toBeNull();
    runtime.endHelpSession("a");
    expect(agentListener).toBeNull();
  });
});
