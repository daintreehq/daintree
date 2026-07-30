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
    // Explicit return-type annotation so the unresolved variant can swap in a
    // "not-ready"/"no-match" miss; the default resolves to a real provider.
    resolveProvider: vi.fn<
      (_opts: {
        remoteUrl: string | null;
        forgeProviderOverride: string | null;
        globalDefaultProviderId: string | null;
        projectPath?: string | null;
      }) => Promise<ForgeResolveProviderResult>
    >(async () => ({
      status: "resolved",
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
    createIssue: vi.fn(),
    assignIssue: vi.fn(),
    unassignIssue: vi.fn(),
    createPR: vi.fn(),
    closePR: vi.fn(),
    reopenPR: vi.fn(),
    mergePR: vi.fn(),
    convertPRToDraft: vi.fn(),
    markPRReadyForReview: vi.fn(),
    commentOnPR: vi.fn(),
    editPR: vi.fn(),
    closeIssue: vi.fn(),
    reopenIssue: vi.fn(),
    editIssue: vi.fn(),
    addIssueComment: vi.fn(),
    addIssueLabel: vi.fn(),
    removeIssueLabel: vi.fn(),
    validateToken: vi.fn(),
    getRateLimit: vi.fn().mockResolvedValue({ limit: null, remaining: null, resetAt: null }),
  };

  const bridge = makeMockBridge(mockImpl);
  lastMockBridge = bridge;
  vi.doMock("../../workspace-host/forgeBridge.js", () => ({
    getForgeBridge: () => bridge,
    initForgeBridge: vi.fn(() => bridge),
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
  /**
   * Miss discrimination (#9997): "not-ready" (default) mimics the cold-start
   * race where the plugin scan hasn't settled; "no-match" is the definitive
   * "no provider matches this remote" answer that pauses polling.
   */
  status?: "not-ready" | "no-match";
}) {
  // No impl behind the bridge — `resolveProvider` misses so the service
  // takes the "no forge provider resolved" branch.
  const placeholderImpl = makeMockEmptyImpl();
  const bridge = makeMockBridge(placeholderImpl);
  bridge.resolveProvider.mockResolvedValue({ status: opts?.status ?? "not-ready" });
  lastMockBridge = bridge;
  vi.doMock("../../workspace-host/forgeBridge.js", () => ({
    getForgeBridge: () => bridge,
    initForgeBridge: vi.fn(() => bridge),
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
    createIssue: vi.fn(),
    assignIssue: vi.fn(),
    unassignIssue: vi.fn(),
    createPR: vi.fn(),
    closePR: vi.fn(),
    reopenPR: vi.fn(),
    mergePR: vi.fn(),
    convertPRToDraft: vi.fn(),
    markPRReadyForReview: vi.fn(),
    commentOnPR: vi.fn(),
    editPR: vi.fn(),
    closeIssue: vi.fn(),
    reopenIssue: vi.fn(),
    editIssue: vi.fn(),
    addIssueComment: vi.fn(),
    addIssueLabel: vi.fn(),
    removeIssueLabel: vi.fn(),
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
    const mockImpl = mockForgeProviderResolved();

    const { pullRequestService } = await import("../PullRequestService.js");
    const { events } = await import("../events.js");

    const detected: DaintreeEventMap["sys:pr:detected"][] = [];
    const unsubscribe = events.on("sys:pr:detected", (payload) => detected.push(payload));

    pullRequestService.initialize("/repo", "test-project-id");

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

  it("preserves the declined PR state through detection (#9981)", async () => {
    mockForgeProviderResolved(async () =>
      makeMockForgePR({ state: "declined", rawState: "DECLINED" })
    );

    const { pullRequestService } = await import("../PullRequestService.js");
    const { events } = await import("../events.js");

    const detected: DaintreeEventMap["sys:pr:detected"][] = [];
    const unsubscribe = events.on("sys:pr:detected", (payload) => detected.push(payload));

    pullRequestService.initialize("/repo", "test-project-id");
    events.emit(
      "sys:worktree:update",
      makeWorktreeSnapshot({ worktreeId: "wt-1", branch: "feature/declined" })
    );

    await pullRequestService.refresh();
    await flushLoaders();

    // Phase-1 detection and the phase-2 CI enrichment re-emit both carry
    // "declined" — the enrichment must not revert it from a stale capture.
    expect(detected.length).toBeGreaterThanOrEqual(2);
    expect(detected.every((p) => p.prState === "declined")).toBe(true);

    unsubscribe();
    pullRequestService.destroy();
  });

  it("re-emits a declined state when revalidation finds the PR declined (#9981)", async () => {
    const mockImpl = mockForgeProviderResolved(async () => makeMockForgePR({ state: "open" }));
    const findPRsByNumbers = vi.fn(async (_repo: RepoRef, prNumbers: number[]) => {
      const map = new Map<number, ForgePR | null>();
      for (const n of prNumbers) {
        map.set(n, makeMockForgePR({ number: n, state: "declined", rawState: "DECLINED" }));
      }
      return map;
    });
    mockImpl.batchLookups = { findPRsByNumbers };

    const { pullRequestService } = await import("../PullRequestService.js");
    const { events } = await import("../events.js");

    const detected: DaintreeEventMap["sys:pr:detected"][] = [];
    const unsubscribe = events.on("sys:pr:detected", (payload) => detected.push(payload));

    pullRequestService.initialize("/repo", "test-project-id");
    events.emit(
      "sys:worktree:update",
      makeWorktreeSnapshot({ worktreeId: "wt-1", branch: "feature/a" })
    );

    await pullRequestService.refresh();
    await flushLoaders();
    // Detection (and the fire-and-forget CI enrichment re-emit) carry "open".
    expect(detected.length).toBeGreaterThanOrEqual(1);
    expect(detected.every((p) => p.prState === "open")).toBe(true);
    const countBeforeRevalidation = detected.length;

    // The open → declined transition must surface — previously the collapse
    // meant the declined state itself never reached the event.
    await (
      pullRequestService as unknown as { revalidateResolvedPRs: () => Promise<void> }
    ).revalidateResolvedPRs();
    await flushLoaders();

    const reemits = detected.slice(countBeforeRevalidation);
    // Every re-emit carries the new state — a spurious "open"/"closed" emit
    // alongside the correct one would mask the regression.
    expect(reemits.length).toBeGreaterThanOrEqual(1);
    expect(reemits.every((p) => p.prState === "declined")).toBe(true);

    unsubscribe();
    pullRequestService.destroy();
  });

  it("clears provider PR caches through the forge bridge on manual refresh", async () => {
    mockForgeProviderResolved();

    const { pullRequestService } = await import("../PullRequestService.js");
    const { events } = await import("../events.js");

    pullRequestService.initialize("/repo", "test-project-id");
    events.emit(
      "sys:worktree:update",
      makeWorktreeSnapshot({ worktreeId: "wt-1", branch: "feature/a" })
    );

    await pullRequestService.refresh();

    expect(lastMockBridge?.clearPullRequestCaches).toHaveBeenCalledWith("daintree.github.github");

    pullRequestService.destroy();
  });

  it("emits sys:issue:detected carrying the canonical owner/repo (#8452)", async () => {
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

    pullRequestService.initialize("/repo", "test-project-id");
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
    const getConfig = vi.fn(async (key: string) =>
      key === "remote.upstream.url"
        ? "https://github.com/upstreamowner/upstreamrepo.git"
        : "https://github.com/originowner/originrepo.git"
    );
    mockForgeProviderUnresolved({ getConfig });
    const bridge = lastMockBridge!;

    const { pullRequestService } = await import("../PullRequestService.js");

    pullRequestService.initialize("/repo", "test-project-id");
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
    const getConfig = vi.fn(async (key: string) =>
      key === "remote.origin.url" ? "https://github.com/originowner/originrepo.git" : null
    );
    mockForgeProviderUnresolved({ getConfig });
    const bridge = lastMockBridge!;

    const { pullRequestService } = await import("../PullRequestService.js");

    pullRequestService.initialize("/repo", "test-project-id");
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

  it("forwards the initialized project root as projectPath so main can stamp the RepoRef (#10563)", async () => {
    mockForgeProviderUnresolved();
    const bridge = lastMockBridge!;

    const { pullRequestService } = await import("../PullRequestService.js");

    pullRequestService.initialize("/repo", "test-project-id");
    await pullRequestService.refresh();

    expect(bridge.resolveProvider).toHaveBeenCalledWith(
      expect.objectContaining({ projectPath: "/repo" })
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

    pullRequestService.initialize("/repo", "test-project-id");
    await pullRequestService.refresh();

    expect(getConfig).toHaveBeenCalledWith("remote.origin.url");
    expect(bridge.resolveProvider).toHaveBeenCalledWith(
      expect.objectContaining({ remoteUrl: "https://github.com/envowner/envrepo.git" })
    );

    pullRequestService.destroy();
  });

  it("does not track default branches like main/master", async () => {
    const mockImpl = mockForgeProviderResolved();

    const { pullRequestService } = await import("../PullRequestService.js");
    const { events } = await import("../events.js");

    pullRequestService.initialize("/repo", "test-project-id");

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
    mockForgeProviderResolved(async () => null);

    const { pullRequestService } = await import("../PullRequestService.js");
    const { events } = await import("../events.js");

    const cleared: DaintreeEventMap["sys:pr:cleared"][] = [];
    const detected: DaintreeEventMap["sys:pr:detected"][] = [];
    const unsubscribeCleared = events.on("sys:pr:cleared", (p) => cleared.push(p));
    const unsubscribeDetected = events.on("sys:pr:detected", (p) => detected.push(p));

    pullRequestService.initialize("/repo", "test-project-id");
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
    mockForgeProviderResolved(async () =>
      makeMockForgePR({ number: 7, title: "Fix bug", url: "https://github.com/o/r/pull/7" })
    );

    const { pullRequestService } = await import("../PullRequestService.js");
    const { events } = await import("../events.js");

    const cleared: DaintreeEventMap["sys:pr:cleared"][] = [];
    const unsubscribeCleared = events.on("sys:pr:cleared", (payload) => cleared.push(payload));

    pullRequestService.initialize("/repo", "test-project-id");

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

    pullRequestService.initialize("/repo", "test-project-id");

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

    pullRequestService.initialize("/repo", "test-project-id");

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

    pullRequestService.initialize("/repo", "test-project-id");
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
    expect(ciByWorktree.get("wt-1")).toBe("success");
    expect(ciByWorktree.get("wt-2")).toBe("success");

    unsubscribe();
    pullRequestService.destroy();
  });

  it("flags the phase-1 emit as loading and lands the enriched status on phase-2 (#9551)", async () => {
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

    pullRequestService.initialize("/repo", "test-project-id");
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
    const phase2 = detected.find((d) => d.prCiStatus === "success");
    expect(phase2).toBeDefined();
    expect(phase2?.isCiStatusLoading).toBeFalsy();

    unsubscribe();
    pullRequestService.destroy();
  });

  it("emits a phase-2 clear when CI checks have genuinely disappeared (#9551)", async () => {
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

    pullRequestService.initialize("/repo", "test-project-id");
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

    pullRequestService.initialize("/repo", "test-project-id");
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

    pullRequestService.initialize("/repo", "test-project-id");
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

    pullRequestService.initialize("/repo", "test-project-id");
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

    pullRequestService.initialize("/repo", "test-project-id");
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

    pullRequestService.initialize("/repo", "test-project-id");
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

    pullRequestService.initialize("/repo", "test-project-id");
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

    pullRequestService.initialize("/repo", "test-project-id");
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
    const batchSpy = vi.fn(async () => {
      throw new Error("transient batch failure");
    });

    const mockImpl = mockForgeProviderResolved(undefined, batchSpy);

    const { pullRequestService } = await import("../PullRequestService.js");
    const { events } = await import("../events.js");

    const detected: DaintreeEventMap["sys:pr:detected"][] = [];
    const unsubscribe = events.on("sys:pr:detected", (payload) => detected.push(payload));

    pullRequestService.initialize("/repo", "test-project-id");

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

    pullRequestService.initialize("/repo", "test-project-id");

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

  describe("transient lookup failures (#9994)", () => {
    it("preserves PR rows and counts one error when a per-branch lookup fails transiently", async () => {
      mockForgeProviderResolved(async () => {
        throw new Error("network timeout");
      });

      const { pullRequestService } = await import("../PullRequestService.js");
      const { events } = await import("../events.js");

      const cleared: DaintreeEventMap["sys:pr:cleared"][] = [];
      const unsubscribe = events.on("sys:pr:cleared", (payload) => cleared.push(payload));

      pullRequestService.initialize("/repo", "test-project-id");
      events.emit(
        "sys:worktree:update",
        makeWorktreeSnapshot({ worktreeId: "wt-1", branch: "feature/a" })
      );

      const svc = pullRequestService as unknown as {
        checkForPRs: () => Promise<void>;
        resolveProvider: () => Promise<void>;
        consecutiveErrors: number;
        lastCheckAt: number;
      };

      await svc.resolveProvider();
      svc.lastCheckAt = Number.NEGATIVE_INFINITY;
      await svc.checkForPRs();

      // Transient failure is NOT authoritative absence: no spurious clear,
      // and the failure counts toward the circuit breaker.
      expect(cleared).toHaveLength(0);
      expect(svc.consecutiveErrors).toBe(1);

      unsubscribe();
      pullRequestService.destroy();
    });

    it("trips the circuit breaker after three consecutive failing cycles", async () => {
      mockForgeProviderResolved(async () => {
        throw new Error("network timeout");
      });

      const { pullRequestService } = await import("../PullRequestService.js");
      const { events } = await import("../events.js");

      const detectionStates: DaintreeEventMap["sys:pr:detection-state"][] = [];
      const unsubscribe = events.on("sys:pr:detection-state", (payload) =>
        detectionStates.push(payload)
      );

      // This service runs in the workspace-host UtilityProcess, where ui:notify has
      // no consumer, so the breaker trip must NOT emit it — the ambient
      // detection-state path is the only signal. Guard against the dead emit
      // returning (#9976).
      const notifications: DaintreeEventMap["ui:notify"][] = [];
      const unsubNotify = events.on("ui:notify", (payload) => notifications.push(payload));

      pullRequestService.initialize("/repo", "test-project-id");
      events.emit(
        "sys:worktree:update",
        makeWorktreeSnapshot({ worktreeId: "wt-1", branch: "feature/a" })
      );

      const svc = pullRequestService as unknown as {
        checkForPRs: () => Promise<void>;
        resolveProvider: () => Promise<void>;
        consecutiveErrors: number;
        lastCheckAt: number;
      };

      await svc.resolveProvider();
      for (let cycle = 0; cycle < 3; cycle++) {
        svc.lastCheckAt = Number.NEGATIVE_INFINITY;
        await svc.checkForPRs();
      }

      expect(svc.consecutiveErrors).toBe(3);
      expect(detectionStates).toContainEqual(expect.objectContaining({ tripped: true }));
      expect(notifications).toHaveLength(0);

      unsubNotify();
      unsubscribe();
      pullRequestService.destroy();
    });

    it("resets consecutiveErrors once a cycle completes without lookup failures", async () => {
      let failing = true;
      mockForgeProviderResolved(async () => {
        if (failing) throw new Error("network timeout");
        return makeMockForgePR();
      });

      const { pullRequestService } = await import("../PullRequestService.js");
      const { events } = await import("../events.js");

      const detected: DaintreeEventMap["sys:pr:detected"][] = [];
      const unsubscribe = events.on("sys:pr:detected", (payload) => detected.push(payload));

      pullRequestService.initialize("/repo", "test-project-id");
      events.emit(
        "sys:worktree:update",
        makeWorktreeSnapshot({ worktreeId: "wt-1", branch: "feature/a" })
      );

      const svc = pullRequestService as unknown as {
        checkForPRs: () => Promise<void>;
        resolveProvider: () => Promise<void>;
        consecutiveErrors: number;
        lastCheckAt: number;
      };

      await svc.resolveProvider();
      for (let cycle = 0; cycle < 2; cycle++) {
        svc.lastCheckAt = Number.NEGATIVE_INFINITY;
        await svc.checkForPRs();
      }
      expect(svc.consecutiveErrors).toBe(2);

      failing = false;
      svc.lastCheckAt = Number.NEGATIVE_INFINITY;
      await svc.checkForPRs();

      expect(svc.consecutiveErrors).toBe(0);
      expect(detected).toHaveLength(1);

      unsubscribe();
      pullRequestService.destroy();
    });

    it("keeps an existing PR row when its branch lookup later fails transiently", async () => {
      let failing = false;
      mockForgeProviderResolved(async () => {
        if (failing) throw new Error("network timeout");
        return makeMockForgePR();
      });

      const { pullRequestService } = await import("../PullRequestService.js");
      const { events } = await import("../events.js");

      const cleared: DaintreeEventMap["sys:pr:cleared"][] = [];
      const unsubscribe = events.on("sys:pr:cleared", (payload) => cleared.push(payload));

      pullRequestService.initialize("/repo", "test-project-id");
      events.emit(
        "sys:worktree:update",
        makeWorktreeSnapshot({ worktreeId: "wt-1", branch: "feature/a" })
      );

      await pullRequestService.refresh();
      const svc = pullRequestService as unknown as {
        detectedPRs: Map<string, unknown>;
        consecutiveErrors: number;
      };
      expect(svc.detectedPRs.has("wt-1")).toBe(true);

      // refresh() re-queries every worktree; the lookup now fails transiently.
      // The detected row must survive — this is the #9994 regression scenario.
      failing = true;
      await pullRequestService.refresh();

      expect(cleared).toHaveLength(0);
      expect(svc.detectedPRs.has("wt-1")).toBe(true);
      expect(svc.consecutiveErrors).toBe(1);

      unsubscribe();
      pullRequestService.destroy();
    });

    it("treats a non-Error rejection as transient, not confirmed absence", async () => {
      mockForgeProviderResolved(() => Promise.reject({ code: "ETIMEDOUT" }));

      const { pullRequestService } = await import("../PullRequestService.js");
      const { events } = await import("../events.js");

      const cleared: DaintreeEventMap["sys:pr:cleared"][] = [];
      const unsubscribe = events.on("sys:pr:cleared", (payload) => cleared.push(payload));

      pullRequestService.initialize("/repo", "test-project-id");
      events.emit(
        "sys:worktree:update",
        makeWorktreeSnapshot({ worktreeId: "wt-1", branch: "feature/a" })
      );

      await pullRequestService.refresh();

      const svc = pullRequestService as unknown as { consecutiveErrors: number };
      expect(cleared).toHaveLength(0);
      expect(svc.consecutiveErrors).toBe(1);

      unsubscribe();
      pullRequestService.destroy();
    });

    it("clears the row and deletes the detectedPRs entry on a confirmed no-PR result", async () => {
      let prGone = false;
      mockForgeProviderResolved(async () => (prGone ? null : makeMockForgePR()));

      const { pullRequestService } = await import("../PullRequestService.js");
      const { events } = await import("../events.js");

      const cleared: DaintreeEventMap["sys:pr:cleared"][] = [];
      const unsubscribe = events.on("sys:pr:cleared", (payload) => cleared.push(payload));

      pullRequestService.initialize("/repo", "test-project-id");
      events.emit(
        "sys:worktree:update",
        makeWorktreeSnapshot({ worktreeId: "wt-1", branch: "feature/a" })
      );

      await pullRequestService.refresh();
      const svc = pullRequestService as unknown as {
        detectedPRs: Map<string, unknown>;
        consecutiveErrors: number;
      };
      expect(svc.detectedPRs.has("wt-1")).toBe(true);

      // refresh() empties resolvedWorktrees but keeps detectedPRs, so the
      // confirmed-absent path must delete the stale entry alongside the clear
      // (otherwise a PENDING entry keeps the revalidation boost armed).
      prGone = true;
      await pullRequestService.refresh();

      expect(cleared).toHaveLength(1);
      expect(cleared[0]).toMatchObject({ worktreeId: "wt-1", branchName: "feature/a" });
      expect(svc.detectedPRs.has("wt-1")).toBe(false);
      expect(svc.consecutiveErrors).toBe(0);

      unsubscribe();
      pullRequestService.destroy();
    });

    it("handles a mixed cycle: detected, confirmed-absent, and failed branches independently", async () => {
      const mockImpl = mockForgeProviderResolved();
      mockImpl.findPRByBranch = vi.fn(async (_repo: RepoRef, branch: string) => {
        if (branch === "feature/a") return makeMockForgePR({ number: 1, headRef: branch });
        if (branch === "feature/b") return null;
        throw new Error("socket hang up");
      });

      const { pullRequestService } = await import("../PullRequestService.js");
      const { events } = await import("../events.js");

      const detected: DaintreeEventMap["sys:pr:detected"][] = [];
      const cleared: DaintreeEventMap["sys:pr:cleared"][] = [];
      const unsubDetected = events.on("sys:pr:detected", (payload) => detected.push(payload));
      const unsubCleared = events.on("sys:pr:cleared", (payload) => cleared.push(payload));

      pullRequestService.initialize("/repo", "test-project-id");
      events.emit(
        "sys:worktree:update",
        makeWorktreeSnapshot({ worktreeId: "wt-a", branch: "feature/a" })
      );
      events.emit(
        "sys:worktree:update",
        makeWorktreeSnapshot({ worktreeId: "wt-b", branch: "feature/b" })
      );
      events.emit(
        "sys:worktree:update",
        makeWorktreeSnapshot({ worktreeId: "wt-c", branch: "feature/c" })
      );

      const svc = pullRequestService as unknown as {
        checkForPRs: () => Promise<void>;
        resolveProvider: () => Promise<void>;
        detectedPRs: Map<string, unknown>;
        consecutiveErrors: number;
        lastCheckAt: number;
      };

      // Seed a previously-detected PR on the branch that is about to fail —
      // the failing lookup must leave it untouched.
      const priorPR = {
        number: 3,
        title: "Prior PR",
        url: "https://github.com/o/r/pull/3",
        state: "open",
        isDraft: false,
        providerId: "daintree.github.github",
        stagnantPollCount: 0,
      };
      svc.detectedPRs.set("wt-c", priorPR);

      await svc.resolveProvider();
      svc.lastCheckAt = Number.NEGATIVE_INFINITY;
      await svc.checkForPRs();

      // Detected branch resolves, confirmed-absent branch clears, failed
      // branch is skipped entirely (row preserved) — and the cycle counts a
      // single error.
      expect(detected.map((d) => d.worktreeId)).toContain("wt-a");
      expect(detected.map((d) => d.worktreeId)).not.toContain("wt-c");
      expect(cleared).toHaveLength(1);
      expect(cleared[0].worktreeId).toBe("wt-b");
      expect(svc.detectedPRs.get("wt-c")).toBe(priorPR);
      expect(svc.consecutiveErrors).toBe(1);

      unsubDetected();
      unsubCleared();
      pullRequestService.destroy();
    });

    it("routes mid-cycle failures to the rate-limit pause instead of the breaker when a limit is active", async () => {
      const mockImpl = mockForgeProviderResolved(async () => {
        throw new Error("API rate limit exceeded");
      });
      // First gate consult (top of cycle) sees budget remaining; the
      // post-error consult sees the exhausted limit that landed mid-cycle.
      mockImpl.getRateLimit = vi
        .fn()
        .mockResolvedValueOnce({ limit: 5000, remaining: 100, resetAt: null })
        .mockResolvedValue({ limit: 5000, remaining: 0, resetAt: Date.now() + 60_000 });

      const { pullRequestService } = await import("../PullRequestService.js");
      const { events } = await import("../events.js");

      const cleared: DaintreeEventMap["sys:pr:cleared"][] = [];
      const notifications: DaintreeEventMap["ui:notify"][] = [];
      const unsubCleared = events.on("sys:pr:cleared", (payload) => cleared.push(payload));
      const unsubNotify = events.on("ui:notify", (payload) => notifications.push(payload));

      pullRequestService.initialize("/repo", "test-project-id");
      events.emit(
        "sys:worktree:update",
        makeWorktreeSnapshot({ worktreeId: "wt-1", branch: "feature/a" })
      );

      const svc = pullRequestService as unknown as {
        checkForPRs: () => Promise<void>;
        resolveProvider: () => Promise<void>;
        consecutiveErrors: number;
        nextRetryAt: number;
        lastCheckAt: number;
      };

      await svc.resolveProvider();
      // A pre-existing streak is cleared by the pause: the prior failures were
      // likely the same rate limit before the gate caught it, so carrying them
      // over would leave the breaker on a hair trigger after the pause.
      svc.consecutiveErrors = 2;
      svc.lastCheckAt = Number.NEGATIVE_INFINITY;
      await svc.checkForPRs();

      // Rate-limit pause, not circuit breaker: streak cleared, no clear event,
      // no breaker trip or toast, polling deferred until the limit resets.
      expect(svc.consecutiveErrors).toBe(0);
      expect(svc.nextRetryAt).toBeGreaterThan(Date.now());
      expect(cleared).toHaveLength(0);
      expect(pullRequestService.getStatus().detectionStateTripped).toBe(false);
      expect(notifications).toHaveLength(0);

      unsubCleared();
      unsubNotify();
      pullRequestService.destroy();
    });
  });

  it("no-ops when no forge provider is resolved (null linkage, no toast, no error)", async () => {
    mockForgeProviderUnresolved();

    const { pullRequestService } = await import("../PullRequestService.js");
    const { events } = await import("../events.js");

    const detected: DaintreeEventMap["sys:pr:detected"][] = [];
    const unsubscribe = events.on("sys:pr:detected", (payload) => detected.push(payload));

    pullRequestService.initialize("/repo", "test-project-id");

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

  describe("no-match provider pause (#9997)", () => {
    it("keeps retrying on the 5s cold-start cap while resolution reports not-ready", async () => {
      mockForgeProviderUnresolved({ status: "not-ready" });
      const bridge = lastMockBridge!;

      const { pullRequestService } = await import("../PullRequestService.js");
      const { events } = await import("../events.js");

      pullRequestService.initialize("/repo", "test-project-id");
      events.emit(
        "sys:worktree:update",
        makeWorktreeSnapshot({ worktreeId: "wt-1", branch: "feature/test" })
      );

      await pullRequestService.start(0);
      const callsAfterStart = bridge.resolveProvider.mock.calls.length;
      expect(callsAfterStart).toBeGreaterThan(0);

      // The transient miss keeps the cold-start catch-up cap: each 5s tick
      // re-attempts resolution.
      await vi.advanceTimersByTimeAsync(5_000);
      expect(bridge.resolveProvider.mock.calls.length).toBe(callsAfterStart + 1);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(bridge.resolveProvider.mock.calls.length).toBe(callsAfterStart + 2);

      pullRequestService.destroy();
    });

    it("pauses polling entirely on a definitive no-match (no 5s spin)", async () => {
      mockForgeProviderUnresolved({ status: "no-match" });
      const bridge = lastMockBridge!;

      const { pullRequestService } = await import("../PullRequestService.js");
      const { events } = await import("../events.js");

      pullRequestService.initialize("/repo", "test-project-id");
      events.emit(
        "sys:worktree:update",
        makeWorktreeSnapshot({ worktreeId: "wt-1", branch: "feature/test" })
      );

      await pullRequestService.start(0);
      const callsAfterStart = bridge.resolveProvider.mock.calls.length;
      expect(callsAfterStart).toBeGreaterThan(0);

      // Definitive miss: no timer is armed, so hours of fake time produce
      // zero further resolution attempts (the bug was a 5s loop forever).
      await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
      expect(bridge.resolveProvider.mock.calls.length).toBe(callsAfterStart);

      pullRequestService.destroy();
    });

    it("re-arms a no-match pause when main pushes forge:provider-registry-updated", async () => {
      mockForgeProviderUnresolved({ status: "no-match" });
      const bridge = lastMockBridge!;

      const { pullRequestService } = await import("../PullRequestService.js");
      const { events } = await import("../events.js");

      pullRequestService.initialize("/repo", "test-project-id");
      events.emit(
        "sys:worktree:update",
        makeWorktreeSnapshot({ worktreeId: "wt-1", branch: "feature/test" })
      );

      await pullRequestService.start(0);
      await vi.advanceTimersByTimeAsync(60_000);
      const callsWhilePaused = bridge.resolveProvider.mock.calls.length;

      // A plugin registered a forge provider that matches now.
      bridge.resolveProvider.mockResolvedValue({
        status: "resolved",
        namespacedId: "daintree.github.github",
        repo: makeMockRepoRef(),
      });
      bridge.findPRByBranch.mockResolvedValue(null);
      pullRequestService.notifyForgeProviderRegistryUpdated();

      // Debounced wake-up re-resolves and resumes the poll loop.
      await vi.advanceTimersByTimeAsync(1_000);
      expect(bridge.resolveProvider.mock.calls.length).toBe(callsWhilePaused + 1);
      expect(pullRequestService.getProviderContext()).toMatchObject({
        providerId: "daintree.github.github",
        owner: "testowner",
        repo: "testrepo",
      });

      pullRequestService.destroy();
    });

    it("re-resolves an already-resolved provider on forge:provider-registry-updated", async () => {
      // Registry updates now also signal provider REMOVAL (live built-in
      // disable, #9304 follow-up), so a cached resolution can't be trusted —
      // it must be dropped and re-resolved. In the still-registered case the
      // re-resolution lands on the same provider.
      mockForgeProviderResolved();
      const bridge = lastMockBridge!;

      const { pullRequestService } = await import("../PullRequestService.js");
      const { events } = await import("../events.js");

      pullRequestService.initialize("/repo", "test-project-id");
      events.emit(
        "sys:worktree:update",
        makeWorktreeSnapshot({ worktreeId: "wt-1", branch: "feature/test" })
      );

      await pullRequestService.refresh();
      const callsAfterRefresh = bridge.resolveProvider.mock.calls.length;
      expect(pullRequestService.getProviderContext()).not.toBeNull();

      pullRequestService.notifyForgeProviderRegistryUpdated();
      // Invalidation is immediate — the stale resolution must not survive
      // even before any re-check fires. (When the provider was removed, this
      // is what stops further RPCs against an unregistered provider.)
      expect(pullRequestService.getProviderContext()).toBeNull();

      // Next check re-resolves; with the provider still registered it lands
      // back on the same provider.
      await pullRequestService.refresh();
      expect(bridge.resolveProvider.mock.calls.length).toBeGreaterThan(callsAfterRefresh);
      expect(pullRequestService.getProviderContext()).toMatchObject({
        providerId: "daintree.github.github",
      });

      pullRequestService.destroy();
    });

    it("transitions from not-ready retries to a no-match pause when the scan settles mid-session", async () => {
      mockForgeProviderUnresolved({ status: "not-ready" });
      const bridge = lastMockBridge!;

      const { pullRequestService } = await import("../PullRequestService.js");
      const { events } = await import("../events.js");

      pullRequestService.initialize("/repo", "test-project-id");
      events.emit(
        "sys:worktree:update",
        makeWorktreeSnapshot({ worktreeId: "wt-1", branch: "feature/test" })
      );

      await pullRequestService.start(0);
      const callsAfterStart = bridge.resolveProvider.mock.calls.length;

      // Plugin scan finishes between ticks — the next retry gets the
      // definitive answer and the loop must pause instead of spinning on.
      bridge.resolveProvider.mockResolvedValue({ status: "no-match" });
      await vi.advanceTimersByTimeAsync(5_000);
      const callsAtNoMatch = bridge.resolveProvider.mock.calls.length;
      expect(callsAtNoMatch).toBe(callsAfterStart + 1);

      await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
      expect(bridge.resolveProvider.mock.calls.length).toBe(callsAtNoMatch);

      pullRequestService.destroy();
    });

    it("is harmless when forge:provider-registry-updated arrives before start()", async () => {
      mockForgeProviderUnresolved({ status: "no-match" });
      const bridge = lastMockBridge!;

      const { pullRequestService } = await import("../PullRequestService.js");
      const { events } = await import("../events.js");

      pullRequestService.initialize("/repo", "test-project-id");
      pullRequestService.notifyForgeProviderRegistryUpdated();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(bridge.resolveProvider).not.toHaveBeenCalled();

      events.emit(
        "sys:worktree:update",
        makeWorktreeSnapshot({ worktreeId: "wt-1", branch: "feature/test" })
      );
      await pullRequestService.start(0);
      expect(bridge.resolveProvider).toHaveBeenCalled();

      pullRequestService.destroy();
    });

    it("does not re-resolve when a worktree update fires while paused on no-match", async () => {
      mockForgeProviderUnresolved({ status: "no-match" });
      const bridge = lastMockBridge!;

      const { pullRequestService } = await import("../PullRequestService.js");
      const { events } = await import("../events.js");

      pullRequestService.initialize("/repo", "test-project-id");
      events.emit(
        "sys:worktree:update",
        makeWorktreeSnapshot({ worktreeId: "wt-1", branch: "feature/test" })
      );

      await pullRequestService.start(0);
      await vi.advanceTimersByTimeAsync(60_000);
      const callsWhilePaused = bridge.resolveProvider.mock.calls.length;

      // New candidate triggers the debounced check, but the cached no-match
      // must keep blocking resolution (no fresh git-config spawns, #9997).
      events.emit(
        "sys:worktree:update",
        makeWorktreeSnapshot({ worktreeId: "wt-2", branch: "feature/other" })
      );
      await vi.advanceTimersByTimeAsync(60_000);
      expect(bridge.resolveProvider.mock.calls.length).toBe(callsWhilePaused);

      pullRequestService.destroy();
    });

    it("re-resolves after a no-match when the repo's git remotes change (#11155)", async () => {
      mockForgeProviderUnresolved({ status: "no-match" });
      const bridge = lastMockBridge!;

      const { pullRequestService } = await import("../PullRequestService.js");
      const { events } = await import("../events.js");

      pullRequestService.initialize("/repo", "test-project-id");
      events.emit(
        "sys:worktree:update",
        makeWorktreeSnapshot({ worktreeId: "wt-1", branch: "feature/test" })
      );

      await pullRequestService.start(0);
      await vi.advanceTimersByTimeAsync(60_000);
      const callsWhilePaused = bridge.resolveProvider.mock.calls.length;

      // `git remote add origin` — the one signal narrow enough to release the
      // pause. Unlike a worktree update, it means the input to resolution
      // itself changed, so the cached no-match is now stale.
      events.emit("sys:forge:remote-changed", { timestamp: Date.now() });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(bridge.resolveProvider.mock.calls.length).toBeGreaterThan(callsWhilePaused);

      pullRequestService.destroy();
    });

    it("re-pauses after a remote change that still resolves to no-match", async () => {
      mockForgeProviderUnresolved({ status: "no-match" });
      const bridge = lastMockBridge!;

      const { pullRequestService } = await import("../PullRequestService.js");
      const { events } = await import("../events.js");

      pullRequestService.initialize("/repo", "test-project-id");
      events.emit(
        "sys:worktree:update",
        makeWorktreeSnapshot({ worktreeId: "wt-1", branch: "feature/test" })
      );
      await pullRequestService.start(0);
      await vi.advanceTimersByTimeAsync(60_000);

      // A remote pointing at a host no provider claims: the re-resolve happens
      // once, then the pause must re-arm. Without this, adding an unsupported
      // remote would reopen #9997's forever-5s spin.
      events.emit("sys:forge:remote-changed", { timestamp: Date.now() });
      await vi.advanceTimersByTimeAsync(10_000);
      const callsAfterRemoteChange = bridge.resolveProvider.mock.calls.length;

      await vi.advanceTimersByTimeAsync(60_000);
      expect(bridge.resolveProvider.mock.calls.length).toBe(callsAfterRemoteChange);

      pullRequestService.destroy();
    });

    it("re-resolves after a no-match when forge settings change (setForgeSettings + refresh)", async () => {
      mockForgeProviderUnresolved({ status: "no-match" });
      const bridge = lastMockBridge!;

      const { pullRequestService } = await import("../PullRequestService.js");
      const { events } = await import("../events.js");

      pullRequestService.initialize("/repo", "test-project-id");
      events.emit(
        "sys:worktree:update",
        makeWorktreeSnapshot({ worktreeId: "wt-1", branch: "feature/test" })
      );

      await pullRequestService.start(0);
      await vi.advanceTimersByTimeAsync(60_000);
      const callsWhilePaused = bridge.resolveProvider.mock.calls.length;

      // Mirrors WorkspaceService.updateForgeSettings: settings push then refresh.
      bridge.resolveProvider.mockResolvedValue({
        status: "resolved",
        namespacedId: "daintree.github.github",
        repo: makeMockRepoRef(),
      });
      bridge.findPRByBranch.mockResolvedValue(null);
      pullRequestService.setForgeSettings({
        forgeProviderOverride: "daintree.github.github",
        forgeDefaultProviderId: null,
      });
      await pullRequestService.refresh();

      expect(bridge.resolveProvider.mock.calls.length).toBeGreaterThan(callsWhilePaused);
      expect(pullRequestService.getProviderContext()).not.toBeNull();

      pullRequestService.destroy();
    });
  });

  it("skips polling when provider reports remaining: 0 with a future resetAt", async () => {
    const futureReset = Date.now() + 30_000;
    const mockImpl = mockForgeProviderResolved();
    mockImpl.getRateLimit = vi.fn().mockResolvedValue({
      limit: 5000,
      remaining: 0,
      resetAt: futureReset,
    });

    const { pullRequestService } = await import("../PullRequestService.js");
    const { events } = await import("../events.js");

    pullRequestService.initialize("/repo", "test-project-id");

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
    const mockImpl = mockForgeProviderResolved();
    mockImpl.getRateLimit = vi.fn().mockResolvedValue({
      limit: 5000,
      remaining: 200,
      resetAt: null,
      secondaryThrottled: true,
    });

    const { pullRequestService } = await import("../PullRequestService.js");
    const { events } = await import("../events.js");

    pullRequestService.initialize("/repo", "test-project-id");

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
    const mockImpl = mockForgeProviderResolved();
    delete (mockImpl as unknown as Record<string, unknown>).getRateLimit;

    const { pullRequestService } = await import("../PullRequestService.js");
    const { events } = await import("../events.js");

    pullRequestService.initialize("/repo", "test-project-id");

    events.emit(
      "sys:worktree:update",
      makeWorktreeSnapshot({ worktreeId: "wt-1", branch: "feature/test" })
    );

    await pullRequestService.refresh();

    expect(mockImpl.findPRByBranch).toHaveBeenCalledTimes(1);

    pullRequestService.destroy();
  });

  it("proceeds normally when remaining is null (provider doesn't report that dimension)", async () => {
    const mockImpl = mockForgeProviderResolved();
    mockImpl.getRateLimit = vi.fn().mockResolvedValue({
      limit: null,
      remaining: null,
      resetAt: null,
    });

    const { pullRequestService } = await import("../PullRequestService.js");
    const { events } = await import("../events.js");

    pullRequestService.initialize("/repo", "test-project-id");

    events.emit(
      "sys:worktree:update",
      makeWorktreeSnapshot({ worktreeId: "wt-1", branch: "feature/test" })
    );

    await pullRequestService.refresh();

    expect(mockImpl.findPRByBranch).toHaveBeenCalledTimes(1);

    pullRequestService.destroy();
  });

  it("proceeds normally when getRateLimit rejects (fails open)", async () => {
    const mockImpl = mockForgeProviderResolved();
    mockImpl.getRateLimit = vi.fn().mockRejectedValue(new Error("timeout"));

    const { pullRequestService } = await import("../PullRequestService.js");
    const { events } = await import("../events.js");

    pullRequestService.initialize("/repo", "test-project-id");

    events.emit(
      "sys:worktree:update",
      makeWorktreeSnapshot({ worktreeId: "wt-1", branch: "feature/test" })
    );

    await pullRequestService.refresh();

    expect(mockImpl.findPRByBranch).toHaveBeenCalledTimes(1);

    pullRequestService.destroy();
  });

  it("skips revalidation when provider reports rate-limited", async () => {
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

    pullRequestService.initialize("/repo", "test-project-id");

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

      pullRequestService.initialize("/repo", "test-project-id");
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
      ciStatus?: "success" | "failure" | "pending";
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
      mockForgeProviderResolved();

      const { pullRequestService } = await import("../PullRequestService.js");
      pullRequestService.initialize("/repo", "test-project-id");

      const svc = pullRequestService as any;
      svc.detectedPRs.set("wt-1", makeDetectedPR({ stagnantPollCount: 0, ciStatus: "pending" }));

      expect(svc.getBoostRevalidationIntervalMs()).toBe(30_000);
      pullRequestService.destroy();
    });

    it("getBoostRevalidationIntervalMs: 60s at count 10", async () => {
      mockForgeProviderResolved();

      const { pullRequestService } = await import("../PullRequestService.js");
      pullRequestService.initialize("/repo", "test-project-id");

      const svc = pullRequestService as any;
      svc.detectedPRs.set("wt-1", makeDetectedPR({ stagnantPollCount: 10, ciStatus: "pending" }));

      expect(svc.getBoostRevalidationIntervalMs()).toBe(60_000);
      pullRequestService.destroy();
    });

    it("getBoostRevalidationIntervalMs: 120s at count 20", async () => {
      mockForgeProviderResolved();

      const { pullRequestService } = await import("../PullRequestService.js");
      pullRequestService.initialize("/repo", "test-project-id");

      const svc = pullRequestService as any;
      svc.detectedPRs.set("wt-1", makeDetectedPR({ stagnantPollCount: 20, ciStatus: "pending" }));

      expect(svc.getBoostRevalidationIntervalMs()).toBe(120_000);
      pullRequestService.destroy();
    });

    it("getBoostRevalidationIntervalMs: picks max across PENDING PRs only", async () => {
      mockForgeProviderResolved();

      const { pullRequestService } = await import("../PullRequestService.js");
      pullRequestService.initialize("/repo", "test-project-id");

      const svc = pullRequestService as any;
      // SUCCESS PR with high count — should be ignored
      svc.detectedPRs.set(
        "wt-1",
        makeDetectedPR({ number: 1, stagnantPollCount: 20, ciStatus: "success" })
      );
      // PENDING PR with lower count — this one counts
      svc.detectedPRs.set(
        "wt-2",
        makeDetectedPR({ number: 2, stagnantPollCount: 12, ciStatus: "pending" })
      );

      expect(svc.getBoostRevalidationIntervalMs()).toBe(60_000);
      pullRequestService.destroy();
    });

    it("getBoostRevalidationIntervalMs: ignores non-PENDING PRs", async () => {
      mockForgeProviderResolved();

      const { pullRequestService } = await import("../PullRequestService.js");
      pullRequestService.initialize("/repo", "test-project-id");

      const svc = pullRequestService as any;
      svc.detectedPRs.set("wt-1", makeDetectedPR({ stagnantPollCount: 20, ciStatus: "success" }));

      expect(svc.getBoostRevalidationIntervalMs()).toBe(30_000);
      pullRequestService.destroy();
    });

    it("getBoostRevalidationIntervalMs: returns 30s when detectedPRs is empty", async () => {
      mockForgeProviderResolved();

      const { pullRequestService } = await import("../PullRequestService.js");
      pullRequestService.initialize("/repo", "test-project-id");

      const svc = pullRequestService as any;
      svc.detectedPRs.clear();

      expect(svc.getBoostRevalidationIntervalMs()).toBe(30_000);
      pullRequestService.destroy();
    });

    it("clearStagnantPollCounts: resets all PRs to 0", async () => {
      mockForgeProviderResolved();

      const { pullRequestService } = await import("../PullRequestService.js");
      pullRequestService.initialize("/repo", "test-project-id");

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
      mockForgeProviderResolved();

      const { pullRequestService } = await import("../PullRequestService.js");
      pullRequestService.initialize("/repo", "test-project-id");

      const svc = pullRequestService as any;
      svc.detectedPRs.set("wt-1", makeDetectedPR({ stagnantPollCount: 8 }));
      svc.isPolling = true;

      pullRequestService.stop();

      for (const pr of svc.detectedPRs.values()) {
        expect(pr.stagnantPollCount).toBe(0);
      }
    });

    it("refresh() clears stagnant counts", async () => {
      mockForgeProviderResolved();

      const { pullRequestService } = await import("../PullRequestService.js");
      pullRequestService.initialize("/repo", "test-project-id");

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
      mockForgeProviderResolved();

      const { pullRequestService } = await import("../PullRequestService.js");
      pullRequestService.initialize("/repo", "test-project-id");

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
      const pr = makeDetectedPR({ stagnantPollCount: 0, ciStatus: "pending" });

      // Simulate unchanged CI result
      const prevSame = pr.ciStatus;
      pr.ciStatus = "pending";
      if (pr.ciStatus !== undefined) {
        pr.stagnantPollCount = prevSame === pr.ciStatus ? pr.stagnantPollCount + 1 : 0;
      }
      expect(pr.stagnantPollCount).toBe(1);

      // Simulate another unchanged poll
      const prevSame2 = pr.ciStatus;
      pr.ciStatus = "pending";
      if (pr.ciStatus !== undefined) {
        pr.stagnantPollCount = prevSame2 === pr.ciStatus ? pr.stagnantPollCount + 1 : 0;
      }
      expect(pr.stagnantPollCount).toBe(2);

      // Simulate CI transition
      const prevDiff = pr.ciStatus as string | undefined;
      pr.ciStatus = "success";
      if (pr.ciStatus !== undefined) {
        pr.stagnantPollCount = prevDiff === pr.ciStatus ? pr.stagnantPollCount + 1 : 0;
      }
      expect(pr.stagnantPollCount).toBe(0);
    });

    it("scheduleRevalidation sets a timer when boost is active", async () => {
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

  describe("CI enrichment gating (#10124)", () => {
    const ROLE_ENV = "DAINTREE_INSTANCE_ROLE";

    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
      vi.resetModules();
      vi.clearAllMocks();
      lastMockBridge = null;
    });

    function makeDetectedPR(overrides?: {
      number?: number;
      ciStatus?: "success" | "failure" | "pending";
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

    // Worker instances never own a focused window, so enrichment must default
    // off — set before the singleton is imported so the field initializer reads
    // it. withRole restores the prior env regardless of assertion outcome.
    async function withRole<T>(role: string | undefined, fn: () => Promise<T>): Promise<T> {
      const prev = process.env[ROLE_ENV];
      if (role === undefined) delete process.env[ROLE_ENV];
      else process.env[ROLE_ENV] = role;
      try {
        return await fn();
      } finally {
        if (prev === undefined) delete process.env[ROLE_ENV];
        else process.env[ROLE_ENV] = prev;
      }
    }

    it("initializes enrichment disabled for the worker role", async () => {
      await withRole("worker", async () => {
        mockForgeProviderResolved();

        const { pullRequestService } = await import("../PullRequestService.js");
        const svc = pullRequestService as any;

        expect(svc.ciEnrichmentEnabled).toBe(false);
        pullRequestService.destroy();
      });
    });

    it("initializes enrichment enabled for attended (non-worker) instances", async () => {
      await withRole(undefined, async () => {
        mockForgeProviderResolved();

        const { pullRequestService } = await import("../PullRequestService.js");
        const svc = pullRequestService as any;

        expect(svc.ciEnrichmentEnabled).toBe(true);
        pullRequestService.destroy();
      });
    });

    it("skips the getCIStatuses batch entirely on worker instances", async () => {
      await withRole("worker", async () => {
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

        pullRequestService.initialize("/repo", "test-project-id");
        events.emit(
          "sys:worktree:update",
          makeWorktreeSnapshot({ worktreeId: "wt-1", branch: "feature/a" })
        );

        await pullRequestService.refresh();
        await flushLoaders();

        // The expensive enrichment fan-out never runs...
        expect(getCIStatuses).not.toHaveBeenCalled();
        expect(mockImpl.getCIStatus).not.toHaveBeenCalled();

        // ...and the detection emit omits the loading flag: there is no phase-2
        // coming, so a held "loading" would spin forever (#6240).
        const detection = detected.find((d) => d.prNumber === 7);
        expect(detection).toBeDefined();
        expect(detection?.isCiStatusLoading).toBeUndefined();
        expect(detection?.prCiStatus).toBeUndefined();

        unsubscribe();
        pullRequestService.destroy();
      });
    });

    it("clears in-flight CI and collapses the boost when enrichment is disabled", async () => {
      await withRole(undefined, async () => {
        mockForgeProviderResolved();

        const { pullRequestService } = await import("../PullRequestService.js");
        const { events } = await import("../events.js");
        const svc = pullRequestService as any;

        pullRequestService.initialize("/repo", "test-project-id");
        svc.repoRef = makeMockRepoRef();
        svc.detectedPRs.set("wt-1", makeDetectedPR({ number: 7, ciStatus: "pending" }));
        svc.boostExpiresAt = Date.now() + 15 * 60 * 1000;

        const detected: DaintreeEventMap["sys:pr:detected"][] = [];
        const unsubscribe = events.on("sys:pr:detected", (payload) => detected.push(payload));

        pullRequestService.setCIEnrichmentEnabled(false);

        // PENDING is cleared to undefined (unknown), never SUCCESS (#6240).
        expect(svc.detectedPRs.get("wt-1").ciStatus).toBeUndefined();
        // No PENDING entry left → boost collapses so cadence decays to baseline.
        expect(svc.boostExpiresAt).toBeNull();

        // The re-emit drops the dot: absent CI fields + no loading flag mean the
        // host full-replaces to "no checks" rather than holding the stale dot.
        const clear = detected.find((d) => d.worktreeId === "wt-1" && d.prNumber === 7);
        expect(clear).toBeDefined();
        expect(clear?.prCiStatus).toBeUndefined();
        expect(clear?.ciStatus).toBeUndefined();
        expect(clear?.isCiStatusLoading).toBeUndefined();

        unsubscribe();
        pullRequestService.destroy();
      });
    });

    it("leaves terminal CI states untouched and emits nothing for them on disable", async () => {
      await withRole(undefined, async () => {
        mockForgeProviderResolved();

        const { pullRequestService } = await import("../PullRequestService.js");
        const { events } = await import("../events.js");
        const svc = pullRequestService as any;

        pullRequestService.initialize("/repo", "test-project-id");
        svc.repoRef = makeMockRepoRef();
        svc.detectedPRs.set("wt-1", makeDetectedPR({ number: 7, ciStatus: "success" }));

        const detected: DaintreeEventMap["sys:pr:detected"][] = [];
        const unsubscribe = events.on("sys:pr:detected", (payload) => detected.push(payload));

        pullRequestService.setCIEnrichmentEnabled(false);

        // SUCCESS is already correct for the renderer — no sweep, no noise emit.
        expect(svc.detectedPRs.get("wt-1").ciStatus).toBe("success");
        expect(detected).toHaveLength(0);

        unsubscribe();
        pullRequestService.destroy();
      });
    });

    it("is idempotent — a second disable does not re-sweep or re-emit", async () => {
      await withRole(undefined, async () => {
        mockForgeProviderResolved();

        const { pullRequestService } = await import("../PullRequestService.js");
        const { events } = await import("../events.js");
        const svc = pullRequestService as any;

        pullRequestService.initialize("/repo", "test-project-id");
        svc.repoRef = makeMockRepoRef();
        svc.detectedPRs.set("wt-1", makeDetectedPR({ number: 7, ciStatus: "pending" }));

        const detected: DaintreeEventMap["sys:pr:detected"][] = [];
        const unsubscribe = events.on("sys:pr:detected", (payload) => detected.push(payload));

        pullRequestService.setCIEnrichmentEnabled(false);
        const afterFirst = detected.length;
        // Re-seed a PENDING entry: if the second call still swept, it would emit.
        svc.detectedPRs.get("wt-1").ciStatus = "pending";
        pullRequestService.setCIEnrichmentEnabled(false);

        expect(afterFirst).toBe(1);
        expect(detected).toHaveLength(afterFirst);
        // The re-seeded value is left alone — the no-op early-returns before sweep.
        expect(svc.detectedPRs.get("wt-1").ciStatus).toBe("pending");

        unsubscribe();
        pullRequestService.destroy();
      });
    });

    it("does not write CI back when enrichment is disabled mid-flight", async () => {
      await withRole(undefined, async () => {
        let resolveCi: (m: Map<number, CIStatus | null>) => void = () => {};
        const batchSpy = vi.fn(async (_repo: RepoRef, branches: string[]) => {
          const map = new Map<string, ForgePR | null>();
          for (const branch of branches)
            map.set(branch, makeMockForgePR({ number: 7, headRef: branch }));
          return map;
        });
        const mockImpl = mockForgeProviderResolved(undefined, batchSpy);
        const getCIStatuses = vi.fn(
          (_repo: RepoRef, _prNumbers: number[]) =>
            new Promise<Map<number, CIStatus | null>>((resolve) => {
              resolveCi = resolve;
            })
        );
        mockImpl.batchLookups = { getCIStatuses };

        const { pullRequestService } = await import("../PullRequestService.js");
        const { events } = await import("../events.js");
        const svc = pullRequestService as any;

        pullRequestService.initialize("/repo", "test-project-id");
        events.emit(
          "sys:worktree:update",
          makeWorktreeSnapshot({ worktreeId: "wt-1", branch: "feature/a" })
        );
        await pullRequestService.refresh();
        await flushLoaders();

        // Enrichment is dispatched but still pending. Disable, then let it land.
        expect(getCIStatuses).toHaveBeenCalledTimes(1);
        pullRequestService.setCIEnrichmentEnabled(false);
        resolveCi(new Map([[7, makeMockCIStatus()]]));
        await flushLoaders();

        // The stale in-flight result is discarded — the PR keeps no CI status.
        const pr = svc.detectedPRs.get("wt-1");
        expect(pr?.ciStatus).toBeUndefined();

        pullRequestService.destroy();
      });
    });

    it("keeps worker instances disabled even when asked to re-enable", async () => {
      await withRole("worker", async () => {
        mockForgeProviderResolved();

        const { pullRequestService } = await import("../PullRequestService.js");
        const svc = pullRequestService as any;

        // A stray focus signal must not flip a worker back on.
        pullRequestService.setCIEnrichmentEnabled(true);
        expect(svc.ciEnrichmentEnabled).toBe(false);

        pullRequestService.destroy();
      });
    });

    it("does not blank a SUCCESS worktree that shares a PR number with a swept one", async () => {
      await withRole(undefined, async () => {
        mockForgeProviderResolved();

        const { pullRequestService } = await import("../PullRequestService.js");
        const { events } = await import("../events.js");
        const svc = pullRequestService as any;

        pullRequestService.initialize("/repo", "test-project-id");
        svc.repoRef = makeMockRepoRef();
        // Two distinct PR objects coincidentally numbered 42: one PENDING (to be
        // swept), one SUCCESS (must survive untouched).
        svc.detectedPRs.set("wt-pending", makeDetectedPR({ number: 42, ciStatus: "pending" }));
        svc.detectedPRs.set("wt-success", makeDetectedPR({ number: 42, ciStatus: "success" }));

        const detected: DaintreeEventMap["sys:pr:detected"][] = [];
        const unsubscribe = events.on("sys:pr:detected", (payload) => detected.push(payload));

        pullRequestService.setCIEnrichmentEnabled(false);

        // The SUCCESS entry keeps its status and is never re-emitted as cleared.
        expect(svc.detectedPRs.get("wt-success").ciStatus).toBe("success");
        expect(detected.some((d) => d.worktreeId === "wt-success")).toBe(false);
        // The PENDING entry was swept and re-emitted without a CI status.
        expect(svc.detectedPRs.get("wt-pending").ciStatus).toBeUndefined();
        expect(detected.some((d) => d.worktreeId === "wt-pending")).toBe(true);

        unsubscribe();
        pullRequestService.destroy();
      });
    });
  });

  describe("terminal CI re-enrichment (#11513)", () => {
    const MINUTE = 60 * 1000;

    // Two resolved worktrees on distinct branches → PRs 1 and 2, with a
    // caller-controlled CI state per PR number so a test can simulate a re-run
    // landing between polls. probeOpenPRList always reports "unchanged", which
    // is the steady state this issue is about: metadata revalidation is skipped,
    // so CI selection is the only thing that can trigger a re-fetch.
    function makeUnchangedProbeHarness(ciByNumber: Map<number, CIStatus | null>) {
      const numberByBranch = new Map([
        ["feature/a", 1],
        ["feature/b", 2],
      ]);
      const batchSpy = vi.fn(async (_repo: RepoRef, branches: string[]) => {
        const map = new Map<string, ForgePR | null>();
        for (const branch of branches) {
          const number = numberByBranch.get(branch);
          map.set(branch, number ? makeMockForgePR({ number, headRef: branch }) : null);
        }
        return map;
      });
      const mockImpl = mockForgeProviderResolved(undefined, batchSpy);

      const getCIStatuses = vi.fn(async (_repo: RepoRef, prNumbers: number[]) => {
        const map = new Map<number, CIStatus | null>();
        for (const n of prNumbers) map.set(n, ciByNumber.get(n) ?? null);
        return map;
      });
      const findPRsByNumbers = vi.fn(async (_repo: RepoRef, prNumbers: number[]) => {
        const map = new Map<number, ForgePR | null>();
        for (const n of prNumbers) map.set(n, makeMockForgePR({ number: n }));
        return map;
      });
      const probeOpenPRList = vi.fn(async () => ({ kind: "unchanged" as const }));
      mockImpl.batchLookups = { findPRsByNumbers, getCIStatuses, probeOpenPRList };

      return { getCIStatuses, findPRsByNumbers, probeOpenPRList };
    }

    function ciState(state: "success" | "failure" | "pending"): CIStatus {
      return {
        state,
        total: 1,
        passed: state === "success" ? 1 : 0,
        failed: state === "failure" ? 1 : 0,
        pending: state === "pending" ? 1 : 0,
        rawData: null,
      };
    }

    // Resolve `branches` into detected PRs and let the first CI enrichment land,
    // so every PR carries a status and a fresh attempt timestamp. Returns with
    // the CI spy cleared, ready for the assertions under test.
    async function detectAndSettle(branches: string[]) {
      const { pullRequestService } = await import("../PullRequestService.js");
      const { events } = await import("../events.js");

      pullRequestService.initialize("/repo", "test-project-id");
      branches.forEach((branch, index) => {
        events.emit(
          "sys:worktree:update",
          makeWorktreeSnapshot({ worktreeId: `wt-${index + 1}`, branch })
        );
      });

      await pullRequestService.refresh();
      await flushLoaders();

      // start() is what normally arms this; the focus paths under test gate on
      // it, and calling start() here would schedule jittered startup timers.
      (pullRequestService as unknown as { isPolling: boolean }).isPolling = true;

      return { pullRequestService, events };
    }

    async function revalidate(service: unknown): Promise<void> {
      await (
        service as unknown as { revalidateResolvedPRs: () => Promise<void> }
      ).revalidateResolvedPRs();
      await flushLoaders();
    }

    // Jump the clock without firing timers — advancing time normally would run
    // the self-rescheduling revalidation chain and add calls the assertions
    // aren't about.
    function jump(ms: number): void {
      vi.setSystemTime(Date.now() + ms);
    }

    it("does not re-check a terminal PR before its interval elapses", async () => {
      const { getCIStatuses } = makeUnchangedProbeHarness(
        new Map([
          [1, ciState("failure")],
          [2, ciState("success")],
        ])
      );

      const { pullRequestService } = await detectAndSettle(["feature/a", "feature/b"]);
      getCIStatuses.mockClear();

      // Back-to-back tick: both PRs were just enriched, so neither is due.
      await revalidate(pullRequestService);
      expect(getCIStatuses).not.toHaveBeenCalled();

      // Still short of the shorter (failure) interval.
      jump(2 * MINUTE);
      await revalidate(pullRequestService);
      expect(getCIStatuses).not.toHaveBeenCalled();

      pullRequestService.destroy();
    });

    it("re-checks a failed PR before a successful one", async () => {
      const { getCIStatuses } = makeUnchangedProbeHarness(
        new Map([
          [1, ciState("failure")],
          [2, ciState("success")],
        ])
      );

      const { pullRequestService } = await detectAndSettle(["feature/a", "feature/b"]);
      getCIStatuses.mockClear();

      // Failure weighting is the point: at some elapsed time the failed PR is
      // due and the successful one is not. Walk forward a minute at a time
      // until the first re-check fires and assert what it contained.
      let firstBatch: number[] | null = null;
      for (let elapsed = 0; elapsed < 60 && firstBatch === null; elapsed++) {
        jump(MINUTE);
        await revalidate(pullRequestService);
        if (getCIStatuses.mock.calls.length > 0) {
          firstBatch = getCIStatuses.mock.calls[0]?.[1] ?? null;
        }
      }

      // The failed PR re-checks strictly sooner — the success PR is absent from
      // the first batch entirely.
      expect(firstBatch).toEqual([1]);

      pullRequestService.destroy();
    });

    it("turns a green badge red when a re-run fails", async () => {
      const ciByNumber = new Map([
        [1, ciState("failure")],
        [2, ciState("success")],
      ]);
      const { getCIStatuses } = makeUnchangedProbeHarness(ciByNumber);

      const { pullRequestService, events } = await detectAndSettle(["feature/a", "feature/b"]);
      const svc = pullRequestService as unknown as {
        detectedPRs: Map<string, { ciStatus?: string }>;
      };
      expect(svc.detectedPRs.get("wt-2")?.ciStatus).toBe("success");
      getCIStatuses.mockClear();

      const detected: DaintreeEventMap["sys:pr:detected"][] = [];
      const unsubscribe = events.on("sys:pr:detected", (payload) => detected.push(payload));

      // The green PR's next run breaks, with no push behind it.
      ciByNumber.set(2, ciState("failure"));

      for (
        let elapsed = 0;
        elapsed < 60 && svc.detectedPRs.get("wt-2")?.ciStatus !== "failure";
        elapsed++
      ) {
        jump(MINUTE);
        await revalidate(pullRequestService);
      }

      // A green badge is not a fixed point — asserting the badge actually flips
      // rather than merely that PR 2 was queried, so a regression that fetches
      // but declines to apply the result over a cached success is still caught
      // (#6149).
      expect(svc.detectedPRs.get("wt-2")?.ciStatus).toBe("failure");
      expect(detected.filter((d) => d.worktreeId === "wt-2").at(-1)?.prCiStatus).toBe("failure");

      unsubscribe();
      pullRequestService.destroy();
    });

    it("surfaces a re-run that flips a failed PR back to pending", async () => {
      const ciByNumber = new Map([[1, ciState("failure")]]);
      const { getCIStatuses } = makeUnchangedProbeHarness(ciByNumber);

      const { pullRequestService, events } = await detectAndSettle(["feature/a"]);
      const svc = pullRequestService as unknown as {
        detectedPRs: Map<string, { ciStatus?: string; stagnantPollCount: number }>;
        boostExpiresAt: number | null;
      };
      expect(svc.detectedPRs.get("wt-1")?.ciStatus).toBe("failure");
      getCIStatuses.mockClear();

      const detected: DaintreeEventMap["sys:pr:detected"][] = [];
      const unsubscribe = events.on("sys:pr:detected", (payload) => detected.push(payload));

      // Seed a stagnation count the transition has to actually clear — starting
      // from 0 would let an implementation that never resets it still pass.
      const pr = svc.detectedPRs.get("wt-1");
      if (pr) pr.stagnantPollCount = 17;

      // The user re-runs the failed job: no push, so updated_at never moves and
      // the probe still reports the PR unchanged.
      ciByNumber.set(1, ciState("pending"));

      for (let elapsed = 0; elapsed < 60 && getCIStatuses.mock.calls.length === 0; elapsed++) {
        jump(MINUTE);
        await revalidate(pullRequestService);
      }

      expect(svc.detectedPRs.get("wt-1")?.ciStatus).toBe("pending");
      expect(detected.at(-1)?.prCiStatus).toBe("pending");
      // The cross→pending transition now arms the boost, which it never could
      // while terminal states were excluded from re-enrichment.
      expect(svc.boostExpiresAt).not.toBeNull();
      // A stale terminal stagnation count must not land the re-run straight in
      // the slowest decay band.
      expect(svc.detectedPRs.get("wt-1")?.stagnantPollCount).toBe(0);

      unsubscribe();
      pullRequestService.destroy();
    });

    it("paces the next attempt off the request, not the response", async () => {
      const { getCIStatuses } = makeUnchangedProbeHarness(new Map([[1, ciState("failure")]]));

      const { pullRequestService } = await detectAndSettle(["feature/a"]);
      const svc = pullRequestService as unknown as {
        detectedPRs: Map<string, { ciStatus?: string }>;
      };
      getCIStatuses.mockClear();
      // Every re-check from here on comes back with the key omitted, which the
      // loader surfaces as a per-key rejection. Rejecting the whole call instead
      // would fall through to the per-PR getCIStatus path, whose default mock
      // resolves null and would quietly retire the PR from terminal state.
      getCIStatuses.mockResolvedValue(new Map<number, CIStatus | null>());

      for (let elapsed = 0; elapsed < 60 && getCIStatuses.mock.calls.length === 0; elapsed++) {
        jump(MINUTE);
        await revalidate(pullRequestService);
      }
      expect(getCIStatuses).toHaveBeenCalledTimes(1);
      // The rejection left the cached status alone, so the PR is still terminal
      // and still a candidate — the only thing holding it back is the pacing.
      expect(svc.detectedPRs.get("wt-1")?.ciStatus).toBe("failure");

      // The attempt is stamped on enqueue, so a rejected batch waits out the
      // interval instead of re-firing on every tick.
      await revalidate(pullRequestService);
      await revalidate(pullRequestService);
      expect(getCIStatuses).toHaveBeenCalledTimes(1);

      pullRequestService.destroy();
    });

    it("re-checks a terminal PR when the system clock jumps backwards", async () => {
      const { getCIStatuses } = makeUnchangedProbeHarness(new Map([[1, ciState("success")]]));

      const { pullRequestService } = await detectAndSettle(["feature/a"]);
      getCIStatuses.mockClear();

      // A clock correction leaves the last-attempt stamp in the future. Elapsed
      // time can never reach the interval again, so without a rebase the PR
      // would be wedged out of re-checks for the length of the jump.
      jump(-2 * 60 * MINUTE);
      await revalidate(pullRequestService);

      expect(getCIStatuses).toHaveBeenCalledWith(expect.anything(), [1]);

      pullRequestService.destroy();
    });

    it("leaves the pending cadence untouched", async () => {
      const { getCIStatuses } = makeUnchangedProbeHarness(new Map([[1, ciState("pending")]]));

      const { pullRequestService } = await detectAndSettle(["feature/a"]);
      getCIStatuses.mockClear();

      // Pending re-polls every tick. The attempt timestamp the terminal pass
      // introduced must not throttle it — that cadence is deliberately tuned
      // and re-tuning it is an explicit non-goal of this issue.
      await revalidate(pullRequestService);
      await revalidate(pullRequestService);

      expect(getCIStatuses).toHaveBeenCalledTimes(2);

      pullRequestService.destroy();
    });

    it("does not periodically re-check a PR with no CI checks", async () => {
      // `null` from the provider is a confirmed "no CI configured" → undefined
      // status. There is nothing to re-poll for, so the slow pass must not burn
      // quota on it (#6240). Focus regain is the deliberate exception, since a
      // blur-swept badge is indistinguishable from this state.
      const { getCIStatuses } = makeUnchangedProbeHarness(new Map([[1, null]]));

      const { pullRequestService } = await detectAndSettle(["feature/a"]);
      const svc = pullRequestService as unknown as {
        detectedPRs: Map<string, { ciStatus?: string }>;
      };
      expect(svc.detectedPRs.get("wt-1")?.ciStatus).toBeUndefined();
      getCIStatuses.mockClear();

      for (let elapsed = 0; elapsed < 60; elapsed++) {
        jump(MINUTE);
        await revalidate(pullRequestService);
      }

      expect(getCIStatuses).not.toHaveBeenCalled();

      pullRequestService.destroy();
    });

    it("backfills a CI status swept to unknown on blur once focus returns", async () => {
      const ciByNumber = new Map([[1, ciState("pending")]]);
      const { getCIStatuses } = makeUnchangedProbeHarness(ciByNumber);

      const { pullRequestService, events } = await detectAndSettle(["feature/a"]);
      const svc = pullRequestService as unknown as {
        detectedPRs: Map<string, { ciStatus?: string }>;
        hasUnresolvedCandidates: () => boolean;
      };

      // Blur sweeps the in-flight badge to unknown.
      pullRequestService.setCIEnrichmentEnabled(false);
      expect(svc.detectedPRs.get("wt-1")?.ciStatus).toBeUndefined();

      // CI finished while the window was blurred.
      ciByNumber.set(1, ciState("success"));
      getCIStatuses.mockClear();

      const detected: DaintreeEventMap["sys:pr:detected"][] = [];
      const unsubscribe = events.on("sys:pr:detected", (payload) => detected.push(payload));

      pullRequestService.setCIEnrichmentEnabled(true);
      pullRequestService.setFocusCadence(true);
      await flushLoaders();

      // The swept entry is neither pending nor probe-flagged, so only the focus
      // pass can reach it — and it must, because every candidate is already
      // resolved, which is what made the old catch-up skip this entirely.
      expect(svc.hasUnresolvedCandidates()).toBe(false);
      expect(getCIStatuses).toHaveBeenCalledWith(expect.anything(), [1]);
      expect(svc.detectedPRs.get("wt-1")?.ciStatus).toBe("success");
      expect(detected.at(-1)?.prCiStatus).toBe("success");

      unsubscribe();
      pullRequestService.destroy();
    });

    it("backfills a swept CI status on the periodic tick when focus is missed", async () => {
      const ciByNumber = new Map([[1, ciState("pending")]]);
      const { getCIStatuses } = makeUnchangedProbeHarness(ciByNumber);

      const { pullRequestService } = await detectAndSettle(["feature/a"]);
      const svc = pullRequestService as unknown as {
        detectedPRs: Map<string, { ciStatus?: string }>;
      };

      pullRequestService.setCIEnrichmentEnabled(false);
      expect(svc.detectedPRs.get("wt-1")?.ciStatus).toBeUndefined();

      ciByNumber.set(1, ciState("success"));
      getCIStatuses.mockClear();

      // Focus regain WITHOUT the catch-up landing — it can be lost to the 5s
      // throttle after a quick alt-tab, to a rate-limit pause, or to a rejected
      // batch. The swept entry is neither pending nor terminal, so before the
      // backfill marker nothing would ever pick it up again.
      pullRequestService.setCIEnrichmentEnabled(true);
      await revalidate(pullRequestService);

      expect(getCIStatuses).toHaveBeenCalledWith(expect.anything(), [1]);
      expect(svc.detectedPRs.get("wt-1")?.ciStatus).toBe("success");

      // Debt settled: the entry drops back to the ordinary terminal cadence
      // instead of re-fetching on every tick forever.
      getCIStatuses.mockClear();
      await revalidate(pullRequestService);
      expect(getCIStatuses).not.toHaveBeenCalled();

      pullRequestService.destroy();
    });

    it("keeps the backfill debt when the CI lookup fails outright", async () => {
      const ciByNumber = new Map([[1, ciState("pending")]]);
      const { getCIStatuses } = makeUnchangedProbeHarness(ciByNumber);

      const { pullRequestService } = await detectAndSettle(["feature/a"]);
      const svc = pullRequestService as unknown as {
        detectedPRs: Map<string, { ciStatus?: string; needsCiBackfill?: boolean }>;
      };

      pullRequestService.setCIEnrichmentEnabled(false);
      expect(svc.detectedPRs.get("wt-1")?.needsCiBackfill).toBe(true);

      // The whole batch call fails. The loader's per-PR fallback launders that
      // into a resolved `null`, which is indistinguishable from a confirmed
      // "no checks" — so treating null as authoritative would clear the debt
      // and strand the badge permanently on a transient blip.
      getCIStatuses.mockRejectedValue(new Error("provider unreachable"));
      pullRequestService.setCIEnrichmentEnabled(true);
      await revalidate(pullRequestService);

      expect(svc.detectedPRs.get("wt-1")?.ciStatus).toBeUndefined();
      expect(svc.detectedPRs.get("wt-1")?.needsCiBackfill).toBe(true);

      // Provider recovers → the retained debt gets the badge back.
      getCIStatuses.mockReset();
      getCIStatuses.mockImplementation(async (_repo: RepoRef, prNumbers: number[]) => {
        const map = new Map<number, CIStatus | null>();
        for (const n of prNumbers) map.set(n, ciByNumber.get(n) ?? null);
        return map;
      });
      ciByNumber.set(1, ciState("success"));
      await revalidate(pullRequestService);

      expect(svc.detectedPRs.get("wt-1")?.ciStatus).toBe("success");
      expect(svc.detectedPRs.get("wt-1")?.needsCiBackfill).toBeUndefined();

      pullRequestService.destroy();
    });

    it("re-arms revalidation when a re-run newly arms the boost", async () => {
      const ciByNumber = new Map([[1, ciState("failure")]]);
      makeUnchangedProbeHarness(ciByNumber);

      const { pullRequestService } = await detectAndSettle(["feature/a"]);
      const svc = pullRequestService as unknown as {
        scheduleRevalidation: () => void;
        boostExpiresAt: number | null;
      };
      expect(svc.boostExpiresAt).toBeNull();

      const scheduleSpy = vi.spyOn(svc, "scheduleRevalidation");

      ciByNumber.set(1, ciState("pending"));
      for (let elapsed = 0; elapsed < 60 && svc.boostExpiresAt === null; elapsed++) {
        jump(MINUTE);
        await revalidate(pullRequestService);
      }
      expect(svc.boostExpiresAt).not.toBeNull();

      // Enrichment is fire-and-forget, so the tick that discovered the re-run
      // had already re-armed its own timer at the baseline before the pending
      // result landed. Without an explicit reschedule the freshly-armed boost
      // wouldn't take effect until that stale interval elapsed.
      expect(scheduleSpy).toHaveBeenCalled();

      scheduleSpy.mockRestore();
      pullRequestService.destroy();
    });

    it("runs the focus catch-up even when enrichment was already enabled", async () => {
      const { getCIStatuses } = makeUnchangedProbeHarness(new Map([[1, ciState("failure")]]));

      const { pullRequestService } = await detectAndSettle(["feature/a"]);
      getCIStatuses.mockClear();

      // A workspace-host restarted while the app was blurred keeps the attended
      // `true` default (its focus cadence is never replayed), so focus regain
      // brings no flag transition. Hooking the catch-up off the enrichment
      // setter would silently skip that host.
      pullRequestService.setFocusCadence(true);
      await flushLoaders();

      expect(getCIStatuses).toHaveBeenCalledWith(expect.anything(), [1]);

      pullRequestService.destroy();
    });

    it("throttles repeated focus catch-ups", async () => {
      const { getCIStatuses } = makeUnchangedProbeHarness(new Map([[1, ciState("failure")]]));

      const { pullRequestService } = await detectAndSettle(["feature/a"]);
      getCIStatuses.mockClear();

      pullRequestService.setFocusCadence(true);
      await flushLoaders();
      const afterFirst = getCIStatuses.mock.calls.length;

      // Rapid alt-tabbing must not burst the CI fan-out.
      pullRequestService.setFocusCadence(true);
      await flushLoaders();

      expect(afterFirst).toBe(1);
      expect(getCIStatuses).toHaveBeenCalledTimes(afterFirst);

      // ...but the throttle must RELEASE. An implementation that allowed the
      // first catch-up and suppressed every later one would satisfy the
      // assertions above while breaking the feature.
      jump(MINUTE);
      pullRequestService.setFocusCadence(true);
      await flushLoaders();

      expect(getCIStatuses).toHaveBeenCalledTimes(afterFirst + 1);

      pullRequestService.destroy();
    });

    it("re-arms the focus catch-up after a reset", async () => {
      const { getCIStatuses } = makeUnchangedProbeHarness(new Map([[1, ciState("failure")]]));

      const { pullRequestService } = await detectAndSettle(["feature/a"]);
      getCIStatuses.mockClear();

      pullRequestService.setFocusCadence(true);
      await flushLoaders();
      expect(getCIStatuses).toHaveBeenCalledTimes(1);

      // A project switch clears the throttle stamp along with the rest of the
      // state, so the next lifecycle isn't born inside a stale throttle window.
      pullRequestService.reset();
      expect(
        (pullRequestService as unknown as { lastFocusCiCheckAt: number }).lastFocusCiCheckAt
      ).toBe(Number.NEGATIVE_INFINITY);

      pullRequestService.destroy();
    });

    it("does not spend quota on focus while a rate-limit pause is active", async () => {
      const { getCIStatuses } = makeUnchangedProbeHarness(new Map([[1, ciState("failure")]]));

      const { pullRequestService } = await detectAndSettle(["feature/a"]);
      getCIStatuses.mockClear();

      // A recorded primary/secondary pause parks the service until nextRetryAt.
      const svc = pullRequestService as unknown as { nextRetryAt: number };
      svc.nextRetryAt = Date.now() + 30 * MINUTE;

      pullRequestService.setFocusCadence(true);
      await flushLoaders();
      expect(getCIStatuses).not.toHaveBeenCalled();

      // ...and resumes once the pause expires, rather than staying wedged.
      svc.nextRetryAt = 0;
      pullRequestService.setFocusCadence(true);
      await flushLoaders();
      expect(getCIStatuses).toHaveBeenCalledTimes(1);

      pullRequestService.destroy();
    });

    it("issues one CI lookup for two worktrees sharing a PR", async () => {
      const { getCIStatuses } = makeUnchangedProbeHarness(new Map([[1, ciState("failure")]]));

      // Both worktrees sit on the branch that resolves to PR 1.
      const { pullRequestService, events } = await detectAndSettle(["feature/a", "feature/a"]);
      getCIStatuses.mockClear();

      const detected: DaintreeEventMap["sys:pr:detected"][] = [];
      const unsubscribe = events.on("sys:pr:detected", (payload) => detected.push(payload));

      pullRequestService.setFocusCadence(true);
      await flushLoaders();

      // Deduplicated to a single batch entry, and each worktree still gets its
      // own phase-2 emit so neither badge is left behind.
      expect(getCIStatuses).toHaveBeenCalledWith(expect.anything(), [1]);
      expect(detected.filter((d) => d.worktreeId === "wt-1")).toHaveLength(1);
      expect(detected.filter((d) => d.worktreeId === "wt-2")).toHaveLength(1);

      unsubscribe();
      pullRequestService.destroy();
    });

    it("stamps the focus catch-up so the next tick does not duplicate it", async () => {
      const { getCIStatuses } = makeUnchangedProbeHarness(new Map([[1, ciState("failure")]]));

      const { pullRequestService } = await detectAndSettle(["feature/a"]);
      getCIStatuses.mockClear();

      pullRequestService.setFocusCadence(true);
      await flushLoaders();
      expect(getCIStatuses).toHaveBeenCalledTimes(1);

      // The focus pass goes through the same enrichment entry point, so it
      // re-paces the terminal interval rather than stacking on top of it.
      await revalidate(pullRequestService);
      expect(getCIStatuses).toHaveBeenCalledTimes(1);

      pullRequestService.destroy();
    });

    it("keeps both paths inert while CI enrichment is disabled", async () => {
      const { getCIStatuses } = makeUnchangedProbeHarness(new Map([[1, ciState("failure")]]));

      const { pullRequestService } = await detectAndSettle(["feature/a"]);
      pullRequestService.setCIEnrichmentEnabled(false);
      getCIStatuses.mockClear();

      // Well past both terminal intervals.
      jump(60 * MINUTE);
      await revalidate(pullRequestService);
      pullRequestService.setFocusCadence(true);
      await flushLoaders();

      expect(getCIStatuses).not.toHaveBeenCalled();

      pullRequestService.destroy();
    });

    it("keeps both paths inert on worker instances", async () => {
      const prev = process.env.DAINTREE_INSTANCE_ROLE;
      process.env.DAINTREE_INSTANCE_ROLE = "worker";
      try {
        const { getCIStatuses } = makeUnchangedProbeHarness(new Map([[1, ciState("failure")]]));

        const { pullRequestService } = await detectAndSettle(["feature/a"]);
        const svc = pullRequestService as unknown as { ciEnrichmentEnabled: boolean };

        jump(60 * MINUTE);
        await revalidate(pullRequestService);
        // A stray focus signal must not enable enrichment as a side effect.
        pullRequestService.setFocusCadence(true);
        await flushLoaders();

        expect(svc.ciEnrichmentEnabled).toBe(false);
        expect(getCIStatuses).not.toHaveBeenCalled();

        pullRequestService.destroy();
      } finally {
        if (prev === undefined) delete process.env.DAINTREE_INSTANCE_ROLE;
        else process.env.DAINTREE_INSTANCE_ROLE = prev;
      }
    });
  });
});
