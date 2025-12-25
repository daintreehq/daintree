import { useState, useEffect, useCallback, useRef } from "react";
import type { RepositoryStats } from "../types";
import { githubClient, projectClient } from "@/clients";

const ACTIVE_POLL_INTERVAL = 30 * 1000;
const IDLE_POLL_INTERVAL = 5 * 60 * 1000;
const ERROR_BACKOFF_INTERVAL = 2 * 60 * 1000;

export interface UseRepositoryStatsReturn {
  stats: RepositoryStats | null;
  loading: boolean;
  error: string | null;
  isStale: boolean;
  lastUpdated: number | null;
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

  const pollTimerRef = useRef<NodeJS.Timeout | null>(null);
  const isVisibleRef = useRef(!document.hidden);
  const mountedRef = useRef(true);
  const lastErrorRef = useRef<string | null>(null);
  const inFlightRef = useRef(false);

  const fetchStats = useCallback(async (force = false) => {
    if (inFlightRef.current) {
      return;
    }

    try {
      inFlightRef.current = true;

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
        setStats(repoStats);
        setIsStale(repoStats.stale ?? false);
        setLastUpdated(repoStats.lastUpdated ?? null);

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const cleanup = projectClient.onSwitch(() => {
      if (pollTimerRef.current) {
        clearTimeout(pollTimerRef.current);
        pollTimerRef.current = null;
      }

      fetchStats().then(() => {
        if (mountedRef.current) {
          scheduleNextPoll();
        }
      });
    });

    return cleanup;
  }, [fetchStats, scheduleNextPoll]);

  return {
    stats,
    loading,
    error,
    isStale,
    lastUpdated,
    refresh,
  };
}
