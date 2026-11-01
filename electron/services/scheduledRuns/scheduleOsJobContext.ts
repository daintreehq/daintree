import { readlinkSync } from "node:fs";
import { validateTimeZone } from "../../../shared/utils/cron.js";
import {
  runWhenClosedIssues,
  type ScheduleOsJobContext,
} from "../../../shared/utils/scheduleOsJob.js";
import type { Schedule } from "../../../shared/types/scheduledRuns.js";
import type { ScheduleIssue } from "../../../shared/utils/scheduleValidation.js";

const LOCALTIME = "/etc/localtime";

/**
 * The zone launchd and the systemd user manager read their calendars in: the
 * system's, from the `/etc/localtime` link, not this process's `Intl` zone,
 * which a `TZ` in the environment Daintree was started from can move. Null
 * when neither names a zone, never UTC by default.
 */
export function readSystemTimeZone(
  readLink: (file: string) => string = readlinkSync
): string | null {
  try {
    const match = /\/zoneinfo\/(.+)$/.exec(readLink(LOCALTIME));
    if (match) {
      const zone = validateTimeZone(match[1]!);
      if (zone.ok) return zone.timeZone;
    }
  } catch {
    // No link: fall back to what the runtime reports.
  }
  try {
    const zone = validateTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone ?? "");
    return zone.ok ? zone.timeZone : null;
  } catch {
    return null;
  }
}

/**
 * Why a Microsoft Store (AppX/MSIX) build can't install the job: Windows
 * won't start an app inside `WindowsApps` by its path, and that path changes
 * with every update.
 */
export const MICROSOFT_STORE_UNAVAILABLE =
  "Windows can't start the Microsoft Store version of Daintree from a scheduled task. Install Daintree from daintree.org/download to run schedules while it isn't running";

/**
 * The zone Task Scheduler reads its triggers in: Windows' own, which the
 * runtime's `Intl` zone follows unless a `TZ` in the environment Daintree was
 * started from moves it. With one set, the PC's zone is taken as unknown
 * rather than guessed.
 */
export function readWindowsTimeZone(
  tz: string | undefined = process.env.TZ,
  runtimeZone: () => string | undefined = () => Intl.DateTimeFormat().resolvedOptions().timeZone
): string | null {
  if (tz !== undefined && tz.trim() !== "") return null;
  try {
    const zone = validateTimeZone(runtimeZone() ?? "");
    return zone.ok ? zone.timeZone : null;
  } catch {
    return null;
  }
}

/** This machine's OS job, read fresh each time: the system zone can change while Daintree runs. */
export function scheduleOsJobContext(
  platform: NodeJS.Platform = process.platform,
  windowsStore: boolean = process.windowsStore === true
): ScheduleOsJobContext {
  if (platform === "darwin") {
    return { kind: "launch-agent", systemTimeZone: readSystemTimeZone(), unavailable: null };
  }
  if (platform === "linux") {
    return { kind: "systemd-timer", systemTimeZone: readSystemTimeZone(), unavailable: null };
  }
  if (platform === "win32") {
    return {
      kind: "task-scheduler",
      systemTimeZone: readWindowsTimeZone(),
      unavailable: windowsStore ? MICROSOFT_STORE_UNAVAILABLE : null,
    };
  }
  return { kind: null, systemTimeZone: null, unavailable: null };
}

/** The store's check on a schedule about to be written with the option on. */
export function runWhenClosedWriteIssues(schedule: Schedule): ScheduleIssue[] {
  if (!schedule.policies.runWhenClosed) return [];
  return runWhenClosedIssues(schedule, scheduleOsJobContext());
}
