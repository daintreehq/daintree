/**
 * Recency arbitration for the toolbar issue/PR count badge (issue #9741).
 *
 * Two sources feed each count: the periodic stats poll (`useRepositoryStats`,
 * carrying `lastUpdated`) and the dropdown's list-derived count (`onCountUpdate`
 * in `the dropdown list`, added in #9694, switched to real totals in
 * #9718). The list count used to win unconditionally once set, so the badge
 * froze on the list's number until the dropdown was reopened — even while a
 * fresher background poll had newer data.
 *
 * This helper shows whichever source was updated most recently. The list count
 * still wins immediately after a fresh dropdown fetch (its timestamp is newer);
 * it just yields once a later stats poll lands. Both timestamps are epoch ms
 * from the same `Date.now()` clock — the toolbar stamps the list timestamp when
 * `onCountUpdate` fires, and the stats timestamp is the per-count
 * `issueCountRefreshedAt` / `prCountRefreshedAt`: the last time that count was
 * actually read from a forge count endpoint. NOT `lastUpdated`, which the main
 * process re-stamps when its activity probe re-serves cached counts —
 * arbitrating on that let a stale cached count outrank a fresher
 * dropdown-observed total on every background poll.
 *
 * @param statsCount       Total from the stats poll, or null when unavailable.
 * @param statsLastUpdated Epoch ms when this count was last read from the forge
 *                         (the per-count refreshed-at stamp), or null when
 *                         there is no honest stats baseline yet.
 * @param listCount        Count reported by the dropdown list, or null before
 *                         the dropdown has loaded.
 * @param listApproximate  Whether the list count is approximate (cache hit
 *                         without a real `totalCount`) — drives the `+` suffix.
 * @param listTimestamp    Epoch ms when the list count was last reported, or
 *                         null if it never has.
 */
export function resolveForgeDisplayCount(
  statsCount: number | null,
  statsLastUpdated: number | null,
  listCount: number | null,
  listApproximate: boolean,
  listTimestamp: number | null
): number | string | null {
  // The list count wins when it exists AND is at least as fresh as the stats
  // poll. `statsLastUpdated == null` means there is no stats baseline yet, so a
  // present list count is the best available value. `>=` (not `>`) keeps the
  // higher-fidelity list count on a same-millisecond tie.
  const listWins =
    listCount !== null &&
    (statsLastUpdated == null || (listTimestamp != null && listTimestamp >= statsLastUpdated));

  if (listWins) {
    return listApproximate ? `${listCount}+` : listCount;
  }
  return statsCount;
}

const COMPACT_UNITS: ReadonlyArray<readonly [number, string]> = [
  [1_000_000_000, "B"],
  [1_000_000, "M"],
  [1_000, "k"],
];

/**
 * Glance form of a toolbar count: exact below 1,000, then `1.2k`, `23k`,
 * `1.2M`. Never wider than four characters, so a six-digit commit history
 * cannot stretch the pill row. Truncates rather than rounds — a badge that
 * reads `24k` for 23,645 commits claims history that does not exist, and the
 * digit should only tick over once the real count gets there. The exact
 * number belongs in the accessible name and the tooltip.
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

/**
 * The badge text for a resolved display count: numbers compacted, the list's
 * approximate `N+` form compacted on its numeric part, anything else as-is.
 */
export function formatForgeBadgeCount(display: number | string | null): string | null {
  if (display === null) return null;
  if (typeof display === "number") return formatCompactCount(display);
  const approximate = /^(\d+)\+$/.exec(display);
  return approximate ? `${formatCompactCount(Number(approximate[1]))}+` : display;
}

/** The exact form for accessible names and tooltips: `23,645`. */
export function formatExactCount(display: number | string | null): string {
  if (display === null) return "—";
  if (typeof display === "number") return display.toLocaleString("en-US");
  const approximate = /^(\d+)\+$/.exec(display);
  return approximate ? `${Number(approximate[1]).toLocaleString("en-US")}+` : display;
}
