import type { ComparisonResult, ComparisonSample } from "../types";
import { mean, stdDev } from "./stats";

function pooledStdDev(a: number[], b: number[]): number {
  const nA = a.length;
  const nB = b.length;
  const meanA = mean(a);
  const meanB = mean(b);
  const ssA = a.reduce((sum, v) => sum + (v - meanA) ** 2, 0);
  const ssB = b.reduce((sum, v) => sum + (v - meanB) ** 2, 0);
  const pooled = (ssA + ssB) / (nA + nB - 2);
  return Math.sqrt(pooled);
}

export function cohensD(a: number[], b: number[]): number {
  const sP = pooledStdDev(a, b);
  if (sP === 0) return 0;
  return (mean(a) - mean(b)) / sP;
}

function rankData(combined: number[]): { ranks: Float64Array; tieCorrection: number } {
  const n = combined.length;
  const indexed = combined.map((v, i) => ({ v, i }));
  indexed.sort((a, b) => a.v - b.v);

  const ranks = new Float64Array(n);
  let tieCorrection = 0;
  let i = 0;

  while (i < n) {
    let j = i + 1;
    while (j < n && indexed[j].v === indexed[i].v) j++;
    const avgRank = (i + 1 + j) / 2;
    const tieCount = j - i;
    if (tieCount > 1) {
      tieCorrection += tieCount ** 3 - tieCount;
    }
    for (let k = i; k < j; k++) {
      ranks[indexed[k].i] = avgRank;
    }
    i = j;
  }

  return { ranks, tieCorrection };
}

function normalCdf(z: number): number {
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;
  const sign = z < 0 ? -1 : 1;
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + p * x);
  const y = 1 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return 0.5 * (1 + sign * y);
}

function exactMannWhitneyPValue(u: number, nA: number, nB: number): number {
  const n = nA + nB;
  const maxU = nA * nB;

  // DP: count ways to achieve each U value
  // dp[j][k] = count of arrangements of first j items (from combined set)
  //            where A-rank-sum contributions total k
  // After filling, count arrangements where A-rank-sum <= U or >= total - U
  const totalRankSum = (n * (n + 1)) / 2;

  // Build count of distributions of U statistic
  // f[u] = number of ways to get exactly U
  const f = new Float64Array(maxU + 1);
  f[0] = 1;

  for (let rank = 1; rank <= n; rank++) {
    for (let u = maxU; u >= rank; u--) {
      f[u] += f[u - rank];
    }
    for (let u = 0; u < rank && u <= maxU; u++) {
      // f[u] unchanged (can't subtract rank)
    }
  }

  // f[u] now counts ways to get rank-sum of u for the A group
  // But we need to restrict to exactly nA items selected
  // Redo with item count constraint
  const dp: Float64Array[] = [];
  dp[0] = new Float64Array(1);
  dp[0][0] = 1;

  for (let item = 1; item <= n; item++) {
    const prevMax = (item - 1) * n;
    const curMax = item * n;
    const row = new Float64Array(curMax + 1);
    for (let count = 0; count <= Math.min(item, nA); count++) {
      // Skip - we rebuild below with proper 2D DP
    }
    dp[item] = row;
  }

  // Simpler 2D DP: ways[c][s] = ways to choose c items from {1..i} with sum s
  // Only need current and previous i-level
  let prev = new Map<string, number>();
  prev.set("0,0", 1);

  for (let i = 1; i <= n; i++) {
    const next = new Map<string, number>();
    for (const [key, ways] of prev) {
      const [c, s] = key.split(",").map(Number);

      // Don't pick i
      const skipKey = `${c},${s}`;
      next.set(skipKey, (next.get(skipKey) ?? 0) + ways);

      // Pick i (add to A group)
      if (c + 1 <= nA) {
        const pickKey = `${c + 1},${s + i}`;
        next.set(pickKey, (next.get(pickKey) ?? 0) + ways);
      }
    }
    prev = next;
  }

  // Count total arrangements and those <= U
  let totalWays = 0;
  let atOrBelowU = 0;

  for (const [key, ways] of prev) {
    const [c, s] = key.split(",").map(Number);
    if (c !== nA) continue;
    totalWays += ways;
    const thisU = s - (nA * (nA + 1)) / 2;
    if (thisU <= u || thisU >= maxU - u) {
      atOrBelowU += ways;
    }
  }

  if (totalWays === 0) return 1;
  return Math.min(1, atOrBelowU / totalWays);
}

export function mannWhitneyU(
  a: number[],
  b: number[],
  options: { exact?: boolean } = {}
): { u: number; pValue: number } {
  const nA = a.length;
  const nB = b.length;

  if (nA === 0 || nB === 0) {
    return { u: 0, pValue: 1 };
  }

  const combined = [...a, ...b];
  const { ranks, tieCorrection } = rankData(combined);

  let rankSumA = 0;
  for (let i = 0; i < nA; i++) {
    rankSumA += ranks[i];
  }

  const u1 = rankSumA - (nA * (nA + 1)) / 2;
  const u2 = nA * nB - u1;
  const u = Math.min(u1, u2);

  const useExact = options.exact ?? nA + nB < 30;

  if (useExact && nA + nB <= 20) {
    const pValue = exactMannWhitneyPValue(u, nA, nB);
    return { u, pValue };
  }

  // Normal approximation with continuity correction and tie correction
  const meanU = (nA * nB) / 2;
  const sigmaSquared =
    (nA * nB * (nA + nB + 1)) / 12 - (nA * nB * tieCorrection) / (12 * (nA + nB) * (nA + nB - 1));
  const sigma = Math.sqrt(Math.max(1, sigmaSquared));

  const z = (u + 0.5 - meanU) / sigma;
  const pValue = 2 * normalCdf(z);

  return { u, pValue: Math.min(1, pValue) };
}

export function compareSamples(
  head: ComparisonSample,
  base: ComparisonSample,
  maxPValue = 0.05,
  minEffectSize = 0.5
): ComparisonResult {
  const { u, pValue } = mannWhitneyU(head.durations, base.durations);
  const effectSize = Math.abs(cohensD(head.durations, base.durations));
  const significant = pValue <= maxPValue;
  const regression =
    significant && effectSize >= minEffectSize && mean(head.durations) > mean(base.durations);

  return {
    headLabel: head.label,
    baseLabel: base.label,
    uStatistic: u,
    pValue,
    effectSize,
    significant,
    regression,
  };
}
