import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";
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
  let sysRemoteChanged: Mock<(payload: { timestamp: number }) => void>;

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

    sysRemoteChanged = vi.fn<(payload: { timestamp: number }) => void>();
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

  /**
   * Advance the config file's identity so the reprobe's stat gate sees a real
   * change. Git rewrites `.git/config` lock-then-rename, so a real
   * `git remote` mutation always lands a new inode.
   */
  let configStat = { ino: 1, mtimeMs: 1000, ctimeMs: 1000, size: 200 };
  function setConfigStat(next: Partial<typeof configStat>): void {
    configStat = { ...configStat, ...next };
    mockStat.mockResolvedValue({ ...configStat });
  }
  function touchConfigFile(): void {
    setConfigStat({
      ino: configStat.ino + 1,
      mtimeMs: configStat.mtimeMs + 1000,
      ctimeMs: configStat.ctimeMs + 1000,
      size: configStat.size + 1,
    });
  }
  /** A rewrite that moved ONLY the inode — mtime, ctime and size all unchanged. */
  function touchConfigInodeOnly(): void {
    setConfigStat({ ino: configStat.ino + 1 });
  }

  /**
   * Drive the `.git/config`-write path and let the debounced probe settle.
   * `touch: false` simulates a watcher event that did NOT correspond to a real
   * config write (an unnamed `fs.watch` event).
   */
  async function fireConfigChange(opts: { times?: number; touch?: boolean } = {}): Promise<void> {
    if (opts.touch !== false) touchConfigFile();
    for (let i = 0; i < (opts.times ?? 1); i++) {
      service["scheduleForgeRemoteReprobe"]({ observedConfigWrite: true });
    }
    await vi.advanceTimersByTimeAsync(300);
    await vi.advanceTimersByTimeAsync(0);
  }

  /** Establish the load-time baseline, as `startForgeRemoteDetection` does. */
  async function seedBaseline(remotes: Remote[]): Promise<void> {
    mockSimpleGit.getRemotes.mockResolvedValue(remotes);
    touchConfigFile();
    service["startForgeRemoteDetection"]();
    await vi.advanceTimersByTimeAsync(0);
    mockSimpleGit.getRemotes.mockClear();
  }

  /** Run a monitor's start probe (which must never seed the baseline). */
  async function runStartProbe(monitor: WorktreeMonitor, remotes: Remote[]): Promise<void> {
    mockSimpleGit.getRemotes.mockResolvedValue(remotes);
    await service["probeForgeRemoteAsync"](monitor);
    mockSimpleGit.getRemotes.mockClear();
  }

  const ORIGIN_GITHUB = remote("origin", "https://github.com/acme/app.git");

  it("resolves the provider after an origin is added to a repo that had none", async () => {
    const main = registerMonitor("/test/main", { isMainWorktree: true });
    await seedBaseline([]);
    await runStartProbe(main, []);
    expect(main.getSnapshot().matchedForgeProviderId).toBeUndefined();

    mockSimpleGit.getRemotes.mockResolvedValue([ORIGIN_GITHUB]);
    await fireConfigChange();

    expect(main.getSnapshot().matchedForgeProviderId).toBe(GITHUB_PROVIDER_ID);
    expect(sysRemoteChanged).toHaveBeenCalledTimes(1);
    expect(mockSendEvent).toHaveBeenCalledWith({ type: "forge-remote-changed" });
  });

  it("coalesces every sibling worktree's config event into ONE git read", async () => {
    // All worktrees share the common dir, so each one's watcher reports the
    // same write. Without coalescing this is N subprocess spawns per write.
    registerMonitor("/test/main", { isMainWorktree: true });
    registerMonitor("/test/feature-1");
    registerMonitor("/test/feature-2");
    await seedBaseline([]);

    mockSimpleGit.getRemotes.mockResolvedValue([ORIGIN_GITHUB]);
    await fireConfigChange({ times: 3 });

    expect(mockSimpleGit.getRemotes).toHaveBeenCalledTimes(1);
    expect(sysRemoteChanged).toHaveBeenCalledTimes(1);
  });

  it("fans the new provider out to every running monitor", async () => {
    const main = registerMonitor("/test/main", { isMainWorktree: true });
    const feature = registerMonitor("/test/feature");
    await seedBaseline([]);

    mockSimpleGit.getRemotes.mockResolvedValue([ORIGIN_GITHUB]);
    await fireConfigChange();

    // Remotes are repo-level: one probe must update the sibling's card too,
    // not just the worktree whose watcher happened to fire.
    expect(main.getSnapshot().matchedForgeProviderId).toBe(GITHUB_PROVIDER_ID);
    expect(feature.getSnapshot().matchedForgeProviderId).toBe(GITHUB_PROVIDER_ID);
  });

  it("emits nothing when a config write leaves the remotes unchanged", async () => {
    // `.git/config` is also written by `git push -u` and
    // `git branch --set-upstream-to`. The file genuinely changes (so the stat
    // gate opens and git runs), but the remote table doesn't — and a provider
    // churn here would make PullRequestService's no-match pause (#9997)
    // meaningless.
    registerMonitor("/test/main", { isMainWorktree: true });
    await seedBaseline([ORIGIN_GITHUB]);

    mockSimpleGit.getRemotes.mockResolvedValue([ORIGIN_GITHUB]);
    await fireConfigChange();

    expect(mockSimpleGit.getRemotes).toHaveBeenCalledTimes(1);
    expect(sysRemoteChanged).not.toHaveBeenCalled();
    expect(mockSendEvent).not.toHaveBeenCalledWith({ type: "forge-remote-changed" });
  });

  it("skips the git spawn when the watcher fires but the config never moved", async () => {
    // `fs.watch` can report a change with NO filename, which we conservatively
    // treat as possibly-config. The stat gate is what keeps that conservatism
    // from turning into a `git remote` spawn storm.
    registerMonitor("/test/main", { isMainWorktree: true });
    await seedBaseline([ORIGIN_GITHUB]);

    await fireConfigChange({ touch: false });
    await fireConfigChange({ touch: false });

    expect(mockSimpleGit.getRemotes).not.toHaveBeenCalled();
    expect(sysRemoteChanged).not.toHaveBeenCalled();
  });

  it("detects a remote whose URL was repointed at another host", async () => {
    const main = registerMonitor("/test/main", { isMainWorktree: true });
    const gitlab = remote("origin", "https://gitlab.com/acme/app.git");
    await seedBaseline([gitlab]);
    await runStartProbe(main, [gitlab]);
    expect(main.getSnapshot().matchedForgeProviderId).toBeUndefined();

    mockSimpleGit.getRemotes.mockResolvedValue([ORIGIN_GITHUB]);
    await fireConfigChange();

    expect(sysRemoteChanged).toHaveBeenCalledTimes(1);
    expect(main.getSnapshot().matchedForgeProviderId).toBe(GITHUB_PROVIDER_ID);
  });

  it("clears the provider when the origin is removed", async () => {
    const main = registerMonitor("/test/main", { isMainWorktree: true });
    await seedBaseline([ORIGIN_GITHUB]);
    await runStartProbe(main, [ORIGIN_GITHUB]);
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
    await seedBaseline([]);

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
    await seedBaseline([ORIGIN_GITHUB]);
    await runStartProbe(main, [ORIGIN_GITHUB]);

    mockSimpleGit.getRemotes.mockRejectedValue(new Error("not a git repository"));
    await fireConfigChange();

    expect(sysRemoteChanged).not.toHaveBeenCalled();
    // The last-known provider survives a transient failure.
    expect(main.getSnapshot().matchedForgeProviderId).toBe(GITHUB_PROVIDER_ID);
  });

  describe("baseline seeding", () => {
    it("a monitor start probe that races the user cannot absorb the change", async () => {
      // The sharp edge: a start probe still in flight when the user runs
      // `git remote add` reads the NEW table. If it were allowed to seed the
      // baseline, the reprobe would compare equal and emit nothing — the
      // worktree card would light up while the toolbar stayed dark forever.
      //
      // No baseline is established first, precisely so that a `??=` seed inside
      // `probeForgeRemoteAsync` WOULD take effect — that's what makes this a
      // real regression test rather than one an unfixed build also passes.
      const main = registerMonitor("/test/main", { isMainWorktree: true });
      touchConfigFile();

      // The start probe reads the post-add table (it lost the race with the user).
      await runStartProbe(main, [ORIGIN_GITHUB]);
      expect(main.getSnapshot().matchedForgeProviderId).toBe(GITHUB_PROVIDER_ID);
      expect(service["forgeRemoteSignature"]).toBeNull();

      // The watcher's reprobe must still see this as a change.
      mockSimpleGit.getRemotes.mockResolvedValue([ORIGIN_GITHUB]);
      await fireConfigChange({ touch: false });

      expect(sysRemoteChanged).toHaveBeenCalledTimes(1);
      expect(mockSendEvent).toHaveBeenCalledWith({ type: "forge-remote-changed" });
    });

    it("discards a load-time baseline read that spanned a config write", async () => {
      registerMonitor("/test/main", { isMainWorktree: true });

      // The seed's git read is still in flight when the user adds the remote.
      let releaseSeed: (remotes: Remote[]) => void = () => {};
      mockSimpleGit.getRemotes.mockReturnValue(
        new Promise<Remote[]>((resolve) => {
          releaseSeed = resolve;
        })
      );
      touchConfigFile();
      service["startForgeRemoteDetection"]();

      // Watcher observes the write while the seed read is outstanding.
      service["scheduleForgeRemoteReprobe"]({ observedConfigWrite: true });

      // The seed now returns the POST-add table — it must not become the
      // baseline, or the reprobe below would find nothing changed.
      releaseSeed([ORIGIN_GITHUB]);
      await vi.advanceTimersByTimeAsync(0);
      expect(service["forgeRemoteSignature"]).toBeNull();

      mockSimpleGit.getRemotes.mockResolvedValue([ORIGIN_GITHUB]);
      touchConfigFile();
      await vi.advanceTimersByTimeAsync(300);
      await vi.advanceTimersByTimeAsync(0);

      expect(sysRemoteChanged).toHaveBeenCalledTimes(1);
    });
  });

  describe("teardown", () => {
    it("drops a probe that lands after teardown", async () => {
      registerMonitor("/test/main", { isMainWorktree: true });
      await seedBaseline([]);

      let releaseGit: (remotes: Remote[]) => void = () => {};
      mockSimpleGit.getRemotes.mockReturnValue(
        new Promise<Remote[]>((resolve) => {
          releaseGit = resolve;
        })
      );

      touchConfigFile();
      service["scheduleForgeRemoteReprobe"]({ observedConfigWrite: true });
      await vi.advanceTimersByTimeAsync(300);

      // The project unloads while git is still running. A late completion must
      // not signal on behalf of a project that is no longer loaded.
      service["stopForgeRemoteDetection"]();
      releaseGit([ORIGIN_GITHUB]);
      await vi.advanceTimersByTimeAsync(0);

      expect(sysRemoteChanged).not.toHaveBeenCalled();
      expect(mockSendEvent).not.toHaveBeenCalledWith({ type: "forge-remote-changed" });
    });

    it("drops a baseline seed that lands after teardown", async () => {
      // Otherwise project A's remotes become project B's baseline, and B's real
      // `git remote add` could compare equal and be suppressed.
      let releaseSeed: (remotes: Remote[]) => void = () => {};
      mockSimpleGit.getRemotes.mockReturnValue(
        new Promise<Remote[]>((resolve) => {
          releaseSeed = resolve;
        })
      );
      touchConfigFile();
      service["startForgeRemoteDetection"]();

      service["stopForgeRemoteDetection"]();
      releaseSeed([ORIGIN_GITHUB]);
      await vi.advanceTimersByTimeAsync(0);

      expect(service["forgeRemoteSignature"]).toBeNull();
      expect(service["forgeConfigFingerprint"]).toBeNull();
    });

    it("stops the backstop timer", async () => {
      await seedBaseline([]);
      service["stopForgeRemoteDetection"]();

      touchConfigFile();
      mockSimpleGit.getRemotes.mockResolvedValue([ORIGIN_GITHUB]);
      await vi.advanceTimersByTimeAsync(15 * 60 * 1000);

      expect(mockSimpleGit.getRemotes).not.toHaveBeenCalled();
    });
  });

  describe("in-flight probe races", () => {
    it("a duplicate event mid-probe cannot cancel the pending detection", async () => {
      // Probe A stats the changed config, then stalls in git. A late sibling (or
      // unnamed) event supersedes it with probe B. If A had already *consumed*
      // the fingerprint, B would see "nothing changed" and bail — and A would
      // then die on its sequence check. The remote change would vanish entirely.
      registerMonitor("/test/main", { isMainWorktree: true });
      await seedBaseline([]);

      let releaseA: (remotes: Remote[]) => void = () => {};
      mockSimpleGit.getRemotes.mockReturnValueOnce(
        new Promise<Remote[]>((resolve) => {
          releaseA = resolve;
        })
      );
      touchConfigFile();
      await fireConfigChange({ touch: false });

      mockSimpleGit.getRemotes.mockResolvedValue([ORIGIN_GITHUB]);
      await fireConfigChange({ touch: false });

      releaseA([ORIGIN_GITHUB]);
      await vi.advanceTimersByTimeAsync(0);

      // Exactly one emit: B detected it, and superseded A stayed silent.
      expect(sysRemoteChanged).toHaveBeenCalledTimes(1);
    });

    it("a failed git read leaves the change visible to the next probe", async () => {
      // The fingerprint must not be consumed by a probe that never managed to
      // read the remotes — otherwise a transient git failure marks the change as
      // seen and the backstop skips it forever.
      const main = registerMonitor("/test/main", { isMainWorktree: true });
      await seedBaseline([]);

      mockSimpleGit.getRemotes.mockRejectedValueOnce(new Error("git spawn failed"));
      await fireConfigChange();
      expect(sysRemoteChanged).not.toHaveBeenCalled();

      // The backstop tick re-stats: the fingerprint still differs from the
      // baseline, so it probes again rather than treating it as already seen.
      mockSimpleGit.getRemotes.mockResolvedValue([ORIGIN_GITHUB]);
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
      await vi.advanceTimersByTimeAsync(300);
      await vi.advanceTimersByTimeAsync(0);

      expect(sysRemoteChanged).toHaveBeenCalledTimes(1);
      expect(main.getSnapshot().matchedForgeProviderId).toBe(GITHUB_PROVIDER_ID);
    });
  });

  describe("watcher-independent backstop", () => {
    it("detects a rewrite that moved only the inode", async () => {
      // Coarse-timestamp and network filesystems can leave mtime, ctime AND size
      // identical across git's lock-then-rename. The inode still moves — which is
      // exactly why the fingerprint includes it. A mtime+size fingerprint would
      // call this "unchanged" and never probe.
      const main = registerMonitor("/test/main", { isMainWorktree: true });
      await seedBaseline([remote("origin", "https://gitlab.com/acme/app.git")]);

      touchConfigInodeOnly();
      mockSimpleGit.getRemotes.mockResolvedValue([ORIGIN_GITHUB]);
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
      await vi.advanceTimersByTimeAsync(300);
      await vi.advanceTimersByTimeAsync(0);

      expect(sysRemoteChanged).toHaveBeenCalledTimes(1);
      expect(main.getSnapshot().matchedForgeProviderId).toBe(GITHUB_PROVIDER_ID);
    });

    it("probes when the config moves, and not before", async () => {
      // Covers a disabled or silently-degraded git watcher: `fs.watch` failures
      // fall back to polling without telling anyone, and inotify exhaustion is
      // a live failure mode on Linux.
      const main = registerMonitor("/test/main", { isMainWorktree: true });
      await seedBaseline([]);

      // Unchanged file: the tick stats, and stops there.
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
      await vi.advanceTimersByTimeAsync(300);
      expect(mockSimpleGit.getRemotes).not.toHaveBeenCalled();

      // `git remote add` rewrote the file (lock-then-rename → new inode).
      touchConfigFile();
      mockSimpleGit.getRemotes.mockResolvedValue([ORIGIN_GITHUB]);
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
      await vi.advanceTimersByTimeAsync(300);
      await vi.advanceTimersByTimeAsync(0);

      expect(mockSimpleGit.getRemotes).toHaveBeenCalledTimes(1);
      expect(sysRemoteChanged).toHaveBeenCalledTimes(1);
      expect(main.getSnapshot().matchedForgeProviderId).toBe(GITHUB_PROVIDER_ID);
    });
  });
});
