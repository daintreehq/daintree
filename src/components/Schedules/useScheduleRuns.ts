import { useCallback, useEffect, useState } from "react";
import { schedulesClient } from "@/clients/schedulesClient";
import type { ScheduledRun } from "@shared/types/scheduledRuns";
import { logError } from "@/utils/logger";

export interface ScheduleRunsState {
  /**
   * `error`: the last read failed, so `runs` is the last good read, if any, and
   * an empty history would be a guess.
   */
  status: "loading" | "ready" | "error";
  /** Newest first, as the history lists them. */
  runs: readonly ScheduledRun[];
  /** Rises with every read that lands, so the clock can be re-read beside fresh history. */
  version: number;
  /** A retry is reading again; the runs already known stay up meanwhile. */
  retrying: boolean;
}

const LOADING: ScheduleRunsState = { status: "loading", runs: [], version: 0, retrying: false };

/**
 * One schedule's recorded runs, read again whenever main says that schedule's
 * history changed. Subscribed before the first read, so a run that starts in
 * between isn't missed. Another schedule starts from nothing rather than from
 * the last one's runs.
 */
export function useScheduleRuns(projectId: string | null, scheduleId: string | null) {
  const [state, setState] = useState<ScheduleRunsState>(LOADING);
  const [seen, setSeen] = useState(scheduleId);
  const [attempt, setAttempt] = useState(0);
  if (scheduleId !== seen) {
    setSeen(scheduleId);
    setState(LOADING);
  }

  useEffect(() => {
    if (projectId === null || scheduleId === null) return;
    let cancelled = false;
    let reads = 0;
    const read = () => {
      const ticket = ++reads;
      schedulesClient
        .listScheduleRuns(scheduleId)
        .then((runs) => {
          if (cancelled || ticket !== reads) return;
          setState((prev) => ({
            status: "ready",
            runs,
            version: prev.version + 1,
            retrying: false,
          }));
        })
        .catch((error: unknown) => {
          if (cancelled || ticket !== reads) return;
          logError("Failed to read a schedule's run history", error);
          setState((prev) => ({ ...prev, status: "error", retrying: false }));
        });
    };
    const unsubscribe = schedulesClient.onRunsChanged((payload) => {
      if (payload.projectId === projectId && payload.scheduleIds.includes(scheduleId)) read();
    });
    read();
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [projectId, scheduleId, attempt]);

  const retry = useCallback(() => {
    setState((prev) => ({ ...prev, retrying: true }));
    setAttempt((value) => value + 1);
  }, []);

  return { runsState: state, retryRuns: retry };
}
