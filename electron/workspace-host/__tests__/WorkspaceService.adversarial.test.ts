import { EventEmitter } from "events";
import { existsSync } from "fs";
import { resolve as pathResolve } from "path";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { createHardenedGit } from "../../utils/hardenedGit.js";
import type { WorkspaceService } from "../WorkspaceService.js";
import type { WorkspaceHostEvent } from "../../../shared/types/workspace-host.js";

const mockSimpleGit = {
  raw: vi.fn(),
  checkIsRepo: vi.fn().mockResolvedValue(true),
  branch: vi.fn().mockResolvedValue({ current: "main" }),
};

vi.mock("simple-git", () => ({
  simpleGit: vi.fn(() => mockSimpleGit),
}));

const waitForPathExistsMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock("../../utils/fs.js", () => ({
  waitForPathExists: waitForPathExistsMock,
}));

vi.mock("../../utils/hardenedGit.js", () => ({
  createHardenedGit: vi.fn(() => mockSimpleGit),
  createAuthenticatedGit: vi.fn(() => mockSimpleGit),
  validateBranchName: vi.fn(),
}));

vi.mock("../../utils/git.js", () => ({
  invalidateGitStatusCache: vi.fn(),
}));

vi.mock("../../utils/gitUtils.js", () => ({
  getGitDir: vi.fn().mockReturnValue("/test/worktree/.git"),
  clearGitDirCache: vi.fn(),
  clearGitCommonDirCache: vi.fn(),
}));

