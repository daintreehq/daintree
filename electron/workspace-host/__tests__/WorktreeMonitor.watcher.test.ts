import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Worktree } from "../../../shared/types/worktree.js";
import type { PluginWorktreeLinked } from "../../../shared/types/plugin.js";
import { BUILTIN_GITHUB_PROVIDER_ID } from "../../../shared/utils/forgeProviderIds.js";
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
  getRepoOperationState: async (...args: unknown[]) => mockGetRepoOperationStateSync(...args),
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
let capturedOnWatcherFailed: (() => void) | undefined;
let capturedOnInotifyLimitReached: ((limit: "watches" | "instances") => void) | undefined;
let capturedOnEmfileLimitReached: (() => void) | undefined;
let capturedWatcherOptions: Record<string, unknown> | undefined;
const capturedWatcherOptionsHistory: Record<string, unknown>[] = [];
let watcherStartCallCount = 0;

interface MockWatcherHandle {
  updateDebouncePolicy(policy: Record<string, unknown>): void;
}
/** Every debounce retime pushed to a LIVE watcher, newest last. */
let debouncePolicyUpdates: Record<string, unknown>[] = [];
let capturedWatchers: MockWatcherHandle[] = [];

vi.mock("../../utils/gitFileWatcher.js", () => {
  return {
    GitFileWatcher: class {
      private readonly onWatcherFailed?: () => void;
      private readonly watchWorktree: boolean;
      constructor(
        opts: {
          onWatcherFailed?: () => void;
          onInotifyLimitReached?: (limit: "watches" | "instances") => void;
          onEmfileLimitReached?: () => void;
          watchWorktree?: boolean;
        } & Record<string, unknown>
      ) {
        this.onWatcherFailed = opts.onWatcherFailed;
        this.watchWorktree = opts.watchWorktree === true;
        capturedOnWatcherFailed = opts.onWatcherFailed;
        capturedOnInotifyLimitReached = opts.onInotifyLimitReached;
        capturedOnEmfileLimitReached = opts.onEmfileLimitReached;
        capturedWatcherOptions = opts;
        capturedWatcherOptionsHistory.push(opts);
        capturedWatchers.push(this as unknown as MockWatcherHandle);
      }
      updateDebouncePolicy(policy: Record<string, unknown>) {
        debouncePolicyUpdates.push(policy);
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
import { clearGitDirCache, getGitDir } from "../../utils/gitUtils.js";
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
    capturedOnWatcherFailed = undefined;
    capturedOnInotifyLimitReached = undefined;
    capturedOnEmfileLimitReached = undefined;
    capturedWatcherOptions = undefined;
    debouncePolicyUpdates = [];
    capturedWatchers = [];
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

  describe("issue number carried by the linked PR (#12381)", () => {
    const githubPr: PluginWorktreeLinked = {
      providerId: BUILTIN_GITHUB_PROVIDER_ID,
      pr: {
        ref: {
          providerId: BUILTIN_GITHUB_PROVIDER_ID,
          owner: "daintreehq",
          repo: "daintree",
          number: 12189,
          rawData: null,
        },
        url: "https://github.com/daintreehq/daintree/pull/12189",
        state: "open",
      },
    };

    // onIssueNotFound clears the title and onPRDetected links the PR. Their
    // lookups settle in either order, so the projection must hold after each
    // step of both sequences, not just once both have landed.
    it("keeps the phantom issue out of the snapshot whichever state change lands first", () => {
      const notFoundFirst = new WorktreeMonitor(
        TEST_WORKTREE,
        TEST_CONFIG,
        makeCallbacks(),
        "main"
      );
      notFoundFirst.setIssueNumber(12189);
      notFoundFirst.setIssueTitle("Stale title");
      expect(notFoundFirst.getSnapshot().issueNumber).toBe(12189);
      notFoundFirst.setIssueTitle(undefined);
      notFoundFirst.setLinked(githubPr);
      expect(notFoundFirst.getSnapshot().issueNumber).toBeUndefined();

      const prFirst = new WorktreeMonitor(TEST_WORKTREE, TEST_CONFIG, makeCallbacks(), "main");
      prFirst.setIssueNumber(12189);
      prFirst.setIssueTitle("Stale title");
      prFirst.setLinked(githubPr);
      expect(prFirst.getSnapshot().issueNumber).toBeUndefined();
      expect(prFirst.getSnapshot().issueTitle).toBeUndefined();
      prFirst.setIssueTitle(undefined);

      for (const monitor of [notFoundFirst, prFirst]) {
        const snapshot = monitor.getSnapshot();
        expect(snapshot.issueNumber).toBeUndefined();
        expect(snapshot.issueTitle).toBeUndefined();
        expect(snapshot.prNumber).toBe(12189);
        // The raw parsed number stays so onIssueNotFound still matches its lookup.
        expect(monitor.issueNumber).toBe(12189);
      }
    });

    it("brings the parsed number back once the PR link is genuinely cleared", () => {
      const monitor = new WorktreeMonitor(TEST_WORKTREE, TEST_CONFIG, makeCallbacks(), "main");
      monitor.setIssueNumber(12189);
      monitor.setLinked(githubPr);
      expect(monitor.getSnapshot().issueNumber).toBeUndefined();

      monitor.clearPRInfo();
      monitor.clearLinked();
      expect(monitor.getSnapshot().issueNumber).toBe(12189);
    });
  });

  describe("branchDerivedTitle in snapshot (#8851)", () => {
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

  describe("watcher retry", () => {
    const WATCH_CONFIG: WorktreeMonitorConfig = {
      ...TEST_CONFIG,
      gitWatchEnabled: true,
    };

    // Active worktree — gets the recursive watcher under the focus-tier rules.
    const ACTIVE_WORKTREE: Worktree = { ...TEST_WORKTREE, isCurrent: true };

    it("background worktree starts with watchWorktree: false (focus-tier)", async () => {
      mockWatcherStartResult = true;
      mockGetWorktreeChangesWithStats.mockResolvedValue({
        worktreeId: "/test/worktree",
        rootPath: "/test",
        changes: [],
        changedFileCount: 0,
        lastUpdated: Date.now(),
      });

      const callbacks = makeCallbacks();
      const monitor = new WorktreeMonitor(TEST_WORKTREE, WATCH_CONFIG, callbacks, "main");
      await monitor.start();

      expect(capturedWatcherOptions).toMatchObject({ watchWorktree: false });
      expect(monitor.hasWatcher).toBe(true);

      monitor.stop();
    });

    it("isCurrent flip false→true upgrades watcher to recursive immediately", async () => {
      mockWatcherStartResult = true;
      mockGetWorktreeChangesWithStats.mockResolvedValue({
        worktreeId: "/test/worktree",
        rootPath: "/test",
        changes: [],
        changedFileCount: 0,
        lastUpdated: Date.now(),
      });

      const callbacks = makeCallbacks();
      const monitor = new WorktreeMonitor(TEST_WORKTREE, WATCH_CONFIG, callbacks, "main");
      await monitor.start();

      expect(capturedWatcherOptions).toMatchObject({ watchWorktree: false });
      const startsBeforeFlip = capturedWatcherOptionsHistory.length;

      monitor.isCurrent = true;

      // The setter rebuilt the watcher; latest call is the recursive arm.
      expect(capturedWatcherOptionsHistory.length).toBe(startsBeforeFlip + 1);
      expect(capturedWatcherOptionsHistory.at(-1)).toMatchObject({ watchWorktree: true });

      monitor.stop();
    });

    it("isCurrent flip true→false defers downgrade by the settle delay", async () => {
      mockWatcherStartResult = true;
      mockGetWorktreeChangesWithStats.mockResolvedValue({
        worktreeId: "/test/worktree",
        rootPath: "/test",
        changes: [],
        changedFileCount: 0,
        lastUpdated: Date.now(),
      });

      const callbacks = makeCallbacks();
      const monitor = new WorktreeMonitor(ACTIVE_WORKTREE, WATCH_CONFIG, callbacks, "main");
      await monitor.start();

      expect(capturedWatcherOptions).toMatchObject({ watchWorktree: true });
      const startsBeforeFlip = capturedWatcherOptionsHistory.length;

      monitor.isCurrent = false;

      // No synchronous downgrade — the recursive watcher is preserved while
      // the settle timer runs.
      expect(capturedWatcherOptionsHistory.length).toBe(startsBeforeFlip);

      // After the 3s settle delay the controller rebuilds in git-only mode.
      await vi.advanceTimersByTimeAsync(3_000);
      expect(capturedWatcherOptionsHistory.length).toBe(startsBeforeFlip + 1);
      expect(capturedWatcherOptionsHistory.at(-1)).toMatchObject({ watchWorktree: false });

      monitor.stop();
    });

    it("rapid isCurrent toggle cancels the deferred downgrade", async () => {
      mockWatcherStartResult = true;
      mockGetWorktreeChangesWithStats.mockResolvedValue({
        worktreeId: "/test/worktree",
        rootPath: "/test",
        changes: [],
        changedFileCount: 0,
        lastUpdated: Date.now(),
      });

      const callbacks = makeCallbacks();
      const monitor = new WorktreeMonitor(ACTIVE_WORKTREE, WATCH_CONFIG, callbacks, "main");
      await monitor.start();

      const startsBeforeFlip = capturedWatcherOptionsHistory.length;

      monitor.isCurrent = false;
      // Re-focus before the settle timer fires.
      await vi.advanceTimersByTimeAsync(1_000);
      monitor.isCurrent = true;

      // Let the original settle window elapse — no rebuild happened.
      await vi.advanceTimersByTimeAsync(5_000);
      expect(capturedWatcherOptionsHistory.length).toBe(startsBeforeFlip);
      expect(capturedWatcherOptionsHistory.at(-1)).toMatchObject({ watchWorktree: true });

      monitor.stop();
    });

    it("agentActive flip false→true upgrades a background watcher to recursive and forces a refresh", async () => {
      mockWatcherStartResult = true;
      mockGetWorktreeChangesWithStats.mockResolvedValue({
        worktreeId: "/test/worktree",
        rootPath: "/test",
        changes: [],
        changedFileCount: 0,
        lastUpdated: Date.now(),
      });

      const callbacks = makeCallbacks();
      const monitor = new WorktreeMonitor(TEST_WORKTREE, WATCH_CONFIG, callbacks, "main");
      await monitor.start();
      await flushInitialStatus();

      expect(capturedWatcherOptions).toMatchObject({ watchWorktree: false });
      const startsBeforeFlip = capturedWatcherOptionsHistory.length;
      const statusCallsBefore = mockGetWorktreeChangesWithStats.mock.calls.length;

      monitor.agentActive = true;

      // Immediate upgrade — an agent's edits must stream without waiting.
      expect(capturedWatcherOptionsHistory.length).toBe(startsBeforeFlip + 1);
      expect(capturedWatcherOptionsHistory.at(-1)).toMatchObject({ watchWorktree: true });

      // Activation also forces a status refresh so the card baselines now.
      await vi.advanceTimersByTimeAsync(0);
      expect(mockGetWorktreeChangesWithStats.mock.calls.length).toBe(statusCallsBefore + 1);

      monitor.stop();
    });

    it("losing focus while an agent works keeps the recursive watcher (elevation held)", async () => {
      mockWatcherStartResult = true;
      mockGetWorktreeChangesWithStats.mockResolvedValue({
        worktreeId: "/test/worktree",
        rootPath: "/test",
        changes: [],
        changedFileCount: 0,
        lastUpdated: Date.now(),
      });

      const callbacks = makeCallbacks();
      const monitor = new WorktreeMonitor(ACTIVE_WORKTREE, WATCH_CONFIG, callbacks, "main");
      await monitor.start();
      monitor.agentActive = true;
      await vi.advanceTimersByTimeAsync(0);

      const startsBeforeFlip = capturedWatcherOptionsHistory.length;
      monitor.isCurrent = false;
      await vi.advanceTimersByTimeAsync(5_000);

      // No rebuild: the working agent holds the elevation.
      expect(capturedWatcherOptionsHistory.length).toBe(startsBeforeFlip);
      expect(capturedWatcherOptionsHistory.at(-1)).toMatchObject({ watchWorktree: true });

      monitor.stop();
    });

    it("agentActive set before start arms recursive and runs the initial status synchronously", async () => {
      mockWatcherStartResult = true;
      mockGetWorktreeChangesWithStats.mockResolvedValue({
        worktreeId: "/test/worktree",
        rootPath: "/test",
        changes: [],
        changedFileCount: 0,
        lastUpdated: Date.now(),
      });

      const callbacks = makeCallbacks();
      const monitor = new WorktreeMonitor(TEST_WORKTREE, WATCH_CONFIG, callbacks, "main");
      // WorkspaceService.addNewWorktreeMonitor applies the retained
      // agent-activity set before start() — e.g. a worktree the agent itself
      // just created.
      monitor.agentActive = true;
      await monitor.start();

      expect(capturedWatcherOptions).toMatchObject({ watchWorktree: true });
      // Elevated start skips the 2-5s background jitter.
      expect(mockGetWorktreeChangesWithStats).toHaveBeenCalledTimes(1);

      const startsBeforeFlip = capturedWatcherOptionsHistory.length;
      monitor.agentActive = false;

      // Downgrade settles behind the same delay as focus loss.
      expect(capturedWatcherOptionsHistory.length).toBe(startsBeforeFlip);
      await vi.advanceTimersByTimeAsync(3_000);
      expect(capturedWatcherOptionsHistory.at(-1)).toMatchObject({ watchWorktree: false });

      monitor.stop();
    });

    it("watcher start failure schedules retry on active worktree", async () => {
      mockWatcherStartResult = false;
      mockGetWorktreeChangesWithStats.mockResolvedValue({
        worktreeId: "/test/worktree",
        rootPath: "/test",
        changes: [],
        changedFileCount: 0,
        lastUpdated: Date.now(),
      });

      const callbacks = makeCallbacks();
      const monitor = new WorktreeMonitor(ACTIVE_WORKTREE, WATCH_CONFIG, callbacks, "main");
      await monitor.start();

      expect(monitor.hasWatcher).toBe(false);

      // After retry interval, watcher should attempt again
      mockWatcherStartResult = true;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(monitor.hasWatcher).toBe(true);

      monitor.stop();
    });

    it("background worktree does not retry recursive arm — focus flip re-arms instead", async () => {
      // Background worktrees skip the recursive watcher entirely. The retry
      // loop is reserved for active worktrees so a sea of background tabs
      // can't keep poking inotify after ENOSPC.
      mockRecursiveStartResult = false;
      mockGitOnlyStartResult = true;
      mockGetWorktreeChangesWithStats.mockResolvedValue({
        worktreeId: "/test/worktree",
        rootPath: "/test",
        changes: [],
        changedFileCount: 0,
        lastUpdated: Date.now(),
      });

      const callbacks = makeCallbacks();
      const monitor = new WorktreeMonitor(TEST_WORKTREE, WATCH_CONFIG, callbacks, "main");
      await monitor.start();

      // Background → git-only mode; no recursive attempt.
      expect(monitor.hasWatcher).toBe(true);
      const startsAfterBackgroundStart = watcherStartCallCount;

      mockRecursiveStartResult = true;
      await vi.advanceTimersByTimeAsync(30_000);
      // No retry queued for background — start count is unchanged.
      expect(watcherStartCallCount).toBe(startsAfterBackgroundStart);

      monitor.stop();
    });

    it("retry timer is cleared on stop()", async () => {
      mockWatcherStartResult = false;
      mockGetWorktreeChangesWithStats.mockResolvedValue({
        worktreeId: "/test/worktree",
        rootPath: "/test",
        changes: [],
        changedFileCount: 0,
        lastUpdated: Date.now(),
      });

      const callbacks = makeCallbacks();
      const monitor = new WorktreeMonitor(ACTIVE_WORKTREE, WATCH_CONFIG, callbacks, "main");
      await monitor.start();

      monitor.stop();

      // After retry interval, watcher should NOT have started
      mockWatcherStartResult = true;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(monitor.hasWatcher).toBe(false);
    });

    it("max retries exhausted leaves monitor without watcher", async () => {
      mockWatcherStartResult = false;
      mockGetWorktreeChangesWithStats.mockResolvedValue({
        worktreeId: "/test/worktree",
        rootPath: "/test",
        changes: [],
        changedFileCount: 0,
        lastUpdated: Date.now(),
      });

      const callbacks = makeCallbacks();
      const monitor = new WorktreeMonitor(ACTIVE_WORKTREE, WATCH_CONFIG, callbacks, "main");
      await monitor.start();

      // Exhaust all 5 retries
      for (let i = 0; i < 5; i++) {
        await vi.advanceTimersByTimeAsync(30_000);
      }

      expect(monitor.hasWatcher).toBe(false);

      // One more interval should NOT trigger another retry
      mockWatcherStartResult = true;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(monitor.hasWatcher).toBe(false);

      monitor.stop();
    });

    it("runtime watcher failure preserves .git/ watchers via git-only fallback", async () => {
      // The recursive watcher fails at runtime — the per-file .git/
      // watchers must survive as a degraded watcher rather than going dark.
      mockRecursiveStartResult = true;
      mockGitOnlyStartResult = true;
      mockGetWorktreeChangesWithStats.mockResolvedValue({
        worktreeId: "/test/worktree",
        rootPath: "/test",
        changes: [],
        changedFileCount: 0,
        lastUpdated: Date.now(),
      });

      const callbacks = makeCallbacks();
      const monitor = new WorktreeMonitor(ACTIVE_WORKTREE, WATCH_CONFIG, callbacks, "main");
      await monitor.start();

      expect(monitor.hasWatcher).toBe(true);
      expect(capturedWatcherOptionsHistory.at(-1)).toMatchObject({ watchWorktree: true });
      const startsAfterInitialStart = watcherStartCallCount;

      // Simulate runtime watcher failure
      capturedOnWatcherFailed?.();

      // Watcher remains — git-only is now active. Last constructor call set
      // watchWorktree:false.
      expect(monitor.hasWatcher).toBe(true);
      expect(capturedWatcherOptionsHistory.at(-1)).toMatchObject({ watchWorktree: false });
      expect(watcherStartCallCount).toBe(startsAfterInitialStart + 1);

      // After retry interval, the recursive watcher attempts to re-arm.
      await vi.advanceTimersByTimeAsync(30_000);
      expect(capturedWatcherOptionsHistory.at(-1)).toMatchObject({ watchWorktree: true });
      expect(monitor.hasWatcher).toBe(true);

      monitor.stop();
    });

    it("forwards inotify-limit signal to callbacks with the worktree id", async () => {
      mockWatcherStartResult = true;
      mockGetWorktreeChangesWithStats.mockResolvedValue({
        worktreeId: "/test/worktree",
        rootPath: "/test",
        changes: [],
        changedFileCount: 0,
        lastUpdated: Date.now(),
      });

      const onInotifyLimitReached = vi.fn();
      const callbacks = makeCallbacks({ onInotifyLimitReached });
      const monitor = new WorktreeMonitor(ACTIVE_WORKTREE, WATCH_CONFIG, callbacks, "main");
      await monitor.start();

      expect(capturedOnInotifyLimitReached).toBeDefined();
      capturedOnInotifyLimitReached?.("instances");
      expect(onInotifyLimitReached).toHaveBeenCalledWith(ACTIVE_WORKTREE.id, "instances");
      expect(onInotifyLimitReached).toHaveBeenCalledTimes(1);

      monitor.stop();
    });

    it("forwards emfile-limit signal to callbacks with the worktree id", async () => {
      mockWatcherStartResult = true;
      mockGetWorktreeChangesWithStats.mockResolvedValue({
        worktreeId: "/test/worktree",
        rootPath: "/test",
        changes: [],
        changedFileCount: 0,
        lastUpdated: Date.now(),
      });

      const onEmfileLimitReached = vi.fn();
      const callbacks = makeCallbacks({ onEmfileLimitReached });
      const monitor = new WorktreeMonitor(ACTIVE_WORKTREE, WATCH_CONFIG, callbacks, "main");
      await monitor.start();

      expect(capturedOnEmfileLimitReached).toBeDefined();
      capturedOnEmfileLimitReached?.();
      expect(onEmfileLimitReached).toHaveBeenCalledWith(ACTIVE_WORKTREE.id);
      expect(onEmfileLimitReached).toHaveBeenCalledTimes(1);

      monitor.stop();
    });

    it("startup ENOSPC degrades to git-only and schedules a single retry", async () => {
      // Regression guard for the startup-ENOSPC retry fix combined with the
      // git-only preservation behaviour. The recursive arm fires
      // onWatcherFailed synchronously and returns false. WorktreeMonitor's
      // handleWatcherFailed installs git-only inline, then the else branch of
      // startWatcher must NOT install a duplicate git-only or schedule a
      // duplicate retry.
      mockRecursiveStartResult = false;
      mockGitOnlyStartResult = true;
      mockWatcherStartFiresFailure = true;
      mockGetWorktreeChangesWithStats.mockResolvedValue({
        worktreeId: "/test/worktree",
        rootPath: "/test",
        changes: [],
        changedFileCount: 0,
        lastUpdated: Date.now(),
      });

      const callbacks = makeCallbacks();
      const monitor = new WorktreeMonitor(ACTIVE_WORKTREE, WATCH_CONFIG, callbacks, "main");
      await monitor.start();

      // Initial recursive start failed → exactly one git-only fallback was
      // installed (not two), and a watcher is active.
      expect(monitor.hasWatcher).toBe(true);
      expect(capturedWatcherOptionsHistory.length).toBe(2);
      expect(capturedWatcherOptionsHistory[0]).toMatchObject({ watchWorktree: true });
      expect(capturedWatcherOptionsHistory[1]).toMatchObject({ watchWorktree: false });
      expect(watcherStartCallCount).toBe(2);

      // Flip to success for the retry attempt.
      mockWatcherStartFiresFailure = false;
      mockRecursiveStartResult = true;
      await vi.advanceTimersByTimeAsync(30_000);

      // One retry, not two: recursive re-armed, git-only swapped out.
      expect(watcherStartCallCount).toBe(3);
      expect(capturedWatcherOptionsHistory.at(-1)).toMatchObject({ watchWorktree: true });
      expect(monitor.hasWatcher).toBe(true);

      monitor.stop();
    });

    it("refresh() resets watcher retry budget so subsequent failures can schedule retries", async () => {
      mockRecursiveStartResult = false;
      mockGitOnlyStartResult = true;
      mockGetWorktreeChangesWithStats.mockResolvedValue({
        worktreeId: "/test/worktree",
        rootPath: "/test",
        changes: [],
        changedFileCount: 0,
        lastUpdated: Date.now(),
      });

      const callbacks = makeCallbacks();
      const monitor = new WorktreeMonitor(ACTIVE_WORKTREE, WATCH_CONFIG, callbacks, "main");
      await monitor.start();

      // Exhaust all 5 retries.
      for (let i = 0; i < 5; i++) {
        await vi.advanceTimersByTimeAsync(30_000);
      }
      const startsAtExhaustion = watcherStartCallCount;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(watcherStartCallCount).toBe(startsAtExhaustion);

      // refresh() resets budget and calls update() which fires
      // stop(false) + start("recursive") [fails] + start("git-only") [succeeds].
      await monitor.refresh();
      expect(watcherStartCallCount).toBe(startsAtExhaustion + 2);
      expect(clearGitDirCache).toHaveBeenCalledWith(ACTIVE_WORKTREE.path);

      // Recursive still fails — should schedule a retry with fresh budget.
      await vi.advanceTimersByTimeAsync(30_000);
      expect(watcherStartCallCount).toBe(startsAtExhaustion + 4);

      monitor.stop();
    });

    it("refresh() does not attempt re-arm when budget was not exhausted", async () => {
      mockRecursiveStartResult = true;
      mockGitOnlyStartResult = true;
      mockGetWorktreeChangesWithStats.mockResolvedValue({
        worktreeId: "/test/worktree",
        rootPath: "/test",
        changes: [],
        changedFileCount: 0,
        lastUpdated: Date.now(),
      });

      const callbacks = makeCallbacks();
      const monitor = new WorktreeMonitor(ACTIVE_WORKTREE, WATCH_CONFIG, callbacks, "main");
      await monitor.start();

      expect(monitor.hasWatcher).toBe(true);
      const startsBeforeRefresh = watcherStartCallCount;

      // refresh() when budget is zero no-ops — no extra watcher churn.
      await monitor.refresh();
      expect(watcherStartCallCount).toBe(startsBeforeRefresh);
      expect(clearGitDirCache).not.toHaveBeenCalled();

      monitor.stop();
    });

    it("ensureWatcherState during recursive backoff preserves retry budget", async () => {
      // Regression guard: ensureWatcherState() / focus rotation must not
      // reset the recursive-retry counter while a retry is already pending.
      // Otherwise an external workspace refresh during ENOSPC backoff grants
      // the failing recursive arm a fresh 5-attempt budget on the same
      // constrained kernel, hammering inotify.
      mockRecursiveStartResult = false;
      mockGitOnlyStartResult = true;
      mockGetWorktreeChangesWithStats.mockResolvedValue({
        worktreeId: "/test/worktree",
        rootPath: "/test",
        changes: [],
        changedFileCount: 0,
        lastUpdated: Date.now(),
      });

      const callbacks = makeCallbacks();
      const monitor = new WorktreeMonitor(ACTIVE_WORKTREE, WATCH_CONFIG, callbacks, "main");
      await monitor.start();

      // Recursive failed, git-only fallback installed, retry timer pending.
      expect(monitor.hasWatcher).toBe(true);
      expect(capturedWatcherOptionsHistory.at(-1)).toMatchObject({ watchWorktree: false });

      // External refresh — must not reset the retry budget.
      monitor.ensureWatcherState();

      // Burn through the budget. With a preserved counter, only the
      // remaining retries fire; reset would extend the loop.
      for (let i = 0; i < 5; i++) {
        await vi.advanceTimersByTimeAsync(30_000);
      }

      expect(monitor.hasWatcher).toBe(true);
      expect(capturedWatcherOptionsHistory.at(-1)).toMatchObject({ watchWorktree: false });

      // One more interval — budget exhausted, no further retry.
      const startsBeforeIdle = watcherStartCallCount;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(watcherStartCallCount).toBe(startsBeforeIdle);

      monitor.stop();
    });
  });

  describe("git-watch budget gate (#9538)", () => {
    const WATCH_CONFIG: WorktreeMonitorConfig = {
      ...TEST_CONFIG,
      gitWatchEnabled: true,
    };

    beforeEach(() => {
      mockWatcherStartResult = true;
      mockGetWorktreeChangesWithStats.mockResolvedValue({
        worktreeId: "/test/worktree",
        rootPath: "/test",
        changes: [],
        changedFileCount: 0,
        lastUpdated: Date.now(),
      });
    });

    it("revoking the budget stops the watcher; granting re-arms it", async () => {
      const monitor = new WorktreeMonitor(TEST_WORKTREE, WATCH_CONFIG, makeCallbacks(), "main");
      await monitor.start();
      expect(monitor.hasWatcher).toBe(true);
      expect(monitor.gitWatchBudgetGranted).toBe(true);

      monitor.setGitWatchBudgetAllowed(false);
      expect(monitor.hasWatcher).toBe(false);
      expect(monitor.gitWatchBudgetGranted).toBe(false);

      monitor.setGitWatchBudgetAllowed(true);
      expect(monitor.hasWatcher).toBe(true);
      expect(monitor.gitWatchBudgetGranted).toBe(true);

      monitor.stop();
    });

    it("is idempotent — re-applying the same value does not churn the watcher", async () => {
      const monitor = new WorktreeMonitor(TEST_WORKTREE, WATCH_CONFIG, makeCallbacks(), "main");
      await monitor.start();
      const startsAfterArm = watcherStartCallCount;

      // Same value: no ensureState/start work.
      monitor.setGitWatchBudgetAllowed(true);
      expect(watcherStartCallCount).toBe(startsAfterArm);
      expect(monitor.hasWatcher).toBe(true);

      monitor.stop();
    });

    it("granting budget never arms a watcher when git watching is disabled", async () => {
      const monitor = new WorktreeMonitor(
        TEST_WORKTREE,
        { ...TEST_CONFIG, gitWatchEnabled: false },
        makeCallbacks(),
        "main"
      );
      await monitor.start();
      expect(monitor.hasWatcher).toBe(false);

      // The combined gate is AND, not OR: budget alone must not arm a watcher
      // the user disabled.
      monitor.setGitWatchBudgetAllowed(false);
      monitor.setGitWatchBudgetAllowed(true);
      expect(watcherStartCallCount).toBe(0);
      expect(monitor.hasWatcher).toBe(false);

      monitor.stop();
    });

    it("ensureWatcherState does not re-arm an evicted watcher", async () => {
      const monitor = new WorktreeMonitor(TEST_WORKTREE, WATCH_CONFIG, makeCallbacks(), "main");
      await monitor.start();
      monitor.setGitWatchBudgetAllowed(false);
      expect(monitor.hasWatcher).toBe(false);

      // Mirrors the syncMonitors reconcile that would otherwise re-arm.
      monitor.ensureWatcherState();
      expect(monitor.hasWatcher).toBe(false);

      monitor.stop();
    });
  });

  describe("working-tree-changed signal (#11330)", () => {
    const WATCH_CONFIG: WorktreeMonitorConfig = {
      ...TEST_CONFIG,
      gitWatchEnabled: true,
    };
    // Active worktree → recursive watcher, and start() resolves the initial
    // git status synchronously so _hasInitialStatus is already true on return.
    const ACTIVE_WORKTREE: Worktree = { ...TEST_WORKTREE, isCurrent: true };

    beforeEach(() => {
      mockWatcherStartResult = true;
      mockGetWorktreeChangesWithStats.mockResolvedValue({
        worktreeId: "/test/worktree",
        rootPath: "/test",
        changes: [],
        changedFileCount: 0,
        lastUpdated: Date.now(),
      });
    });

    it("a recursive-watcher flush emits a stamped snapshot without a git-status change", async () => {
      const callbacks = makeCallbacks();
      const monitor = new WorktreeMonitor(ACTIVE_WORKTREE, WATCH_CONFIG, callbacks, "main");
      await monitor.start();

      expect(monitor.hasInitialStatus).toBe(true);
      // No raw-fs write yet, so the initial snapshot carries no stamp.
      expect(
        vi.mocked(callbacks.onUpdate).mock.calls.at(-1)?.[0]?.workingTreeChangedAt
      ).toBeUndefined();

      const statusCallsBefore = mockGetWorktreeChangesWithStats.mock.calls.length;
      const emitsBefore = vi.mocked(callbacks.onUpdate).mock.calls.length;

      const fireWorktreeFilesChanged = capturedWatcherOptions?.onWorktreeFilesChanged as
        ((affectedDirs: readonly string[] | null) => void) | undefined;
      expect(fireWorktreeFilesChanged).toBeDefined();
      fireWorktreeFilesChanged?.(null);

      // Emitted off the write alone — a fresh snapshot, no extra git status run.
      expect(vi.mocked(callbacks.onUpdate).mock.calls.length).toBe(emitsBefore + 1);
      expect(mockGetWorktreeChangesWithStats.mock.calls.length).toBe(statusCallsBefore);
      expect(
        vi.mocked(callbacks.onUpdate).mock.calls.at(-1)?.[0]?.workingTreeChangedAt
      ).toBeGreaterThan(0);

      monitor.stop();
    });

    it("stamps a strictly increasing workingTreeChangedAt across successive flushes", async () => {
      const callbacks = makeCallbacks();
      const monitor = new WorktreeMonitor(ACTIVE_WORKTREE, WATCH_CONFIG, callbacks, "main");
      await monitor.start();

      const fireWorktreeFilesChanged = capturedWatcherOptions?.onWorktreeFilesChanged as (
        affectedDirs: readonly string[] | null
      ) => void;

      // Two flushes with no timer advance between them: the monotonic guard
      // (Math.max(now, prev + 1)) must still move the stamp forward even when
      // Date.now() is unchanged.
      fireWorktreeFilesChanged(null);
      const first = vi.mocked(callbacks.onUpdate).mock.calls.at(-1)?.[0]?.workingTreeChangedAt;
      fireWorktreeFilesChanged(null);
      const second = vi.mocked(callbacks.onUpdate).mock.calls.at(-1)?.[0]?.workingTreeChangedAt;

      expect(first).toBeGreaterThan(0);
      expect(second).toBeGreaterThan(first ?? 0);

      monitor.stop();
    });

    it("a flush before initial status stamps but does not emit; the first snapshot carries it", async () => {
      // Background worktree defers its initial git status behind the 2-5s
      // jitter, so _hasInitialStatus is still false right after start() — the
      // only clean way to exercise the pre-initial-status branch. Driving the
      // captured callback directly stands in for the recursive flush.
      const callbacks = makeCallbacks();
      const monitor = new WorktreeMonitor(TEST_WORKTREE, WATCH_CONFIG, callbacks, "main");
      await monitor.start();

      expect(monitor.hasInitialStatus).toBe(false);
      expect(callbacks.onUpdate).not.toHaveBeenCalled();

      const fireWorktreeFilesChanged = capturedWatcherOptions?.onWorktreeFilesChanged as (
        affectedDirs: readonly string[] | null
      ) => void;
      fireWorktreeFilesChanged(["src"]);

      // Stamped internally, but no incomplete snapshot emitted for it.
      expect(callbacks.onUpdate).not.toHaveBeenCalled();

      // Once the deferred initial status lands, its first snapshot carries the
      // retained stamp.
      await flushInitialStatus();
      expect(monitor.hasInitialStatus).toBe(true);
      expect(callbacks.onUpdate).toHaveBeenCalled();
      expect(
        vi.mocked(callbacks.onUpdate).mock.calls[0]?.[0]?.workingTreeChangedAt
      ).toBeGreaterThan(0);
      // But NOT the directories that burst named. A second flush before the
      // first status would have overwritten them, and nothing would ever
      // re-read the difference — so a retained stamp reports "unknown" rather
      // than a set it cannot prove is complete (#12244).
      expect(vi.mocked(callbacks.onUpdate).mock.calls[0]?.[0]?.workingTreeChangedDirs).toBeNull();

      monitor.stop();
    });

    it("carries the burst's directories on the snapshot the flush emits", async () => {
      const callbacks = makeCallbacks();
      const monitor = new WorktreeMonitor(ACTIVE_WORKTREE, WATCH_CONFIG, callbacks, "main");
      await monitor.start();

      const fireWorktreeFilesChanged = capturedWatcherOptions?.onWorktreeFilesChanged as (
        affectedDirs: readonly string[] | null
      ) => void;

      fireWorktreeFilesChanged(["src/panels", ""]);
      const emitted = vi.mocked(callbacks.onUpdate).mock.calls.at(-1)?.[0];
      expect(emitted?.workingTreeChangedDirs).toEqual(["src/panels", ""]);
      expect(emitted?.workingTreeChangedAt).toBeGreaterThan(0);

      // An unclassifiable burst replaces them rather than leaving the previous
      // burst's directories standing against a newer stamp.
      fireWorktreeFilesChanged(null);
      const next = vi.mocked(callbacks.onUpdate).mock.calls.at(-1)?.[0];
      expect(next?.workingTreeChangedDirs).toBeNull();
      expect(next?.workingTreeChangedAt).toBeGreaterThan(emitted?.workingTreeChangedAt ?? 0);

      monitor.stop();
    });
  });

  describe("backgrounded project (#12459)", () => {
    const WATCH_CONFIG: WorktreeMonitorConfig = {
      ...TEST_CONFIG,
      gitWatchEnabled: true,
    };
    const ACTIVE_WORKTREE: Worktree = { ...TEST_WORKTREE, isCurrent: true };

    beforeEach(() => {
      mockWatcherStartResult = true;
      mockGetWorktreeChangesWithStats.mockResolvedValue({
        worktreeId: "/test/worktree",
        rootPath: "/test",
        changes: [],
        changedFileCount: 0,
        lastUpdated: Date.now(),
      });
    });

    function statusCalls(): number {
      return mockGetWorktreeChangesWithStats.mock.calls.length;
    }

    function fireGitChange(): void {
      const onChange = capturedWatcherOptions?.onChange as (() => void) | undefined;
      expect(onChange).toBeDefined();
      onChange?.();
    }

    it("pause tears down the focused worktree's recursive watcher and a straggling event runs no status", async () => {
      const monitor = new WorktreeMonitor(ACTIVE_WORKTREE, WATCH_CONFIG, makeCallbacks(), "main");
      await monitor.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(monitor.hasWatcher).toBe(true);
      expect(capturedWatcherOptions).toMatchObject({ watchWorktree: true });

      monitor.pausePolling();
      expect(monitor.hasWatcher).toBe(false);
      // Poll timer cancelled too, not merely a timer that declines when it fires.
      expect(vi.getTimerCount()).toBe(0);

      // Clear the self-trigger cooldown so the event would otherwise force a
      // refresh straight away, then deliver it through the retired watcher.
      await vi.advanceTimersByTimeAsync(2_000);
      const before = statusCalls();
      fireGitChange();
      await vi.advanceTimersByTimeAsync(10 * 60_000);

      expect(statusCalls()).toBe(before);
      monitor.stop();
    });

    it("resume re-arms the watcher and runs exactly one forced catch-up pass", async () => {
      const callbacks = makeCallbacks();
      const monitor = new WorktreeMonitor(ACTIVE_WORKTREE, WATCH_CONFIG, callbacks, "main");
      await monitor.start();
      await vi.advanceTimersByTimeAsync(0);
      monitor.pausePolling();
      await vi.advanceTimersByTimeAsync(10 * 60_000);

      const before = statusCalls();
      const armsBefore = capturedWatcherOptionsHistory.length;
      monitor.resumePolling();
      await vi.advanceTimersByTimeAsync(0);

      expect(monitor.hasWatcher).toBe(true);
      expect(capturedWatcherOptionsHistory.length).toBe(armsBefore + 1);
      expect(capturedWatcherOptionsHistory.at(-1)).toMatchObject({ watchWorktree: true });
      expect(statusCalls()).toBe(before + 1);
      // Recursive coverage was down for the whole pause, so the stat pre-check
      // can't be trusted — the catch-up must be forced.
      expect(mockGetWorktreeChangesWithStats.mock.calls.at(-1)?.[1]).toMatchObject({
        forceRefresh: true,
      });
      // The file browser is told its listings may have missed writes.
      expect(
        vi.mocked(callbacks.onUpdate).mock.calls.at(-1)?.[0]?.workingTreeChangedAt
      ).toBeGreaterThan(0);

      // Then back to the normal recursive heartbeat: nothing early, one pass at 5 min.
      await vi.advanceTimersByTimeAsync(60_000);
      expect(statusCalls()).toBe(before + 1);
      await vi.advanceTimersByTimeAsync(241_000);
      expect(statusCalls()).toBe(before + 2);
      monitor.stop();
    });

    it("a monitor paused before start never arms a watcher or a poll loop", async () => {
      const monitor = new WorktreeMonitor(ACTIVE_WORKTREE, WATCH_CONFIG, makeCallbacks(), "main");
      monitor.pausePolling();
      await monitor.start();
      await vi.advanceTimersByTimeAsync(0);

      expect(watcherStartCallCount).toBe(0);
      expect(monitor.hasWatcher).toBe(false);
      // The one-shot initial status still lands so the card has data.
      expect(statusCalls()).toBe(1);

      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(statusCalls()).toBe(1);
      monitor.stop();
    });

    it("pause leaves an agent-active worktree's watcher and status work alone", async () => {
      const monitor = new WorktreeMonitor(TEST_WORKTREE, WATCH_CONFIG, makeCallbacks(), "main");
      monitor.agentActive = true;
      await monitor.start();
      await vi.advanceTimersByTimeAsync(0);
      const armsBefore = capturedWatcherOptionsHistory.length;

      monitor.pausePolling();

      expect(monitor.hasWatcher).toBe(true);
      expect(capturedWatcherOptionsHistory.length).toBe(armsBefore);
      expect(capturedWatcherOptions).toMatchObject({ watchWorktree: true });

      await vi.advanceTimersByTimeAsync(2_000);
      const before = statusCalls();
      fireGitChange();
      await vi.advanceTimersByTimeAsync(0);
      expect(statusCalls()).toBe(before + 1);

      // Its heartbeat keeps running without any watcher event.
      await vi.advanceTimersByTimeAsync(300_000);
      expect(statusCalls()).toBe(before + 2);
      monitor.stop();
    });

    it("an agent past the recursive cap keeps git-only plus the 60s elevated poll through a pause", async () => {
      const monitor = new WorktreeMonitor(TEST_WORKTREE, WATCH_CONFIG, makeCallbacks(), "main");
      monitor.agentActive = true;
      monitor.setRecursiveWatchBudgetAllowed(false);
      await monitor.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(capturedWatcherOptions).toMatchObject({ watchWorktree: false });

      monitor.pausePolling();
      expect(monitor.hasWatcher).toBe(true);
      const before = statusCalls();
      await vi.advanceTimersByTimeAsync(61_000);

      expect(statusCalls()).toBe(before + 1);
      // No recursive coverage, so the elevated poll forces a real status.
      expect(mockGetWorktreeChangesWithStats.mock.calls.at(-1)?.[1]).toMatchObject({
        forceRefresh: true,
      });
      monitor.stop();
    });

    it("an agent that finishes while paused lets go of its watcher; resume brings it back with one pass", async () => {
      const monitor = new WorktreeMonitor(TEST_WORKTREE, WATCH_CONFIG, makeCallbacks(), "main");
      monitor.agentActive = true;
      await monitor.start();
      await vi.advanceTimersByTimeAsync(0);
      monitor.pausePolling();

      const before = statusCalls();
      monitor.agentActive = false;

      // Released at once — no 3s downgrade settle, and no "final" refresh on a
      // project nobody is looking at.
      expect(monitor.hasWatcher).toBe(false);
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(statusCalls()).toBe(before);

      monitor.resumePolling();
      await vi.advanceTimersByTimeAsync(0);
      expect(monitor.hasWatcher).toBe(true);
      expect(capturedWatcherOptions).toMatchObject({ watchWorktree: false });
      expect(statusCalls()).toBe(before + 1);
      monitor.stop();
    });

    it("an agent that starts while paused gets its recursive watcher and poll loop back", async () => {
      const monitor = new WorktreeMonitor(TEST_WORKTREE, WATCH_CONFIG, makeCallbacks(), "main");
      await monitor.start();
      await flushInitialStatus();
      monitor.pausePolling();
      expect(monitor.hasWatcher).toBe(false);

      const before = statusCalls();
      monitor.agentActive = true;
      await vi.advanceTimersByTimeAsync(0);

      expect(monitor.hasWatcher).toBe(true);
      expect(capturedWatcherOptions).toMatchObject({ watchWorktree: true });
      expect(statusCalls()).toBe(before + 1);

      // The poll loop is back too: the recursive heartbeat fires at 5 min.
      await vi.advanceTimersByTimeAsync(301_000);
      expect(statusCalls()).toBe(before + 2);
      monitor.stop();
    });

    it("a status pass in flight at resume keeps the catch-up instead of dropping it", async () => {
      const monitor = new WorktreeMonitor(ACTIVE_WORKTREE, WATCH_CONFIG, makeCallbacks(), "main");
      await monitor.start();
      await vi.advanceTimersByTimeAsync(0);
      monitor.pausePolling();

      // An explicit refresh while paused is still running when the project comes back.
      let release!: () => void;
      mockGetWorktreeChangesWithStats.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = () =>
              resolve({
                worktreeId: "/test/worktree",
                rootPath: "/test",
                changes: [],
                changedFileCount: 0,
                lastUpdated: Date.now(),
              });
          })
      );
      const refresh = monitor.refresh();
      await vi.advanceTimersByTimeAsync(0);
      const before = statusCalls();

      monitor.resumePolling();
      await vi.advanceTimersByTimeAsync(0);
      expect(statusCalls()).toBe(before);

      release();
      await refresh;
      await vi.advanceTimersByTimeAsync(0);
      expect(statusCalls()).toBe(before + 1);
      monitor.stop();
    });

    it("a deferred catch-up that fails does not escape as an unhandled rejection", async () => {
      const monitor = new WorktreeMonitor(ACTIVE_WORKTREE, WATCH_CONFIG, makeCallbacks(), "main");
      await monitor.start();
      await vi.advanceTimersByTimeAsync(0);
      monitor.pausePolling();

      let release!: () => void;
      mockGetWorktreeChangesWithStats
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              release = () =>
                resolve({
                  worktreeId: "/test/worktree",
                  rootPath: "/test",
                  changes: [],
                  changedFileCount: 0,
                  lastUpdated: Date.now(),
                });
            })
        )
        .mockRejectedValueOnce(new Error("git status failed"));
      const refresh = monitor.refresh();
      await vi.advanceTimersByTimeAsync(0);
      const before = statusCalls();

      // Parked behind the in-flight pass, then drained into a pass that fails.
      monitor.resumePolling();
      release();
      await refresh;
      await vi.advanceTimersByTimeAsync(0);

      expect(statusCalls()).toBe(before + 1);
      expect(monitor.getSnapshot().mood).toBe("error");
      monitor.stop();
    });

    it("rapid background/foreground flips while the poll queue is busy run one catch-up", async () => {
      const { default: PQueue } = await import("p-queue");
      const queue = new PQueue({ concurrency: 1 });
      const monitor = new WorktreeMonitor(
        ACTIVE_WORKTREE,
        WATCH_CONFIG,
        makeCallbacks(),
        "main",
        queue
      );
      await monitor.start();
      await vi.advanceTimersByTimeAsync(0);

      let unblock!: () => void;
      void queue.add(
        () =>
          new Promise<void>((resolve) => {
            unblock = resolve;
          })
      );
      const before = statusCalls();

      monitor.pausePolling();
      monitor.resumePolling();
      monitor.pausePolling();
      monitor.resumePolling();
      unblock();
      await vi.advanceTimersByTimeAsync(0);

      expect(statusCalls()).toBe(before + 1);
      monitor.stop();
    });

    it("a catch-up still queued when the project is backgrounded again does not run", async () => {
      const { default: PQueue } = await import("p-queue");
      const queue = new PQueue({ concurrency: 1 });
      const monitor = new WorktreeMonitor(
        ACTIVE_WORKTREE,
        WATCH_CONFIG,
        makeCallbacks(),
        "main",
        queue
      );
      await monitor.start();
      await vi.advanceTimersByTimeAsync(0);

      let unblock!: () => void;
      void queue.add(
        () =>
          new Promise<void>((resolve) => {
            unblock = resolve;
          })
      );
      const before = statusCalls();

      monitor.pausePolling();
      monitor.resumePolling();
      monitor.pausePolling();
      unblock();
      await vi.advanceTimersByTimeAsync(10 * 60_000);

      expect(statusCalls()).toBe(before);
      monitor.stop();
    });

    it("earning a recursive slot reconciles status for edits git-only coverage missed", async () => {
      const monitor = new WorktreeMonitor(TEST_WORKTREE, WATCH_CONFIG, makeCallbacks(), "main");
      monitor.agentActive = true;
      monitor.setRecursiveWatchBudgetAllowed(false);
      await monitor.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(capturedWatcherOptions).toMatchObject({ watchWorktree: false });
      const before = statusCalls();

      monitor.setRecursiveWatchBudgetAllowed(true);
      await vi.advanceTimersByTimeAsync(0);

      expect(capturedWatcherOptions).toMatchObject({ watchWorktree: true });
      expect(statusCalls()).toBe(before + 1);
      // Forced: the stat pre-check would trust the new recursive watcher.
      expect(mockGetWorktreeChangesWithStats.mock.calls.at(-1)?.[1]).toMatchObject({
        forceRefresh: true,
      });
      monitor.stop();
    });

    it("a resume that overlaps a running catch-up still gets its own pass", async () => {
      const monitor = new WorktreeMonitor(ACTIVE_WORKTREE, WATCH_CONFIG, makeCallbacks(), "main");
      await monitor.start();
      await vi.advanceTimersByTimeAsync(0);
      monitor.pausePolling();

      let release!: () => void;
      mockGetWorktreeChangesWithStats.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = () =>
              resolve({
                worktreeId: "/test/worktree",
                rootPath: "/test",
                changes: [],
                changedFileCount: 0,
                lastUpdated: Date.now(),
              });
          })
      );
      const before = statusCalls();
      monitor.resumePolling();
      await vi.advanceTimersByTimeAsync(0);
      expect(statusCalls()).toBe(before + 1);

      // Backgrounded and foregrounded again while that pass is still reading:
      // edits in between are newer than what it will publish.
      monitor.pausePolling();
      monitor.resumePolling();
      release();
      await vi.advanceTimersByTimeAsync(0);

      expect(statusCalls()).toBe(before + 2);
      monitor.stop();
    });

    it("a worktree that loses focus before its queued catch-up runs still gets a forced pass", async () => {
      const { default: PQueue } = await import("p-queue");
      const queue = new PQueue({ concurrency: 1 });
      const monitor = new WorktreeMonitor(
        ACTIVE_WORKTREE,
        WATCH_CONFIG,
        makeCallbacks(),
        "main",
        queue
      );
      await monitor.start();
      await vi.advanceTimersByTimeAsync(0);
      monitor.pausePolling();

      let unblock!: () => void;
      void queue.add(
        () =>
          new Promise<void>((resolve) => {
            unblock = resolve;
          })
      );
      const before = statusCalls();
      monitor.resumePolling();
      monitor.isCurrent = false;
      unblock();
      await vi.advanceTimersByTimeAsync(0);

      expect(statusCalls()).toBe(before + 1);
      // Its recursive watcher was down for the whole pause.
      expect(mockGetWorktreeChangesWithStats.mock.calls.at(-1)?.[1]).toMatchObject({
        forceRefresh: true,
      });
      monitor.stop();
    });

    it("keeps the watcher armed and observing when only the app stops being watched", async () => {
      const monitor = new WorktreeMonitor(ACTIVE_WORKTREE, WATCH_CONFIG, makeCallbacks(), "main");
      await monitor.start();
      await vi.advanceTimersByTimeAsync(0);
      const armsBefore = capturedWatcherOptionsHistory.length;
      const armedWith = capturedWatcherOptions as Record<string, unknown>;

      // Visible but unfocused: status work continues, network work does not.
      monitor.applyPollingPermissions({
        status: true,
        backgroundWork: false,
        attenuated: true,
      });

      // The whole point: no teardown, no re-arm, no window in which events are
      // lost. The watcher is retimed in place instead.
      expect(monitor.hasWatcher).toBe(true);
      expect(capturedWatcherOptionsHistory.length).toBe(armsBefore);
      expect(debouncePolicyUpdates).toHaveLength(1);
      const attenuated = debouncePolicyUpdates.at(-1)!;
      expect(attenuated.worktreeLeadingDebounceMs).toBeUndefined();
      expect(attenuated.worktreeMinDebounceMs as number).toBeGreaterThan(
        armedWith.worktreeMinDebounceMs as number
      );
      expect(attenuated.worktreeMaxWaitMs as number).toBeGreaterThan(
        armedWith.worktreeMaxWaitMs as number
      );

      // And it still reports: a change reaches the status pass without waiting
      // for anyone to come back.
      await vi.advanceTimersByTimeAsync(2_000);
      const before = statusCalls();
      fireGitChange();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(statusCalls()).toBe(before + 1);

      monitor.applyPollingPermissions({ status: true, backgroundWork: true, attenuated: false });
      expect(debouncePolicyUpdates).toHaveLength(2);
      expect(debouncePolicyUpdates.at(-1)?.worktreeLeadingDebounceMs).toBeDefined();
      expect(capturedWatcherOptionsHistory.length).toBe(armsBefore);

      monitor.stop();
    });

    it("still tears the watcher down when the project itself is backgrounded", async () => {
      const monitor = new WorktreeMonitor(ACTIVE_WORKTREE, WATCH_CONFIG, makeCallbacks(), "main");
      await monitor.start();
      await vi.advanceTimersByTimeAsync(0);

      monitor.applyPollingPermissions({
        status: false,
        backgroundWork: false,
        attenuated: true,
      });

      expect(monitor.hasWatcher).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
      monitor.stop();
    });
  });
});
