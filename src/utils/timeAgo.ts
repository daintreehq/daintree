// Lazy module-level singletons — Intl formatter construction is expensive and
// the options never vary, so don't rebuild them on every virtualized row mount.
let absoluteFormatter: Intl.DateTimeFormat | undefined;
let currentYearFormatter: Intl.DateTimeFormat | undefined;

/**
 * The full date with a named month ("May 6, 2026"). Explicit fields rather than
 * `dateStyle: "medium"`, which is numeric in some locales (de-DE "06.05.2026").
 */
export function formatMediumDate(timestamp: number): string {
  return (absoluteFormatter ??= new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  })).format(new Date(timestamp));
}

/**
 * The compact absolute label every relative-time formatter falls back to past
 * 30 days. The year is dropped while it is the current one: it carries no
 * information there, and "May 6, 2026" takes nearly twice the width of "May 6"
 * from whatever text the label sits beside. Never a numeric date — "9/1/2026"
 * reads differently in every locale and looks like a different kind of value
 * from the "5d ago" in the row above it.
 */
export function formatAbsoluteDate(timestamp: number, now: number): string {
  const date = new Date(timestamp);
  if (date.getFullYear() !== new Date(now).getFullYear()) {
    return formatMediumDate(timestamp);
  }
  return (currentYearFormatter ??= new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
  })).format(date);
}

/** Past this age a relative label stops being useful and the date takes over. */
export const RELATIVE_TIME_CUTOFF_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Compact relative time for tight rows — "just now", "5m ago", "11d ago", then
 * "Sep 1" past 30 days.
 *
 * `now` is injectable so callers can be tested against a fixed clock; it
 * defaults to the wall clock, which is what every render site wants.
 *
 * The verbose counterpart is `formatRelativeTime` in `src/lib`, which spells
 * the unit out ("11 days ago") for the settings tables and audit logs that have
 * the width for it. Render either through `TimeAgo` (or `LiveTimeAgo` when the
 * label has to tick) so the exact time is one hover away.
 */
export function formatTimeAgo(value: number | string, now: number = Date.now()): string {
  const date = new Date(value);
  if (isNaN(date.getTime())) return "Unknown";
  const seconds = Math.floor((now - date.getTime()) / 1000);

  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < RELATIVE_TIME_CUTOFF_MS / 1000) return `${Math.floor(seconds / 86400)}d ago`;
  return formatAbsoluteDate(date.getTime(), now);
}

/**
 * The one "when did we last look" label: "Last checked 5m ago". Compact, no
 * trailing period, so it reads the same as a settings description, a popover
 * footer or a chip's tooltip.
 */
export function formatLastChecked(value: number | string, now: number = Date.now()): string {
  return `Last checked ${formatTimeAgo(value, now)}`;
}
