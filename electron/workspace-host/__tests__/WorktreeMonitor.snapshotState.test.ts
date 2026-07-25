import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Worktree } from "../../../shared/types/worktree.js";
import { WorktreeRemovedError } from "../../utils/errorTypes.js";

const mockGetWorktreeChangesWithStats = vi.fn();
const mockInvalidateGitStatusCache = vi.fn();
const mockGitRaw = vi.fn();

const { mockCreateHardenedGit, mockCreateWslHardenedGit } = vi.hoisted(() => ({
  mockCreateHardenedGit: vi.fn(),
  mockCreateWslHardenedGit: vi.fn(),
}));

mockCreateHardenedGit.mockImplementation(() => ({
  raw: (...args: unknown[]) => mockGitRaw(...args),
  log: vi.fn().mockResolvedValue({ latest: null }),
}));
mockCreateWslHardenedGit.mockImplementation(() => ({
  raw: (...args: unknown[]) => mockGitRaw(...args),
  log: vi.fn().mockResolvedValue({ latest: null }),
}));

vi.mock("../../utils/hardenedGit.js", () => ({
  createHardenedGit: mockCreateHardenedGit,
  createWslHardenedGit: mockCreateWslHardenedGit,
  validateCwd: vi.fn(),
}));

vi.mock("../../utils/git.js", () => ({
  getWorktreeChangesWithStats: (...args: unknown[]) => mockGetWorktreeChangesWithStats(...args),
  invalidateGitStatusCache: (...args: unknown[]) => mockInvalidateGitStatusCache(...args),
}));

vi.mock("fs/promises", () => ({
  access: vi.fn().mockRejectedValue(new Error("ENOENT")),
  readFile: vi.fn().mockRejectedValue(new Error("ENOENT")),
  stat: vi.fn().mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" })),
}));

vi.mock("simple-git", () => ({
  simpleGit: vi.fn(() => ({ raw: vi.fn(), log: vi.fn().mockResolvedValue({ latest: null }) })),
}));

const { mockCategorizeWorktree } = vi.hoisted(() => ({
  mockCategorizeWorktree: vi.fn().mockReturnValue("stable"),
}));

vi.mock("../../services/worktree/mood.js", () => ({
  categorizeWorktree: mockCategorizeWorktree,
}));

vi.mock("../../services/issueExtractor.js", () => ({
  extractIssueNumberSync: vi.fn().mockReturnValue(null),
  extractIssueNumber: vi.fn().mockResolvedValue(null),
  deriveIssueTitleFromBranch: vi.fn().mockReturnValue(undefined),
}));

vi.mock("../../utils/gitUtils.js", () => ({
  getGitDir: vi.fn().mockReturnValue(null),
  clearGitDirCache: vi.fn(),
  clearGitCommonDirCache: vi.fn(),
}));

const mockGetRepoOperationStateSync = vi.fn().mockReturnValue(undefined);
vi.mock("../../utils/gitRepoOperationState.js", () => ({
  isRepoOperationInProgress: vi.fn().mockReturnValue(false),
  getRepoOperationStateSync: (...args: unknown[]) => mockGetRepoOperationStateSync(...args),
  OPERATION_SENTINEL_NAMES: [
    "MERGE_HEAD",
    "rebase-merge",
    "rebase-apply",
    "CHERRY_PICK_HEAD",
    "REVERT_HEAD",
  ],
}));

let mockWatcherStartResult = false;
/** Optional per-mode override. When set, takes precedence over `mockWatcherStartResult`
 *  for that mode, so a test can model "recursive fails, git-only succeeds". */
let mockRecursiveStartResult: boolean | undefined;
let mockGitOnlyStartResult: boolean | undefined;
/** When true, the stub's `start()` synchronously invokes `onWatcherFailed`
 *  before returning — mirroring the real startup-ENOSPC catch path. Only
 *  fires for recursive (`watchWorktree: true`) starts, matching the real
 *  watcher's behaviour where per-file `.git/` watchers never trigger the
 *  failure callback. */
let mockWatcherStartFiresFailure = false;
const capturedWatcherOptionsHistory: Record<string, unknown>[] = [];
let watcherStartCallCount = 0;

vi.mock("../../utils/gitFileWatcher.js", () => {
  return {
    GitFileWatcher: class {
      private readonly onWatcherFailed?: () => void;
      private readonly watchWorktree: boolean;
      constructor(
        opts: {
          onWatcherFailed?: () => void;
          onInotifyLimitReached?: () => void;
          onEmfileLimitReached?: () => void;
          watchWorktree?: boolean;
        } & Record<string, unknown>
      ) {
        this.onWatcherFailed = opts.onWatcherFailed;
        this.watchWorktree = opts.watchWorktree === true;
        capturedWatcherOptionsHistory.push(opts);
      }
      start() {
        watcherStartCallCount++;
        const result = this.watchWorktree
          ? (mockRecursiveStartResult ?? mockWatcherStartResult)
          : (mockGitOnlyStartResult ?? mockWatcherStartResult);
        // Only the recursive arm reports failures via `onWatcherFailed`.
        if (this.watchWorktree && mockWatcherStartFiresFailure && !result) {
          this.onWatcherFailed?.();
        }
        return Promise.resolve(result);
      }
      dispose() {}
    },
  };
});

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

