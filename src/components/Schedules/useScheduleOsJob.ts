import { useCallback, useEffect, useRef, useState } from "react";
import { schedulesClient } from "@/clients/schedulesClient";
import type { ScheduleOsJobStatus } from "@shared/types/ipc/schedules";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { logError } from "@/utils/logger";

export interface ScheduleOsJobState<B> {
  status: ScheduleOsJobStatus | null;
  /** A repair asked for and not yet answered. */
  repairing: boolean;
  /** Why the status or the repair couldn't be read; the last status stays up. */
  error: string | null;
  /**
   * What the caller passed as `basis` when the read that answered last was
   * asked, so the answer is shown against the schedules it describes rather
   * than ones changed since. Null before any answer.
   */
  basis: B | null;
}

/**
 * The OS job that starts Daintree for schedules when it isn't running
 * (#15990), read while the view is open and again after each schedule
 * change: main answers once the change has reached the job. A reply to an
 * older read never replaces a newer one. `checking` holds from a change until
 * the read made after it answers.
 */
export function useScheduleOsJob<B = null>(
  enabled: boolean,
  schedulesRevision: number | null,
  basis?: B
) {
  const [state, setState] = useState<ScheduleOsJobState<B> & { answeredRevision: number | null }>({
    status: null,
    repairing: false,
    error: null,
    basis: null,
    answeredRevision: null,
  });
  const latest = useRef(0);
  // Read when an ask goes out, so an answer carries what it was asked about.
  const basisRef = useRef<B | null>(basis ?? null);
  const revisionRef = useRef<number | null>(schedulesRevision);
  useEffect(() => {
    basisRef.current = basis ?? null;
    revisionRef.current = schedulesRevision;
  });

  useEffect(() => {
    if (!enabled || schedulesRevision === null) return;
    const ask = ++latest.current;
    const askedAbout = basisRef.current;
    schedulesClient
      .osJobStatus()
      .then((status) => {
        if (ask !== latest.current) return;
        setState((prev) => ({
          ...prev,
          status,
          error: null,
          basis: askedAbout,
          answeredRevision: schedulesRevision,
        }));
      })
      .catch((error: unknown) => {
        if (ask !== latest.current) return;
        logError("Failed to read the schedules' OS job", error);
        setState((prev) => ({
          ...prev,
          error: formatErrorMessage(error, "Couldn't check the job that starts Daintree"),
          basis: askedAbout,
          answeredRevision: schedulesRevision,
        }));
      });
    return () => {
      // A closed view or a newer read: this answer is no longer wanted.
      if (ask === latest.current) latest.current += 1;
    };
  }, [enabled, schedulesRevision]);

  const repair = useCallback(() => {
    const ask = ++latest.current;
    const askedAbout = basisRef.current;
    const revision = revisionRef.current;
    setState((prev) => ({ ...prev, repairing: true, error: null }));
    schedulesClient
      .repairOsJob()
      .then((status) => {
        if (ask !== latest.current) return;
        setState((prev) => ({
          ...prev,
          status,
          error: null,
          basis: askedAbout,
          answeredRevision: revision,
        }));
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

  const { answeredRevision, ...rest } = state;
  const checking = enabled && schedulesRevision !== null && answeredRevision !== schedulesRevision;
  return { ...rest, checking, repair };
}
