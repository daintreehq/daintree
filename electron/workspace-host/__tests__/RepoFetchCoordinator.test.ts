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
    expect(result.lastFetchedAt).toBe(coord.getLastSuccessfulFetch("/repo/.git"));
    expect(result.authFailed).toBe(false);
  });

  it("passes --no-write-fetch-head to background fetches to avoid FETCH_HEAD contention", async () => {
    mockGetGitCommonDir.mockReturnValue("/repo/.git");
    const mockGit = makeMockGit(() => Promise.resolve());
    mockCreateBackgroundFetchGit.mockReturnValue(mockGit);

    const coord = new RepoFetchCoordinator();
    await coord.fetchForWorktree({
      worktreeId: "wt1",
      worktreePath: "/repo",
    });

    expect(mockGit.raw).toHaveBeenCalledTimes(1);
    const args = mockGit.raw.mock.calls[0][0];
    expect(args).toEqual(["fetch", "origin", "--no-auto-gc", "--prune", "--no-write-fetch-head"]);
  });

  it("propagates authFailed=true via FetchResult on auth-class failures and skips", async () => {
    mockGetGitCommonDir.mockReturnValue("/repo/.git");
    mockCreateBackgroundFetchGit.mockReturnValue(
      makeMockGit(() => Promise.reject(new Error("Authentication failed for 'https://x'")))
    );

    const coord = new RepoFetchCoordinator();
    const failed = await coord.fetchForWorktree({
      worktreeId: "wt1",
      worktreePath: "/repo",
    });
    expect(failed.status).toBe("failed");
    expect(failed.authFailed).toBe(true);
    expect(failed.lastFetchedAt).toBeNull();

    // Subsequent skip from auth suspension also carries authFailed=true so the
    // renderer keeps the "Sign in to refresh" affordance visible.
    const skipped = await coord.fetchForWorktree({
      worktreeId: "wt1",
      worktreePath: "/repo",
    });
    expect(skipped.status).toBe("skipped");
    expect(skipped.skipReason).toBe("auth-suspended");
    expect(skipped.authFailed).toBe(true);
  });

  it("preserves the prior lastFetchedAt across a transient failure", async () => {
    mockGetGitCommonDir.mockReturnValue("/repo/.git");
    // First call: success.
    mockCreateBackgroundFetchGit.mockReturnValueOnce(makeMockGit(() => Promise.resolve()));
    const coord = new RepoFetchCoordinator();
    const ok = await coord.fetchForWorktree({ worktreeId: "wt1", worktreePath: "/repo" });
    expect(ok.status).toBe("success");
    const firstTs = ok.lastFetchedAt;
    expect(firstTs).not.toBeNull();

    // Second call: transient fetch error. Advance past the recency window so
    // the call actually fetches instead of reusing the first success.
    vi.advanceTimersByTime(30_000);
    mockCreateBackgroundFetchGit.mockReturnValueOnce(
      makeMockGit(() => Promise.reject(new Error("the remote end hung up unexpectedly")))
    );
    const failed = await coord.fetchForWorktree({ worktreeId: "wt1", worktreePath: "/repo" });
    expect(failed.status).toBe("failed");
    expect(failed.authFailed).toBe(false);
    expect(failed.lastFetchedAt).toBe(firstTs);
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

    // Failing fetches never record a success, so each queued sibling still
    // runs a real fetch — exercising the per-commondir chain itself.
    let inFlight = 0;
    let maxInFlight = 0;
    mockCreateBackgroundFetchGit.mockReturnValue(
      makeMockGit(async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await Promise.resolve();
        await Promise.resolve();
        inFlight--;
        throw new Error("the remote end hung up unexpectedly");
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

  it("dedups queued sibling fetches once the first one in the chain succeeds", async () => {
    mockGetGitCommonDir.mockReturnValue("/repo/.git");
    mockCreateBackgroundFetchGit.mockReturnValue(makeMockGit(() => Promise.resolve()));

    const onFetchSuccess = vi.fn();
    const coord = new RepoFetchCoordinator({ onFetchSuccess });
    const results = await Promise.all([
      coord.fetchForWorktree({ worktreeId: "wtA", worktreePath: "/repo/a" }),
      coord.fetchForWorktree({ worktreeId: "wtB", worktreePath: "/repo/b" }),
      coord.fetchForWorktree({ worktreeId: "wtC", worktreePath: "/repo/c" }),
    ]);

    expect(mockCreateBackgroundFetchGit).toHaveBeenCalledTimes(1);
    expect(results.map((r) => r.status)).toEqual(["success", "success", "success"]);
    const stamps = new Set(results.map((r) => r.lastFetchedAt));
    expect(stamps.size).toBe(1);
    expect(onFetchSuccess).toHaveBeenCalledTimes(1);
    expect(onFetchSuccess).toHaveBeenCalledWith("wtA");
  });

  it("skips a fetch inside the recency window and runs a real one after it elapses", async () => {
    mockGetGitCommonDir.mockReturnValue("/repo/.git");
    mockCreateBackgroundFetchGit.mockReturnValue(makeMockGit(() => Promise.resolve()));

    const coord = new RepoFetchCoordinator();
    const first = await coord.fetchForWorktree({ worktreeId: "wt1", worktreePath: "/repo" });
    expect(first.status).toBe("success");

    mockCreateBackgroundFetchGit.mockClear();
    const within = await coord.fetchForWorktree({ worktreeId: "wt2", worktreePath: "/repo" });
    expect(within.status).toBe("success");
    expect(within.lastFetchedAt).toBe(first.lastFetchedAt);
    expect(mockCreateBackgroundFetchGit).not.toHaveBeenCalled();

    vi.advanceTimersByTime(16_000);
    const after = await coord.fetchForWorktree({ worktreeId: "wt2", worktreePath: "/repo" });
    expect(after.status).toBe("success");
    expect(mockCreateBackgroundFetchGit).toHaveBeenCalledTimes(1);
  });

  it("applies a short recency window to force fetches (wake storm)", async () => {
    mockGetGitCommonDir.mockReturnValue("/repo/.git");
    mockCreateBackgroundFetchGit.mockReturnValue(makeMockGit(() => Promise.resolve()));

    const coord = new RepoFetchCoordinator();
    const first = await coord.fetchForWorktree({
      worktreeId: "wt1",
      worktreePath: "/repo",
      force: true,
    });
    expect(first.status).toBe("success");

    mockCreateBackgroundFetchGit.mockClear();
    const within = await coord.fetchForWorktree({
      worktreeId: "wt2",
      worktreePath: "/repo",
      force: true,
    });
    expect(within.status).toBe("success");
    expect(within.lastFetchedAt).toBe(first.lastFetchedAt);
    expect(mockCreateBackgroundFetchGit).not.toHaveBeenCalled();

    vi.advanceTimersByTime(6_000);
    const after = await coord.fetchForWorktree({
      worktreeId: "wt2",
      worktreePath: "/repo",
      force: true,
    });
    expect(after.status).toBe("success");
    expect(mockCreateBackgroundFetchGit).toHaveBeenCalledTimes(1);
  });

  it("never serves the recency skip over a cached failure", async () => {
    mockGetGitCommonDir.mockReturnValue("/repo/.git");
    let attempt = 0;
    mockCreateBackgroundFetchGit.mockReturnValue(
      makeMockGit(() => {
        attempt++;
        if (attempt === 1) return Promise.resolve();
        return Promise.reject(new Error("Could not resolve host: github.com"));
      })
    );

    const coord = new RepoFetchCoordinator();
    await coord.fetchForWorktree({ worktreeId: "wt1", worktreePath: "/repo" });
    vi.advanceTimersByTime(6_000);
    const failed = await coord.fetchForWorktree({
      worktreeId: "wt1",
      worktreePath: "/repo",
      force: true,
    });
    expect(failed.status).toBe("failed");

    const blocked = await coord.fetchForWorktree({ worktreeId: "wt1", worktreePath: "/repo" });
    expect(blocked.status).toBe("skipped");
    expect(blocked.skipReason).toBe("in-failure-window");
    expect(blocked.networkFailed).toBe(true);
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

    // Second fetch (past the recency window) fails with 404 — now treated as
    // auth-failed.
    vi.advanceTimersByTime(30_000);
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

  it("classifies native AbortError (name === 'AbortError') as transient", async () => {
    mockGetGitCommonDir.mockReturnValue("/repo/.git");
    const abortError = new Error("The operation was aborted");
    (abortError as { name?: string }).name = "AbortError";
    mockCreateBackgroundFetchGit.mockReturnValue(makeMockGit(() => Promise.reject(abortError)));

    const coord = new RepoFetchCoordinator();
    const result = await coord.fetchForWorktree({
      worktreeId: "wt1",
      worktreePath: "/repo",
    });

    expect(result.status).toBe("failed");
    // classifyGitError returns "unknown" for this message, but isAbortError
    // catches it by name and routes it to transient.
    expect(result.networkFailed).toBe(true);
    expect(result.authFailed).toBe(false);
    expect(coord.hasFailureFor("/repo/.git")).toBe(true);

    // clearNetworkFailures clears transient; clearAuthFailures does not.
    coord.clearAuthFailures();
    expect(coord.hasFailureFor("/repo/.git")).toBe(true);

    coord.clearNetworkFailures();
    expect(coord.hasFailureFor("/repo/.git")).toBe(false);
  });

  it("classifies simple-git wrapped abort (name='GitError' with abort message) as transient", async () => {
    mockGetGitCommonDir.mockReturnValue("/repo/.git");
    // simple-git wraps the underlying AbortError in a GitError — the name
    // changes but the abort indicators stay in the message.
    const gitError = new Error("the operation was aborted");
    (gitError as { name?: string }).name = "GitError";
    mockCreateBackgroundFetchGit.mockReturnValue(makeMockGit(() => Promise.reject(gitError)));

    const coord = new RepoFetchCoordinator();
    const result = await coord.fetchForWorktree({
      worktreeId: "wt1",
      worktreePath: "/repo",
    });

    expect(result.status).toBe("failed");
    expect(result.networkFailed).toBe(true);
    expect(result.authFailed).toBe(false);
    expect(coord.hasFailureFor("/repo/.git")).toBe(true);

    // clearAuthFailures should not clear abort-classified transient failures
    coord.clearAuthFailures();
    expect(coord.hasFailureFor("/repo/.git")).toBe(true);

    coord.clearNetworkFailures();
    expect(coord.hasFailureFor("/repo/.git")).toBe(false);
  });

  it("does not classify a generic Error with 'abort' in message as abort", async () => {
    mockGetGitCommonDir.mockReturnValue("/repo/.git");
    // A plain Error with name="Error" and "abort" in the message should NOT
    // match isAbortError — the message fallback only applies to GitError
    // wrappers, not arbitrary Error objects.
    const genericError = new Error("some irrelevant abort message");
    mockCreateBackgroundFetchGit.mockReturnValue(makeMockGit(() => Promise.reject(genericError)));

    const coord = new RepoFetchCoordinator();
    // Verify directly through the private method.
    expect((coord as any).isAbortError(genericError)).toBe(false);

    const result = await coord.fetchForWorktree({
      worktreeId: "wt1",
      worktreePath: "/repo",
    });

    expect(result.status).toBe("failed");
    // Falls through to the generic transient path (no auth or network match).
    expect(result.networkFailed).toBe(true);
    expect(result.authFailed).toBe(false);
    expect(coord.hasFailureFor("/repo/.git")).toBe(true);
  });
});
