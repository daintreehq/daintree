export interface FormatElapsedDurationOptions {
  /**
   * Keep sub-minute precision for measurements rather than wall-clock spans:
   * "3.2ms" (one decimal under 10ms), "812ms", then "1.5s" up to a minute.
   * Past a minute the output is the same as without it.
   */
  subSecond?: boolean;
}

export function formatElapsedDuration(ms: number, options?: FormatElapsedDurationOptions): string {
  if (options?.subSecond === true && Number.isFinite(ms) && ms >= 0 && ms < 59_950) {
    // Thresholds sit at the rounding edge so 9.96 never prints "10.0ms".
    if (ms < 9.95) return `${ms.toFixed(1)}ms`;
    if (ms < 999.5) return `${Math.round(ms)}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
  }

  if (!Number.isFinite(ms) || ms <= 0) return "0s";

  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) {
    return `${days}d ${hours % 24}h`;
  }
  if (hours > 0) {
    return `${hours}h ${minutes % 60}m`;
  }
  if (minutes > 0) {
    return `${minutes}m`;
  }
  return `${seconds}s`;
}
