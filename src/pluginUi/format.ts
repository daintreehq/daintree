// The host's formatters, copied rather than imported: these are synchronous
// functions, so they cannot sit behind the kit's lazy chunk, and a static
// import of `src/utils` or `src/lib` from this facade would pull app modules
// into the plugin-ui chunk's static graph. `__tests__/format.test.ts` pins
// each one to the host function it copies, so the two cannot drift.

let mediumDateFormatter: Intl.DateTimeFormat | undefined;
let currentYearFormatter: Intl.DateTimeFormat | undefined;
let relativeTimeFormatter: Intl.RelativeTimeFormat | undefined;

const RELATIVE_TIME_CUTOFF_MS = 30 * 24 * 60 * 60 * 1000;

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

function formatAbsoluteDate(timestamp: number, now: number): string {
  const date = new Date(timestamp);
  if (date.getFullYear() !== new Date(now).getFullYear()) {
    return (mediumDateFormatter ??= new Intl.DateTimeFormat(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    })).format(date);
  }
  return (currentYearFormatter ??= new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
  })).format(date);
}

/**
 * Compact relative time for tight rows: "just now", "5m ago", "11d ago", then
 * the date ("Sep 1") past 30 days. Takes epoch ms, an ISO string or a Date.
 */
export function formatTimeAgo(value: number | string | Date, now?: number): string {
  const timestamp = toTimestamp(value);
  if (Number.isNaN(timestamp)) return "Unknown";
  const current = clock(now);
  const seconds = Math.floor((current - timestamp) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < RELATIVE_TIME_CUTOFF_MS / 1000) return `${Math.floor(seconds / 86400)}d ago`;
  return formatAbsoluteDate(timestamp, current);
}

/**
 * Spelled-out relative time for tables and logs with the width for it:
 * "5 minutes ago", "in 3 hours". Past 30 days a past time becomes its date.
 */
export function formatRelativeTime(value: number | string | Date, now?: number): string {
  const epochMs = toTimestamp(value);
  if (Number.isNaN(epochMs)) return "Unknown";
  const current = clock(now);
  if (current - epochMs >= RELATIVE_TIME_CUTOFF_MS) return formatAbsoluteDate(epochMs, current);
  const formatter = (relativeTimeFormatter ??= new Intl.RelativeTimeFormat("en", {
    numeric: "auto",
  }));
  const deltaSeconds = Math.round((epochMs - current) / 1000);
  if (Math.abs(deltaSeconds) < 60) return formatter.format(deltaSeconds, "second");
  const deltaMinutes = Math.round(deltaSeconds / 60);
  if (Math.abs(deltaMinutes) < 60) return formatter.format(deltaMinutes, "minute");
  const deltaHours = Math.round(deltaMinutes / 60);
  if (Math.abs(deltaHours) < 24) return formatter.format(deltaHours, "hour");
  return formatter.format(Math.round(deltaHours / 24), "day");
}

const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB"] as const;

/** A size in 1024 steps, one decimal at most: "0 B", "512 B", "1.5 KB", "3 MB". */
export function formatBytes(bytes: number): string {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const k = 1024;
  const unit = Math.max(
    0,
    Math.min(Math.floor(Math.log(bytes) / Math.log(k)), BYTE_UNITS.length - 1)
  );
  const rounded = parseFloat((bytes / Math.pow(k, unit)).toFixed(1));
  if (rounded >= k && unit < BYTE_UNITS.length - 1) {
    return `${parseFloat((rounded / k).toFixed(1))} ${BYTE_UNITS[unit + 1]}`;
  }
  return `${rounded} ${BYTE_UNITS[unit]}`;
}

const COUNT_UNITS: ReadonlyArray<readonly [number, string]> = [
  [1_000_000_000, "B"],
  [1_000_000, "M"],
  [1_000, "k"],
];

/**
 * A count for a badge: exact below 1,000, then "1.2k", "23k", "1.2M", never
 * wider than four characters. Truncates rather than rounds, so it never claims
 * more than there is. Put the exact number in the tooltip or accessible name.
 */
export function formatCount(count: number): string {
  if (typeof count !== "number" || !Number.isFinite(count) || count < 1_000) return String(count);
  for (const [size, suffix] of COUNT_UNITS) {
    if (count < size) continue;
    const tenths = Math.floor((count * 10) / size);
    return tenths < 100 ? `${tenths / 10}${suffix}` : `${Math.floor(count / size)}${suffix}`;
  }
  return String(count);
}

/** An elapsed time in ms, two units at most: "45s", "12m", "3h 5m", "2d 4h". */
export function formatDuration(ms: number): string {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) return "0s";
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${seconds}s`;
}
