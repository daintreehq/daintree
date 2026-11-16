import type { WorktreeState } from "@/types";
import { reviewChangeHint } from "@/lib/reviewChangeHint";
import { useReviewMarksStore, worktreeReviewMark } from "@/store/reviewMarksStore";

/** The card's "Changed since review" line for this worktree, or null (#14588). */
export function useReviewChangeHint(
  worktree: Pick<WorktreeState, "id" | "branch" | "isDetached" | "worktreeChanges"> &
    Partial<Pick<WorktreeState, "lastActivityTimestamp">>
): string | null {
  const { id, branch, isDetached, worktreeChanges, lastActivityTimestamp } = worktree;
  const headOid = worktreeChanges?.headOid;
  const latestFileMtime = worktreeChanges?.latestFileMtime;
  // Selects the line itself: every card holds this hook, and a selection of the
  // whole marks map woke them all for a mark saved on any one worktree — and
  // each snapshot rebuilds every mark object, so even this card's own mark
  // can't serve as the comparison (#17072).
  return useReviewMarksStore((s) =>
    reviewChangeHint(worktreeReviewMark(s.marks, { id, branch, isDetached }), {
      headOid,
      latestFileMtime,
      lastActivityTimestamp,
    })
  );
}
