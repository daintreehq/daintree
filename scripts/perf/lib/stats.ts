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
