// Wall-clock times for the kit TimePicker and DateTimePicker. A time is
// minutes since midnight inside the kit and `"HH:mm"` at the edges; a
// date-time is `"YYYY-MM-DDTHH:mm"`, a day and a wall time with no zone.

import { toIsoDate } from "@/pluginUi/dateMath";

export const MINUTES_PER_DAY = 24 * 60;

/** `"HH:mm"` (seconds, if given, are dropped) as minutes since midnight; null for anything else. */
export function parseIsoTime(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match = /^(\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?$/.exec(value.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

export function formatIsoTime(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  return `${String(hours).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

/** `"YYYY-MM-DDTHH:mm"` split into its day and its minutes; null unless both are real. */
export function parseIsoDateTime(value: unknown): { date: string; minutes: number } | null {
  if (typeof value !== "string") return null;
  const [datePart, timePart, extra] = value.trim().split("T");
  if (extra !== undefined || datePart === undefined || timePart === undefined) return null;
  const date = toIsoDate(datePart);
  const minutes = parseIsoTime(timePart);
  return date === null || minutes === null ? null : { date, minutes };
}

export function formatIsoDateTime(date: string, minutes: number): string {
  return `${date}T${formatIsoTime(minutes)}`;
}

let cachedHourCycle: 12 | 24 | null = null;

/** Whether the user's locale writes times on a 12-hour clock. */
export function localeHourCycle(): 12 | 24 {
  if (cachedHourCycle !== null) return cachedHourCycle;
  try {
    const cycle = new Intl.DateTimeFormat(undefined, { hour: "numeric" }).resolvedOptions()
      .hourCycle;
    cachedHourCycle = cycle === "h11" || cycle === "h12" ? 12 : 24;
  } catch {
    cachedHourCycle = 24;
  }
  return cachedHourCycle;
}

const periodNames = new Map<string, readonly [string, string]>();

/** The locale's names for the two halves of the day, "AM" and "PM" in English. */
export function dayPeriodNames(): readonly [string, string] {
  const cached = periodNames.get("default");
  if (cached) return cached;
  const read = (hour: number) => {
    try {
      const parts = new Intl.DateTimeFormat(undefined, {
        hour: "numeric",
        hourCycle: "h12",
        timeZone: "UTC",
      }).formatToParts(new Date(Date.UTC(2026, 0, 1, hour)));
      return parts.find((part) => part.type === "dayPeriod")?.value;
    } catch {
      return undefined;
    }
  };
  const names = [read(9) ?? "AM", read(21) ?? "PM"] as const;
  periodNames.set("default", names);
  return names;
}

/** "9:30 AM" or "09:30", as the list and the spoken value say a time. */
export function formatTimeLabel(minutes: number, cycle: 12 | 24): string {
  const hours = Math.floor(minutes / 60);
  const mins = String(minutes % 60).padStart(2, "0");
  if (cycle === 24) return `${String(hours).padStart(2, "0")}:${mins}`;
  const [am, pm] = dayPeriodNames();
  const twelve = hours % 12 === 0 ? 12 : hours % 12;
  return `${twelve}:${mins} ${hours < 12 ? am : pm}`;
}

/**
 * The list's spacing for an arrow-key `step`: the smallest multiple of it that
 * is at least 15 minutes, so a 1-minute step does not list 1,440 rows.
 */
export function timeListStep(step: number): number {
  return step * Math.max(1, Math.ceil(15 / step));
}

/** Every time from `min` to `max` on the list's spacing, starting at midnight. */
export function timeListOptions(step: number, min: number | null, max: number | null): number[] {
  const spacing = timeListStep(step);
  const out: number[] = [];
  for (let minutes = 0; minutes < MINUTES_PER_DAY; minutes += spacing) {
    if (min !== null && minutes < min) continue;
    if (max !== null && minutes > max) continue;
    out.push(minutes);
  }
  return out;
}

/**
 * A zone's short name for the field ("GMT+10", "PDT"), from `Intl`; null for
 * a zone the platform does not know. `now` fixes the instant, since the name
 * can change with daylight saving.
 */
export function timeZoneLabel(timeZone: string | undefined, now: number): string | null {
  try {
    const parts = new Intl.DateTimeFormat(undefined, {
      timeZone,
      timeZoneName: "short",
    }).formatToParts(new Date(now));
    return parts.find((part) => part.type === "timeZoneName")?.value ?? null;
  } catch {
    return null;
  }
}

/** The zone's full IANA id, for the label's tooltip; the user's own when none is given. */
export function resolvedTimeZone(timeZone: string | undefined): string | null {
  try {
    return new Intl.DateTimeFormat(undefined, { timeZone }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}
