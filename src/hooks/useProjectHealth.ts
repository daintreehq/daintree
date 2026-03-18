import { useState, useEffect, useCallback, useRef } from "react";
import type { ProjectHealthData } from "../types";
import { githubClient, projectClient } from "@/clients";

const ACTIVE_POLL_INTERVAL = 30 * 1000;
const IDLE_POLL_INTERVAL = 5 * 60 * 1000;
const ERROR_BACKOFF_INTERVAL = 2 * 60 * 1000;

export interface UseProjectHealthReturn {
  health: ProjectHealthData | null;
  loading: boolean;
  error: string | null;
  lastUpdated: number | null;
  refresh: (options?: { force?: boolean }) => Promise<void>;
}

export function useProjectHealth(): UseProjectHealthReturn {
  const [health, setHealth] = useState<ProjectHealthData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);

  const pollTimerRef = useRef<NodeJS.Timeout | null>(null);
  const isVisibleRef = useRef(!document.hidden);
  const mountedRef = useRef(true);
  const lastErrorRef = useRef<string | null>(null);
  const inFlightRef = useRef(false);
  const queuedFetchRef = useRef<{ pending: boolean; force: boolean }>({
    pending: false,
    force: false,
  });

  const fetchHealth = useCallback(async (force = false) => {
    if (inFlightRef.current) {
      queuedFetchRef.current.pending = true;
      queuedFetchRef.current.force = queuedFetchRef.current.force || force;
      return;
    }

    try {
      inFlightRef.current = true;

      const project = await projectClient.getCurrent();
      if (!project) {
        if (mountedRef.current) {
          setHealth(null);
          setError(null);
          setLastUpdated(null);
          lastErrorRef.current = null;
        }
        return;
      }

      setLoading(true);

      const result = await githubClient.getProjectHealth(project.path, force);

      if (mountedRef.current) {
        setHealth(result);
        setLastUpdated(result.lastUpdated ?? null);

        if (result.error) {
          setError(result.error);
          lastErrorRef.current = result.error;
        } else {
          setError(null);
          lastErrorRef.current = null;
        }
      }
    } catch (err) {
      if (mountedRef.current) {
        const errorMessage = err instanceof Error ? err.message : "Failed to fetch project health";
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
        void fetchHealth(queuedForce);
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

    pollTimerRef.current = setTimeout(() => {
      fetchHealth().then(() => {
        if (mountedRef.current) {
          scheduleNextPoll();
        }
      });
    }, interval);
  }, [fetchHealth]);

  const refresh = useCallback(
    async (options?: { force?: boolean }) => {
      if (pollTimerRef.current) {
        clearTimeout(pollTimerRef.current);
        pollTimerRef.current = null;
      }
      await fetchHealth(options?.force ?? false);
      if (mountedRef.current) {
        scheduleNextPoll();
      }
    },
    [fetchHealth, scheduleNextPoll]
  );

  useEffect(() => {
    const handleVisibilityChange = () => {
      isVisibleRef.current = !document.hidden;

      if (pollTimerRef.current) {
        clearTimeout(pollTimerRef.current);
        pollTimerRef.current = null;
      }

      if (isVisibleRef.current) {
        fetchHealth().then(() => {
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
  }, [fetchHealth, scheduleNextPoll]);

  useEffect(() => {
    mountedRef.current = true;

    return () => {
      mountedRef.current = false;
      queuedFetchRef.current = { pending: false, force: false };
      if (pollTimerRef.current) {
        clearTimeout(pollTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    fetchHealth().then(() => {
      if (mountedRef.current) {
        scheduleNextPoll();
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const handleSidebarRefresh = () => {
      void refresh({ force: true });
    };
    window.addEventListener("canopy:refresh-sidebar", handleSidebarRefresh);
    return () => {
      window.removeEventListener("canopy:refresh-sidebar", handleSidebarRefresh);
    };
  }, [refresh]);

  useEffect(() => {
    const cleanup = projectClient.onSwitch(() => {
      if (pollTimerRef.current) {
        clearTimeout(pollTimerRef.current);
        pollTimerRef.current = null;
      }

      setHealth(null);
      setLastUpdated(null);

      fetchHealth().then(() => {
        if (mountedRef.current) {
          scheduleNextPoll();
        }
      });
    });

    return cleanup;
  }, [fetchHealth, scheduleNextPoll]);

  return {
    health,
    loading,
    error,
    lastUpdated,
    refresh,
  };
}
