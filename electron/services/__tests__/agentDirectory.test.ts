import { describe, expect, it, vi } from "vitest";
import {
  AgentDirectorySchema,
  isFullAgentDirectory,
} from "../../../shared/types/agentDirectory.js";
import {
  LocalAgentDirectory,
  collectAgentDirectory,
  type AgentDirectorySources,
  type ResumableLane,
} from "../agentDirectory.js";

type Terminal = Awaited<ReturnType<AgentDirectorySources["readTerminals"]>>["terminals"][number];

function terminal(fields: Partial<Terminal> & { id: string }): Terminal {
  return { cwd: "/secret/path", spawnedAt: 1, hasPty: true, ...fields } as Terminal;
}

function sources(overrides: Partial<AgentDirectorySources> = {}): AgentDirectorySources {
  const terminals = [
    terminal({
      id: "w1",
      projectId: "p1",
      detectedAgentId: "claude",
      agentState: "working",
      spawnedAt: 2,
    }),
    terminal({
      id: "w2",
      projectId: "p1",
      launchAgentId: "codex",
      agentState: "waiting",
      waitingReason: "approval",
      lastStateChange: 500,
      title: "  fix   the bug ",
      lastHandback: { message: "private text", observedAt: 700, truncated: false },
      spawnedAt: 1,
    }),
    // Assistants run ordinary agents, stamped or bound to a lane.
    terminal({
      id: "a0",
      projectId: "p1",
      isAssistantTerminal: true,
      detectedAgentId: "claude",
      agentState: "idle",
    }),
    terminal({
      id: "a1",
      projectId: "p1",
      isAssistantTerminal: true,
      launchAgentId: "codex",
      agentState: "working",
    }),
    terminal({
      id: "orphan",
      projectId: "p1",
      isAssistantTerminal: true,
      detectedAgentId: "claude",
    }),
  ];
  const generations: Record<string, number> = { w1: 3, w2: 4, a0: 7, a1: 8 };
  return {
    hostId: "local",
    now: () => 9000,
    listRunningLanes: () => [
      { projectId: "p1", slot: 1, agentId: "codex", attached: false },
      { projectId: "p1", slot: 0, agentId: "claude", attached: true },
    ],
    getRunningLaneSession: (projectId, slot) => ({
      sessionId: `s${slot}`,
      terminalId: `a${slot}`,
      projectViewWebContentsId: 1,
      ...(projectId ? {} : {}),
    }),
    getLiveGeneration: (id) => generations[id] ?? null,
    readTerminals: async () => ({ terminals, degraded: false }),
    isHelpTerminal: () => false,
    resumableLanes: async () => ({ lanes: [], complete: true }),
    ...overrides,
  };
}

