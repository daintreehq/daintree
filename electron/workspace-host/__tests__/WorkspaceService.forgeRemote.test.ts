import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "events";
import type { WorkspaceService } from "../WorkspaceService.js";
import type { WorktreeMonitor } from "../WorktreeMonitor.js";
import type { Worktree } from "../../../shared/types/worktree.js";

type Remote = { name: string; refs: { fetch: string; push: string } };

const mockSimpleGit = {
  raw: vi.fn().mockResolvedValue(undefined),
  branch: vi.fn().mockResolvedValue({ current: "main" }),
  getRemotes: vi.fn<() => Promise<Remote[]>>().mockResolvedValue([]),
};

function remote(name: string, url: string): Remote {
  return { name, refs: { fetch: url, push: url } };
}

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
    changedFileCount: 0,
    changes: [],
    lastUpdated: 0,
  }),
}));

const mockGetGitCommonDir = vi.fn().mockResolvedValue("/test/root/.git");
vi.mock("../../utils/gitUtils.js", () => ({
  getGitDir: vi.fn().mockReturnValue("/test/root/.git"),
  getGitCommonDir: (...args: unknown[]) => mockGetGitCommonDir(...args),
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
    };
  }),
  NoteFileReader: vi.fn(function () {
    return { read: vi.fn().mockResolvedValue({}) };
  }),
}));

const mockPullRequestService = {
  initialize: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
  reset: vi.fn(),
  cleanup: vi.fn(),
  refresh: vi.fn().mockResolvedValue(undefined),
  getStatus: vi.fn().mockReturnValue({
    state: "idle",
    isPolling: false,
    candidateCount: 0,
    resolvedCount: 0,
    isEnabled: true,
  }),
};

vi.mock("../../services/PullRequestService.js", () => ({
  pullRequestService: mockPullRequestService,
}));

// A real emitter so the in-process `sys:forge:remote-changed` hop is observable.
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

const mockStat = vi.fn();
vi.mock("fs/promises", () => ({
  stat: (...args: unknown[]) => mockStat(...args),
  mkdir: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
  access: vi.fn().mockResolvedValue(undefined),
  readFile: vi.fn().mockRejectedValue(new Error("ENOENT")),
  cp: vi.fn().mockResolvedValue(undefined),
  realpath: vi.fn((p: string) => Promise.resolve(p)),
}));

vi.mock("child_process", () => ({
  spawn: vi.fn(),
}));

function createTestWorktree(overrides: Partial<Worktree> = {}): Worktree {
  return {
    id: "/test/worktree",
    path: "/test/worktree",
    name: "feature/test",
    branch: "feature/test",
    isCurrent: false,
    isMainWorktree: false,
    gitDir: "/test/worktree/.git",
    ...overrides,
  };
}

const GITHUB_PROVIDER_ID = "daintree.github.github";

