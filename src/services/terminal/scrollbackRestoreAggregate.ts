export type ScrollbackRestoreState = "none" | "pending" | "in-progress" | "done";

export interface ScrollbackRestoreAggregate {
  /** Terminals queued for restore but not yet started. */
  pendingCount: number;
  /** Terminals actively replaying their buffer. */
  inProgressCount: number;
  /**
   * Terminals participating in the batch — every state except `"none"`,
   * including those already `"done"`. Drives the "N of M" denominator;
   * `"none"` terminals never entered the batch so they are excluded.
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