vi.mock("../../services/issueExtractor.js", () => ({
  extractIssueNumberSync: vi.fn().mockReturnValue(null),
  extractIssueNumber: vi.fn().mockResolvedValue(null),
  deriveIssueTitleFromBranch: vi.fn().mockReturnValue(undefined),
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

vi.mock("../../services/events.js", () => ({
  events: new EventEmitter(),
}));

vi.mock("fs/promises", () => ({
  stat: vi.fn().mockRejectedValue(new Error("ENOENT")),
  mkdir: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
  access: vi.fn().mockResolvedValue(undefined),
  readFile: vi.fn().mockRejectedValue(new Error("ENOENT")),
  cp: vi.fn().mockResolvedValue(undefined),
  // Identity by default: containment check (assertWorktreePathContained)
  // realpaths the repo parent and the target's nearest existing ancestor;
  // identity keeps resolved paths unchanged so existing assertions hold.
  realpath: vi.fn().mockImplementation((p: string) => Promise.resolve(p)),
}));

// Default to "exists" so existing tests focus on the git/monitor logic rather
// than the parent-directory creation path.
vi.mock("fs", () => ({
  existsSync: vi.fn().mockReturnValue(true),
}));

describe("WorkspaceService adversarial", () => {
  let service: WorkspaceService;
  let sentEvents: WorkspaceHostEvent[];

  beforeEach(async () => {
    vi.clearAllMocks();
    mockSimpleGit.raw.mockResolvedValue(undefined);
    mockSimpleGit.checkIsRepo.mockResolvedValue(true);
    waitForPathExistsMock.mockResolvedValue(undefined);

    sentEvents = [];
    const workspaceModule = await import("../WorkspaceService.js");
    service = new workspaceModule.WorkspaceService((event: WorkspaceHostEvent) => {
      sentEvents.push(event);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fails loadProject cleanly when worktree metadata mapping is corrupted", async () => {
    const listService = service["listService"] as unknown as {
      list: Mock;
      mapToWorktrees: Mock;
    };

    listService.list = vi.fn().mockResolvedValue([{ path: "/broken" }]);
    listService.mapToWorktrees = vi.fn(() => {
      throw new Error("Corrupted worktree metadata");
    });

    await service.loadProject("req-load", "/repo", "ws-test-project-id");

    expect(sentEvents).toContainEqual(
      expect.objectContaining({
        type: "load-project-result",
        requestId: "req-load",
        success: false,
        error: "Corrupted worktree metadata",
      })
    );
  });

  it("fails loadProject before any git call when the project root was deleted (#10663)", async () => {
    // The project directory was removed/moved externally before this load.
    vi.mocked(existsSync).mockReturnValueOnce(false);

    await service.loadProject("req-missing", "/missing/path", "ws-test-project-id");

    expect(sentEvents).toContainEqual(
      expect.objectContaining({
        type: "load-project-result",
        requestId: "req-missing",
        success: false,
        error: "Project directory does not exist: /missing/path",
      })
    );
    // The guard must fire before any git instance is constructed for the dead
    // path — otherwise the polling loops keep retrying it and spam WARN logs.
    expect(createHardenedGit).not.toHaveBeenCalled();
    // `projectRootPath` must stay null: if the guard were moved after the
    // assignment the failure event would still fire, but the dead path would
    // be primed and the polling loops would resume. Pin the ordering.
    expect(service["projectRootPath"]).toBeNull();
  });

  describe("a folder with no git repository (#11405)", () => {
    /**
     * Every monitor is a `GitStatusPass` poller, and its first tick against a
     * non-repo raises `WorktreeRemovedError` — which the pass answers by
     * removing the workspace. So the invariant under test is that none is ever
     * created, not that they cope.
     */
    function monitorCount(): number {
      return (service["monitors"] as Map<string, unknown>).size;
    }

    beforeEach(() => {
      mockSimpleGit.checkIsRepo.mockResolvedValue(false);
    });

    it("loads successfully instead of surfacing a worktree-load failure", async () => {
      await service.loadProject("req-plain", "/downloads", "ws-plain");

      expect(sentEvents).toContainEqual({
        type: "load-project-result",
        requestId: "req-plain",
        success: true,
      });
      expect(sentEvents.some((e) => e.type === "load-project-result" && !e.success)).toBe(false);
    });

    it("starts no worktree monitor, watcher, or enumeration", async () => {
      const listService = service["listService"] as unknown as { list: Mock };
      listService.list = vi.fn();
      const startWatcher = vi.spyOn(
        service["topologyWatcher"] as unknown as { startWatcher: () => Promise<void> },
        "startWatcher"
      );

      await service.loadProject("req-plain", "/downloads", "ws-plain");

      expect(monitorCount()).toBe(0);
      expect(listService.list).not.toHaveBeenCalled();
      expect(startWatcher).not.toHaveBeenCalled();
      // `worktree prune` writes into `.git`; a folder Daintree merely adopted
      // must never be written to.
      expect(mockSimpleGit.raw).not.toHaveBeenCalled();
    });

    // #11650. The empty state list this folder produces is indistinguishable
    // from the one a host that has not finished registering produces, so the
    // verdict has to ride along with it — otherwise the renderer has to guess,
    // and guessing "no repository" would strip a real repo's worktree state
    // during the boot race, while guessing "unknown" is what let a folder with
    // no repository adopt another project's worktree in the first place.
    it("reports the folder as not git-backed alongside its empty state list", async () => {
      await service.loadProject("req-plain", "/downloads", "ws-plain");
      sentEvents.length = 0;

      service.getAllStates("states-plain");

      const event = sentEvents.find((e) => e.type === "all-states");
      expect(event).toMatchObject({ states: [], gitBacked: false });
    });

    it("stays inert when the workspace is foregrounded again", async () => {
      await service.loadProject("req-plain", "/downloads", "ws-plain");
      const startWatcher = vi.spyOn(
        service["topologyWatcher"] as unknown as { startWatcher: () => Promise<void> },
        "startWatcher"
      );

      service.pause();
      service.resume();

      expect(startWatcher).not.toHaveBeenCalled();
      expect(monitorCount()).toBe(0);
    });

    it("does not mint a monitor on a later topology reconcile", async () => {
      await service.loadProject("req-plain", "/downloads", "ws-plain");

      await (service as unknown as { discoverAndSyncWorktrees: () => Promise<void> })[
        "discoverAndSyncWorktrees"
      ]();

      expect(monitorCount()).toBe(0);
    });

    it("ignores a sync carrying worktrees from main", async () => {
      await service.loadProject("req-plain", "/downloads", "ws-plain");

      // `WorkspaceClient.sync` fans out to every live host, so a lightweight
      // one can be handed another project's worktree list. Accepting it would
      // arm a monitor whose first poll deletes this workspace.
      await service.syncMonitors(
        [
          {
            id: "wt-1",
            path: "/downloads",
            branch: "main",
            isMainWorktree: true,
          } as unknown as Parameters<typeof service.syncMonitors>[0][number],
        ],
        "wt-1",
        "main"
      );

      expect(monitorCount()).toBe(0);
    });

    it("treats a throwing repository probe as no repository", async () => {
      // simple-git rejects rather than answering false on permission denials
      // and other environment faults.
      mockSimpleGit.checkIsRepo.mockRejectedValue(new Error("EACCES"));

      await service.loadProject("req-denied", "/downloads", "ws-plain");

      expect(sentEvents).toContainEqual({
        type: "load-project-result",
        requestId: "req-denied",
        success: true,
      });
      expect(monitorCount()).toBe(0);
    });
  });

  it("returns a failure when git worktree add hits index.lock contention", async () => {
    mockSimpleGit.raw.mockRejectedValueOnce(
      new Error("fatal: Unable to create '/repo/.git/index.lock': File exists.")
    );

    await service.createWorktree("req-create", "/repo", {
      baseBranch: "main",
      newBranch: "feature/lock",
      path: "/repo/wt-lock",
    });

    expect(sentEvents).toContainEqual(
      expect.objectContaining({
        type: "create-worktree-result",
        requestId: "req-create",
        success: false,
        error: expect.stringContaining("index.lock"),
      })
    );
  });

  it("does not remove existing non-main monitors when adding a new worktree — the single-element syncMonitors bug regression", async () => {
    // Regression guard for the worst bug found in review: passing
    // syncMonitors([createdWorktree]) treated the single-element array as
    // the authoritative worktree set and removed every other non-main monitor
    // (plus firing worktree-removed for each), so bulk-creating 30 worktrees
    // converged to "main + last-created". Fix: createWorktree uses a narrower
    // addNewWorktreeMonitor that only adds.
    const existingPath = pathResolve("/repo/wt-existing");
    const newPath = pathResolve("/repo/wt-new");
    const existingWorktree = {
      id: existingPath,
      path: existingPath,
      name: "feature/existing",
      branch: "feature/existing",
      isCurrent: false,
      isMainWorktree: false,
      gitDir: `${existingPath}/.git`,
    };
    await (
      service as unknown as {
        addNewWorktreeMonitor: (
          wt: typeof existingWorktree,
          isActive: boolean,
          skipInitialGitStatus: boolean
        ) => Promise<void>;
      }
    ).addNewWorktreeMonitor(existingWorktree, false, true);
    expect(service["monitors"].has(existingPath)).toBe(true);

    // Drop the events recorded during the seeding so the assertion below is
    // clean.
    sentEvents.length = 0;

    await service.createWorktree("req-add", "/repo", {
      baseBranch: "main",
      newBranch: "feature/new",
      path: "/repo/wt-new",
    });

    // Both monitors must be present — the existing one was NOT removed.
    expect(service["monitors"].has(existingPath)).toBe(true);
    expect(service["monitors"].has(newPath)).toBe(true);

    // No worktree-removed event was fired for the existing worktree.
    const removedEvents = sentEvents.filter(
      (e): e is WorkspaceHostEvent & { type: "worktree-removed" } => e.type === "worktree-removed"
    );
    expect(removedEvents).toEqual([]);
  });

  it("syncMonitors derives the main branch from the main worktree, not the caller's argument", async () => {
    // The base-branch divergence badge was pinned to "main" because the
    // `mainBranch` argument is never populated with a real value — internal
    // callers pass the stale field straight back. syncMonitors must instead
    // read the actual main worktree's branch (e.g. "develop" in a gitflow
    // repo) so non-PR worktrees diff against the real integration branch.
    const mainWorktree = {
      id: "/repo",
      path: "/repo",
      name: "repo",
      branch: "develop",
      isCurrent: true,
      isMainWorktree: true,
      gitDir: "/repo/.git",
    };
    const featureWorktree = {
      id: "/repo/wt-feature",
      path: "/repo/wt-feature",
      name: "feature/x",
      branch: "feature/x",
      isCurrent: false,
      isMainWorktree: false,
      gitDir: "/repo/wt-feature/.git",
    };

    await (
      service as unknown as {
        syncMonitors: (
          worktrees: unknown[],
          activeId: string | null,
          mainBranch: string,
          monitorConfig: undefined,
          skipInitialGitStatus: boolean
        ) => Promise<void>;
      }
    ).syncMonitors([mainWorktree, featureWorktree], null, "main", undefined, true);

    // The caller passed the stale "main" default; the real integration branch
    // ("develop") is taken from the main worktree instead.
    expect(service["mainBranch"]).toBe("develop");
  });

  it("succeeds without calling listService.list — the Worktree is built from inputs, so an empty list can never fail the create", async () => {
    const listService = service["listService"] as unknown as {
      invalidateCache: Mock;
      list: Mock;
      mapToWorktrees: Mock;
    };

    // Simulate the prior-regression scenario: list returns empty (e.g. the
    // worktree was externally removed before the discovery subprocess ran).
    // Under the old code this produced a "Worktree not found" failure. With
    // opt 3, the subprocess is gone and the direct-build path is unaffected.
    listService.invalidateCache = vi.fn();
    listService.list = vi.fn().mockResolvedValue([]);
    listService.mapToWorktrees = vi.fn().mockReturnValue([]);
    const expectedWorktreeId = pathResolve("/repo/wt-missing");

    await service.createWorktree("req-missing", "/repo", {
      baseBranch: "main",
      newBranch: "feature/missing",
      path: "/repo/wt-missing",
    });

    expect(sentEvents).toContainEqual(
      expect.objectContaining({
        type: "create-worktree-result",
        requestId: "req-missing",
        success: true,
        worktreeId: expectedWorktreeId,
      })
    );
    expect(listService.list).not.toHaveBeenCalled();
  });

  it("does not accumulate duplicate monitors when delete and create overlap on the same path", async () => {
    const racePath = pathResolve("/repo/wt-race");
    let releaseGit!: () => void;
    let signalRawCalled!: () => void;
    const rawCalled = new Promise<void>((resolve) => {
      signalRawCalled = resolve;
    });
    mockSimpleGit.raw.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseGit = resolve;
          signalRawCalled();
        })
    );

    const createPromise = service.createWorktree("req-race-create", "/repo", {
      baseBranch: "main",
      newBranch: "feature/race",
      path: "/repo/wt-race",
    });

    const deletePromise = service.deleteWorktree("req-race-delete", racePath);

    // The containment check (#9154) introduces an await on realpath before
    // `git.raw` runs, so synchronously calling releaseGit() here would land
    // before the mock implementation ran. Wait for the raw call to capture
    // the resolver first.
    await rawCalled;
    releaseGit();
    await Promise.allSettled([createPromise, deletePromise]);

    // Monitor sync now runs in a fire-and-forget tail — let it settle before
    // asserting the monitor map.
    await new Promise((resolve) => setImmediate(resolve));

    const monitorEntries = Array.from(service["monitors"].keys()).filter(
      (worktreeId) => worktreeId === racePath
    );
    expect(monitorEntries.length).toBeLessThanOrEqual(1);
  });

  it("emits 10 successful local create-worktree results under concurrent load without config.lock errors", async () => {
    // Guards the QUEUE_CONCURRENCY=3 bump in BulkCreateWorktreeDialog (#5163):
    // with --no-track on the local-create path (PR #5165), install_branch_config
    // is skipped, so .git/config.lock contention that previously capped the
    // producer queue at 2 no longer applies. Run 10 concurrent createWorktree
    // calls on the fromRemote=false path and assert no result event reports a
    // "could not lock config file" failure.
    const promises = Array.from({ length: 10 }, (_, i) =>
      service.createWorktree(`req-stress-${i}`, "/repo", {
        baseBranch: "main",
        newBranch: `feature/stress-${i}`,
        path: `/repo/wt-stress-${i}`,
        fromRemote: false,
      })
    );

    await Promise.allSettled(promises);
    await new Promise((resolve) => setImmediate(resolve));

    const resultEvents = sentEvents.filter(
      (e): e is WorkspaceHostEvent & { type: "create-worktree-result" } =>
        e.type === "create-worktree-result"
    );

    expect(resultEvents).toHaveLength(10);
    for (const event of resultEvents) {
      expect(event.success).toBe(true);
      if ("error" in event && event.error) {
        expect(event.error).not.toMatch(/could not lock config file/i);
      }
    }

    // Each result must bind to a distinct requestId — rules out duplicated /
    // misrouted success events silently satisfying the count check above.
    const requestIds = new Set(resultEvents.map((e) => e.requestId));
    expect(requestIds.size).toBe(10);
    for (let i = 0; i < 10; i++) {
      expect(requestIds.has(`req-stress-${i}`)).toBe(true);
    }

    // Guard against drifting onto the fromRemote=true --track path, which
    // still writes to .git/config and reintroduces lock contention. Inspect
    // every `worktree add` argv so a partial drift (9 of 10 on --no-track)
    // still fails, unlike an `arrayContaining` smoke check.
    const worktreeAddCalls = mockSimpleGit.raw.mock.calls.filter(
      (call): call is [string[]] =>
        Array.isArray(call[0]) && call[0][0] === "worktree" && call[0][1] === "add"
    );
    expect(worktreeAddCalls).toHaveLength(10);
    for (const [argv] of worktreeAddCalls) {
      expect(argv).toContain("--no-track");
      expect(argv).not.toContain("--track");
    }
  });

  describe("handleInotifyLimitReached", () => {
    const setPlatform = (value: NodeJS.Platform) => {
      Object.defineProperty(process, "platform", { value, configurable: true });
    };

    it("sends a single inotify-limit-reached event on Linux even when called many times", () => {
      const origPlatform = process.platform;
      setPlatform("linux");
      try {
        const privateService = service as unknown as { handleInotifyLimitReached: () => void };
        privateService.handleInotifyLimitReached();
        privateService.handleInotifyLimitReached();
        privateService.handleInotifyLimitReached();

        const inotifyEvents = sentEvents.filter((e) => e.type === "inotify-limit-reached");
        expect(inotifyEvents).toHaveLength(1);
      } finally {
        setPlatform(origPlatform);
      }
    });

    it("does not emit on non-Linux platforms", () => {
      const origPlatform = process.platform;
      setPlatform("darwin");
      try {
        const privateService = service as unknown as { handleInotifyLimitReached: () => void };
        privateService.handleInotifyLimitReached();

        const inotifyEvents = sentEvents.filter((e) => e.type === "inotify-limit-reached");
        expect(inotifyEvents).toHaveLength(0);
      } finally {
        setPlatform(origPlatform);
      }
    });
  });

  describe("handleEmfileLimitReached", () => {
    const setPlatform = (value: NodeJS.Platform) => {
      Object.defineProperty(process, "platform", { value, configurable: true });
    };

    it("sends a single emfile-limit-reached event on macOS even when called many times", () => {
      const origPlatform = process.platform;
      setPlatform("darwin");
      try {
        const privateService = service as unknown as { handleEmfileLimitReached: () => void };
        privateService.handleEmfileLimitReached();
        privateService.handleEmfileLimitReached();
        privateService.handleEmfileLimitReached();

        const emfileEvents = sentEvents.filter((e) => e.type === "emfile-limit-reached");
        expect(emfileEvents).toHaveLength(1);
      } finally {
        setPlatform(origPlatform);
      }
    });

    it("does not emit on non-Darwin platforms", () => {
      const origPlatform = process.platform;
      setPlatform("linux");
      try {
        const privateService = service as unknown as { handleEmfileLimitReached: () => void };
        privateService.handleEmfileLimitReached();

        const emfileEvents = sentEvents.filter((e) => e.type === "emfile-limit-reached");
        expect(emfileEvents).toHaveLength(0);
      } finally {
        setPlatform(origPlatform);
      }
    });
  });

  describe("onPRDetected CI-status preservation (#9551)", () => {
    type OnPRDetected = (worktreeId: string, data: Record<string, unknown>) => void;

    function getOnPRDetected(): OnPRDetected {
      return (service as unknown as { prService: { callbacks: { onPRDetected: OnPRDetected } } })
        .prService.callbacks.onPRDetected;
    }

    function installStubMonitor(opts: {
      worktreeId: string;
      branch: string;
      prNumber: number;
      prCiStatus: string | undefined;
    }): { setPRInfo: Mock } {
      let prCiStatus = opts.prCiStatus;
      let linked: unknown = {
        providerId: "p",
        pr: {
          ref: { providerId: "p", owner: "o", repo: "r", number: opts.prNumber, rawData: null },
          url: "https://example.test/pr",
          state: "open",
          ciStatus: opts.prCiStatus ? { state: "success" } : undefined,
        },
      };
      const setPRInfo = vi.fn((info: { prCiStatus?: string }) => {
        prCiStatus = info.prCiStatus;
      });
      const monitor = {
        branch: opts.branch,
        get hasInitialStatus() {
          return true;
        },
        getSnapshot() {
          return {
            worktreeId: opts.worktreeId,
            prNumber: opts.prNumber,
            prCiStatus,
            linked,
            branch: opts.branch,
          };
        },
        setLinked(l: unknown) {
          linked = l;
        },
        setPRInfo,
      };
      (service as unknown as { monitors: Map<string, unknown> }).monitors.set(
        opts.worktreeId,
        monitor
      );
      return { setPRInfo };
    }

    function baseEvent(overrides: Record<string, unknown>): Record<string, unknown> {
      return {
        prNumber: 42,
        prUrl: "https://example.test/pr",
        prState: "open",
        prCiStatus: undefined,
        prTitle: "PR",
        branchName: "feature/x",
        providerId: "p",
        owner: "o",
        repo: "r",
        ...overrides,
      };
    }

    it("keeps the prior CI rollup on a phase-1 loading emit for the same PR", () => {
      const { setPRInfo } = installStubMonitor({
        worktreeId: "/repo/wt",
        branch: "feature/x",
        prNumber: 42,
        prCiStatus: "success",
      });

      getOnPRDetected()("/repo/wt", baseEvent({ isCiStatusLoading: true, prCiStatus: undefined }));

      // The monitor write and both outbound events keep success — no blink.
      expect(setPRInfo).toHaveBeenCalledWith(expect.objectContaining({ prCiStatus: "success" }));
      const prDetected = sentEvents.find((e) => e.type === "pr-detected") as
        (WorkspaceHostEvent & { prCiStatus?: string }) | undefined;
      expect(prDetected?.prCiStatus).toBe("success");
      const wtUpdate = sentEvents.find((e) => e.type === "worktree-update") as
        (WorkspaceHostEvent & { worktree: { prCiStatus?: string } }) | undefined;
      expect(wtUpdate?.worktree.prCiStatus).toBe("success");
    });

    it("full-replaces to undefined when no loading flag is set (checks genuinely gone)", () => {
      const { setPRInfo } = installStubMonitor({
        worktreeId: "/repo/wt",
        branch: "feature/x",
        prNumber: 42,
        prCiStatus: "success",
      });

      getOnPRDetected()("/repo/wt", baseEvent({ prCiStatus: undefined }));

      expect(setPRInfo).toHaveBeenCalledWith(expect.objectContaining({ prCiStatus: undefined }));
      const prDetected = sentEvents.find((e) => e.type === "pr-detected") as
        (WorkspaceHostEvent & { prCiStatus?: string }) | undefined;
      expect(prDetected?.prCiStatus).toBeUndefined();
    });

    it("does not preserve across a PR reassignment even when loading", () => {
      const { setPRInfo } = installStubMonitor({
        worktreeId: "/repo/wt",
        branch: "feature/x",
        prNumber: 41,
        prCiStatus: "success",
      });

      // New PR number 42 arrives loading — prior PR #41's dot must not carry over.
      getOnPRDetected()(
        "/repo/wt",
        baseEvent({ prNumber: 42, isCiStatusLoading: true, prCiStatus: undefined })
      );

      expect(setPRInfo).toHaveBeenCalledWith(expect.objectContaining({ prCiStatus: undefined }));
    });
  });

  describe("onPRDetected declined state propagation (#9981)", () => {
    type OnPRDetected = (worktreeId: string, data: Record<string, unknown>) => void;

    function getOnPRDetected(): OnPRDetected {
      return (service as unknown as { prService: { callbacks: { onPRDetected: OnPRDetected } } })
        .prService.callbacks.onPRDetected;
    }

    it("keeps declined on linked.pr.state and collapses only the flat prState", () => {
      let linked: { pr?: { state?: string } } | undefined;
      const setPRInfo = vi.fn();
      const monitor = {
        branch: "feature/x",
        get hasInitialStatus() {
          return true;
        },
        getSnapshot() {
          return { worktreeId: "/repo/wt", branch: "feature/x", linked };
        },
        setLinked(l: unknown) {
          linked = l as typeof linked;
        },
        setPRInfo,
      };
      (service as unknown as { monitors: Map<string, unknown> }).monitors.set("/repo/wt", monitor);

      getOnPRDetected()("/repo/wt", {
        prNumber: 7,
        prUrl: "https://bitbucket.example/pr/7",
        prState: "declined",
        prTitle: "PR",
        branchName: "feature/x",
        providerId: "p",
        owner: "o",
        repo: "r",
      });

      // The canonical projection and the monitor's private flat field keep
      // the full provider state; only the outbound legacy field collapses.
      expect(linked?.pr?.state).toBe("declined");
      expect(setPRInfo).toHaveBeenCalledWith(expect.objectContaining({ prState: "declined" }));
      const prDetected = sentEvents.find((e) => e.type === "pr-detected") as
        | (WorkspaceHostEvent & { prState?: string; linked?: { pr?: { state?: string } } })
        | undefined;
      expect(prDetected?.prState).toBe("closed");
      expect(prDetected?.linked?.pr?.state).toBe("declined");
    });
  });
});
