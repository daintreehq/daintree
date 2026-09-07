import type { RepoState, StagingStatus } from "@shared/types";

/**
 * The single wording for a halted git operation and what aborting it costs.
 *
 * Lifted out of `ConflictPanel` when the worktree card's Git submenu gained its
 * own Abort row (#12092). Two surfaces confirming the same abort is fine; two
 * surfaces describing it differently is not — "Discards 3 staged resolutions
 * and reverts 2 of 5 replayed commits" in Review Hub and a vaguer sentence on
 * the card would be the same operation wearing two consequences, and the reader
 * has no way to know which one is accurate.
 */

/** The four states in which an operation is genuinely mid-flight. */
export type RepoOperationState = Exclude<RepoState, "CLEAN" | "DIRTY">;

export const OPERATION_LABEL: Record<RepoOperationState, string> = {
  MERGING: "Merge",
  REBASING: "Rebase",
  CHERRY_PICKING: "Cherry-pick",
  REVERTING: "Revert",
};

const ABORT_RESTORE_SUFFIX: Record<RepoOperationState, string> = {
  MERGING: "restores the working tree to its pre-merge state.",
  REBASING: "returns HEAD to the original branch tip.",
  CHERRY_PICKING: "restores the working tree to the state before the operation started.",
  REVERTING: "restores the working tree to the state before the operation started.",
};

/** `"CLEAN"`/`"DIRTY"` narrowed away, so callers can branch on a real operation. */
export function toRepoOperationState(state: RepoState | undefined): RepoOperationState | null {
  if (!state || state === "CLEAN" || state === "DIRTY") return null;
  return state;
}

/**
 * What aborting this operation actually discards, counted from a fresh status.
 *
 * The counts are the whole point: a bare "discards the in-progress rebase" is
 * true and unhelpful, because what the user is weighing is the conflict work
 * they have already staged. Every branch below states a number the reader can
 * check against what is on screen.
 */
export function buildAbortDescription(
  operationState: RepoOperationState,
  status: StagingStatus
): string {
  const stagedCount = status.staged.length;
  const parts: string[] = [];

  if (stagedCount > 0) {
    parts.push(`Discards ${stagedCount} staged resolution${stagedCount === 1 ? "" : "s"}`);
  }

  if (
    operationState === "REBASING" &&
    status.rebaseStep != null &&
    status.rebaseTotalSteps != null &&
    status.rebaseTotalSteps > 0
  ) {
    // `rebaseStep` from `git status` is the *next* commit to replay, so the
    // already-replayed count is one less. Clamp to 0 to be safe.
    const replayed = Math.max(0, status.rebaseStep - 1);
    if (replayed > 0) {
      const replayFragment = `reverts ${replayed} of ${status.rebaseTotalSteps} replayed commit${
        replayed === 1 ? "" : "s"
      }`;
      if (parts.length > 0) {
        parts.push(`and ${replayFragment}`);
      } else {
        parts.push(replayFragment.charAt(0).toUpperCase() + replayFragment.slice(1));
      }
    }
  }

  const restore = ABORT_RESTORE_SUFFIX[operationState];

  if (parts.length === 0) {
    return `Discards the in-progress ${OPERATION_LABEL[operationState].toLowerCase()} and ${restore}`;
  }
  return `${parts.join(" ")} and ${restore}`;
}
