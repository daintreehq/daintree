// Calendar-day helpers for the kit's "YYYY-MM-DD" values (Calendar, DatePicker,
// DateRangePicker). `dateMath` is the pure day arithmetic the kit's date
// components use too; it lives in `src/pluginUi` so the facade can import it
// statically and it stays in the `plugin-ui` chunk, off both the lazy kit chunk
// and the startup one. Like the formatters, these take a plugin's untyped
// input and never throw.
import {
  addDays,
  formatFieldDate,
  formatFullDate,
  formatLongDate,
  todayIso,
  toIsoDate,
} from "./dateMath";

function clock(now: unknown): number {
  return typeof now === "number" && Number.isFinite(now) ? now : Date.now();
}

/** The user's wall-clock day, "2026-09-30". `now` fixes the clock. */
function isoToday(now?: number): string {
  return todayIso(clock(now));
}

/**
 * The local calendar day an instant falls on: a `Date` or epoch ms. Null for
 * an invalid date or one outside years 1–9999.
 */
function isoFromDate(date: Date | number): string | null {
  const time = date instanceof Date ? date.getTime() : typeof date === "number" ? date : Number.NaN;
  if (!Number.isFinite(time)) return null;
  return toIsoDate(todayIso(time));
}

/**
 * The day `days` away (negative for earlier), with no daylight-saving hour to
 * move it. Held within years 1–9999; null when `day` is not a real
 * "YYYY-MM-DD" date or `days` is not a finite number.
 */
function isoAddDays(day: string, days: number): string | null {
  const iso = toIsoDate(day);
  if (iso === null || typeof days !== "number" || !Number.isFinite(days)) return null;
  return addDays(iso, Math.trunc(days));
}

const STYLES = { short: formatFieldDate, long: formatLongDate, full: formatFullDate } as const;

/**
 * A "YYYY-MM-DD" day as the kit's date fields show it: "Sep 30, 2026"
 * (`short`, the default), "September 30, 2026" (`long`) or "Wednesday,
 * September 30, 2026" (`full`). "Unknown" when it is not a real date.
 */
function formatIsoDate(day: string, style?: "short" | "long" | "full"): string {
  const iso = toIsoDate(day);
  if (iso === null) return "Unknown";
  const format = typeof style === "string" && Object.hasOwn(STYLES, style) ? STYLES[style] : null;
  return (format ?? formatFieldDate)(iso);
}

export { formatIsoDate, isoAddDays, isoFromDate, isoToday };