describe("collectAgentDirectory (#14160)", () => {
  it("reads assistants alone for a picker, so workers never crowd them out of the cap", async () => {
    const workers = Array.from({ length: 300 }, (_, i) =>
      terminal({ id: `w${i}`, projectId: "p1", detectedAgentId: "claude" })
    );
    const directory = await collectAgentDirectory(
      sources({
        listRunningLanes: () => [],
        getLiveGeneration: () => 1,
        readTerminals: async () => ({ terminals: workers, degraded: false }),
        resumableLanes: async () => ({
          lanes: [{ projectId: "p1", slot: 0, agentId: "claude", capturedAt: 5 }],
          complete: true,
        }),
      }),
      { assistantsOnly: true }
    );
    expect(directory.omitted).toBe(0);
    expect(directory.entries).toEqual([expect.objectContaining({ state: "resumable", lane: 0 })]);
  });

  it("names the global session by its own scope, as a viewer resolves it (#14163)", async () => {
    const directory = await collectAgentDirectory(
      sources({
        listRunningLanes: () => [
          { projectId: "daintree:global-assistant", slot: 0, agentId: "claude", attached: false },
        ],
      })
    );
    expect(AgentDirectorySchema.safeParse(directory).success).toBe(true);
    const assistants = directory.entries.filter((entry) => entry.role === "assistant");
    expect(assistants).toHaveLength(1);
    expect(assistants[0]).toMatchObject({
      state: "live",
      subject: { hostId: "local", scope: { kind: "global" }, terminalId: "a0", incarnation: 7 },
    });
    expect(assistants[0]!.state === "live" && "lane" in assistants[0]!.subject).toBe(false);
  });

  it("types two assistant lanes and the workers once each, role apart from agent", async () => {
    const directory = await collectAgentDirectory(sources());

    expect(AgentDirectorySchema.safeParse(directory).success).toBe(true);
    expect(isFullAgentDirectory(directory)).toBe(true);
    expect(directory.observedAt).toBe(9000);
    const rows = directory.entries.map((entry) =>
      entry.state === "live"
        ? [entry.role, entry.subject.terminalId, entry.subject.lane ?? null, entry.agentId]
        : null
    );
    expect(rows).toEqual([
      ["assistant", "a0", 0, "claude"],
      ["assistant", "a1", 1, "codex"],
      ["worker", "w2", null, "codex"],
      ["worker", "w1", null, "claude"],
    ]);
    // The unbound stamped terminal appears nowhere, as a worker or an assistant.
    expect(JSON.stringify(directory)).not.toContain("orphan");
  });

  it("carries observations without terminal text, paths or handback messages", async () => {
    const directory = await collectAgentDirectory(sources());
    const worker = directory.entries.find(
      (entry) => entry.state === "live" && entry.subject.terminalId === "w2"
    );

    expect(worker).toMatchObject({
      state: "live",
      agentState: "waiting",
      waitingReason: "approval",
      since: 500,
      label: "fix the bug",
      attached: null,
      handback: { observedAt: 700 },
      subject: { hostId: "local", scope: { kind: "project", projectId: "p1" }, incarnation: 4 },
    });
    const text = JSON.stringify(directory);
    expect(text).not.toContain("/secret/path");
    expect(text).not.toContain("private text");
  });

  it("reports attachment for assistants", async () => {
    const directory = await collectAgentDirectory(sources());
    const attached = directory.entries.flatMap((entry) =>
      entry.state === "live" && entry.role === "assistant" ? [entry.attached] : []
    );
    expect(attached).toEqual([true, false]);
  });

  it("gives a reused terminal id a new incarnation and keeps hosts apart", async () => {
    const first = await collectAgentDirectory(sources());
    const second = await collectAgentDirectory(
      sources({
        getLiveGeneration: (id) => (id === "w1" ? 99 : id === "w2" ? 4 : id === "a0" ? 7 : 8),
      })
    );
    const pick = (directory: typeof first) =>
      directory.entries.flatMap((entry) =>
        entry.state === "live" && entry.subject.terminalId === "w1" ? [entry.subject] : []
      )[0];
    expect(pick(first)?.incarnation).toBe(3);
    expect(pick(second)?.incarnation).toBe(99);

    const other = await collectAgentDirectory(sources({ hostId: "studio" }));
    expect(pick(other)).toMatchObject({ hostId: "studio", terminalId: "w1" });
    expect(pick(other)?.hostId).not.toBe(pick(first)?.hostId);
  });

  it("lists a lane that has only a resume pointer as resumable, never live, and never twice", async () => {
    const pointers: ResumableLane[] = [
      { projectId: "p1", slot: 0, agentId: "claude", capturedAt: 11 },
      { projectId: "p2", slot: 2, agentId: "codex", capturedAt: 22 },
    ];
    const directory = await collectAgentDirectory(
      sources({ resumableLanes: async () => ({ lanes: pointers, complete: true }) })
    );

    const resumable = directory.entries.filter((entry) => entry.state === "resumable");
    expect(resumable).toEqual([
      {
        state: "resumable",
        role: "assistant",
        hostId: "local",
        scope: { kind: "project", projectId: "p2" },
        lane: 2,
        agentId: "codex",
        capturedAt: 22,
      },
    ]);
    expect(JSON.stringify(resumable)).not.toContain("terminalId");
  });

  it("lists a project's lanes whose renderer is gone as resumable, from main-side state alone", async () => {
    const directory = await collectAgentDirectory(
      sources({
        listRunningLanes: () => [],
        getRunningLaneSession: () => null,
        getLiveGeneration: () => null,
        readTerminals: async () => ({ terminals: [], degraded: false }),
        resumableLanes: async () => ({
          lanes: [{ projectId: "p1", slot: 0, agentId: "claude", capturedAt: 5 }],
          complete: true,
        }),
      })
    );
    expect(directory.entries.map((entry) => entry.state)).toEqual(["resumable"]);
  });

  it("filters to one project before the cap", async () => {
    const directory = await collectAgentDirectory(
      sources({
        resumableLanes: async () => ({
          lanes: [{ projectId: "p2", slot: 0, agentId: null, capturedAt: 1 }],
          complete: true,
        }),
      }),
      { projectId: "p2" }
    );
    expect(directory.entries.map((entry) => entry.state)).toEqual(["resumable"]);
  });

  it("marks a partial pty read incomplete and an untargetable worker incomplete, not exited", async () => {
    const partial = await collectAgentDirectory(
      sources({ readTerminals: async () => ({ terminals: [], degraded: true }) })
    );
    expect(partial.complete).toBe(false);
    expect(isFullAgentDirectory(partial)).toBe(false);
    // The lanes still stand, with no state claimed for a PTY that wasn't read.
    expect(partial.entries[0]).toMatchObject({ role: "assistant", agentState: null });

    const untracked = await collectAgentDirectory(
      sources({ getLiveGeneration: (id) => (id.startsWith("a") ? 1 : null) })
    );
    expect(untracked.complete).toBe(false);
    expect(
      untracked.entries.every((entry) => entry.state === "live" && entry.role === "assistant")
    ).toBe(true);
  });

  it("does not lend a replaced run's observations to its new incarnation", async () => {
    let generation = 7;
    const directory = await collectAgentDirectory(
      sources({
        getLiveGeneration: (id) =>
          id === "a0"
            ? generation
            : (({ w1: 3, w2: 4, a1: 8 } as Record<string, number>)[id] ?? null),
        readTerminals: async () => {
          generation = 8; // a0 restarted while the pty was read
          return {
            terminals: [terminal({ id: "a0", agentState: "waiting", waitingReason: "approval" })],
            degraded: false,
          };
        },
      })
    );
    const a0 = directory.entries.find(
      (entry) => entry.state === "live" && entry.subject.terminalId === "a0"
    );
    expect(a0).toMatchObject({
      subject: { incarnation: 8 },
      agentState: null,
      waitingReason: null,
    });
    expect(directory.complete).toBe(false);
  });

  it("is incomplete when the resume pointers of some projects were not looked up", async () => {
    const directory = await collectAgentDirectory(
      sources({ resumableLanes: async () => ({ lanes: [], complete: false }) })
    );
    expect(directory.complete).toBe(false);
    expect(isFullAgentDirectory(directory)).toBe(false);
  });

  it("caps entries and counts the rest", async () => {
    const many = Array.from({ length: 300 }, (_, index) =>
      terminal({ id: `m${index}`, projectId: "p9", detectedAgentId: "claude" })
    );
    const directory = await collectAgentDirectory(
      sources({
        listRunningLanes: () => [],
        readTerminals: async () => ({ terminals: many, degraded: false }),
        getLiveGeneration: () => 1,
      })
    );
    expect(directory.entries).toHaveLength(256);
    expect(directory.omitted).toBe(44);
    expect(isFullAgentDirectory(directory)).toBe(false);
  });

  it("never starts, resumes or reads a session to list one", async () => {
    const getRunningLaneSession = vi.fn(sources().getRunningLaneSession);
    await collectAgentDirectory(sources({ getRunningLaneSession }));
    expect(getRunningLaneSession).toHaveBeenCalledTimes(2);
  });
});

