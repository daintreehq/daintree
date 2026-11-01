import { useCallback, useEffect, useState } from "react";
import { schedulesClient } from "@/clients/schedulesClient";
import type { ScheduledRun } from "@shared/types/scheduledRuns";
import { logError } from "@/utils/logger";

export interface LastRunsState {
  /**
   * `error`: the last read failed, so what's shown is the last good read, if any,
   * and "No runs yet" would be a guess.
   */
  status: "loading" | "ready" | "error";
  byScheduleId: ReadonlyMap<string, ScheduledRun>;
  /** Rises with every read that lands, so the clock can be re-read beside fresh history. */
  version: number;
}

const EMPTY: ReadonlyMap<string, ScheduledRun> = new Map();
const LOADING: LastRunsState = { status: "loading", byScheduleId: EMPTY, version: 0 };

/**
 * Each schedule's newest recorded run, read again whenever main says the
 * project's run history changed. Subscribed before the first read, so a run that
 * starts in between isn't missed. A new project, or the view closing and opening
 * again, starts from nothing rather than from the last project's runs.
 */
export function useLastRuns(projectId: string | null) {
  const [state, setState] = useState<LastRunsState>(LOADING);
  const [seenProjectId, setSeenProjectId] = useState(projectId);
  const [attempt, setAttempt] = useState(0);
  if (projectId !== seenProjectId) {
    setSeenProjectId(projectId);
    setState(LOADING);
  }

  useEffect(() => {
    if (projectId === null) return;
    let cancelled = false;
    let reads = 0;
    const read = () => {
      const ticket = ++reads;
      schedulesClient
        .listRuns(projectId)
        .then((runs) => {
          if (cancelled || ticket !== reads) return;
          // Newest first, so the first run seen for a schedule is its last.
          const byScheduleId = new Map<string, ScheduledRun>();
          for (const run of runs) {
            if (!byScheduleId.has(run.scheduleId)) byScheduleId.set(run.scheduleId, run);
          }
          setState((prev) => ({ status: "ready", byScheduleId, version: prev.version + 1 }));
        })
        .catch((error: unknown) => {
          if (cancelled || ticket !== reads) return;
          logError("Failed to read scheduled run history", error);
          setState((prev) => ({ ...prev, status: "error" }));
        });
    };
    const unsubscribe = schedulesClient.onRunsChanged((payload) => {
      if (payload.projectId === projectId) read();
    });
    read();
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [projectId, attempt]);

  const retry = useCallback(() => setAttempt((value) => value + 1), []);

  return { lastRuns: state, retryLastRuns: retry };
}
