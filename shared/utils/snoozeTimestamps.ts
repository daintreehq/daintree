/**
 * Snooze duration ladder shown in the per-thread snooze picker. The four
 * options cover IDE-appropriate defer windows: same-session short defers
 * ("1h", "4h"), cross-day ("tomorrow-8am"), and full-week ("next-monday-8am").
 * Mirrors the Linear inbox model — 30-minute slots are intentionally omitted
 * because dev work happens in deep-work blocks where sub-hour defers are too
 * granular to be useful.
 */
export type SnoozeDurationOption = "1h" | "4h" | "tomorrow-8am" | "next-monday-8am";

export const SNOOZE_DURATION_OPTIONS: readonly SnoozeDurationOption[] = [
  "1h",
  "4h",
  "tomorrow-8am",
  "next-monday-8am",
] as const;

export const SNOOZE_LABEL: Record<SnoozeDurationOption, string> = {
  "1h": "For 1 hour",
  "4h": "For 4 hours",
  "tomorrow-8am": "Until tomorrow",
  "next-monday-8am": "Until next week",
};

const HOUR_MS = 60 * 60 * 1000;
const MORNING_HOUR = 8;

/**
 * Resolves a snooze duration option to an absolute epoch-ms timestamp. Uses
 * local `Date` arithmetic (matches `nextOccurrenceTimestamp` in `quietHours.ts`)
 * so DST transitions land on the user-facing wall-clock hour rather than a
 * UTC offset. The `now` parameter is injectable for tests.
 */
export function resolveSnoozeDuration(
  option: SnoozeDurationOption,
  now: Date = new Date()
): number {
  switch (option) {
    case "1h":
      return now.getTime() + HOUR_MS;
    case "4h":
      return now.getTime() + 4 * HOUR_MS;
    case "tomorrow-8am": {
      const target = new Date(now);
      target.setDate(target.getDate() + 1);
      target.setHours(MORNING_HOUR, 0, 0, 0);
      return target.getTime();
    }
    case "next-monday-8am": {
      const target = new Date(now);
      // getDay(): 0 = Sunday, 1 = Monday, …, 6 = Saturday. The picker labels
      // this slot "Until next week", so the resolved timestamp is always
      // strictly more than 24 hours out even when invoked on a Monday — the
      // user is deferring to next Monday, not today.
      const daysUntilNextMonday = (1 - target.getDay() + 7) % 7 || 7;
      target.setDate(target.getDate() + daysUntilNextMonday);
      target.setHours(MORNING_HOUR, 0, 0, 0);
      return target.getTime();
    }
  }
}
