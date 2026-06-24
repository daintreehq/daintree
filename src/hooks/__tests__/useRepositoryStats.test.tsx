// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ForgeRepositoryStats } from "@shared/types/ipc/forge";

const PROVIDER_ID = "test.forge.provider";

const {
  getCurrentMock,
  onSwitchMock,
  getRepoStatsMock,
  getFirstPageCacheMock,
  onRateLimitChangedMock,
  onRepoStatsAndPageUpdatedMock,
  onRepoCountsUpdatedMock,
} = vi.hoisted(() => ({
  getCurrentMock: vi.fn(),
  onSwitchMock: vi.fn(),
  getRepoStatsMock: vi.fn(),
  getFirstPageCacheMock: vi.fn().mockResolvedValue(null),
  onRateLimitChangedMock: vi.fn<(cb: (payload: unknown) => void) => () => void>(() => () => {}),
  onRepoStatsAndPageUpdatedMock: vi.fn<(cb: (payload: unknown) => void) => () => void>(
    () => () => {}
  ),
  onRepoCountsUpdatedMock: vi.fn<(cb: (payload: unknown) => void) => () => void>(() => () => {}),
}));

vi.mock("@/clients", () => ({
  projectClient: {
    getCurrent: getCurrentMock,
    onSwitch: onSwitchMock,
  },
}));

vi.mock("@/clients/forgeClient", () => ({
  forgeClient: {
    getRepoStats: getRepoStatsMock,
    getFirstPageCache: getFirstPageCacheMock,
    onRateLimitChanged: onRateLimitChangedMock,
    onRepoStatsAndPageUpdated: onRepoStatsAndPageUpdatedMock,
    onRepoCountsUpdated: onRepoCountsUpdatedMock,
  },
}));

vi.mock("@/store/projectStore", () => ({
  useProjectStore: (selector: (s: { currentProject: { id: string } | null }) => unknown) =>
    selector({ currentProject: { id: "test-project" } }),
}));

vi.mock("@/hooks/useResolvedForgeProvider", () => ({
  useResolvedForgeProvider: () => ({
    entry: { pluginId: "test.forge", contribution: { id: "provider", name: "Test Forge" } },
    providerId: "test.forge.provider",
    resolvedVia: "hostname",
    loading: false,
    refresh: () => {},
  }),
}));

import {
  useRepositoryStats,
  FRESH_THRESHOLD_MS,
  _resetSwitchBackCacheForTests,
} from "../useRepositoryStats";
import { _resetPollingLifecycleForTests } from "../usePollingLifecycle";
import { useSystemWakeStore } from "@/store/systemWakeStore";
import {
  _resetForTests as resetForgeResourceCache,
  buildCacheKey,
  getCache,
  setCache,
} from "@/lib/forgeResourceCache";
import type { Issue, PR } from "@shared/types/forge";

function createDeferred<T>() {
  let resolve: (value: T) => void;
  let reject: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve: resolve!, reject: reject! };
}

