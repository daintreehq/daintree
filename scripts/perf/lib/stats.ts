import type { MetricStat } from "../types";

export function mean(values: number[]): number {
  if (values.length === 0) return 0;
  const total = values.reduce((sum, value) => sum + value, 0);
  return total / values.length;
}

export function stdDev(values: number[]): number {
  if (values.length <= 1) return 0;
  const mu = mean(values);
  const variance =
    values.reduce((sum, value) => {
      const delta = value - mu;
      return sum + delta * delta;
    }, 0) / values.length;
  return Math.sqrt(variance);
}

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  if (p <= 0) return Math.min(...values);
  if (p >= 100) return Math.max(...values);

  const sorted = [...values].sort((a, b) => a - b);
  const rank = (p / 100) * (sorted.length - 1);
  const lowerIndex = Math.floor(rank);
  const upperIndex = Math.ceil(rank);

  if (lowerIndex === upperIndex) {
    return sorted[lowerIndex];
  }

  const lowerWeight = upperIndex - rank;
  const upperWeight = rank - lowerIndex;
  return sorted[lowerIndex] * lowerWeight + sorted[upperIndex] * upperWeight;
}

export function round(value: number, digits = 3): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/**
 * Average each metric across the samples that actually reported it. A metric
 * present in only some samples is divided by its own occurrence count, not the
 * total sample count — otherwise a sparse-but-large metric is diluted toward
 * zero and can slip under its budget ceiling.
 */
export function averageMetrics(samples: Array<Record<string, number>>): Record<string, number> {
  const sums: Record<string, number> = {};
  const counts: Record<string, number> = {};

  for (const sample of samples) {
    for (const [key, value] of Object.entries(sample)) {
      sums[key] = (sums[key] ?? 0) + value;
      counts[key] = (counts[key] ?? 0) + 1;
    }
  }

  const averages: Record<string, number> = {};
  for (const key of Object.keys(sums)) {
    averages[key] = sums[key] / counts[key];
  }
  return averages;
}

/**
 * Full spread per metric across the samples that reported it.
 *
 * `max` and `sum` are the point. For a count — process spawns, git invocations,
 * retries — the mean flattens exactly the spike worth seeing: one iteration
 * spawning 20 processes among fifteen quiet ones averages to 1.25. Denominators
 * stay per-metric for the same reason `averageMetrics` uses them: a metric only
 * some iterations emit must not be diluted by the ones that didn't.
 *
 * Non-finite samples propagate into `sum`/`max` rather than being dropped, so a
 * broken measurement stays visible instead of quietly reading as a clean one.
 */
export function aggregateMetrics(
  samples: Array<Record<string, number>>
): Record<string, MetricStat> {
  const collected = new Map<string, number[]>();

  for (const sample of samples) {
    for (const [key, value] of Object.entries(sample)) {
      const values = collected.get(key);
      if (values) values.push(value);
      else collected.set(key, [value]);
    }
  }

  const stats: Record<string, MetricStat> = {};
  for (const [key, values] of collected) {
    // Math.max/min and + all propagate NaN, which is the wanted behaviour here.
    const sum = values.reduce((acc, value) => acc + value, 0);
    const max = values.reduce((acc, value) => Math.max(acc, value), Number.NEGATIVE_INFINITY);
    const min = values.reduce((acc, value) => Math.min(acc, value), Number.POSITIVE_INFINITY);
    stats[key] = { mean: sum / values.length, max, min, sum, count: values.length };
  }
  return stats;
}
