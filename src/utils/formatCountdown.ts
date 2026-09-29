/**
 * Time remaining on a short-lived grant or hold: "4m 59s", "4m", "59s". The
 * same unit spelling as `formatElapsedDuration`, with seconds kept because the
 * decay is the signal. Callers add " left" themselves; a clock face ("4:59")
 * reads as a timestamp beside the app's other durations.
 */
export function formatCountdown(totalSeconds: number): string {
  const safe = Number.isFinite(totalSeconds) ? Math.max(0, Math.floor(totalSeconds)) : 0;
  if (safe >= 60) {
    const minutes = Math.floor(safe / 60);
    const seconds = safe % 60;
    return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  }
  return `${safe}s`;
}
