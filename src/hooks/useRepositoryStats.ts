import { useState, useEffect, useCallback, useRef } from "react";
import type { GitHubRateLimitKind, RepositoryStats } from "../types";
import { githubClient, projectClient } from "@/clients";
import { isTokenRelatedError } from "@/lib/githubErrors";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { buildCacheKey, getCache, setCache } from "@/lib/githubResourceCache";

function isValidPagePayload(page: unknown): page is {
  items: unknown[];
  endCursor: string | null;
  hasNextPage: boolean;
} {
  if (!page || typeof page !== "object") return false;
  const p = page as Record<string, unknown>;
  return Array.isArray(p.items) && (typeof p.endCursor === "string" || p.endCursor === null);
}

const ACTIVE_POLL_INTERVAL = 30 * 1000;
const IDLE_POLL_INTERVAL = 5 * 60 * 1000;
const ERROR_BACKOFF_INTERVAL = 2 * 60 * 1000;

// Add a small buffer to the reset timestamp to avoid scheduling a poll at the
// exact instant GitHub releases the quota — paired with the main-process
// buffer in GitHubRateLimitService, this keeps the next attempt safely past
// reset even under clock skew.
const RATE_LIMIT_RESUME_BUFFER_MS = 2_000;

export interface UseRepositoryStatsReturn {
  stats: RepositoryStats | null;
  loading: boolean;
  error: string | null;
  isTokenError: boolean;
  isStale: boolean;
  lastUpdated: number | null;
  rateLimitResetAt: number | null;
  rateLimitKind: GitHubRateLimitKind | null;
  refresh: (options?: { force?: boolean }) => Promise<void>;
}

/**
 * @example
 * ```tsx
 * function Toolbar() {
 *   const { stats, loading, error, refresh } = useRepositoryStats();
 *
 *   if (loading && !stats) return <LoadingSpinner />;
 *   if (error && !stats) return <ErrorMessage error={error} onRetry={refresh} />;
 *
 *   return (
 *     <div>
 *       <StatsBadge label="Commits" count={stats?.commitCount ?? 0} />
 *       <StatsBadge label="Issues" count={stats?.issueCount ?? 0} />
 *       <StatsBadge label="PRs" count={stats?.prCount ?? 0} />
 *     </div>
 *   );
 * }
 * ```
 */
