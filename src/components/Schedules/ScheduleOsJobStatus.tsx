import type { ReactNode } from "react";
import { RefreshCw } from "lucide-react";
import { CalendarClock } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/Callout";
import { useDeferredLoading } from "@/hooks/useDeferredLoading";
import { UI_INLINE_LOADING_GATE_MS } from "@/lib/animationUtils";
import { pluralize } from "@/lib/pluralize";
import type { ProjectScheduleSwitches } from "@shared/types/scheduledRuns";
import type { ScheduleOsJobStatus as OsJobStatus } from "@shared/types/ipc/schedules";
import {
  projectStartsDaintree,
  runWhenClosedSchedules,
  scheduleOsJobStarter,
  type ProjectSchedules,
} from "@shared/utils/scheduleOsJob";

interface ScheduleOsJobStatusProps {
  status: OsJobStatus | null;
  /**
   * The project's switches and schedules as they were when `status` was
   * asked for, so a change shows once main has written or removed the job
   * for it. Null before the first answer.
   */
  basis: ProjectSchedules | null;
  /** The project's switches now (#16166); null before they're read. */
  switches: ProjectScheduleSwitches | null;
  /** A change hasn't been answered for yet. */
  checking: boolean;
  repairing: boolean;
  /** Why the status or a repair couldn't be read. */
  error: string | null;
  onRepair: () => void;
}

/**
 * Whether the OS job that starts Daintree for this project's schedules, set
 * to run when it isn't running, is installed and loaded (#15990, #15991,
 * #15993), shown under the project's switch for it (#16168). While the
 * project's switches leave the job out, it speaks only of a job that may need
 * repairing: one left behind starts Daintree for nothing.
 */
export function ScheduleOsJobStatus({
  status,
  basis,
  switches,
  checking,
  repairing,
  error,
  onRepair,
}: ScheduleOsJobStatusProps) {
  // A quick answer never flashes a placeholder; until it comes the last answer stays up.
  const showChecking = useDeferredLoading(checking, UI_INLINE_LOADING_GATE_MS);
  const starts = basis !== null && projectStartsDaintree(basis.switches);
  const startsNow = switches !== null && projectStartsDaintree(switches);

  if (showChecking && (starts || startsNow)) {
    return (
      <Wrapper>
        <Callout severity="neutral" size="compact" role="status">
          Checking the job that starts Daintree…
        </Callout>
      </Wrapper>
    );
  }
  if (!basis || (!status && !error)) return null;
  const stale = status?.state === "stale";
  // Switched off, a removal not yet confirmed (stale, or not read) still needs saying.
  if (!starts && !stale && !error) return null;

  const schedules = basis.schedules;
  const optedIn = runWhenClosedSchedules(basis);
  const optedInIds = new Set(optedIn.map((s) => s.id));
  const names = new Map(schedules.map((s) => [s.id, s.name]));
  const excluded = starts
    ? (status?.excluded ?? []).filter((entry) => optedInIds.has(entry.scheduleId))
    : [];
  const started = optedIn.length - excluded.length;
  const kind = status?.context.kind ?? null;
  // What starts Daintree, as the platform's own name for it.
  const starter = kind ? scheduleOsJobStarter(kind) : "This computer";
  const repairButton = (
    <Button variant="outline" size="sm" onClick={onRepair} loading={repairing}>
      <RefreshCw />
      Repair
    </Button>
  );

  let job: ReactNode = null;
  if (starts && status?.unavailable) {
    job = (
      <Callout severity="warning" title={`${starter} can't start Daintree for these schedules`}>
        {status.unavailable}
      </Callout>
    );
  } else if (!status || stale || error) {
    job = (
      <Callout
        severity="warning"
        title="The job that starts Daintree for schedules is out of date"
        action={repairButton}
      >
        {error ??
          status?.error ??
          "It doesn't match the schedules set to run when Daintree isn't running."}
      </Callout>
    );
  } else if (optedIn.length === 0) {
    job = (
      <Callout severity="neutral" size="compact" icon={CalendarClock}>
        No schedule that&apos;s on here is set to run when Daintree isn&apos;t running. Turn that on
        in a schedule&apos;s editor so Daintree starts for it.
      </Callout>
    );
  } else if (status.state === "current" && started > 0) {
    job = (
      <Callout severity="neutral" size="compact" icon={CalendarClock}>
        Installed and loaded. {starter} starts Daintree without a window for{" "}
        {pluralize(started, "schedule")} here when it isn&apos;t running.
      </Callout>
    );
  }
  if (!job && excluded.length === 0) return null;

  return (
    <Wrapper>
      {job}
      {excluded.length > 0 && (
        <Callout
          severity="warning"
          title={`${pluralize(excluded.length, "schedule")} can't start Daintree when it isn't running`}
        >
          <ul className="flex flex-col gap-1">
            {excluded.map((entry) => (
              <li key={entry.scheduleId}>
                <span className="text-text-primary">{names.get(entry.scheduleId)}</span>:{" "}
                {entry.reason}
              </li>
            ))}
          </ul>
        </Callout>
      )}
    </Wrapper>
  );
}

function Wrapper({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2" data-testid="schedule-os-job-status">
      {children}
    </div>
  );
}
