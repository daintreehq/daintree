import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";
import { EventEmitter } from "events";
import os from "os";
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
  setForgeSettings: vi.fn(),
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
      setUpstreamRef() {}
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

  /**
   * Run a monitor's start probe (which must never seed the baseline). It
   * resolves from the shared table when one is held, so the remotes it sees are
   * whatever the repo held at the last read — not a fresh mock value.
   */
  async function runStartProbe(monitor: WorktreeMonitor): Promise<void> {
    await service["probeForgeRemoteAsync"](monitor);
    mockSimpleGit.getRemotes.mockClear();
  }

  const ORIGIN_GITHUB = remote("origin", "https://github.com/acme/app.git");

  describe("remote selection honours the project setting (#11408)", () => {
    const ORIGIN_INTERNAL = remote("origin", "https://git.internal.example/acme/app.git");
    const UPSTREAM_GITHUB = remote("upstream", "https://github.com/upstream/app.git");

    it("probes the remote named by forgeRemote rather than origin", async () => {
      service["forgeRemoteName"] = "upstream";
      const main = registerMonitor("/test/main", { isMainWorktree: true });
      await seedBaseline([ORIGIN_GITHUB, UPSTREAM_GITHUB]);
      await runStartProbe(main);

      expect(main.remoteFetchUrl).toBe("https://github.com/upstream/app.git");
    });

    it("auto-detects a provider-matching remote when origin matches nothing", async () => {
      service["forgeRemoteName"] = null;
      const main = registerMonitor("/test/main", { isMainWorktree: true });
      await seedBaseline([ORIGIN_INTERNAL, UPSTREAM_GITHUB]);
      await runStartProbe(main);

      expect(main.getSnapshot().matchedForgeProviderId).toBe(GITHUB_PROVIDER_ID);
      expect(main.remoteFetchUrl).toBe("https://github.com/upstream/app.git");
    });

    it("keeps auto-detect on origin when origin itself matches a provider", async () => {
      // Origin-first parity with PullRequestService — the toolbar and the
      // worktree PR badges must not read different repositories.
      service["forgeRemoteName"] = null;
      const main = registerMonitor("/test/main", { isMainWorktree: true });
      await seedBaseline([ORIGIN_GITHUB, UPSTREAM_GITHUB]);
      await runStartProbe(main);

      expect(main.remoteFetchUrl).toBe("https://github.com/acme/app.git");
    });

    it("coalesces a burst of matcher pushes into one git read", async () => {
      // The relay fires on every registry change, so plugin init arrives as a
      // burst — one `git remote -v` each would be pure waste. No table is held
      // yet, so the burst has to read once.
      registerMonitor("/test/main", { isMainWorktree: true });
      mockSimpleGit.getRemotes.mockResolvedValue([ORIGIN_GITHUB]);

      for (let i = 0; i < 4; i++) {
        service.setForgeProviderMatchers([
          { providerId: GITHUB_PROVIDER_ID, hostnames: ["github.com"] },
        ]);
      }
      await vi.advanceTimersByTimeAsync(300);
      await vi.advanceTimersByTimeAsync(0);

      expect(mockSimpleGit.getRemotes).toHaveBeenCalledTimes(1);
    });

    it("re-selects when the matcher table arrives after a cold start", async () => {
      // Cold start: no matchers yet, so name preference alone picks origin
      // even though no provider can read it. Once the GitHub matcher lands,
      // re-matching that remembered URL is not enough — selection must re-run
      // or the affordance stays hidden while upstream was usable all along.
      service["forgeProviderMatchers"] = [];
      service["forgeRemoteName"] = null;
      const main = registerMonitor("/test/main", { isMainWorktree: true });
      await seedBaseline([ORIGIN_INTERNAL, UPSTREAM_GITHUB]);
      await runStartProbe(main);
      expect(main.remoteFetchUrl).toBe("https://git.internal.example/acme/app.git");
      expect(main.getSnapshot().matchedForgeProviderId).toBeFalsy();

      service.setForgeProviderMatchers([
        { providerId: GITHUB_PROVIDER_ID, hostnames: ["github.com"] },
      ]);
      await vi.advanceTimersByTimeAsync(300);
      await vi.advanceTimersByTimeAsync(0);

      expect(main.remoteFetchUrl).toBe("https://github.com/upstream/app.git");
      expect(main.getSnapshot().matchedForgeProviderId).toBe(GITHUB_PROVIDER_ID);
      // Only the selection inputs moved, so the load's table still describes
      // the repo: the matcher relay at plugin load costs no subprocess (#16427).
      expect(mockSimpleGit.getRemotes).not.toHaveBeenCalled();
    });

    it("keeps the signature across ALL remotes, not just the selected one", async () => {
      // The signature answers "did the remote table change" — adding an
      // unselected remote must still be detected as a change.
      service["forgeRemoteName"] = "upstream";
      registerMonitor("/test/main", { isMainWorktree: true });
      await seedBaseline([UPSTREAM_GITHUB]);

      mockSimpleGit.getRemotes.mockResolvedValue([UPSTREAM_GITHUB, ORIGIN_INTERNAL]);
      await fireConfigChange();

      expect(sysRemoteChanged).toHaveBeenCalledTimes(1);
      expect(mockSendEvent).toHaveBeenCalledWith({ type: "forge-remote-changed" });
    });

    it("re-selects and fans out when updateForgeSettings changes the remote", async () => {
      // `.git/config` is untouched, so the signature-gated reprobe never fires
      // — the selection change itself has to drive the update.
      // `mirror` is not a preferred name, so auto-detect starts on origin.
      const MIRROR_GITHUB = remote("mirror", "https://github.com/mirror/app.git");
      service["forgeRemoteName"] = null;
      const main = registerMonitor("/test/main", { isMainWorktree: true });
      await seedBaseline([ORIGIN_GITHUB, MIRROR_GITHUB]);
      await runStartProbe(main);
      expect(main.remoteFetchUrl).toBe("https://github.com/acme/app.git");

      service.updateForgeSettings({
        forgeProviderOverride: null,
        forgeDefaultProviderId: null,
        forgeRemote: "mirror",
      });
      await vi.advanceTimersByTimeAsync(0);

      expect(main.remoteFetchUrl).toBe("https://github.com/mirror/app.git");
    });
  });

  it("resolves the provider after an origin is added to a repo that had none", async () => {
    const main = registerMonitor("/test/main", { isMainWorktree: true });
    await seedBaseline([]);
    await runStartProbe(main);
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
    await runStartProbe(main);
    expect(main.getSnapshot().matchedForgeProviderId).toBeUndefined();

    mockSimpleGit.getRemotes.mockResolvedValue([ORIGIN_GITHUB]);
    await fireConfigChange();

    expect(sysRemoteChanged).toHaveBeenCalledTimes(1);
    expect(main.getSnapshot().matchedForgeProviderId).toBe(GITHUB_PROVIDER_ID);
  });

  it("clears the provider when the origin is removed", async () => {
    const main = registerMonitor("/test/main", { isMainWorktree: true });
    await seedBaseline([ORIGIN_GITHUB]);
    await runStartProbe(main);
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
    await runStartProbe(main);

    mockSimpleGit.getRemotes.mockRejectedValue(new Error("not a git repository"));
    await fireConfigChange();

    expect(sysRemoteChanged).not.toHaveBeenCalled();
    // The last-known provider survives a transient failure.
    expect(main.getSnapshot().matchedForgeProviderId).toBe(GITHUB_PROVIDER_ID);
  });

  describe("project load (#16427)", () => {
    function loadWorktrees(ids: string[]): Worktree[] {
      return ids.map((id, i) =>
        createTestWorktree({ id, path: id, gitDir: `${id}/.git`, isMainWorktree: i === 0 })
      );
    }

    beforeEach(() => {
      service["gitBacked"] = true;
    });

    it("reads the remotes once for every worktree a load installs", async () => {
      mockSimpleGit.getRemotes.mockResolvedValue([ORIGIN_GITHUB]);
      touchConfigFile();
      service["startForgeRemoteDetection"]();

      await service.syncMonitors(
        loadWorktrees(["/test/main", "/test/feature-1", "/test/feature-2", "/test/feature-3"]),
        null,
        "main",
        undefined,
        true
      );
      await vi.advanceTimersByTimeAsync(0);

      expect(mockSimpleGit.getRemotes).toHaveBeenCalledTimes(1);
      for (const monitor of service["monitors"].values()) {
        expect(monitor.remoteFetchUrl).toBe("https://github.com/acme/app.git");
        expect(monitor.getSnapshot().matchedForgeProviderId).toBe(GITHUB_PROVIDER_ID);
      }
    });

    it("still resolves a worktree added after load", async () => {
      mockSimpleGit.getRemotes.mockResolvedValue([ORIGIN_GITHUB]);
      touchConfigFile();
      service["startForgeRemoteDetection"]();
      await service.syncMonitors(loadWorktrees(["/test/main"]), null, "main", undefined, true);
      await vi.advanceTimersByTimeAsync(0);
      mockSimpleGit.getRemotes.mockClear();

      await installLate();

      const late = service["monitors"].get("/test/late")!;
      expect(late.remoteFetchUrl).toBe("https://github.com/acme/app.git");
      expect(late.getSnapshot().matchedForgeProviderId).toBe(GITHUB_PROVIDER_ID);
      expect(mockSimpleGit.getRemotes).not.toHaveBeenCalled();
    });

    it("lets monitors installed mid-read join the load's pending read", async () => {
      let releaseSeed: (remotes: Remote[]) => void = () => {};
      mockSimpleGit.getRemotes.mockReturnValueOnce(
        new Promise<Remote[]>((resolve) => {
          releaseSeed = resolve;
        })
      );
      touchConfigFile();
      service["startForgeRemoteDetection"]();

      await service.syncMonitors(
        loadWorktrees(["/test/main", "/test/feature-1", "/test/feature-2"]),
        null,
        "main",
        undefined,
        true
      );
      expect(service["monitors"].size).toBe(3);
      for (const monitor of service["monitors"].values()) {
        expect(monitor.remoteFetchUrl).toBeUndefined();
      }
      releaseSeed([ORIGIN_GITHUB]);
      await vi.advanceTimersByTimeAsync(0);

      expect(mockSimpleGit.getRemotes).toHaveBeenCalledTimes(1);
      for (const monitor of service["monitors"].values()) {
        expect(monitor.remoteFetchUrl).toBe("https://github.com/acme/app.git");
      }
    });

    async function loadThree(): Promise<void> {
      await service.syncMonitors(
        loadWorktrees(["/test/main", "/test/feature-1", "/test/feature-2"]),
        null,
        "main",
        undefined,
        true
      );
    }

    it("shares one retry between every monitor when the load's read fails", async () => {
      // A failure is never held as the table, so the monitors are not left
      // unresolved — but they retry together, not once each.
      let failSeed: () => void = () => {};
      mockSimpleGit.getRemotes.mockReturnValueOnce(
        new Promise<Remote[]>((_, reject) => {
          failSeed = () => reject(new Error("git spawn failed"));
        })
      );
      mockSimpleGit.getRemotes.mockResolvedValue([ORIGIN_GITHUB]);
      touchConfigFile();
      service["startForgeRemoteDetection"]();
      await loadThree();
      expect(mockSimpleGit.getRemotes).toHaveBeenCalledTimes(1);

      failSeed();
      await vi.advanceTimersByTimeAsync(0);

      expect(mockSimpleGit.getRemotes).toHaveBeenCalledTimes(2);
      for (const monitor of service["monitors"].values()) {
        expect(monitor.remoteFetchUrl).toBe("https://github.com/acme/app.git");
      }
      // Only the load-time read may seed the baseline, and it failed.
      expect(service["forgeRemoteSignature"]).toBeNull();
    });

    it("stops after one shared retry when git keeps failing", async () => {
      let failSeed: () => void = () => {};
      mockSimpleGit.getRemotes.mockReturnValueOnce(
        new Promise<Remote[]>((_, reject) => {
          failSeed = () => reject(new Error("not a git repository"));
        })
      );
      mockSimpleGit.getRemotes.mockRejectedValue(new Error("not a git repository"));
      touchConfigFile();
      service["startForgeRemoteDetection"]();
      await loadThree();

      failSeed();
      await vi.advanceTimersByTimeAsync(0);

      expect(mockSimpleGit.getRemotes).toHaveBeenCalledTimes(2);
      expect(service["forgeRemoteRead"]).toBeNull();
    });

    it("resolves monitors from a fresh read when the load's read is discarded", async () => {
      // The config moved between the seed's two stats with no watcher event to
      // say so: the seed's table may predate the change, so it is neither the
      // baseline nor the table the monitors take.
      let releaseSeed: (remotes: Remote[]) => void = () => {};
      mockSimpleGit.getRemotes.mockReturnValueOnce(
        new Promise<Remote[]>((resolve) => {
          releaseSeed = resolve;
        })
      );
      mockSimpleGit.getRemotes.mockResolvedValue([ORIGIN_GITHUB]);
      touchConfigFile();
      service["startForgeRemoteDetection"]();
      await loadThree();

      touchConfigFile();
      releaseSeed([]);
      await vi.advanceTimersByTimeAsync(0);

      expect(service["forgeRemoteSignature"]).toBeNull();
      expect(mockSimpleGit.getRemotes).toHaveBeenCalledTimes(2);
      for (const monitor of service["monitors"].values()) {
        expect(monitor.remoteFetchUrl).toBe("https://github.com/acme/app.git");
      }
    });

    it("moves a worktree added inside the reprobe window onto the new table", async () => {
      await seedBaseline([]);
      await service.syncMonitors(loadWorktrees(["/test/main"]), null, "main", undefined, true);
      await vi.advanceTimersByTimeAsync(0);

      // `git remote add` lands; the watcher sees it, and the worktree appears
      // inside the reprobe's debounce window, before anything re-read git.
      mockSimpleGit.getRemotes.mockResolvedValue([ORIGIN_GITHUB]);
      touchConfigFile();
      service["scheduleForgeRemoteReprobe"]({ observedConfigWrite: true });
      await installLate();
      await vi.advanceTimersByTimeAsync(300);
      await vi.advanceTimersByTimeAsync(0);

      for (const id of ["/test/main", "/test/late"]) {
        expect(service["monitors"].get(id)!.remoteFetchUrl).toBe("https://github.com/acme/app.git");
      }
      expect(sysRemoteChanged).toHaveBeenCalledTimes(1);
    });

    async function installLate(): Promise<void> {
      await service["addNewWorktreeMonitor"](
        createTestWorktree({ id: "/test/late", path: "/test/late", gitDir: "/test/late/.git" }),
        false,
        true
      );
      await vi.advanceTimersByTimeAsync(0);
    }
  });

  describe("shared remote table (#16427)", () => {
    function holdNextRead(): (remotes: Remote[]) => void {
      let release: (remotes: Remote[]) => void = () => {};
      mockSimpleGit.getRemotes.mockReturnValueOnce(
        new Promise<Remote[]>((resolve) => {
          release = resolve;
        })
      );
      return (remotes) => release(remotes);
    }

    it("a start read that lands after a newer reprobe cannot overwrite it", async () => {
      const main = registerMonitor("/test/main", { isMainWorktree: true });
      const releaseStart = holdNextRead();
      const startProbe = service["probeForgeRemoteAsync"](main);

      // The user adds the remote while the start read is still in git; the
      // reprobe reads the new table and fans it out first.
      mockSimpleGit.getRemotes.mockResolvedValue([ORIGIN_GITHUB]);
      await fireConfigChange();
      expect(main.remoteFetchUrl).toBe("https://github.com/acme/app.git");

      // The start read now returns the table from before the add.
      releaseStart([]);
      await startProbe;

      expect(main.remoteFetchUrl).toBe("https://github.com/acme/app.git");
      expect(main.getSnapshot().matchedForgeProviderId).toBe(GITHUB_PROVIDER_ID);
    });

    it("a start read superseded by a reprobe that fails still resolves", async () => {
      // The reprobe took the slot and then failed, so it fanned nothing out:
      // the stranded start read has to read again rather than give up.
      const main = registerMonitor("/test/main", { isMainWorktree: true });
      const releaseStart = holdNextRead();
      const startProbe = service["probeForgeRemoteAsync"](main);

      mockSimpleGit.getRemotes.mockRejectedValueOnce(new Error("git spawn failed"));
      mockSimpleGit.getRemotes.mockResolvedValue([ORIGIN_GITHUB]);
      await fireConfigChange();

      releaseStart([]);
      await startProbe;

      expect(mockSimpleGit.getRemotes).toHaveBeenCalledTimes(3);
      expect(main.remoteFetchUrl).toBe("https://github.com/acme/app.git");
    });

    it("an own start read that fails after a failed reprobe replaced it retries", async () => {
      // Both reads failed, but only the reprobe's says anything about the repo
      // now; the start read was stranded and nothing fanned out.
      const main = registerMonitor("/test/main", { isMainWorktree: true });
      let failStart: () => void = () => {};
      mockSimpleGit.getRemotes.mockReturnValueOnce(
        new Promise<Remote[]>((_, reject) => {
          failStart = () => reject(new Error("git spawn failed"));
        })
      );
      const startProbe = service["probeForgeRemoteAsync"](main);

      mockSimpleGit.getRemotes.mockRejectedValueOnce(new Error("git spawn failed"));
      mockSimpleGit.getRemotes.mockResolvedValue([ORIGIN_GITHUB]);
      await fireConfigChange();
      failStart();
      await startProbe;

      expect(mockSimpleGit.getRemotes).toHaveBeenCalledTimes(3);
      expect(main.remoteFetchUrl).toBe("https://github.com/acme/app.git");
    });

    it("a reselect read started before the load's read cannot land over it", async () => {
      // The load assigns the project root before it seeds, so a matcher push in
      // that window starts a read the seed then replaces. Applying that older
      // table after the seed consumed the fingerprint would stick for good.
      const main = registerMonitor("/test/main", { isMainWorktree: true });
      const releaseEarly = holdNextRead();
      const reselect = service["reselectForgeRemote"]();

      mockSimpleGit.getRemotes.mockResolvedValue([ORIGIN_GITHUB]);
      touchConfigFile();
      service["startForgeRemoteDetection"]();
      await vi.advanceTimersByTimeAsync(0);

      releaseEarly([]);
      await reselect;
      await vi.advanceTimersByTimeAsync(300);
      await vi.advanceTimersByTimeAsync(0);

      expect(main.remoteFetchUrl).toBe("https://github.com/acme/app.git");
    });

    it("a failed start read cannot clear the table a newer reprobe holds", async () => {
      const main = registerMonitor("/test/main", { isMainWorktree: true });
      let failStart: () => void = () => {};
      mockSimpleGit.getRemotes.mockReturnValueOnce(
        new Promise<Remote[]>((_, reject) => {
          failStart = () => reject(new Error("git spawn failed"));
        })
      );
      const startProbe = service["probeForgeRemoteAsync"](main);

      mockSimpleGit.getRemotes.mockResolvedValue([ORIGIN_GITHUB]);
      await fireConfigChange();
      failStart();
      await startProbe;
      mockSimpleGit.getRemotes.mockClear();

      const late = registerMonitor("/test/late");
      await service["probeForgeRemoteAsync"](late);

      expect(mockSimpleGit.getRemotes).not.toHaveBeenCalled();
      expect(late.remoteFetchUrl).toBe("https://github.com/acme/app.git");
    });

    it("a read landing for a monitor that was replaced is not applied to it", async () => {
      const stale = registerMonitor("/test/main", { isMainWorktree: true });
      const releaseStart = holdNextRead();
      const startProbe = service["probeForgeRemoteAsync"](stale);

      // Same id, new incarnation — the old one is still running.
      registerMonitor("/test/main", { isMainWorktree: true });
      releaseStart([ORIGIN_GITHUB]);
      await startProbe;

      expect(stale.remoteFetchUrl).toBeUndefined();
    });

    it("a replaced monitor does not retry a load read that failed", async () => {
      let failSeed: () => void = () => {};
      mockSimpleGit.getRemotes.mockReturnValueOnce(
        new Promise<Remote[]>((_, reject) => {
          failSeed = () => reject(new Error("git spawn failed"));
        })
      );
      touchConfigFile();
      service["startForgeRemoteDetection"]();
      const stale = registerMonitor("/test/main", { isMainWorktree: true });
      const startProbe = service["probeForgeRemoteAsync"](stale);

      registerMonitor("/test/main", { isMainWorktree: true });
      failSeed();
      await startProbe;

      expect(mockSimpleGit.getRemotes).toHaveBeenCalledTimes(1);
    });

    it("a monitor's own failed read is final", async () => {
      // As before the shared table: a repo whose enumeration keeps failing
      // costs one read per monitor start, not one plus a retry.
      const main = registerMonitor("/test/main", { isMainWorktree: true });
      mockSimpleGit.getRemotes.mockRejectedValue(new Error("not a git repository"));

      await service["probeForgeRemoteAsync"](main);

      expect(mockSimpleGit.getRemotes).toHaveBeenCalledTimes(1);
    });

    it("reads the shared table at the project root, never a monitor's path", async () => {
      // A monitor whose install straddled a project switch can still be
      // running; a read from its path would hand its repo's remotes to every
      // monitor of the incoming project.
      const { createHardenedGit } = await import("../../utils/hardenedGit.js");
      const straddler = registerMonitor("/old/main", { isMainWorktree: true });
      mockSimpleGit.getRemotes.mockResolvedValue([ORIGIN_GITHUB]);
      vi.mocked(createHardenedGit).mockClear();

      await service["probeForgeRemoteAsync"](straddler);

      expect(vi.mocked(createHardenedGit).mock.calls.map((call) => call[0])).toEqual([
        "/test/root",
      ]);
    });

    it("reprobes at the project root, never a monitor's path", async () => {
      const { createHardenedGit } = await import("../../utils/hardenedGit.js");
      registerMonitor("/old/main", { isMainWorktree: true });
      await seedBaseline([]);
      mockSimpleGit.getRemotes.mockResolvedValue([ORIGIN_GITHUB]);
      vi.mocked(createHardenedGit).mockClear();

      await fireConfigChange();

      expect(vi.mocked(createHardenedGit).mock.calls.map((call) => call[0])).toEqual([
        "/test/root",
      ]);
    });

    it("falls back to the listed main worktree once the project root is gone", async () => {
      // The project root may be a linked worktree that is later removed; the
      // main worktree outlives it. `/test/root` does not exist on disk.
      const { createHardenedGit } = await import("../../utils/hardenedGit.js");
      service["forgeMainWorktreePath"] = "/test/main";
      registerMonitor("/old/main", { isMainWorktree: true });
      await seedBaseline([]);
      mockSimpleGit.getRemotes.mockResolvedValue([ORIGIN_GITHUB]);
      vi.mocked(createHardenedGit).mockClear();

      await fireConfigChange();
      service["forgeRemoteRead"] = null;
      await runStartProbe(registerMonitor("/test/late"));

      expect(vi.mocked(createHardenedGit).mock.calls.map((call) => call[0])).toEqual([
        "/test/main",
        "/test/main",
      ]);
      service["projectRootPath"] = os.tmpdir();
      vi.mocked(createHardenedGit).mockClear();
      await fireConfigChange();
      expect(vi.mocked(createHardenedGit).mock.calls[0]?.[0]).toBe(os.tmpdir());

      service["stopForgeRemoteDetection"]();
      expect(service["forgeMainWorktreePath"]).toBeNull();
    });

    it("a start read in flight across a project switch leaves no table behind", async () => {
      const main = registerMonitor("/test/main", { isMainWorktree: true });
      const releaseStart = holdNextRead();
      const startProbe = service["probeForgeRemoteAsync"](main);

      // `onProjectSwitch` stops and drops every monitor alongside the forge
      // teardown.
      service["monitors"].delete("/test/main");
      main.stop();
      service["stopForgeRemoteDetection"]();
      releaseStart([ORIGIN_GITHUB]);
      await startProbe;

      expect(service["forgeRemoteRead"]).toBeNull();
      expect(mockSimpleGit.getRemotes).toHaveBeenCalledTimes(1);
    });

    it("a reselect in flight across a project switch does not retry", async () => {
      // Its bounded retry would otherwise re-arm against the next project.
      registerMonitor("/test/main", { isMainWorktree: true });
      const releaseRead = holdNextRead();
      const reselect = service["reselectForgeRemote"]();

      service["stopForgeRemoteDetection"]();
      releaseRead([ORIGIN_GITHUB]);
      await reselect;
      await vi.advanceTimersByTimeAsync(300 * 4);
      await vi.advanceTimersByTimeAsync(0);

      expect(mockSimpleGit.getRemotes).toHaveBeenCalledTimes(1);
    });

    it("re-reads git on a moved config even while a table is held", async () => {
      const main = registerMonitor("/test/main", { isMainWorktree: true });
      await seedBaseline([]);
      await runStartProbe(main);

      mockSimpleGit.getRemotes.mockResolvedValue([ORIGIN_GITHUB]);
      touchConfigFile();
      // The backstop observes nothing, so nothing drops the table first.
      service["scheduleForgeRemoteReprobe"]({ observedConfigWrite: false });
      await vi.advanceTimersByTimeAsync(300);
      await vi.advanceTimersByTimeAsync(0);

      expect(mockSimpleGit.getRemotes).toHaveBeenCalledTimes(1);
      expect(main.getSnapshot().matchedForgeProviderId).toBe(GITHUB_PROVIDER_ID);
      expect(sysRemoteChanged).toHaveBeenCalledTimes(1);
    });
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
      mockSimpleGit.getRemotes.mockResolvedValue([ORIGIN_GITHUB]);
      await runStartProbe(main);
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

  describe("while backgrounded (#12519)", () => {
    beforeEach(() => {
      vi.spyOn(os, "setPriority").mockImplementation(() => {});
      // Stands in for a load that initialized PR detection, so resume() starts it.
      service["prService"]["initializedForPath"] = "/test/root";
    });

    it("drops the backstop while paused — a retained host must not tick for hours", async () => {
      registerMonitor("/test/main", { isMainWorktree: true });
      await seedBaseline([]);

      service.pause();
      touchConfigFile();
      mockSimpleGit.getRemotes.mockResolvedValue([ORIGIN_GITHUB]);
      mockStat.mockClear();
      await vi.advanceTimersByTimeAsync(30 * 60 * 1000);

      expect(mockStat).not.toHaveBeenCalled();
      expect(mockSimpleGit.getRemotes).not.toHaveBeenCalled();
      expect(sysRemoteChanged).not.toHaveBeenCalled();
    });

    it("catches a remote added while paused before PR polling restarts", async () => {
      registerMonitor("/test/main", { isMainWorktree: true });
      await seedBaseline([]);
      service.pause();

      touchConfigFile();
      mockSimpleGit.getRemotes.mockResolvedValue([ORIGIN_GITHUB]);
      mockPullRequestService.start.mockClear();

      service.resume();
      // PR polling waits for the remotes to settle.
      expect(mockPullRequestService.start).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(0);

      expect(sysRemoteChanged).toHaveBeenCalledTimes(1);
      expect(mockPullRequestService.start).toHaveBeenCalledWith(0);
      // The invalidation lands before the poller restarts on its cached provider.
      expect(sysRemoteChanged.mock.invocationCallOrder[0]).toBeLessThan(
        mockPullRequestService.start.mock.invocationCallOrder[0]
      );
    });

    it("costs one stat and no git on resume when nothing moved", async () => {
      registerMonitor("/test/main", { isMainWorktree: true });
      await seedBaseline([]);
      service.pause();
      mockPullRequestService.start.mockClear();
      mockStat.mockClear();

      service.resume();
      await vi.advanceTimersByTimeAsync(0);

      const configStats = mockStat.mock.calls.filter(([p]) => String(p).endsWith("config"));
      expect(configStats).toHaveLength(1);
      expect(mockSimpleGit.getRemotes).not.toHaveBeenCalled();
      expect(sysRemoteChanged).not.toHaveBeenCalled();
      expect(mockPullRequestService.start).toHaveBeenCalledWith(0);
    });

    it("re-arms the backstop on resume", async () => {
      const main = registerMonitor("/test/main", { isMainWorktree: true });
      await seedBaseline([]);
      service.pause();
      service.resume();
      await vi.advanceTimersByTimeAsync(0);

      touchConfigFile();
      mockSimpleGit.getRemotes.mockResolvedValue([ORIGIN_GITHUB]);
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
      await vi.advanceTimersByTimeAsync(300);
      await vi.advanceTimersByTimeAsync(0);

      expect(sysRemoteChanged).toHaveBeenCalledTimes(1);
      expect(main.getSnapshot().matchedForgeProviderId).toBe(GITHUB_PROVIDER_ID);
    });

    /** Hold every `.git/config` stat until released, in call order. */
    function holdConfigStats(): Array<() => void> {
      const releases: Array<() => void> = [];
      mockStat.mockImplementation((p: unknown) =>
        String(p).endsWith("config")
          ? new Promise((resolve) => releases.push(() => resolve({ ...configStat })))
          : Promise.resolve({ ...configStat })
      );
      return releases;
    }

    it("a repeat foreground does not start PR polling ahead of the settle", async () => {
      // A switch-back foregrounds twice: the switch handler, then the pool's
      // warm re-attach.
      registerMonitor("/test/main", { isMainWorktree: true });
      await seedBaseline([]);
      service.pause();
      const releases = holdConfigStats();
      mockPullRequestService.start.mockClear();

      service.resume();
      service.resume();
      await vi.advanceTimersByTimeAsync(0);
      expect(mockPullRequestService.start).not.toHaveBeenCalled();

      releases[0]();
      await vi.advanceTimersByTimeAsync(0);
      expect(mockPullRequestService.start).toHaveBeenCalledTimes(1);
    });

    it("a settle superseded by a pause does not restart PR polling in the next cycle", async () => {
      registerMonitor("/test/main", { isMainWorktree: true });
      await seedBaseline([]);
      service.pause();
      const releases = holdConfigStats();
      mockPullRequestService.start.mockClear();

      service.resume();
      service.pause();
      service.resume();
      await vi.advanceTimersByTimeAsync(0);

      // The first cycle's reprobe lands while the second's is still pending.
      releases[0]();
      await vi.advanceTimersByTimeAsync(0);
      expect(mockPullRequestService.start).not.toHaveBeenCalled();

      releases[1]();
      await vi.advanceTimersByTimeAsync(0);
      expect(mockPullRequestService.start).toHaveBeenCalledTimes(1);
    });

    it("waits for a watcher probe that supersedes the resume probe", async () => {
      registerMonitor("/test/main", { isMainWorktree: true });
      await seedBaseline([]);
      service.pause();
      const releases = holdConfigStats();
      mockPullRequestService.start.mockClear();

      service.resume();
      await vi.advanceTimersByTimeAsync(0);
      // A `.git/config` event lands while the resume probe is still out.
      service["scheduleForgeRemoteReprobe"]({ observedConfigWrite: true });
      await vi.advanceTimersByTimeAsync(300);

      // The superseded resume probe bails at its sequence check...
      releases[0]();
      await vi.advanceTimersByTimeAsync(0);
      expect(mockPullRequestService.start).not.toHaveBeenCalled();

      // ...and polling waits for the probe that replaced it.
      releases[1]();
      await vi.advanceTimersByTimeAsync(0);
      expect(mockPullRequestService.start).toHaveBeenCalledTimes(1);
    });

    it("restarts PR polling after the deadline when the settle hangs", async () => {
      // A stat on a dead mount never returns (the config stat is held forever).
      registerMonitor("/test/main", { isMainWorktree: true });
      await seedBaseline([]);
      service.pause();
      holdConfigStats();
      mockPullRequestService.start.mockClear();

      service.resume();
      await vi.advanceTimersByTimeAsync(4_999);
      expect(mockPullRequestService.start).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(mockPullRequestService.start).toHaveBeenCalledTimes(1);
    });

    it("replays every provider's deferred credential change, not just the last", async () => {
      const main = registerMonitor("/test/main", { isMainWorktree: true });
      await seedBaseline([]);
      const fetchNow = vi.spyOn(main, "triggerFetchNow").mockResolvedValue(undefined);
      service.pause();
      mockPullRequestService.refresh.mockClear();
      mockPullRequestService.reset.mockClear();

      // Provider A's token was fixed, then provider B signed out.
      service.updateForgeCredentials("acme.a", { kind: "bearer", value: "token" });
      service.updateForgeCredentials("acme.b", null);

      service.resume();
      await vi.advanceTimersByTimeAsync(0);

      expect(fetchNow).toHaveBeenCalledTimes(1);
      expect(mockPullRequestService.refresh).toHaveBeenCalledTimes(1);
      expect(mockPullRequestService.reset).toHaveBeenCalled();
    });

    it("holds a credential change that arrives mid-settle until the settle lands", async () => {
      registerMonitor("/test/main", { isMainWorktree: true });
      await seedBaseline([]);
      service.pause();
      const releases = holdConfigStats();
      mockPullRequestService.refresh.mockClear();

      service.resume();
      await vi.advanceTimersByTimeAsync(0);
      service.updateForgeCredentials(GITHUB_PROVIDER_ID, { kind: "bearer", value: "token" });
      expect(mockPullRequestService.refresh).not.toHaveBeenCalled();

      releases[0]();
      await vi.advanceTimersByTimeAsync(0);
      expect(mockPullRequestService.refresh).toHaveBeenCalledTimes(1);
    });

    it("an unload during the settle leaves PR polling to the next load", async () => {
      registerMonitor("/test/main", { isMainWorktree: true });
      await seedBaseline([]);
      service.pause();
      const releases = holdConfigStats();
      mockPullRequestService.start.mockClear();

      service.resume();
      await vi.advanceTimersByTimeAsync(0);
      service["stopForgeRemoteDetection"]();
      releases[0]();
      await vi.advanceTimersByTimeAsync(0);

      expect(mockPullRequestService.start).not.toHaveBeenCalled();
    });

    it("takes a forge settings push while backgrounded without querying the forge", async () => {
      await seedBaseline([]);
      service.pause();
      mockPullRequestService.refresh.mockClear();

      service.updateForgeSettings({
        forgeProviderOverride: GITHUB_PROVIDER_ID,
        forgeDefaultProviderId: null,
        forgeRemote: null,
      });

      expect(mockPullRequestService.setForgeSettings).toHaveBeenCalled();
      expect(mockPullRequestService.refresh).not.toHaveBeenCalled();
    });

    it("replays a credential change on resume instead of fetching while backgrounded", async () => {
      const main = registerMonitor("/test/main", { isMainWorktree: true });
      await seedBaseline([]);
      const fetchNow = vi.spyOn(main, "triggerFetchNow").mockResolvedValue(undefined);
      service.pause();
      mockPullRequestService.refresh.mockClear();

      service.updateForgeCredentials(GITHUB_PROVIDER_ID, { kind: "bearer", value: "token" });
      expect(fetchNow).not.toHaveBeenCalled();
      expect(mockPullRequestService.refresh).not.toHaveBeenCalled();

      service.resume();
      // Replayed with the PR poller, once the remotes have settled.
      expect(mockPullRequestService.refresh).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchNow).toHaveBeenCalledTimes(1);
      expect(mockPullRequestService.refresh).toHaveBeenCalledTimes(1);
    });

    it("does not restart PR polling when paused again before the reprobe lands", async () => {
      registerMonitor("/test/main", { isMainWorktree: true });
      await seedBaseline([]);
      service.pause();
      mockPullRequestService.start.mockClear();

      service.resume();
      service.pause();
      await vi.advanceTimersByTimeAsync(0);

      expect(mockPullRequestService.start).not.toHaveBeenCalled();
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
