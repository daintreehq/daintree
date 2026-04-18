import { useState, useEffect, useCallback, useRef } from "react";
import type { GitHubRateLimitKind, RepositoryStats } from "../types";
import { githubClient, projectClient } from "@/clients";
import { isTokenRelatedError } from "@/lib/githubErrors";

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

  const fetchStats = useCallback(async (force = false) => {
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

        // Track current project to detect stale fetches
        lastKnownCountsRef.current.projectPath = project.path;

        // Only preserve counts when data is stale or errored (not on successful fresh fetch)
        const shouldPreserve = repoStats.stale === true || repoStats.ghError !== undefined;

        if (shouldPreserve) {
          // Preserve last known counts during transient failures/stale data
          // Don't update preserved counts - keep the last good values
        } else {
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
        setLastUpdated(repoStats.lastUpdated ?? null);

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
      }
    } catch (err) {
      if (mountedRef.current) {
        const errorMessage =
          err instanceof Error ? err.message : "Failed to fetch repository stats";
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
  }, []);

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

      setStats(null);
      setIsStale(false);
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
