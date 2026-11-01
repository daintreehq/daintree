import { useCallback, useEffect, useRef, useState } from "react";
import { schedulesClient } from "@/clients/schedulesClient";
import type { ScheduleOsJobStatus } from "@shared/types/ipc/schedules";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { logError } from "@/utils/logger";

export interface ScheduleOsJobState {
  status: ScheduleOsJobStatus | null;
  /** A repair asked for and not yet answered. */
  repairing: boolean;
  /** Why the status or the repair couldn't be read; the last status stays up. */
  error: string | null;
}

/**
 * The OS job that starts Daintree for schedules when it isn't running
 * (#15990), read while the dialog is open and again after each schedule
 * change: main answers once the change has reached the job. A reply to an
 * older read never replaces a newer one.
 */
export function useScheduleOsJob(enabled: boolean, schedulesRevision: number | null) {
  const [state, setState] = useState<ScheduleOsJobState>({
    status: null,
    repairing: false,
    error: null,
  });
  const latest = useRef(0);

  useEffect(() => {
    if (!enabled || schedulesRevision === null) return;
    const ask = ++latest.current;
    schedulesClient
      .osJobStatus()
      .then((status) => {
        if (ask === latest.current) setState((prev) => ({ ...prev, status, error: null }));
      })
      .catch((error: unknown) => {
        if (ask !== latest.current) return;
        logError("Failed to read the schedules' OS job", error);
        setState((prev) => ({
          ...prev,
          error: formatErrorMessage(error, "Couldn't check the job that starts Daintree"),
        }));
      });
    return () => {
      // A closed dialog or a newer read: this answer is no longer wanted.
      if (ask === latest.current) latest.current += 1;
    };
  }, [enabled, schedulesRevision]);

  const repair = useCallback(() => {
    const ask = ++latest.current;
    setState((prev) => ({ ...prev, repairing: true, error: null }));
    schedulesClient
      .repairOsJob()
      .then((status) => {
        if (ask === latest.current) setState((prev) => ({ ...prev, status, error: null }));
      })
      .catch((error: unknown) => {
        logError("Failed to repair the schedules' OS job", error);
        if (ask !== latest.current) return;
        setState((prev) => ({
          ...prev,
          error: formatErrorMessage(error, "Couldn't repair the job that starts Daintree"),
        }));
      })
      // Even when a newer read took over the answer, the repair itself is over.
      .finally(() => setState((prev) => ({ ...prev, repairing: false })));
  }, []);

  return { ...state, repair };
}
