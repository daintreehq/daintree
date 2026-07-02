import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "events";
import { resolve as pathResolve } from "path";
import type { SimpleGit } from "simple-git";
import type { WorkspaceService } from "../WorkspaceService.js";
import type { WorktreeMonitor } from "../WorktreeMonitor.js";
import type { Worktree } from "../../../shared/types/worktree.js";

const TEST_WORKTREE_PATH = pathResolve("/test/worktree");

const { parcelWatcherCallbacks, mockGetGitCommonDir, mockParcelSubscribe } = vi.hoisted(() => {
  const callbacks: Array<(err: Error | null, events: unknown[]) => void> = [];
  return {
    parcelWatcherCallbacks: callbacks,
    mockGetGitCommonDir: vi.fn<(arg: string) => string | null>().mockReturnValue(null),
    mockParcelSubscribe: vi.fn(
      (_dir: string, cb: (err: Error | null, events: unknown[]) => void) => {
        callbacks.push(cb);
        return Promise.resolve({ unsubscribe: vi.fn() });
      }
    ),
  };
});

vi.mock("@parcel/watcher", () => ({
  default: {
    subscribe: mockParcelSubscribe,
  },
}));

const mockSimpleGit = {
  raw: vi.fn().mockResolvedValue(undefined),
  branch: vi.fn().mockResolvedValue({ current: "main" }),
};

vi.mock("simple-git", () => ({
  simpleGit: vi.fn(() => mockSimpleGit),
}));

vi.mock("../../utils/fs.js", () => ({
  waitForPathExists: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../utils/hardenedGit.js", () => ({
  createHardenedGit: vi.fn(() => mockSimpleGit),
  validateCwd: vi.fn(),
  validateBranchName: vi.fn(),
}));

vi.mock("../../utils/git.js", () => ({
  invalidateGitStatusCache: vi.fn(),
  getWorktreeChangesWithStats: vi.fn().mockResolvedValue({
    head: "abc123",
    isDirty: false,
    stagedFileCount: 0,
    unstagedFileCount: 0,
    untrackedFileCount: 0,
    conflictedFileCount: 0,
    changedFileCount: 0,
    changes: [],
  }),
}));

