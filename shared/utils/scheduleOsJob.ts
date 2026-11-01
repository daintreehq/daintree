import type { Schedule, ScheduleCadence } from "../types/scheduledRuns.js";
import { launchdCalendarFor } from "./launchdCalendar.js";
import type { ScheduleIssue } from "./scheduleValidation.js";
import { systemdCalendarFor } from "./systemdCalendar.js";

/**
 * The OS job that starts Daintree for schedules when it isn't running: a
 * LaunchAgent on macOS (#15990), a `systemd --user` timer on Linux (#15991).
 */
export type ScheduleOsJobKind = "launch-agent" | "systemd-timer";

/**
 * What decides whether a schedule can use the OS job on this machine. Main
 * reads it and hands the renderer the same values, so the editor refuses
 * what main would.
 */
export interface ScheduleOsJobContext {
  /** Null on a platform with no OS job yet. */
  readonly kind: ScheduleOsJobKind | null;
  /** The zone the OS reads the job's calendar in; null when it couldn't be read. */
  readonly systemTimeZone: string | null;
}

export const RUN_WHEN_CLOSED_PATH = "policies.runWhenClosed";

/**
 * Why a cadence can't start Daintree when it isn't running, or null when it
 * can. Main refuses to store the option on with a reason; a stored schedule
 * that stops qualifying (the machine's zone changed) is left out of the job.
 */
export function runWhenClosedIssue(
  cadence: Pick<ScheduleCadence, "cron" | "timeZone">,
  context: ScheduleOsJobContext
): string | null {
  if (context.kind === null) {
    return "Starting Daintree for a schedule isn't available on this platform yet";
  }
  if (context.kind === "systemd-timer") {
    if (context.systemTimeZone === null) return "Couldn't read this computer's time zone";
    const calendar = systemdCalendarFor(cadence, context.systemTimeZone);
    return calendar.ok ? null : calendar.reason;
  }
  if (context.systemTimeZone === null) return "Couldn't read this Mac's time zone";
  const calendar = launchdCalendarFor(cadence, context.systemTimeZone);
  return calendar.ok ? null : calendar.reason;
}

/** The option's issue for a schedule about to be stored; none while it's off. */
export function runWhenClosedIssues(
  schedule: Schedule,
  context: ScheduleOsJobContext
): ScheduleIssue[] {
  if (!schedule.policies.runWhenClosed) return [];
  const message = runWhenClosedIssue(schedule.cadence, context);
  return message === null ? [] : [{ path: RUN_WHEN_CLOSED_PATH, cronField: null, message }];
}
