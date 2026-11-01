import { useCallback, useEffect, useState } from "react";
import { schedulesClient } from "@/clients/schedulesClient";
import type { SchedulesSnapshot } from "@shared/types/ipc/schedules";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { logError } from "@/utils/logger";

export type ProjectSchedulesState =
  | { status: "loading"; snapshot: null }
  | { status: "ready"; snapshot: SchedulesSnapshot }
  | {
      status: "error";
      snapshot: SchedulesSnapshot | null;
      message: string;
      /** A retry is reading again; the rows already known stay up meanwhile. */
      retrying?: boolean;
    };

function newer(current: SchedulesSnapshot | null, next: SchedulesSnapshot): SchedulesSnapshot {
  // A reply and a push can cross; the higher revision is the later commit.
  if (current && current.projectId === next.projectId && current.revision >= next.revision) {
    return current;
  }
  return next;
}

/**
 * This view's project's schedules, kept current by main's `schedules:changed`
 * pushes. Subscribed before the first read so no commit between the two is missed.
 */
export function useProjectSchedules(enabled: boolean) {
  const [state, setState] = useState<ProjectSchedulesState>({ status: "loading", snapshot: null });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const take = (next: SchedulesSnapshot) => {
      if (cancelled) return;
      setState((prev) => ({ status: "ready", snapshot: newer(prev.snapshot, next) }));
    };
    const unsubscribe = schedulesClient.onChanged(take);
    schedulesClient
      .list()
      .then((snapshot) => {
        if (cancelled) return;
        if (snapshot) take(snapshot);
        else
          setState((prev) => ({
            status: "error",
            snapshot: prev.snapshot,
            message: "This window isn't showing a project yet",
          }));
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        logError("Failed to load schedules", error);
        setState((prev) => ({
          status: "error",
          snapshot: prev.snapshot,
          message: formatErrorMessage(error, "Couldn't load this project's schedules"),
        }));
      });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [enabled, attempt]);

  const retry = useCallback(() => {
    setState((prev) =>
      prev.status === "error" && prev.snapshot
        ? { ...prev, retrying: true }
        : { status: "loading", snapshot: null }
    );
    setAttempt((value) => value + 1);
  }, []);

  /** Folds a snapshot an edit answered with in, so the list doesn't wait for the push. */
  const accept = useCallback((snapshot: SchedulesSnapshot) => {
    setState((prev) => ({ status: "ready", snapshot: newer(prev.snapshot, snapshot) }));
  }, []);

  return { state, retry, accept };
}
