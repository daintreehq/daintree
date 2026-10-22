import { describe, expect, it } from "vitest";
import {
  CENSUS_MAX_AGE_MS,
  evaluateGit,
  evaluateShellTerminals,
  evaluateWorkspace,
  isPlainShellName,
  terminalsStillVetted,
  type ProcessInventoryRead,
  type SleepGateTerminal,
} from "../idleShellSleepGates.js";
import type { WorktreeSnapshot } from "../../../shared/types/workspace-host.js";

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

function inventory(
  entries: Array<{ id: string; projectId?: string; comm?: string; processCount?: number }>,
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

describe("isPlainShellName", () => {
  it.each(["zsh", "-zsh", "/bin/bash", "fish", "pwsh.exe", "C:\\Windows\\System32\\cmd.exe"])(
    "accepts %s",
    (comm) => expect(isPlainShellName(comm)).toBe(true)
  );

  it.each(["node", "python3", "ssh", "sudo", "nohup", ""])("rejects %s", (comm) =>
    expect(isPlainShellName(comm)).toBe(false)
  );
});

describe("evaluateShellTerminals", () => {
  it("vouches for idle plain shells and returns their ids", () => {
    const result = evaluate([terminal("a"), terminal("b")], inventory([{ id: "a" }, { id: "b" }]));
    expect(result).toEqual({ ok: true, value: new Set(["a", "b"]) });
  });

  it("ignores other projects' terminals and exited records", () => {
    const result = evaluate(
      [terminal("a"), terminal("x", { projectId: "other" }), terminal("dead", { hasPty: false })],
      inventory([{ id: "a" }, { id: "x", projectId: "other", processCount: 4 }])
    );
    expect(result).toEqual({ ok: true, value: new Set(["a"]) });
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
    ["a launched agent", { launchAgentId: "claude" }, "agent-terminal"],
    ["a detected agent", { detectedAgentId: "codex" }, "agent-terminal"],
    ["an agent that has since exited", { everDetectedAgent: true }, "agent-terminal"],
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

describe("terminalsStillVetted", () => {
  const vetted = new Set(["a"]);
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
  it("passes only when every probe is clear", () => {
    expect(evaluateGit([{ state: "clear" }, { state: "clear" }])).toBeNull();
    expect(evaluateGit([])).toBeNull();
  });

  it("names a busy worktree ahead of an unreadable one", () => {
    expect(
      evaluateGit([
        { state: "unknown", reason: "EACCES" },
        { state: "busy", marker: "MERGE_HEAD" },
      ])
    ).toBe("git-busy");
    expect(evaluateGit([{ state: "clear" }, { state: "unknown", reason: "timeout" }])).toBe(
      "git-unknown"
    );
  });
});
