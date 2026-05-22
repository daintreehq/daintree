import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import type { WorktreeSnapshot } from "../../../shared/types/workspace-host.js";
import type { DaintreeEventMap } from "../events.js";
import type { ForgeProviderImpl, RepoRef, PR as ForgePR } from "../../../shared/types/forge.js";

function makeWorktreeSnapshot(
  overrides: Partial<WorktreeSnapshot> & Pick<WorktreeSnapshot, "worktreeId">
): WorktreeSnapshot {
  return {
    id: overrides.worktreeId,
    path: "/repo",
    name: "Worktree",
    isCurrent: false,
    ...overrides,
  };
}

function makeMockRepoRef(): RepoRef {
  return { host: "github.com", owner: "testowner", repo: "testrepo", rawData: null };
}

function makeMockForgePR(overrides?: Partial<ForgePR>): ForgePR {
  return {
    number: 42,
    title: "Add new feature",
    body: "",
    state: "open",
    rawState: "OPEN",
    isDraft: false,
    merged: false,
    url: "https://github.com/o/r/pull/42",
    baseRef: "main",
    headRef: "feature/test",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    rawData: null,
    ...overrides,
  };
}

function mockForgeProviderResolved(
  findPRByBranch?: () => Promise<ForgePR | null>,
  findPRsByBranches?: (repo: RepoRef, branches: string[]) => Promise<Map<string, ForgePR | null>>
) {
  const mockImpl: ForgeProviderImpl = {
    getCredentials: vi.fn(),
    validateCredentials: vi.fn(),
    parseRemote: vi.fn(() => makeMockRepoRef()),
    listIssues: vi.fn(),
    listPRs: vi.fn(),
    getIssue: vi.fn().mockResolvedValue(null),
    getPR: vi.fn().mockResolvedValue(null),
    findPRByBranch: vi
      .fn<() => Promise<ForgePR | null>>()
      .mockImplementation(findPRByBranch ?? (async () => makeMockForgePR())),
    ...(findPRsByBranches
      ? {
          findPRsByBranches: vi
            .fn<(repo: RepoRef, branches: string[]) => Promise<Map<string, ForgePR | null>>>()
            .mockImplementation(findPRsByBranches),
        }
      : {}),
    getCIStatus: vi.fn().mockResolvedValue(null),
    getRepoMetadata: vi.fn(),
    buildIssueUrl: vi.fn(),
    buildPRUrl: vi.fn(),
    buildIssuesUrl: vi.fn(),
    buildPRsUrl: vi.fn(),
    buildCommitsUrl: vi.fn(),
    assignIssue: vi.fn(),
    validateToken: vi.fn(),
    getRateLimit: vi.fn().mockResolvedValue({ limit: null, remaining: null, resetAt: null }),
  };

  vi.doMock("../forgeProviderResolver.js", () => ({
    resolveForgeProvider: vi.fn().mockReturnValue({
      entry: {
        pluginId: "daintree.github",
        contribution: { id: "github", name: "GitHub", matches: ["github.com"] },
      },
      resolvedVia: "hostname",
    }),
  }));
  vi.doMock("../forgeProviderRegistry.js", () => ({
    getForgeProviderImpl: vi.fn().mockReturnValue(mockImpl),
    registerForgeProviders: vi.fn(),
    unregisterForgeProviders: vi.fn(),
    clearForgeProviderRegistry: vi.fn(),
  }));
  vi.doMock("../projectStorePaths.js", () => ({
    generateProjectId: vi.fn().mockReturnValue("test-project-id"),
  }));
  vi.doMock("../../utils/hardenedGit.js", () => ({
    createHardenedGit: vi.fn().mockReturnValue({
      getConfig: vi.fn().mockResolvedValue("https://github.com/testowner/testrepo.git"),
    }),
  }));

  return mockImpl;
}

function mockForgeProviderUnresolved() {
  vi.doMock("../forgeProviderResolver.js", () => ({
    resolveForgeProvider: vi.fn().mockReturnValue({ entry: null, resolvedVia: null }),
  }));
  vi.doMock("../forgeProviderRegistry.js", () => ({
    getForgeProviderImpl: vi.fn().mockReturnValue(undefined),
  }));
  vi.doMock("../projectStorePaths.js", () => ({
    generateProjectId: vi.fn().mockReturnValue("test-project-id"),
  }));
  vi.doMock("../../utils/hardenedGit.js", () => ({
    createHardenedGit: vi.fn().mockReturnValue({
      getConfig: vi.fn().mockResolvedValue("https://github.com/testowner/testrepo.git"),
    }),
  }));
}

