import { EventEmitter } from "events";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { WorkspaceService } from "../WorkspaceService.js";
import type { WorkspaceHostEvent } from "../../../shared/types/workspace-host.js";

const mockSimpleGit = {
  raw: vi.fn(),
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
}));

vi.mock("../../utils/git.js", () => ({
  invalidateGitStatusCache: vi.fn(),
}));

vi.mock("../../utils/gitUtils.js", () => ({
  getGitDir: vi.fn().mockReturnValue("/test/worktree/.git"),
  clearGitDirCache: vi.fn(),
}));

vi.mock("../../services/issueExtractor.js", () => ({
  extractIssueNumberSync: vi.fn().mockReturnValue(null),
  extractIssueNumber: vi.fn().mockResolvedValue(null),
}));

vi.mock("../../services/github/GitHubAuth.js", () => ({
  GitHubAuth: vi.fn().mockImplementation(() => ({
    getToken: vi.fn().mockResolvedValue(null),
  })),
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
}));

describe("WorkspaceService adversarial", () => {
  let service: WorkspaceService;
  let sentEvents: WorkspaceHostEvent[];

  beforeEach(async () => {
    vi.clearAllMocks();
    mockSimpleGit.raw.mockResolvedValue(undefined);
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

    await service.loadProject("req-load", "/repo");

    expect(sentEvents).toContainEqual(
      expect.objectContaining({
        type: "load-project-result",
        requestId: "req-load",
        success: false,
        error: "Corrupted worktree metadata",
      })
    );
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
    const existingWorktree = {
      id: "/repo/wt-existing",
      path: "/repo/wt-existing",
      name: "feature/existing",
      branch: "feature/existing",
      isCurrent: false,
      isMainWorktree: false,
      gitDir: "/repo/wt-existing/.git",
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
    expect(service["monitors"].has("/repo/wt-existing")).toBe(true);

    // Drop the events recorded during the seeding so the assertion below is
    // clean.
    sentEvents.length = 0;

    await service.createWorktree("req-add", "/repo", {
      baseBranch: "main",
      newBranch: "feature/new",
      path: "/repo/wt-new",
    });

    // Both monitors must be present — the existing one was NOT removed.
    expect(service["monitors"].has("/repo/wt-existing")).toBe(true);
    expect(service["monitors"].has("/repo/wt-new")).toBe(true);

    // No worktree-removed event was fired for the existing worktree.
    const removedEvents = sentEvents.filter(
      (e): e is WorkspaceHostEvent & { type: "worktree-removed" } => e.type === "worktree-removed"
    );
    expect(removedEvents).toEqual([]);
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
        worktreeId: "/repo/wt-missing",
      })
    );
    expect(listService.list).not.toHaveBeenCalled();
  });

  it("does not accumulate duplicate monitors when delete and create overlap on the same path", async () => {
    let releaseGit!: () => void;
    mockSimpleGit.raw.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseGit = resolve;
        })
    );

    const createPromise = service.createWorktree("req-race-create", "/repo", {
      baseBranch: "main",
      newBranch: "feature/race",
      path: "/repo/wt-race",
    });

    const deletePromise = service.deleteWorktree("req-race-delete", "/repo/wt-race");

    releaseGit();
    await Promise.allSettled([createPromise, deletePromise]);

    // Monitor sync now runs in a fire-and-forget tail — let it settle before
    // asserting the monitor map.
    await new Promise((resolve) => setImmediate(resolve));

    const monitorEntries = Array.from(service["monitors"].keys()).filter(
      (worktreeId) => worktreeId === "/repo/wt-race"
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
});
