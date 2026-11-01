import type { Schedule, ScheduleCadence } from "../types/scheduledRuns.js";
import { launchdCalendarFor } from "./launchdCalendar.js";
import { systemdCalendarFor } from "./systemdCalendar.js";
import { fitTaskTriggers, taskSchedulerTriggersFor } from "./taskSchedulerTriggers.js";
import type { ScheduleIssue } from "./scheduleValidation.js";

/**
 * The OS job that starts Daintree for schedules when it isn't running: a
 * LaunchAgent on macOS (#15990), a `systemd --user` timer on Linux (#15991),
 * a Task Scheduler task on Windows (#15993).
 */
export type ScheduleOsJobKind = "launch-agent" | "systemd-timer" | "task-scheduler";

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
  /** Why this build can never install the job (a Microsoft Store build), or null. */
  readonly unavailable: string | null;
}

export const RUN_WHEN_CLOSED_PATH = "policies.runWhenClosed";

const PLATFORM: Record<ScheduleOsJobKind, { starter: string; machine: string }> = {
  "launch-agent": { starter: "macOS", machine: "Mac" },
  "systemd-timer": { starter: "systemd", machine: "computer" },
  "task-scheduler": { starter: "Windows", machine: "PC" },
};

/** What starts Daintree for a kind of job, as the user knows it: "macOS", "systemd", "Windows". */
export function scheduleOsJobStarter(kind: ScheduleOsJobKind): string {
  return PLATFORM[kind].starter;
}

/** What the user calls the machine a kind of job runs on: "Mac", "computer", "PC". */
export function scheduleOsJobMachine(kind: ScheduleOsJobKind): string {
  return PLATFORM[kind].machine;
}

/** A switched-on schedule with the option on, whether or not the job can start it. */
export function isRunWhenClosedOptedIn(schedule: Schedule): boolean {
  return schedule.enabled && schedule.policies.runWhenClosed;
}

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
  if (context.unavailable !== null) return context.unavailable;
  if (context.systemTimeZone === null) {
    return `Couldn't read this ${scheduleOsJobMachine(context.kind)}'s time zone`;
  }
  switch (context.kind) {
    case "launch-agent": {
      const calendar = launchdCalendarFor(cadence, context.systemTimeZone);
      return calendar.ok ? null : calendar.reason;
    }
    case "systemd-timer": {
      const calendar = systemdCalendarFor(cadence, context.systemTimeZone);
      return calendar.ok ? null : calendar.reason;
    }
    case "task-scheduler": {
      const triggers = taskSchedulerTriggersFor(cadence, context.systemTimeZone);
      return triggers.ok ? null : triggers.reason;
    }
  }
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

export interface RunWhenClosedExclusion {
  projectId: string;
  scheduleId: string;
  reason: string;
}

export interface RunWhenClosedFit {
  /** The cadences the job starts Daintree for. */
  included: Pick<ScheduleCadence, "cron" | "timeZone">[];
  /** Every opted-in schedule it leaves out, and why. */
  excluded: RunWhenClosedExclusion[];
}

/**
 * Which opted-in schedules, across every project, the machine's one job
 * starts Daintree for. A schedule whose cadence the job can't hold is left
 * out with why. Windows' task also has room for only so many triggers, so
 * there the schedules are fitted oldest first, and one that would take it
 * past its limit is left out whole while a later one may still fit.
 */
export function fitRunWhenClosed(
  snapshots: Iterable<{ projectId: string; schedules: readonly Schedule[] }>,
  context: ScheduleOsJobContext
): RunWhenClosedFit {
  const excluded: RunWhenClosedExclusion[] = [];
  const eligible: { projectId: string; schedule: Schedule }[] = [];
  for (const { projectId, schedules } of snapshots) {
    for (const schedule of schedules) {
      if (!isRunWhenClosedOptedIn(schedule)) continue;
      const reason = runWhenClosedIssue(schedule.cadence, context);
      if (reason === null) eligible.push({ projectId, schedule });
      else excluded.push({ projectId, scheduleId: schedule.id, reason });
    }
  }
  if (context.kind !== "task-scheduler" || context.systemTimeZone === null) {
    return { included: eligible.map(({ schedule }) => schedule.cadence), excluded };
  }

  const zone = context.systemTimeZone;
  eligible.sort(
    (a, b) =>
      a.schedule.createdAt - b.schedule.createdAt ||
      compare(a.projectId, b.projectId) ||
      compare(a.schedule.id, b.schedule.id)
  );
  const fit = fitTaskTriggers(
    eligible.map(({ schedule }) => {
      const result = taskSchedulerTriggersFor(schedule.cadence, zone);
      return result.ok ? result.triggers : [];
    })
  );
  const included: RunWhenClosedFit["included"] = [];
  eligible.forEach(({ projectId, schedule }, index) => {
    const reason = fit.reasons[index] ?? null;
    if (reason === null) included.push(schedule.cadence);
    else excluded.push({ projectId, scheduleId: schedule.id, reason });
  });
  return { included, excluded };
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