describe("WorkspaceService forge-remote detection (#11155)", () => {
  let service: WorkspaceService;
  let mockSendEvent: ReturnType<typeof vi.fn>;
  let WorktreeMonitorClass: typeof WorktreeMonitor;
  let sysRemoteChanged: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockSendEvent = vi.fn();
    mockSimpleGit.getRemotes.mockResolvedValue([]);
    mockStat.mockRejectedValue(new Error("ENOENT"));

    const WorkspaceServiceModule = await import("../WorkspaceService.js");
    service = new WorkspaceServiceModule.WorkspaceService(mockSendEvent as never);

    const WorktreeMonitorModule = await import("../WorktreeMonitor.js");
    WorktreeMonitorClass = WorktreeMonitorModule.WorktreeMonitor;

    service["projectRootPath"] = "/test/root";
    service["git"] = mockSimpleGit as never;
    service["forgeProviderMatchers"] = [
      { providerId: GITHUB_PROVIDER_ID, hostnames: ["github.com"] },
    ];

    sysRemoteChanged = vi.fn();
    mockEvents.on("sys:forge:remote-changed", sysRemoteChanged);
  });

  afterEach(() => {
    mockEvents.removeAllListeners();
    for (const monitor of service["monitors"].values()) {
      monitor.stop();
    }
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function registerMonitor(id: string, opts: { isMainWorktree?: boolean } = {}): WorktreeMonitor {
    const monitor = new WorktreeMonitorClass(
      createTestWorktree({
        id,
        path: id,
        gitDir: `${id}/.git`,
        isMainWorktree: opts.isMainWorktree ?? false,
      }),
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
    service["monitors"].set(id, monitor);
    monitor.start();
    return monitor;
  }

  /** Drive the `.git/config`-write path and let the debounced probe settle. */
  async function fireConfigChange(times = 1): Promise<void> {
    for (let i = 0; i < times; i++) {
      service["scheduleForgeRemoteReprobe"]();
    }
    await vi.advanceTimersByTimeAsync(300);
    await vi.advanceTimersByTimeAsync(0);
  }

  /** Establish a known baseline signature, as a monitor's start probe would. */
  async function seedBaseline(monitor: WorktreeMonitor, remotes: Remote[]): Promise<void> {
    mockSimpleGit.getRemotes.mockResolvedValue(remotes);
    await service["probeForgeRemoteAsync"](monitor);
    mockSimpleGit.getRemotes.mockClear();
  }

  it("resolves the provider after an origin is added to a repo that had none", async () => {
    const main = registerMonitor("/test/main", { isMainWorktree: true });
    await seedBaseline(main, []);
    expect(main.getSnapshot().matchedForgeProviderId).toBeUndefined();

    mockSimpleGit.getRemotes.mockResolvedValue([
      remote("origin", "https://github.com/acme/app.git"),
    ]);
    await fireConfigChange();

    expect(main.getSnapshot().matchedForgeProviderId).toBe(GITHUB_PROVIDER_ID);
    expect(sysRemoteChanged).toHaveBeenCalledTimes(1);
    expect(mockSendEvent).toHaveBeenCalledWith({ type: "forge-remote-changed" });
  });

  it("coalesces every sibling worktree's config event into ONE git read", async () => {
    // All worktrees share the common dir, so each one's watcher reports the
    // same write. Without coalescing this is N subprocess spawns per write.
    const main = registerMonitor("/test/main", { isMainWorktree: true });
    registerMonitor("/test/feature-1");
    registerMonitor("/test/feature-2");
    await seedBaseline(main, []);

    mockSimpleGit.getRemotes.mockResolvedValue([
      remote("origin", "https://github.com/acme/app.git"),
    ]);
    await fireConfigChange(3);

    expect(mockSimpleGit.getRemotes).toHaveBeenCalledTimes(1);
    expect(sysRemoteChanged).toHaveBeenCalledTimes(1);
  });

  it("fans the new provider out to every running monitor", async () => {
    const main = registerMonitor("/test/main", { isMainWorktree: true });
    const feature = registerMonitor("/test/feature");
    await seedBaseline(main, []);

    mockSimpleGit.getRemotes.mockResolvedValue([
      remote("origin", "https://github.com/acme/app.git"),
    ]);
    await fireConfigChange();

    // Remotes are repo-level: one probe must update the sibling's card too,
    // not just the worktree whose watcher happened to fire.
    expect(main.getSnapshot().matchedForgeProviderId).toBe(GITHUB_PROVIDER_ID);
    expect(feature.getSnapshot().matchedForgeProviderId).toBe(GITHUB_PROVIDER_ID);
  });

  it("emits nothing when a config write leaves the remotes unchanged", async () => {
    // `.git/config` is also written by `git push -u` and
    // `git branch --set-upstream-to`. Those must not churn the provider, or
    // PullRequestService's no-match pause (#9997) stops meaning anything.
    const main = registerMonitor("/test/main", { isMainWorktree: true });
    const remotes = [remote("origin", "https://github.com/acme/app.git")];
    await seedBaseline(main, remotes);

    mockSimpleGit.getRemotes.mockResolvedValue(remotes);
    await fireConfigChange();

    expect(mockSimpleGit.getRemotes).toHaveBeenCalledTimes(1);
    expect(sysRemoteChanged).not.toHaveBeenCalled();
    expect(mockSendEvent).not.toHaveBeenCalledWith({ type: "forge-remote-changed" });
  });

  it("detects a remote whose URL was repointed at another host", async () => {
    const main = registerMonitor("/test/main", { isMainWorktree: true });
    await seedBaseline(main, [remote("origin", "https://gitlab.com/acme/app.git")]);
    expect(main.getSnapshot().matchedForgeProviderId).toBeUndefined();

    mockSimpleGit.getRemotes.mockResolvedValue([
      remote("origin", "https://github.com/acme/app.git"),
    ]);
    await fireConfigChange();

    expect(sysRemoteChanged).toHaveBeenCalledTimes(1);
    expect(main.getSnapshot().matchedForgeProviderId).toBe(GITHUB_PROVIDER_ID);
  });

  it("clears the provider when the origin is removed", async () => {
    const main = registerMonitor("/test/main", { isMainWorktree: true });
    await seedBaseline(main, [remote("origin", "https://github.com/acme/app.git")]);
    expect(main.getSnapshot().matchedForgeProviderId).toBe(GITHUB_PROVIDER_ID);

    mockSimpleGit.getRemotes.mockResolvedValue([]);
    await fireConfigChange();

    expect(sysRemoteChanged).toHaveBeenCalledTimes(1);
    // The snapshot carries `undefined` for "no provider" (SnapshotBuilder maps
    // null → undefined), so the cleared state is the absence of an id.
    expect(main.getSnapshot().matchedForgeProviderId).toBeUndefined();
  });

  it("stays forge-neutral — an unmatched host resolves to no provider without erroring", async () => {
    const main = registerMonitor("/test/main", { isMainWorktree: true });
    await seedBaseline(main, []);

    mockSimpleGit.getRemotes.mockResolvedValue([
      remote("origin", "https://git.internal.example/acme/app.git"),
    ]);
    await fireConfigChange();

    // The remote table changed, so the signal still fires (main re-runs the
    // full precedence chain, which may resolve via an override or a default) —
    // but no hostname matcher claims it.
    expect(sysRemoteChanged).toHaveBeenCalledTimes(1);
    expect(main.getSnapshot().matchedForgeProviderId).toBeUndefined();
  });

  it("emits nothing when the git read fails", async () => {
    const main = registerMonitor("/test/main", { isMainWorktree: true });
    await seedBaseline(main, [remote("origin", "https://github.com/acme/app.git")]);

    mockSimpleGit.getRemotes.mockRejectedValue(new Error("not a git repository"));
    await fireConfigChange();

    expect(sysRemoteChanged).not.toHaveBeenCalled();
    // The last-known provider survives a transient failure.
    expect(main.getSnapshot().matchedForgeProviderId).toBe(GITHUB_PROVIDER_ID);
  });

  it("drops a probe that lands after teardown", async () => {
    const main = registerMonitor("/test/main", { isMainWorktree: true });
    await seedBaseline(main, []);

    let releaseGit: (remotes: Remote[]) => void = () => {};
    mockSimpleGit.getRemotes.mockReturnValue(
      new Promise<Remote[]>((resolve) => {
        releaseGit = resolve;
      })
    );

    service["scheduleForgeRemoteReprobe"]();
    await vi.advanceTimersByTimeAsync(300);

    // The project unloads while git is still running. A late completion must
    // not signal on behalf of a project that is no longer loaded.
    service["stopForgeConfigPoll"]();
    releaseGit([remote("origin", "https://github.com/acme/app.git")]);
    await vi.advanceTimersByTimeAsync(0);

    expect(sysRemoteChanged).not.toHaveBeenCalled();
    expect(mockSendEvent).not.toHaveBeenCalledWith({ type: "forge-remote-changed" });
  });

  describe("watcher-independent fallback", () => {
    it("probes when the config fingerprint moves, and not before", async () => {
      // Covers a disabled or silently-degraded git watcher: `fs.watch` failures
      // fall back to polling without telling anyone, and inotify exhaustion is
      // a live failure mode on Linux.
      const main = registerMonitor("/test/main", { isMainWorktree: true });
      await seedBaseline(main, []);

      mockStat.mockResolvedValue({ mtimeMs: 1000, size: 200 });
      service["startForgeConfigPoll"]();
      await vi.advanceTimersByTimeAsync(0);

      // Unchanged file: a stat, no subprocess.
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
      await vi.advanceTimersByTimeAsync(300);
      expect(mockSimpleGit.getRemotes).not.toHaveBeenCalled();

      // `git remote add` rewrote the file.
      mockStat.mockResolvedValue({ mtimeMs: 2000, size: 260 });
      mockSimpleGit.getRemotes.mockResolvedValue([
        remote("origin", "https://github.com/acme/app.git"),
      ]);
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
      await vi.advanceTimersByTimeAsync(300);
      await vi.advanceTimersByTimeAsync(0);

      expect(mockSimpleGit.getRemotes).toHaveBeenCalledTimes(1);
      expect(sysRemoteChanged).toHaveBeenCalledTimes(1);
      expect(main.getSnapshot().matchedForgeProviderId).toBe(GITHUB_PROVIDER_ID);
    });

    it("stops on teardown", async () => {
      mockStat.mockResolvedValue({ mtimeMs: 1000, size: 200 });
      service["startForgeConfigPoll"]();
      await vi.advanceTimersByTimeAsync(0);

      service["stopForgeConfigPoll"]();
      mockStat.mockResolvedValue({ mtimeMs: 2000, size: 260 });
      await vi.advanceTimersByTimeAsync(15 * 60 * 1000);

      expect(mockSimpleGit.getRemotes).not.toHaveBeenCalled();
    });
  });
});
