import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Worktree } from "../../../shared/types/worktree.js";

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

  describe("WSL git routing", () => {
    beforeEach(() => {
      mockCreateHardenedGit.mockClear();
      mockCreateWslHardenedGit.mockClear();
      mockGetWorktreeChangesWithStats.mockResolvedValue({
        changes: [],
        changedFileCount: 0,
        totalInsertions: 0,
        totalDeletions: 0,
        latestFileMtime: null,
        lastUpdated: Date.now(),
      });
    });

    it("does not pass wsl invocation when not opted in", async () => {
      const wsl: Worktree = {
        ...TEST_WORKTREE,
        path: "\\\\wsl$\\Ubuntu\\home\\user\\repo",
        isWslPath: true,
        wslDistro: "Ubuntu",
        wslPosixPath: "/home/user/repo",
        wslGitEligible: "eligible",
        wslGitOptIn: false,
      };
      const monitor = new WorktreeMonitor(wsl, TEST_CONFIG, makeCallbacks(), "main");
      await monitor.start();
      await flushInitialStatus();

      const lastCall =
        mockGetWorktreeChangesWithStats.mock.calls[
          mockGetWorktreeChangesWithStats.mock.calls.length - 1
        ];
      expect(lastCall[1]?.wsl).toBeUndefined();

      monitor.stop();
    });

    it("passes wsl invocation when eligible + opted in (Windows only)", async () => {
      const original = process.platform;
      Object.defineProperty(process, "platform", { value: "win32", configurable: true });
      try {
        const wsl: Worktree = {
          ...TEST_WORKTREE,
          path: "\\\\wsl$\\Ubuntu\\home\\user\\repo",
          isWslPath: true,
          wslDistro: "Ubuntu",
          wslPosixPath: "/home/user/repo",
          wslGitEligible: "eligible",
          wslGitOptIn: true,
        };
        const monitor = new WorktreeMonitor(wsl, TEST_CONFIG, makeCallbacks(), "main");
        await monitor.start();
        await flushInitialStatus();

        const lastCall =
          mockGetWorktreeChangesWithStats.mock.calls[
            mockGetWorktreeChangesWithStats.mock.calls.length - 1
          ];
        expect(lastCall[1]?.wsl).toEqual({
          distro: "Ubuntu",
          uncPath: "\\\\wsl$\\Ubuntu\\home\\user\\repo",
          posixPath: "/home/user/repo",
        });

        // Snapshot must carry the upstream-provided wslPosixPath verbatim —
        // if the field round-trips through getSnapshot, renderer-side
        // consumers can rely on it without re-parsing the UNC.
        const snapshot = monitor.getSnapshot();
        expect(snapshot.wslPosixPath).toBe("/home/user/repo");

        monitor.stop();
      } finally {
        Object.defineProperty(process, "platform", { value: original, configurable: true });
      }
    });

    it("silently disables WSL git routing when wslPosixPath is missing upstream", async () => {
      // Regression guard: with the regex hoisted upstream, a WorktreeMonitor
      // constructed without `wslPosixPath` (e.g. bypassing enrichWorktreeWithWsl)
      // must short-circuit WSL routing rather than route to a fabricated
      // distro-root path.
      const original = process.platform;
      Object.defineProperty(process, "platform", { value: "win32", configurable: true });
      try {
        const wsl: Worktree = {
          ...TEST_WORKTREE,
          path: "\\\\wsl$\\Ubuntu\\home\\user\\repo",
          isWslPath: true,
          wslDistro: "Ubuntu",
          wslGitEligible: "eligible",
          wslGitOptIn: true,
        };
        const monitor = new WorktreeMonitor(wsl, TEST_CONFIG, makeCallbacks(), "main");
        await monitor.start();
        await flushInitialStatus();

        const lastCall =
          mockGetWorktreeChangesWithStats.mock.calls[
            mockGetWorktreeChangesWithStats.mock.calls.length - 1
          ];
        expect(lastCall[1]?.wsl).toBeUndefined();

        monitor.stop();
      } finally {
        Object.defineProperty(process, "platform", { value: original, configurable: true });
      }
    });

    it("setWslOptIn re-emits snapshot with updated fields when value changes", async () => {
      const original = process.platform;
      Object.defineProperty(process, "platform", { value: "win32", configurable: true });
      try {
        const wsl: Worktree = {
          ...TEST_WORKTREE,
          path: "\\\\wsl$\\Ubuntu\\home\\user\\repo",
          isWslPath: true,
          wslDistro: "Ubuntu",
          wslPosixPath: "/home/user/repo",
          wslGitEligible: "eligible",
          wslGitOptIn: false,
        };
        const callbacks = makeCallbacks();
        const monitor = new WorktreeMonitor(wsl, TEST_CONFIG, callbacks, "main");
        await monitor.start();
        await flushInitialStatus();

        const updateCallsBefore = (callbacks.onUpdate as ReturnType<typeof vi.fn>).mock.calls
          .length;
        monitor.setWslOptIn(true, true);
        const updateCallsAfter = (callbacks.onUpdate as ReturnType<typeof vi.fn>).mock.calls.length;
        expect(updateCallsAfter).toBeGreaterThan(updateCallsBefore);

        const snapshot = monitor.getSnapshot();
        expect(snapshot.wslGitOptIn).toBe(true);
        expect(snapshot.wslGitDismissed).toBe(true);
        expect(snapshot.isWslPath).toBe(true);

        monitor.stop();
      } finally {
        Object.defineProperty(process, "platform", { value: original, configurable: true });
      }
    });

    it("serializes ineligible as 'ineligible', not absent (#9924)", async () => {
      // The old `this._wslGitEligible || undefined` coercion dropped `false` to
      // absent, making "ineligible" indistinguishable from "unprobed" on the
      // renderer. The three-state field must round-trip 'ineligible' verbatim.
      const wsl: Worktree = {
        ...TEST_WORKTREE,
        path: "\\\\wsl$\\Debian\\home\\user\\repo",
        isWslPath: true,
        wslDistro: "Debian",
        wslPosixPath: "/home/user/repo",
        wslGitEligible: "ineligible",
      };
      const monitor = new WorktreeMonitor(wsl, TEST_CONFIG, makeCallbacks(), "main");
      await monitor.start();
      await flushInitialStatus();

      expect(monitor.getSnapshot().wslGitEligible).toBe("ineligible");

      monitor.stop();
    });

    it("defaults eligibility to 'unprobed' when the field is absent (#9924)", async () => {
      const wsl: Worktree = {
        ...TEST_WORKTREE,
        path: "\\\\wsl$\\Ubuntu\\home\\user\\repo",
        isWslPath: true,
        wslDistro: "Ubuntu",
        wslPosixPath: "/home/user/repo",
      };
      const monitor = new WorktreeMonitor(wsl, TEST_CONFIG, makeCallbacks(), "main");
      await monitor.start();
      await flushInitialStatus();

      expect(monitor.getSnapshot().wslGitEligible).toBe("unprobed");

      monitor.stop();
    });

    it("setWslEligible flips git routing at runtime without restart (#9924)", async () => {
      const original = process.platform;
      Object.defineProperty(process, "platform", { value: "win32", configurable: true });
      try {
        const wsl: Worktree = {
          ...TEST_WORKTREE,
          path: "\\\\wsl$\\Ubuntu\\home\\user\\repo",
          isWslPath: true,
          wslDistro: "Ubuntu",
          wslPosixPath: "/home/user/repo",
          // Start ineligible + opted in: no WSL routing yet.
          wslGitEligible: "ineligible",
          wslGitOptIn: true,
        };
        const callbacks = makeCallbacks();
        const monitor = new WorktreeMonitor(wsl, TEST_CONFIG, callbacks, "main");
        await monitor.start();
        await flushInitialStatus();

        // Becoming the default distro mid-session flips eligibility → routing on.
        const updateCallsBefore = (callbacks.onUpdate as ReturnType<typeof vi.fn>).mock.calls
          .length;
        monitor.setWslEligible("eligible");
        const updateCallsAfter = (callbacks.onUpdate as ReturnType<typeof vi.fn>).mock.calls.length;
        expect(updateCallsAfter).toBeGreaterThan(updateCallsBefore);
        expect(monitor.getSnapshot().wslGitEligible).toBe("eligible");

        mockGetWorktreeChangesWithStats.mockClear();
        await monitor.refresh();

        const lastCall =
          mockGetWorktreeChangesWithStats.mock.calls[
            mockGetWorktreeChangesWithStats.mock.calls.length - 1
          ];
        expect(lastCall[1]?.wsl).toEqual({
          distro: "Ubuntu",
          uncPath: "\\\\wsl$\\Ubuntu\\home\\user\\repo",
          posixPath: "/home/user/repo",
        });

        monitor.stop();
      } finally {
        Object.defineProperty(process, "platform", { value: original, configurable: true });
      }
    });

    it("setWslEligible is a no-op when the value is unchanged (#9924)", async () => {
      const wsl: Worktree = {
        ...TEST_WORKTREE,
        path: "\\\\wsl$\\Ubuntu\\home\\user\\repo",
        isWslPath: true,
        wslDistro: "Ubuntu",
        wslPosixPath: "/home/user/repo",
        wslGitEligible: "ineligible",
      };
      const callbacks = makeCallbacks();
      const monitor = new WorktreeMonitor(wsl, TEST_CONFIG, callbacks, "main");
      await monitor.start();
      await flushInitialStatus();

      const before = (callbacks.onUpdate as ReturnType<typeof vi.fn>).mock.calls.length;
      monitor.setWslEligible("ineligible");
      const after = (callbacks.onUpdate as ReturnType<typeof vi.fn>).mock.calls.length;
      expect(after).toBe(before);

      monitor.stop();
    });

    it("exposes isWslPath and wslDistro getters for eligibility refresh (#9924)", () => {
      const wsl: Worktree = {
        ...TEST_WORKTREE,
        path: "\\\\wsl$\\Ubuntu\\home\\user\\repo",
        isWslPath: true,
        wslDistro: "Ubuntu",
        wslPosixPath: "/home/user/repo",
      };
      const monitor = new WorktreeMonitor(wsl, TEST_CONFIG, makeCallbacks(), "main");
      expect(monitor.isWslPath).toBe(true);
      expect(monitor.wslDistro).toBe("Ubuntu");
    });
  });

  describe("heartbeat gap detection", () => {
    const CLEAN_CHANGES = {
      worktreeId: "/test/worktree",
      rootPath: "/test",
      changes: [],
      changedFileCount: 0,
      lastUpdated: 0,
    };

    function getMoodSequence(callbacks: WorktreeMonitorCallbacks): Array<string | undefined> {
      const fn = callbacks.onUpdate as ReturnType<typeof vi.fn>;
      return fn.mock.calls.map((call) => (call[0] as { mood?: string }).mood);
    }

    it("emits stale and force-refreshes when gap exceeds multiplier and floor", async () => {
      mockGetWorktreeChangesWithStats.mockResolvedValue(CLEAN_CHANGES);

      const callbacks = makeCallbacks();
      const monitor = new WorktreeMonitor(TEST_WORKTREE, TEST_CONFIG, callbacks, "main");
      await monitor.start();
      await flushInitialStatus();

      mockGetWorktreeChangesWithStats.mockClear();
      // Simulate that the last poll completion happened 60s ago in wall time —
      // the OS effectively suspended the process between then and now.
      (monitor as unknown as { lastGitStatusCompletedAt: number }).lastGitStatusCompletedAt =
        Date.now() - 60_000;
      mockInvalidateGitStatusCache.mockClear();

      // Fire the next pending poll timer (base interval 2000ms).
      await vi.advanceTimersByTimeAsync(5000);

      const moods = getMoodSequence(callbacks);
      expect(moods).toContain("stale");
      // Force refresh ran (forceRefresh=true invalidates the cache before fetching).
      expect(mockInvalidateGitStatusCache).toHaveBeenCalled();
      expect(mockGetWorktreeChangesWithStats).toHaveBeenCalled();

      monitor.stop();
    });

    it("does not mark stale before any git status has completed", async () => {
      // Set the watcher to start successfully so that start() is a no-op for git
      // status (startWithoutGitStatus path also leaves lastGitStatusCompletedAt = 0).
      mockGetWorktreeChangesWithStats.mockResolvedValue(CLEAN_CHANGES);

      const callbacks = makeCallbacks();
      const monitor = new WorktreeMonitor(TEST_WORKTREE, TEST_CONFIG, callbacks, "main");
      monitor.startWithoutGitStatus();

      // Advance well past the gap floor without ever completing a poll.
      await vi.advanceTimersByTimeAsync(120_000);

      const moods = getMoodSequence(callbacks);
      expect(moods).not.toContain("stale");

      monitor.stop();
    });

    it("does not mark stale when elapsed exceeds 3x interval but is below 30s floor", async () => {
      mockGetWorktreeChangesWithStats.mockResolvedValue(CLEAN_CHANGES);

      const callbacks = makeCallbacks();
      const monitor = new WorktreeMonitor(TEST_WORKTREE, TEST_CONFIG, callbacks, "main");
      await monitor.start();
      await flushInitialStatus();

      mockGetWorktreeChangesWithStats.mockClear();
      // 10s gap > 3x base interval (6s) but < 30s floor.
      (monitor as unknown as { lastGitStatusCompletedAt: number }).lastGitStatusCompletedAt =
        Date.now() - 10_000;

      await vi.advanceTimersByTimeAsync(5000);

      const moods = getMoodSequence(callbacks);
      expect(moods).not.toContain("stale");

      monitor.stop();
    });

    it("does not mark stale when elapsed exceeds 30s floor but is below 360s ceiling", async () => {
      mockGetWorktreeChangesWithStats.mockResolvedValue(CLEAN_CHANGES);

      const callbacks = makeCallbacks();
      // Watcher fallback path: base interval = 300s, raw threshold = 900s,
      // capped to 360s by HEARTBEAT_GAP_CEILING_MS.
      const watcherConfig: WorktreeMonitorConfig = {
        ...TEST_CONFIG,
        gitWatchEnabled: true,
      };
      mockWatcherStartResult = true;
      const monitor = new WorktreeMonitor(TEST_WORKTREE, watcherConfig, callbacks, "main");
      await monitor.start();
      await flushInitialStatus();

      mockGetWorktreeChangesWithStats.mockClear();
      // Advance most of the way to the heartbeat fire (timer is at +300s).
      await vi.advanceTimersByTimeAsync(245_000);
      // Simulate a watcher-driven update landing at T+245s — lastCompleted is now recent.
      (monitor as unknown as { lastGitStatusCompletedAt: number }).lastGitStatusCompletedAt =
        Date.now();
      // Advance another 60s to fire the heartbeat at T+305s.
      // elapsed at fire = 55s: above 30s floor, below 360s ceiling — must not mark stale.
      await vi.advanceTimersByTimeAsync(60_000);

      const moods = getMoodSequence(callbacks);
      expect(moods).not.toContain("stale");

      monitor.stop();
    });

    // Skipped on Windows: vi fake-timer microtask draining differs from
    // POSIX hosts here — the forced-refresh microtask chain doesn't fully
    // settle within `advanceTimersByTimeAsync(0)`, leaving the mood at "stale"
    // even after the refresh resolves. Linux/macOS still cover the logic.
    it.skipIf(process.platform === "win32")(
      "stale mood reverts after the forced refresh completes",
      async () => {
        mockGetWorktreeChangesWithStats.mockResolvedValue(CLEAN_CHANGES);

        const callbacks = makeCallbacks();
        const monitor = new WorktreeMonitor(TEST_WORKTREE, TEST_CONFIG, callbacks, "main");
        await monitor.start();
        await flushInitialStatus();

        (monitor as unknown as { lastGitStatusCompletedAt: number }).lastGitStatusCompletedAt =
          Date.now() - 60_000;

        await vi.advanceTimersByTimeAsync(5000);
        // Drain any microtasks the forced refresh kicked off.
        await vi.advanceTimersByTimeAsync(0);

        const moods = getMoodSequence(callbacks);
        const staleIndex = moods.indexOf("stale");
        expect(staleIndex).toBeGreaterThanOrEqual(0);
        // After the forced refresh, categorizeWorktree() returns "stable" (mocked),
        // so the final mood should be back to the real value.
        const finalMood = moods[moods.length - 1];
        expect(finalMood).not.toBe("stale");

        monitor.stop();
      }
    );

    // Skipped on Windows: same vi fake-timer race as above — a poll
    // microtask scheduled before stop() can still resolve into a git call
    // after the timers are cleared on Windows hosts. Linux/macOS still
    // exercise the stop()-cancels-heartbeat path.
    it.skipIf(process.platform === "win32")(
      "does not run heartbeat check after stop()",
      async () => {
        mockGetWorktreeChangesWithStats.mockResolvedValue(CLEAN_CHANGES);

        const callbacks = makeCallbacks();
        const monitor = new WorktreeMonitor(TEST_WORKTREE, TEST_CONFIG, callbacks, "main");
        await monitor.start();
        await flushInitialStatus();

        (monitor as unknown as { lastGitStatusCompletedAt: number }).lastGitStatusCompletedAt =
          Date.now() - 60_000;

        monitor.stop();
        mockGetWorktreeChangesWithStats.mockClear();

        await vi.advanceTimersByTimeAsync(120_000);

        const moods = getMoodSequence(callbacks);
        expect(moods).not.toContain("stale");
        expect(mockGetWorktreeChangesWithStats).not.toHaveBeenCalled();
      }
    );

    it("watcher fallback interval (300s) triggers stale when gap exceeds 360s ceiling", async () => {
      mockGetWorktreeChangesWithStats.mockResolvedValue(CLEAN_CHANGES);
      mockWatcherStartResult = true;

      const watcherConfig: WorktreeMonitorConfig = {
        ...TEST_CONFIG,
        gitWatchEnabled: true,
      };

      const callbacks = makeCallbacks();
      const monitor = new WorktreeMonitor(TEST_WORKTREE, watcherConfig, callbacks, "main");
      await monitor.start();
      await flushInitialStatus();

      // 100s past offset on lastCompleted plus the 300s timer fire gives an
      // elapsed of ~400s at fire — above the 360s ceiling. Raw threshold
      // (3 * 300s = 900s) is clamped to 360s so suspend/wake detection stays
      // bounded regardless of base interval.
      (monitor as unknown as { lastGitStatusCompletedAt: number }).lastGitStatusCompletedAt =
        Date.now() - 100_000;

      await vi.advanceTimersByTimeAsync(305_000);

      const moods = getMoodSequence(callbacks);
      expect(moods).toContain("stale");

      monitor.stop();
    });

    it("watcher fallback interval (300s) does not trigger stale on a quiet repo", async () => {
      mockGetWorktreeChangesWithStats.mockResolvedValue(CLEAN_CHANGES);
      mockWatcherStartResult = true;

      const watcherConfig: WorktreeMonitorConfig = {
        ...TEST_CONFIG,
        gitWatchEnabled: true,
      };

      const callbacks = makeCallbacks();
      const monitor = new WorktreeMonitor(TEST_WORKTREE, watcherConfig, callbacks, "main");
      await monitor.start();
      await flushInitialStatus();

      // After the initial poll, lastCompleted is set and the heartbeat timer
      // is scheduled for +300s. Advance to fire it without mutating
      // lastCompleted (no watcher events, no manual override). Elapsed at
      // fire is the base interval (~300s) — below the 360s ceiling, so the
      // safety net must NOT flicker stale on every cycle.
      await vi.advanceTimersByTimeAsync(305_000);

      const moods = getMoodSequence(callbacks);
      expect(moods).not.toContain("stale");

      monitor.stop();
    });

    // Skipped on Windows: vi fake-timer microtask race lets a queued poll
    // resolve into a git call before the in-flight gate (`_isUpdating`)
    // takes effect on Windows hosts. Linux/macOS still cover the gate.
    it.skipIf(process.platform === "win32")(
      "does not emit stale while a refresh is already in flight",
      async () => {
        mockGetWorktreeChangesWithStats.mockResolvedValue(CLEAN_CHANGES);

        const callbacks = makeCallbacks();
        const monitor = new WorktreeMonitor(TEST_WORKTREE, TEST_CONFIG, callbacks, "main");
        await monitor.start();
        await flushInitialStatus();

        mockGetWorktreeChangesWithStats.mockClear();
        // Simulate an in-flight refresh AND an aged completion timestamp.
        (monitor as unknown as { _isUpdating: boolean })._isUpdating = true;
        (monitor as unknown as { lastGitStatusCompletedAt: number }).lastGitStatusCompletedAt =
          Date.now() - 60_000;

        await vi.advanceTimersByTimeAsync(5000);

        const moods = getMoodSequence(callbacks);
        expect(moods).not.toContain("stale");
        // Force-refresh path is gated behind the gap check, so it must not have
        // kicked off a duplicate git call either.
        expect(mockGetWorktreeChangesWithStats).not.toHaveBeenCalled();

        // Restore so stop() doesn't trip an in-flight assertion in teardown.
        (monitor as unknown as { _isUpdating: boolean })._isUpdating = false;
        monitor.stop();
      }
    );

    it("retains 'error' mood when the forced refresh fails", async () => {
      mockGetWorktreeChangesWithStats.mockResolvedValueOnce(CLEAN_CHANGES);

      const callbacks = makeCallbacks();
      const monitor = new WorktreeMonitor(TEST_WORKTREE, TEST_CONFIG, callbacks, "main");
      await monitor.start();
      await flushInitialStatus();

      mockGetWorktreeChangesWithStats.mockReset();
      mockGetWorktreeChangesWithStats.mockRejectedValue(new Error("git stalled"));
      (monitor as unknown as { lastGitStatusCompletedAt: number }).lastGitStatusCompletedAt =
        Date.now() - 60_000;

      await vi.advanceTimersByTimeAsync(5000);
      // Drain microtasks queued by the failing refresh.
      await vi.advanceTimersByTimeAsync(0);

      const moods = getMoodSequence(callbacks);
      expect(moods).toContain("stale");
      // updateGitStatus's catch path emits "error" before throwing; the gap
      // helper swallows the throw so the monitor stays alive.
      expect(moods).toContain("error");
      // Monitor is still running and a follow-up timer is pending.
      expect((monitor as unknown as { _isRunning: boolean })._isRunning).toBe(true);

      monitor.stop();
    });

    it("forced refresh produces real categorized mood, not 'stale'", async () => {
      mockGetWorktreeChangesWithStats.mockResolvedValue(CLEAN_CHANGES);
      // After the gap-driven refresh runs, categorize as something non-trivial.
      mockCategorizeWorktree.mockReturnValue("dirty");

      const callbacks = makeCallbacks();
      const monitor = new WorktreeMonitor(TEST_WORKTREE, TEST_CONFIG, callbacks, "main");
      await monitor.start();
      await flushInitialStatus();

      (monitor as unknown as { lastGitStatusCompletedAt: number }).lastGitStatusCompletedAt =
        Date.now() - 60_000;

      await vi.advanceTimersByTimeAsync(5000);
      await vi.advanceTimersByTimeAsync(0);

      const moods = getMoodSequence(callbacks);
      expect(moods).toContain("stale");
      expect(moods[moods.length - 1]).toBe("dirty");

      mockCategorizeWorktree.mockReturnValue("stable");
      monitor.stop();
    });
  });

  describe("git operation skip (rebase / merge / cherry-pick)", () => {
    it("skips getWorktreeChangesWithStats while a git operation is in progress", async () => {
      vi.mocked(getGitDir).mockResolvedValue("/test/worktree/.git");
      mockGetRepoOperationStateSync.mockReturnValue("REBASING");

      const callbacks = makeCallbacks();
      const monitor = new WorktreeMonitor(TEST_WORKTREE, TEST_CONFIG, callbacks, "main");

      await monitor.start();
      await flushInitialStatus();

      expect(mockGetRepoOperationStateSync).toHaveBeenCalledWith("/test/worktree/.git");
      expect(mockGetWorktreeChangesWithStats).not.toHaveBeenCalled();

      monitor.stop();
    });

    it("runs git status normally once the operation finishes", async () => {
      vi.mocked(getGitDir).mockResolvedValue("/test/worktree/.git");
      mockGetRepoOperationStateSync.mockReturnValue("MERGING");
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
      expect(mockGetWorktreeChangesWithStats).not.toHaveBeenCalled();

      // Simulate the rebase/merge finishing — sentinels disappear, then a
      // subsequent updateGitStatus call exercises the normal flow.
      mockGetRepoOperationStateSync.mockReturnValue(undefined);
      await monitor.updateGitStatus(true);

      expect(mockGetWorktreeChangesWithStats).toHaveBeenCalledTimes(1);
      expect(callbacks.onUpdate).toHaveBeenCalled();

      monitor.stop();
    });

    it("emits an initial snapshot when start() is skipped mid-operation", async () => {
      vi.mocked(getGitDir).mockResolvedValue("/test/worktree/.git");
      mockGetRepoOperationStateSync.mockReturnValue("REBASING");

      const callbacks = makeCallbacks();
      const monitor = new WorktreeMonitor(TEST_WORKTREE, TEST_CONFIG, callbacks, "main");

      await monitor.start();
      await flushInitialStatus();

      // The renderer must still receive a snapshot so the worktree is
      // visible — otherwise it stays invisible until the operation ends.
      expect(callbacks.onUpdate).toHaveBeenCalledTimes(1);
      expect(monitor.hasInitialStatus).toBe(true);
      expect(mockGetWorktreeChangesWithStats).not.toHaveBeenCalled();

      monitor.stop();
    });

    it("forced refresh during a blocking operation stamps freshness and re-emits (#10715)", async () => {
      vi.mocked(getGitDir).mockResolvedValue("/test/worktree/.git");
      mockGetRepoOperationStateSync.mockReturnValue("REVERTING");

      const callbacks = makeCallbacks();
      const monitor = new WorktreeMonitor(TEST_WORKTREE, TEST_CONFIG, callbacks, "main");

      await monitor.start();
      await flushInitialStatus();
      // Initial snapshot emitted once; the git status fork itself was skipped.
      expect(callbacks.onUpdate).toHaveBeenCalledTimes(1);
      expect(mockGetWorktreeChangesWithStats).not.toHaveBeenCalled();

      vi.mocked(callbacks.onUpdate).mockClear();
      // The user clicks Refresh on the stale card → forced refresh. The op is
      // still in progress so git status stays skipped, but the renderer must
      // receive a fresh snapshot whose freshness timestamp has advanced —
      // otherwise the Refresh button is a permanent no-op (the bug).
      await monitor.updateGitStatus(true);

      expect(mockGetWorktreeChangesWithStats).not.toHaveBeenCalled();
      expect(callbacks.onUpdate).toHaveBeenCalledTimes(1);
      const snapshot = vi.mocked(callbacks.onUpdate).mock.calls.at(-1)?.[0];
      expect(snapshot?.lastGitStatusCheckedAt).toBeGreaterThan(0);

      monitor.stop();
    });

    it("background poll during a blocking operation stamps silently without re-emitting", async () => {
      vi.mocked(getGitDir).mockResolvedValue("/test/worktree/.git");
      mockGetRepoOperationStateSync.mockReturnValue("REBASING");

      const callbacks = makeCallbacks();
      const monitor = new WorktreeMonitor(TEST_WORKTREE, TEST_CONFIG, callbacks, "main");

      await monitor.start();
      await flushInitialStatus();
      expect(callbacks.onUpdate).toHaveBeenCalledTimes(1);

      vi.mocked(callbacks.onUpdate).mockClear();
      // A non-forced (background) poll advances the freshness stamp but must not
      // emit a redundant snapshot — only the user-driven forced refresh does.
      await monitor.updateGitStatus(false);
      expect(callbacks.onUpdate).not.toHaveBeenCalled();

      monitor.stop();
    });

    it("does not check operation sentinels when getGitDir returns null", async () => {
      vi.mocked(getGitDir).mockResolvedValue(null);
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

      expect(mockGetRepoOperationStateSync).not.toHaveBeenCalled();
      expect(mockGetWorktreeChangesWithStats).toHaveBeenCalled();

      monitor.stop();
    });
  });
});
