import type { ReactNode } from "react";
import { RefreshCw } from "lucide-react";
import { CalendarClock } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/Callout";
import { pluralize } from "@/lib/pluralize";
import type { Schedule } from "@shared/types/scheduledRuns";
import type { ScheduleOsJobStatus as OsJobStatus } from "@shared/types/ipc/schedules";

interface ScheduleOsJobStatusProps {
  status: OsJobStatus | null;
  schedules: readonly Schedule[];
  repairing: boolean;
  /** Why the status or a repair couldn't be read. */
  error: string | null;
  onRepair: () => void;
}

/**
 * Whether the OS job that starts Daintree for this project's schedules, set
 * to run when it isn't running, is installed and current (#15990). Silent
 * while no switched-on schedule here asks for it.
 */
export function ScheduleOsJobStatus({
  status,
  schedules,
  repairing,
  error,
  onRepair,
}: ScheduleOsJobStatusProps) {
  const optedIn = schedules.filter((s) => s.enabled && s.policies.runWhenClosed);
  if (optedIn.length === 0 || (!status && !error)) return null;

  const names = new Map(schedules.map((s) => [s.id, s.name]));
  const excluded = (status?.excluded ?? []).filter((entry) => names.has(entry.scheduleId));
  const started = optedIn.length - excluded.length;
  const repairButton = (
    <Button variant="outline" size="sm" onClick={onRepair} disabled={repairing}>
      <RefreshCw />
      {repairing ? "Repairing…" : "Repair"}
    </Button>
  );

  let job: ReactNode = null;
  if (status?.unavailable) {
    job = (
      <Callout severity="warning" title="macOS can't start Daintree for these schedules">
        {status.unavailable}
      </Callout>
    );
  } else if (!status || status.state === "stale" || error) {
    job = (
      <Callout
        severity="warning"
        title="The job that starts Daintree for these schedules is out of date"
        action={repairButton}
      >
        {error ??
          status?.error ??
          "It doesn't match the schedules set to run when Daintree isn't running."}
      </Callout>
    );
  } else if (status.state === "current" && started > 0) {
    job = (
      <Callout severity="neutral" size="compact" icon={CalendarClock}>
        macOS starts Daintree without a window for {pluralize(started, "schedule")} here when
        it isn&apos;t running.
      </Callout>
    );
  }

  return (
    <div className="mb-4 flex flex-col gap-2" data-testid="schedule-os-job-status">
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
    </div>
  );
}
