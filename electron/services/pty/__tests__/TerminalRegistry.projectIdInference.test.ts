import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TerminalRegistry, resolveTrashTtlMs } from "../TerminalRegistry.js";
import {
  MAX_PRESERVED_TERMINAL_SNAPSHOTS,
  PRESERVED_SNAPSHOT_RECENT_ACCESS_GUARD_MS,
  TRASH_TTL_MS,
  type TerminalInfo,
} from "../types.js";
import type { TerminalProcess } from "../TerminalProcess.js";

function hashProjectId(projectRootPath: string): string {
  const canonical = path.normalize(fs.realpathSync(projectRootPath));
  return createHash("sha256").update(canonical).digest("hex");
}

function createMockTerminalProcess(options: {
  id: string;
  cwd: string;
  projectId?: string;
  worktreeId?: string;
}): TerminalProcess {
  const info = {
    id: options.id,
    projectId: options.projectId,
    cwd: options.cwd,
    shell: "/bin/sh",
    kind: "terminal",
    type: "terminal",
    spawnedAt: Date.now(),
    analysisEnabled: false,
    lastInputTime: Date.now(),
    lastOutputTime: Date.now(),
    lastCheckTime: Date.now(),
    restartCount: 0,
    worktreeId: options.worktreeId,
    outputBuffer: "",
    semanticBuffer: [],
    ptyProcess: { pid: 12345 },
  };

  return {
    getInfo: () => info,
    getPtyProcess: () => info.ptyProcess,
  } as unknown as TerminalProcess;
}

