import { describe, expect, it, vi } from "vitest";
import {
  AgentDirectorySchema,
  isFullAgentDirectory,
  type AgentDirectory,
} from "../../../shared/types/agentDirectory.js";
import type { PaneNotifyState } from "../../../shared/types/terminalNotify.js";
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

  it("lists no host throwaway run, and still reads as complete (#14445)", async () => {
    const base = sources();
    const { terminals } = await base.readTerminals();
    const directory = await collectAgentDirectory({
      ...base,
      readTerminals: async () => ({
        terminals: [
          ...terminals,
          terminal({
            id: "daintree-throwaway-1",
            projectId: "daintree:host-throwaway",
            detectedAgentId: "claude",
            agentState: "waiting",
          }),
        ],
        degraded: false,
      }),
    });

    expect(directory.complete).toBe(true);
    expect(JSON.stringify(directory)).not.toContain("throwaway");
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

describe("collectAgentDirectory decisions and supervision (#14165)", () => {
  const notices = (terminalId: string, fields: Partial<PaneNotifyState> = {}): PaneNotifyState => ({
    terminalId,
    pendingCount: 0,
    readyCount: 0,
    delivery: { status: "idle" },
    revision: 1,
    ...fields,
  });

  function liveAssistant(directory: AgentDirectory, terminalId: string) {
    const entry = directory.entries.find(
      (candidate) => candidate.state === "live" && candidate.subject.terminalId === terminalId
    );
    if (entry?.state !== "live") throw new Error(`no live ${terminalId}`);
    return entry;
  }

  it("puts each lane's own confirmations and notices on its own entry, never a neighbour's", async () => {
    const pendingConfirmations = vi.fn((owner: { helpSessionId: string; terminalId: string }) =>
      owner.helpSessionId === "s1" && owner.terminalId === "a1"
        ? {
            waiting: [{ actionId: "worktree.delete", since: 8_000, expiresAt: 38_000 }],
            omitted: 0,
          }
        : { waiting: [], omitted: 0 }
    );
    const directory = await collectAgentDirectory(
      sources({
        pendingConfirmations,
        paneNotices: (terminalId) =>
          terminalId === "a0"
            ? notices("a0", {
                pendingCount: 2,
                readyCount: 1,
                delivery: { status: "held", reason: "working" },
              })
            : notices(terminalId),
      })
    );

    expect(AgentDirectorySchema.safeParse(directory).success).toBe(true);
    expect(pendingConfirmations).toHaveBeenCalledWith(
      { helpSessionId: "s1", terminalId: "a1" },
      9000
    );
    expect(liveAssistant(directory, "a1")).toMatchObject({
      confirmations: { waiting: [{ actionId: "worktree.delete" }], omitted: 0 },
      // Watching nothing is said as nothing, not as a fault.
      notices: null,
    });
    expect(liveAssistant(directory, "a0")).toMatchObject({
      confirmations: { waiting: [], omitted: 0 },
      notices: { pending: 2, ready: 1, delivery: "held" },
    });
    // A worker is no assistant's session: it carries neither.
    const worker = liveAssistant(directory, "w1");
    expect("confirmations" in worker || "notices" in worker).toBe(false);
  });

  it("leaves notices unsaid, not empty, when they can't be read", async () => {
    const directory = await collectAgentDirectory(sources({ paneNotices: () => undefined }));
    expect("notices" in liveAssistant(directory, "a0")).toBe(false);
  });

  it("gives a run replaced mid-read none of the old session's waits or notices", async () => {
    let generation = 7;
    const directory = await collectAgentDirectory(
      sources({
        getLiveGeneration: (id) =>
          id === "a0"
            ? generation
            : (({ w1: 3, w2: 4, a1: 8 } as Record<string, number>)[id] ?? null),
        readTerminals: async () => {
          generation = 8;
          return { terminals: [], degraded: false };
        },
        pendingConfirmations: () => ({
          waiting: [{ actionId: "worktree.delete", since: 1, expiresAt: 99_999 }],
          omitted: 0,
        }),
        paneNotices: (terminalId) => notices(terminalId, { readyCount: 3 }),
      })
    );

    const replaced = liveAssistant(directory, "a0");
    expect(replaced.subject.incarnation).toBe(8);
    expect("confirmations" in replaced || "notices" in replaced).toBe(false);
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

  describe("late reads (#14456)", () => {
    type Read = Awaited<ReturnType<AgentDirectorySources["readTerminals"]>>;
    function deferredReads() {
      const calls: Array<{ resolve: (read: Read) => void; reject: (error: Error) => void }> = [];
      return {
        calls,
        readTerminals: () =>
          new Promise<Read>((resolve, reject) => {
            calls.push({ resolve, reject });
          }),
      };
    }
    const snapshot = (title: string): Read => ({
      terminals: [terminal({ id: "w1", projectId: "p1", detectedAgentId: "claude", title })],
      degraded: false,
    });
    const outstanding = (directory: LocalAgentDirectory) =>
      (directory as unknown as { collecting: Map<string, unknown> }).collecting.size;
    const labels = (read: AgentDirectory) =>
      read.entries.map((entry) => (entry.state === "live" ? entry.label : null));

    it("never lets a timed-out read replace a newer snapshot of its scope", async () => {
      vi.useFakeTimers();
      try {
        let clock = 100;
        const reads = deferredReads();
        const directory = new LocalAgentDirectory(
          sources({
            now: () => clock,
            listRunningLanes: () => [],
            getLiveGeneration: () => 1,
            readTerminals: reads.readTerminals,
          }),
          20
        );

        const a = directory.read();
        await vi.advanceTimersByTimeAsync(20);
        expect(await a).toMatchObject({ coverage: "unreachable" });

        clock = 300;
        const b = directory.read();
        await vi.advanceTimersByTimeAsync(0);
        reads.calls[1]!.resolve(snapshot("new snapshot"));
        const fresh = await b;
        expect(fresh).toMatchObject({ coverage: "ok", observedAt: 300 });
        expect(labels(fresh)).toEqual(["new snapshot"]);

        // A's collection was still running and read its sources before B did.
        clock = 400;
        reads.calls[0]!.resolve(snapshot("old snapshot"));
        await vi.advanceTimersByTimeAsync(0);

        const c = directory.read();
        await vi.advanceTimersByTimeAsync(0);
        reads.calls[2]!.reject(new Error("no pty client"));
        const stale = await c;
        expect(stale).toMatchObject({ coverage: "stale", observedAt: 300, complete: false });
        expect(labels(stale)).toEqual(["new snapshot"]);
        expect(outstanding(directory)).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not bring an older snapshot back after the newer one is evicted", async () => {
      vi.useFakeTimers();
      try {
        const reads = deferredReads();
        const directory = new LocalAgentDirectory(
          sources({
            listRunningLanes: () => [],
            getLiveGeneration: () => 1,
            readTerminals: reads.readTerminals,
          }),
          20
        );

        const a = directory.read();
        expect(directory.read()).toBe(a);
        await vi.advanceTimersByTimeAsync(20);
        expect(await a).toMatchObject({ coverage: "unreachable" });

        const b = directory.read();
        await vi.advanceTimersByTimeAsync(0);
        reads.calls[1]!.resolve(snapshot("new snapshot"));
        expect(labels(await b)).toEqual(["new snapshot"]);
        expect(outstanding(directory)).toBe(1);

        for (let i = 0; i < 64; i++) {
          const other = directory.read({ projectId: `other-${i}` });
          await vi.advanceTimersByTimeAsync(0);
          reads.calls.at(-1)!.resolve(snapshot("other snapshot"));
          expect((await other).coverage).toBe("ok");
        }

        reads.calls[0]!.resolve(snapshot("old snapshot"));
        await vi.advanceTimersByTimeAsync(0);

        const c = directory.read();
        await vi.advanceTimersByTimeAsync(0);
        reads.calls.at(-1)!.reject(new Error("no pty client"));
        expect(await c).toMatchObject({ coverage: "unreachable", observedAt: null, entries: [] });
        expect(vi.getTimerCount()).toBe(0);
        expect(outstanding(directory)).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it("lets a late complete read replace a snapshot a partial read fell back to", async () => {
      vi.useFakeTimers();
      try {
        let clock = 100;
        const reads = deferredReads();
        const directory = new LocalAgentDirectory(
          sources({
            now: () => clock,
            listRunningLanes: () => [],
            getLiveGeneration: () => 1,
            readTerminals: reads.readTerminals,
          }),
          20
        );

        const first = directory.read();
        await vi.advanceTimersByTimeAsync(0);
        reads.calls[0]!.resolve(snapshot("first snapshot"));
        await first;

        clock = 200;
        const a = directory.read();
        await vi.advanceTimersByTimeAsync(20);
        expect(await a).toMatchObject({ coverage: "stale", observedAt: 100 });

        clock = 300;
        const partial = directory.read();
        await vi.advanceTimersByTimeAsync(0);
        reads.calls[2]!.resolve({ terminals: [], degraded: true });
        expect(await partial).toMatchObject({ coverage: "stale", observedAt: 100 });

        clock = 400;
        reads.calls[1]!.resolve(snapshot("late snapshot"));
        await vi.advanceTimersByTimeAsync(0);

        const c = directory.read();
        await vi.advanceTimersByTimeAsync(0);
        reads.calls[3]!.reject(new Error("no pty client"));
        const stale = await c;
        expect(stale).toMatchObject({ coverage: "stale", observedAt: 400 });
        expect(labels(stale)).toEqual(["late snapshot"]);
      } finally {
        vi.useRealTimers();
      }
    });

    it("lets a late read refresh its scope when nothing newer landed, and keeps scopes apart", async () => {
      vi.useFakeTimers();
      try {
        let clock = 100;
        const reads = deferredReads();
        const directory = new LocalAgentDirectory(
          sources({
            now: () => clock,
            listRunningLanes: () => [],
            getLiveGeneration: () => 1,
            readTerminals: reads.readTerminals,
          }),
          20
        );

        const all = directory.read();
        await vi.advanceTimersByTimeAsync(20);
        expect(await all).toMatchObject({ coverage: "unreachable" });

        // A newer read of another scope lands first; it must not order this one.
        clock = 300;
        const other = directory.read({ projectId: "p1" });
        await vi.advanceTimersByTimeAsync(0);
        reads.calls[1]!.resolve(snapshot("p1 snapshot"));
        expect(labels(await other)).toEqual(["p1 snapshot"]);

        clock = 400;
        reads.calls[0]!.resolve(snapshot("late snapshot"));
        await vi.advanceTimersByTimeAsync(0);

        const next = directory.read();
        await vi.advanceTimersByTimeAsync(0);
        reads.calls[2]!.reject(new Error("no pty client"));
        const stale = await next;
        expect(stale).toMatchObject({ coverage: "stale", observedAt: 400 });
        expect(labels(stale)).toEqual(["late snapshot"]);

        const p1 = directory.read({ projectId: "p1" });
        await vi.advanceTimersByTimeAsync(0);
        reads.calls[3]!.reject(new Error("no pty client"));
        const p1Stale = await p1;
        expect(p1Stale).toMatchObject({ coverage: "stale", observedAt: 300 });
        expect(labels(p1Stale)).toEqual(["p1 snapshot"]);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
