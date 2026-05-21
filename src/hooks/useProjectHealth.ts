import { useState, useEffect, useRef } from "react";
import type { ProjectHealthData } from "../types";
// eslint-disable-next-line no-restricted-imports
import { githubClient, projectClient } from "@/clients";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { usePollingLifecycle } from "@/hooks/usePollingLifecycle";
import { useSystemWakeStore } from "@/store/systemWakeStore";

const ACTIVE_POLL_INTERVAL = 30 * 1000;
const IDLE_POLL_INTERVAL = 5 * 60 * 1000;
const ERROR_BACKOFF_INTERVAL = 2 * 60 * 1000;

export interface UseProjectHealthReturn {
  health: ProjectHealthData | null;
  loading: boolean;
  // True while a refetch is in flight regardless of whether health is already
  // available. Distinct from `loading`, which narrows to the first-fetch
  // (no-data-yet) case so background revalidations don't flash skeletons over
  // visible signals.
  isValidating: boolean;
  error: string | null;
  lastUpdated: number | null;
  refresh: (options?: { force?: boolean }) => Promise<void>;
}

export function useProjectHealth(): UseProjectHealthReturn {
  const [health, setHealth] = useState<ProjectHealthData | null>(null);
  const [loading, setLoading] = useState(false);
  const [isValidating, setIsValidating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);

  const mountedRef = useRef(true);
  const lastErrorRef = useRef<string | null>(null);
  const projectPathRef = useRef<string | null>(null);
  // Tracks whether any result has been applied to state. Mirrors the
  // `hasAppliedResultRef` pattern in `useRepositoryStats`: distinguishes the
  // first cold fetch (skeleton ok) from a background revalidation (must not
  // flash the skeleton over visible signals).
  const hasAppliedResultRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const polling = usePollingLifecycle({
    fetchFn: async ({ force, isInvalidated }) => {
      try {
        const project = await projectClient.getCurrent();
        if (!project) {
          if (mountedRef.current) {
            setHealth(null);
            setError(null);
            setLastUpdated(null);
            lastErrorRef.current = null;
            projectPathRef.current = null;
          }
          return;
        }

        if (mountedRef.current) {
          // Always signal in-flight revalidation, but only flip the skeleton
          // when no result has been applied yet — wake/focus/interval
          // refetches must not hide visible signals.
          setIsValidating(true);
          if (!hasAppliedResultRef.current) setLoading(true);
        }

        const result = await githubClient.getProjectHealth(project.path, force);

        if (!mountedRef.current) return;
        if (isInvalidated()) return;
        if (projectPathRef.current !== null && projectPathRef.current !== project.path) return;

        projectPathRef.current = project.path;
        hasAppliedResultRef.current = true;

        setHealth(result);
        setLastUpdated(result.lastUpdated ?? null);

        if (result.error) {
          setError(result.error);
          lastErrorRef.current = result.error;
        } else {
          setError(null);
          lastErrorRef.current = null;
        }
      } catch (err) {
        // Bail when the fetch was superseded — applying the old project's
        // error to the new project's state would surface a stale error and
        // push `calculateNextInterval` into ERROR_BACKOFF_INTERVAL.
        if (isInvalidated()) return;
        if (mountedRef.current) {
          const errorMessage = formatErrorMessage(err, "Failed to fetch project health");
          setError(errorMessage);
          lastErrorRef.current = errorMessage;
        }
      } finally {
        if (mountedRef.current) {
          setLoading(false);
          setIsValidating(false);
        }
      }
    },
    calculateNextInterval: ({ isVisible }) => {
      if (lastErrorRef.current) return ERROR_BACKOFF_INTERVAL;
      return isVisible ? ACTIVE_POLL_INTERVAL : IDLE_POLL_INTERVAL;
    },
    onProjectSwitch: () => {
      if (!mountedRef.current) return;
      projectPathRef.current = null;
      // Clear error state too — without this the previous project's failure
      // would carry through and `calculateNextInterval` would back off the
      // first poll of the new project by ERROR_BACKOFF_INTERVAL.
      lastErrorRef.current = null;
      hasAppliedResultRef.current = false;
      setHealth(null);
      setLastUpdated(null);
      setError(null);
      setLoading(false);
      setIsValidating(false);
    },
  });

  // Coalesce sleep-wake fetches onto the shared wake-coordinator slice
  // (#8066). Seeded with the current epoch so a late-mounting consumer never
  // fires a spurious refetch for a wake that landed before it existed.
  const wakeEpoch = useSystemWakeStore((s) => s.wakeEpoch);
  const lastSeenWakeEpochRef = useRef(useSystemWakeStore.getState().wakeEpoch);
  useEffect(() => {
    if (wakeEpoch <= lastSeenWakeEpochRef.current) return;
    lastSeenWakeEpochRef.current = wakeEpoch;
    void polling.refresh();
  }, [wakeEpoch, polling]);

  return {
    health,
    loading,
    isValidating,
    error,
    lastUpdated,
    refresh: polling.refresh,
  };
}