describe("TerminalRegistry projectId inference", () => {
  it("counts terminals without projectId using .git directory root hashing", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "daintree-terminal-registry-"));
    try {
      fs.mkdirSync(path.join(root, ".git"));
      const subdir = path.join(root, "subdir");
      fs.mkdirSync(subdir);

      const projectId = hashProjectId(root);
      const registry = new TerminalRegistry();
      registry.add(
        "t1",
        createMockTerminalProcess({
          id: "t1",
          cwd: subdir,
        })
      );

      const stats = registry.getProjectStats(projectId);
      expect(stats.terminalCount).toBe(1);
      expect(registry.getForProject(projectId)).toEqual(["t1"]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("infers main projectId for linked worktrees via commondir", () => {
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "daintree-terminal-registry-wt-"));
    try {
      const mainRoot = path.join(sandbox, "main");
      const commonGitDir = path.join(mainRoot, ".git");
      fs.mkdirSync(path.join(commonGitDir, "worktrees", "wt1"), { recursive: true });

      const worktreeRoot = path.join(sandbox, "worktree-wt1");
      fs.mkdirSync(worktreeRoot, { recursive: true });

      const gitDir = path.join(commonGitDir, "worktrees", "wt1");
      fs.writeFileSync(path.join(worktreeRoot, ".git"), `gitdir: ${gitDir}\n`, "utf8");
      fs.writeFileSync(path.join(gitDir, "commondir"), "../..", "utf8");

      const projectId = hashProjectId(mainRoot);

      const registry = new TerminalRegistry();
      registry.add(
        "t2",
        createMockTerminalProcess({
          id: "t2",
          cwd: path.join(worktreeRoot, "nested"),
          worktreeId: worktreeRoot,
        })
      );

      const stats = registry.getProjectStats(projectId);
      expect(stats.terminalCount).toBe(1);
      expect(registry.getForProject(projectId)).toEqual(["t2"]);
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it("excludes trashed terminals from getForProject and getProjectStats", () => {
    const registry = new TerminalRegistry(120000);
    const projectId = "project-123";

    const activeTerminal = createMockTerminalProcess({
      id: "t-active",
      cwd: "/tmp",
      projectId,
    });

    const trashedTerminal = createMockTerminalProcess({
      id: "t-trashed",
      cwd: "/tmp",
      projectId,
    });

    registry.add("t-active", activeTerminal);
    registry.add("t-trashed", trashedTerminal);

    registry.trash("t-trashed", () => {});

    const terminals = registry.getForProject(projectId);
    expect(terminals).toEqual(["t-active"]);
    expect(terminals).not.toContain("t-trashed");

    const stats = registry.getProjectStats(projectId);
    expect(stats.terminalCount).toBe(1);
    expect(stats.processIds).toEqual([12345]);
  });

  it("includes terminals in getForProject after restore from trash", () => {
    const registry = new TerminalRegistry(120000);
    const projectId = "project-123";

    const terminal = createMockTerminalProcess({
      id: "t-1",
      cwd: "/tmp",
      projectId,
    });

    registry.add("t-1", terminal);
    registry.trash("t-1", () => {});

    expect(registry.getForProject(projectId)).toEqual([]);

    registry.restore("t-1");

    expect(registry.getForProject(projectId)).toEqual(["t-1"]);

    const stats = registry.getProjectStats(projectId);
    expect(stats.terminalCount).toBe(1);
    expect(stats.processIds).toEqual([12345]);
    expect(stats.terminalTypes).toEqual({ terminal: 1 });
  });

  it("does not leak terminals across projects after repeated getForProject calls", () => {
    const registry = new TerminalRegistry();
    const projectA = "project-aaa";
    const projectB = "project-bbb";

    const terminalA = createMockTerminalProcess({
      id: "t-a",
      cwd: "/tmp",
      projectId: projectA,
    });

    const terminalNoProject = createMockTerminalProcess({
      id: "t-no-project",
      cwd: "/tmp/random-" + Date.now(),
    });

    registry.add("t-a", terminalA);
    registry.add("t-no-project", terminalNoProject);

    // Query for project A — should only find t-a
    expect(registry.getForProject(projectA)).toEqual(["t-a"]);

    // Query for project B — should find nothing (t-no-project must NOT leak here)
    expect(registry.getForProject(projectB)).toEqual([]);

    // Query project A again — still only t-a
    expect(registry.getForProject(projectA)).toEqual(["t-a"]);

    // t-no-project should not have been assigned to any project
    const info = terminalNoProject.getInfo();
    expect(info.projectId).toBeUndefined();
  });

  it("clears trash timeout when terminal is deleted", () => {
    const registry = new TerminalRegistry(120000);
    const projectId = "project-123";
    let killedId: string | null = null;

    const terminal = createMockTerminalProcess({
      id: "t-1",
      cwd: "/tmp",
      projectId,
    });

    registry.add("t-1", terminal);
    registry.trash("t-1", (id) => {
      killedId = id;
    });

    expect(registry.isInTrash("t-1")).toBe(true);

    registry.delete("t-1");

    expect(registry.isInTrash("t-1")).toBe(false);
    expect(killedId).toBe(null);
  });

  it("calls unref on trash timeout so the TTL never pins the event loop", () => {
    const registry = new TerminalRegistry(120000);
    const terminal = createMockTerminalProcess({
      id: "t-1",
      cwd: "/tmp",
      projectId: "project-1",
    });
    registry.add("t-1", terminal);

    const original = global.setTimeout;
    const unrefSpies: ReturnType<typeof vi.fn>[] = [];
    const trackedTimers: NodeJS.Timeout[] = [];
    const wrapped = ((handler: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
      const timer = original(handler, ms, ...args);
      trackedTimers.push(timer);
      const originalUnref = timer.unref.bind(timer);
      const unrefSpy = vi.fn(() => originalUnref());
      (timer as unknown as { unref: () => NodeJS.Timeout }).unref = unrefSpy;
      unrefSpies.push(unrefSpy);
      return timer;
    }) as typeof setTimeout;
    Object.assign(wrapped, original);
    global.setTimeout = wrapped;

    try {
      registry.trash("t-1", () => {});
      expect(unrefSpies).toHaveLength(1);
      expect(unrefSpies[0]).toHaveBeenCalledTimes(1);
    } finally {
      global.setTimeout = original;
      for (const t of trackedTimers) clearTimeout(t);
    }
  });
});

const NOW = 1_000_000_000_000;

function createPreservedTerminal(options: {
  id: string;
  preservedAt?: number;
  lastAccessedAt?: number;
  preserved?: boolean;
}): TerminalProcess {
  const info = {
    id: options.id,
    preservedSnapshot:
      options.preserved === false
        ? undefined
        : { data: `snapshot-${options.id}`, cols: 80, rows: 24 },
    preservedAt: options.preservedAt,
    preservedSnapshotLastAccessedAt: options.lastAccessedAt,
  } as unknown as TerminalInfo;

  return {
    getInfo: () => info,
  } as unknown as TerminalProcess;
}

describe("TerminalRegistry.evictPreservedSnapshots", () => {
  it("evicts nothing when the count is at or below the cap", () => {
    const registry = new TerminalRegistry();
    for (let i = 0; i < 3; i++) {
      registry.add(`t${i}`, createPreservedTerminal({ id: `t${i}`, preservedAt: NOW + i }));
    }

    registry.evictPreservedSnapshots(3, undefined, NOW + 1000);

    expect(registry.size()).toBe(3);
  });

  it("evicts the oldest snapshot when one over the cap", () => {
    const registry = new TerminalRegistry();
    registry.add("old", createPreservedTerminal({ id: "old", preservedAt: NOW - 100 }));
    registry.add("mid", createPreservedTerminal({ id: "mid", preservedAt: NOW - 50 }));
    registry.add("new", createPreservedTerminal({ id: "new", preservedAt: NOW }));

    registry.evictPreservedSnapshots(2, undefined, NOW + 1_000_000);

    expect(registry.has("old")).toBe(false);
    expect(registry.has("mid")).toBe(true);
    expect(registry.has("new")).toBe(true);
  });

  it("enforces the default cap, evicting exactly the oldest overflow", () => {
    const registry = new TerminalRegistry();
    // One over the production cap; the oldest must be the single eviction.
    for (let i = 0; i <= MAX_PRESERVED_TERMINAL_SNAPSHOTS; i++) {
      registry.add(`t${i}`, createPreservedTerminal({ id: `t${i}`, preservedAt: NOW + i }));
    }

    registry.evictPreservedSnapshots(undefined, undefined, NOW + 10_000_000);

    expect(registry.size()).toBe(MAX_PRESERVED_TERMINAL_SNAPSHOTS);
    expect(registry.has("t0")).toBe(false); // oldest
    expect(registry.has(`t${MAX_PRESERVED_TERMINAL_SNAPSHOTS}`)).toBe(true); // newest
  });

  it("never evicts skipId even if it is the oldest, evicting the next candidate instead", () => {
    const registry = new TerminalRegistry();
    registry.add("oldSkip", createPreservedTerminal({ id: "oldSkip", preservedAt: NOW - 100 }));
    registry.add("a", createPreservedTerminal({ id: "a", preservedAt: NOW - 50 }));
    registry.add("b", createPreservedTerminal({ id: "b", preservedAt: NOW }));

    registry.evictPreservedSnapshots(2, "oldSkip", NOW + 1_000_000);

    expect(registry.has("oldSkip")).toBe(true);
    expect(registry.has("a")).toBe(false); // next-oldest non-skipped
    expect(registry.has("b")).toBe(true);
  });

  it("skips a recently-accessed snapshot and evicts the next-oldest evictable one", () => {
    const registry = new TerminalRegistry();
    // Oldest by preservedAt, but accessed within the guard window → kept.
    registry.add(
      "viewed",
      createPreservedTerminal({ id: "viewed", preservedAt: NOW - 1000, lastAccessedAt: NOW })
    );
    registry.add("a", createPreservedTerminal({ id: "a", preservedAt: NOW - 500 }));
    registry.add("b", createPreservedTerminal({ id: "b", preservedAt: NOW - 200 }));

    // Cap of 2 over 3 entries → evict 1. "viewed" is guarded, so "a" goes.
    registry.evictPreservedSnapshots(2, undefined, NOW);

    expect(registry.has("viewed")).toBe(true);
    expect(registry.has("a")).toBe(false);
    expect(registry.has("b")).toBe(true);
  });

  it("treats a snapshot accessed just outside the guard window as evictable", () => {
    const registry = new TerminalRegistry();
    registry.add(
      "stale",
      createPreservedTerminal({
        id: "stale",
        preservedAt: NOW - 1000,
        lastAccessedAt: NOW - PRESERVED_SNAPSHOT_RECENT_ACCESS_GUARD_MS - 1,
      })
    );
    registry.add("a", createPreservedTerminal({ id: "a", preservedAt: NOW }));

    registry.evictPreservedSnapshots(1, undefined, NOW);

    expect(registry.has("stale")).toBe(false);
    expect(registry.has("a")).toBe(true);
  });

  it("ignores terminals without a preserved snapshot", () => {
    const registry = new TerminalRegistry();
    registry.add("live1", createPreservedTerminal({ id: "live1", preserved: false }));
    registry.add("live2", createPreservedTerminal({ id: "live2", preserved: false }));
    registry.add("p1", createPreservedTerminal({ id: "p1", preservedAt: NOW - 100 }));
    registry.add("p2", createPreservedTerminal({ id: "p2", preservedAt: NOW }));

    // Cap of 1 over 2 preserved entries → evict the oldest preserved only; live
    // terminals are never counted or touched.
    registry.evictPreservedSnapshots(1, undefined, NOW + 1_000_000);

    expect(registry.has("p1")).toBe(false);
    expect(registry.has("p2")).toBe(true);
    expect(registry.has("live1")).toBe(true);
    expect(registry.has("live2")).toBe(true);
  });

  it("tolerates over-cap when every entry is being actively viewed", () => {
    const registry = new TerminalRegistry();
    // All entries are within the access guard, so none is a valid eviction
    // target — the cap yields to not dropping a snapshot the user is viewing.
    registry.add(
      "g1",
      createPreservedTerminal({ id: "g1", preservedAt: NOW - 100, lastAccessedAt: NOW })
    );
    registry.add(
      "g2",
      createPreservedTerminal({ id: "g2", preservedAt: NOW - 50, lastAccessedAt: NOW })
    );
    registry.add(
      "g3",
      createPreservedTerminal({ id: "g3", preservedAt: NOW, lastAccessedAt: NOW })
    );

    registry.evictPreservedSnapshots(1, undefined, NOW);

    expect(registry.size()).toBe(3);
  });

  it("evicts an unviewed newest entry rather than a viewed older one", () => {
    const registry = new TerminalRegistry();
    // Older entries are actively viewed; the newest has never been served.
    registry.add(
      "viewedOld",
      createPreservedTerminal({ id: "viewedOld", preservedAt: NOW - 100, lastAccessedAt: NOW })
    );
    registry.add(
      "viewedMid",
      createPreservedTerminal({ id: "viewedMid", preservedAt: NOW - 50, lastAccessedAt: NOW })
    );
    registry.add(
      "freshUnviewed",
      createPreservedTerminal({ id: "freshUnviewed", preservedAt: NOW })
    );

    // Cap 2 over 3 → evict 1. The viewed entries are guarded, so the unviewed
    // newest is the only valid target.
    registry.evictPreservedSnapshots(2, undefined, NOW);

    expect(registry.has("freshUnviewed")).toBe(false);
    expect(registry.has("viewedOld")).toBe(true);
    expect(registry.has("viewedMid")).toBe(true);
  });

  it("sorts a snapshot with no preservedAt as oldest", () => {
    const registry = new TerminalRegistry();
    registry.add("noTimestamp", createPreservedTerminal({ id: "noTimestamp" }));
    registry.add("a", createPreservedTerminal({ id: "a", preservedAt: NOW - 100 }));

    registry.evictPreservedSnapshots(1, undefined, NOW + 1_000_000);

    expect(registry.has("noTimestamp")).toBe(false);
    expect(registry.has("a")).toBe(true);
  });

  it("evicts all unguarded entries when called with max 0", () => {
    const registry = new TerminalRegistry();
    registry.add("a", createPreservedTerminal({ id: "a", preservedAt: NOW - 100 }));
    registry.add(
      "viewed",
      createPreservedTerminal({ id: "viewed", preservedAt: NOW - 50, lastAccessedAt: NOW })
    );
    registry.add("b", createPreservedTerminal({ id: "b", preservedAt: NOW }));

    registry.evictPreservedSnapshots(0, undefined, NOW);

    expect(registry.has("a")).toBe(false);
    expect(registry.has("b")).toBe(false);
    expect(registry.has("viewed")).toBe(true); // guarded survives even at max 0
  });
});

function stubE2E(ttl: string | undefined, { packaged = "0", mode = "1" } = {}) {
  vi.stubEnv("DAINTREE_E2E_MODE", mode);
  vi.stubEnv("DAINTREE_IS_PACKAGED", packaged);
  vi.stubEnv("DAINTREE_E2E_TRASH_TTL_MS", ttl);
}

describe("resolveTrashTtlMs", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns the product TTL without an override", () => {
    stubE2E(undefined);
    expect(resolveTrashTtlMs()).toBe(TRASH_TTL_MS);
  });

  it("honours the override in an unpackaged E2E launch", () => {
    stubE2E("3000");
    expect(resolveTrashTtlMs()).toBe(3000);
  });

  it.each([
    ["outside E2E mode", { mode: "" }],
    ["in a packaged build", { packaged: "1" }],
  ])("ignores the override %s", (_label, gate) => {
    stubE2E("3000", gate);
    expect(resolveTrashTtlMs()).toBe(TRASH_TTL_MS);
  });

  it("ignores a malformed override", () => {
    stubE2E("soon");
    expect(resolveTrashTtlMs()).toBe(TRASH_TTL_MS);
  });
});

describe("TerminalRegistry trash TTL override", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  function trashOne(registry: TerminalRegistry): ReturnType<typeof vi.fn> {
    registry.add("t1", {} as unknown as TerminalProcess);
    const onExpire = vi.fn();
    registry.trash("t1", onExpire);
    return onExpire;
  }

  it("kills a trashed terminal at the overridden TTL when constructed with defaults", () => {
    stubE2E("3000");
    const registry = new TerminalRegistry();
    const onExpire = trashOne(registry);

    vi.advanceTimersByTime(2_999);
    expect(onExpire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onExpire).toHaveBeenCalledWith("t1");
  });

  it("keeps the product TTL without the E2E gate", () => {
    stubE2E("3000", { mode: "" });
    const registry = new TerminalRegistry();
    const onExpire = trashOne(registry);

    vi.advanceTimersByTime(3_000);
    expect(onExpire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(TRASH_TTL_MS - 3_000);
    expect(onExpire).toHaveBeenCalledWith("t1");
  });
});
