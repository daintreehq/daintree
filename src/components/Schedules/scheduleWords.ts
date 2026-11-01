import { machineTimeZone, nextCronOccurrence } from "@shared/utils/cron";
import { describeParsedCron } from "@shared/utils/cronDescription";
import { validateCadence } from "@shared/utils/scheduledRuns";
import type {
  ScheduleCadence,
  ScheduleDonePolicy,
  ScheduleMissedRunPolicy,
  ScheduleOverlapPolicy,
} from "@shared/types/scheduledRuns";

/** The cadence in words, or null when it has no short reading and the expression has to speak for itself. */
export function cadenceWords(cadence: ScheduleCadence): string | null {
  const validation = validateCadence(cadence);
  return validation.ok ? describeParsedCron(validation.cron) : null;
}

/** When the schedule next fires after `now`, or null when its cadence can't be read. */
export function nextRunAt(cadence: ScheduleCadence, now: number): number | null {
  const validation = validateCadence(cadence);
  if (!validation.ok) return null;
  try {
    return nextCronOccurrence(validation.cron, validation.timeZone, now);
  } catch {
    return null;
  }
}

/**
 * A run's instant as the schedule's own zone reads it ("Mon, Nov 2, 2:00 AM").
 * The zone is named only when it isn't this machine's: a schedule keeps the zone
 * it was made in, so after travel its times are not the clock on the wall.
 */
export function formatRunInstant(epochMs: number, timeZone: string): string {
  const foreign = timeZone !== machineTimeZone();
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone,
    ...(foreign ? { timeZoneName: "short" } : {}),
  }).format(epochMs);
}

const RELATIVE = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

/** The local calendar date of an instant in a zone, as a day count for subtraction. */
function localDayNumber(epochMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).formatToParts(epochMs);
  const read = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  return Math.round(Date.UTC(read("year"), read("month") - 1, read("day")) / 86_400_000);
}

/**
 * How soon a run is: minutes, then hours within a day, then calendar days in the
 * schedule's zone, so 3:15 AM the day after tomorrow never reads "tomorrow".
 */
export function formatNextRunRelative(epochMs: number, now: number, timeZone: string): string {
  const minutes = Math.round((epochMs - now) / 60_000);
  if (minutes < 1) return "in under a minute";
  if (minutes < 60) return RELATIVE.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (hours < 24) return RELATIVE.format(hours, "hour");
  return RELATIVE.format(localDayNumber(epochMs, timeZone) - localDayNumber(now, timeZone), "day");
}

export const MISSED_RUN_OPTIONS: readonly { value: ScheduleMissedRunPolicy; label: string }[] = [
  { value: "run-once-late", label: "Run once late" },
  { value: "skip", label: "Skip" },
];

export const MISSED_RUN_CONSEQUENCE: Record<ScheduleMissedRunPolicy, string> = {
  "run-once-late":
    "Runs missed while the computer slept or Daintree was closed catch up as one run when it's back",
  skip: "Runs missed while the computer slept or Daintree was closed are recorded as skipped",
};

export const OVERLAP_OPTIONS: readonly { value: ScheduleOverlapPolicy; label: string }[] = [
  { value: "skip", label: "Skip" },
  { value: "start-another", label: "Start another" },
  { value: "replace", label: "Replace" },
];

export const OVERLAP_CONSEQUENCE: Record<ScheduleOverlapPolicy, string> = {
  skip: "The new run is skipped while the last one is still going",
  "start-another": "The new run starts alongside the one still going",
  replace: "The run still going is stopped and the new one takes its place",
};

export const DONE_OPTIONS: readonly { value: ScheduleDonePolicy; label: string }[] = [
  { value: "keep", label: "Keep" },
  { value: "background", label: "Background" },
  { value: "close", label: "Close" },
];

export const DONE_CONSEQUENCE: Record<ScheduleDonePolicy, string> = {
  keep: "The terminal stays where it opened",
  background: "The terminal moves to the background, still running",
  close: "The terminal closes; its conversation can still be resumed",
};
