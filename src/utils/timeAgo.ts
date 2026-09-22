/**
 * Compact relative time for tight rows — "just now", "5m ago", "11d ago".
 *
 * `now` is injectable so callers can be tested against a fixed clock; it
 * defaults to the wall clock, which is what every render site wants.
 *
 * The verbose counterpart is `formatRelativeTime` in `src/lib`, which spells
 * the unit out ("11 days ago") for the settings tables and audit logs that have
 * the width for it.
 */
export function formatTimeAgo(value: number | string, now: number = Date.now()): string {
  const date = new Date(value);
  if (isNaN(date.getTime())) return "Unknown";
  const seconds = Math.floor((now - date.getTime()) / 1000);

  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 2592000) return `${Math.floor(seconds / 86400)}d ago`;
  return date.toLocaleDateString();
}
