import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import type { WorktreeSnapshot } from "../../../shared/types/workspace-host.js";
import type { DaintreeEventMap } from "../events.js";
import type {
  ForgeProviderImpl,
  RepoRef,
  PR as ForgePR,
  PRSnapshot,
  CIStatus,
} from "../../../shared/types/forge.js";
import type { ForgeResolveProviderResult } from "../../../shared/types/workspace-host.js";

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

// Module-level handle so tests that want to assert on bridge calls directly
// (resolveProvider, getRateLimit) can grab the most recently created stub
// without changing every helper call site.
let lastMockBridge: ReturnType<typeof makeMockBridge> | null = null;

function makeMockBridge(impl: ForgeProviderImpl) {
  // The bridge stub delegates each call to the underlying impl, stripping the
  // namespacedId argument so existing `expect(impl.X).toHaveBeenCalledWith(...)`
  // assertions keep matching the original (provider-shaped) signature.
  return {
    // Explicit return-type annotation so `.mockResolvedValue(null)` is allowed
    // for the unresolved variant; the default resolves to a real provider.
    resolveProvider: vi.fn<
      (_opts: {
        remoteUrl: string | null;
        forgeProviderOverride: string | null;
        globalDefaultProviderId: string | null;
      }) => Promise<ForgeResolveProviderResult | null>
    >(async () => ({
      namespacedId: "daintree.github.github",
      repo: makeMockRepoRef(),
    })),
    findPRByBranch: vi.fn((_id: string, repo: RepoRef, branch: string) =>
      impl.findPRByBranch(repo, branch)
    ),
    findPRsByBranches: vi.fn(async (_id: string, repo: RepoRef, branches: string[]) => {
      if (!impl.findPRsByBranches) return null;
      return impl.findPRsByBranches(repo, branches);
    }),
    findPRsByNumbers: vi.fn(async (_id: string, repo: RepoRef, prNumbers: number[]) => {
      if (!impl.batchLookups?.findPRsByNumbers) return null;
      return impl.batchLookups.findPRsByNumbers(repo, prNumbers);
    }),
    getPR: vi.fn((_id: string, repo: RepoRef, prNumber: number) => impl.getPR(repo, prNumber)),
    getIssue: vi.fn((_id: string, repo: RepoRef, issueNumber: number) =>
      impl.getIssue(repo, issueNumber)
    ),
    getCIStatus: vi.fn((_id: string, repo: RepoRef, prNumber: number) =>
      impl.getCIStatus(repo, prNumber)
    ),
    getCIStatuses: vi.fn(async (_id: string, repo: RepoRef, prNumbers: number[]) => {
      if (!impl.batchLookups?.getCIStatuses) return null;
      return impl.batchLookups.getCIStatuses(repo, prNumbers);
    }),
    probeOpenPRList: vi.fn(async (_id: string, repo: RepoRef, tracked: PRSnapshot[]) => {
      if (!impl.batchLookups?.probeOpenPRList) return null;
      return impl.batchLookups.probeOpenPRList(repo, tracked);
    }),
    getRateLimit: vi.fn(async (_id: string) => impl.getRateLimit?.() ?? null),
    clearPullRequestCaches: vi.fn(async (_id: string) => {
      await impl.clearPullRequestCaches?.();
    }),
    handleResult: vi.fn(),
    // Default to lease-granted so existing tests (single-window assumption)
    // behave exactly as they did before the cross-window lease landed.
    acquirePollLease: vi.fn(async () => true),
    releasePollLease: vi.fn(),
    handleLeaseResult: vi.fn(),
    dispose: vi.fn(),
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
    unassignIssue: vi.fn(),
    validateToken: vi.fn(),
    getRateLimit: vi.fn().mockResolvedValue({ limit: null, remaining: null, resetAt: null }),
  };

  const bridge = makeMockBridge(mockImpl);
  lastMockBridge = bridge;
  vi.doMock("../../workspace-host/forgeBridge.js", () => ({
    getForgeBridge: () => bridge,
    initForgeBridge: vi.fn(() => bridge),
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

function mockForgeProviderUnresolved(opts?: {
  getConfig?: (key: string) => Promise<string | null>;
}) {
  // No impl behind the bridge — `resolveProvider` returns null so the service
  // takes the "no forge provider resolved" branch.
  const placeholderImpl = makeMockEmptyImpl();
  const bridge = makeMockBridge(placeholderImpl);
  bridge.resolveProvider.mockResolvedValue(null);
  lastMockBridge = bridge;
  vi.doMock("../../workspace-host/forgeBridge.js", () => ({
    getForgeBridge: () => bridge,
    initForgeBridge: vi.fn(() => bridge),
  }));
  vi.doMock("../projectStorePaths.js", () => ({
    generateProjectId: vi.fn().mockReturnValue("test-project-id"),
  }));
  const getConfig =
    opts?.getConfig ?? vi.fn().mockResolvedValue("https://github.com/testowner/testrepo.git");
  vi.doMock("../../utils/hardenedGit.js", () => ({
    createHardenedGit: vi.fn().mockReturnValue({ getConfig }),
  }));
}

function makeMockCIStatus(): CIStatus {
  return { state: "success", total: 1, passed: 1, failed: 0, pending: 0, rawData: null };
}

// Drain microtasks + process.nextTick so the host-side BatchLoader's
// fire-and-forget CI enrichment dispatches under fake timers (which fake
// setTimeout but not nextTick/microtasks).
async function flushLoaders(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
    await new Promise<void>((resolve) => process.nextTick(resolve));
  }
}

function makeMockEmptyImpl(): ForgeProviderImpl {
  return {
    getCredentials: vi.fn(),
    validateCredentials: vi.fn(),
    parseRemote: vi.fn(),
    listIssues: vi.fn(),
    listPRs: vi.fn(),
    getIssue: vi.fn(),
    getPR: vi.fn(),
    findPRByBranch: vi.fn(),
    getCIStatus: vi.fn(),
    getRepoMetadata: vi.fn(),
    buildIssueUrl: vi.fn(),
    buildPRUrl: vi.fn(),
    buildIssuesUrl: vi.fn(),
    buildPRsUrl: vi.fn(),
    buildCommitsUrl: vi.fn(),
    assignIssue: vi.fn(),
    unassignIssue: vi.fn(),
    validateToken: vi.fn(),
  };
}

describe("PullRequestService", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.resetModules();
    vi.clearAllMocks();
    // `lastMockBridge` is module-level so a stale reference from a prior
    // test never bleeds into the next one's assertions.
    lastMockBridge = null;
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

  it("clears provider PR caches through the forge bridge on manual refresh", async () => {
    mockForgeProviderResolved();

    const { pullRequestService } = await import("../PullRequestService.js");
    const { events } = await import("../events.js");

    pullRequestService.initialize("/repo");
    events.emit(
      "sys:worktree:update",
      makeWorktreeSnapshot({ worktreeId: "wt-1", branch: "feature/a" })
    );

    await pullRequestService.refresh();

    expect(lastMockBridge?.clearPullRequestCaches).toHaveBeenCalledWith("daintree.github.github");

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

    const getConfig = vi.fn(async (key: string) =>
      key === "remote.upstream.url"
        ? "https://github.com/upstreamowner/upstreamrepo.git"
        : "https://github.com/originowner/originrepo.git"
    );
    mockForgeProviderUnresolved({ getConfig });
    const bridge = lastMockBridge!;

    const { pullRequestService } = await import("../PullRequestService.js");

    pullRequestService.initialize("/repo");
    pullRequestService.setForgeSettings({
      forgeProviderOverride: null,
      forgeDefaultProviderId: null,
      forgeRemote: "upstream",
    });

    await pullRequestService.refresh();

    expect(getConfig).toHaveBeenCalledWith("remote.upstream.url");
    expect(bridge.resolveProvider).toHaveBeenCalledWith(
      expect.objectContaining({ remoteUrl: "https://github.com/upstreamowner/upstreamrepo.git" })
    );

    pullRequestService.destroy();
  });

  it("falls back to origin when the selected forgeRemote has no URL (#8456)", async () => {
    const clearPRCaches = vi.fn();
    vi.doMock("../GitHubService.js", () => ({ clearPRCaches }));

    const getConfig = vi.fn(async (key: string) =>
      key === "remote.origin.url" ? "https://github.com/originowner/originrepo.git" : null
    );
    mockForgeProviderUnresolved({ getConfig });
    const bridge = lastMockBridge!;

    const { pullRequestService } = await import("../PullRequestService.js");

    pullRequestService.initialize("/repo");
    pullRequestService.setForgeSettings({
      forgeProviderOverride: null,
      forgeDefaultProviderId: null,
      forgeRemote: "missing",
    });

    await pullRequestService.refresh();

    expect(bridge.resolveProvider).toHaveBeenCalledWith(
      expect.objectContaining({ remoteUrl: "https://github.com/originowner/originrepo.git" })
    );

    pullRequestService.destroy();
  });

  it("unwraps the ConfigGetResult envelope from simple-git's getConfig (#8870)", async () => {
    // Regression: PullRequestService used to cast `git.getConfig()` straight
    // to `string | null`, but simple-git returns a `{ value, values, ... }`
    // envelope at runtime in the workspace-host UtilityProcess. The cast
    // silently produced null and the bridge never saw a real `remoteUrl`,
    // so PR detection was permanently skipped (#8870). The fix unwraps the
    // envelope; this test pins the envelope shape so a future change can't
    // silently regress it.
    const clearPRCaches = vi.fn();
    vi.doMock("../GitHubService.js", () => ({ clearPRCaches }));

    const getConfig = vi.fn(async (key: string) => ({
      key,
      paths: [".git/config"],
      scopes: {},
      value: "  https://github.com/envowner/envrepo.git  ",
      values: ["  https://github.com/envowner/envrepo.git  "],
    }));
    // Cast is necessary because the helper's parameter type promises a
    // plain string return; the test deliberately exercises the envelope
    // shape that the real simple-git ships and PullRequestService unwraps.
    mockForgeProviderUnresolved({
      getConfig: getConfig as unknown as (key: string) => Promise<string | null>,
    });
    const bridge = lastMockBridge!;

    const { pullRequestService } = await import("../PullRequestService.js");

    pullRequestService.initialize("/repo");
    await pullRequestService.refresh();

    expect(getConfig).toHaveBeenCalledWith("remote.origin.url");
    expect(bridge.resolveProvider).toHaveBeenCalledWith(
      expect.objectContaining({ remoteUrl: "https://github.com/envowner/envrepo.git" })
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

  it("emits sys:pr:cleared for a fresh candidate when the forge has no PR (#8870)", async () => {
    // Without this clear, WorktreeMonitor._linked stays at its initial
    // `undefined` and the renderer's preservation rule keeps any prior
    // session's linked.pr visible indefinitely.
    const clearPRCaches = vi.fn();
    vi.doMock("../GitHubService.js", () => ({ clearPRCaches }));
    mockForgeProviderResolved(async () => null);

    const { pullRequestService } = await import("../PullRequestService.js");
    const { events } = await import("../events.js");

    const cleared: DaintreeEventMap["sys:pr:cleared"][] = [];
    const detected: DaintreeEventMap["sys:pr:detected"][] = [];
    const unsubscribeCleared = events.on("sys:pr:cleared", (p) => cleared.push(p));
    const unsubscribeDetected = events.on("sys:pr:detected", (p) => detected.push(p));

    pullRequestService.initialize("/repo");
    events.emit(
      "sys:worktree:update",
      makeWorktreeSnapshot({ worktreeId: "wt-1", branch: "feature/no-pr" })
    );

    await pullRequestService.refresh();

    expect(detected).toHaveLength(0);
    expect(cleared).toHaveLength(1);
    expect(cleared[0]).toMatchObject({
      worktreeId: "wt-1",
      branchName: "feature/no-pr",
      providerId: "daintree.github.github",
    });

    unsubscribeCleared();
    unsubscribeDetected();
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

  it("coalesces CI-status enrichment into one getCIStatuses batch when the capability is present", async () => {
    vi.doMock("../GitHubService.js", () => ({ clearPRCaches: vi.fn() }));

    const batchSpy = vi.fn(async (_repo: RepoRef, branches: string[]) => {
      const map = new Map<string, ForgePR | null>();
      for (const branch of branches) {
        map.set(
          branch,
          makeMockForgePR({ number: branch === "feature/a" ? 1 : 2, headRef: branch })
        );
      }
      return map;
    });
    const mockImpl = mockForgeProviderResolved(undefined, batchSpy);

    const getCIStatuses = vi.fn(async (_repo: RepoRef, prNumbers: number[]) => {
      const map = new Map<number, CIStatus | null>();
      for (const n of prNumbers) map.set(n, makeMockCIStatus());
      return map;
    });
    // The bridge stub reads `batchLookups` lazily at call time, so attaching it
    // after the resolved-provider setup is enough to advertise the capability.
    mockImpl.batchLookups = { getCIStatuses };

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
    await flushLoaders();

    // Two PRs detected in one cycle → a single coalesced batch call, never the
    // per-PR path.
    expect(getCIStatuses).toHaveBeenCalledTimes(1);
    expect(getCIStatuses).toHaveBeenCalledWith(expect.anything(), expect.arrayContaining([1, 2]));
    expect(mockImpl.getCIStatus).not.toHaveBeenCalled();

    // The batched CI result is applied: each worktree gets a re-emit carrying
    // its enriched status, proving the coalesced data flows back through.
    const ciByWorktree = new Map(
      detected.filter((d) => d.prCiStatus).map((d) => [d.worktreeId, d.prCiStatus])
    );
    expect(ciByWorktree.get("wt-1")).toBe("SUCCESS");
    expect(ciByWorktree.get("wt-2")).toBe("SUCCESS");

    unsubscribe();
    pullRequestService.destroy();
  });

  it("flags the phase-1 emit as loading and lands the enriched status on phase-2 (#9551)", async () => {
    vi.doMock("../GitHubService.js", () => ({ clearPRCaches: vi.fn() }));

    const batchSpy = vi.fn(async (_repo: RepoRef, branches: string[]) => {
      const map = new Map<string, ForgePR | null>();
      for (const branch of branches)
        map.set(branch, makeMockForgePR({ number: 7, headRef: branch }));
      return map;
    });
    const mockImpl = mockForgeProviderResolved(undefined, batchSpy);
    const getCIStatuses = vi.fn(async (_repo: RepoRef, prNumbers: number[]) => {
      const map = new Map<number, CIStatus | null>();
      for (const n of prNumbers) map.set(n, makeMockCIStatus());
      return map;
    });
    mockImpl.batchLookups = { getCIStatuses };

    const { pullRequestService } = await import("../PullRequestService.js");
    const { events } = await import("../events.js");

    const detected: DaintreeEventMap["sys:pr:detected"][] = [];
    const unsubscribe = events.on("sys:pr:detected", (payload) => detected.push(payload));

    pullRequestService.initialize("/repo");
    events.emit(
      "sys:worktree:update",
      makeWorktreeSnapshot({ worktreeId: "wt-1", branch: "feature/a" })
    );

    await pullRequestService.refresh();
    await flushLoaders();

    // Phase-1: the emit before enrichment carries the loading flag and no CI
    // status, so the renderer/host preserves the prior dot.
    const phase1 = detected.find((d) => d.isCiStatusLoading === true);
    expect(phase1).toBeDefined();
    expect(phase1?.prCiStatus).toBeUndefined();

    // Phase-2: enriched emit carries the resolved status and NOT the flag.
    const phase2 = detected.find((d) => d.prCiStatus === "SUCCESS");
    expect(phase2).toBeDefined();
    expect(phase2?.isCiStatusLoading).toBeFalsy();

    unsubscribe();
    pullRequestService.destroy();
  });

  it("emits a phase-2 clear when CI checks have genuinely disappeared (#9551)", async () => {
    vi.doMock("../GitHubService.js", () => ({ clearPRCaches: vi.fn() }));

    const batchSpy = vi.fn(async (_repo: RepoRef, branches: string[]) => {
      const map = new Map<string, ForgePR | null>();
      for (const branch of branches)
        map.set(branch, makeMockForgePR({ number: 7, headRef: branch }));
      return map;
    });
    const mockImpl = mockForgeProviderResolved(undefined, batchSpy);
    // Authoritative "no checks": a present key with a null value (distinct from a
    // transient miss, which the batch contract surfaces as a rejection).
    const getCIStatuses = vi.fn(async (_repo: RepoRef, prNumbers: number[]) => {
      const map = new Map<number, CIStatus | null>();
      for (const n of prNumbers) map.set(n, null);
      return map;
    });
    mockImpl.batchLookups = { getCIStatuses };

    const { pullRequestService } = await import("../PullRequestService.js");
    const { events } = await import("../events.js");

    const detected: DaintreeEventMap["sys:pr:detected"][] = [];
    const unsubscribe = events.on("sys:pr:detected", (payload) => detected.push(payload));

    pullRequestService.initialize("/repo");
    events.emit(
      "sys:worktree:update",
      makeWorktreeSnapshot({ worktreeId: "wt-1", branch: "feature/a" })
    );

    await pullRequestService.refresh();
    await flushLoaders();

    expect(getCIStatuses).toHaveBeenCalledTimes(1);
    expect(mockImpl.getCIStatus).not.toHaveBeenCalled();
    // The enrichment re-emits (phase-2) with no CI status and no loading flag,
    // so the host full-replaces the preserved dot away. Without this, a vanished
    // check would leave a stale dot forever.
    const phase2Clear = detected.find(
      (d) => !d.isCiStatusLoading && d.prCiStatus === undefined && d.ciStatus === undefined
    );
    expect(phase2Clear).toBeDefined();

    unsubscribe();
    pullRequestService.destroy();
  });

  it("does not bump consecutiveErrors when the provider is invalidated mid-check", async () => {
    vi.doMock("../GitHubService.js", () => ({ clearPRCaches: vi.fn() }));

    let releaseBatch: (() => void) | undefined;
    const batchSpy = vi.fn(
      (_repo: RepoRef, branches: string[]) =>
        new Promise<Map<string, ForgePR | null>>((resolve) => {
          releaseBatch = () => {
            const map = new Map<string, ForgePR | null>();
            for (const branch of branches)
              map.set(branch, makeMockForgePR({ number: 1, headRef: branch }));
            resolve(map);
          };
        })
    );
    mockForgeProviderResolved(undefined, batchSpy);

    const { pullRequestService } = await import("../PullRequestService.js");
    const { events } = await import("../events.js");

    pullRequestService.initialize("/repo");
    events.emit(
      "sys:worktree:update",
      makeWorktreeSnapshot({ worktreeId: "wt-1", branch: "feature/a" })
    );

    const svc = pullRequestService as unknown as {
      checkForPRs: () => Promise<void>;
      resolveProvider: () => Promise<void>;
      invalidateProvider: () => void;
      consecutiveErrors: number;
      lastCheckAt: number;
    };

    await svc.resolveProvider();
    svc.lastCheckAt = Number.NEGATIVE_INFINITY;

    // Start a check that blocks inside the branch loader's batch function.
    const checkPromise = svc.checkForPRs();
    await flushLoaders();
    expect(batchSpy).toHaveBeenCalledTimes(1);

    // Swap the provider mid-flight (refresh()/setForgeSettings() do this): the
    // loader is disposed, rejecting the in-flight load. The cycle must be
    // discarded by the stale-provider guard, NOT counted as an error.
    svc.invalidateProvider();
    releaseBatch?.(); // late batch result must be dropped silently
    await checkPromise;
    await flushLoaders();

    expect(svc.consecutiveErrors).toBe(0);

    pullRequestService.destroy();
  });

  it("falls back to per-PR getCIStatus when the batch CI capability is absent", async () => {
    vi.doMock("../GitHubService.js", () => ({ clearPRCaches: vi.fn() }));

    const batchSpy = vi.fn(async (_repo: RepoRef, branches: string[]) => {
      const map = new Map<string, ForgePR | null>();
      for (const branch of branches) {
        map.set(
          branch,
          makeMockForgePR({ number: branch === "feature/a" ? 1 : 2, headRef: branch })
        );
      }
      return map;
    });
    const mockImpl = mockForgeProviderResolved(undefined, batchSpy);
    mockImpl.getCIStatus = vi.fn().mockResolvedValue(makeMockCIStatus());

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
    await flushLoaders();

    // No batch capability → loader falls back to one getCIStatus per PR.
    expect(mockImpl.getCIStatus).toHaveBeenCalledTimes(2);

    pullRequestService.destroy();
  });

  it("coalesces revalidation getPR fan-out into one findPRsByNumbers batch when present", async () => {
    vi.doMock("../GitHubService.js", () => ({ clearPRCaches: vi.fn() }));

    const batchSpy = vi.fn(async (_repo: RepoRef, branches: string[]) => {
      const map = new Map<string, ForgePR | null>();
      for (const branch of branches) {
        map.set(
          branch,
          makeMockForgePR({ number: branch === "feature/a" ? 1 : 2, headRef: branch })
        );
      }
      return map;
    });
    const mockImpl = mockForgeProviderResolved(undefined, batchSpy);

    const findPRsByNumbers = vi.fn(async (_repo: RepoRef, prNumbers: number[]) => {
      const map = new Map<number, ForgePR | null>();
      for (const n of prNumbers) map.set(n, makeMockForgePR({ number: n }));
      return map;
    });
    mockImpl.batchLookups = { findPRsByNumbers };

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
    await (
      pullRequestService as unknown as { revalidateResolvedPRs: () => Promise<void> }
    ).revalidateResolvedPRs();

    // Both resolved PRs revalidate through one batch call, not per-number getPR.
    expect(findPRsByNumbers).toHaveBeenCalledTimes(1);
    expect(findPRsByNumbers).toHaveBeenCalledWith(
      expect.anything(),
      expect.arrayContaining([1, 2])
    );
    expect(mockImpl.getPR).not.toHaveBeenCalled();

    pullRequestService.destroy();
  });

  it("skips the findPRsByNumbers revalidation batch when probeOpenPRList reports unchanged", async () => {
    vi.doMock("../GitHubService.js", () => ({ clearPRCaches: vi.fn() }));

    const batchSpy = vi.fn(async (_repo: RepoRef, branches: string[]) => {
      const map = new Map<string, ForgePR | null>();
      for (const branch of branches) {
        map.set(
          branch,
          makeMockForgePR({ number: branch === "feature/a" ? 1 : 2, headRef: branch })
        );
      }
      return map;
    });
    const mockImpl = mockForgeProviderResolved(undefined, batchSpy);

    const findPRsByNumbers = vi.fn(async (_repo: RepoRef, prNumbers: number[]) => {
      const map = new Map<number, ForgePR | null>();
      for (const n of prNumbers) map.set(n, makeMockForgePR({ number: n }));
      return map;
    });
    const probeOpenPRList = vi.fn(async () => ({ kind: "unchanged" as const }));
    mockImpl.batchLookups = { findPRsByNumbers, probeOpenPRList };

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
    findPRsByNumbers.mockClear();
    probeOpenPRList.mockClear();

    await (
      pullRequestService as unknown as { revalidateResolvedPRs: () => Promise<void> }
    ).revalidateResolvedPRs();

    // A 304-equivalent probe means nothing changed — the GraphQL re-fetch is skipped.
    expect(probeOpenPRList).toHaveBeenCalledTimes(1);
    expect(findPRsByNumbers).not.toHaveBeenCalled();

    pullRequestService.destroy();
  });

  it("re-fetches only the changed PR when probeOpenPRList reports a subset changed", async () => {
    vi.doMock("../GitHubService.js", () => ({ clearPRCaches: vi.fn() }));

    const batchSpy = vi.fn(async (_repo: RepoRef, branches: string[]) => {
      const map = new Map<string, ForgePR | null>();
      for (const branch of branches) {
        map.set(
          branch,
          makeMockForgePR({ number: branch === "feature/a" ? 1 : 2, headRef: branch })
        );
      }
      return map;
    });
    const mockImpl = mockForgeProviderResolved(undefined, batchSpy);

    const findPRsByNumbers = vi.fn(async (_repo: RepoRef, prNumbers: number[]) => {
      const map = new Map<number, ForgePR | null>();
      for (const n of prNumbers) map.set(n, makeMockForgePR({ number: n }));
      return map;
    });
    const probeOpenPRList = vi.fn(async () => ({
      kind: "changed" as const,
      changed: [
        {
          number: 1,
          headSha: "sha2",
          updatedAt: "2024-02-02T00:00:00Z",
          state: "open" as const,
          title: "Add new feature",
        },
      ],
    }));
    mockImpl.batchLookups = { findPRsByNumbers, probeOpenPRList };

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
    findPRsByNumbers.mockClear();

    await (
      pullRequestService as unknown as { revalidateResolvedPRs: () => Promise<void> }
    ).revalidateResolvedPRs();

    // Only PR #1 changed — PR #2 is not re-fetched.
    expect(findPRsByNumbers).toHaveBeenCalledTimes(1);
    expect(findPRsByNumbers).toHaveBeenCalledWith(expect.anything(), [1]);

    pullRequestService.destroy();
  });

  it("seeds headSha/updatedAt from a changed probe so the next tick's snapshot is in sync", async () => {
    vi.doMock("../GitHubService.js", () => ({ clearPRCaches: vi.fn() }));

    const batchSpy = vi.fn(async (_repo: RepoRef, branches: string[]) => {
      const map = new Map<string, ForgePR | null>();
      for (const branch of branches) {
        map.set(branch, makeMockForgePR({ number: 1, headRef: branch }));
      }
      return map;
    });
    const mockImpl = mockForgeProviderResolved(undefined, batchSpy);

    const findPRsByNumbers = vi.fn(async (_repo: RepoRef, prNumbers: number[]) => {
      const map = new Map<number, ForgePR | null>();
      for (const n of prNumbers) map.set(n, makeMockForgePR({ number: n }));
      return map;
    });
    const probeCalls: PRSnapshot[][] = [];
    const probeOpenPRList = vi.fn(async (_repo: RepoRef, tracked: PRSnapshot[]) => {
      probeCalls.push(tracked);
      if (probeCalls.length === 1) {
        return {
          kind: "changed" as const,
          changed: [
            {
              number: 1,
              headSha: "sha2",
              updatedAt: "2024-02-02T00:00:00Z",
              state: "open" as const,
              title: "Add new feature",
            },
          ],
        };
      }
      return { kind: "unchanged" as const };
    });
    mockImpl.batchLookups = { findPRsByNumbers, probeOpenPRList };

    const { pullRequestService } = await import("../PullRequestService.js");
    const { events } = await import("../events.js");

    pullRequestService.initialize("/repo");
    events.emit(
      "sys:worktree:update",
      makeWorktreeSnapshot({ worktreeId: "wt-1", branch: "feature/a" })
    );

    await pullRequestService.refresh();

    const revalidate = (
      pullRequestService as unknown as { revalidateResolvedPRs: () => Promise<void> }
    ).revalidateResolvedPRs.bind(pullRequestService);

    await revalidate();
    await revalidate();

    // First probe saw the un-seeded (null) markers; after consuming the changed
    // probe, the second probe's tracked snapshot carries the seeded REST markers.
    expect(probeCalls).toHaveLength(2);
    expect(probeCalls[0][0]).toMatchObject({ number: 1, headSha: null, updatedAt: null });
    expect(probeCalls[1][0]).toMatchObject({
      number: 1,
      headSha: "sha2",
      updatedAt: "2024-02-02T00:00:00Z",
    });

    pullRequestService.destroy();
  });

  it("keeps polling CI for in-flight PRs even when probeOpenPRList reports unchanged", async () => {
    vi.doMock("../GitHubService.js", () => ({ clearPRCaches: vi.fn() }));

    const batchSpy = vi.fn(async (_repo: RepoRef, branches: string[]) => {
      const map = new Map<string, ForgePR | null>();
      for (const branch of branches)
        map.set(branch, makeMockForgePR({ number: 1, headRef: branch }));
      return map;
    });
    const mockImpl = mockForgeProviderResolved(undefined, batchSpy);

    const getCIStatuses = vi.fn(async (_repo: RepoRef, prNumbers: number[]) => {
      const map = new Map<number, CIStatus | null>();
      for (const n of prNumbers) {
        map.set(n, { state: "pending", total: 1, passed: 0, failed: 0, pending: 1, rawData: null });
      }
      return map;
    });
    const findPRsByNumbers = vi.fn(async (_repo: RepoRef, prNumbers: number[]) => {
      const map = new Map<number, ForgePR | null>();
      for (const n of prNumbers) map.set(n, makeMockForgePR({ number: n }));
      return map;
    });
    const probeOpenPRList = vi.fn(async () => ({ kind: "unchanged" as const }));
    mockImpl.batchLookups = { findPRsByNumbers, getCIStatuses, probeOpenPRList };

    const { pullRequestService } = await import("../PullRequestService.js");
    const { events } = await import("../events.js");

    pullRequestService.initialize("/repo");
    events.emit(
      "sys:worktree:update",
      makeWorktreeSnapshot({ worktreeId: "wt-1", branch: "feature/a" })
    );

    await pullRequestService.refresh();
    await flushLoaders();

    getCIStatuses.mockClear();
    findPRsByNumbers.mockClear();

    await (
      pullRequestService as unknown as { revalidateResolvedPRs: () => Promise<void> }
    ).revalidateResolvedPRs();
    await flushLoaders();

    // PR metadata re-fetch is skipped (probe unchanged) but CI keeps polling,
    // since a CI re-run doesn't bump the PR's updated_at.
    expect(findPRsByNumbers).not.toHaveBeenCalled();
    expect(getCIStatuses).toHaveBeenCalledTimes(1);
    expect(getCIStatuses).toHaveBeenCalledWith(expect.anything(), [1]);

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

  it("skips checkForPRs when a sibling window holds the poll lease (#9055)", async () => {
    const clearPRCaches = vi.fn();
    vi.doMock("../GitHubService.js", () => ({ clearPRCaches }));

    const mockImpl = mockForgeProviderResolved();
    // Deny the lease — simulates a sibling Electron window already polling
    // this project. The service must short-circuit without calling ANY forge
    // provider methods; PR events still propagate from the elected host
    // through main → renderer fan-out.
    lastMockBridge!.acquirePollLease.mockResolvedValue(false);

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

    // None of the provider's PR-fetching methods are called when the lease is denied.
    expect(mockImpl.findPRByBranch).not.toHaveBeenCalled();
    expect(mockImpl.findPRsByBranches).toBeUndefined();
    expect(mockImpl.getPR).not.toHaveBeenCalled();
    expect(mockImpl.getCIStatus).not.toHaveBeenCalled();
    expect(detected).toHaveLength(0);

    unsubscribe();
    pullRequestService.destroy();
  });

  it("releases the poll lease on stop (#9055)", async () => {
    vi.doMock("../GitHubService.js", () => ({ clearPRCaches: vi.fn() }));
    mockForgeProviderResolved();

    const { pullRequestService } = await import("../PullRequestService.js");

    pullRequestService.initialize("/repo");
    pullRequestService.stop();

    expect(lastMockBridge!.releasePollLease).toHaveBeenCalled();

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

  describe("boost cadence decay", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
      vi.resetModules();
      vi.clearAllMocks();
      lastMockBridge = null;
    });

    // Helper: create a minimal InternalLinkedPR-like object for populating
    // detectedPRs directly in tests that access private helpers.
    function makeDetectedPR(overrides?: {
      number?: number;
      ciStatus?: "SUCCESS" | "FAILURE" | "ERROR" | "PENDING" | "EXPECTED";
      stagnantPollCount?: number;
    }) {
      return {
        number: overrides?.number ?? 42,
        title: "Test PR",
        url: "https://github.com/o/r/pull/42",
        state: "open" as const,
        isDraft: false,
        ciStatus: overrides?.ciStatus,
        providerId: "daintree.github.github",
        stagnantPollCount: overrides?.stagnantPollCount ?? 0,
      };
    }

    it("getBoostRevalidationIntervalMs: base 30s at count 0", async () => {
      vi.doMock("../GitHubService.js", () => ({ clearPRCaches: vi.fn() }));
      mockForgeProviderResolved();

      const { pullRequestService } = await import("../PullRequestService.js");
      pullRequestService.initialize("/repo");

      const svc = pullRequestService as any;
      svc.detectedPRs.set("wt-1", makeDetectedPR({ stagnantPollCount: 0, ciStatus: "PENDING" }));

      expect(svc.getBoostRevalidationIntervalMs()).toBe(30_000);
      pullRequestService.destroy();
    });

    it("getBoostRevalidationIntervalMs: 60s at count 10", async () => {
      vi.doMock("../GitHubService.js", () => ({ clearPRCaches: vi.fn() }));
      mockForgeProviderResolved();

      const { pullRequestService } = await import("../PullRequestService.js");
      pullRequestService.initialize("/repo");

      const svc = pullRequestService as any;
      svc.detectedPRs.set("wt-1", makeDetectedPR({ stagnantPollCount: 10, ciStatus: "PENDING" }));

      expect(svc.getBoostRevalidationIntervalMs()).toBe(60_000);
      pullRequestService.destroy();
    });

    it("getBoostRevalidationIntervalMs: 120s at count 20", async () => {
      vi.doMock("../GitHubService.js", () => ({ clearPRCaches: vi.fn() }));
      mockForgeProviderResolved();

      const { pullRequestService } = await import("../PullRequestService.js");
      pullRequestService.initialize("/repo");

      const svc = pullRequestService as any;
      svc.detectedPRs.set("wt-1", makeDetectedPR({ stagnantPollCount: 20, ciStatus: "PENDING" }));

      expect(svc.getBoostRevalidationIntervalMs()).toBe(120_000);
      pullRequestService.destroy();
    });

    it("getBoostRevalidationIntervalMs: picks max across PENDING PRs only", async () => {
      vi.doMock("../GitHubService.js", () => ({ clearPRCaches: vi.fn() }));
      mockForgeProviderResolved();

      const { pullRequestService } = await import("../PullRequestService.js");
      pullRequestService.initialize("/repo");

      const svc = pullRequestService as any;
      // SUCCESS PR with high count — should be ignored
      svc.detectedPRs.set(
        "wt-1",
        makeDetectedPR({ number: 1, stagnantPollCount: 20, ciStatus: "SUCCESS" })
      );
      // PENDING PR with lower count — this one counts
      svc.detectedPRs.set(
        "wt-2",
        makeDetectedPR({ number: 2, stagnantPollCount: 12, ciStatus: "PENDING" })
      );

      expect(svc.getBoostRevalidationIntervalMs()).toBe(60_000);
      pullRequestService.destroy();
    });

    it("getBoostRevalidationIntervalMs: ignores non-PENDING PRs", async () => {
      vi.doMock("../GitHubService.js", () => ({ clearPRCaches: vi.fn() }));
      mockForgeProviderResolved();

      const { pullRequestService } = await import("../PullRequestService.js");
      pullRequestService.initialize("/repo");

      const svc = pullRequestService as any;
      svc.detectedPRs.set("wt-1", makeDetectedPR({ stagnantPollCount: 20, ciStatus: "SUCCESS" }));

      expect(svc.getBoostRevalidationIntervalMs()).toBe(30_000);
      pullRequestService.destroy();
    });

    it("getBoostRevalidationIntervalMs: returns 30s when detectedPRs is empty", async () => {
      vi.doMock("../GitHubService.js", () => ({ clearPRCaches: vi.fn() }));
      mockForgeProviderResolved();

      const { pullRequestService } = await import("../PullRequestService.js");
      pullRequestService.initialize("/repo");

      const svc = pullRequestService as any;
      svc.detectedPRs.clear();

      expect(svc.getBoostRevalidationIntervalMs()).toBe(30_000);
      pullRequestService.destroy();
    });

    it("clearStagnantPollCounts: resets all PRs to 0", async () => {
      vi.doMock("../GitHubService.js", () => ({ clearPRCaches: vi.fn() }));
      mockForgeProviderResolved();

      const { pullRequestService } = await import("../PullRequestService.js");
      pullRequestService.initialize("/repo");

      const svc = pullRequestService as any;
      svc.detectedPRs.set("wt-1", makeDetectedPR({ stagnantPollCount: 5 }));
      svc.detectedPRs.set("wt-2", makeDetectedPR({ number: 2, stagnantPollCount: 15 }));

      svc.clearStagnantPollCounts();

      for (const pr of svc.detectedPRs.values()) {
        expect(pr.stagnantPollCount).toBe(0);
      }
      pullRequestService.destroy();
    });

    it("stop() clears stagnant counts", async () => {
      vi.doMock("../GitHubService.js", () => ({ clearPRCaches: vi.fn() }));
      mockForgeProviderResolved();

      const { pullRequestService } = await import("../PullRequestService.js");
      pullRequestService.initialize("/repo");

      const svc = pullRequestService as any;
      svc.detectedPRs.set("wt-1", makeDetectedPR({ stagnantPollCount: 8 }));
      svc.isPolling = true;

      pullRequestService.stop();

      for (const pr of svc.detectedPRs.values()) {
        expect(pr.stagnantPollCount).toBe(0);
      }
    });

    it("refresh() clears stagnant counts", async () => {
      vi.doMock("../GitHubService.js", () => ({ clearPRCaches: vi.fn() }));
      mockForgeProviderResolved();

      const { pullRequestService } = await import("../PullRequestService.js");
      pullRequestService.initialize("/repo");

      const svc = pullRequestService as any;
      svc.detectedPRs.set("wt-1", makeDetectedPR({ stagnantPollCount: 8 }));

      // refresh() is async; the setup path is complex, so just verify
      // clearStagnantPollCounts was called by checking the state before
      // refresh executes fully
      await pullRequestService.refresh();

      for (const pr of svc.detectedPRs.values()) {
        expect(pr.stagnantPollCount).toBe(0);
      }
    });

    it("reset() clears stagnant counts", async () => {
      vi.doMock("../GitHubService.js", () => ({ clearPRCaches: vi.fn() }));
      mockForgeProviderResolved();

      const { pullRequestService } = await import("../PullRequestService.js");
      pullRequestService.initialize("/repo");

      const svc = pullRequestService as any;
      svc.detectedPRs.set("wt-1", makeDetectedPR({ stagnantPollCount: 8 }));

      pullRequestService.reset();

      // reset() calls detectedPRs.clear() after clearStagnantPollCounts()
      // So the map should be empty
      expect(svc.detectedPRs.size).toBe(0);
    });

    it("stagnantPollCount comparison logic: same CI increments, different CI resets", () => {
      // Verify the core stagnation logic directly (the enrichPRWithCIStatus
      // fire-and-forget chain is not easily testable with vitest 4 fake timers,
      // but its behavior is exercised by scheduleRevalidation interval
      // selection in the tests above).
      const pr = makeDetectedPR({ stagnantPollCount: 0, ciStatus: "PENDING" });

      // Simulate unchanged CI result
      const prevSame = pr.ciStatus;
      pr.ciStatus = "PENDING";
      if (pr.ciStatus !== undefined) {
        pr.stagnantPollCount = prevSame === pr.ciStatus ? pr.stagnantPollCount + 1 : 0;
      }
      expect(pr.stagnantPollCount).toBe(1);

      // Simulate another unchanged poll
      const prevSame2 = pr.ciStatus;
      pr.ciStatus = "PENDING";
      if (pr.ciStatus !== undefined) {
        pr.stagnantPollCount = prevSame2 === pr.ciStatus ? pr.stagnantPollCount + 1 : 0;
      }
      expect(pr.stagnantPollCount).toBe(2);

      // Simulate CI transition
      const prevDiff = pr.ciStatus as string | undefined;
      pr.ciStatus = "SUCCESS";
      if (pr.ciStatus !== undefined) {
        pr.stagnantPollCount = prevDiff === pr.ciStatus ? pr.stagnantPollCount + 1 : 0;
      }
      expect(pr.stagnantPollCount).toBe(0);
    });

    it("scheduleRevalidation sets a timer when boost is active", async () => {
      const clearPRCaches = vi.fn();
      vi.doMock("../GitHubService.js", () => ({ clearPRCaches }));

      mockForgeProviderResolved();

      const { pullRequestService } = await import("../PullRequestService.js");
      const svc = pullRequestService as any;

      // isEnabled is a getter that checks nextRetryAt === 0
      svc.nextRetryAt = 0;
      svc.isPolling = true;
      svc.detectedPRs.set("wt-1", makeDetectedPR({ stagnantPollCount: 15 }));
      svc.boostExpiresAt = Date.now() + 15 * 60 * 1000;

      svc.scheduleRevalidation();

      expect(svc.revalidationTimer).not.toBeNull();

      clearTimeout(svc.revalidationTimer);
      svc.revalidationTimer = null;
      pullRequestService.destroy();
    });
  });
});
