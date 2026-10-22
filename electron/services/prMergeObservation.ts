import type { PRMergeIntent } from "../../shared/types/forge.js";

/** The pending-merge fields a detected PR carries between reads. */
export interface MergeObservation {
  mergeIntent?: PRMergeIntent | null;
  armedHeadSha?: string;
  headMovedWhileArmed?: boolean;
}

// Folds one forge read into the entry. An episode runs from arming until
// nothing is pending; re-arming (a new `enabledAt`) starts a new one, and moving
// from armed into the queue continues it. Observed this session only: a head
// that moved before the first armed read, or across a restart, goes unseen.
export function applyMergeObservation(
  pr: MergeObservation,
  prior: MergeObservation | undefined,
  intent: PRMergeIntent | null | undefined,
  head: string | undefined
): void {
  const previous = prior?.mergeIntent;
  // A read that didn't carry the fields keeps what was known.
  const next = intent === undefined ? previous : intent;
  const continues =
    previous != null &&
    next != null &&
    !(
      previous.kind === "auto-merge" &&
      next.kind === "auto-merge" &&
      previous.enabledAt !== next.enabledAt
    );
  const armedHeadSha = continues ? prior?.armedHeadSha : undefined;
  const moved = continues ? prior?.headMovedWhileArmed : undefined;
  pr.mergeIntent = next;
  if (next == null) {
    pr.armedHeadSha = undefined;
    pr.headMovedWhileArmed = undefined;
    return;
  }
  pr.armedHeadSha = armedHeadSha ?? head;
  pr.headMovedWhileArmed =
    moved === true ||
    (head !== undefined && pr.armedHeadSha !== undefined && head !== pr.armedHeadSha)
      ? true
      : undefined;
}