export function useRepositoryStats(): UseRepositoryStatsReturn {
  const [stats, setStats] = useState<RepositoryStats | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isStale, setIsStale] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const [rateLimitResetAt, setRateLimitResetAt] = useState<number | null>(null);
  const [rateLimitKind, setRateLimitKind] = useState<GitHubRateLimitKind | null>(null);
  const rateLimitResetAtRef = useRef<number | null>(null);
  // Mirrors the `lastUpdated` state for synchronous reads from event-handler
  // closures (push subscribers). Used to skip stale stat pushes whose
  // `fetchedAt` is older than what we've already applied.
  const lastUpdatedRef = useRef<number | null>(null);

  // Tracks whether any result (success, error, or stale) has already been
  // applied to state. Set to true by applyStatsResult on first write, reset
  // to false on project switch. Prevents the cold-start hydration from
  // overwriting a network fetch result (including errors) that landed first.
  const hasAppliedResultRef = useRef(false);

  // Preserve last known non-zero counts to prevent empty state flash during refresh
  const lastKnownCountsRef = useRef<{
    issueCount: number | null;
    prCount: number | null;
    projectPath: string | null;
  }>({ issueCount: null, prCount: null, projectPath: null });

  const pollTimerRef = useRef<NodeJS.Timeout | null>(null);
  const isVisibleRef = useRef(!document.hidden);
  const mountedRef = useRef(true);
  const lastErrorRef = useRef<string | null>(null);
  const inFlightRef = useRef(false);
  const queuedFetchRef = useRef<{ pending: boolean; force: boolean }>({
    pending: false,
    force: false,
  });
  const activeFetchIdRef = useRef(0);
  const invalidatedFetchIdRef = useRef<number | null>(null);

  // Apply a `RepositoryStats` result to local state — shared by the network
  // fetch path (`fetchStats`) and the broadcast push path
  // (`onRepoStatsAndPageUpdated`). Both paths must run identical preservation
  // logic so a list-fetch-triggered update can't flash a `0` count when stale.
  const applyStatsResult = useCallback(
    (repoStats: RepositoryStats, opts: { projectPath: string }) => {
      if (!mountedRef.current) return;

      hasAppliedResultRef.current = true;

      // Track current project so a stale callback from a previous project
      // can be detected by `fetchStats`'s cross-project guard.
      lastKnownCountsRef.current.projectPath = opts.projectPath;

      // Only preserve counts when data is stale or errored (not on successful fresh fetch)
      const shouldPreserve = repoStats.stale === true || repoStats.ghError !== undefined;

      if (!shouldPreserve) {
        // Fresh successful data - update preserved counts and accept genuine 0s
        if (repoStats.issueCount !== null && repoStats.issueCount > 0) {
          lastKnownCountsRef.current.issueCount = repoStats.issueCount;
        } else if (repoStats.issueCount === 0) {
          // Clear preserved count on confirmed 0 from successful fetch
          lastKnownCountsRef.current.issueCount = null;
        }

        if (repoStats.prCount !== null && repoStats.prCount > 0) {
          lastKnownCountsRef.current.prCount = repoStats.prCount;
        } else if (repoStats.prCount === 0) {
          // Clear preserved count on confirmed 0 from successful fetch
          lastKnownCountsRef.current.prCount = null;
        }
      }

      // Apply preservation: use preserved counts only when data is stale/errored
      const preservedStats: RepositoryStats = {
        ...repoStats,
        issueCount:
          shouldPreserve &&
          repoStats.issueCount === 0 &&
          lastKnownCountsRef.current.issueCount !== null
            ? lastKnownCountsRef.current.issueCount
            : repoStats.issueCount,
        prCount:
          shouldPreserve && repoStats.prCount === 0 && lastKnownCountsRef.current.prCount !== null
            ? lastKnownCountsRef.current.prCount
            : repoStats.prCount,
      };

      setStats(preservedStats);
      setIsStale(repoStats.stale ?? false);
      const nextLastUpdated = repoStats.lastUpdated ?? null;
      lastUpdatedRef.current = nextLastUpdated;
      setLastUpdated(nextLastUpdated);

      const nextResetAt = repoStats.rateLimitResetAt ?? null;
      const nextKind = repoStats.rateLimitKind ?? null;
      rateLimitResetAtRef.current = nextResetAt;
      setRateLimitResetAt(nextResetAt);
      setRateLimitKind(nextKind);

      if (repoStats.ghError) {
        setError(repoStats.ghError);
        lastErrorRef.current = repoStats.ghError;
      } else {
        setError(null);
        lastErrorRef.current = null;
      }
    },
    []
  );

  const fetchStats = useCallback(
    async (force = false) => {
      if (inFlightRef.current) {
        queuedFetchRef.current.pending = true;
        queuedFetchRef.current.force = queuedFetchRef.current.force || force;
        invalidatedFetchIdRef.current = activeFetchIdRef.current;
        return;
      }

      try {
        inFlightRef.current = true;
        activeFetchIdRef.current += 1;
        const fetchId = activeFetchIdRef.current;

        const project = await projectClient.getCurrent();
        if (!project) {
          if (mountedRef.current) {
            setStats(null);
            setError(null);
            setIsStale(false);
            lastUpdatedRef.current = null;
            setLastUpdated(null);
            lastErrorRef.current = null;
          }
          return;
        }

        setLoading(true);

        const repoStats = await githubClient.getRepoStats(project.path, force);

        if (mountedRef.current) {
          if (invalidatedFetchIdRef.current === fetchId) {
            return;
          }

          // Ignore results from previous project (race condition protection)
          if (
            lastKnownCountsRef.current.projectPath !== null &&
            lastKnownCountsRef.current.projectPath !== project.path
          ) {
            return;
          }

          applyStatsResult(repoStats, { projectPath: project.path });
        }
      } catch (err) {
        if (mountedRef.current) {
          const errorMessage = formatErrorMessage(err, "Failed to fetch repository stats");
          setError(errorMessage);
          lastErrorRef.current = errorMessage;
        }
      } finally {
        if (mountedRef.current) {
          setLoading(false);
        }
        inFlightRef.current = false;
        if (mountedRef.current && queuedFetchRef.current.pending) {
          const queuedForce = queuedFetchRef.current.force;
          queuedFetchRef.current = { pending: false, force: false };
          void fetchStats(queuedForce);
        }
      }
    },
    [applyStatsResult]
  );

  const scheduleNextPoll = useCallback(() => {
    if (pollTimerRef.current) {
      clearTimeout(pollTimerRef.current);
    }

    let interval = isVisibleRef.current ? ACTIVE_POLL_INTERVAL : IDLE_POLL_INTERVAL;
    if (lastErrorRef.current) {
      interval = ERROR_BACKOFF_INTERVAL;
    }

    const resetAt = rateLimitResetAtRef.current;
    if (resetAt !== null && resetAt > Date.now()) {
      interval = resetAt - Date.now() + RATE_LIMIT_RESUME_BUFFER_MS;
    }

    pollTimerRef.current = setTimeout(() => {
      fetchStats().then(() => {
        if (mountedRef.current) {
          scheduleNextPoll();
        }
      });
    }, interval);
  }, [fetchStats]);

  const refresh = useCallback(
    async (options?: { force?: boolean }) => {
      if (pollTimerRef.current) {
        clearTimeout(pollTimerRef.current);
        pollTimerRef.current = null;
      }
      await fetchStats(options?.force ?? false);
      if (mountedRef.current) {
        scheduleNextPoll();
      }
    },
    [fetchStats, scheduleNextPoll]
  );

  useEffect(() => {
    const handleVisibilityChange = () => {
      isVisibleRef.current = !document.hidden;

      if (pollTimerRef.current) {
        clearTimeout(pollTimerRef.current);
        pollTimerRef.current = null;
      }

      if (isVisibleRef.current) {
        fetchStats().then(() => {
          if (mountedRef.current) {
            scheduleNextPoll();
          }
        });
      } else {
        scheduleNextPoll();
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [fetchStats, scheduleNextPoll]);

  useEffect(() => {
    mountedRef.current = true;

    return () => {
      mountedRef.current = false;
      queuedFetchRef.current = { pending: false, force: false };
      invalidatedFetchIdRef.current = null;
      if (pollTimerRef.current) {
        clearTimeout(pollTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    fetchStats().then(() => {
      if (mountedRef.current) {
        scheduleNextPoll();
      }
    });
  }, [fetchStats, scheduleNextPoll]);

  useEffect(() => {
    const handleSidebarRefresh = () => {
      void refresh({ force: true });
    };
    window.addEventListener("daintree:refresh-sidebar", handleSidebarRefresh);
    return () => {
      window.removeEventListener("daintree:refresh-sidebar", handleSidebarRefresh);
    };
  }, [refresh]);

  useEffect(() => {
    const cleanup = projectClient.onSwitch(() => {
      if (pollTimerRef.current) {
        clearTimeout(pollTimerRef.current);
        pollTimerRef.current = null;
      }

      // Clear preserved counts on project switch to prevent cross-contamination
      lastKnownCountsRef.current = { issueCount: null, prCount: null, projectPath: null };
      hasAppliedResultRef.current = false;

      setStats(null);
      setIsStale(false);
      lastUpdatedRef.current = null;
      setLastUpdated(null);
      rateLimitResetAtRef.current = null;
      setRateLimitResetAt(null);
      setRateLimitKind(null);

      fetchStats().then(() => {
        if (mountedRef.current) {
          scheduleNextPoll();
        }
      });
    });

    return cleanup;
  }, [fetchStats, scheduleNextPoll]);

  // Cold-start hydration: before the first poll completes, ask main for the
  // disk-persisted first page so the very first dropdown click after launch
  // resolves against real rows. Entries older than the disk cache's freshness
  // budget are dropped on read by the main-side cache and surface as `null`.
  // Within-session project switches don't re-hydrate from disk — the broadcast
  // subscription below seeds the renderer cache once the next poll completes.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const project = await projectClient.getCurrent();
        if (!project || cancelled || !mountedRef.current) return;
        const cached = await githubClient.getFirstPageCache(project.path);
        if (!cached || cancelled || !mountedRef.current) return;

        // Re-verify project identity after the async cache read. A project
        // switch may have fired while we were waiting for the IPC response.
        const currentProject = await projectClient.getCurrent();
        if (cancelled || !mountedRef.current) return;
        if (!currentProject || currentProject.path !== project.path) return;
        if (cached.projectPath !== currentProject.path) return;

        // Seed toolbar counts from bootstrap stats so the pill renders cached
        // counts immediately instead of an em-dash. Only apply when no other
        // result (network fetch success, error, or stale push) has landed
        // yet — the network poll will replace these with fresh data.
        if (cached.stats && !hasAppliedResultRef.current) {
          const bootstrapStats: RepositoryStats = {
            commitCount: 0,
            issueCount: cached.stats.issueCount,
            prCount: cached.stats.prCount,
            loading: false,
            stale: true,
            lastUpdated: cached.stats.lastUpdated,
          };
          applyStatsResult(bootstrapStats, { projectPath: currentProject.path });
        }

        const issuesKey = buildCacheKey(currentProject.path, "issue", "open", "created");
        const prsKey = buildCacheKey(currentProject.path, "pr", "open", "created");
        // Don't downgrade a fresher entry — the broadcast push from the first
        // poll can land before this hydration resolves, and disk data is up
        // to 10 minutes old.
        // Only seed items when the payload has actual items — a stats-only
        // payload (first-page cache expired but stats within bootstrap TTL)
        // has empty arrays that must not overwrite the renderer items cache.
        if (cached.issues.items.length > 0) {
          const existingIssues = getCache(issuesKey);
          if (!existingIssues || existingIssues.timestamp < cached.lastUpdated) {
            setCache(issuesKey, {
              items: cached.issues.items,
              endCursor: cached.issues.endCursor,
              hasNextPage: cached.issues.hasNextPage,
              timestamp: cached.lastUpdated,
            });
          }
        }
        if (cached.prs.items.length > 0) {
          const existingPRs = getCache(prsKey);
          if (!existingPRs || existingPRs.timestamp < cached.lastUpdated) {
            setCache(prsKey, {
              items: cached.prs.items,
              endCursor: cached.prs.endCursor,
              hasNextPage: cached.prs.hasNextPage,
              timestamp: cached.lastUpdated,
            });
          }
        }
      } catch {
        // Disk hydration is best-effort; the network poll fallback covers
        // any failure here.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [applyStatsResult]);

  // Subscribe to the combined repo-stats-and-first-page push from the main
  // process. Whenever a poll completes successfully, main broadcasts the
  // counts AND the first 20 open issues + open PRs (sorted by created-desc).
  // Seed the renderer's `githubResourceCache` for the matching default-filter
  // cache key so the next dropdown click reads from hot cache instantly, and
  // apply the pushed stats to the toolbar count immediately so the badge
  // converges with the dropdown without waiting for the next 30s poll.
  useEffect(() => {
    const cleanup = githubClient.onRepoStatsAndPageUpdated((payload) => {
      if (!mountedRef.current) return;
      // Filter by current project. Each `WebContentsView` runs its own
      // renderer with isolated module state, so the cache writes below are
      // scoped to this view's project.
      projectClient
        .getCurrent()
        .then((project) => {
          if (!project || project.path !== payload.projectPath) return;
          if (!mountedRef.current) return;
          // Defensive shape guard against future IPC drift — bad payloads
          // are skipped rather than written to cache where they would crash
          // consumers using "isDraft" in item or item.number.
          if (!isValidPagePayload(payload.issues) || !isValidPagePayload(payload.prs)) return;

          // Stats freshness guard: compare the broadcast's `stats.lastUpdated`
          // (the actual GitHub API fetch time) to whatever we last applied.
          // Same units on both sides since the helper writes
          // `lastUpdatedRef.current = repoStats.lastUpdated`. Using `fetchedAt`
          // here would be over-permissive — `fetchedAt` is set later in the
          // broadcast call chain than `stats.lastUpdated` and would let an
          // older fetch's payload through if a long commit-count lookup
          // delayed the broadcast.
          const pushedLastUpdated = payload.stats.lastUpdated ?? null;
          const skipStats =
            pushedLastUpdated !== null &&
            lastUpdatedRef.current !== null &&
            pushedLastUpdated <= lastUpdatedRef.current;

          // Cache freshness guard: the renderer cache may have been written by
          // a more-recent SWR revalidation in `GitHubResourceList` whose
          // timestamp is independent of `lastUpdatedRef`. Don't downgrade a
          // fresher entry — same pattern as the disk-hydration block above.
          const issuesKey = buildCacheKey(payload.projectPath, "issue", "open", "created");
          const prsKey = buildCacheKey(payload.projectPath, "pr", "open", "created");
          const existingIssues = getCache(issuesKey);
          const existingPRs = getCache(prsKey);
          if (!existingIssues || existingIssues.timestamp < payload.fetchedAt) {
            setCache(issuesKey, {
              items: payload.issues.items,
              endCursor: payload.issues.endCursor,
              hasNextPage: payload.issues.hasNextPage,
              timestamp: payload.fetchedAt,
            });
          }
          if (!existingPRs || existingPRs.timestamp < payload.fetchedAt) {
            setCache(prsKey, {
              items: payload.prs.items,
              endCursor: payload.prs.endCursor,
              hasNextPage: payload.prs.hasNextPage,
              timestamp: payload.fetchedAt,
            });
          }

          if (!skipStats) {
            applyStatsResult(payload.stats, { projectPath: payload.projectPath });
          }
        })
        .catch(() => {
          // Project lookup races during teardown / project switch are
          // expected and benign — swallow rather than producing an
          // unhandled rejection.
        });
    });
    return cleanup;
  }, [applyStatsResult]);

  useEffect(() => {
    const cleanup = githubClient.onRateLimitChanged((payload) => {
      if (!mountedRef.current) return;
      const nextResetAt = payload.blocked && payload.resetAt ? payload.resetAt : null;
      const nextKind = payload.blocked ? payload.kind : null;
      rateLimitResetAtRef.current = nextResetAt;
      setRateLimitResetAt(nextResetAt);
      setRateLimitKind(nextKind);

      // Cancel any pending poll scheduled against the old state so it
      // can't race with the state-change handler (e.g. firing a
      // redundant fetch right after our immediate refresh kicks off).
      if (pollTimerRef.current) {
        clearTimeout(pollTimerRef.current);
        pollTimerRef.current = null;
      }

      // When the limit clears, run an immediate refresh so the UI updates
      // without waiting a full poll interval; otherwise reschedule against
      // the new resume time.
      if (!payload.blocked) {
        void fetchStats().then(() => {
          if (mountedRef.current) {
            scheduleNextPoll();
          }
        });
      } else if (mountedRef.current) {
        scheduleNextPoll();
      }
    });
    return cleanup;
  }, [fetchStats, scheduleNextPoll]);

  const isTokenError = isTokenRelatedError(error);

  return {
    stats,
    loading,
    error,
    isTokenError,
    isStale,
    lastUpdated,
    rateLimitResetAt,
    rateLimitKind,
    refresh,
  };
}