import { WorktreeMonitor } from "../WorktreeMonitor.js";
import type { WorktreeMonitorConfig, WorktreeMonitorCallbacks } from "../WorktreeMonitor.js";
import { getGitDir } from "../../utils/gitUtils.js";
import { stat, readFile, access } from "fs/promises";

const TEST_WORKTREE: Worktree = {
  id: "/test/worktree",
  path: "/test/worktree",
  name: "test-branch",
  branch: "test-branch",
  isCurrent: false,
  isMainWorktree: false,
};

const TEST_CONFIG: WorktreeMonitorConfig = {
  basePollingInterval: 2000,
  adaptiveBackoff: false,
  pollIntervalMax: 10000,
  circuitBreakerThreshold: 5,
  gitWatchEnabled: false,
};

function makeCallbacks(overrides?: Partial<WorktreeMonitorCallbacks>): WorktreeMonitorCallbacks {
  return {
    onUpdate: vi.fn(),
    onRemoved: vi.fn(),
    onError: vi.fn(),
    ...overrides,
  };
}

// Matches STATUS_INITIAL_DELAY_MIN_MS in WorktreeMonitor.ts. Background
// monitors defer their initial updateGitStatus through a 2-5s jitter timer,
// so tests must advance fake timers past the lower bound before asserting
// on onUpdate / hasInitialStatus. Math.random() is mocked to 0 in
// beforeEach, pinning the jitter to the minimum (2000ms). Advance by
// exactly the minimum so the follow-on poll (scheduled at +2000ms from
// when the initial fires) doesn't also fire and inflate call counts.
const STATUS_INITIAL_DELAY_MIN_MS = 2_000;

async function flushInitialStatus(): Promise<void> {
  await vi.advanceTimersByTimeAsync(STATUS_INITIAL_DELAY_MIN_MS);
}