describe("LocalAgentDirectory last-known retention", () => {
  it("answers a failed read with the last directory, dated when it was seen, never an empty one", async () => {
    let fail = false;
    let clock = 100;
    const directory = new LocalAgentDirectory(
      sources({
        now: () => clock,
        readTerminals: async () => {
          if (fail) throw new Error("no pty client");
          return {
            terminals: [terminal({ id: "w1", projectId: "p1", detectedAgentId: "claude" })],
            degraded: false,
          };
        },
        listRunningLanes: () => [],
        getLiveGeneration: () => 1,
      })
    );
    const fresh = await directory.read();
    expect(fresh.coverage).toBe("ok");

    fail = true;
    clock = 500;
    const stale = await directory.read();
    expect(stale.coverage).toBe("stale");
    expect(stale.observedAt).toBe(100);
    expect(stale.entries).toEqual(fresh.entries);
    expect(isFullAgentDirectory(stale)).toBe(false);
  });

  it("keeps the last directory when a later read is degraded or slow", async () => {
    let mode: "ok" | "degraded" | "slow" = "ok";
    const directory = new LocalAgentDirectory(
      sources({
        listRunningLanes: () => [],
        getLiveGeneration: () => 1,
        readTerminals: async () => {
          if (mode === "slow") return new Promise(() => {});
          return {
            terminals:
              mode === "ok"
                ? [terminal({ id: "w1", projectId: "p1", detectedAgentId: "claude" })]
                : [],
            degraded: mode === "degraded",
          };
        },
      }),
      20
    );
    const fresh = await directory.read();
    mode = "degraded";
    const degraded = await directory.read();
    expect(degraded).toMatchObject({ coverage: "stale", observedAt: 9000, complete: false });
    expect(degraded.entries).toEqual(fresh.entries);
    mode = "slow";
    const slow = await directory.read();
    expect(slow).toMatchObject({ coverage: "stale", observedAt: 9000 });
    expect(slow.entries).toEqual(fresh.entries);
  });

  it("is unreachable, not empty, when nothing was ever read", async () => {
    const directory = new LocalAgentDirectory(
      sources({
        readTerminals: async () => {
          throw new Error("down");
        },
      })
    );
    const read = await directory.read();
    expect(read).toMatchObject({ coverage: "unreachable", observedAt: null, entries: [] });
    expect(isFullAgentDirectory(read)).toBe(false);
  });
});
