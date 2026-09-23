const COMPACT_UNITS: ReadonlyArray<readonly [number, string]> = [
  [1_000_000_000, "B"],
  [1_000_000, "M"],
  [1_000, "k"],
];

/**
 * Glance form of a count for a badge: exact below 1,000, then `1.2k`, `23k`,
 * `1.2M`. Never wider than four characters, so a six-digit commit history
 * cannot stretch the chrome it sits in. Truncates rather than rounds — a badge
 * that reads `24k` for 23,645 commits claims history that does not exist, and
 * the digit should only tick over once the real count gets there. The exact
 * number (`formatCountExact`) belongs in the accessible name and the tooltip.
 */
export function formatCompactCount(count: number): string {
  if (!Number.isFinite(count) || count < 1_000) return String(count);
  for (const [size, suffix] of COMPACT_UNITS) {
    if (count < size) continue;
    // Integer arithmetic: `count / size * 10` drifts (1.3 * 10 = 13.000…02).
    const tenths = Math.floor((count * 10) / size);
    if (tenths < 100) {
      return `${tenths / 10}${suffix}`;
    }
    return `${Math.floor(count / size)}${suffix}`;
  }
  return String(count);
}

/** The exact form for accessible names and tooltips: `23,645`. */
export function formatCountExact(count: number): string {
  return count.toLocaleString("en-US");
}
