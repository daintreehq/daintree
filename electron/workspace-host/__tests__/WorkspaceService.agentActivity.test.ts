import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "events";
import { resolve as pathResolve } from "path";
import type { WorkspaceService } from "../WorkspaceService.js";
import type { WorktreeMonitor } from "../WorktreeMonitor.js";
import type { Worktree } from "../../../shared/types/worktree.js";

// Records each GitFileWatcher construction so tests can assert which tier
// (recursive vs git-only) the controller armed after an agent-activity flip.
const watcherArms: Array<{ watchWorktree: boolean }> = [];

vi.mock("../../utils/gitFileWatcher.js", () => ({
  GitFileWatcher: class {
    constructor(opts: { watchWorktree?: boolean } & Record<string, unknown>) {
      watcherArms.push({ watchWorktree: opts.watchWorktree === true });
    }
    start() {
      return Promise.resolve(true);
    }
    dispose() {}
  },
}));

const mockSimpleGit = {
  raw: vi.fn().mockResolvedValue(undefined),
  branch: vi.fn().mockResolvedValue({ current: "main" }),
};

vi.mock("simple-git", () => ({
  simpleGit: vi.fn(() => mockSimpleGit),
}));

vi.mock("../../utils/hardenedGit.js", () => ({
  createHardenedGit: vi.fn(() => mockSimpleGit),
  createWslHardenedGit: vi.fn(() => mockSimpleGit),
  validateCwd: vi.fn(),
  validateBranchName: vi.fn(),
}));

vi.mock("../../utils/git.js", () => ({
  invalidateGitStatusCache: vi.fn(),
  getWorktreeChangesWithStats: vi.fn().mockResolvedValue({
    head: "abc123",
    isDirty: false,
    changedFileCount: 0,
    changes: [],
  }),
}));

vi.mock("../../utils/gitUtils.js", () => ({
  getGitDir: vi.fn().mockReturnValue(null),
  getGitCommonDir: vi.fn().mockReturnValue(null),
  clearGitDirCache: vi.fn(),
  clearGitCommonDirCache: vi.fn(),
}));

vi.mock("../../services/worktree/mood.js", () => ({
  categorizeWorktree: vi.fn().mockReturnValue("stable"),
}));

vi.mock("../../services/issueExtractor.js", () => ({
  extractIssueNumberSync: vi.fn().mockReturnValue(null),
  extractIssueNumber: vi.fn().mockResolvedValue(null),
  deriveIssueTitleFromBranch: vi.fn().mockReturnValue(undefined),
}));

vi.mock("../../services/worktree/index.js", () => ({
  AdaptivePollingStrategy: vi.fn(function () {
    return {
      getCurrentInterval: vi.fn().mockReturnValue(2000),
      updateInterval: vi.fn(),
      reportActivity: vi.fn(),
      updateConfig: vi.fn(),
      isCircuitBreakerTripped: vi.fn().mockReturnValue(false),
      reset: vi.fn(),
      setBaseInterval: vi.fn(),
      calculateNextInterval: vi.fn().mockReturnValue(2000),
      recordSuccess: vi.fn(),
      recordFailure: vi.fn(),
      recordNoChange: vi.fn(),
      recordStateChange: vi.fn(),
    };
  }),
  NoteFileReader: vi.fn(function () {
    return { read: vi.fn().mockResolvedValue({}) };
  }),
}));

vi.mock("../../services/PullRequestService.js", () => ({
  pullRequestService: {
    initialize: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    reset: vi.fn(),
    refresh: vi.fn(),
    getStatus: vi.fn().mockReturnValue({
      state: "idle",
      isPolling: false,
      candidateCount: 0,
      resolvedCount: 0,
      isEnabled: true,
    }),
  },
}));

const mockEvents = new EventEmitter();
vi.mock("../../services/events.js", () => ({
  events: mockEvents,
}));

