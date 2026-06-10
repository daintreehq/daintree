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
 * `onCountUpdate` fires, and `lastUpdated` is set by the stats fetch.
 *
 * @param statsCount       Total from the stats poll, or null when unavailable.
 * @param statsLastUpdated Epoch ms of the last stats fetch, or null before the
 *                         first poll resolves (no stats baseline yet).
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
