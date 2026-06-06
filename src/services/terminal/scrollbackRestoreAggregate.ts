export type ScrollbackRestoreState = "none" | "pending" | "lazy-pending" | "in-progress" | "done";

export interface ScrollbackRestoreAggregate {
  /** Terminals eagerly queued for restore but not yet started. */
  pendingCount: number;
  /** Terminals actively replaying their buffer. */
  inProgressCount: number;
  /**
   * Terminals participating in the eager batch — `"pending"`, `"in-progress"`,
   * and `"done"`. Drives the "N of M" denominator.
   *
   * `"none"` (never entered) and `"lazy-pending"` are excluded: a lazy restore
   * is deferred until the user scrolls its panel into view and may never fire,
   * so counting it would pin the ambient progress indicator open for the whole
   * session. A lazy terminal only joins the tally once it actually starts
   * (`"in-progress"`).
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
    if (state === "none" || state === "lazy-pending") continue;
    totalCount++;
    if (state === "pending") pendingCount++;
    else if (state === "in-progress") inProgressCount++;
  }
  return { pendingCount, inProgressCount, totalCount };
}
