import type { WorktreeAgentBuckets } from "@/lib/worktreeAgentBuckets";

/**
 * The one mark a worktree card wears, projected from its quick-state buckets so
 * the card can never disagree with the filter it is counted under.
 *
 * Attention outranks the rest — an agent asking is the only state blocking on
 * the reader. A seen Finished worktree wears nothing: there is nothing left on
 * it to look at, the same reason Pilot leaves `done` unhued.
 */
export type ChipState = "attention" | "cleanup" | "finished" | null;

export function computeChipState(buckets: WorktreeAgentBuckets): ChipState {
  if (buckets.attention) return "attention";
  if (buckets.cleanup) return "cleanup";
  if (buckets.finishedUnseen) return "finished";
  return null;
}
