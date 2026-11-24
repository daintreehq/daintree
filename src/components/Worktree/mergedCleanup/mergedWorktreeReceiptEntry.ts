import type { MergedWorktreeRemovalReceipt } from "@shared/types/mergedWorktreeCleanup";
import type { NotificationHistoryEntry } from "@/store/slices/notificationHistorySlice";

/** One inbox entry per removal, whichever view files it. */
export function mergedWorktreeReceiptEntryId(receiptId: string): string {
  return `merged-worktree-removal:${receiptId}`;
}

/**
 * A worktree the merged-worktree rule removed (#17321), as an unread inbox
 * entry. Built only from what the receipt recorded. No worktree address: the
 * worktree is gone, and the row would only say so.
 */
export function mergedWorktreeReceiptEntry(
  receipt: MergedWorktreeRemovalReceipt
): NotificationHistoryEntry {
  return {
    id: mergedWorktreeReceiptEntryId(receipt.id),
    type: "info",
    title: "Merged worktree removed",
    message: `${receipt.branch} in ${receipt.projectName}: PR #${receipt.prNumber} merged over a day ago and the worktree held nothing uncommitted. The branch is kept.`,
    timestamp: receipt.removedAt,
    seenAsToast: false,
    summarized: false,
    countable: true,
    archivedAt: null,
    context: { projectId: receipt.projectId, eventKind: "git" },
  };
}