vi.mock("fs/promises", () => ({
  stat: vi.fn().mockResolvedValue({ birthtimeMs: 1000, ctimeMs: 1000 }),
  mkdir: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
  access: vi.fn().mockResolvedValue(undefined),
  readFile: vi.fn().mockRejectedValue(new Error("ENOENT")),
  cp: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("child_process", () => ({
  spawn: vi.fn(),
}));

function wtPath(name: string): string {
  return pathResolve(`/test/${name}`);
}

function createTestWorktree(name: string, overrides: Partial<Worktree> = {}): Worktree {
  return {
    id: wtPath(name),
    path: wtPath(name),
    name,
    branch: name,
    isCurrent: false,
    isMainWorktree: false,
    gitDir: `${wtPath(name)}/.git`,
    ...overrides,
  };
}

describe("WorkspaceService agent-activity elevation", () => {
  let service: WorkspaceService;
  let WorktreeMonitorClass: typeof WorktreeMonitor;

  beforeEach(async () => {
    vi.clearAllMocks();
    watcherArms.length = 0;
    const WorkspaceServiceModule = await import("../WorkspaceService.js");
    service = new WorkspaceServiceModule.WorkspaceService(vi.fn() as any);
    const WorktreeMonitorModule = await import("../WorktreeMonitor.js");
    WorktreeMonitorClass = WorktreeMonitorModule.WorktreeMonitor;

    service["projectRootPath"] = "/test/root";
    service["git"] = mockSimpleGit as any;
    service["gitWatchEnabled"] = true;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function registerMonitor(name: string, isCurrent = false): WorktreeMonitor {
    const wt = createTestWorktree(name, { isCurrent });
    const monitor = new WorktreeMonitorClass(
      wt,
      {
        basePollingInterval: 10000,
        adaptiveBackoff: false,
        pollIntervalMax: 30000,
        circuitBreakerThreshold: 3,
        gitWatchEnabled: true,
      },
      { onUpdate: vi.fn() },
      "main"
    );
    service["monitors"].set(wt.id, monitor);
    monitor.startWithoutGitStatus();
    return monitor;
  }

  function setActive(name: string): void {
    service["activeWorktreeId"] = wtPath(name);
  }

  it("elevates a background monitor to the recursive watcher tier", () => {
    const a = registerMonitor("a");
    service["applyWatcherBudget"]();
    expect(watcherArms.at(-1)).toEqual({ watchWorktree: false });

    service.setAgentActivity([a.id]);

    expect(a.agentActive).toBe(true);
    // The elevation change rebuilt the watcher with recursive coverage.
    expect(watcherArms.at(-1)).toEqual({ watchWorktree: true });
  });

  it("exempts agent-active worktrees from background budget eviction", () => {
    service["backgroundGitWatcherCap"] = 1;
    const active = registerMonitor("active", true);
    const a = registerMonitor("a");
    const b = registerMonitor("b");
    const c = registerMonitor("c");
    setActive("active");
    // Recency: a (LRU) → b → c (MRU). Under cap 1 only c would survive.
    service["lruTouch"](a.id);
    service["lruTouch"](b.id);
    service["lruTouch"](c.id);

    service.setAgentActivity([a.id]);

    expect(active.hasWatcher).toBe(true);
    expect(a.hasWatcher).toBe(true); // agent-active: exempt despite LRU-oldest
    expect(b.hasWatcher).toBe(false); // pays the cap for the pool
    expect(c.hasWatcher).toBe(true); // MRU keeps the single slot
    expect(service["backgroundGitWatcherLru"].has(a.id)).toBe(false);
  });

  it("deactivation returns the worktree to the budget pool", () => {
    service["backgroundGitWatcherCap"] = 1;
    registerMonitor("active", true);
    const a = registerMonitor("a");
    const b = registerMonitor("b");
    setActive("active");
    service["lruTouch"](a.id);
    service["lruTouch"](b.id);
    service.setAgentActivity([a.id]);
    expect(a.hasWatcher).toBe(true);
    expect(service["backgroundGitWatcherLru"].has(a.id)).toBe(false);

    service.setAgentActivity([]);

    expect(a.agentActive).toBe(false);
    // Re-enters the pool; as the freshest entry it holds the single slot and
    // the older b stays evicted.
    expect(service["backgroundGitWatcherLru"].has(a.id)).toBe(true);
    expect(a.hasWatcher).toBe(true);
    expect(b.hasWatcher).toBe(false);
  });

  it("monitors created after the broadcast inherit the agent-active flag", async () => {
    service.setAgentActivity([wtPath("agent-made")]);

    await service["addNewWorktreeMonitor"](createTestWorktree("agent-made"), false, true);

    const monitor = service["monitors"].get(wtPath("agent-made"));
    expect(monitor).toBeDefined();
    expect(monitor!.agentActive).toBe(true);
    expect(monitor!.hasWatcher).toBe(true);
    // Armed recursive from the start — not a cold background git-only arm.
    expect(watcherArms.at(-1)).toEqual({ watchWorktree: true });
    expect(service["backgroundGitWatcherLru"].has(wtPath("agent-made"))).toBe(false);
  });

  it("setAgentActivity for an unknown worktree id is retained but harmless", () => {
    const a = registerMonitor("a");
    service.setAgentActivity([wtPath("not-yet-discovered")]);

    expect(a.agentActive).toBe(false);
    expect(service["agentActiveWorktreeIds"].has(wtPath("not-yet-discovered"))).toBe(true);
  });

  it("removing a monitor drops its agent-active flag (no stale elevation on recreate)", () => {
    const a = registerMonitor("a");
    service.setAgentActivity([a.id]);
    expect(service["agentActiveWorktreeIds"].has(a.id)).toBe(true);

    service["removeMonitor"](a.id);

    expect(service["agentActiveWorktreeIds"].has(a.id)).toBe(false);
  });

  it("ignores malformed payloads instead of clearing every elevation", () => {
    const a = registerMonitor("a");
    service.setAgentActivity([a.id]);
    expect(a.agentActive).toBe(true);

    service.setAgentActivity(undefined as unknown as string[]);
    expect(a.agentActive).toBe(true);

    service.setAgentActivity([42, a.id] as unknown as string[]);
    expect(a.agentActive).toBe(true);
    expect(service["agentActiveWorktreeIds"].size).toBe(1);
  });

  function modeOf(monitor: WorktreeMonitor): string {
    return (monitor as unknown as { watcherController: { currentMode: string } }).watcherController
      .currentMode;
  }

  describe("agent recursive cap", () => {
    it("caps recursive coverage for agent-active worktrees; the rest keep a git-only watcher", () => {
      service["agentRecursiveWatcherCap"] = 1;
      registerMonitor("active", true);
      setActive("active");
      const a = registerMonitor("a");
      const b = registerMonitor("b");
      service["applyWatcherBudget"]();

      service.setAgentActivity([a.id, b.id]);

      expect(modeOf(a)).toBe("recursive");
      expect(b.hasWatcher).toBe(true);
      expect(modeOf(b)).toBe("git-only");
    });

    it("arms an over-cap newcomer git-only directly, never recursive first", () => {
      service["agentRecursiveWatcherCap"] = 1;
      const a = registerMonitor("a");
      service["applyWatcherBudget"]();
      service.setAgentActivity([a.id]);
      // Registered after the last budget pass, so it still carries the default
      // recursive grant going into its activation.
      const b = registerMonitor("b");
      watcherArms.length = 0;

      service.setAgentActivity([a.id, b.id]);

      expect(modeOf(b)).toBe("git-only");
      expect(watcherArms).not.toContainEqual({ watchWorktree: true });
    });

    it("a batched install never arms an over-cap agent recursive before the budget pass", async () => {
      service["agentRecursiveWatcherCap"] = 1;
      service.setAgentActivity([wtPath("x"), wtPath("y")]);

      // syncMonitors defers the budget until every monitor has started.
      await service["addNewWorktreeMonitor"](createTestWorktree("x"), false, true, true);
      await service["addNewWorktreeMonitor"](createTestWorktree("y"), false, true, true);
      expect(watcherArms.filter((arm) => arm.watchWorktree)).toHaveLength(0);

      service["applyWatcherBudget"]();

      const x = service["monitors"].get(wtPath("x"))!;
      const y = service["monitors"].get(wtPath("y"))!;
      expect(modeOf(x)).toBe("recursive");
      expect(modeOf(y)).toBe("git-only");
      expect(watcherArms.filter((arm) => arm.watchWorktree)).toHaveLength(1);
    });

    it("a non-agent losing focus keeps the 3s downgrade settle under the agent cap", () => {
      vi.useFakeTimers();
      try {
        service["agentRecursiveWatcherCap"] = 0;
        const x = registerMonitor("x", true);
        const y = registerMonitor("y");
        setActive("x");
        service["applyWatcherBudget"]();
        expect(modeOf(x)).toBe("recursive");

        service.setActiveWorktree("req", y.id);

        expect(modeOf(y)).toBe("recursive");
        vi.advanceTimersByTime(2_999);
        expect(modeOf(x)).toBe("recursive");
        vi.advanceTimersByTime(1);
        expect(modeOf(x)).toBe("git-only");
      } finally {
        vi.useRealTimers();
      }
    });

    it("a newcomer never evicts an established agent's recursive stream, whatever the broadcast order", () => {
      service["agentRecursiveWatcherCap"] = 1;
      const a = registerMonitor("a");
      const b = registerMonitor("b");
      service["applyWatcherBudget"]();
      service.setAgentActivity([a.id]);
      expect(modeOf(a)).toBe("recursive");

      service.setAgentActivity([b.id, a.id]);

      expect(modeOf(a)).toBe("recursive");
      expect(modeOf(b)).toBe("git-only");
    });

    it("a freed slot promotes the next agent in activation order", () => {
      service["agentRecursiveWatcherCap"] = 1;
      const a = registerMonitor("a");
      const b = registerMonitor("b");
      service["applyWatcherBudget"]();
      service.setAgentActivity([a.id, b.id]);
      expect(modeOf(b)).toBe("git-only");

      service.setAgentActivity([b.id]);

      expect(modeOf(b)).toBe("recursive");
    });

    it("the focused worktree is outside the cap", () => {
      service["agentRecursiveWatcherCap"] = 0;
      const active = registerMonitor("active", true);
      setActive("active");
      const a = registerMonitor("a");
      service["applyWatcherBudget"]();

      service.setAgentActivity([active.id, a.id]);

      expect(modeOf(active)).toBe("recursive");
      expect(a.hasWatcher).toBe(true);
      expect(modeOf(a)).toBe("git-only");
    });

    it("a shrunk cap from the resource profile demotes the newest agents", () => {
      const a = registerMonitor("a");
      const b = registerMonitor("b");
      service["applyWatcherBudget"]();
      service.setAgentActivity([a.id, b.id]);
      expect(modeOf(a)).toBe("recursive");
      expect(modeOf(b)).toBe("recursive");

      service.updateMonitorConfig({ agentRecursiveWatcherCap: 1 });

      expect(modeOf(a)).toBe("recursive");
      expect(modeOf(b)).toBe("git-only");
    });
  });

  describe("backgrounded project (#12459)", () => {
    it("pause tears down non-agent watchers, the focused one included, and keeps agent-active ones", () => {
      const active = registerMonitor("active", true);
      setActive("active");
      const a = registerMonitor("a");
      const b = registerMonitor("b");
      service["applyWatcherBudget"]();
      service.setAgentActivity([a.id]);

      service.setPollingEnabled(false);

      expect(active.hasWatcher).toBe(false);
      expect(b.hasWatcher).toBe(false);
      expect(a.hasWatcher).toBe(true);
      expect(modeOf(a)).toBe("recursive");
    });

    it("agent activity changes while paused re-evaluate the watcher both ways", () => {
      const a = registerMonitor("a");
      const b = registerMonitor("b");
      service["applyWatcherBudget"]();
      service.setAgentActivity([a.id]);
      service.setPollingEnabled(false);

      service.setAgentActivity([b.id]);

      // a's agent finished on a project nobody is looking at: released now.
      expect(a.hasWatcher).toBe(false);
      // b's agent started: it gets the recursive watcher back.
      expect(b.hasWatcher).toBe(true);
      expect(modeOf(b)).toBe("recursive");
    });

    it("switching worktrees while paused arms nothing for non-agent worktrees", () => {
      const x = registerMonitor("x", true);
      const y = registerMonitor("y");
      setActive("x");
      service["applyWatcherBudget"]();
      service.setPollingEnabled(false);

      service.setActiveWorktree("req", y.id);

      expect(x.hasWatcher).toBe(false);
      expect(y.hasWatcher).toBe(false);
    });

    it("an agent-active worktree added while paused arms its recursive watcher", async () => {
      service.setAgentActivity([wtPath("agent-late")]);
      service.setPollingEnabled(false);

      await service["addNewWorktreeMonitor"](createTestWorktree("agent-late"), false, true);

      const monitor = service["monitors"].get(wtPath("agent-late"));
      expect(monitor!.hasWatcher).toBe(true);
      expect(modeOf(monitor!)).toBe("recursive");
    });

    it("a worktree added while paused joins paused", async () => {
      service.setPollingEnabled(false);

      await service["addNewWorktreeMonitor"](createTestWorktree("late"), false, true);

      const monitor = service["monitors"].get(wtPath("late"));
      expect(monitor).toBeDefined();
      expect(monitor!.hasWatcher).toBe(false);
    });
  });
});
