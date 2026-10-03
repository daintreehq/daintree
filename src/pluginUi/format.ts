// The host's formatters, served to plugins. These are leaf modules with no app
// imports, so the facade can import them statically. The wrappers below only
// make a plugin's untyped input safe (a Date, a non-number, a bad clock)
// before delegating; the label itself always comes from the host function.
import { formatTimeAgo as hostTimeAgo } from "@/utils/timeAgo";
import { formatRelativeTime as hostRelativeTime } from "@/lib/formatRelativeTime";
import { formatBytes as hostBytes } from "@/lib/formatBytes";

export { formatCompactCount as formatCount } from "@/lib/formatCount";
export { formatElapsedDuration as formatDuration } from "@/utils/formatElapsedDuration";

// Through `Date` for numbers too, so an out-of-range or infinite timestamp is
// NaN ("Unknown") as it is in the host, never a label or an Intl throw.
function toTimestamp(value: unknown): number {
  if (typeof value === "number" || typeof value === "string" || value instanceof Date) {
    return new Date(value).getTime();
  }
  return Number.NaN;
}

function clock(now: unknown): number {
  return typeof now === "number" && Number.isFinite(now) ? now : Date.now();
}

/**
 * Compact relative time for tight rows: "just now", "5m ago", "11d ago", then
 * the date ("Sep 1") past 30 days. Takes epoch ms, an ISO string or a Date.
 */
function pluginTimeAgo(value: number | string | Date, now?: number): string {
  const timestamp = toTimestamp(value);
  if (Number.isNaN(timestamp)) return "Unknown";
  return hostTimeAgo(timestamp, clock(now));
}

/**
 * Spelled-out relative time for tables and logs with the width for it:
 * "5 minutes ago", "in 3 hours". Past 30 days a past time becomes its date.
 */
function pluginRelativeTime(value: number | string | Date, now?: number): string {
  const timestamp = toTimestamp(value);
  if (Number.isNaN(timestamp)) return "Unknown";
  return hostRelativeTime(timestamp, clock(now));
}

/** A size in 1024 steps, one decimal at most: "0 B", "512 B", "1.5 KB", "3 MB". */
function pluginBytes(bytes: number): string {
  if (typeof bytes !== "number" || !Number.isFinite(bytes)) return "0 B";
  return hostBytes(bytes);
}

export {
  pluginTimeAgo as formatTimeAgo,
  pluginRelativeTime as formatRelativeTime,
  pluginBytes as formatBytes,
};
