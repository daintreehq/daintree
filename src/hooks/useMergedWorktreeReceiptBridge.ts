import { useEffect } from "react";
import { isRemoteWindow } from "@/hooks/useHostPlatform";
import { useProjectStore } from "@/store/projectStore";
import {
  flushNotificationHistory,
  notificationHistoryIdsInStorage,
  useNotificationHistoryStore,
} from "@/store/slices/notificationHistorySlice";
import {
  mergedWorktreeReceiptEntry,
  mergedWorktreeReceiptEntryId,
} from "@/components/Worktree/mergedCleanup/mergedWorktreeReceiptEntry";
import { logWarn } from "@/utils/logger";
import { formatErrorMessage } from "@shared/utils/errorMessage";

/**
 * Puts the worktrees the merged-worktree rule removed (#17321) in the
 * notification inbox, in a view on screen once its state has loaded, again
 * whenever it's shown, and when main says a removal just happened. Each
 * receipt waits in main until it's written to storage and read back, so one
 * that didn't land is offered again, and one filed twice is still one entry.
 */
export function useMergedWorktreeReceiptBridge(isStateLoaded: boolean): void {
  const projectId = useProjectStore((state) => state.currentProject?.id ?? null);

  useEffect(() => {
    if (!isStateLoaded || !projectId || isRemoteWindow()) return;
    const api = window.electron?.mergedWorktreeCleanup;
    if (!api?.takeReceipts || !api.ackReceipts) return;
    let disposed = false;
    // Parked out of sight: main hands receipts only to the view on screen.
    let cached = false;
    let asking = false;
    let askAgain = false;

    const fileOnce = async (): Promise<void> => {
      const receipts = await api.takeReceipts();
      if (disposed || cached || receipts.length === 0) return;
      useNotificationHistoryStore
        .getState()
        .importEntries(receipts.map((receipt) => mergedWorktreeReceiptEntry(receipt)));
      flushNotificationHistory();
      const stored = notificationHistoryIdsInStorage();
      const ids = receipts
        .filter((receipt) => stored.has(mergedWorktreeReceiptEntryId(receipt.id)))
        .map((receipt) => receipt.id);
      if (ids.length > 0) await api.ackReceipts({ ids });
    };

    const ask = async (): Promise<void> => {
      if (asking) {
        askAgain = true;
        return;
      }
      asking = true;
      try {
        do {
          askAgain = false;
          try {
            await fileOnce();
          } catch (error) {
            logWarn("Couldn't put removed worktrees in the inbox", {
              error: formatErrorMessage(error, "unknown"),
            });
          }
        } while (askAgain && !disposed);
      } finally {
        asking = false;
      }
    };

    void ask();
    const offReady = api.onReceiptsReady?.(() => {
      if (!cached) void ask();
    });
    const offRevealed = window.electron?.app?.onViewRevealed?.(() => {
      cached = false;
      void ask();
    });
    const offCached = window.electron?.app?.onViewCached?.(() => {
      cached = true;
    });
    return () => {
      disposed = true;
      offReady?.();
      offRevealed?.();
      offCached?.();
    };
  }, [isStateLoaded, projectId]);
}
