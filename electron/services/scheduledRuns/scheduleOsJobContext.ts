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
 * The zone launchd reads its calendars in: the system's, from the
 * `/etc/localtime` link, not this process's `Intl` zone, which a `TZ` in the
 * environment Daintree was started from can move. Null when neither names a
 * zone, never UTC by default.
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

/** This machine's OS job, read fresh each time: the system zone can change while Daintree runs. */
export function scheduleOsJobContext(
  platform: NodeJS.Platform = process.platform
): ScheduleOsJobContext {
  if (platform !== "darwin") return { kind: null, systemTimeZone: null };
  return { kind: "launch-agent", systemTimeZone: readSystemTimeZone() };
}

/** The store's check on a schedule about to be written with the option on. */
export function runWhenClosedWriteIssues(schedule: Schedule): ScheduleIssue[] {
  if (!schedule.policies.runWhenClosed) return [];
  return runWhenClosedIssues(schedule, scheduleOsJobContext());
}