vi.mock("../../utils/gitUtils.js", () => ({
  getGitDir: vi.fn().mockReturnValue("/test/worktree/.git"),
  getGitCommonDir: mockGetGitCommonDir,
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

vi.mock("../../utils/gitFileWatcher.js", () => {
  return {
    GitFileWatcher: class {
      start() {
        return Promise.resolve(false);
      }
      dispose() {}
    },
  };
});

vi.mock("fs", async () => {
  const actual = await vi.importActual<typeof import("fs")>("fs");
  return {
    ...actual,
    existsSync: vi.fn((p: unknown) => {
      if (typeof p === "string" && p.endsWith("/worktrees")) return true;
      return (actual.existsSync as (p: unknown) => boolean)(p);
    }),
  };
});

vi.mock("fs/promises", () => ({
  stat: vi.fn().mockRejectedValue(new Error("ENOENT")),
  mkdir: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
  access: vi.fn().mockRejectedValue(new Error("ENOENT")),
  readFile: vi.fn().mockRejectedValue(new Error("ENOENT")),
  cp: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("child_process", () => ({
  spawn: vi.fn(),
}));

function createTestWorktree(overrides: Partial<Worktree> = {}): Worktree {
  return {
    id: TEST_WORKTREE_PATH,
    path: TEST_WORKTREE_PATH,
    name: "feature/test",
    branch: "feature/test",
    isCurrent: false,
    isMainWorktree: false,
    gitDir: `${TEST_WORKTREE_PATH}/.git`,
    ...overrides,
  };
}

describe("WorkspaceService external worktree removal", () => {
  let service: WorkspaceService;
  let mockSendEvent: ReturnType<typeof vi.fn>;
  let WorktreeMonitorClass: typeof WorktreeMonitor;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockSimpleGit.raw.mockReset().mockResolvedValue(undefined);
    mockSimpleGit.branch.mockReset().mockResolvedValue({ current: "main" });
    mockSendEvent = vi.fn();

    const WorkspaceServiceModule = await import("../WorkspaceService.js");
    service = new WorkspaceServiceModule.WorkspaceService(mockSendEvent as any);

    const WorktreeMonitorModule = await import("../WorktreeMonitor.js");
    WorktreeMonitorClass = WorktreeMonitorModule.WorktreeMonitor;

    service["projectRootPath"] = "/test/root";
    service["git"] = mockSimpleGit as any;
    service["listService"].setGit(mockSimpleGit as unknown as SimpleGit, "/test/root");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function createAndRegisterMonitor(overrides: Partial<Worktree> = {}): WorktreeMonitor {
    const wt = createTestWorktree(overrides);
    const monitor = new WorktreeMonitorClass(
      wt,
      {
        basePollingInterval: 10000,
        adaptiveBackoff: false,
        pollIntervalMax: 30000,
        circuitBreakerThreshold: 3,
        gitWatchEnabled: false,
      },
      { onUpdate: vi.fn() },
      "main"
    );
    service["monitors"].set(wt.id, monitor);
    return monitor;
  }

  describe("discoverAndSyncWorktrees() conditional prune (#6669)", () => {
    it("prunes and re-lists when the list carries a prunable entry, clearing externally-deleted worktrees", async () => {
      createAndRegisterMonitor();
      expect(service["monitors"].has(TEST_WORKTREE_PATH)).toBe(true);

      const callOrder: string[] = [];
      let pruned = false;
      mockSimpleGit.raw.mockImplementation(async (args: string[]) => {
        callOrder.push(args.join(" "));
        if (args[0] === "worktree" && args[1] === "prune") {
          pruned = true;
          return undefined;
        }
        if (args[0] === "worktree" && args[1] === "list") {
          if (pruned) {
            // Post-prune list: phantom worktree is gone, only main remains.
            return [
              "worktree /test/root",
              "HEAD aaaaaaaaaaaaaaaaaaaa",
              "branch refs/heads/main",
              "",
            ].join("\n");
          }
          // Pre-prune list: Git 2.31+ keeps the externally-deleted worktree
          // in the porcelain output with a `prunable` marker.
          return [
            "worktree /test/root",
            "HEAD aaaaaaaaaaaaaaaaaaaa",
            "branch refs/heads/main",
            "",
            `worktree ${TEST_WORKTREE_PATH}`,
            "HEAD bbbbbbbbbbbbbbbbbbbb",
            "branch refs/heads/feature",
            "prunable gitdir file points to non-existent location",
            "",
          ].join("\n");
        }
        return undefined;
      });

      // Force the list cache to be re-fetched (forceRefresh: true bypasses
      // it anyway, but ensure no stale entry leaks through).
      service["listService"].invalidateCache();

      await service["discoverAndSyncWorktrees"]();

      // List-first, prune only on a prunable marker, then re-list so the
      // sync sees the cleaned topology.
      const firstListIdx = callOrder.findIndex((c) => c.startsWith("worktree list"));
      const pruneIdx = callOrder.findIndex((c) => c.startsWith("worktree prune"));
      const secondListIdx = callOrder.findIndex(
        (c, i) => i > pruneIdx && c.startsWith("worktree list")
      );
      expect(firstListIdx).toBeGreaterThanOrEqual(0);
      expect(pruneIdx).toBeGreaterThan(firstListIdx);
      expect(secondListIdx).toBeGreaterThan(pruneIdx);

      expect(service["monitors"].has(TEST_WORKTREE_PATH)).toBe(false);
      expect(mockSendEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "worktree-removed",
          worktreeId: TEST_WORKTREE_PATH,
        })
      );
    });

    it("skips the prune spawn entirely on a quiet cycle with nothing prunable", async () => {
      const callOrder: string[] = [];
      mockSimpleGit.raw.mockImplementation(async (args: string[]) => {
        callOrder.push(args.join(" "));
        if (args[0] === "worktree" && args[1] === "list") {
          return [
            "worktree /test/root",
            "HEAD aaaaaaaaaaaaaaaaaaaa",
            "branch refs/heads/main",
            "",
          ].join("\n");
        }
        return undefined;
      });

      service["listService"].invalidateCache();
      await service["discoverAndSyncWorktrees"]();

      expect(callOrder.some((c) => c.startsWith("worktree list"))).toBe(true);
      expect(callOrder.some((c) => c.startsWith("worktree prune"))).toBe(false);
    });
  });

  describe("discoverAndSyncWorktrees() prune failure handling (#6669)", () => {
    it("continues refresh when 'git worktree prune' itself fails", async () => {
      createAndRegisterMonitor();

      let listCalled = false;
      mockSimpleGit.raw.mockImplementation(async (args: string[]) => {
        if (args[0] === "worktree" && args[1] === "prune") {
          throw new Error("fatal: failed to prune (EPERM)");
        }
        if (args[0] === "worktree" && args[1] === "list") {
          listCalled = true;
          // List still includes the registered monitor — refresh succeeds,
          // sync runs, monitor remains registered (no phantom to clean up).
          return [
            "worktree /test/root",
            "HEAD aaaaaaaaaaaaaaaaaaaa",
            "branch refs/heads/main",
            "",
            "worktree /test/worktree",
            "HEAD bbbbbbbbbbbbbbbbbbbb",
            "branch refs/heads/feature/test",
            "",
          ].join("\n");
        }
        return undefined;
      });

      service["listService"].invalidateCache();

      await expect(service["discoverAndSyncWorktrees"]()).resolves.not.toThrow();
      expect(listCalled).toBe(true);
      expect(service["monitors"].has(TEST_WORKTREE_PATH)).toBe(true);
    });
  });

  describe("handleExternalWorktreeRemoval()", () => {
    it("removes non-main worktree and emits removal event", () => {
      createAndRegisterMonitor();

      service["handleExternalWorktreeRemoval"](TEST_WORKTREE_PATH);

      expect(mockSendEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "worktree-removed",
          worktreeId: TEST_WORKTREE_PATH,
        })
      );
      expect(service["monitors"].has(TEST_WORKTREE_PATH)).toBe(false);
    });

    it("does not remove main worktree", () => {
      createAndRegisterMonitor({ isMainWorktree: true });

      service["handleExternalWorktreeRemoval"](TEST_WORKTREE_PATH);

      expect(service["monitors"].has(TEST_WORKTREE_PATH)).toBe(true);
      expect(mockSendEvent).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: "worktree-removed" })
      );
    });
  });

  describe("topology watcher", () => {
    beforeEach(async () => {
      mockGetGitCommonDir.mockReturnValue("/test/root/.git");
      parcelWatcherCallbacks.length = 0;
      mockParcelSubscribe.mockClear();
    });

    it("starts watcher when metadata dir exists", async () => {
      service["startTopologyWatcher"]();
      // Wait for the async subscribe to resolve
      await vi.waitFor(() => expect(mockParcelSubscribe).toHaveBeenCalled());
      expect(mockParcelSubscribe).toHaveBeenCalledWith(
        "/test/root/.git/worktrees",
        expect.any(Function)
      );
    });

    it("does not start watcher when already subscribed", async () => {
      service["startTopologyWatcher"]();
      await vi.waitFor(() => expect(mockParcelSubscribe).toHaveBeenCalledTimes(1));
      service["startTopologyWatcher"]();
      // Give time for a potential second async subscribe
      await new Promise((r) => setTimeout(r, 10));
      expect(mockParcelSubscribe).toHaveBeenCalledTimes(1);
    });

    it("skips watcher start when metadata dir is absent", () => {
      mockGetGitCommonDir.mockReturnValue(null);
      service["startTopologyWatcher"]();
      expect(mockParcelSubscribe).not.toHaveBeenCalled();
    });

    it("stops watcher and clears pending state", async () => {
      service["startTopologyWatcher"]();
      await vi.waitFor(() => expect(mockParcelSubscribe).toHaveBeenCalledTimes(1));
      service["topologyReconcilePending"] = true;

      service["stopTopologyWatcher"]();

      expect(service["topologyWatcherSubscription"].value).toBeUndefined();
      expect(service["topologyReconcilePending"]).toBe(false);
    });

    it("fires reconciliation when watcher callback triggers after debounce", async () => {
      vi.useFakeTimers();
      const discoverSpy = vi
        .spyOn(service as any, "discoverAndSyncWorktrees")
        .mockResolvedValue(undefined);

      service["startTopologyWatcher"]();
      // Flush the async subscribe
      await vi.runAllTimersAsync();
      expect(parcelWatcherCallbacks.length).toBeGreaterThanOrEqual(1);

      // Fire the watcher callback
      parcelWatcherCallbacks[0]!(null, [
        { type: "delete", path: "/test/root/.git/worktrees/phantom" },
      ]);

      // Should not have called discovery yet (debounce hasnt fired)
      expect(discoverSpy).not.toHaveBeenCalled();

      // Advance past the 300ms debounce
      await vi.advanceTimersByTimeAsync(350);

      expect(discoverSpy).toHaveBeenCalledTimes(1);
      vi.useRealTimers();
    });

    it("coalesces burst events into a single reconciliation pass", async () => {
      vi.useFakeTimers();
      const discoverSpy = vi
        .spyOn(service as any, "discoverAndSyncWorktrees")
        .mockResolvedValue(undefined);

      service["startTopologyWatcher"]();
      await vi.runAllTimersAsync();

      // Fire three events in quick succession
      const cb = parcelWatcherCallbacks[0]!;
      cb(null, [{ type: "delete", path: "/test/root/.git/worktrees/a" }]);
      cb(null, [{ type: "delete", path: "/test/root/.git/worktrees/b" }]);
      cb(null, [{ type: "delete", path: "/test/root/.git/worktrees/c" }]);

      await vi.advanceTimersByTimeAsync(350);

      // All three events coalesced into one reconciliation
      expect(discoverSpy).toHaveBeenCalledTimes(1);
      vi.useRealTimers();
    });

    it("suppresses the app-owned create event and drains the pending entry", async () => {
      vi.useFakeTimers();
      const discoverSpy = vi
        .spyOn(service as any, "discoverAndSyncWorktrees")
        .mockResolvedValue(undefined);

      // Simulate the pending entry createWorktree registers before its own
      // `git worktree add`.
      service["topologyMarkPending"]("new-wt", service["topologyPendingCreate"]);

      service["startTopologyWatcher"]();
      await vi.advanceTimersByTimeAsync(0);

      parcelWatcherCallbacks[0]!(null, [
        { type: "create", path: "/test/root/.git/worktrees/new-wt" },
      ]);
      await vi.advanceTimersByTimeAsync(350);

      // App-owned event matched the pending entry — no reconciliation.
      expect(discoverSpy).not.toHaveBeenCalled();
      // ...and the pending entry (plus its safety timer) is drained.
      expect(service["topologyPendingCreate"].has("new-wt")).toBe(false);
      expect(service["topologyPendingSafetyTimers"].has("new-wt")).toBe(false);

      // A later external change to the same name is no longer masked.
      parcelWatcherCallbacks[0]!(null, [
        { type: "delete", path: "/test/root/.git/worktrees/new-wt" },
      ]);
      await vi.advanceTimersByTimeAsync(350);
      expect(discoverSpy).toHaveBeenCalledTimes(1);
      vi.useRealTimers();
    });

    it("does not swallow an external delete during an app-owned create (#8412)", async () => {
      vi.useFakeTimers();
      const discoverSpy = vi
        .spyOn(service as any, "discoverAndSyncWorktrees")
        .mockResolvedValue(undefined);

      // App-owned create in flight for "my-wt".
      service["topologyMarkPending"]("my-wt", service["topologyPendingCreate"]);

      service["startTopologyWatcher"]();
      await vi.advanceTimersByTimeAsync(0);

      // Concurrent external `git worktree remove other-wt`.
      parcelWatcherCallbacks[0]!(null, [
        { type: "delete", path: "/test/root/.git/worktrees/other-wt" },
      ]);
      await vi.advanceTimersByTimeAsync(350);

      // The external delete is not pending → reconciliation fires.
      expect(discoverSpy).toHaveBeenCalledTimes(1);
      // The app-owned pending entry is untouched.
      expect(service["topologyPendingCreate"].has("my-wt")).toBe(true);
      vi.useRealTimers();
    });

    it("reconciles a mixed batch with a matched create and an unmatched delete", async () => {
      vi.useFakeTimers();
      const discoverSpy = vi
        .spyOn(service as any, "discoverAndSyncWorktrees")
        .mockResolvedValue(undefined);

      service["topologyMarkPending"]("my-wt", service["topologyPendingCreate"]);

      service["startTopologyWatcher"]();
      await vi.advanceTimersByTimeAsync(0);

      // Both events coalesce into one debounce window.
      const cb = parcelWatcherCallbacks[0]!;
      cb(null, [{ type: "create", path: "/test/root/.git/worktrees/my-wt" }]);
      cb(null, [{ type: "delete", path: "/test/root/.git/worktrees/other-wt" }]);
      await vi.advanceTimersByTimeAsync(350);

      // Unmatched external delete forces exactly one reconciliation...
      expect(discoverSpy).toHaveBeenCalledTimes(1);
      // ...and the matched create still drained its pending entry.
      expect(service["topologyPendingCreate"].has("my-wt")).toBe(false);
      vi.useRealTimers();
    });

    it("safety valve clears a pending entry after 5s with no reconcile", async () => {
      vi.useFakeTimers();
      const discoverSpy = vi
        .spyOn(service as any, "discoverAndSyncWorktrees")
        .mockResolvedValue(undefined);

      service["topologyMarkPending"]("stuck-wt", service["topologyPendingDelete"]);
      expect(service["topologyPendingDelete"].has("stuck-wt")).toBe(true);

      // No watcher event ever arrives.
      await vi.advanceTimersByTimeAsync(5000);

      expect(service["topologyPendingDelete"].has("stuck-wt")).toBe(false);
      expect(service["topologyPendingSafetyTimers"].has("stuck-wt")).toBe(false);
      expect(discoverSpy).not.toHaveBeenCalled();
      vi.useRealTimers();
    });

    it("no longer exposes a topologyWatchSuppressUntil field", () => {
      expect("topologyWatchSuppressUntil" in service).toBe(false);
      expect((service as any)["topologyWatchSuppressUntil"]).toBeUndefined();
    });

    it("does not let a pending create swallow an external delete of the same basename", async () => {
      vi.useFakeTimers();
      const discoverSpy = vi
        .spyOn(service as any, "discoverAndSyncWorktrees")
        .mockResolvedValue(undefined);

      // App-owned create pending for "foo"; an external `git worktree remove`
      // for a pre-existing worktree whose metadata dir is also "foo" fires a
      // DELETE event — it must not be drained by the pending *create*.
      service["topologyMarkPending"]("foo", service["topologyPendingCreate"]);

      service["startTopologyWatcher"]();
      await vi.advanceTimersByTimeAsync(0);

      parcelWatcherCallbacks[0]!(null, [{ type: "delete", path: "/test/root/.git/worktrees/foo" }]);
      await vi.advanceTimersByTimeAsync(350);

      expect(discoverSpy).toHaveBeenCalledTimes(1);
      // The pending create entry is untouched by the unrelated delete.
      expect(service["topologyPendingCreate"].has("foo")).toBe(true);
      vi.useRealTimers();
    });

    it("clears pending entries and safety timers on stopTopologyWatcher", async () => {
      vi.useFakeTimers();
      const discoverSpy = vi
        .spyOn(service as any, "discoverAndSyncWorktrees")
        .mockResolvedValue(undefined);

      service["topologyMarkPending"]("paused-wt", service["topologyPendingDelete"]);
      expect(service["topologyPendingDelete"].has("paused-wt")).toBe(true);
      expect(service["topologyPendingSafetyTimers"].has("paused-wt")).toBe(true);

      // Pause/teardown clears all pending state.
      service["stopTopologyWatcher"]();
      expect(service["topologyPendingDelete"].has("paused-wt")).toBe(false);
      expect(service["topologyPendingSafetyTimers"].has("paused-wt")).toBe(false);

      // After resume, an external change to that same name still reconciles.
      service["startTopologyWatcher"]();
      await vi.advanceTimersByTimeAsync(0);
      parcelWatcherCallbacks.at(-1)!(null, [
        { type: "delete", path: "/test/root/.git/worktrees/paused-wt" },
      ]);
      await vi.advanceTimersByTimeAsync(350);

      expect(discoverSpy).toHaveBeenCalledTimes(1);
      vi.useRealTimers();
    });

    it("respects post-reconciliation cooldown", async () => {
      vi.useFakeTimers();
      const discoverSpy = vi
        .spyOn(service as any, "discoverAndSyncWorktrees")
        .mockResolvedValue(undefined);

      service["startTopologyWatcher"]();
      await vi.runAllTimersAsync();

      // Fire first event — triggers reconciliation
      parcelWatcherCallbacks[0]!(null, [
        { type: "delete", path: "/test/root/.git/worktrees/wt-1" },
      ]);
      await vi.advanceTimersByTimeAsync(350);
      expect(discoverSpy).toHaveBeenCalledTimes(1);

      // Fire second event immediately — should be suppressed by cooldown
      service["topologyReconcilePending"] = false; // simulate reconcile completion reset
      parcelWatcherCallbacks[0]!(null, [
        { type: "delete", path: "/test/root/.git/worktrees/wt-2" },
      ]);
      await vi.advanceTimersByTimeAsync(350);
      // Still only 1 call because cooldown is active (set to Date.now() + 2000)
      // The second event was swallowed by scheduleTopologyReconcile's cooldown check
      expect(discoverSpy).toHaveBeenCalledTimes(1);

      vi.useRealTimers();
    });

    it("does not process watcher events when polling is disabled", async () => {
      vi.useFakeTimers();
      const discoverSpy = vi
        .spyOn(service as any, "discoverAndSyncWorktrees")
        .mockResolvedValue(undefined);

      service["setPollingEnabled"](false);

      service["startTopologyWatcher"]();
      await vi.runAllTimersAsync();

      parcelWatcherCallbacks[0]!(null, [
        { type: "delete", path: "/test/root/.git/worktrees/wt-1" },
      ]);
      await vi.advanceTimersByTimeAsync(350);

      expect(discoverSpy).not.toHaveBeenCalled();
      vi.useRealTimers();
    });

    it("auto-switches to main worktree when active worktree is externally removed", async () => {
      // Register main + active worktrees
      createAndRegisterMonitor({ id: "/test/main", path: "/test/main", isMainWorktree: true });
      createAndRegisterMonitor({ id: "/test/active", path: "/test/active", isCurrent: true });
      service["activeWorktreeId"] = "/test/active";

      // Mock discoverAndSyncWorktrees to simulate removal of /test/active
      const discoverSpy = vi
        .spyOn(service as any, "discoverAndSyncWorktrees")
        .mockImplementation(async () => {
          // Remove the active monitor (simulating syncMonitors pruning it)
          const monitor = service["monitors"].get("/test/active");
          if (monitor) {
            service.resourceActionExecutor["cleanupResourceActionState"]("/test/active");
            monitor.stop();
            service["monitors"].delete("/test/active");
          }
          service["activeWorktreeId"] = null;
        });

      await service["runTopologyReconcile"]();

      // Active worktree should have been switched to main
      expect(service["activeWorktreeId"]).toBe("/test/main");
      discoverSpy.mockRestore();
    });

    it("does not switch when removal did not affect active worktree", async () => {
      createAndRegisterMonitor({ id: "/test/main", path: "/test/main", isMainWorktree: true });
      createAndRegisterMonitor({ id: "/test/other", path: "/test/other" });
      service["activeWorktreeId"] = "/test/main";

      // discoverAndSyncWorktrees removes /test/other but not /test/main
      vi.spyOn(service as any, "discoverAndSyncWorktrees").mockImplementation(async () => {
        const monitor = service["monitors"].get("/test/other");
        if (monitor) {
          monitor.stop();
          service["monitors"].delete("/test/other");
        }
      });

      await service["runTopologyReconcile"]();

      // Active should still be main
      expect(service["activeWorktreeId"]).toBe("/test/main");
    });
  });

  describe("topology-watcher dark state (#9908)", () => {
    function darkEventCount(): number {
      return mockSendEvent.mock.calls.filter(
        ([e]) => (e as { type?: string })?.type === "topology-watcher-dark"
      ).length;
    }
    function recoveredEventCount(): number {
      return mockSendEvent.mock.calls.filter(
        ([e]) => (e as { type?: string })?.type === "topology-watcher-recovered"
      ).length;
    }

    beforeEach(() => {
      mockGetGitCommonDir.mockReturnValue("/test/root/.git");
      parcelWatcherCallbacks.length = 0;
      mockParcelSubscribe.mockClear();
    });

    it("emits topology-watcher-dark when subscribe() rejects at cold start", async () => {
      mockParcelSubscribe.mockReturnValueOnce(Promise.reject(new Error("EPERM")));

      service["startTopologyWatcher"]();

      await vi.waitFor(() => expect(darkEventCount()).toBe(1));
      expect(service.isTopologyWatcherDark()).toBe(true);
    });

    it("emits the dark event at most once while already dark", async () => {
      mockParcelSubscribe.mockReturnValueOnce(Promise.reject(new Error("EPERM")));
      service["startTopologyWatcher"]();
      await vi.waitFor(() => expect(darkEventCount()).toBe(1));

      // A second independent dark trigger (safety-valve expiry path) must not
      // re-assert the signal — the one-shot guard suppresses it.
      service["handleTopologyWatcherDark"]();
      expect(darkEventCount()).toBe(1);
      expect(service.isTopologyWatcherDark()).toBe(true);
    });

    it("emits topology-watcher-dark when a pending-event safety valve expires", async () => {
      vi.useFakeTimers();
      try {
        // The watcher missed the event our own op produced: the 5s valve fires.
        service["topologyMarkPending"]("missed-wt", service["topologyPendingCreate"]);
        expect(darkEventCount()).toBe(0);

        await vi.advanceTimersByTimeAsync(5001);

        expect(darkEventCount()).toBe(1);
        expect(service.isTopologyWatcherDark()).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it("clears the dark state on a successful runTopologyReconcile and emits recovered", async () => {
      vi.spyOn(service as any, "discoverAndSyncWorktrees").mockResolvedValue(undefined);
      service["handleTopologyWatcherDark"]();
      expect(service.isTopologyWatcherDark()).toBe(true);

      await service["runTopologyReconcile"]();

      expect(service.isTopologyWatcherDark()).toBe(false);
      expect(recoveredEventCount()).toBe(1);
    });

    it("does not emit recovered from a reconcile when never dark", async () => {
      vi.spyOn(service as any, "discoverAndSyncWorktrees").mockResolvedValue(undefined);

      await service["runTopologyReconcile"]();

      expect(recoveredEventCount()).toBe(0);
      expect(service.isTopologyWatcherDark()).toBe(false);
    });

    it("does NOT recover on watcher re-arm — only a reconcile clears the dark state", async () => {
      mockParcelSubscribe.mockReturnValueOnce(Promise.reject(new Error("EPERM")));
      service["startTopologyWatcher"]();
      await vi.waitFor(() => expect(service.isTopologyWatcherDark()).toBe(true));

      // The watcher re-subscribes successfully (default mock resolves). A live
      // subscription does NOT prove the topology is current (#8516/#8558), so
      // the dark state must persist until a reconcile verifies it.
      service["startTopologyWatcher"]();
      await vi.waitFor(() => expect(mockParcelSubscribe).toHaveBeenCalledTimes(2));

      expect(service.isTopologyWatcherDark()).toBe(true);
      expect(recoveredEventCount()).toBe(0);
    });

    it("emits recovered on stopTopologyWatcher while dark so the renderer can clear", async () => {
      service["handleTopologyWatcherDark"]();
      expect(service.isTopologyWatcherDark()).toBe(true);

      service["stopTopologyWatcher"]();

      expect(service.isTopologyWatcherDark()).toBe(false);
      expect(recoveredEventCount()).toBe(1);
    });

    it("does not emit recovered on stopTopologyWatcher when not dark", () => {
      service["stopTopologyWatcher"]();
      expect(recoveredEventCount()).toBe(0);
    });

    it("goes dark when the watcher callback reports a runtime error", async () => {
      service["startTopologyWatcher"]();
      await vi.waitFor(() => expect(parcelWatcherCallbacks.length).toBeGreaterThanOrEqual(1));

      // An established subscription firing an error callback is as unreliable
      // as a failed subscribe — surface the dark state.
      parcelWatcherCallbacks.at(-1)!(new Error("watcher backend error"), []);

      expect(darkEventCount()).toBe(1);
      expect(service.isTopologyWatcherDark()).toBe(true);
    });

    it("can re-dark after a stop/resume cycle clears the guard", async () => {
      vi.useFakeTimers();
      try {
        service["handleTopologyWatcherDark"]();
        expect(darkEventCount()).toBe(1);

        // Stop clears the guard (emits recovered); a fresh valve expiry after
        // resume must be able to signal dark again.
        service["stopTopologyWatcher"]();
        expect(service.isTopologyWatcherDark()).toBe(false);

        service["topologyMarkPending"]("again-wt", service["topologyPendingDelete"]);
        await vi.advanceTimersByTimeAsync(5001);

        expect(darkEventCount()).toBe(2);
        expect(service.isTopologyWatcherDark()).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it("isTopologyWatcherDark() defaults to false", () => {
      expect(service.isTopologyWatcherDark()).toBe(false);
    });
  });

  describe("periodic safety-net timer (#8510)", () => {
    it("calls scheduleTopologyReconcile on each interval tick", async () => {
      vi.useFakeTimers();
      const reconcileSpy = vi
        .spyOn(service as any, "scheduleTopologyReconcile")
        .mockImplementation(() => {});

      service["startPeriodicSafetyTimer"]();

      expect(reconcileSpy).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(90_000);
      expect(reconcileSpy).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(90_000);
      expect(reconcileSpy).toHaveBeenCalledTimes(2);

      vi.useRealTimers();
    });

    it("is idempotent — a second start does not create a duplicate interval", async () => {
      vi.useFakeTimers();
      const reconcileSpy = vi
        .spyOn(service as any, "scheduleTopologyReconcile")
        .mockImplementation(() => {});

      service["startPeriodicSafetyTimer"]();
      service["startPeriodicSafetyTimer"]();

      await vi.advanceTimersByTimeAsync(90_000);
      expect(reconcileSpy).toHaveBeenCalledTimes(1);

      vi.useRealTimers();
    });

    it("stopTopologyWatcher clears the timer so no further ticks fire", async () => {
      vi.useFakeTimers();
      const reconcileSpy = vi
        .spyOn(service as any, "scheduleTopologyReconcile")
        .mockImplementation(() => {});

      service["startPeriodicSafetyTimer"]();
      service["stopTopologyWatcher"]();

      await vi.advanceTimersByTimeAsync(90_000 * 2);
      expect(reconcileSpy).not.toHaveBeenCalled();
      expect(service["periodicSafetyTimer"]).toBeNull();

      vi.useRealTimers();
    });

    it("clears a phantom monitor end-to-end when the interval fires", async () => {
      createAndRegisterMonitor();
      expect(service["monitors"].has(TEST_WORKTREE_PATH)).toBe(true);

      mockSimpleGit.raw.mockImplementation(async (args: string[]) => {
        if (args[0] === "worktree" && args[1] === "list") {
          // Post-prune list: the externally-removed worktree is gone.
          return [
            "worktree /test/root",
            "HEAD aaaaaaaaaaaaaaaaaaaa",
            "branch refs/heads/main",
            "",
          ].join("\n");
        }
        return undefined;
      });
      service["listService"].invalidateCache();

      vi.useFakeTimers();
      service["startPeriodicSafetyTimer"]();
      await vi.advanceTimersByTimeAsync(90_000);

      expect(service["monitors"].has(TEST_WORKTREE_PATH)).toBe(false);
      expect(mockSendEvent).toHaveBeenCalledWith(
        expect.objectContaining({ type: "worktree-removed", worktreeId: TEST_WORKTREE_PATH })
      );

      vi.useRealTimers();
    });

    it("restarts symmetrically across a setPollingEnabled pause/resume cycle", async () => {
      vi.useFakeTimers();
      const reconcileSpy = vi
        .spyOn(service as any, "scheduleTopologyReconcile")
        .mockImplementation(() => {});

      service["startPeriodicSafetyTimer"]();
      service.setPollingEnabled(false);
      expect(service["periodicSafetyTimer"]).toBeNull();

      await vi.advanceTimersByTimeAsync(90_000);
      expect(reconcileSpy).not.toHaveBeenCalled();

      service.setPollingEnabled(true);
      // setPollingEnabled(true) also fires an immediate reconcile (line 2186);
      // clear it so the assertion isolates the restarted timer's tick.
      reconcileSpy.mockClear();
      await vi.advanceTimersByTimeAsync(90_000);
      expect(reconcileSpy).toHaveBeenCalledTimes(1);

      vi.useRealTimers();
    });
  });
});
