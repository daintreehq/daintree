export type ScrollbackRestoreState = "none" | "pending" | "in-progress" | "done";

export interface ScrollbackRestoreAggregate {
  /** Terminals eagerly queued for restore but not yet started. */
  pendingCount: number;
  /** Terminals actively replaying their buffer. */
  inProgressCount: number;
  /**
   * Terminals participating in the eager batch — `"pending"`, `"in-progress"`,
   * and `"done"`. Drives the "N of M" denominator. `"none"` (never entered) is
   * excluded so terminals that never queue a restore don't pin the indicator.
   */
  totalCount: number;
}

export function tallyScrollbackRestoreStates(
  states: Iterable<ScrollbackRestoreState>
): ScrollbackRestoreAggregate {
  let pendingCount = 0;
  let inProgressCount = 0;
  let totalCount = 0;
  for (const state of states) {
    if (state === "none") continue;
    totalCount++;
    if (state === "pending") pendingCount++;
    else if (state === "in-progress") inProgressCount++;
  }
  return { pendingCount, inProgressCount, totalCount };
}
