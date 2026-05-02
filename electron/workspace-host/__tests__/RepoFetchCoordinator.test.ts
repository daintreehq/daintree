import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockGetGitCommonDir = vi.fn();
const mockCreateBackgroundFetchGit = vi.fn();

vi.mock("../../utils/gitUtils.js", () => ({
  getGitCommonDir: (...args: unknown[]) => mockGetGitCommonDir(...args),
  // Other exports referenced by the coordinator's import surface but not used.
  getGitDir: vi.fn().mockReturnValue(null),
  clearGitDirCache: vi.fn(),
  clearGitCommonDirCache: vi.fn(),
}));

vi.mock("../../utils/hardenedGit.js", () => ({
  createBackgroundFetchGit: (...args: unknown[]) => mockCreateBackgroundFetchGit(...args),
}));

import { RepoFetchCoordinator } from "../RepoFetchCoordinator.js";

interface MockGit {
  raw: ReturnType<typeof vi.fn>;
}

function makeMockGit(rawImpl: () => Promise<unknown>): MockGit {
  return { raw: vi.fn().mockImplementation(rawImpl) };
}

describe("RepoFetchCoordinator", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns success on a clean fetch and records lastSuccessfulFetch", async () => {
    mockGetGitCommonDir.mockReturnValue("/repo/.git");
    mockCreateBackgroundFetchGit.mockReturnValue(makeMockGit(() => Promise.resolve()));

    const onFetchSuccess = vi.fn();
    const coord = new RepoFetchCoordinator({ onFetchSuccess });

    const result = await coord.fetchForWorktree({
      worktreeId: "wt1",
      worktreePath: "/repo",
    });

    expect(result.status).toBe("success");
    expect(onFetchSuccess).toHaveBeenCalledWith("wt1");
    expect(coord.getLastSuccessfulFetch("/repo/.git")).not.toBeNull();
  });

  it("skips when commondir cannot be resolved", async () => {
    mockGetGitCommonDir.mockReturnValue(null);

    const coord = new RepoFetchCoordinator();
    const result = await coord.fetchForWorktree({
      worktreeId: "wt1",
      worktreePath: "/no/such/repo",
    });

    expect(result.status).toBe("skipped");
    expect(result.skipReason).toBe("no-common-dir");
    expect(mockCreateBackgroundFetchGit).not.toHaveBeenCalled();
  });

  it("serializes fetches for sibling worktrees sharing a commondir", async () => {
    mockGetGitCommonDir.mockReturnValue("/repo/.git");

    let inFlight = 0;
    let maxInFlight = 0;
    mockCreateBackgroundFetchGit.mockReturnValue(
      makeMockGit(async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await Promise.resolve();
        await Promise.resolve();
        inFlight--;
      })
    );

    const coord = new RepoFetchCoordinator();
    const a = coord.fetchForWorktree({ worktreeId: "wtA", worktreePath: "/repo/a" });
    const b = coord.fetchForWorktree({ worktreeId: "wtB", worktreePath: "/repo/b" });
    const c = coord.fetchForWorktree({ worktreeId: "wtC", worktreePath: "/repo/c" });

    await Promise.all([a, b, c]);

    expect(maxInFlight).toBe(1);
    expect(mockCreateBackgroundFetchGit).toHaveBeenCalledTimes(3);
  });

  it("allows concurrent fetches for distinct commondirs", async () => {
    let invocations = 0;
    mockGetGitCommonDir.mockImplementation((path: string) => `${path}/.git`);
    let inFlight = 0;
    let maxInFlight = 0;
    mockCreateBackgroundFetchGit.mockReturnValue(
      makeMockGit(async () => {
        invocations++;
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await Promise.resolve();
        await Promise.resolve();
        inFlight--;
      })
    );

    const coord = new RepoFetchCoordinator();
    const a = coord.fetchForWorktree({ worktreeId: "wtA", worktreePath: "/repoA" });
    const b = coord.fetchForWorktree({ worktreeId: "wtB", worktreePath: "/repoB" });

    await Promise.all([a, b]);

    expect(invocations).toBe(2);
    expect(maxInFlight).toBeGreaterThan(1);
  });

  it("classifies auth failures and suspends future fetches indefinitely", async () => {
    mockGetGitCommonDir.mockReturnValue("/repo/.git");
    mockCreateBackgroundFetchGit.mockReturnValue(
      makeMockGit(() =>
        Promise.reject(new Error("Authentication failed for 'https://example.com'"))
      )
    );

    const coord = new RepoFetchCoordinator();
    const first = await coord.fetchForWorktree({
      worktreeId: "wt1",
      worktreePath: "/repo",
    });
    expect(first.status).toBe("failed");
    expect(first.reason).toBe("auth-failed");
    expect(coord.hasFailureFor("/repo/.git")).toBe(true);

    // Second attempt should skip without invoking git.
    mockCreateBackgroundFetchGit.mockClear();
    const second = await coord.fetchForWorktree({
      worktreeId: "wt1",
      worktreePath: "/repo",
    });
    expect(second.status).toBe("skipped");
    expect(second.skipReason).toBe("auth-suspended");
    expect(mockCreateBackgroundFetchGit).not.toHaveBeenCalled();
  });

  it("clears auth suspensions on demand", async () => {
    mockGetGitCommonDir.mockReturnValue("/repo/.git");
    mockCreateBackgroundFetchGit.mockReturnValue(
      makeMockGit(() => Promise.reject(new Error("Authentication failed")))
    );

    const coord = new RepoFetchCoordinator();
    await coord.fetchForWorktree({ worktreeId: "wt1", worktreePath: "/repo" });
    expect(coord.hasFailureFor("/repo/.git")).toBe(true);

    coord.clearAuthFailures();
    expect(coord.hasFailureFor("/repo/.git")).toBe(false);
  });

  it("classifies network failures with a short retry window", async () => {
    mockGetGitCommonDir.mockReturnValue("/repo/.git");
    mockCreateBackgroundFetchGit.mockReturnValue(
      makeMockGit(() =>
        Promise.reject(
          new Error(
            "fatal: unable to access 'https://github.com/x.git/': Could not resolve host: github.com"
          )
        )
      )
    );

    const coord = new RepoFetchCoordinator();
    const result = await coord.fetchForWorktree({
      worktreeId: "wt1",
      worktreePath: "/repo",
    });
    expect(result.reason).toBe("network-unavailable");

    // Within the network failure TTL, subsequent attempts skip.
    mockCreateBackgroundFetchGit.mockClear();
    const blocked = await coord.fetchForWorktree({
      worktreeId: "wt1",
      worktreePath: "/repo",
    });
    expect(blocked.status).toBe("skipped");
    expect(blocked.skipReason).toBe("in-failure-window");
  });

  it("clears network failures on demand (wake hook)", async () => {
    mockGetGitCommonDir.mockReturnValue("/repo/.git");
    mockCreateBackgroundFetchGit.mockReturnValue(
      makeMockGit(() => Promise.reject(new Error("Could not resolve host: github.com")))
    );

    const coord = new RepoFetchCoordinator();
    await coord.fetchForWorktree({ worktreeId: "wt1", worktreePath: "/repo" });
    expect(coord.hasFailureFor("/repo/.git")).toBe(true);

    coord.clearNetworkFailures();
    expect(coord.hasFailureFor("/repo/.git")).toBe(false);
  });

  it("treats repo-not-found AFTER a prior success as auth-failed (404 masking)", async () => {
    mockGetGitCommonDir.mockReturnValue("/repo/.git");
    let attempt = 0;
    mockCreateBackgroundFetchGit.mockReturnValue(
      makeMockGit(() => {
        attempt++;
        if (attempt === 1) return Promise.resolve();
        return Promise.reject(new Error("ERROR: Repository not found."));
      })
    );

    const coord = new RepoFetchCoordinator();
    // First fetch succeeds.
    await coord.fetchForWorktree({ worktreeId: "wt1", worktreePath: "/repo" });
    expect(coord.getLastSuccessfulFetch("/repo/.git")).not.toBeNull();

    // Second fetch fails with 404 — now treated as auth-failed.
    const second = await coord.fetchForWorktree({
      worktreeId: "wt1",
      worktreePath: "/repo",
    });
    expect(second.status).toBe("failed");
    expect(second.reason).toBe("repository-not-found");

    // clearNetworkFailures should NOT clear it — auth-suspensions stay.
    coord.clearNetworkFailures();
    expect(coord.hasFailureFor("/repo/.git")).toBe(true);

    // clearAuthFailures should clear it.
    coord.clearAuthFailures();
    expect(coord.hasFailureFor("/repo/.git")).toBe(false);
  });

  it("treats first-fetch repo-not-found as a short retry window (typo / race)", async () => {
    mockGetGitCommonDir.mockReturnValue("/repo/.git");
    mockCreateBackgroundFetchGit.mockReturnValue(
      makeMockGit(() => Promise.reject(new Error("ERROR: Repository not found.")))
    );

    const coord = new RepoFetchCoordinator();
    await coord.fetchForWorktree({ worktreeId: "wt1", worktreePath: "/repo" });
    expect(coord.hasFailureFor("/repo/.git")).toBe(true);

    // clearAuthFailures must NOT clear it — first-fetch 404 is not auth.
    coord.clearAuthFailures();
    expect(coord.hasFailureFor("/repo/.git")).toBe(true);
  });

  it("force=true bypasses the failure cache", async () => {
    mockGetGitCommonDir.mockReturnValue("/repo/.git");
    let attempt = 0;
    mockCreateBackgroundFetchGit.mockReturnValue(
      makeMockGit(() => {
        attempt++;
        if (attempt === 1) return Promise.reject(new Error("Could not resolve host"));
        return Promise.resolve();
      })
    );

    const coord = new RepoFetchCoordinator();
    await coord.fetchForWorktree({ worktreeId: "wt1", worktreePath: "/repo" });
    expect(coord.hasFailureFor("/repo/.git")).toBe(true);

    // Without force, would skip; with force, retries and succeeds.
    const result = await coord.fetchForWorktree({
      worktreeId: "wt1",
      worktreePath: "/repo",
      force: true,
    });
    expect(result.status).toBe("success");
    expect(coord.hasFailureFor("/repo/.git")).toBe(false);
  });

  it("destroy() isolates generations across same-repo re-entry", async () => {
    mockGetGitCommonDir.mockReturnValue("/repo/.git");
    let resolveFirst: (() => void) | undefined;
    let rawCalls = 0;
    mockCreateBackgroundFetchGit.mockReturnValue(
      makeMockGit(() => {
        rawCalls++;
        if (rawCalls === 1) {
          return new Promise<void>((res) => {
            resolveFirst = res;
          });
        }
        return Promise.resolve();
      })
    );

    const onFetchSuccess = vi.fn();
    const coord = new RepoFetchCoordinator({ onFetchSuccess });

    // First fetch: starts but doesn't resolve.
    const inFlight = coord.fetchForWorktree({
      worktreeId: "wtA",
      worktreePath: "/repo",
    });
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(resolveFirst).toBeDefined();

    // Project switch: destroy + reopen same repo path.
    coord.destroy();
    const second = await coord.fetchForWorktree({
      worktreeId: "wtB",
      worktreePath: "/repo",
    });
    expect(second.status).toBe("success");
    // onFetchSuccess fired exactly once for wtB; not for wtA.
    expect(onFetchSuccess).toHaveBeenCalledTimes(1);
    expect(onFetchSuccess).toHaveBeenCalledWith("wtB");

    // Now resolve the original fetch — its completion must NOT fire onFetchSuccess
    // for wtA, because its captured generation is older than the post-destroy
    // baseline assigned to the new state.
    resolveFirst?.();
    await inFlight;
    expect(onFetchSuccess).toHaveBeenCalledTimes(1);
  });

  it("destroy() bumps the generation so in-flight completions are discarded", async () => {
    mockGetGitCommonDir.mockReturnValue("/repo/.git");
    let resolveFetch: (() => void) | undefined;
    mockCreateBackgroundFetchGit.mockReturnValue(
      makeMockGit(
        () =>
          new Promise<void>((res) => {
            resolveFetch = res;
          })
      )
    );

    const onFetchSuccess = vi.fn();
    const coord = new RepoFetchCoordinator({ onFetchSuccess });

    const inFlight = coord.fetchForWorktree({
      worktreeId: "wt1",
      worktreePath: "/repo",
    });

    // Drain microtasks so runFetch starts and captures resolveFetch.
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(resolveFetch).toBeDefined();

    // Tear down before the fetch completes, then resolve.
    coord.destroy();
    resolveFetch?.();

    const result = await inFlight;
    expect(result.status).toBe("skipped");
    expect(result.skipReason).toBe("stale-generation");
    expect(onFetchSuccess).not.toHaveBeenCalled();
  });
});
