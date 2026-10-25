import { describe, expect, it, vi } from "vitest";
import {
  AGENT_DIRECTORY_BYTES_MAX,
  type AgentDirectory,
  type AgentDirectoryEntry,
} from "../../../../shared/types/agentDirectory.js";
import { HostListResultSchema } from "../../../../shared/types/hostControl.js";
import { AppError } from "../../../utils/errorTypes.js";
import { HostCallRuntime, type ObservedHost, type OpenRun } from "../HostCallRuntime.js";
import type { AgentsAnswer, AgentsPayload } from "../linkMethods.js";

const RUN_A: OpenRun = {
  projectId: "proj-1",
  slot: 0,
  sessionId: "a",
  terminalId: "t-a",
  launchGeneration: 1,
};

function host(hostId: string, status: "connected" | "disconnected" = "connected"): ObservedHost {
  return {
    hostId,
    name: `${hostId}-name`,
    connection:
      status === "connected"
        ? {
            status,
            rttMs: 12,
            handshake: {
              version: "1.0.0",
              commit: "abc1234",
              protocolVersion: 12,
              platform: "linux",
              arch: "x64",
            },
          }
        : ({ status } as ObservedHost["connection"]),
    lastSeenAt: 900,
    summary: null,
  };
}

function worker(terminalId: string, projectId = "p", label: string | null = null) {
  return {
    state: "live" as const,
    role: "worker" as const,
    subject: {
      hostId: "local",
      scope: { kind: "project" as const, projectId },
      terminalId,
      incarnation: 4,
    },
    agentId: "claude",
    agentState: "idle" as const,
    waitingReason: null,
    since: null,
    label,
    attached: null,
    handback: null,
  };
}

const ASSISTANT: AgentDirectoryEntry = {
  state: "live",
  role: "assistant",
  subject: {
    hostId: "local",
    scope: { kind: "project", projectId: "p" },
    terminalId: "t-help",
    incarnation: 2,
    lane: 1,
  },
  agentId: "claude",
  agentState: "working",
  waitingReason: null,
  since: 5,
  label: "Assistant",
  attached: false,
  handback: null,
};

const GLOBAL: AgentDirectoryEntry = {
  ...ASSISTANT,
  subject: { hostId: "local", scope: { kind: "global" }, terminalId: "t-global", incarnation: 9 },
} as AgentDirectoryEntry;

const RESUMABLE: AgentDirectoryEntry = {
  state: "resumable",
  role: "assistant",
  hostId: "local",
  scope: { kind: "project", projectId: "p" },
  lane: 2,
  agentId: "codex",
  capturedAt: 3,
};

function directory(entries: AgentDirectoryEntry[], over: Partial<AgentDirectory> = {}) {
  return { coverage: "ok", observedAt: 42, complete: true, omitted: 0, entries, ...over } as const;
}

function setup(
  options: {
    hosts?: ObservedHost[];
    control?: (hostId: string) => boolean;
    agents?: (hostId: string, payload: AgentsPayload) => Promise<AgentsAnswer>;
    client?: boolean;
  } = {}
) {
  let hosts = options.hosts ?? [host("studio")];
  const agents = vi.fn(
    options.agents ??
      (async (): Promise<AgentsAnswer> => ({ status: "done", directory: directory([]) }))
  );
  const relayCall = vi.fn();
  const runtime = new HostCallRuntime({
    getSessionLane: () => ({ projectId: "proj-1", slot: 0 }),
    callerRun: () => RUN_A,
    client: () => (options.client === false ? null : { relayCall, throwawayCall: vi.fn(), agents }),
    hosts: () => hosts,
    controlEnabled: options.control ?? (() => true),
    listHostProjects: async () => [],
  });
  const list = async (args: { projectId?: string } = {}) => {
    const listed = await runtime.list("a", { includeAgents: true, ...args });
    if (!listed.ok) throw new Error("refused");
    expect(HostListResultSchema.safeParse(listed.value).success).toBe(true);
    return listed.value.hosts;
  };
  return {
    runtime,
    agents,
    list,
    setHosts: (next: ObservedHost[]) => {
      hosts = next;
    },
  };
}

