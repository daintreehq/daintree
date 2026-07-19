import type { WorktreeState } from "@/types";

/**
 * How long the main worktree's AI note stays current. Only the main worktree
 * expires its note: a feature worktree's note describes work that is still
 * sitting there uncommitted, while the main worktree is long-lived and a note
 * from an hour ago says nothing about what is in the tree now.
 */
export const MAIN_WORKTREE_NOTE_TTL_MS = 10 * 60 * 1000; // 10 minutes

/**
 * The worktree's AI note if it is still current, else undefined.
 *
 * Shared by the worktree card (which displays it) and `worktree.openReviewHub`
 * (which seeds the commit composer from it) so the two can't drift into
 * disagreeing about whether a note is live.
 *
 * Returns undefined rather than any substitute value. Callers seeding a commit
 * message must carry that through as an empty seed — never fall back to a last
 * commit subject, branch name, or summary. A silently substituted commit
 * message caused a real bad push to a shared branch (#7884).
 */
export function deriveEffectiveNote(
  worktree: Pick<WorktreeState, "aiNote" | "aiNoteTimestamp" | "isMainWorktree">,
  now: number
): string | undefined {
  const trimmed = worktree.aiNote?.trim();
  if (!trimmed) return undefined;

  if (worktree.isMainWorktree && worktree.aiNoteTimestamp) {
    const age = now - worktree.aiNoteTimestamp;
    if (age > MAIN_WORKTREE_NOTE_TTL_MS) {
      return undefined;
    }
  }

  return trimmed;
}

/**
 * First line of the current AI note, or "" when there is no current note.
 * The commit-composer seed — see the no-fallback rule above.
 */
export function deriveCommitMessageSeed(
  worktree: Pick<WorktreeState, "aiNote" | "aiNoteTimestamp" | "isMainWorktree">,
  now: number
): string {
  return deriveEffectiveNote(worktree, now)?.split("\n")[0]?.trim() ?? "";
}
