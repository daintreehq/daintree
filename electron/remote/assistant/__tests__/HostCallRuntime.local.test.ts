import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostMetricsSummary } from "../../../../shared/types/remoteHosts.js";
import type { LaneWake } from "../../../services/mcp-server/terminalNotify.js";
import { AGENT_DIRECTORY_BYTES_MAX } from "../../../../shared/types/agentDirectory.js";
import {
  HOST_LIST_PROJECTS_MAX,
  HostCallResultSchema,
  HostListResultSchema,
} from "../../../../shared/types/hostControl.js";
import {
  HostCallRuntime,
  type ObservedHost,
  type OpenRun,
  type RelayApprovalQuestion,
} from "../HostCallRuntime.js";
import {
  createLocalMcpRelay,
  LOCAL_RELAY_SENDER_ID,
  type LocalMcpRelay,
} from "../localMcpRelay.js";
import type { RelayMcpSession, RelayMcpSessionSpec } from "../mcpRelayExecutor.js";

const RUN_A: OpenRun = {
  projectId: "proj-1",
  slot: 0,
  sessionId: "a",
  terminalId: "t-a",
  launchGeneration: 1,
};

const STUDIO: ObservedHost = {
  hostId: "studio",
  name: "studio-01",
  connection: { status: "connected", rttMs: 12, handshake: {} as never },
  lastSeenAt: 900,
  summary: null,
};

const LIST = { hostId: "local", projectId: "proj-2", tool: "terminal.list", args: { owned: true } };

interface OpenedSession {
  spec: RelayMcpSessionSpec;
  closed: boolean;
  calls: Array<{ tool: string; args: Record<string, unknown>; callId: string }>;
}

