import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "events";
import { resolve as pathResolve } from "path";
import type { WorkspaceService } from "../WorkspaceService.js";
import type { WorktreeMonitor } from "../WorktreeMonitor.js";
import type { Worktree } from "../../../shared/types/worktree.js";

// Tracks live watcher instances + the peak ever held concurrently, so a test
// can assert the budget never lets the live handle count exceed the cap even
// mid-reconcile (evict-before-grant ordering).
const watcherLive = { current: 0, peak: 0 };

// Each git-only watcher arms successfully in these tests so `hasWatcher`
// directly reflects the budget decision.
vi.mock("../../utils/gitFileWatcher.js", () => ({
  GitFileWatcher: class {
    private armed = false;
    start() {
      this.armed = true;
      watcherLive.current++;
      watcherLive.peak = Math.max(watcherLive.peak, watcherLive.current);
      return Promise.resolve(true);
    }
    dispose() {
      if (this.armed) {
        this.armed = false;
        watcherLive.current--;
      }
    }
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

describe("WorkspaceService background git-watcher budget (#9538)", () => {
  let service: WorkspaceService;
  let WorktreeMonitorClass: typeof WorktreeMonitor;

  beforeEach(async () => {
    vi.clearAllMocks();
    watcherLive.current = 0;
    watcherLive.peak = 0;
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

  /**
   * Build a real, running monitor (git watch enabled) and register it directly
   * in the service. Background monitors arm a git-only watcher; the active one
   * arms recursive. Direct registration keeps the test off the async
   * addNewWorktreeMonitor path while still exercising real eviction.
   */
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

  it("evicts background watchers beyond the cap, keeping the MRU set + active", () => {
    service["backgroundGitWatcherCap"] = 2;
    const active = registerMonitor("active", true);
    const a = registerMonitor("a");
    const b = registerMonitor("b");
    const c = registerMonitor("c");
    setActive("active");

    // Recency: a (LRU) → b → c (MRU).
    service["lruTouch"](a.id);
    service["lruTouch"](b.id);
    service["lruTouch"](c.id);

    service["applyWatcherBudget"]();

    expect(active.hasWatcher).toBe(true); // active always keeps its watcher
    expect(a.hasWatcher).toBe(false); // oldest evicted
    expect(b.hasWatcher).toBe(true);
    expect(c.hasWatcher).toBe(true);
  });

  it("never counts the active worktree against the cap", () => {
    service["backgroundGitWatcherCap"] = 1;
    const active = registerMonitor("active", true);
    const a = registerMonitor("a");
    setActive("active");
    service["lruTouch"](a.id);

    service["applyWatcherBudget"]();

    expect(active.hasWatcher).toBe(true);
    expect(a.hasWatcher).toBe(true); // the single background slot
  });

  it("cap of 0 evicts every background watcher but keeps the active one", () => {
    service["backgroundGitWatcherCap"] = 0;
    const active = registerMonitor("active", true);
    const a = registerMonitor("a");
    const b = registerMonitor("b");
    setActive("active");
    service["lruTouch"](a.id);
    service["lruTouch"](b.id);

    service["applyWatcherBudget"]();

    expect(active.hasWatcher).toBe(true);
    expect(a.hasWatcher).toBe(false);
    expect(b.hasWatcher).toBe(false);
  });

  it("updateMonitorConfig with a smaller cap evicts immediately", () => {
    service["backgroundGitWatcherCap"] = 3;
    const active = registerMonitor("active", true);
    const a = registerMonitor("a");
    const b = registerMonitor("b");
    const c = registerMonitor("c");
    setActive("active");
    service["lruTouch"](a.id);
    service["lruTouch"](b.id);
    service["lruTouch"](c.id);
    service["applyWatcherBudget"]();
    expect([a, b, c].every((m) => m.hasWatcher)).toBe(true);

    service.updateMonitorConfig({ backgroundGitWatcherCap: 1 });

    expect(active.hasWatcher).toBe(true);
    expect(a.hasWatcher).toBe(false);
    expect(b.hasWatcher).toBe(false);
    expect(c.hasWatcher).toBe(true); // MRU survives
  });

  it("a grown cap re-arms freed slots for evicted monitors", () => {
    service["backgroundGitWatcherCap"] = 1;
    registerMonitor("active", true);
    const a = registerMonitor("a");
    const b = registerMonitor("b");
    setActive("active");
    service["lruTouch"](a.id);
    service["lruTouch"](b.id);
    service["applyWatcherBudget"]();
    expect(a.hasWatcher).toBe(false);
    expect(b.hasWatcher).toBe(true);

    service.updateMonitorConfig({ backgroundGitWatcherCap: 5 });

    expect(a.hasWatcher).toBe(true);
    expect(b.hasWatcher).toBe(true);
  });

  it("setActiveWorktree gives the newly focused worktree a watcher and demotes the old active to MRU background", () => {
    service["backgroundGitWatcherCap"] = 1;
    const active = registerMonitor("active", true);
    const a = registerMonitor("a");
    const b = registerMonitor("b");
    setActive("active");
    // a is MRU background, b is LRU and will be evicted under cap 1.
    service["lruTouch"](b.id);
    service["lruTouch"](a.id);
    service["applyWatcherBudget"]();
    expect(a.hasWatcher).toBe(true);
    expect(b.hasWatcher).toBe(false);

    // Focus b. It must gain a watcher; the previously-active worktree becomes
    // the most-recently-focused background entry and keeps its watcher within
    // the cap, while a (older) is evicted.
    service.setActiveWorktree("req-1", b.id);

    expect(b.hasWatcher).toBe(true);
    expect(active.hasWatcher).toBe(true); // demoted active is MRU background
    expect(a.hasWatcher).toBe(false);
    expect(service["activeWorktreeId"]).toBe(b.id);
  });

  it("removing a monitor frees its LRU slot for the next evicted worktree", () => {
    service["backgroundGitWatcherCap"] = 1;
    registerMonitor("active", true);
    const a = registerMonitor("a");
    const b = registerMonitor("b");
    setActive("active");
    service["lruTouch"](a.id);
    service["lruTouch"](b.id);
    service["applyWatcherBudget"]();
    expect(a.hasWatcher).toBe(false);
    expect(b.hasWatcher).toBe(true);

    // Drop b; a should reclaim the freed slot.
    const bMonitor = service["monitors"].get(b.id)!;
    bMonitor.stop();
    service["monitors"].delete(b.id);
    service["lruRemove"](b.id);
    service["applyWatcherBudget"]();

    expect(service["backgroundGitWatcherLru"].has(b.id)).toBe(false);
    expect(a.hasWatcher).toBe(true);
  });

  it("cold-start via addNewWorktreeMonitor never arms beyond the cap", async () => {
    service["backgroundGitWatcherCap"] = 3;
    service["activeWorktreeId"] = null;

    // Add 12 background worktrees through the real path. The pre-gate keeps a
    // new background monitor from arming a watcher before applyWatcherBudget
    // evicts the oldest, so the live count never spikes above the cap — the
    // O(N) cold-start handle peak the issue is about.
    for (let i = 0; i < 12; i++) {
      await service["addNewWorktreeMonitor"](createTestWorktree(`bg-${i}`), false, true);
    }

    expect(watcherLive.peak).toBeLessThanOrEqual(3);
    expect(watcherLive.current).toBe(3);
    const armed = [...service["monitors"].values()].filter((m) => m.hasWatcher).length;
    expect(armed).toBe(3);
  });

  it("normalizes junk cap values without throwing", () => {
    service.updateMonitorConfig({ backgroundGitWatcherCap: -5 });
    expect(service["backgroundGitWatcherCap"]).toBe(0);

    service.updateMonitorConfig({ backgroundGitWatcherCap: 4.9 });
    expect(service["backgroundGitWatcherCap"]).toBe(4);
  });
});
