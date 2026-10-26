import { useMemo } from "react";
import type { WorktreeState } from "@/types";
import { reviewChangeHint } from "@/lib/reviewChangeHint";
import { useReviewMarksStore, worktreeReviewMark } from "@/store/reviewMarksStore";

/** The card's "Changed since review" line for this worktree, or null (#14588). */
export function useReviewChangeHint(
  worktree: Pick<WorktreeState, "id" | "branch" | "isDetached" | "worktreeChanges"> &
    Partial<Pick<WorktreeState, "lastActivityTimestamp">>
): string | null {
  const marks = useReviewMarksStore((s) => s.marks);
  const { id, branch, isDetached, worktreeChanges, lastActivityTimestamp } = worktree;
  return useMemo(
    () =>
      reviewChangeHint(worktreeReviewMark(marks, { id, branch, isDetached }), {
        headOid: worktreeChanges?.headOid,
        latestFileMtime: worktreeChanges?.latestFileMtime,
        lastActivityTimestamp,
      }),
    [
      marks,
      id,
      branch,
      isDetached,
      worktreeChanges?.headOid,
      worktreeChanges?.latestFileMtime,
      lastActivityTimestamp,
    ]
  );
}
