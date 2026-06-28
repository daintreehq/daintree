export type MemoryState = "normal" | "elevated" | "critical";
export type TrendDirection = "up" | "down" | "stable";

export interface MemoryThresholds {
  elevated: number;
  critical: number;
}

// Fixed-MB floor used when total RAM is unknown (hardware probe failed). Matches
// the historical absolute thresholds so behaviour degrades gracefully.
export const FALLBACK_THRESHOLDS: MemoryThresholds = { elevated: 500, critical: 800 };
// Fractions of total RAM. The badge sums working-set across Daintree's Electron
// processes (renderers double-count shared pages on macOS), so this is a
// generous pressure heuristic — calibrated near ProcessMemoryMonitor's 25%
// aggregate ceiling, not a precise budget.
const ELEVATED_RAM_FRACTION = 0.2;
const CRITICAL_RAM_FRACTION = 0.33;
export const TREND_DEADBAND_MB_PER_MIN = 3;

/**
 * Derive RAM-relative memory thresholds from total system memory so the badge
 * scales with the machine instead of using fixed MB values that read as
 * "critical" on a 64 GB box and "fine" on an 8 GB one. Falls back to absolute
 * MB when total RAM is unknown.
 */
export function computeThresholds(totalMemoryBytes: number): MemoryThresholds {
  if (!Number.isFinite(totalMemoryBytes) || totalMemoryBytes <= 0) {
    return FALLBACK_THRESHOLDS;
  }
  const totalMB = totalMemoryBytes / 1024 / 1024;
  return {
    elevated: Math.round(totalMB * ELEVATED_RAM_FRACTION),
    critical: Math.round(totalMB * CRITICAL_RAM_FRACTION),
  };
}

export function getMemoryState(totalMB: number, thresholds: MemoryThresholds): MemoryState {
  if (totalMB >= thresholds.critical) return "critical";
  if (totalMB >= thresholds.elevated) return "elevated";
  return "normal";
}

export function computeSlope(samples: number[]): number {
  const n = samples.length;
  if (n < 3) return 0;
  const sumX = (n * (n - 1)) / 2;
  const sumX2 = (n * (n - 1) * (2 * n - 1)) / 6;
  const sumY = samples.reduce((a, b) => a + b, 0);
  const sumXY = samples.reduce((acc, y, i) => acc + i * y, 0);
  const denom = n * sumX2 - sumX * sumX;
  if (denom === 0) return 0;
  return (n * sumXY - sumX * sumY) / denom;
}

export function getTrendDirection(samples: number[], samplesPerMin: number): TrendDirection {
  const slopePerSample = computeSlope(samples);
  const slopePerMin = slopePerSample * samplesPerMin;
  if (Math.abs(slopePerMin) < TREND_DEADBAND_MB_PER_MIN) return "stable";
  return slopePerMin > 0 ? "up" : "down";
}

export function formatMemory(mb: number): string {
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)}GB`;
  return `${mb}MB`;
}
