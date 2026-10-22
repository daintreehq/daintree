import { describe, expect, it } from "vitest";
import {
  CENSUS_MAX_AGE_MS,
  censusMemoryKb,
  evaluateGit,
  evaluateShellTerminals,
  evaluateWorkspace,
  terminalsStillVetted,
  type ProcessInventoryRead,
  type SleepGateTerminal,
} from "../idleShellSleepGates.js";
import type { WorktreeSnapshot } from "../../../shared/types/workspace-host.js";
import type { AgentProcessTreeKind } from "../../../shared/types/processes.js";

const NOW = 1_000_000_000;
const HOUR_MS = 60 * 60 * 1000;
const awakeSince = (timestamp: number) => NOW - timestamp;

function terminal(id: string, overrides: Partial<SleepGateTerminal> = {}): SleepGateTerminal {
  return {
    id,
    projectId: "p",
    kind: "terminal",
    cwd: "/p",
    hasPty: true,
    spawnedAt: NOW - 3 * HOUR_MS,
    lastInputTime: NOW - 3 * HOUR_MS,
    lastOutputTime: NOW - 3 * HOUR_MS,
    ...overrides,
  } as SleepGateTerminal;
}

/** A launched Claude at rest: waiting at its prompt, nothing typed or queued, nothing shown since. */
function agent(id: string, overrides: Partial<SleepGateTerminal> = {}): SleepGateTerminal {
  return terminal(id, {
    launchAgentId: "claude",
    detectedAgentId: "claude",
    everDetectedAgent: true,
    agentSessionId: "session-1",
    agentIncarnation: 0,
    agentState: "waiting",
    waitingReason: "prompt",
    lastStateChange: NOW - 2 * HOUR_MS,
    lastTypedInputAt: NOW - 3 * HOUR_MS,
    lastOutputChangeAt: NOW - 2 * HOUR_MS,
    hasPendingSubmission: false,
    outputObservedSince: NOW - 3 * HOUR_MS,
    ...overrides,
  });
}

function inventory(
  entries: Array<{
    id: string;
    projectId?: string;
    comm?: string;
    processCount?: number;
    agentTree?: AgentProcessTreeKind;
  }>,
  overrides: { available?: boolean; sampledAt?: number; shardsFailed?: number } = {}
): ProcessInventoryRead {
  return {
    shardsFailed: overrides.shardsFailed ?? 0,
    inventories: [
      {
        terminals: entries.map((entry, index) => ({
          id: entry.id,
          projectId: entry.projectId ?? "p",
          cwd: "/p",
          isAssistantTerminal: false,
          spawnedAt: 0,
          isTrashed: false,
          rootPid: 100 + index,
          sample: {
            cpuPercent: 0,
            memoryKb: 1,
            processCount: entry.processCount ?? 1,
            members: [{ pid: 100 + index, comm: entry.comm ?? "zsh", cpuPercent: 0, memoryKb: 1 }],
          },
          ...(entry.agentTree ? { agentTree: entry.agentTree } : {}),
        })),
        pidSamples: {},
        available: overrides.available ?? true,
        sampledAt: overrides.sampledAt ?? NOW,
      },
    ],
  };
}

function evaluate(terminals: SleepGateTerminal[], census: ProcessInventoryRead | null) {
  return evaluateShellTerminals("p", terminals, census, NOW, HOUR_MS, awakeSince);
}

/** The ids a passing result vouched for, or the refusal itself. */
function vouched(result: ReturnType<typeof evaluate>) {
  return result.ok ? [...result.value.keys()] : result;
}