describe("WorktreeMonitor", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    vi.clearAllMocks();
    mockCategorizeWorktree.mockReturnValue("stable");
    mockWatcherStartResult = false;
    mockRecursiveStartResult = undefined;
    mockGitOnlyStartResult = undefined;
    mockWatcherStartFiresFailure = false;
    watcherStartCallCount = 0;
    capturedWatcherOptionsHistory.length = 0;
    mockGetRepoOperationStateSync.mockReturnValue(undefined);
    vi.mocked(getGitDir).mockResolvedValue(null);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("calls onRemoved and stops polling when WorktreeRemovedError is thrown", async () => {
    mockGetWorktreeChangesWithStats.mockRejectedValue(new WorktreeRemovedError("/test/worktree"));

    const callbacks = makeCallbacks();
    const monitor = new WorktreeMonitor(TEST_WORKTREE, TEST_CONFIG, callbacks, "main");

    await monitor.start();
    await flushInitialStatus();

    expect(callbacks.onRemoved).toHaveBeenCalledWith("/test/worktree");
    expect(callbacks.onUpdate).not.toHaveBeenCalled();

    mockGetWorktreeChangesWithStats.mockClear();
    await vi.advanceTimersByTimeAsync(TEST_CONFIG.pollIntervalMax * 2);
    expect(mockGetWorktreeChangesWithStats).not.toHaveBeenCalled();
  });

  it("calls onUpdate on successful git status", async () => {
    mockGetWorktreeChangesWithStats.mockResolvedValue({
      worktreeId: "/test/worktree",
      rootPath: "/test",
      changes: [],
      changedFileCount: 0,
      totalInsertions: 0,
      totalDeletions: 0,
      insertions: 0,
      deletions: 0,
      latestFileMtime: 0,
      lastUpdated: Date.now(),
    });

    const callbacks = makeCallbacks();
    const monitor = new WorktreeMonitor(TEST_WORKTREE, TEST_CONFIG, callbacks, "main");

    await monitor.start();
    await flushInitialStatus();

    expect(callbacks.onUpdate).toHaveBeenCalled();
    expect(callbacks.onRemoved).not.toHaveBeenCalled();

    monitor.stop();
  });

  it("does not call onRemoved for non-removal errors", async () => {
    mockGetWorktreeChangesWithStats.mockRejectedValue(new Error("network timeout"));

    const callbacks = makeCallbacks();
    const monitor = new WorktreeMonitor(TEST_WORKTREE, TEST_CONFIG, callbacks, "main");

    // Background monitor: the deferred initial poll surfaces non-removal
    // errors via mood=error + emit instead of propagating the rejection.
    await monitor.start();
    await flushInitialStatus();

    expect(callbacks.onRemoved).not.toHaveBeenCalled();
    expect(callbacks.onUpdate).toHaveBeenCalled();
    expect(monitor.getSnapshot().mood).toBe("error");

    monitor.stop();
  });

  describe("refresh() path-existence preflight (#8510)", () => {
    const SUCCESS_STATS = {
      worktreeId: "/test/worktree",
      rootPath: "/test",
      changes: [],
      changedFileCount: 0,
      totalInsertions: 0,
      totalDeletions: 0,
      insertions: 0,
      deletions: 0,
      latestFileMtime: 0,
      lastUpdated: Date.now(),
    };

    it("stops and calls onRemoved when the worktree path is gone (ENOENT)", async () => {
      mockGetWorktreeChangesWithStats.mockResolvedValue(SUCCESS_STATS);

      const callbacks = makeCallbacks();
      const monitor = new WorktreeMonitor(TEST_WORKTREE, TEST_CONFIG, callbacks, "main");
      await monitor.start();
      await flushInitialStatus();

      // Path disappears after the monitor is up and running.
      vi.mocked(access).mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
      mockGetWorktreeChangesWithStats.mockClear();
      vi.mocked(callbacks.onRemoved!).mockClear();

      await monitor.refresh();

      expect(callbacks.onRemoved).toHaveBeenCalledWith("/test/worktree");
      expect(callbacks.onRemoved).toHaveBeenCalledTimes(1);
      // Preflight short-circuits before the git status path runs.
      expect(mockGetWorktreeChangesWithStats).not.toHaveBeenCalled();

      // Idempotent: a concurrent/repeat refresh after stop() must not re-emit.
      await monitor.refresh();
      expect(callbacks.onRemoved).toHaveBeenCalledTimes(1);

      monitor.stop();
    });

    it("falls through to a normal refresh on non-ENOENT access errors", async () => {
      mockGetWorktreeChangesWithStats.mockResolvedValue(SUCCESS_STATS);

      const callbacks = makeCallbacks();
      const monitor = new WorktreeMonitor(TEST_WORKTREE, TEST_CONFIG, callbacks, "main");
      await monitor.start();
      await flushInitialStatus();

      vi.mocked(access).mockRejectedValue(Object.assign(new Error("EACCES"), { code: "EACCES" }));
      mockGetWorktreeChangesWithStats.mockClear();
      vi.mocked(callbacks.onRemoved!).mockClear();

      await monitor.refresh();

      // A permission blip must not be misclassified as a removal.
      expect(callbacks.onRemoved).not.toHaveBeenCalled();
      expect(mockGetWorktreeChangesWithStats).toHaveBeenCalled();

      monitor.stop();
    });
  });

  it("includes createdAt and lifecycleStatus in snapshot", () => {
    const callbacks = makeCallbacks();
    const monitor = new WorktreeMonitor(TEST_WORKTREE, TEST_CONFIG, callbacks, "main");
    monitor.setCreatedAt(1234567890);
    monitor.setLifecycleStatus({
      phase: "setup",
      state: "running",
      totalCommands: 1,
      startedAt: 1234567890,
    });

    const snapshot = monitor.getSnapshot();
    expect(snapshot.createdAt).toBe(1234567890);
    expect(snapshot.lifecycleStatus).toEqual(
      expect.objectContaining({ phase: "setup", state: "running" })
    );
  });

  describe("lifecycle phase results accumulator", () => {
    function phaseResult(
      overrides: Partial<import("../../../shared/types/worktree.js").WorktreeLifecyclePhaseResult>
    ): import("../../../shared/types/worktree.js").WorktreeLifecyclePhaseResult {
      return {
        phase: "resource-teardown",
        state: "success",
        category: "billing-critical",
        exitCode: 0,
        signalName: null,
        startedAt: 1,
        completedAt: 2,
        ...overrides,
      };
    }

    it("omits lifecyclePhaseResults from the snapshot when empty", () => {
      const monitor = new WorktreeMonitor(TEST_WORKTREE, TEST_CONFIG, makeCallbacks(), "main");
      expect(monitor.getSnapshot().lifecyclePhaseResults).toBeUndefined();
    });

    it("records phase results and surfaces a copy in the snapshot", () => {
      const monitor = new WorktreeMonitor(TEST_WORKTREE, TEST_CONFIG, makeCallbacks(), "main");
      monitor.recordLifecyclePhaseResult(
        phaseResult({ phase: "resource-teardown", state: "failed", exitCode: 1 })
      );
      monitor.recordLifecyclePhaseResult(
        phaseResult({ phase: "teardown", state: "success", category: "cosmetic" })
      );

      const results = monitor.getSnapshot().lifecyclePhaseResults;
      expect(results).toHaveLength(2);
      expect(results?.[0]).toMatchObject({
        phase: "resource-teardown",
        state: "failed",
        category: "billing-critical",
        exitCode: 1,
      });
      expect(results?.[1]).toMatchObject({ phase: "teardown", category: "cosmetic" });
      // Snapshot must be a copy — mutating internal state later must not leak.
      monitor.clearLifecyclePhaseResults();
      expect(results).toHaveLength(2);
    });

    it("upserts by phase rather than duplicating", () => {
      const monitor = new WorktreeMonitor(TEST_WORKTREE, TEST_CONFIG, makeCallbacks(), "main");
      monitor.recordLifecyclePhaseResult(phaseResult({ phase: "resource-teardown", exitCode: 1 }));
      monitor.recordLifecyclePhaseResult(phaseResult({ phase: "resource-teardown", exitCode: 0 }));

      const results = monitor.getSnapshot().lifecyclePhaseResults;
      expect(results).toHaveLength(1);
      expect(results?.[0].exitCode).toBe(0);
    });

    it("clearLifecyclePhaseResults resets the accumulator", () => {
      const monitor = new WorktreeMonitor(TEST_WORKTREE, TEST_CONFIG, makeCallbacks(), "main");
      monitor.recordLifecyclePhaseResult(phaseResult({}));
      monitor.clearLifecyclePhaseResults();
      expect(monitor.getSnapshot().lifecyclePhaseResults).toBeUndefined();
    });
  });

  it("includes prTitle and issueTitle in snapshot after setPRInfo", () => {
    const callbacks = makeCallbacks();
    const monitor = new WorktreeMonitor(TEST_WORKTREE, TEST_CONFIG, callbacks, "main");
    monitor.setPRInfo({
      prNumber: 42,
      prUrl: "https://github.com/test/pr/42",
      prState: "open",
      prTitle: "Fix bug",
      issueTitle: "Bug report",
    });

    const snapshot = monitor.getSnapshot();
    expect(snapshot.prNumber).toBe(42);
    expect(snapshot.prTitle).toBe("Fix bug");
    expect(snapshot.issueTitle).toBe("Bug report");
  });

  it("clearPRInfo removes PR fields", () => {
    const callbacks = makeCallbacks();
    const monitor = new WorktreeMonitor(TEST_WORKTREE, TEST_CONFIG, callbacks, "main");
    monitor.setPRInfo({ prNumber: 42, prUrl: "url", prState: "open", prTitle: "Title" });
    monitor.clearPRInfo();

    const snapshot = monitor.getSnapshot();
    expect(snapshot.prNumber).toBeUndefined();
    expect(snapshot.prTitle).toBeUndefined();
  });

  it("setPRInfo carries prCiStatus into the snapshot", () => {
    const callbacks = makeCallbacks();
    const monitor = new WorktreeMonitor(TEST_WORKTREE, TEST_CONFIG, callbacks, "main");
    monitor.setPRInfo({
      prNumber: 42,
      prUrl: "https://github.com/test/pr/42",
      prState: "open",
      prCiStatus: "success",
    });

    const snapshot = monitor.getSnapshot();
    expect(snapshot.prCiStatus).toBe("success");
  });

  it("setPRInfo with no prCiStatus clears any prior CI value (full-replace semantics)", () => {
    const callbacks = makeCallbacks();
    const monitor = new WorktreeMonitor(TEST_WORKTREE, TEST_CONFIG, callbacks, "main");
    monitor.setPRInfo({
      prNumber: 42,
      prUrl: "url",
      prState: "open",
      prCiStatus: "failure",
    });
    expect(monitor.getSnapshot().prCiStatus).toBe("failure");

    monitor.setPRInfo({ prNumber: 42, prUrl: "url", prState: "open" });
    expect(monitor.getSnapshot().prCiStatus).toBeUndefined();
  });

  it("clearPRInfo also clears prCiStatus", () => {
    const callbacks = makeCallbacks();
    const monitor = new WorktreeMonitor(TEST_WORKTREE, TEST_CONFIG, callbacks, "main");
    monitor.setPRInfo({
      prNumber: 42,
      prUrl: "url",
      prState: "open",
      prCiStatus: "pending",
    });
    monitor.clearPRInfo();

    expect(monitor.getSnapshot().prCiStatus).toBeUndefined();
  });

  describe("branchDerivedTitle in snapshot (#8851)", () => {
    it("populates branchDerivedTitle from the worktree's initial branch", async () => {
      const { deriveIssueTitleFromBranch } = await import("../../services/issueExtractor.js");
      vi.mocked(deriveIssueTitleFromBranch).mockReturnValue("Surface assistant launch");

      const monitor = new WorktreeMonitor(
        { ...TEST_WORKTREE, branch: "feature/issue-8773-surface-assistant-launch" },
        TEST_CONFIG,
        makeCallbacks(),
        "main"
      );

      expect(monitor.getSnapshot().branchDerivedTitle).toBe("Surface assistant launch");
    });

    it("recomputes branchDerivedTitle when branch is replaced via the setter", async () => {
      const { deriveIssueTitleFromBranch } = await import("../../services/issueExtractor.js");
      vi.mocked(deriveIssueTitleFromBranch)
        .mockReturnValueOnce("First title")
        .mockReturnValueOnce("Second title");

      const monitor = new WorktreeMonitor(
        { ...TEST_WORKTREE, branch: "feature/issue-1-first" },
        TEST_CONFIG,
        makeCallbacks(),
        "main"
      );
      expect(monitor.getSnapshot().branchDerivedTitle).toBe("First title");

      monitor.branch = "feature/issue-2-second";
      expect(monitor.getSnapshot().branchDerivedTitle).toBe("Second title");
    });

    it("leaves branchDerivedTitle undefined when the branch lacks an issue-<n>-<slug> pattern", async () => {
      const { deriveIssueTitleFromBranch } = await import("../../services/issueExtractor.js");
      vi.mocked(deriveIssueTitleFromBranch).mockReturnValue(undefined);

      const monitor = new WorktreeMonitor(
        { ...TEST_WORKTREE, branch: "main" },
        TEST_CONFIG,
        makeCallbacks(),
        "main"
      );

      expect(monitor.getSnapshot().branchDerivedTitle).toBeUndefined();
    });
  });

  describe("linked is the source of truth (#8452)", () => {
    it("derives flat fields from a non-GitHub linked projection", () => {
      const monitor = new WorktreeMonitor(TEST_WORKTREE, TEST_CONFIG, makeCallbacks(), "main");
      monitor.setLinked({
        providerId: "acme.gitlab",
        pr: {
          ref: {
            providerId: "acme.gitlab",
            owner: "acme-corp",
            repo: "my-project",
            number: 1234,
            rawData: null,
          },
          title: "Add widget",
          url: "https://gitlab.acme.com/acme-corp/my-project/-/merge_requests/1234",
          state: "open",
          ciStatus: {
            state: "failure",
            total: 3,
            passed: 1,
            failed: 2,
            pending: 0,
            rawData: null,
          },
        },
        issue: {
          ref: {
            providerId: "acme.gitlab",
            owner: "acme-corp",
            repo: "my-project",
            number: 88,
            rawData: null,
          },
          title: "Widget request",
        },
      });

      const snapshot = monitor.getSnapshot();
      // Flat fields are derived from linked, not collapsed to GitHub defaults.
      expect(snapshot.prNumber).toBe(1234);
      expect(snapshot.prUrl).toBe(
        "https://gitlab.acme.com/acme-corp/my-project/-/merge_requests/1234"
      );
      expect(snapshot.prState).toBe("open");
      expect(snapshot.prTitle).toBe("Add widget");
      expect(snapshot.prCiStatus).toBe("failure");
      expect(snapshot.issueNumber).toBe(88);
      expect(snapshot.issueTitle).toBe("Widget request");
      // The canonical owner/repo survive on the linked projection itself.
      expect(snapshot.linked?.pr?.ref.owner).toBe("acme-corp");
      expect(snapshot.linked?.pr?.ref.repo).toBe("my-project");
    });

    it("maps the declined PR state down to closed for the flat field", () => {
      const monitor = new WorktreeMonitor(TEST_WORKTREE, TEST_CONFIG, makeCallbacks(), "main");
      monitor.setLinked({
        providerId: "acme.bitbucket",
        pr: {
          ref: {
            providerId: "acme.bitbucket",
            owner: "acme-corp",
            repo: "my-project",
            number: 5,
            rawData: null,
          },
          url: "u",
          state: "declined",
        },
      });
      const snapshot = monitor.getSnapshot();
      expect(snapshot.prState).toBe("closed");
      // The canonical projection keeps the full provider state.
      expect(snapshot.linked?.pr?.state).toBe("declined");
    });

    it("collapses a declined legacy flat prState to closed when linked is unset (#9981)", () => {
      const monitor = new WorktreeMonitor(TEST_WORKTREE, TEST_CONFIG, makeCallbacks(), "main");
      monitor.setPRInfo({ prNumber: 5, prUrl: "u", prState: "declined" });
      const snapshot = monitor.getSnapshot();
      expect(snapshot.linked).toBeUndefined();
      expect(snapshot.prState).toBe("closed");
    });

    it("clearLinked after a declined PR leaves no stale flat state (#9981)", () => {
      const monitor = new WorktreeMonitor(TEST_WORKTREE, TEST_CONFIG, makeCallbacks(), "main");
      monitor.setLinked({
        providerId: "acme.bitbucket",
        pr: {
          ref: {
            providerId: "acme.bitbucket",
            owner: "acme-corp",
            repo: "my-project",
            number: 5,
            rawData: null,
          },
          url: "u",
          state: "declined",
        },
      });
      expect(monitor.getSnapshot().prState).toBe("closed");

      monitor.clearLinked();
      const snapshot = monitor.getSnapshot();
      // null, not undefined — #8870 distinguishes "ran and cleared" from "never ran".
      expect(snapshot.linked).toBeNull();
      expect(snapshot.prState).toBeUndefined();
    });

    it("falls back to legacy flat fields when linked is unset", () => {
      // `_linked` initializes to `undefined` (#8870 — distinguishes "PR
      // service hasn't run" from "ran and found no link"). The legacy flat
      // fields populated via setPRInfo remain the source until setLinked
      // or clearLinked fires.
      const monitor = new WorktreeMonitor(TEST_WORKTREE, TEST_CONFIG, makeCallbacks(), "main");
      monitor.setPRInfo({ prNumber: 42, prUrl: "url", prState: "open", prTitle: "Legacy" });
      const snapshot = monitor.getSnapshot();
      expect(snapshot.linked).toBeUndefined();
      expect(snapshot.prNumber).toBe(42);
      expect(snapshot.prTitle).toBe("Legacy");
    });

    it("clearLinked reverts flat-field derivation to the legacy fields", () => {
      const monitor = new WorktreeMonitor(TEST_WORKTREE, TEST_CONFIG, makeCallbacks(), "main");
      monitor.setPRInfo({ prNumber: 7, prUrl: "legacy-url", prState: "merged" });
      monitor.setLinked({
        providerId: "acme.gitlab",
        pr: {
          ref: {
            providerId: "acme.gitlab",
            owner: "acme-corp",
            repo: "my-project",
            number: 999,
            rawData: null,
          },
          url: "linked-url",
          state: "open",
        },
      });
      expect(monitor.getSnapshot().prNumber).toBe(999);

      monitor.clearLinked();
      const snapshot = monitor.getSnapshot();
      expect(snapshot.prNumber).toBe(7);
      expect(snapshot.prUrl).toBe("legacy-url");
    });
  });

  it("hasInitialStatus is false before start", () => {
    const callbacks = makeCallbacks();
    const monitor = new WorktreeMonitor(TEST_WORKTREE, TEST_CONFIG, callbacks, "main");
    expect(monitor.hasInitialStatus).toBe(false);
  });

  it("hasInitialStatus is true after successful updateGitStatus", async () => {
    mockGetWorktreeChangesWithStats.mockResolvedValue({
      worktreeId: "/test/worktree",
      rootPath: "/test",
      changes: [],
      changedFileCount: 0,
      lastUpdated: Date.now(),
    });

    const callbacks = makeCallbacks();
    const monitor = new WorktreeMonitor(TEST_WORKTREE, TEST_CONFIG, callbacks, "main");
    await monitor.start();
    await flushInitialStatus();

    expect(monitor.hasInitialStatus).toBe(true);

    monitor.stop();
  });

  it("isMainWorktree is settable", () => {
    const callbacks = makeCallbacks();
    const monitor = new WorktreeMonitor(TEST_WORKTREE, TEST_CONFIG, callbacks, "main");
    expect(monitor.isMainWorktree).toBe(false);
    monitor.isMainWorktree = true;
    expect(monitor.isMainWorktree).toBe(true);
  });

  describe("ahead/behind upstream tracking", () => {
    const cleanChangesWith = (overrides: {
      ahead?: number;
      behind?: number;
      tracking?: string | null;
    }) => ({
      worktreeId: "/test/worktree",
      rootPath: "/test",
      changes: [],
      changedFileCount: 0,
      lastUpdated: Date.now(),
      ...overrides,
    });

    it("includes aheadCount and behindCount in snapshot when upstream is configured", async () => {
      mockGetWorktreeChangesWithStats.mockResolvedValue(
        cleanChangesWith({ tracking: "origin/main", ahead: 3, behind: 1 })
      );

      const callbacks = makeCallbacks();
      const monitor = new WorktreeMonitor(TEST_WORKTREE, TEST_CONFIG, callbacks, "main");
      await monitor.start();
      await flushInitialStatus();

      const snapshot = monitor.getSnapshot();
      expect(snapshot.aheadCount).toBe(3);
      expect(snapshot.behindCount).toBe(1);

      monitor.stop();
    });

    it("leaves counts undefined when no upstream is configured", async () => {
      mockGetWorktreeChangesWithStats.mockResolvedValue(cleanChangesWith({ tracking: null }));

      const callbacks = makeCallbacks();
      const monitor = new WorktreeMonitor(TEST_WORKTREE, TEST_CONFIG, callbacks, "main");
      await monitor.start();
      await flushInitialStatus();

      const snapshot = monitor.getSnapshot();
      expect(snapshot.aheadCount).toBeUndefined();
      expect(snapshot.behindCount).toBeUndefined();

      monitor.stop();
    });

    it("computes base-branch divergence from rev-list in addition to upstream counts from git status", async () => {
      mockGetWorktreeChangesWithStats.mockResolvedValue(
        cleanChangesWith({ tracking: "origin/main", ahead: 2, behind: 0 })
      );

      const callbacks = makeCallbacks();
      const monitor = new WorktreeMonitor(TEST_WORKTREE, TEST_CONFIG, callbacks, "main");
      await monitor.start();
      await flushInitialStatus();
      await monitor.updateGitStatus(false);

      expect(mockGitRaw).toHaveBeenCalledWith(expect.arrayContaining(["rev-list"]));

      monitor.stop();
    });

    it("diffs base divergence against the constructor main branch when no PR is linked", async () => {
      mockGetWorktreeChangesWithStats.mockResolvedValue(
        cleanChangesWith({ tracking: "origin/test-branch", ahead: 1, behind: 0 })
      );
      mockGitRaw.mockResolvedValue("0\t3\n");

      const monitor = new WorktreeMonitor(TEST_WORKTREE, TEST_CONFIG, makeCallbacks(), "develop");
      await monitor.start();
      await flushInitialStatus();

      expect(mockGitRaw).toHaveBeenCalledWith([
        "rev-list",
        "--count",
        "--left-right",
        "origin/develop...HEAD",
      ]);
      expect(monitor.getSnapshot().baseBranchName).toBe("develop");

      monitor.stop();
    });

    it("diffs base divergence against the linked PR's base branch, overriding the main branch", async () => {
      mockGetWorktreeChangesWithStats.mockResolvedValue(
        cleanChangesWith({ tracking: "origin/test-branch", ahead: 1, behind: 0 })
      );
      mockGitRaw.mockResolvedValue("0\t3\n");

      // Repo main branch is "main", but this worktree's PR targets "develop".
      const monitor = new WorktreeMonitor(TEST_WORKTREE, TEST_CONFIG, makeCallbacks(), "main");
      monitor.setLinked({
        providerId: "github",
        pr: {
          ref: { providerId: "github", owner: "o", repo: "r", number: 7, rawData: null },
          url: "u",
          state: "open",
          baseRef: "develop",
        },
      });
      await monitor.start();
      await flushInitialStatus();

      expect(mockGitRaw).toHaveBeenCalledWith([
        "rev-list",
        "--count",
        "--left-right",
        "origin/develop...HEAD",
      ]);
      expect(mockGitRaw).not.toHaveBeenCalledWith([
        "rev-list",
        "--count",
        "--left-right",
        "origin/main...HEAD",
      ]);
      expect(monitor.getSnapshot().baseBranchName).toBe("develop");

      monitor.stop();
    });

    it("setMainBranch updates the base divergence fallback for an existing monitor", async () => {
      mockGetWorktreeChangesWithStats.mockResolvedValue(
        cleanChangesWith({ tracking: "origin/test-branch", ahead: 1, behind: 0 })
      );
      mockGitRaw.mockResolvedValue("0\t3\n");

      const monitor = new WorktreeMonitor(TEST_WORKTREE, TEST_CONFIG, makeCallbacks(), "main");
      monitor.setMainBranch("develop");
      await monitor.start();
      await flushInitialStatus();

      expect(monitor.getSnapshot().baseBranchName).toBe("develop");

      monitor.stop();
    });

    it("falls back to the local base ref when origin/<base> can't be resolved", async () => {
      mockGetWorktreeChangesWithStats.mockResolvedValue(
        cleanChangesWith({ tracking: "origin/test-branch", ahead: 1, behind: 0 })
      );
      mockGitRaw.mockImplementation((args: string[]) => {
        if (args[0] === "rev-parse") return Promise.resolve("abc\nabc\n");
        if (args.includes("origin/main...HEAD")) {
          return Promise.reject(new Error("unknown revision"));
        }
        return Promise.resolve("1\t4\n");
      });

      const monitor = new WorktreeMonitor(TEST_WORKTREE, TEST_CONFIG, makeCallbacks(), "main");
      await monitor.start();
      await flushInitialStatus();

      expect(mockGitRaw).toHaveBeenCalledWith([
        "rev-list",
        "--count",
        "--left-right",
        "main...HEAD",
      ]);
      const snapshot = monitor.getSnapshot();
      expect(snapshot.baseBranchName).toBe("main");
      expect(snapshot.baseBehindCount).toBe(1);
      expect(snapshot.baseAheadCount).toBe(4);
      expect(snapshot.baseMatchesUpstream).toBe(true);
      expect(mockGitRaw).toHaveBeenCalledWith(["rev-parse", "@{u}", "main"]);

      monitor.stop();
    });

    it("reuses cached divergence on forced passes until a tracked ref's stat changes", async () => {
      vi.mocked(getGitDir).mockResolvedValue("/test/worktree/.git");
      vi.mocked(readFile).mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
      vi.mocked(stat).mockResolvedValue({ mtimeMs: 1_000 } as unknown as Awaited<
        ReturnType<typeof stat>
      >);
      mockGetWorktreeChangesWithStats.mockResolvedValue(cleanChangesWith({ tracking: null }));
      mockGitRaw.mockResolvedValue("2\t5\n");

      const revListCalls = () =>
        mockGitRaw.mock.calls.filter((c) => Array.isArray(c[0]) && c[0][0] === "rev-list").length;

      const monitor = new WorktreeMonitor(TEST_WORKTREE, TEST_CONFIG, makeCallbacks(), "main");
      await monitor.start();
      await flushInitialStatus();
      expect(revListCalls()).toBe(1);
      expect(monitor.getSnapshot().baseAheadCount).toBe(5);
      expect(monitor.getSnapshot().baseBehindCount).toBe(2);

      // Forced pass with unchanged refs: divergence comes from the cache.
      await monitor.updateGitStatus(true);
      expect(revListCalls()).toBe(1);
      expect(monitor.getSnapshot().baseAheadCount).toBe(5);

      // A background fetch writes the loose remote base ref without touching
      // packed-refs — the cache key must notice and recompute.
      vi.mocked(stat).mockImplementation(async (p) => {
        const normalizedPath = String(p).replace(/\\/g, "/");
        const mtimeMs = normalizedPath.endsWith("origin/main") ? 2_000 : 1_000;
        return { mtimeMs } as unknown as Awaited<ReturnType<typeof stat>>;
      });
      mockGitRaw.mockResolvedValue("0\t5\n");
      await monitor.updateGitStatus(true);
      expect(revListCalls()).toBe(2);
      expect(monitor.getSnapshot().baseBehindCount).toBe(0);

      monitor.stop();
    });

    it("reports zero counts when branch is in sync with upstream", async () => {
      mockGetWorktreeChangesWithStats.mockResolvedValue(
        cleanChangesWith({ tracking: "origin/main", ahead: 0, behind: 0 })
      );

      const callbacks = makeCallbacks();
      const monitor = new WorktreeMonitor(TEST_WORKTREE, TEST_CONFIG, callbacks, "main");
      await monitor.start();
      await flushInitialStatus();

      const snapshot = monitor.getSnapshot();
      expect(snapshot.aheadCount).toBe(0);
      expect(snapshot.behindCount).toBe(0);

      monitor.stop();
    });

    it("clears stale counts when upstream is removed between polls", async () => {
      mockGetWorktreeChangesWithStats.mockResolvedValueOnce(
        cleanChangesWith({ tracking: "origin/main", ahead: 2, behind: 1 })
      );
      mockGetWorktreeChangesWithStats.mockResolvedValueOnce(cleanChangesWith({ tracking: null }));

      const callbacks = makeCallbacks();
      const monitor = new WorktreeMonitor(TEST_WORKTREE, TEST_CONFIG, callbacks, "main");
      await monitor.start();
      await flushInitialStatus();
      expect(monitor.getSnapshot().aheadCount).toBe(2);
      expect(monitor.getSnapshot().behindCount).toBe(1);

      await monitor.refresh();

      expect(monitor.getSnapshot().aheadCount).toBeUndefined();
      expect(monitor.getSnapshot().behindCount).toBeUndefined();

      monitor.stop();
    });

    it("treats empty-string tracking as no upstream", async () => {
      mockGetWorktreeChangesWithStats.mockResolvedValue(
        cleanChangesWith({ tracking: "", ahead: 0, behind: 0 })
      );

      const callbacks = makeCallbacks();
      const monitor = new WorktreeMonitor(TEST_WORKTREE, TEST_CONFIG, callbacks, "main");
      await monitor.start();
      await flushInitialStatus();

      const snapshot = monitor.getSnapshot();
      expect(snapshot.aheadCount).toBeUndefined();
      expect(snapshot.behindCount).toBeUndefined();

      monitor.stop();
    });
  });

  describe("external classification (#11434)", () => {
    // The monitor copies selected Worktree fields into private state rather than
    // retaining the object, so a field it doesn't copy never reaches a snapshot.
    it("carries the constructor's classification into the snapshot", () => {
      const external = new WorktreeMonitor(
        { ...TEST_WORKTREE, isExternal: true },
        TEST_CONFIG,
        makeCallbacks(),
        "main"
      );
      const internal = new WorktreeMonitor(
        { ...TEST_WORKTREE, isExternal: false },
        TEST_CONFIG,
        makeCallbacks(),
        "main"
      );

      expect(external.getSnapshot().isExternal).toBe(true);
      expect(internal.getSnapshot().isExternal).toBe(false);
    });

    it("keeps an unknown classification unknown rather than coercing it to false", () => {
      const monitor = new WorktreeMonitor(TEST_WORKTREE, TEST_CONFIG, makeCallbacks(), "main");

      expect(monitor.getSnapshot().isExternal).toBeUndefined();
    });

    it("reflects a reconciled classification through the setter", () => {
      const monitor = new WorktreeMonitor(
        { ...TEST_WORKTREE, isExternal: false },
        TEST_CONFIG,
        makeCallbacks(),
        "main"
      );

      monitor.isExternal = true;
      expect(monitor.getSnapshot().isExternal).toBe(true);

      monitor.isExternal = undefined;
      expect(monitor.getSnapshot().isExternal).toBeUndefined();
    });
  });
});