describe("PullRequestService", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("detects PRs for non-default branches without issue numbers", async () => {
    const clearPRCaches = vi.fn();
    vi.doMock("../GitHubService.js", () => ({ clearPRCaches }));

    const mockImpl = mockForgeProviderResolved();

    const { pullRequestService } = await import("../PullRequestService.js");
    const { events } = await import("../events.js");

    const detected: DaintreeEventMap["sys:pr:detected"][] = [];
    const unsubscribe = events.on("sys:pr:detected", (payload) => detected.push(payload));

    pullRequestService.initialize("/repo");

    events.emit(
      "sys:worktree:update",
      makeWorktreeSnapshot({ worktreeId: "wt-1", branch: "feature/no-issue" })
    );

    await pullRequestService.refresh();

    expect(mockImpl.findPRByBranch).toHaveBeenCalledTimes(1);
    expect(mockImpl.findPRByBranch).toHaveBeenCalledWith(
      expect.objectContaining({ owner: "testowner", repo: "testrepo" }),
      "feature/no-issue"
    );

    expect(detected).toHaveLength(1);
    expect(detected[0]).toMatchObject({
      worktreeId: "wt-1",
      prNumber: 42,
      prUrl: "https://github.com/o/r/pull/42",
      prState: "open",
      prTitle: "Add new feature",
      providerId: "daintree.github.github",
      // #8452: the canonical repo identity must ride the event from the
      // resolved repoRef, not be synthesized downstream with empty strings.
      owner: "testowner",
      repo: "testrepo",
    });
    expect(detected[0].issueNumber).toBeUndefined();

    unsubscribe();
    pullRequestService.destroy();
  });

  it("emits sys:issue:detected carrying the canonical owner/repo (#8452)", async () => {
    vi.doMock("../GitHubService.js", () => ({ clearPRCaches: vi.fn() }));
    const mockImpl = mockForgeProviderResolved();
    mockImpl.getIssue = vi.fn().mockResolvedValue({
      number: 88,
      title: "Widget request",
      state: "open",
      rawState: "OPEN",
      url: "https://github.com/o/r/issues/88",
      rawData: null,
    });

    const { pullRequestService } = await import("../PullRequestService.js");
    const { events } = await import("../events.js");

    const issues: DaintreeEventMap["sys:issue:detected"][] = [];
    const unsubscribe = events.on("sys:issue:detected", (payload) => issues.push(payload));

    pullRequestService.initialize("/repo");
    events.emit(
      "sys:worktree:update",
      makeWorktreeSnapshot({ worktreeId: "wt-1", branch: "feature/widget", issueNumber: 88 })
    );

    await pullRequestService.refresh();

    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      worktreeId: "wt-1",
      issueNumber: 88,
      issueTitle: "Widget request",
      providerId: "daintree.github.github",
      owner: "testowner",
      repo: "testrepo",
    });

    unsubscribe();
    pullRequestService.destroy();
  });

  it("resolves the provider against the selected forgeRemote, not origin (#8456)", async () => {
    const clearPRCaches = vi.fn();
    vi.doMock("../GitHubService.js", () => ({ clearPRCaches }));

    const resolveForgeProvider = vi.fn().mockReturnValue({ entry: null, resolvedVia: null });
    vi.doMock("../forgeProviderResolver.js", () => ({ resolveForgeProvider }));
    vi.doMock("../forgeProviderRegistry.js", () => ({
      getForgeProviderImpl: vi.fn().mockReturnValue(undefined),
    }));
    vi.doMock("../projectStorePaths.js", () => ({
      generateProjectId: vi.fn().mockReturnValue("test-project-id"),
    }));
    const getConfig = vi.fn(async (key: string) =>
      key === "remote.upstream.url"
        ? "https://github.com/upstreamowner/upstreamrepo.git"
        : "https://github.com/originowner/originrepo.git"
    );
    vi.doMock("../../utils/hardenedGit.js", () => ({
      createHardenedGit: vi.fn().mockReturnValue({ getConfig }),
    }));

    const { pullRequestService } = await import("../PullRequestService.js");

    pullRequestService.initialize("/repo");
    pullRequestService.setForgeSettings({
      forgeProviderOverride: null,
      forgeDefaultProviderId: null,
      forgeRemote: "upstream",
    });

    await pullRequestService.refresh();

    expect(getConfig).toHaveBeenCalledWith("remote.upstream.url");
    expect(resolveForgeProvider).toHaveBeenCalledWith(
      expect.objectContaining({ remoteUrl: "https://github.com/upstreamowner/upstreamrepo.git" })
    );

    pullRequestService.destroy();
  });

  it("falls back to origin when the selected forgeRemote has no URL (#8456)", async () => {
    const clearPRCaches = vi.fn();
    vi.doMock("../GitHubService.js", () => ({ clearPRCaches }));

    const resolveForgeProvider = vi.fn().mockReturnValue({ entry: null, resolvedVia: null });
    vi.doMock("../forgeProviderResolver.js", () => ({ resolveForgeProvider }));
    vi.doMock("../forgeProviderRegistry.js", () => ({
      getForgeProviderImpl: vi.fn().mockReturnValue(undefined),
    }));
    vi.doMock("../projectStorePaths.js", () => ({
      generateProjectId: vi.fn().mockReturnValue("test-project-id"),
    }));
    const getConfig = vi.fn(async (key: string) =>
      key === "remote.origin.url" ? "https://github.com/originowner/originrepo.git" : null
    );
    vi.doMock("../../utils/hardenedGit.js", () => ({
      createHardenedGit: vi.fn().mockReturnValue({ getConfig }),
    }));

    const { pullRequestService } = await import("../PullRequestService.js");

    pullRequestService.initialize("/repo");
    pullRequestService.setForgeSettings({
      forgeProviderOverride: null,
      forgeDefaultProviderId: null,
      forgeRemote: "missing",
    });

    await pullRequestService.refresh();

    expect(resolveForgeProvider).toHaveBeenCalledWith(
      expect.objectContaining({ remoteUrl: "https://github.com/originowner/originrepo.git" })
    );

    pullRequestService.destroy();
  });

  it("does not track default branches like main/master", async () => {
    const clearPRCaches = vi.fn();
    vi.doMock("../GitHubService.js", () => ({ clearPRCaches }));
    const mockImpl = mockForgeProviderResolved();

    const { pullRequestService } = await import("../PullRequestService.js");
    const { events } = await import("../events.js");

    pullRequestService.initialize("/repo");

    events.emit(
      "sys:worktree:update",
      makeWorktreeSnapshot({ worktreeId: "wt-main", branch: "main" })
    );
    events.emit(
      "sys:worktree:update",
      makeWorktreeSnapshot({ worktreeId: "wt-master", branch: "master" })
    );

    await pullRequestService.refresh();

    expect(mockImpl.findPRByBranch).not.toHaveBeenCalled();

    pullRequestService.destroy();
  });

  it("clears PR state only when branch changes (not when issue number changes)", async () => {
    const clearPRCaches = vi.fn();
    vi.doMock("../GitHubService.js", () => ({ clearPRCaches }));
    mockForgeProviderResolved(async () =>
      makeMockForgePR({ number: 7, title: "Fix bug", url: "https://github.com/o/r/pull/7" })
    );

    const { pullRequestService } = await import("../PullRequestService.js");
    const { events } = await import("../events.js");

    const cleared: DaintreeEventMap["sys:pr:cleared"][] = [];
    const unsubscribeCleared = events.on("sys:pr:cleared", (payload) => cleared.push(payload));

    pullRequestService.initialize("/repo");

    events.emit(
      "sys:worktree:update",
      makeWorktreeSnapshot({ worktreeId: "wt-1", branch: "feature/a", issueNumber: undefined })
    );
    await pullRequestService.refresh();

    events.emit(
      "sys:worktree:update",
      makeWorktreeSnapshot({ worktreeId: "wt-1", branch: "feature/a", issueNumber: 123 })
    );

    expect(cleared).toHaveLength(0);

    events.emit(
      "sys:worktree:update",
      makeWorktreeSnapshot({ worktreeId: "wt-1", branch: "feature/b", issueNumber: 123 })
    );

    expect(cleared).toHaveLength(1);
    expect(cleared[0]).toMatchObject({ worktreeId: "wt-1", timestamp: expect.any(Number) });

    unsubscribeCleared();
    pullRequestService.destroy();
  });

  it("uses findPRsByBranches batch capability when present (single round-trip for many branches)", async () => {
    const clearPRCaches = vi.fn();
    vi.doMock("../GitHubService.js", () => ({ clearPRCaches }));

    const batchSpy = vi.fn(async (_repo: RepoRef, branches: string[]) => {
      const map = new Map<string, ForgePR | null>();
      for (const branch of branches) {
        map.set(
          branch,
          makeMockForgePR({
            number: branch === "feature/a" ? 1 : 2,
            headRef: branch,
            url: `https://github.com/o/r/pull/${branch === "feature/a" ? 1 : 2}`,
          })
        );
      }
      return map;
    });

    const mockImpl = mockForgeProviderResolved(undefined, batchSpy);

    const { pullRequestService } = await import("../PullRequestService.js");
    const { events } = await import("../events.js");

    const detected: DaintreeEventMap["sys:pr:detected"][] = [];
    const unsubscribe = events.on("sys:pr:detected", (payload) => detected.push(payload));

    pullRequestService.initialize("/repo");

    events.emit(
      "sys:worktree:update",
      makeWorktreeSnapshot({ worktreeId: "wt-1", branch: "feature/a" })
    );
    events.emit(
      "sys:worktree:update",
      makeWorktreeSnapshot({ worktreeId: "wt-2", branch: "feature/b" })
    );

    await pullRequestService.refresh();

    expect(batchSpy).toHaveBeenCalledTimes(1);
    expect(batchSpy).toHaveBeenCalledWith(
      expect.objectContaining({ owner: "testowner", repo: "testrepo" }),
      expect.arrayContaining(["feature/a", "feature/b"])
    );
    // Per-branch path must NOT be used when the batch capability is present and succeeds.
    expect(mockImpl.findPRByBranch).not.toHaveBeenCalled();
    expect(detected).toHaveLength(2);

    const byWorktree = new Map(detected.map((d) => [d.worktreeId, d]));
    expect(byWorktree.get("wt-1")).toMatchObject({
      prNumber: 1,
      prUrl: expect.stringMatching(/\/1$/),
    });
    expect(byWorktree.get("wt-2")).toMatchObject({
      prNumber: 2,
      prUrl: expect.stringMatching(/\/2$/),
    });

    unsubscribe();
    pullRequestService.destroy();
  });

  it("fans out a single batched PR result to every worktree on the same branch", async () => {
    const clearPRCaches = vi.fn();
    vi.doMock("../GitHubService.js", () => ({ clearPRCaches }));

    const batchSpy = vi.fn(async (_repo: RepoRef, branches: string[]) => {
      const map = new Map<string, ForgePR | null>();
      for (const branch of branches) {
        map.set(branch, makeMockForgePR({ number: 99, headRef: branch }));
      }
      return map;
    });

    mockForgeProviderResolved(undefined, batchSpy);

    const { pullRequestService } = await import("../PullRequestService.js");
    const { events } = await import("../events.js");

    const detected: DaintreeEventMap["sys:pr:detected"][] = [];
    const unsubscribe = events.on("sys:pr:detected", (payload) => detected.push(payload));

    pullRequestService.initialize("/repo");

    events.emit(
      "sys:worktree:update",
      makeWorktreeSnapshot({ worktreeId: "wt-a", branch: "shared/branch" })
    );
    events.emit(
      "sys:worktree:update",
      makeWorktreeSnapshot({ worktreeId: "wt-b", branch: "shared/branch" })
    );

    await pullRequestService.refresh();

    // Branch deduplication: one batch call with a single unique branch
    expect(batchSpy).toHaveBeenCalledWith(
      expect.anything(),
      expect.arrayContaining(["shared/branch"])
    );
    // Both worktrees get a detection event from the single PR
    expect(detected).toHaveLength(2);
    const worktreeIds = detected.map((d) => d.worktreeId).sort();
    expect(worktreeIds).toEqual(["wt-a", "wt-b"]);
    expect(detected.every((d) => d.prNumber === 99)).toBe(true);

    unsubscribe();
    pullRequestService.destroy();
  });

  it("falls back to per-branch findPRByBranch when batch capability throws", async () => {
    const clearPRCaches = vi.fn();
    vi.doMock("../GitHubService.js", () => ({ clearPRCaches }));

    const batchSpy = vi.fn(async () => {
      throw new Error("transient batch failure");
    });

    const mockImpl = mockForgeProviderResolved(undefined, batchSpy);

    const { pullRequestService } = await import("../PullRequestService.js");
    const { events } = await import("../events.js");

    const detected: DaintreeEventMap["sys:pr:detected"][] = [];
    const unsubscribe = events.on("sys:pr:detected", (payload) => detected.push(payload));

    pullRequestService.initialize("/repo");

    events.emit(
      "sys:worktree:update",
      makeWorktreeSnapshot({ worktreeId: "wt-1", branch: "feature/a" })
    );
    events.emit(
      "sys:worktree:update",
      makeWorktreeSnapshot({ worktreeId: "wt-2", branch: "feature/b" })
    );

    await pullRequestService.refresh();

    expect(batchSpy).toHaveBeenCalledTimes(1);
    // Per-branch fallback fires for each unique branch on batch failure.
    expect(mockImpl.findPRByBranch).toHaveBeenCalledTimes(2);
    // Detection still completes — a single transient batch error must not blank every row.
    expect(detected).toHaveLength(2);

    unsubscribe();
    pullRequestService.destroy();
  });

  it("uses per-branch fallback for branches the batch result omits", async () => {
    const clearPRCaches = vi.fn();
    vi.doMock("../GitHubService.js", () => ({ clearPRCaches }));

    const batchSpy = vi.fn(async (_repo: RepoRef, branches: string[]) => {
      const map = new Map<string, ForgePR | null>();
      // Resolve only the first branch — omit the second to exercise the partial-result path.
      if (branches.length > 0) {
        map.set(branches[0], makeMockForgePR({ number: 10 }));
      }
      return map;
    });

    const mockImpl = mockForgeProviderResolved(undefined, batchSpy);

    const { pullRequestService } = await import("../PullRequestService.js");
    const { events } = await import("../events.js");

    pullRequestService.initialize("/repo");

    events.emit(
      "sys:worktree:update",
      makeWorktreeSnapshot({ worktreeId: "wt-1", branch: "feature/a" })
    );
    events.emit(
      "sys:worktree:update",
      makeWorktreeSnapshot({ worktreeId: "wt-2", branch: "feature/b" })
    );

    await pullRequestService.refresh();

    expect(batchSpy).toHaveBeenCalledTimes(1);
    // Exactly one per-branch fallback call — for the omitted branch.
    expect(mockImpl.findPRByBranch).toHaveBeenCalledTimes(1);
    expect(mockImpl.findPRByBranch).toHaveBeenCalledWith(
      expect.objectContaining({ owner: "testowner", repo: "testrepo" }),
      "feature/b"
    );

    pullRequestService.destroy();
  });

  it("no-ops when no forge provider is resolved (null linkage, no toast, no error)", async () => {
    const clearPRCaches = vi.fn();
    vi.doMock("../GitHubService.js", () => ({ clearPRCaches }));
    mockForgeProviderUnresolved();

    const { pullRequestService } = await import("../PullRequestService.js");
    const { events } = await import("../events.js");

    const detected: DaintreeEventMap["sys:pr:detected"][] = [];
    const unsubscribe = events.on("sys:pr:detected", (payload) => detected.push(payload));

    pullRequestService.initialize("/repo");

    events.emit(
      "sys:worktree:update",
      makeWorktreeSnapshot({ worktreeId: "wt-1", branch: "feature/test" })
    );

    await pullRequestService.refresh();

    // No PR detected — unresolved provider means null linkage
    expect(detected).toHaveLength(0);

    unsubscribe();
    pullRequestService.destroy();
  });

  it("skips polling when provider reports remaining: 0 with a future resetAt", async () => {
    const clearPRCaches = vi.fn();
    vi.doMock("../GitHubService.js", () => ({ clearPRCaches }));

    const futureReset = Date.now() + 30_000;
    const mockImpl = mockForgeProviderResolved();
    mockImpl.getRateLimit = vi.fn().mockResolvedValue({
      limit: 5000,
      remaining: 0,
      resetAt: futureReset,
    });

    const { pullRequestService } = await import("../PullRequestService.js");
    const { events } = await import("../events.js");

    pullRequestService.initialize("/repo");

    events.emit(
      "sys:worktree:update",
      makeWorktreeSnapshot({ worktreeId: "wt-1", branch: "feature/test" })
    );

    await pullRequestService.refresh();

    expect(mockImpl.getRateLimit).toHaveBeenCalled();
    expect(mockImpl.findPRByBranch).not.toHaveBeenCalled();
    expect(mockImpl.getIssue).not.toHaveBeenCalled();

    const status = pullRequestService.getStatus();
    expect(status.isEnabled).toBe(false);

    pullRequestService.destroy();
  });

  it("skips polling when provider reports secondaryThrottled: true", async () => {
    const clearPRCaches = vi.fn();
    vi.doMock("../GitHubService.js", () => ({ clearPRCaches }));

    const mockImpl = mockForgeProviderResolved();
    mockImpl.getRateLimit = vi.fn().mockResolvedValue({
      limit: 5000,
      remaining: 200,
      resetAt: null,
      secondaryThrottled: true,
    });

    const { pullRequestService } = await import("../PullRequestService.js");
    const { events } = await import("../events.js");

    pullRequestService.initialize("/repo");

    events.emit(
      "sys:worktree:update",
      makeWorktreeSnapshot({ worktreeId: "wt-1", branch: "feature/test" })
    );

    await pullRequestService.refresh();

    expect(mockImpl.getRateLimit).toHaveBeenCalled();
    expect(mockImpl.findPRByBranch).not.toHaveBeenCalled();
    expect(mockImpl.getIssue).not.toHaveBeenCalled();

    pullRequestService.destroy();
  });

  it("proceeds normally when getRateLimit is absent from the provider", async () => {
    const clearPRCaches = vi.fn();
    vi.doMock("../GitHubService.js", () => ({ clearPRCaches }));

    const mockImpl = mockForgeProviderResolved();
    delete (mockImpl as unknown as Record<string, unknown>).getRateLimit;

    const { pullRequestService } = await import("../PullRequestService.js");
    const { events } = await import("../events.js");

    pullRequestService.initialize("/repo");

    events.emit(
      "sys:worktree:update",
      makeWorktreeSnapshot({ worktreeId: "wt-1", branch: "feature/test" })
    );

    await pullRequestService.refresh();

    expect(mockImpl.findPRByBranch).toHaveBeenCalledTimes(1);

    pullRequestService.destroy();
  });

  it("proceeds normally when remaining is null (provider doesn't report that dimension)", async () => {
    const clearPRCaches = vi.fn();
    vi.doMock("../GitHubService.js", () => ({ clearPRCaches }));

    const mockImpl = mockForgeProviderResolved();
    mockImpl.getRateLimit = vi.fn().mockResolvedValue({
      limit: null,
      remaining: null,
      resetAt: null,
    });

    const { pullRequestService } = await import("../PullRequestService.js");
    const { events } = await import("../events.js");

    pullRequestService.initialize("/repo");

    events.emit(
      "sys:worktree:update",
      makeWorktreeSnapshot({ worktreeId: "wt-1", branch: "feature/test" })
    );

    await pullRequestService.refresh();

    expect(mockImpl.findPRByBranch).toHaveBeenCalledTimes(1);

    pullRequestService.destroy();
  });

  it("proceeds normally when getRateLimit rejects (fails open)", async () => {
    const clearPRCaches = vi.fn();
    vi.doMock("../GitHubService.js", () => ({ clearPRCaches }));

    const mockImpl = mockForgeProviderResolved();
    mockImpl.getRateLimit = vi.fn().mockRejectedValue(new Error("timeout"));

    const { pullRequestService } = await import("../PullRequestService.js");
    const { events } = await import("../events.js");

    pullRequestService.initialize("/repo");

    events.emit(
      "sys:worktree:update",
      makeWorktreeSnapshot({ worktreeId: "wt-1", branch: "feature/test" })
    );

    await pullRequestService.refresh();

    expect(mockImpl.findPRByBranch).toHaveBeenCalledTimes(1);

    pullRequestService.destroy();
  });

  it("skips revalidation when provider reports rate-limited", async () => {
    const clearPRCaches = vi.fn();
    vi.doMock("../GitHubService.js", () => ({ clearPRCaches }));

    const mockImpl = mockForgeProviderResolved();
    // First call succeeds to get a resolved PR, then rate-limit kicks in
    // so revalidation blocks
    let callCount = 0;
    mockImpl.getRateLimit = vi.fn().mockImplementation(() => {
      callCount++;
      return Promise.resolve(
        callCount <= 1
          ? { limit: null, remaining: null, resetAt: null }
          : { limit: 5000, remaining: 0, resetAt: Date.now() + 60_000 }
      );
    });

    const { pullRequestService } = await import("../PullRequestService.js");
    const { events } = await import("../events.js");

    pullRequestService.initialize("/repo");

    events.emit(
      "sys:worktree:update",
      makeWorktreeSnapshot({ worktreeId: "wt-1", branch: "feature/test" })
    );

    await pullRequestService.refresh();

    // PR was detected (first getRateLimit was clear)
    expect(mockImpl.findPRByBranch).toHaveBeenCalledTimes(1);

    // Manually revalidate — now getRateLimit returns blocked
    await (pullRequestService as any).revalidateResolvedPRs();

    // Revalidation was blocked by rate-limit gate; provider PR ops were NOT called
    expect(mockImpl.getPR).not.toHaveBeenCalled();

    pullRequestService.destroy();
  });

  describe("issueTitle retry after PR resolved (#8851)", () => {
    it("retries getIssue on subsequent checkForPRs runs after a resolved PR's first issue fetch returns null", async () => {
      vi.doMock("../GitHubService.js", () => ({ clearPRCaches: vi.fn() }));
      const mockImpl = mockForgeProviderResolved();
      const getIssue = vi
        .fn<() => Promise<{ number: number; title: string } | null>>()
        .mockResolvedValueOnce(null)
        .mockResolvedValue({
          number: 88,
          title: "Eventually fetched title",
          state: "open",
          rawState: "OPEN",
          url: "https://github.com/o/r/issues/88",
          rawData: null,
        } as unknown as { number: number; title: string });
      // Override the default null with our staged sequence.
      mockImpl.getIssue = getIssue as unknown as typeof mockImpl.getIssue;

      const { pullRequestService } = await import("../PullRequestService.js");
      const { events } = await import("../events.js");

      const detected: DaintreeEventMap["sys:issue:detected"][] = [];
      const unsubscribe = events.on("sys:issue:detected", (payload) => detected.push(payload));

      pullRequestService.initialize("/repo");
      events.emit(
        "sys:worktree:update",
        makeWorktreeSnapshot({
          worktreeId: "wt-1",
          branch: "feature/issue-88-thing",
          issueNumber: 88,
        })
      );

      // First pass: resolve the provider + PR via refresh() (clears throttle).
      // The first getIssue returns null, so no fetched marker is written.
      await pullRequestService.refresh();
      expect(mockImpl.findPRByBranch).toHaveBeenCalledTimes(1);
      expect(getIssue).toHaveBeenCalledTimes(1);
      expect(detected).toHaveLength(0);

      const svc = pullRequestService as unknown as {
        checkForPRs: () => Promise<void>;
        lastCheckAt: number;
      };

      // Second pass: bypass the 5s throttle, then trigger another check.
      // The worktree is in resolvedWorktrees but NOT in
      // issueTitleFetchedWorktrees, so the issue lookup must run again.
      svc.lastCheckAt = Number.NEGATIVE_INFINITY;
      await svc.checkForPRs();
      expect(getIssue).toHaveBeenCalledTimes(2);
      expect(detected).toHaveLength(1);
      expect(detected[0]).toMatchObject({
        worktreeId: "wt-1",
        issueNumber: 88,
        issueTitle: "Eventually fetched title",
      });

      // Third pass: the marker is now set; no further getIssue calls.
      svc.lastCheckAt = Number.NEGATIVE_INFINITY;
      await svc.checkForPRs();
      expect(getIssue).toHaveBeenCalledTimes(2);

      unsubscribe();
      pullRequestService.destroy();
    });
  });
});