describe("evaluateShellTerminals", () => {
  it("vouches for idle plain shells and returns their ids", () => {
    const result = evaluate([terminal("a"), terminal("b")], inventory([{ id: "a" }, { id: "b" }]));
    expect(vouched(result)).toEqual(["a", "b"]);
  });

  it("doesn't hold the project to a shard that carries none of its terminals", () => {
    const census = inventory([{ id: "a" }]);
    census.inventories.push({
      terminals: [],
      pidSamples: {},
      available: false,
      sampledAt: 0,
    });
    expect(vouched(evaluate([terminal("a")], census))).toEqual(["a"]);
  });

  it("ignores other projects' terminals and exited records", () => {
    const result = evaluate(
      [terminal("a"), terminal("x", { projectId: "other" }), terminal("dead", { hasPty: false })],
      inventory([{ id: "a" }, { id: "x", projectId: "other", processCount: 4 }])
    );
    expect(vouched(result)).toEqual(["a"]);
  });

  it.each([
    ["no census", null, "census-unavailable"],
    ["a failed shard", inventory([{ id: "a" }], { shardsFailed: 1 }), "census-unavailable"],
    ["a failing census", inventory([{ id: "a" }], { available: false }), "census-unavailable"],
    ["no census yet", inventory([{ id: "a" }], { sampledAt: 0 }), "census-stale"],
    [
      "an old census",
      inventory([{ id: "a" }], { sampledAt: NOW - CENSUS_MAX_AGE_MS - 1 }),
      "census-stale",
    ],
    ["a child process", inventory([{ id: "a", processCount: 2 }]), "terminal-busy"],
    ["a non-shell root", inventory([{ id: "a", comm: "python3" }]), "terminal-busy"],
    ["a terminal the census missed", inventory([]), "terminal-unknown"],
    ["a terminal the registry missed", inventory([{ id: "a" }, { id: "b" }]), "terminal-unknown"],
  ])("blocks on %s", (_case, census, reason) => {
    expect(evaluate([terminal("a")], census)).toEqual({ ok: false, reason });
  });

  it.each([
    [
      "an agent launched but not yet detected",
      { launchAgentId: "claude" },
      "agent-resume-unproven",
    ],
    ["an agent typed into a shell", { detectedAgentId: "codex" }, "agent-resume-unproven"],
    ["an agent that has since exited", { everDetectedAgent: true }, "agent-resume-unproven"],
    ["the assistant", { isAssistantTerminal: true }, "agent-terminal"],
    ["a dev preview", { kind: "dev-preview" }, "agent-terminal"],
    ["missing input time", { lastInputTime: undefined }, "terminal-unknown"],
    ["recent input", { lastInputTime: NOW - 60_000 }, "terminal-activity"],
    ["recent output", { lastOutputTime: NOW - 60_000 }, "terminal-activity"],
    ["a fresh spawn", { spawnedAt: NOW - 60_000 }, "terminal-activity"],
    ["a timestamp from the future", { lastOutputTime: NOW + 60_000 }, "terminal-activity"],
  ])("blocks on %s", (_case, overrides, reason) => {
    expect(
      evaluate([terminal("a", overrides as Partial<SleepGateTerminal>)], inventory([{ id: "a" }]))
    ).toEqual({
      ok: false,
      reason,
    });
  });
});

describe("evaluateShellTerminals with agents (#13854)", () => {
  const atRest = (id = "c") =>
    inventory([{ id, processCount: 4, agentTree: "runtime-and-servers" }]);

  it("vouches for an agent at rest whose tree holds only its runtime and servers", () => {
    expect(vouched(evaluate([agent("c")], atRest()))).toEqual(["c"]);
  });

  it("reads spinner and status redraws as quiet: only a visible change counts", () => {
    expect(vouched(evaluate([agent("c", { lastOutputTime: NOW - 1_000 })], atRest()))).toEqual([
      "c",
    ]);
  });

  it("vouches for a project of shells and resting agents together", () => {
    const census = inventory([
      { id: "s" },
      { id: "c", processCount: 2, agentTree: "runtime-and-servers" },
    ]);
    expect(vouched(evaluate([terminal("s"), agent("c")], census))).toEqual(["s", "c"]);
  });

  it("holds the project when any one agent is not at rest", () => {
    const census = inventory([
      { id: "c", agentTree: "runtime-and-servers" },
      { id: "d", agentTree: "runtime-and-servers" },
    ]);
    expect(evaluate([agent("c"), agent("d", { agentState: "working" })], census)).toEqual({
      ok: false,
      reason: "agent-not-at-prompt",
    });
  });

  it.each<[string, Partial<SleepGateTerminal>, string]>([
    ["an agent the registry didn't launch", { launchAgentId: undefined }, "agent-resume-unproven"],
    ["the boot window before detection", { detectedAgentId: undefined }, "agent-resume-unproven"],
    ["another agent detected in the pane", { detectedAgentId: "codex" }, "agent-resume-unproven"],
    ["a turn in progress", { agentState: "working" }, "agent-not-at-prompt"],
    ["an approval prompt", { waitingReason: "approval" }, "agent-not-at-prompt"],
    ["a question", { waitingReason: "question" }, "agent-not-at-prompt"],
    ["an error", { waitingReason: "error" }, "agent-not-at-prompt"],
    ["no waiting reason", { waitingReason: undefined }, "agent-not-at-prompt"],
    ["an idle agent before its first turn", { agentState: "idle" }, "agent-not-at-prompt"],
    ["a completed turn not yet settled", { agentState: "completed" }, "agent-not-at-prompt"],
    ["no settle time", { lastStateChange: undefined }, "agent-not-at-prompt"],
    [
      "an old draft typed after it settled",
      { lastStateChange: NOW - 3 * HOUR_MS, lastTypedInputAt: NOW - 2 * HOUR_MS },
      "agent-input-pending",
    ],
    ["a queued submission", { hasPendingSubmission: true }, "agent-input-pending"],
    ["a host that can't say", { hasPendingSubmission: undefined }, "agent-input-pending"],
    ["recent automated input", { lastInputTime: NOW - 60_000 }, "terminal-activity"],
    [
      "recent typing",
      { lastTypedInputAt: NOW - 60_000, lastStateChange: NOW - 30_000 },
      "terminal-activity",
    ],
    ["a recent visible change", { lastOutputChangeAt: NOW - 60_000 }, "terminal-activity"],
    ["a fresh spawn", { spawnedAt: NOW - 60_000 }, "terminal-activity"],
    ["no visible-change reading", { lastOutputChangeAt: undefined }, "terminal-unknown"],
    ["no mirror reading it", { outputObservedSince: undefined }, "terminal-unknown"],
    [
      "output lost to its mirror inside the threshold",
      { outputObservedSince: NOW - 60_000 },
      "terminal-activity",
    ],
    ["missing input time", { lastInputTime: undefined }, "terminal-unknown"],
  ])("blocks on %s", (_case, overrides, reason) => {
    expect(evaluate([agent("c", overrides)], atRest())).toEqual({ ok: false, reason });
  });

  it.each<[string, ProcessInventoryRead, string]>([
    ["a shell under the agent", inventory([{ id: "c", agentTree: "other" }]), "terminal-busy"],
    [
      "a tree the host couldn't read",
      inventory([{ id: "c", agentTree: "unknown" }]),
      "terminal-unknown",
    ],
    ["a host that doesn't classify", inventory([{ id: "c", processCount: 2 }]), "terminal-unknown"],
    ["an agent the census missed", inventory([]), "terminal-unknown"],
  ])("blocks on %s", (_case, census, reason) => {
    expect(evaluate([agent("c")], census)).toEqual({ ok: false, reason });
  });
});

