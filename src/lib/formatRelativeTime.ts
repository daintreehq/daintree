const RELATIVE_TIME_FORMATTER = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

export function formatRelativeTime(epochMs: number, now: number = Date.now()): string {
  const deltaSeconds = Math.round((epochMs - now) / 1000);
  const absSeconds = Math.abs(deltaSeconds);
  if (absSeconds < 60) return RELATIVE_TIME_FORMATTER.format(deltaSeconds, "second");
  const deltaMinutes = Math.round(deltaSeconds / 60);
  if (Math.abs(deltaMinutes) < 60) return RELATIVE_TIME_FORMATTER.format(deltaMinutes, "minute");
  const deltaHours = Math.round(deltaMinutes / 60);
  if (Math.abs(deltaHours) < 24) return RELATIVE_TIME_FORMATTER.format(deltaHours, "hour");
  const deltaDays = Math.round(deltaHours / 24);
  return RELATIVE_TIME_FORMATTER.format(deltaDays, "day");
}