describe("HostCallRuntime listing hosts' agents (#14455)", () => {
  it("reads a connected host's workers and assistants, addressed by this Shell's id for it", async () => {
    const { list, agents, runtime } = setup({
      agents: async () => ({
        status: "done",
        directory: directory([worker("t-1"), ASSISTANT, GLOBAL, RESUMABLE]),
      }),
    });
    const [studio] = await list({ projectId: "p" });
    expect(agents).toHaveBeenCalledWith("studio", { projectId: "p" }, expect.any(Number));
    expect(studio?.agents).toMatchObject({ coverage: "ok", observedAt: 42, complete: true });
    const entries = studio?.agents?.entries ?? [];
    expect(entries.map((entry) => (entry.state === "live" ? entry.subject : entry))).toEqual([
      {
        hostId: "studio",
        scope: { kind: "project", projectId: "p" },
        terminalId: "t-1",
        incarnation: 4,
      },
      {
        hostId: "studio",
        scope: { kind: "project", projectId: "p" },
        terminalId: "t-help",
        incarnation: 2,
        lane: 1,
      },
      { hostId: "studio", scope: { kind: "global" }, terminalId: "t-global", incarnation: 9 },
      { ...RESUMABLE, hostId: "studio" },
    ]);
    runtime.dispose();
  });

  it("reads nothing without includeAgents, and with no hosts asks no host anything", async () => {
    const { runtime, agents } = setup();
    const plain = await runtime.list("a");
    if (!plain.ok) throw new Error("refused");
    expect(plain.value.hosts[0]?.agents).toBeUndefined();
    expect(agents).not.toHaveBeenCalled();
    runtime.dispose();

    const empty = setup({ hosts: [] });
    await expect(empty.list()).resolves.toEqual([]);
    expect(empty.agents).not.toHaveBeenCalled();
    empty.runtime.dispose();
  });

  it("keeps a host's own stale or partial coverage and its omitted count", async () => {
    const { list, runtime } = setup({
      agents: async () => ({
        status: "done",
        directory: directory([worker("t-1")], { coverage: "stale", complete: false, omitted: 3 }),
      }),
    });
    const [studio] = await list();
    expect(studio?.agents).toMatchObject({
      coverage: "stale",
      observedAt: 42,
      complete: false,
      omitted: 3,
    });
    runtime.dispose();
  });

  it("asks nothing of a host whose control is off here, and forgets what it read of it", async () => {
    let control = true;
    const { list, agents, runtime } = setup({
      control: () => control,
      agents: async () => ({ status: "done", directory: directory([worker("t-1")]) }),
    });
    await list();
    control = false;
    const [off] = await list();
    expect(off?.agents).toEqual({
      coverage: "unreachable",
      observedAt: null,
      complete: false,
      omitted: 0,
      entries: [],
    });
    expect(agents).toHaveBeenCalledTimes(1);

    // Back on but unreadable: nothing from before control went off comes back.
    control = true;
    agents.mockRejectedValueOnce(new AppError({ code: "HOST_DISCONNECTED", message: "gone" }));
    const [again] = await list();
    expect(again?.agents).toMatchObject({ coverage: "unreachable", entries: [] });
    runtime.dispose();
  });

  it("shows nothing a host refused, and forgets what it showed before", async () => {
    const { list, agents, runtime } = setup({
      agents: async () => ({ status: "done", directory: directory([worker("t-1")]) }),
    });
    await list();
    agents.mockResolvedValueOnce({ status: "refused", reason: "control-off" });
    const [refused] = await list();
    expect(refused?.agents).toMatchObject({ coverage: "unreachable", entries: [] });
    agents.mockRejectedValueOnce(new Error("lost"));
    const [after] = await list();
    expect(after?.agents).toMatchObject({ coverage: "unreachable", entries: [] });
    runtime.dispose();
  });

  it("names a host from before this unsupported, never an empty inventory", async () => {
    const { list, runtime } = setup({
      agents: async () => {
        throw new AppError({ code: "UNSUPPORTED", message: "old" });
      },
    });
    const [studio] = await list();
    expect(studio?.agents).toMatchObject({ coverage: "unsupported", complete: false, entries: [] });
    runtime.dispose();
  });

  it("answers a failed or disconnected read with the last one of that filter, marked stale", async () => {
    const { list, agents, runtime, setHosts } = setup({
      agents: async (_hostId, payload) => ({
        status: "done",
        directory: directory([worker(payload.projectId ? "t-filtered" : "t-all")], {
          observedAt: payload.projectId ? 50 : 40,
        }),
      }),
    });
    await list();
    await list({ projectId: "p" });

    agents.mockRejectedValueOnce(new Error("lost"));
    const [failed] = await list();
    expect(failed?.agents).toMatchObject({ coverage: "stale", observedAt: 40, complete: false });
    expect(failed?.agents?.entries.map((entry) => entry.state === "live" && entry.subject)).toEqual(
      [expect.objectContaining({ hostId: "studio", terminalId: "t-all" })]
    );

    setHosts([host("studio", "disconnected")]);
    const calls = agents.mock.calls.length;
    const [down] = await list({ projectId: "p" });
    expect(agents.mock.calls.length).toBe(calls);
    expect(down?.agents).toMatchObject({ coverage: "stale", observedAt: 50 });
    // A filter never read is not borrowed from another one.
    const [other] = await list({ projectId: "q" });
    expect(other?.agents).toMatchObject({ coverage: "unreachable", entries: [] });
    runtime.dispose();
  });

  it("holds a host that doesn't answer in time to the last read, and keeps nothing it sends late", async () => {
    vi.useFakeTimers();
    try {
      let late: ((answer: AgentsAnswer) => void) | undefined;
      const { list, agents, runtime } = setup({
        agents: async () => ({ status: "done", directory: directory([worker("t-first")]) }),
      });
      await list();
      agents.mockImplementationOnce(() => new Promise<AgentsAnswer>((resolve) => (late = resolve)));
      const listing = list();
      await vi.advanceTimersByTimeAsync(5_000);
      const [slow] = await listing;
      expect(slow?.agents).toMatchObject({ coverage: "stale", observedAt: 42, complete: false });
      expect(slow?.agents?.entries).toEqual([
        expect.objectContaining({ subject: expect.objectContaining({ terminalId: "t-first" }) }),
      ]);
      late?.({ status: "done", directory: directory([worker("t-late")], { observedAt: 99 }) });
      await vi.advanceTimersByTimeAsync(0);

      agents.mockRejectedValueOnce(new Error("lost"));
      const [after] = await list();
      expect(after?.agents).toMatchObject({ coverage: "stale", observedAt: 42 });
      expect(after?.agents?.entries).toEqual([
        expect.objectContaining({ subject: expect.objectContaining({ terminalId: "t-first" }) }),
      ]);
      runtime.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps no read of a host removed while it ran", async () => {
    let finish: ((answer: AgentsAnswer) => void) | undefined;
    const { list, agents, runtime, setHosts } = setup({
      agents: () => new Promise<AgentsAnswer>((resolve) => (finish = resolve)),
    });
    const first = list();
    await vi.waitFor(() => expect(finish).toBeDefined());
    setHosts([]);
    await runtime.list("a");
    setHosts([host("studio")]);
    finish?.({ status: "done", directory: directory([worker("t-before")]) });
    await first;
    agents.mockRejectedValueOnce(new Error("lost"));
    const [after] = await list();
    expect(after?.agents).toMatchObject({ coverage: "unreachable", entries: [] });
    runtime.dispose();
  });

  it("forgets a removed host's directory", async () => {
    const { list, agents, runtime, setHosts } = setup({
      agents: async () => ({ status: "done", directory: directory([worker("t-1")]) }),
    });
    await list();
    setHosts([]);
    await list();
    setHosts([host("studio", "disconnected")]);
    const [readded] = await list();
    expect(readded?.agents).toMatchObject({ coverage: "unreachable", entries: [] });
    expect(agents).toHaveBeenCalledTimes(1);
    runtime.dispose();
  });

  it("is unreachable with no client to read through", async () => {
    const { list, runtime } = setup({ client: false });
    const [studio] = await list();
    expect(studio?.agents).toMatchObject({ coverage: "unreachable", entries: [] });
    runtime.dispose();
  });

  it("fits every host's directory into one answer within the budget, each counting what it lost", async () => {
    const many = (count: number) =>
      Array.from({ length: count }, (_, index) => worker(`t-${index}`, "p", "x".repeat(120)));
    const { list, runtime } = setup({
      hosts: [host("studio"), host("lab"), host("tiny")],
      agents: async (hostId) => ({
        status: "done",
        directory: directory(hostId === "tiny" ? many(2) : many(256)),
      }),
    });
    const hosts = await list();
    expect(new TextEncoder().encode(JSON.stringify({ hosts })).length).toBeLessThanOrEqual(
      AGENT_DIRECTORY_BYTES_MAX
    );
    const [studio, lab, tiny] = hosts.map((entry) => entry.agents!);
    // The small one keeps everything; the room it didn't need goes to the others.
    expect(tiny).toMatchObject({ omitted: 0 });
    expect(tiny?.entries).toHaveLength(2);
    for (const cut of [studio!, lab!]) {
      expect(cut.omitted).toBeGreaterThan(0);
      expect(cut.entries.length).toBeGreaterThan(0);
      expect(cut.entries.length + cut.omitted).toBe(256);
    }
    expect(Math.abs(studio!.entries.length - lab!.entries.length)).toBeLessThanOrEqual(1);
    runtime.dispose();
  });

  it("holds a host to the entry cap whatever it sends", async () => {
    // Compact enough that the byte budget alone would keep every one.
    const compact = Array.from({ length: 300 }, (_, index): AgentDirectoryEntry => ({
      ...RESUMABLE,
      lane: 0,
      capturedAt: index,
    }));
    const { list, runtime } = setup({
      agents: async () => ({ status: "done", directory: directory(compact) }),
    });
    const [studio] = await list();
    expect(studio?.agents?.entries).toHaveLength(256);
    expect(studio?.agents?.omitted).toBe(44);
    runtime.dispose();
  });

  it("keeps each host's last read apart under the same filter", async () => {
    const { list, agents, runtime } = setup({
      hosts: [host("studio"), host("lab")],
      agents: async (hostId) => ({ status: "done", directory: directory([worker(`t-${hostId}`)]) }),
    });
    await list({ projectId: "p" });
    agents.mockRejectedValue(new Error("lost"));
    const hosts = await list({ projectId: "p" });
    expect(
      hosts.map((entry) =>
        entry.agents?.entries.map((e) => e.state === "live" && e.subject.terminalId)
      )
    ).toEqual([["t-studio"], ["t-lab"]]);
    expect(hosts.every((entry) => entry.agents?.coverage === "stale")).toBe(true);
    runtime.dispose();
  });

  it("shows nothing it held once control goes off during a read that then fails", async () => {
    let control = true;
    const { list, agents, runtime } = setup({
      control: () => control,
      agents: async () => ({ status: "done", directory: directory([worker("t-1")]) }),
    });
    await list();
    agents.mockImplementationOnce(async () => {
      control = false;
      throw new Error("lost");
    });
    const [during] = await list();
    expect(during?.agents).toMatchObject({ coverage: "unreachable", entries: [] });
    control = true;
    agents.mockRejectedValueOnce(new Error("lost"));
    const [after] = await list();
    expect(after?.agents).toMatchObject({ coverage: "unreachable", entries: [] });
    runtime.dispose();
  });

  it("forgets a host whose control went off on a listing without agents too", async () => {
    let control = true;
    const { list, agents, runtime } = setup({
      control: () => control,
      agents: async () => ({ status: "done", directory: directory([worker("t-1")]) }),
    });
    await list();
    control = false;
    await runtime.list("a");
    control = true;
    agents.mockRejectedValueOnce(new Error("lost"));
    const [after] = await list();
    expect(after?.agents).toMatchObject({ coverage: "unreachable", entries: [] });
    runtime.dispose();
  });

  it("keeps no read begun before its host's directories were forgotten", async () => {
    let control = true;
    let finish: ((answer: AgentsAnswer) => void) | undefined;
    const { list, agents, runtime } = setup({
      hosts: [host("studio")],
      control: () => control,
      agents: () => new Promise<AgentsAnswer>((resolve) => (finish = resolve)),
    });
    const first = list();
    await vi.waitFor(() => expect(finish).toBeDefined());
    // Forgotten mid-read by a listing that sees control off, then turned back on.
    control = false;
    await runtime.list("a");
    control = true;
    finish?.({ status: "done", directory: directory([worker("t-before")]) });
    const [shown] = await first;
    expect(shown?.agents?.entries).toHaveLength(1);
    agents.mockRejectedValueOnce(new Error("lost"));
    const [after] = await list();
    expect(after?.agents).toMatchObject({ coverage: "unreachable", entries: [] });
    runtime.dispose();
  });
});