describe("terminalsStillVetted", () => {
  const vetted = new Map([["a", terminal("a")]]);
  const check = (terminals: SleepGateTerminal[]) =>
    terminalsStillVetted("p", terminals, vetted, NOW, HOUR_MS, awakeSince);

  it("passes the vetted, still-quiet set", () => {
    expect(check([terminal("a"), terminal("x", { projectId: "other" })])).toBe(true);
  });

  it("refuses a terminal it did not vet", () => {
    expect(check([terminal("a"), terminal("b")])).toBe(false);
  });

  it("refuses a vetted terminal touched since", () => {
    expect(check([terminal("a", { lastInputTime: NOW - 1_000 })])).toBe(false);
  });

  it("refuses a vetted shell that has an agent in it now", () => {
    expect(check([terminal("a", { detectedAgentId: "claude", everDetectedAgent: true })])).toBe(
      false
    );
  });

  describe("an agent (#13854)", () => {
    const vettedAgent = new Map([["c", agent("c")]]);
    const checkAgent = (now: SleepGateTerminal) =>
      terminalsStillVetted("p", [now], vettedAgent, NOW, HOUR_MS, awakeSince);

    it("passes the same session still at rest", () => {
      expect(checkAgent(agent("c", { lastOutputTime: NOW - 1_000 }))).toBe(true);
    });

    it.each<[string, Partial<SleepGateTerminal>]>([
      ["a new session id", { agentSessionId: "session-2" }],
      ["a relaunch observed in the PTY", { agentIncarnation: 1 }],
      ["the agent gone from detection", { detectedAgentId: undefined }],
      ["a turn begun", { agentState: "working", lastStateChange: NOW - 1_000 }],
      ["a submission queued", { hasPendingSubmission: true }],
      ["typing since the screen", { lastTypedInputAt: NOW - 1_000, lastInputTime: NOW - 1_000 }],
      [
        "a draft left since it settled, however old",
        { lastStateChange: NOW - 3 * HOUR_MS, lastTypedInputAt: NOW - 2 * HOUR_MS },
      ],
      ["its mirror detached since the screen", { outputObservedSince: undefined }],
      ["output lost to its mirror since the screen", { outputObservedSince: NOW - 1_000 }],
      ["a visible change since the screen", { lastOutputChangeAt: NOW - 1_000 }],
    ])("refuses %s", (_case, overrides) => {
      expect(checkAgent(agent("c", overrides))).toBe(false);
    });
  });
});