describe("useRepositoryStats", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetPollingLifecycleForTests();
    _resetSwitchBackCacheForTests();
    useSystemWakeStore.setState({
      wakeEpoch: 0,
      lastSleepDuration: 0,
      isWakeRevalidating: false,
    });
  });

  it("force-fetches when daintree:refresh-sidebar event is dispatched", async () => {
    const project = { id: "project-a", path: "/repo/a" };
    getCurrentMock.mockResolvedValue(project);
    onSwitchMock.mockReturnValue(() => {});

    const stats: ForgeRepositoryStats = {
      commitCount: 5,
      issueCount: 2,
      prCount: 1,
      loading: false,
      stale: false,
      lastUpdated: 1000,
    };
    getRepoStatsMock.mockResolvedValue(stats);

    renderHook(() => useRepositoryStats());

    await waitFor(() => {
      expect(getRepoStatsMock).toHaveBeenCalledTimes(1);
    });

    await act(async () => {
      window.dispatchEvent(new CustomEvent("daintree:refresh-sidebar"));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(getRepoStatsMock).toHaveBeenCalledTimes(2);
      expect(getRepoStatsMock.mock.calls[1]?.[1]).toBe(true);
    });
  });

  describe("isTokenError", () => {
    const tokenErrorMessages = [
      "GitHub token not configured. Set it in Settings.",
      "Invalid GitHub token",
      "Token lacks required permissions",
      "SSO authorization required for this organization",
    ];

    it.each(tokenErrorMessages)("returns isTokenError=true for error: %s", async (errorMsg) => {
      getCurrentMock.mockResolvedValue({ id: "p", path: "/repo" });
      onSwitchMock.mockReturnValue(() => {});
      getRepoStatsMock.mockResolvedValue({
        commitCount: 0,
        issueCount: 0,
        prCount: 0,
        loading: false,
        stale: false,
        lastUpdated: null,
        error: errorMsg,
      });

      const { result } = renderHook(() => useRepositoryStats());

      await waitFor(() => {
        expect(result.current.isTokenError).toBe(true);
        expect(result.current.error).toBe(errorMsg);
      });
    });

    it("returns isTokenError=false for non-token errors", async () => {
      getCurrentMock.mockResolvedValue({ id: "p", path: "/repo" });
      onSwitchMock.mockReturnValue(() => {});
      getRepoStatsMock.mockResolvedValue({
        commitCount: 0,
        issueCount: 0,
        prCount: 0,
        loading: false,
        stale: false,
        lastUpdated: null,
        error: "Network timeout",
      });

      const { result } = renderHook(() => useRepositoryStats());

      await waitFor(() => {
        expect(result.current.isTokenError).toBe(false);
        expect(result.current.error).toBe("Network timeout");
      });
    });

    it("resets isTokenError when error clears on successful fetch", async () => {
      getCurrentMock.mockResolvedValue({ id: "p", path: "/repo" });
      onSwitchMock.mockReturnValue(() => {});
      getRepoStatsMock.mockResolvedValueOnce({
        commitCount: 0,
        issueCount: 0,
        prCount: 0,
        loading: false,
        stale: false,
        lastUpdated: null,
        error: "GitHub token not configured. Set it in Settings.",
      });

      const { result } = renderHook(() => useRepositoryStats());

      await waitFor(() => {
        expect(result.current.isTokenError).toBe(true);
      });

      getRepoStatsMock.mockResolvedValueOnce({
        commitCount: 5,
        issueCount: 2,
        prCount: 1,
        loading: false,
        stale: false,
        lastUpdated: 2000,
      });

      await act(async () => {
        await result.current.refresh({ force: true });
      });

      await waitFor(() => {
        expect(result.current.isTokenError).toBe(false);
        expect(result.current.error).toBeNull();
      });
    });

    it("clears isTokenError when daintree:refresh-sidebar triggers a successful refetch", async () => {
      getCurrentMock.mockResolvedValue({ id: "p", path: "/repo" });
      onSwitchMock.mockReturnValue(() => {});
      getRepoStatsMock.mockResolvedValueOnce({
        commitCount: 0,
        issueCount: 0,
        prCount: 0,
        loading: false,
        stale: false,
        lastUpdated: null,
        error: "GitHub token not configured. Set it in Settings.",
      });

      const { result } = renderHook(() => useRepositoryStats());

      await waitFor(() => {
        expect(result.current.isTokenError).toBe(true);
        expect(result.current.error).toBe("GitHub token not configured. Set it in Settings.");
      });

      getRepoStatsMock.mockResolvedValueOnce({
        commitCount: 5,
        issueCount: 2,
        prCount: 1,
        loading: false,
        stale: false,
        lastUpdated: 2000,
      });

      await act(async () => {
        window.dispatchEvent(new CustomEvent("daintree:refresh-sidebar"));
        await Promise.resolve();
      });

      await waitFor(() => {
        expect(getRepoStatsMock).toHaveBeenCalledTimes(2);
        expect(getRepoStatsMock.mock.calls[1]?.[1]).toBe(true);
        expect(result.current.isTokenError).toBe(false);
        expect(result.current.error).toBeNull();
      });
    });
  });

  it("queues a refetch on project switch when an earlier fetch is still in flight", async () => {
    let currentProject = { id: "project-a", path: "/repo/a" };
    getCurrentMock.mockImplementation(async () => currentProject);

    let switchHandler: (() => void) | undefined;
    onSwitchMock.mockImplementation((callback: () => void) => {
      switchHandler = callback;
      return () => {};
    });

    const slowA = createDeferred<ForgeRepositoryStats>();
    const statsA: ForgeRepositoryStats = {
      commitCount: 10,
      issueCount: 1,
      prCount: 1,
      loading: false,
      stale: false,
      lastUpdated: 1000,
    };
    const statsB: ForgeRepositoryStats = {
      commitCount: 77,
      issueCount: 2,
      prCount: 3,
      loading: false,
      stale: false,
      lastUpdated: 2000,
    };

    getRepoStatsMock.mockImplementationOnce(() => slowA.promise).mockResolvedValueOnce(statsB);

    const { result } = renderHook(() => useRepositoryStats());

    await waitFor(() => {
      expect(getRepoStatsMock).toHaveBeenCalledTimes(1);
      expect(getRepoStatsMock.mock.calls[0]?.[0]).toBe("/repo/a");
    });

    currentProject = { id: "project-b", path: "/repo/b" };
    act(() => {
      switchHandler?.();
    });

    await act(async () => {
      slowA.resolve(statsA);
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(getRepoStatsMock).toHaveBeenCalledTimes(2);
      expect(getRepoStatsMock.mock.calls[1]?.[0]).toBe("/repo/b");
      expect(result.current.stats?.commitCount).toBe(77);
    });
  });

  describe("cross-project guard + switch-back reuse (issue #10761)", () => {
    function freshStats(overrides: Partial<ForgeRepositoryStats>): ForgeRepositoryStats {
      return {
        commitCount: 0,
        issueCount: 0,
        prCount: 0,
        loading: false,
        stale: false,
        lastUpdated: Date.now(),
        ...overrides,
      };
    }

    // The polling lifecycle serializes fetches: a switch while a fetch is in
    // flight queues the next fetch (rather than running concurrently), so the
    // previous project's request resolves first and must bail before applying.
    it("does not leak an in-flight previous-project error onto the new project", async () => {
      let currentProject = { id: "a", path: "/repo/a" };
      getCurrentMock.mockImplementation(async () => currentProject);
      let switchHandler: (() => void) | undefined;
      onSwitchMock.mockImplementation((cb: () => void) => {
        switchHandler = cb;
        return () => {};
      });

      const slowA = createDeferred<ForgeRepositoryStats>();
      const statsB = freshStats({ commitCount: 22, issueCount: 2, prCount: 2 });
      getRepoStatsMock.mockImplementationOnce(() => slowA.promise).mockResolvedValueOnce(statsB);

      const { result } = renderHook(() => useRepositoryStats());
      await waitFor(() => expect(getRepoStatsMock).toHaveBeenCalledTimes(1));

      // Switch to B while A's fetch is still pending, then let A fail. A's
      // error must be discarded; the queued B fetch then loads cleanly.
      currentProject = { id: "b", path: "/repo/b" };
      act(() => {
        switchHandler?.();
      });
      await act(async () => {
        slowA.reject(new Error("Project A network failure"));
        await Promise.resolve();
      });

      await waitFor(() => {
        expect(getRepoStatsMock).toHaveBeenCalledTimes(2);
        expect(result.current.stats?.commitCount).toBe(22);
        expect(result.current.error).toBeNull();
        expect(result.current.freshnessLevel).not.toBe("errored");
      });
    });

    it("does not leak an in-flight previous-project success onto the new project", async () => {
      let currentProject = { id: "a", path: "/repo/a" };
      getCurrentMock.mockImplementation(async () => currentProject);
      let switchHandler: (() => void) | undefined;
      onSwitchMock.mockImplementation((cb: () => void) => {
        switchHandler = cb;
        return () => {};
      });

      const slowA = createDeferred<ForgeRepositoryStats>();
      const statsA = freshStats({ commitCount: 11, issueCount: 9, prCount: 9 });
      const statsB = freshStats({ commitCount: 22, issueCount: 2, prCount: 2 });
      getRepoStatsMock.mockImplementationOnce(() => slowA.promise).mockResolvedValueOnce(statsB);

      const { result } = renderHook(() => useRepositoryStats());
      await waitFor(() => expect(getRepoStatsMock).toHaveBeenCalledTimes(1));

      currentProject = { id: "b", path: "/repo/b" };
      act(() => {
        switchHandler?.();
      });
      await act(async () => {
        slowA.resolve(statsA);
        await Promise.resolve();
      });

      await waitFor(() => {
        expect(getRepoStatsMock).toHaveBeenCalledTimes(2);
        expect(result.current.stats?.commitCount).toBe(22);
      });
      // A's stale counts never surfaced on B.
      expect(result.current.stats?.issueCount).toBe(2);
    });

    it("restores cached stats without a skeleton when switching back within FRESH_THRESHOLD_MS", async () => {
      let currentProject = { id: "a", path: "/repo/a" };
      getCurrentMock.mockImplementation(async () => currentProject);
      let switchHandler: (() => void) | undefined;
      onSwitchMock.mockImplementation((cb: () => void) => {
        switchHandler = cb;
        return () => {};
      });

      const now = Date.now();
      const statsA = freshStats({ commitCount: 7, issueCount: 4, prCount: 3, lastUpdated: now });
      const statsB = freshStats({ commitCount: 12, issueCount: 1, prCount: 1, lastUpdated: now });
      const statsARevalidated = freshStats({
        commitCount: 8,
        issueCount: 5,
        prCount: 3,
        lastUpdated: now + 1,
      });
      // Hold the switch-back revalidation so the restored cache value is
      // observable before fresh data lands over it.
      const slowRevalidate = createDeferred<ForgeRepositoryStats>();

      getRepoStatsMock
        .mockResolvedValueOnce(statsA)
        .mockResolvedValueOnce(statsB)
        .mockImplementationOnce(() => slowRevalidate.promise);

      const { result } = renderHook(() => useRepositoryStats());
      await waitFor(() => expect(result.current.stats?.commitCount).toBe(7));

      currentProject = { id: "b", path: "/repo/b" };
      act(() => {
        switchHandler?.();
      });
      await waitFor(() => expect(result.current.stats?.commitCount).toBe(12));

      // Switch back to A within the freshness window — cached counts restore
      // immediately, the skeleton never shows, and a background revalidation
      // still fires.
      currentProject = { id: "a", path: "/repo/a" };
      act(() => {
        switchHandler?.();
      });
      await waitFor(() => {
        expect(result.current.stats?.commitCount).toBe(7);
        expect(result.current.loading).toBe(false);
      });
      expect(getRepoStatsMock).toHaveBeenCalledTimes(3);

      // The background revalidation converges to fresh data.
      await act(async () => {
        slowRevalidate.resolve(statsARevalidated);
        await Promise.resolve();
      });
      await waitFor(() => expect(result.current.stats?.commitCount).toBe(8));
    });

    it("does not reuse cached stats when switching back after FRESH_THRESHOLD_MS", async () => {
      let currentProject = { id: "a", path: "/repo/a" };
      getCurrentMock.mockImplementation(async () => currentProject);
      let switchHandler: (() => void) | undefined;
      onSwitchMock.mockImplementation((cb: () => void) => {
        switchHandler = cb;
        return () => {};
      });

      // A's stats are older than the fresh window (but still within aging, so
      // the entry survives eviction) — switch-back must not restore them.
      const staleAge = Date.now() - (FRESH_THRESHOLD_MS + 5_000);
      const statsA = freshStats({ commitCount: 7, lastUpdated: staleAge });
      const statsB = freshStats({ commitCount: 12 });
      const slowA2 = createDeferred<ForgeRepositoryStats>();

      getRepoStatsMock
        .mockResolvedValueOnce(statsA)
        .mockResolvedValueOnce(statsB)
        .mockImplementationOnce(() => slowA2.promise);

      const { result } = renderHook(() => useRepositoryStats());
      await waitFor(() => expect(result.current.stats?.commitCount).toBe(7));

      currentProject = { id: "b", path: "/repo/b" };
      act(() => {
        switchHandler?.();
      });
      await waitFor(() => expect(result.current.stats?.commitCount).toBe(12));

      // Switch back to A — its cache entry is past FRESH_THRESHOLD_MS, so the
      // hook clears to a skeleton and refetches.
      currentProject = { id: "a", path: "/repo/a" };
      act(() => {
        switchHandler?.();
      });
      await waitFor(() => {
        expect(result.current.stats).toBeNull();
        expect(result.current.loading).toBe(true);
      });

      await act(async () => {
        slowA2.resolve(freshStats({ commitCount: 9, issueCount: 4, prCount: 2 }));
        await Promise.resolve();
      });
      await waitFor(() => expect(result.current.stats?.commitCount).toBe(9));
    });

    it("never restores a previous error on switch-back (errors are not cached)", async () => {
      let currentProject = { id: "a", path: "/repo/a" };
      getCurrentMock.mockImplementation(async () => currentProject);
      let switchHandler: (() => void) | undefined;
      onSwitchMock.mockImplementation((cb: () => void) => {
        switchHandler = cb;
        return () => {};
      });

      const erroredA = freshStats({
        commitCount: 0,
        issueCount: null,
        prCount: null,
        stale: true,
        error: "Token expired",
      });
      const statsB = freshStats({ commitCount: 12 });
      const freshA = freshStats({ commitCount: 5, issueCount: 2, prCount: 1 });

      getRepoStatsMock
        .mockResolvedValueOnce(erroredA)
        .mockResolvedValueOnce(statsB)
        .mockResolvedValueOnce(freshA);

      const { result } = renderHook(() => useRepositoryStats());
      await waitFor(() => expect(result.current.error).toBe("Token expired"));

      currentProject = { id: "b", path: "/repo/b" };
      act(() => {
        switchHandler?.();
      });
      await waitFor(() => expect(result.current.stats?.commitCount).toBe(12));

      // Switch back to A — the errored result was never cached, so a fresh fetch
      // runs and the error does not reappear.
      currentProject = { id: "a", path: "/repo/a" };
      act(() => {
        switchHandler?.();
      });
      await waitFor(() => {
        expect(getRepoStatsMock).toHaveBeenCalledTimes(3);
        expect(result.current.stats?.commitCount).toBe(5);
        expect(result.current.error).toBeNull();
      });
    });

    it("evicts the oldest cache entry once the cap is exceeded", async () => {
      // Cap is 20 entries. Loading 21 distinct projects evicts the oldest
      // (smallest lastUpdated), so switching back to it can no longer restore
      // from cache and must refetch with a skeleton.
      let currentProject = { id: "p0", path: "/repo/p0" };
      getCurrentMock.mockImplementation(async () => currentProject);
      let switchHandler: (() => void) | undefined;
      onSwitchMock.mockImplementation((cb: () => void) => {
        switchHandler = cb;
        return () => {};
      });

      const base = Date.now();
      let tick = 0;
      getRepoStatsMock.mockImplementation(async () => {
        tick += 1;
        return freshStats({ commitCount: tick, lastUpdated: base + tick });
      });

      const { result } = renderHook(() => useRepositoryStats());
      await waitFor(() => expect(result.current.stats?.commitCount).toBe(1));

      // Load 20 more distinct projects (p1..p20) → 21 total, evicting p0.
      for (let i = 1; i <= 20; i++) {
        currentProject = { id: `p${i}`, path: `/repo/p${i}` };
        act(() => {
          switchHandler?.();
        });
        await waitFor(() => expect(result.current.stats?.commitCount).toBe(i + 1));
      }

      // Switch back to p0 — its entry was evicted, so it refetches with a
      // skeleton instead of restoring instantly.
      const slowP0 = createDeferred<ForgeRepositoryStats>();
      getRepoStatsMock.mockImplementationOnce(() => slowP0.promise);
      currentProject = { id: "p0", path: "/repo/p0" };
      act(() => {
        switchHandler?.();
      });
      await waitFor(() => {
        expect(result.current.stats).toBeNull();
        expect(result.current.loading).toBe(true);
      });

      await act(async () => {
        slowP0.resolve(freshStats({ commitCount: 999 }));
        await Promise.resolve();
      });
      await waitFor(() => expect(result.current.stats?.commitCount).toBe(999));
    });
  });

  describe("onRepoCountsUpdated push (issue #10122)", () => {
    function countsPayload(
      projectPath: string,
      stats: ForgeRepositoryStats,
      fetchedAt = Date.now()
    ) {
      return { providerId: PROVIDER_ID, projectPath, stats, fetchedAt };
    }

    it("applies count-only pushed stats for the current project", async () => {
      const project = { id: "p", path: "/repo/counts" };
      getCurrentMock.mockResolvedValue(project);
      onSwitchMock.mockReturnValue(() => {});
      getRepoStatsMock.mockResolvedValue({
        commitCount: 5,
        issueCount: 2,
        prCount: 1,
        loading: false,
        stale: false,
        lastUpdated: 1000,
      });

      let pushHandler: ((payload: unknown) => void) | undefined;
      onRepoCountsUpdatedMock.mockImplementation((cb: (p: unknown) => void) => {
        pushHandler = cb;
        return () => {};
      });

      const { result } = renderHook(() => useRepositoryStats());

      await waitFor(() => {
        expect(result.current.stats?.issueCount).toBe(2);
      });

      const pushedStats: ForgeRepositoryStats = {
        commitCount: 5,
        issueCount: 7,
        prCount: 3,
        loading: false,
        stale: false,
        lastUpdated: 2000,
      };
      await act(async () => {
        pushHandler?.(countsPayload(project.path, pushedStats, 2000));
        await Promise.resolve();
        await Promise.resolve();
      });

      await waitFor(() => {
        expect(result.current.stats?.issueCount).toBe(7);
        expect(result.current.stats?.prCount).toBe(3);
        expect(result.current.lastUpdated).toBe(2000);
      });
    });

    it("marks diverged open list entries stale on a count push without removing rows (count buster)", async () => {
      const project = { id: "p", path: "/repo/buster" };
      getCurrentMock.mockResolvedValue(project);
      onSwitchMock.mockReturnValue(() => {});
      getRepoStatsMock.mockResolvedValue({
        commitCount: 0,
        issueCount: 2,
        prCount: 3,
        loading: false,
        stale: false,
        lastUpdated: 1000,
      });

      let pushHandler: ((payload: unknown) => void) | undefined;
      onRepoCountsUpdatedMock.mockImplementation((cb: (p: unknown) => void) => {
        pushHandler = cb;
        return () => {};
      });

      const issuesKey = buildCacheKey(project.path, "issue", "open", "created");
      const prsKey = buildCacheKey(project.path, "pr", "open", "created");
      const row: Issue = {
        number: 1,
        title: "t",
        body: "",
        url: "",
        state: "open",
        rawState: "OPEN",
        author: { login: "u", avatarUrl: "", rawData: null },
        assignees: [],
        labels: [],
        commentCount: 0,
        createdAt: 0,
        updatedAt: 0,
        rawData: null,
      };
      setCache(issuesKey, {
        items: [row],
        nextCursor: null,
        hasMore: false,
        timestamp: Date.now(),
        countAtWrite: 2,
      });
      setCache(prsKey, {
        items: [row],
        nextCursor: null,
        hasMore: false,
        timestamp: Date.now(),
        countAtWrite: 3,
      });

      const { result } = renderHook(() => useRepositoryStats());
      await waitFor(() => {
        expect(result.current.stats?.issueCount).toBe(2);
      });

      // Issue count moved 2 → 7; PR count is unchanged at 3.
      await act(async () => {
        pushHandler?.(
          countsPayload(project.path, {
            commitCount: 0,
            issueCount: 7,
            prCount: 3,
            loading: false,
            stale: false,
            lastUpdated: 2000,
          })
        );
        await Promise.resolve();
        await Promise.resolve();
      });

      await waitFor(() => {
        expect(getCache(issuesKey)?.stale).toBe(true);
      });
      expect(getCache(issuesKey)?.items).toHaveLength(1);
      expect(getCache(prsKey)?.stale).toBeUndefined();
    });

    it("ignores count pushes for a different project", async () => {
      const project = { id: "p", path: "/repo/current" };
      getCurrentMock.mockResolvedValue(project);
      onSwitchMock.mockReturnValue(() => {});
      getRepoStatsMock.mockResolvedValue({
        commitCount: 5,
        issueCount: 2,
        prCount: 1,
        loading: false,
        stale: false,
        lastUpdated: 1000,
      });

      let pushHandler: ((payload: unknown) => void) | undefined;
      onRepoCountsUpdatedMock.mockImplementation((cb: (p: unknown) => void) => {
        pushHandler = cb;
        return () => {};
      });

      const { result } = renderHook(() => useRepositoryStats());

      await waitFor(() => {
        expect(result.current.stats?.issueCount).toBe(2);
      });

      await act(async () => {
        pushHandler?.(
          countsPayload("/repo/other", {
            commitCount: 0,
            issueCount: 99,
            prCount: 99,
            loading: false,
            stale: false,
            lastUpdated: 2000,
          })
        );
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(result.current.stats?.issueCount).toBe(2);
      expect(result.current.lastUpdated).toBe(1000);
    });

    it("skips a count push older than the last applied result", async () => {
      const project = { id: "p", path: "/repo/older" };
      getCurrentMock.mockResolvedValue(project);
      onSwitchMock.mockReturnValue(() => {});
      getRepoStatsMock.mockResolvedValue({
        commitCount: 5,
        issueCount: 4,
        prCount: 2,
        loading: false,
        stale: false,
        lastUpdated: 5000,
      });

      let pushHandler: ((payload: unknown) => void) | undefined;
      onRepoCountsUpdatedMock.mockImplementation((cb: (p: unknown) => void) => {
        pushHandler = cb;
        return () => {};
      });

      const { result } = renderHook(() => useRepositoryStats());

      await waitFor(() => {
        expect(result.current.stats?.issueCount).toBe(4);
      });

      await act(async () => {
        pushHandler?.(
          countsPayload(project.path, {
            commitCount: 5,
            issueCount: 1,
            prCount: 1,
            loading: false,
            stale: false,
            lastUpdated: 1000,
          })
        );
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(result.current.stats?.issueCount).toBe(4);
      expect(result.current.lastUpdated).toBe(5000);
    });
  });

  describe("onRepoStatsAndPageUpdated push", () => {
    beforeEach(() => {
      resetForgeResourceCache();
    });

    function makePushPayload(
      projectPath: string,
      stats: ForgeRepositoryStats,
      fetchedAt: number = Date.now()
    ) {
      return {
        providerId: PROVIDER_ID,
        projectPath,
        stats,
        issues: { items: [], endCursor: null, hasNextPage: false, totalCount: 0 },
        prs: { items: [], endCursor: null, hasNextPage: false, totalCount: 0 },
        fetchedAt,
      };
    }

    it("applies pushed stats to toolbar counts immediately without waiting for the next poll", async () => {
      const project = { id: "p", path: "/repo/push" };
      getCurrentMock.mockResolvedValue(project);
      onSwitchMock.mockReturnValue(() => {});
      // First poll lands a baseline so `lastUpdatedRef` is seeded.
      getRepoStatsMock.mockResolvedValue({
        commitCount: 5,
        issueCount: 0,
        prCount: 1,
        loading: false,
        stale: false,
        lastUpdated: 1000,
      });

      let pushHandler: ((payload: unknown) => void) | undefined;
      onRepoStatsAndPageUpdatedMock.mockImplementation((cb: (p: unknown) => void) => {
        pushHandler = cb;
        return () => {};
      });

      const { result } = renderHook(() => useRepositoryStats());

      await waitFor(() => {
        expect(result.current.stats?.prCount).toBe(1);
      });

      // Push a fresher payload — count drops to 0 (e.g. PR was merged).
      const pushedStats: ForgeRepositoryStats = {
        commitCount: 6,
        issueCount: 0,
        prCount: 0,
        loading: false,
        stale: false,
        lastUpdated: 2000,
      };
      await act(async () => {
        pushHandler?.(makePushPayload(project.path, pushedStats, 2000));
        await Promise.resolve();
        await Promise.resolve();
      });

      await waitFor(() => {
        expect(result.current.stats?.prCount).toBe(0);
        expect(result.current.stats?.commitCount).toBe(6);
        expect(result.current.lastUpdated).toBe(2000);
      });
    });

    it("ignores a push payload whose fetchedAt is older than the last applied result", async () => {
      const project = { id: "p", path: "/repo/stale" };
      getCurrentMock.mockResolvedValue(project);
      onSwitchMock.mockReturnValue(() => {});
      getRepoStatsMock.mockResolvedValue({
        commitCount: 10,
        issueCount: 3,
        prCount: 4,
        loading: false,
        stale: false,
        lastUpdated: 5000,
      });

      let pushHandler: ((payload: unknown) => void) | undefined;
      onRepoStatsAndPageUpdatedMock.mockImplementation((cb: (p: unknown) => void) => {
        pushHandler = cb;
        return () => {};
      });

      const { result } = renderHook(() => useRepositoryStats());

      await waitFor(() => {
        expect(result.current.stats?.prCount).toBe(4);
        expect(result.current.lastUpdated).toBe(5000);
      });

      // Older push must be ignored.
      const olderStats: ForgeRepositoryStats = {
        commitCount: 1,
        issueCount: 0,
        prCount: 0,
        loading: false,
        stale: false,
        lastUpdated: 1000,
      };
      await act(async () => {
        pushHandler?.(makePushPayload(project.path, olderStats, 1000));
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(result.current.stats?.prCount).toBe(4);
      expect(result.current.stats?.commitCount).toBe(10);
      expect(result.current.lastUpdated).toBe(5000);
    });

    it("preserves last known counts when a stale push payload arrives with 0 counts", async () => {
      const project = { id: "p", path: "/repo/preserve" };
      getCurrentMock.mockResolvedValue(project);
      onSwitchMock.mockReturnValue(() => {});
      // Fresh poll establishes a known good count of 2 PRs.
      getRepoStatsMock.mockResolvedValue({
        commitCount: 7,
        issueCount: 1,
        prCount: 2,
        loading: false,
        stale: false,
        lastUpdated: 1000,
      });

      let pushHandler: ((payload: unknown) => void) | undefined;
      onRepoStatsAndPageUpdatedMock.mockImplementation((cb: (p: unknown) => void) => {
        pushHandler = cb;
        return () => {};
      });

      const { result } = renderHook(() => useRepositoryStats());

      await waitFor(() => {
        expect(result.current.stats?.prCount).toBe(2);
      });

      // A fresher push lands but it's marked stale with 0 counts — should
      // preserve the last good prCount=2 instead of flashing 0.
      const stalePush: ForgeRepositoryStats = {
        commitCount: 7,
        issueCount: 0,
        prCount: 0,
        loading: false,
        stale: true,
        lastUpdated: 2000,
      };
      await act(async () => {
        pushHandler?.(makePushPayload(project.path, stalePush, 2000));
        await Promise.resolve();
        await Promise.resolve();
      });

      await waitFor(() => {
        expect(result.current.isStale).toBe(true);
        // Preserved counts shown despite the 0 in the payload.
        expect(result.current.stats?.prCount).toBe(2);
        expect(result.current.stats?.issueCount).toBe(1);
      });
    });

    it("preserves last known counts when a stale push payload arrives with null counts", async () => {
      const project = { id: "p", path: "/repo/preserve-null" };
      getCurrentMock.mockResolvedValue(project);
      onSwitchMock.mockReturnValue(() => {});
      // Fresh poll establishes known good counts: 3 issues, 2 PRs.
      getRepoStatsMock.mockResolvedValue({
        commitCount: 7,
        issueCount: 3,
        prCount: 2,
        loading: false,
        stale: false,
        lastUpdated: 1000,
      });

      let pushHandler: ((payload: unknown) => void) | undefined;
      onRepoStatsAndPageUpdatedMock.mockImplementation((cb: (p: unknown) => void) => {
        pushHandler = cb;
        return () => {};
      });

      const { result } = renderHook(() => useRepositoryStats());

      await waitFor(() => {
        expect(result.current.stats?.issueCount).toBe(3);
        expect(result.current.stats?.prCount).toBe(2);
      });

      // A failed poll surfaces null counts with an error — preserve the last
      // good counts instead of flashing a `—` dash in the toolbar badge.
      const failedPush: ForgeRepositoryStats = {
        commitCount: 7,
        issueCount: null,
        prCount: null,
        loading: false,
        stale: true,
        error: "rate limited",
        lastUpdated: 2000,
      };
      await act(async () => {
        pushHandler?.(makePushPayload(project.path, failedPush, 2000));
        await Promise.resolve();
        await Promise.resolve();
      });

      await waitFor(() => {
        expect(result.current.isStale).toBe(true);
        // Preserved counts shown despite the nulls in the payload.
        expect(result.current.stats?.issueCount).toBe(3);
        expect(result.current.stats?.prCount).toBe(2);
      });
    });

    it("preserves a confirmed 0 across a failed poll instead of flashing a dash", async () => {
      const project = { id: "p", path: "/repo/preserve-zero" };
      getCurrentMock.mockResolvedValue(project);
      onSwitchMock.mockReturnValue(() => {});

      let pushHandler: ((payload: unknown) => void) | undefined;
      onRepoStatsAndPageUpdatedMock.mockImplementation((cb: (p: unknown) => void) => {
        pushHandler = cb;
        return () => {};
      });

      // Fresh poll confirms the repo genuinely has 0 open issues and 0 PRs.
      getRepoStatsMock.mockResolvedValue({
        commitCount: 7,
        issueCount: 0,
        prCount: 0,
        loading: false,
        stale: false,
        lastUpdated: 1000,
      });

      const { result } = renderHook(() => useRepositoryStats());

      await waitFor(() => {
        expect(result.current.stats?.issueCount).toBe(0);
        expect(result.current.stats?.prCount).toBe(0);
      });

      // A failed poll surfaces null counts — the confirmed 0 must be preserved,
      // not replaced with a `—` dash.
      const failedPush: ForgeRepositoryStats = {
        commitCount: 7,
        issueCount: null,
        prCount: null,
        loading: false,
        stale: true,
        error: "timeout",
        lastUpdated: 2000,
      };
      await act(async () => {
        pushHandler?.(makePushPayload(project.path, failedPush, 2000));
        await Promise.resolve();
        await Promise.resolve();
      });

      await waitFor(() => {
        expect(result.current.isStale).toBe(true);
        expect(result.current.stats?.issueCount).toBe(0);
        expect(result.current.stats?.prCount).toBe(0);
      });
    });

    it("shows a genuine 0 from a fresh fetch instead of a preserved count", async () => {
      const project = { id: "p", path: "/repo/confirmed-zero" };
      getCurrentMock.mockResolvedValue(project);
      onSwitchMock.mockReturnValue(() => {});

      let pushHandler: ((payload: unknown) => void) | undefined;
      onRepoStatsAndPageUpdatedMock.mockImplementation((cb: (p: unknown) => void) => {
        pushHandler = cb;
        return () => {};
      });

      // Fresh poll establishes known good counts: 3 issues, 2 PRs.
      getRepoStatsMock.mockResolvedValue({
        commitCount: 7,
        issueCount: 3,
        prCount: 2,
        loading: false,
        stale: false,
        lastUpdated: 1000,
      });

      const { result } = renderHook(() => useRepositoryStats());

      await waitFor(() => {
        expect(result.current.stats?.issueCount).toBe(3);
        expect(result.current.stats?.prCount).toBe(2);
      });

      // A fresh (non-stale) fetch confirms the repo now has 0 open issues/PRs —
      // this is real data and must show 0, not the previously preserved counts.
      const freshZero: ForgeRepositoryStats = {
        commitCount: 7,
        issueCount: 0,
        prCount: 0,
        loading: false,
        stale: false,
        lastUpdated: 2000,
      };
      await act(async () => {
        pushHandler?.(makePushPayload(project.path, freshZero, 2000));
        await Promise.resolve();
        await Promise.resolve();
      });

      await waitFor(() => {
        expect(result.current.stats?.issueCount).toBe(0);
        expect(result.current.stats?.prCount).toBe(0);
      });
    });

    it("ignores a push payload whose projectPath differs from the active project", async () => {
      const project = { id: "p", path: "/repo/active" };
      getCurrentMock.mockResolvedValue(project);
      onSwitchMock.mockReturnValue(() => {});
      getRepoStatsMock.mockResolvedValue({
        commitCount: 5,
        issueCount: 1,
        prCount: 1,
        loading: false,
        stale: false,
        lastUpdated: 1000,
      });

      let pushHandler: ((payload: unknown) => void) | undefined;
      onRepoStatsAndPageUpdatedMock.mockImplementation((cb: (p: unknown) => void) => {
        pushHandler = cb;
        return () => {};
      });

      const { result } = renderHook(() => useRepositoryStats());

      await waitFor(() => {
        expect(result.current.stats?.prCount).toBe(1);
      });

      const otherStats: ForgeRepositoryStats = {
        commitCount: 99,
        issueCount: 99,
        prCount: 99,
        loading: false,
        stale: false,
        lastUpdated: 9999,
      };
      await act(async () => {
        pushHandler?.(makePushPayload("/repo/other", otherStats, 9999));
        await Promise.resolve();
        await Promise.resolve();
      });

      // Must not be contaminated by the cross-project push.
      expect(result.current.stats?.prCount).toBe(1);
      expect(result.current.stats?.commitCount).toBe(5);
    });
  });

  describe("disk-cache hydration on mount", () => {
    beforeEach(() => {
      resetForgeResourceCache();
    });

    function makeIssue(n: number): Issue {
      return {
        number: n,
        title: `Issue #${n}`,
        body: "",
        url: `https://forge.test/repo/issues/${n}`,
        state: "open",
        rawState: "OPEN",
        author: { login: "user", avatarUrl: "", rawData: null },
        assignees: [],
        labels: [],
        commentCount: 0,
        createdAt: 0,
        updatedAt: 0,
        rawData: null,
      };
    }

    function makePR(n: number): PR {
      return {
        ...makeIssue(n),
        isDraft: false,
        merged: false,
        baseRef: "main",
        headRef: `pr-${n}`,
      } as unknown as PR;
    }

    it("seeds the renderer cache from the disk-persisted first page on cold start", async () => {
      const project = { id: "p", path: "/repo/disk" };
      getCurrentMock.mockResolvedValue(project);
      onSwitchMock.mockReturnValue(() => {});
      // Stats fetch never resolves so the only cache-write path under test is
      // the disk hydration effect.
      getRepoStatsMock.mockImplementation(() => new Promise(() => {}));

      const issueItems = [makeIssue(1), makeIssue(2)];
      const prItems = [makePR(3)];
      const lastUpdated = Date.now() - 5_000;
      getFirstPageCacheMock.mockResolvedValueOnce({
        providerId: PROVIDER_ID,
        projectPath: project.path,
        lastUpdated,
        issues: { items: issueItems, endCursor: "issue-cursor", hasNextPage: true },
        prs: { items: prItems, endCursor: null, hasNextPage: false },
      });

      renderHook(() => useRepositoryStats());

      const issuesKey = buildCacheKey(project.path, "issue", "open", "created");
      const prsKey = buildCacheKey(project.path, "pr", "open", "created");

      await waitFor(() => {
        expect(getCache(issuesKey)?.items).toEqual(issueItems);
      });
      expect(getCache(issuesKey)?.nextCursor).toBe("issue-cursor");
      expect(getCache(issuesKey)?.hasMore).toBe(true);
      expect(getCache(issuesKey)?.timestamp).toBe(lastUpdated);
      expect(getCache(prsKey)?.items).toEqual(prItems);
      expect(getCache(prsKey)?.timestamp).toBe(lastUpdated);
    });

    it("does not overwrite a fresher renderer cache entry with stale disk data", async () => {
      const project = { id: "p", path: "/repo/fresh" };
      getCurrentMock.mockResolvedValue(project);
      onSwitchMock.mockReturnValue(() => {});
      getRepoStatsMock.mockImplementation(() => new Promise(() => {}));

      const issuesKey = buildCacheKey(project.path, "issue", "open", "created");
      const freshTimestamp = Date.now();
      const fresherIssue = makeIssue(99);
      // Pre-seed an in-memory entry that's NEWER than the disk entry — this
      // simulates the broadcast push from the first poll landing before the
      // async disk read resolves.
      setCache(issuesKey, {
        items: [fresherIssue],
        nextCursor: null,
        hasMore: false,
        timestamp: freshTimestamp,
      });

      getFirstPageCacheMock.mockResolvedValueOnce({
        providerId: PROVIDER_ID,
        projectPath: project.path,
        lastUpdated: freshTimestamp - 60_000,
        issues: {
          items: [makeIssue(1)],
          endCursor: null,
          hasNextPage: false,
        },
        prs: { items: [], endCursor: null, hasNextPage: false },
      });

      renderHook(() => useRepositoryStats());

      await waitFor(() => {
        expect(getFirstPageCacheMock).toHaveBeenCalled();
      });
      // Microtask flush so the disk-cache .then() chain settles before we
      // assert the cache wasn't overwritten.
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(getCache(issuesKey)?.items).toEqual([fresherIssue]);
      expect(getCache(issuesKey)?.timestamp).toBe(freshTimestamp);
    });

    it("is a no-op when the disk cache returns null (first-ever launch)", async () => {
      const project = { id: "p", path: "/repo/empty" };
      getCurrentMock.mockResolvedValue(project);
      onSwitchMock.mockReturnValue(() => {});
      getRepoStatsMock.mockImplementation(() => new Promise(() => {}));
      getFirstPageCacheMock.mockResolvedValueOnce(null);

      const { result } = renderHook(() => useRepositoryStats());

      await waitFor(() => {
        expect(getFirstPageCacheMock).toHaveBeenCalled();
      });

      const issuesKey = buildCacheKey(project.path, "issue", "open", "created");
      const prsKey = buildCacheKey(project.path, "pr", "open", "created");
      expect(getCache(issuesKey)).toBeUndefined();
      expect(getCache(prsKey)).toBeUndefined();
      // Hook stays alive without throwing.
      expect(result.current.error).toBeNull();
    });

    it("ignores a disk entry whose projectPath differs from the active project", async () => {
      const project = { id: "p", path: "/repo/active" };
      getCurrentMock.mockResolvedValue(project);
      onSwitchMock.mockReturnValue(() => {});
      getRepoStatsMock.mockImplementation(() => new Promise(() => {}));

      // Disk entry's projectPath doesn't match active project — the cache is
      // shared per-window across projects, so the path guard is the only
      // thing keeping a stale neighbouring repo's data out of the active view.
      getFirstPageCacheMock.mockResolvedValueOnce({
        projectPath: "/repo/other",
        lastUpdated: Date.now(),
        issues: { items: [makeIssue(7)], endCursor: null, hasNextPage: false },
        prs: { items: [], endCursor: null, hasNextPage: false },
      });

      renderHook(() => useRepositoryStats());

      await waitFor(() => {
        expect(getFirstPageCacheMock).toHaveBeenCalled();
      });
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      const issuesKey = buildCacheKey(project.path, "issue", "open", "created");
      expect(getCache(issuesKey)).toBeUndefined();
    });

    it("seeds toolbar stats from cached bootstrap counts on cold start", async () => {
      const project = { id: "p", path: "/repo/bootstrap-stats" };
      getCurrentMock.mockResolvedValue(project);
      onSwitchMock.mockReturnValue(() => {});
      // Network poll never resolves — only the hydration effect writes stats.
      getRepoStatsMock.mockImplementation(() => new Promise(() => {}));

      const lastUpdated = Date.now() - 5_000;
      getFirstPageCacheMock.mockResolvedValueOnce({
        providerId: PROVIDER_ID,
        projectPath: project.path,
        lastUpdated,
        issues: { items: [], endCursor: null, hasNextPage: false },
        prs: { items: [], endCursor: null, hasNextPage: false },
        stats: { issueCount: 12, prCount: 7, lastUpdated },
      });

      const { result } = renderHook(() => useRepositoryStats());

      await waitFor(() => {
        expect(result.current.stats?.issueCount).toBe(12);
        expect(result.current.stats?.prCount).toBe(7);
        expect(result.current.isStale).toBe(true);
        expect(result.current.stats?.stale).toBe(true);
        expect(result.current.lastUpdated).toBe(lastUpdated);
      });
    });

    it("does not overwrite fresher network stats with bootstrap cache", async () => {
      const project = { id: "p", path: "/repo/race" };
      getCurrentMock.mockResolvedValue(project);
      onSwitchMock.mockReturnValue(() => {});

      const networkLastUpdated = Date.now();
      // Network poll resolves BEFORE the disk hydration effect — simulates
      // ultra-fast network beating the async IPC cache read.
      getRepoStatsMock.mockResolvedValue({
        commitCount: 42,
        issueCount: 99,
        prCount: 88,
        loading: false,
        stale: false,
        lastUpdated: networkLastUpdated,
      });

      const cachedLastUpdated = networkLastUpdated - 60_000;
      getFirstPageCacheMock.mockResolvedValueOnce({
        providerId: PROVIDER_ID,
        projectPath: project.path,
        lastUpdated: cachedLastUpdated,
        issues: { items: [], endCursor: null, hasNextPage: false },
        prs: { items: [], endCursor: null, hasNextPage: false },
        stats: { issueCount: 1, prCount: 2, lastUpdated: cachedLastUpdated },
      });

      const { result } = renderHook(() => useRepositoryStats());

      await waitFor(() => {
        expect(result.current.stats?.issueCount).toBe(99);
      });

      // Flush so the hydration effect settles.
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      // Network data must not be overwritten by older cache data.
      expect(result.current.stats?.issueCount).toBe(99);
      expect(result.current.stats?.prCount).toBe(88);
      expect(result.current.stats?.commitCount).toBe(42);
      expect(result.current.isStale).toBe(false);
      expect(result.current.lastUpdated).toBe(networkLastUpdated);
    });

    it("does not seed items cache from a stats-only payload", async () => {
      const project = { id: "p", path: "/repo/stats-only" };
      getCurrentMock.mockResolvedValue(project);
      onSwitchMock.mockReturnValue(() => {});
      getRepoStatsMock.mockImplementation(() => new Promise(() => {}));

      const lastUpdated = Date.now() - 5_000;
      // Stats-only: empty items arrays + valid stats (simulates first-page
      // cache expired but stats still within 60-min bootstrap TTL).
      getFirstPageCacheMock.mockResolvedValueOnce({
        providerId: PROVIDER_ID,
        projectPath: project.path,
        lastUpdated,
        issues: { items: [], endCursor: null, hasNextPage: false },
        prs: { items: [], endCursor: null, hasNextPage: false },
        stats: { issueCount: 5, prCount: 3, lastUpdated },
      });

      renderHook(() => useRepositoryStats());

      await waitFor(() => {
        expect(getFirstPageCacheMock).toHaveBeenCalled();
      });
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      const issuesKey = buildCacheKey(project.path, "issue", "open", "created");
      const prsKey = buildCacheKey(project.path, "pr", "open", "created");
      // Items cache must NOT be seeded from empty arrays.
      expect(getCache(issuesKey)).toBeUndefined();
      expect(getCache(prsKey)).toBeUndefined();
    });

    it("does not apply bootstrap stats from a stale project after project switch", async () => {
      let currentProject = { id: "p", path: "/repo/a" };
      getCurrentMock.mockImplementation(async () => currentProject);

      let switchHandler: (() => void) | undefined;
      onSwitchMock.mockImplementation((cb: () => void) => {
        switchHandler = cb;
        return () => {};
      });

      // Network poll for project A stays pending.
      getRepoStatsMock.mockImplementation(() => new Promise(() => {}));

      // Defer the hydration IPC response so we can switch projects mid-flight.
      const deferred = createDeferred<{
        providerId: string;
        projectPath: string;
        lastUpdated: number;
        issues: { items: Issue[]; endCursor: null; hasNextPage: false };
        prs: { items: PR[]; endCursor: null; hasNextPage: false };
        stats: { issueCount: number; prCount: number; lastUpdated: number };
      }>();
      getFirstPageCacheMock.mockReturnValueOnce(deferred.promise);

      const { result } = renderHook(() => useRepositoryStats());

      await waitFor(() => {
        expect(getFirstPageCacheMock).toHaveBeenCalled();
      });

      // Switch to project B while hydration is in-flight. The onSwitch
      // handler resets state to null and queues a fetch for B (blocked by
      // inFlightRef since A's fetch is still pending).
      currentProject = { id: "p", path: "/repo/b" };
      act(() => {
        switchHandler?.();
      });

      // State was reset by the switch handler.
      expect(result.current.stats).toBeNull();

      await act(async () => {
        // Resolve hydration with project A's cached data. The re-verify
        // check inside the effect must detect the path mismatch against
        // the current project (B) and bail.
        deferred.resolve({
          providerId: PROVIDER_ID,
          projectPath: "/repo/a",
          lastUpdated: 1000,
          issues: { items: [], endCursor: null, hasNextPage: false },
          prs: { items: [], endCursor: null, hasNextPage: false },
          stats: { issueCount: 999, prCount: 888, lastUpdated: 1000 },
        });
        await Promise.resolve();
        await Promise.resolve();
      });

      // Must still show null — the re-verify prevented A's stale cache
      // from being applied after the project switch.
      expect(result.current.stats).toBeNull();
    });

    it("does not clear an existing error when bootstrap hydration resolves", async () => {
      const project = { id: "p", path: "/repo/err-then-cache" };
      getCurrentMock.mockResolvedValue(project);
      onSwitchMock.mockReturnValue(() => {});

      // Network fetch resolves first with an error and no lastUpdated.
      getRepoStatsMock.mockResolvedValue({
        commitCount: 0,
        issueCount: null,
        prCount: null,
        loading: false,
        error: "Network timeout",
        // No lastUpdated field — simulates error payload from main process.
      });

      const cacheLastUpdated = Date.now() - 5_000;
      // Hydration resolves after the error with valid cached stats.
      getFirstPageCacheMock.mockResolvedValue({
        providerId: PROVIDER_ID,
        projectPath: project.path,
        lastUpdated: cacheLastUpdated,
        issues: { items: [], endCursor: null, hasNextPage: false },
        prs: { items: [], endCursor: null, hasNextPage: false },
        stats: { issueCount: 5, prCount: 3, lastUpdated: cacheLastUpdated },
      });

      const { result } = renderHook(() => useRepositoryStats());

      // Network fetch lands first, setting the error.
      await waitFor(() => {
        expect(result.current.error).toBe("Network timeout");
      });

      // Flush so hydration effect settles.
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      // Error must persist — bootstrap MUST NOT clear it.
      expect(result.current.error).toBe("Network timeout");
      // Bootstrap stats (5/3) must NOT have been applied.
      expect(result.current.stats?.issueCount).toBeNull();
      expect(result.current.stats?.prCount).toBeNull();
    });
  });

  describe("freshnessLevel", () => {
    // Real timers throughout — `waitFor` relies on microtasks + setTimeout to
    // poll, which `vi.useFakeTimers` would deadlock. Test ages are anchored to
    // `Date.now()` at the start of each test instead, and the freshness
    // computation reads `Date.now()` directly at render time.
    it("returns 'fresh' when lastUpdated is within 90s", async () => {
      const now = Date.now();
      getCurrentMock.mockResolvedValue({ id: "p", path: "/repo" });
      onSwitchMock.mockReturnValue(() => {});
      getRepoStatsMock.mockResolvedValue({
        commitCount: 5,
        issueCount: 2,
        prCount: 1,
        loading: false,
        stale: false,
        lastUpdated: now - 30_000,
      });

      const { result } = renderHook(() => useRepositoryStats());

      await waitFor(() => {
        expect(result.current.stats?.commitCount).toBe(5);
        expect(result.current.freshnessLevel).toBe("fresh");
      });
    });

    it("returns 'aging' when lastUpdated is between 90s and 5min", async () => {
      const now = Date.now();
      getCurrentMock.mockResolvedValue({ id: "p", path: "/repo" });
      onSwitchMock.mockReturnValue(() => {});
      getRepoStatsMock.mockResolvedValue({
        commitCount: 5,
        issueCount: 2,
        prCount: 1,
        loading: false,
        stale: false,
        lastUpdated: now - 120_000,
      });

      const { result } = renderHook(() => useRepositoryStats());

      await waitFor(() => {
        expect(result.current.lastUpdated).toBe(now - 120_000);
        expect(result.current.freshnessLevel).toBe("aging");
      });
    });

    it("returns 'stale-disk' when stale=true and no ghError", async () => {
      const now = Date.now();
      getCurrentMock.mockResolvedValue({ id: "p", path: "/repo" });
      onSwitchMock.mockReturnValue(() => {});
      getRepoStatsMock.mockResolvedValue({
        commitCount: 5,
        issueCount: 2,
        prCount: 1,
        loading: false,
        stale: true,
        lastUpdated: now - 10_000,
      });

      const { result } = renderHook(() => useRepositoryStats());

      await waitFor(() => {
        expect(result.current.isStale).toBe(true);
        expect(result.current.freshnessLevel).toBe("stale-disk");
      });
    });

    it("returns 'errored' when stale=true with a ghError string", async () => {
      const now = Date.now();
      getCurrentMock.mockResolvedValue({ id: "p", path: "/repo" });
      onSwitchMock.mockReturnValue(() => {});
      getRepoStatsMock.mockResolvedValue({
        commitCount: 5,
        issueCount: 2,
        prCount: 1,
        loading: false,
        stale: true,
        lastUpdated: now - 10_000,
        error: "Network unreachable",
      });

      const { result } = renderHook(() => useRepositoryStats());

      await waitFor(() => {
        expect(result.current.isStale).toBe(true);
        expect(result.current.error).toBe("Network unreachable");
        expect(result.current.freshnessLevel).toBe("errored");
      });
    });

    it("returns 'errored' when fetchStats throws and no stats are applied", async () => {
      getCurrentMock.mockResolvedValue({ id: "p", path: "/repo" });
      onSwitchMock.mockReturnValue(() => {});
      getRepoStatsMock.mockRejectedValue(new Error("kaboom"));

      const { result } = renderHook(() => useRepositoryStats());

      await waitFor(() => {
        expect(result.current.error).not.toBeNull();
        expect(result.current.stats).toBeNull();
        expect(result.current.freshnessLevel).toBe("errored");
      });
    });

    it("returns 'errored' when IPC returned ghError with stale=false and no lastUpdated", async () => {
      // Reproduces the IPC handler path where the renderer-side stats payload
      // carries `ghError` (no token / first launch / network blip) but the
      // service has nothing to flag stale because there's no disk fallback.
      // Without the `error && lastUpdated == null` guard in the memo, this
      // would silently resolve to "fresh" and hide the failure entirely.
      getCurrentMock.mockResolvedValue({ id: "p", path: "/repo" });
      onSwitchMock.mockReturnValue(() => {});
      getRepoStatsMock.mockResolvedValue({
        commitCount: 0,
        issueCount: null,
        prCount: null,
        loading: false,
        stale: false,
        error: "Network timeout",
      });

      const { result } = renderHook(() => useRepositoryStats());

      await waitFor(() => {
        expect(result.current.error).toBe("Network timeout");
        expect(result.current.lastUpdated).toBeNull();
        expect(result.current.freshnessLevel).toBe("errored");
      });
    });

    it("clears errored freshness on project switch before the new project's first poll resolves", async () => {
      // Without the error reset in the onSwitch handler, the freshness memo
      // would still see the previous project's `error` and report "errored"
      // for the new project's empty pill until its first fetch returned.
      let currentProject = { id: "a", path: "/repo/a" };
      getCurrentMock.mockImplementation(async () => currentProject);
      let switchHandler: (() => void) | undefined;
      onSwitchMock.mockImplementation((cb: () => void) => {
        switchHandler = cb;
        return () => {};
      });

      // Project A returns a ghError on its single fetch — establishes errored.
      getRepoStatsMock.mockResolvedValueOnce({
        commitCount: 0,
        issueCount: null,
        prCount: null,
        loading: false,
        stale: false,
        error: "Network timeout on project A",
      });

      const { result } = renderHook(() => useRepositoryStats());

      await waitFor(() => {
        expect(result.current.freshnessLevel).toBe("errored");
        expect(result.current.error).toBe("Network timeout on project A");
      });

      // Project B's fetch is held pending so we observe the post-switch
      // pre-fetch state — error must already be cleared.
      currentProject = { id: "b", path: "/repo/b" };
      const slowB = createDeferred<ForgeRepositoryStats>();
      getRepoStatsMock.mockImplementationOnce(() => slowB.promise);

      act(() => {
        switchHandler?.();
      });

      await waitFor(() => {
        expect(result.current.error).toBeNull();
        expect(result.current.stats).toBeNull();
        expect(result.current.freshnessLevel).toBe("fresh");
      });
    });

    it("respects FRESH_THRESHOLD_MS / AGING_THRESHOLD_MS as documented boundaries", async () => {
      const { FRESH_THRESHOLD_MS: FRESH, AGING_THRESHOLD_MS: AGING } =
        await import("../useRepositoryStats");
      expect(FRESH).toBe(90_000);
      expect(AGING).toBe(300_000);
      expect(AGING).toBeGreaterThan(FRESH);
    });
  });

  describe("rate limits", () => {
    it("surfaces rateLimitResetAt and rateLimitKind from the stats payload", async () => {
      getCurrentMock.mockResolvedValue({ id: "p", path: "/repo" });
      onSwitchMock.mockReturnValue(() => {});
      const resetAt = Date.now() + 60_000;
      getRepoStatsMock.mockResolvedValue({
        commitCount: 0,
        issueCount: 0,
        prCount: 0,
        loading: false,
        error: "GitHub rate limit exceeded. Resets in 1m.",
        rateLimitResetAt: resetAt,
        rateLimitKind: "primary",
      });

      const { result } = renderHook(() => useRepositoryStats());

      await waitFor(() => {
        expect(result.current.rateLimitResetAt).toBe(resetAt);
        expect(result.current.rateLimitKind).toBe("primary");
      });
    });

    it("applies rate-limit state pushed via onRateLimitChanged and clears on unblock", async () => {
      getCurrentMock.mockResolvedValue({ id: "p", path: "/repo" });
      onSwitchMock.mockReturnValue(() => {});
      let pushHandler: ((p: unknown) => void) | undefined;
      onRateLimitChangedMock.mockImplementation((cb: (p: unknown) => void) => {
        pushHandler = cb as typeof pushHandler;
        return () => {};
      });
      getRepoStatsMock.mockResolvedValue({
        commitCount: 0,
        issueCount: 0,
        prCount: 0,
        loading: false,
      });

      const { result } = renderHook(() => useRepositoryStats());

      await waitFor(() => {
        expect(result.current.rateLimitResetAt).toBeNull();
      });

      const resetAt = Date.now() + 30_000;
      act(() => {
        pushHandler?.({
          providerId: PROVIDER_ID,
          state: { limit: 5000, remaining: 0, resetAt, secondaryThrottled: true },
        });
      });

      await waitFor(() => {
        expect(result.current.rateLimitResetAt).toBe(resetAt);
        expect(result.current.rateLimitKind).toBe("secondary");
      });

      act(() => {
        pushHandler?.({
          providerId: PROVIDER_ID,
          state: { limit: 5000, remaining: 4000, resetAt: null },
        });
      });

      await waitFor(() => {
        expect(result.current.rateLimitResetAt).toBeNull();
        expect(result.current.rateLimitKind).toBeNull();
      });
    });
  });

  describe("wake-coordinator subscription", () => {
    it("refreshes when wakeEpoch increments past the value seen at mount", async () => {
      getCurrentMock.mockResolvedValue({ id: "p", path: "/repo/a" });
      onSwitchMock.mockReturnValue(() => {});
      getRepoStatsMock.mockResolvedValue({
        commitCount: 1,
        issueCount: 1,
        prCount: 1,
        loading: false,
        stale: false,
        lastUpdated: 1000,
      });

      renderHook(() => useRepositoryStats());

      await waitFor(() => {
        expect(getRepoStatsMock).toHaveBeenCalledTimes(1);
      });

      await act(async () => {
        useSystemWakeStore.setState((s) => ({ wakeEpoch: s.wakeEpoch + 1 }));
        await Promise.resolve();
      });

      await waitFor(() => {
        expect(getRepoStatsMock).toHaveBeenCalledTimes(2);
      });
    });

    it("does not refresh for a wakeEpoch that was already current at mount", async () => {
      // Simulate a prior wake landing before this consumer mounts.
      useSystemWakeStore.setState({
        wakeEpoch: 3,
        lastSleepDuration: 0,
        isWakeRevalidating: false,
      });

      getCurrentMock.mockResolvedValue({ id: "p", path: "/repo/a" });
      onSwitchMock.mockReturnValue(() => {});
      getRepoStatsMock.mockResolvedValue({
        commitCount: 1,
        issueCount: 1,
        prCount: 1,
        loading: false,
        stale: false,
        lastUpdated: 1000,
      });

      renderHook(() => useRepositoryStats());

      await waitFor(() => {
        expect(getRepoStatsMock).toHaveBeenCalledTimes(1);
      });

      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      // Only the mount fetch ran — the previous wake should not retroactively
      // trigger this consumer.
      expect(getRepoStatsMock).toHaveBeenCalledTimes(1);
    });

    it("refreshes once per increment when wakeEpoch bumps multiple times", async () => {
      getCurrentMock.mockResolvedValue({ id: "p", path: "/repo/a" });
      onSwitchMock.mockReturnValue(() => {});
      getRepoStatsMock.mockResolvedValue({
        commitCount: 1,
        issueCount: 1,
        prCount: 1,
        loading: false,
        stale: false,
        lastUpdated: 1000,
      });

      renderHook(() => useRepositoryStats());

      await waitFor(() => {
        expect(getRepoStatsMock).toHaveBeenCalledTimes(1);
      });

      await act(async () => {
        useSystemWakeStore.setState((s) => ({ wakeEpoch: s.wakeEpoch + 1 }));
        await Promise.resolve();
      });
      await waitFor(() => {
        expect(getRepoStatsMock).toHaveBeenCalledTimes(2);
      });

      await act(async () => {
        useSystemWakeStore.setState((s) => ({ wakeEpoch: s.wakeEpoch + 1 }));
        await Promise.resolve();
      });
      await waitFor(() => {
        expect(getRepoStatsMock).toHaveBeenCalledTimes(3);
      });
    });
  });

  describe("loading vs isValidating split", () => {
    it("keeps loading true only for the cold first fetch", async () => {
      getCurrentMock.mockResolvedValue({ id: "p", path: "/repo/a" });
      onSwitchMock.mockReturnValue(() => {});

      const firstFetch = createDeferred<ForgeRepositoryStats>();
      getRepoStatsMock.mockImplementationOnce(() => firstFetch.promise);

      const { result } = renderHook(() => useRepositoryStats());

      await waitFor(() => {
        expect(result.current.loading).toBe(true);
        expect(result.current.isValidating).toBe(true);
      });

      await act(async () => {
        firstFetch.resolve({
          commitCount: 1,
          issueCount: 2,
          prCount: 3,
          loading: false,
          stale: false,
          lastUpdated: 1000,
        });
        await Promise.resolve();
      });

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
        expect(result.current.isValidating).toBe(false);
        expect(result.current.stats?.commitCount).toBe(1);
      });
    });

    it("flips isValidating without flipping loading on a background refetch", async () => {
      getCurrentMock.mockResolvedValue({ id: "p", path: "/repo/a" });
      onSwitchMock.mockReturnValue(() => {});

      const stats: ForgeRepositoryStats = {
        commitCount: 5,
        issueCount: 2,
        prCount: 1,
        loading: false,
        stale: false,
        lastUpdated: 1000,
      };

      const slow = createDeferred<ForgeRepositoryStats>();
      getRepoStatsMock.mockResolvedValueOnce(stats).mockImplementationOnce(() => slow.promise);

      const { result } = renderHook(() => useRepositoryStats());

      await waitFor(() => {
        expect(result.current.stats?.commitCount).toBe(5);
        expect(result.current.loading).toBe(false);
        expect(result.current.isValidating).toBe(false);
      });

      // Trigger a background revalidate via the wake coordinator. The visible
      // counts must stay on screen — `loading` must remain false — while
      // `isValidating` flips true.
      await act(async () => {
        useSystemWakeStore.setState((s) => ({ wakeEpoch: s.wakeEpoch + 1 }));
        await Promise.resolve();
      });

      await waitFor(() => {
        expect(result.current.isValidating).toBe(true);
      });
      expect(result.current.loading).toBe(false);
      expect(result.current.stats?.commitCount).toBe(5);

      await act(async () => {
        slow.resolve({
          commitCount: 6,
          issueCount: 2,
          prCount: 1,
          loading: false,
          stale: false,
          lastUpdated: 2000,
        });
        await Promise.resolve();
      });

      await waitFor(() => {
        expect(result.current.isValidating).toBe(false);
        expect(result.current.stats?.commitCount).toBe(6);
      });
    });
  });

  describe("worker instance role (#10123)", () => {
    beforeEach(() => {
      window.__DAINTREE_INSTANCE_ROLE__ = { role: "worker" };
      getCurrentMock.mockResolvedValue({ id: "p", path: "/repo" });
      onSwitchMock.mockReturnValue(() => {});
      getRepoStatsMock.mockResolvedValue({
        commitCount: 1,
        issueCount: 1,
        prCount: 1,
        loading: false,
        stale: false,
        lastUpdated: 1000,
      });
    });

    afterEach(() => {
      delete window.__DAINTREE_INSTANCE_ROLE__;
    });

    it("performs no automatic fetch on mount", async () => {
      renderHook(() => useRepositoryStats());

      await act(async () => {
        await Promise.resolve();
      });

      expect(getRepoStatsMock).not.toHaveBeenCalled();
    });

    it("suppresses the wake-epoch refetch", async () => {
      renderHook(() => useRepositoryStats());

      await act(async () => {
        useSystemWakeStore.setState((s) => ({ wakeEpoch: s.wakeEpoch + 1 }));
        await Promise.resolve();
      });

      expect(getRepoStatsMock).not.toHaveBeenCalled();
    });

    it("suppresses the rate-limit-cleared auto-refresh", async () => {
      let rateLimitCb: ((payload: unknown) => void) | undefined;
      onRateLimitChangedMock.mockImplementation((cb) => {
        rateLimitCb = cb;
        return () => {};
      });

      renderHook(() => useRepositoryStats());

      await waitFor(() => {
        expect(rateLimitCb).toBeDefined();
      });

      await act(async () => {
        rateLimitCb?.({
          providerId: PROVIDER_ID,
          state: { limit: 5000, remaining: 4000, resetAt: null },
        });
        await Promise.resolve();
      });

      expect(getRepoStatsMock).not.toHaveBeenCalled();
    });

    it("keeps explicit refresh() functional without resuming polling", async () => {
      const { result } = renderHook(() => useRepositoryStats());

      await act(async () => {
        await result.current.refresh({ force: true });
      });

      expect(getRepoStatsMock).toHaveBeenCalledTimes(1);
      expect(getRepoStatsMock.mock.calls[0]?.[1]).toBe(true);
    });
  });
});