describe("HostCallRuntime reaching this machine's other projects (#14024)", () => {
  let runs: Map<string, OpenRun>;
  let projects: Array<{ id: string; name: string; path: string; frontendAttached?: boolean }>;
  let relayCall: ReturnType<typeof vi.fn>;
  let opened: OpenedSession[];
  let answer: (session: OpenedSession) => Promise<CallToolResult>;
  let queued: Array<{
    lane: { helpSessionId: string; terminalId: string; projectId: string };
    wake: LaneWake;
  }>;
  let asked: RelayApprovalQuestion[];
  let retired: Array<[string, string]>;
  let ids: number;
  let local: LocalMcpRelay;
  let latestSummary: (() => HostMetricsSummary | null) | undefined;
  let runtime: HostCallRuntime;

  beforeEach(() => {
    latestSummary = undefined;
    runs = new Map([["a", { ...RUN_A }]]);
    projects = [
      { id: "proj-1", name: "daintree", path: "/repos/daintree" },
      { id: "proj-2", name: "website", path: "/repos/website" },
      { id: "proj-3", name: "api", path: "/repos/api" },
    ];
    relayCall = vi.fn();
    opened = [];
    answer = async () => ({ content: [], structuredContent: { terminals: [] } });
    queued = [];
    asked = [];
    retired = [];
    ids = 0;
    local = createLocalMcpRelay({
      machineName: () => "greg-mbp",
      hasProject: async (projectId) => projects.some((project) => project.id === projectId),
      openSession: async (spec) => {
        const session: OpenedSession = { spec, closed: false, calls: [] };
        opened.push(session);
        return {
          isOpen: () => !session.closed,
          callTool: async (tool, args, { callId }) => {
            session.calls.push({ tool, args, callId });
            return answer(session);
          },
          close: () => {
            session.closed = true;
          },
        } satisfies RelayMcpSession;
      },
      retirePrincipal: (senderId, helpSessionId) => retired.push([senderId, helpSessionId]),
      receiveNotices: (payload) => runtime.receiveNotices("local", payload),
      receiveApproval: (payload) => runtime.receiveApproval("local", payload),
      newId: () => `notice-${++ids}`,
    });
    runtime = new HostCallRuntime({
      getSessionLane: (id) => (runs.has(id) ? { projectId: "proj-1", slot: 0 } : null),
      callerRun: (id) => runs.get(id) ?? null,
      client: () => ({ relayCall }) as never,
      hosts: () => [STUDIO],
      inLocalView: () => true,
      // No switch, here or in the registry, names this machine.
      controlEnabled: (hostId) => hostId === "studio",
      listHostProjects: async () => [
        { id: "host-p", name: "remote repo", path: "/r", frontendAttached: true },
      ],
      queueNotice: (lane, wake) => queued.push({ lane, wake }),
      askApproval: async (question) => {
        asked.push(question);
        return "approved";
      },
      local: {
        name: () => "greg-mbp",
        projects: async () => projects,
        latestSummary: () => latestSummary?.() ?? null,
        relayCall: (payload) => local.relayCall(payload),
      },
      now: () => 1000,
      newId: () => `00000000-0000-4000-8000-00000000000${++ids}`,
    });
  });

  afterEach(() => {
    runtime.dispose();
    local.dispose();
  });

  describe("host.list", () => {
    it("lists this machine first as local, naming every project but the caller's own", async () => {
      const listed = await runtime.list("a");
      if (!listed.ok) throw new Error("refused");

      expect(HostListResultSchema.safeParse(listed.value).success).toBe(true);
      expect(listed.value.hosts.map((host) => host.hostId)).toEqual(["local", "studio"]);
      expect(listed.value.hosts[0]).toEqual({
        hostId: "local",
        name: "greg-mbp",
        connection: "connected",
        rttMs: null,
        lastSeenAt: null,
        load: null,
        agentsObserved: null,
        projects: [
          { projectId: "proj-2", name: "website", frontendAttached: null },
          { projectId: "proj-3", name: "api", frontendAttached: null },
        ],
        control: true,
      });
      expect(listed.value.hosts[1]?.projects).toEqual([
        { projectId: "host-p", name: "remote repo", frontendAttached: true },
      ]);
    });

    it("adds the agent inventory only when asked, local read, remote hosts unsupported", async () => {
      const agents = vi.fn(async () => ({
        coverage: "ok" as const,
        observedAt: 42,
        complete: true,
        omitted: 0,
        entries: [],
      }));
      const withAgents = new HostCallRuntime({
        getSessionLane: () => ({ projectId: "proj-1", slot: 0 }),
        callerRun: () => RUN_A,
        client: () => null,
        hosts: () => [STUDIO],
        controlEnabled: () => true,
        local: { name: () => "greg-mbp", projects: async () => [], relayCall: vi.fn(), agents },
      });

      const plain = await withAgents.list("a");
      if (!plain.ok) throw new Error("refused");
      expect(plain.value.hosts.every((host) => host.agents === undefined)).toBe(true);
      expect(agents).not.toHaveBeenCalled();

      const listed = await withAgents.list("a", { includeAgents: true, projectId: "proj-1" });
      if (!listed.ok) throw new Error("refused");
      expect(HostListResultSchema.safeParse(listed.value).success).toBe(true);
      expect(agents).toHaveBeenCalledWith({ projectId: "proj-1" });
      expect(listed.value.hosts[0]?.agents).toMatchObject({ coverage: "ok", observedAt: 42 });
      // A host this Shell can't read agents from is not an empty inventory.
      expect(listed.value.hosts[1]?.agents).toMatchObject({
        coverage: "unsupported",
        complete: false,
        entries: [],
      });
      withAgents.dispose();
    });

    it("fits the agents so the whole host.list answer stays within the directory budget", async () => {
      const entry = (index: number) => ({
        state: "live" as const,
        role: "worker" as const,
        subject: {
          hostId: "local",
          scope: { kind: "project" as const, projectId: "p" },
          terminalId: `terminal-${index}`,
          incarnation: 1,
        },
        agentId: "claude",
        agentState: "idle" as const,
        waitingReason: null,
        since: null,
        label: "x".repeat(120),
        attached: null,
        handback: null,
      });
      const full = new HostCallRuntime({
        getSessionLane: () => ({ projectId: "proj-1", slot: 0 }),
        callerRun: () => RUN_A,
        client: () => null,
        hosts: () => [],
        local: {
          name: () => "greg-mbp",
          projects: async () =>
            Array.from({ length: 50 }, (_, index) => ({
              id: `q-${index}`,
              name: `Project ${index}`,
              path: "/p",
            })),
          relayCall: vi.fn(),
          agents: async () => ({
            coverage: "ok" as const,
            observedAt: 1,
            complete: true,
            omitted: 0,
            entries: Array.from({ length: 256 }, (_, index) => entry(index)),
          }),
        },
      });
      const listed = await full.list("a", { includeAgents: true });
      if (!listed.ok) throw new Error("refused");
      expect(new TextEncoder().encode(JSON.stringify(listed.value)).length).toBeLessThanOrEqual(
        AGENT_DIRECTORY_BYTES_MAX
      );
      const agents = listed.value.hosts[0]?.agents;
      expect(agents?.omitted).toBeGreaterThan(0);
      expect(agents?.entries.length).toBeGreaterThan(0);
      full.dispose();
    });

    it("reports an unreadable local inventory as unreachable, not empty", async () => {
      const broken = new HostCallRuntime({
        getSessionLane: () => ({ projectId: "proj-1", slot: 0 }),
        callerRun: () => RUN_A,
        client: () => null,
        hosts: () => [],
        local: {
          name: () => "greg-mbp",
          projects: async () => [],
          relayCall: vi.fn(),
          agents: async () => {
            throw new Error("boom");
          },
        },
      });
      const listed = await broken.list("a", { includeAgents: true });
      if (!listed.ok) throw new Error("refused");
      expect(listed.value.hosts[0]?.agents).toMatchObject({ coverage: "unreachable", entries: [] });
      broken.dispose();
    });

    it("gives this machine's load from the sample it holds, and null where it holds none", async () => {
      let listed = await runtime.list("a");
      if (!listed.ok) throw new Error("refused");
      expect(listed.value.hosts[0]?.load).toBeNull();

      latestSummary = () =>
        ({
          sampledAt: 995,
          platform: "darwin",
          cpuPercent: 25,
          cpuLogicalCoreCount: 12,
          memoryPressure: "normal",
          memoryUsedBytes: 10e9,
          memoryTotalBytes: 36e9,
          thermal: null,
        }) as HostMetricsSummary;
      listed = await runtime.list("a");
      if (!listed.ok) throw new Error("refused");
      expect(HostListResultSchema.safeParse(listed.value).success).toBe(true);
      expect(listed.value.hosts[0]?.load).toMatchObject({
        stale: false,
        ageMs: 5,
        cpuBusyCores: 3,
        cpuIdleCores: 9,
        memoryAvailableBytes: 26e9,
        thermal: null,
      });
    });

    it("caps the projects it names, and names none when they can't be read", async () => {
      projects = Array.from({ length: HOST_LIST_PROJECTS_MAX + 5 }, (_, index) => ({
        id: `p-${index}`,
        name: `Project ${index}`,
        path: `/repos/${index}`,
      }));
      let listed = await runtime.list("a");
      if (!listed.ok) throw new Error("refused");
      expect(listed.value.hosts[0]?.projects).toHaveLength(HOST_LIST_PROJECTS_MAX);

      const failing = new HostCallRuntime({
        getSessionLane: () => ({ projectId: "proj-1", slot: 0 }),
        callerRun: () => RUN_A,
        client: () => null,
        hosts: () => [],
        local: {
          name: () => "greg-mbp",
          projects: async () => {
            throw new Error("database closed");
          },
          relayCall: vi.fn(),
        },
      });
      listed = await failing.list("a");
      if (!listed.ok) throw new Error("refused");
      expect(listed.value.hosts).toHaveLength(1);
      expect(listed.value.hosts[0]?.projects).toBeNull();
    });
  });

  describe("host.call", () => {
    it("runs the call in a session admitted for the caller in that project, with no link", async () => {
      const settled = await runtime.call("a", LIST, { tier: "full" });

      expect(settled).toEqual({
        ok: true,
        value: {
          outcome: "ok",
          detail: null,
          retryAfterMs: null,
          callId: "00000000-0000-4000-8000-000000000001",
          result: { isError: false, structured: { terminals: [] }, text: null },
        },
      });
      if (!settled.ok) throw new Error("refused");
      expect(HostCallResultSchema.safeParse(settled.value).success).toBe(true);
      expect(relayCall).not.toHaveBeenCalled();
      expect(opened).toHaveLength(1);
      expect(opened[0]!.spec).toMatchObject({
        senderId: LOCAL_RELAY_SENDER_ID,
        helpSessionId: "a",
        projectId: "proj-2",
        tier: "full",
        shellName: "greg-mbp",
        local: true,
      });
      expect(opened[0]!.calls).toEqual([
        {
          tool: "terminal.list",
          args: { owned: true },
          callId: "00000000-0000-4000-8000-000000000001",
        },
      ]);
    });

    it("refuses the caller's own project before anything runs", async () => {
      const settled = await runtime.call("a", { ...LIST, projectId: "proj-1" }, { tier: "core" });

      expect(settled).toMatchObject({
        ok: true,
        value: {
          outcome: "policy_rejected",
          detail: expect.stringMatching(/own project/),
          callId: null,
          result: null,
        },
      });
      expect(opened).toEqual([]);
    });

    it("says it is this machine that has no project with that id", async () => {
      const settled = await runtime.call("a", { ...LIST, projectId: "gone" }, { tier: "core" });

      expect(settled).toMatchObject({
        ok: true,
        value: {
          outcome: "not_found",
          detail: expect.stringMatching(/^This machine has no project/),
        },
      });
      expect(opened).toEqual([]);
    });

    it("runs a resend once, answering it from the first send", async () => {
      const first = await runtime.call("a", LIST, { tier: "core" });
      if (!first.ok || first.value.callId === null) throw new Error("refused");
      const again = await runtime.call(
        "a",
        { ...LIST, callId: first.value.callId },
        { tier: "core" }
      );

      expect(again).toEqual(first);
      expect(opened[0]!.calls).toHaveLength(1);
    });

    it("is no host at all where this machine's projects can't be reached", async () => {
      const remoteOnly = new HostCallRuntime({
        getSessionLane: () => ({ projectId: "proj-1", slot: 0 }),
        callerRun: () => RUN_A,
        client: () => ({ relayCall }) as never,
        hosts: () => [STUDIO],
        controlEnabled: () => true,
      });

      await expect(remoteOnly.call("a", LIST, { tier: "core" })).resolves.toMatchObject({
        ok: true,
        value: { outcome: "not_found" },
      });
      const listed = await remoteOnly.list("a");
      if (!listed.ok) throw new Error("refused");
      expect(listed.value.hosts.map((host) => host.hostId)).toEqual(["studio"]);
      expect(relayCall).not.toHaveBeenCalled();
    });
  });

  it("types a notice the call armed into the run that made it, even one fired before it answered", async () => {
    answer = async (session) => {
      session.spec.deliverNotices([
        {
          helpSessionId: "a",
          callId: session.calls[0]!.callId,
          terminalId: "t-site",
          observation: {
            kind: "state",
            state: "waiting",
            waitingReason: "prompt",
            handback: false,
          },
        },
      ]);
      return { content: [], structuredContent: { terminalId: "t-site" } };
    };
    await runtime.call(
      "a",
      {
        ...LIST,
        tool: "agent.launch",
        args: { agentId: "claude", prompt: "fix it", notify: true },
      },
      { tier: "core" }
    );

    expect(queued).toHaveLength(1);
    expect(queued[0]!.lane).toEqual({ helpSessionId: "a", terminalId: "t-a", projectId: "proj-1" });
    expect(queued[0]!.wake).toMatchObject({
      kind: "notice",
      hostNotice: { hostName: "greg-mbp", notice: { terminalId: "t-site" } },
    });
    expect(queued[0]!.wake.recheck()).toEqual({ kind: "ready" });

    runs.set("a", { ...RUN_A, launchGeneration: 2 });
    expect(queued[0]!.wake.recheck()).toEqual({ kind: "unavailable", reason: "relaunched" });
  });

  it("puts a confirm-gated call to the person in the caller's own window, for that call alone", async () => {
    let decision: unknown;
    answer = async (session) => {
      decision = await session.spec.requestApproval({
        callId: session.calls[0]!.callId,
        actionId: "worktree.delete",
        args: { worktreeId: "/wt/feature" },
        lines: ["No uncommitted changes."],
      });
      return { content: [], structuredContent: { deleted: true } };
    };
    await runtime.call(
      "a",
      { ...LIST, tool: "worktree.deleteOwned", args: { worktreeId: "/wt/feature" } },
      { tier: "full" }
    );

    expect(asked).toEqual([
      {
        hostId: "local",
        helpSessionId: "a",
        actionId: "worktree.delete",
        args: { worktreeId: "/wt/feature" },
        lines: ["No uncommitted changes."],
      },
    ]);
    expect(decision).toMatchObject({ decision: "approved" });

    // A question about anything but the call that is out gets no approval.
    answer = async (session) => {
      decision = await session.spec.requestApproval({
        callId: session.calls.at(-1)!.callId,
        actionId: "worktree.delete",
        args: { worktreeId: "/wt/other" },
        lines: [],
      });
      return { content: [], structuredContent: {} };
    };
    await runtime.call(
      "a",
      { ...LIST, tool: "worktree.deleteOwned", args: { worktreeId: "/wt/feature" } },
      { tier: "full" }
    );
    expect(asked).toHaveLength(1);
    expect(decision).toEqual({ decision: "unavailable" });
  });

  it("lets a help session that ended go, closing its sessions and its hold on what it made", async () => {
    await runtime.call("a", LIST, { tier: "core" });
    expect(opened[0]!.closed).toBe(false);

    local.endHelpSession("a");

    expect(opened[0]!.closed).toBe(true);
    expect(retired).toEqual([[LOCAL_RELAY_SENDER_ID, "a"]]);
  });
});