describe("censusMemoryKb", () => {
  function shard(
    entries: Array<{ id: string; projectId?: string; memoryKb: number | null }>
  ): ProcessInventoryRead["inventories"][number] {
    return {
      terminals: entries.map((entry, index) => ({
        id: entry.id,
        projectId: entry.projectId ?? "p",
        cwd: "/p",
        isAssistantTerminal: false,
        spawnedAt: 0,
        isTrashed: false,
        rootPid: 100 + index,
        sample:
          entry.memoryKb === null
            ? null
            : {
                cpuPercent: 0,
                memoryKb: entry.memoryKb,
                processCount: 3,
                // Capped by the host: the tree total is what counts.
                members: [{ pid: 100 + index, comm: "zsh", cpuPercent: 0, memoryKb: 1 }],
              },
      })),
      pidSamples: { 999: { cpuPercent: 0, memoryKb: 50_000, processCount: 1, members: [] } },
      available: true,
      sampledAt: NOW,
    };
  }

  it("sums the whole tree of every named terminal in the project", () => {
    const census = {
      shardsFailed: 0,
      inventories: [shard([{ id: "a", memoryKb: 4096 }]), shard([{ id: "b", memoryKb: 2048 }])],
    };
    expect(censusMemoryKb(census, "p", new Set(["a", "b"]))).toBe(6144);
  });

  it("leaves out other projects, unnamed terminals and stray pid samples", () => {
    const census = {
      shardsFailed: 0,
      inventories: [
        shard([
          { id: "a", memoryKb: 4096 },
          { id: "other", memoryKb: 8192 },
          { id: "x", projectId: "q", memoryKb: 16_384 },
        ]),
      ],
    };
    expect(censusMemoryKb(census, "p", new Set(["a", "x"]))).toBe(4096);
  });

  it("counts a terminal two shards both list once", () => {
    const census = {
      shardsFailed: 0,
      inventories: [shard([{ id: "a", memoryKb: 4096 }]), shard([{ id: "a", memoryKb: 4096 }])],
    };
    expect(censusMemoryKb(census, "p", new Set(["a"]))).toBe(4096);
  });

  it("adds nothing for a terminal without a reading", () => {
    const census = {
      shardsFailed: 0,
      inventories: [
        shard([
          { id: "a", memoryKb: 4096 },
          { id: "b", memoryKb: null },
        ]),
      ],
    };
    expect(censusMemoryKb(census, "p", new Set(["a", "b"]))).toBe(4096);
    expect(censusMemoryKb(null, "p", new Set(["a"]))).toBe(0);
  });
});

describe("evaluateWorkspace", () => {
  const worktree = (overrides: Partial<WorktreeSnapshot> = {}) =>
    ({ path: "/p", ...overrides }) as WorktreeSnapshot;

  it("returns every worktree path to probe", () => {
    expect(
      evaluateWorkspace({ states: [worktree(), worktree({ path: "/p-feature" })], gitBacked: true })
    ).toEqual({ ok: true, value: ["/p", "/p-feature"] });
  });

  it("has nothing to probe in a folder that isn't a repository", () => {
    expect(evaluateWorkspace({ states: [], gitBacked: false })).toEqual({ ok: true, value: [] });
  });

  it.each([
    ["no read", null, "workspace-unknown"],
    ["an unprobed host", { states: [], gitBacked: null }, "workspace-unknown"],
    ["a repository with no worktrees listed", { states: [], gitBacked: true }, "workspace-unknown"],
    [
      "a resource config",
      { states: [worktree({ hasResourceConfig: true })], gitBacked: true },
      "resource-configured",
    ],
    [
      "a remembered resource status",
      { states: [worktree({ resourceStatus: { lastStatus: "paused" } })], gitBacked: true },
      "resource-configured",
    ],
    [
      "a running lifecycle phase",
      {
        states: [worktree({ lifecycleStatus: { phase: "setup", state: "running", startedAt: 0 } })],
        gitBacked: true,
      },
      "lifecycle-busy",
    ],
    [
      "a setup still pending",
      { states: [worktree({ setupStatus: { state: "pending", startedAt: 0 } })], gitBacked: true },
      "lifecycle-busy",
    ],
  ])("blocks on %s", (_case, read, reason) => {
    expect(evaluateWorkspace(read as Parameters<typeof evaluateWorkspace>[0])).toEqual({
      ok: false,
      reason,
    });
  });
});

describe("evaluateGit", () => {
  it("passes only a clear probe", () => {
    expect(evaluateGit({ state: "clear" })).toBeNull();
    expect(evaluateGit({ state: "busy", marker: "MERGE_HEAD" })).toBe("git-busy");
    expect(evaluateGit({ state: "unknown", reason: "timeout" })).toBe("git-unknown");
  });
});
