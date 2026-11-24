import { create } from "zustand";
import type { BulkWorktreeRunSnapshot } from "@shared/types/ipc/bulkWorktreeRuns";
import { bulkWorktreeRunsClient } from "@/clients/bulkWorktreeRunsClient";

/**
 * Every bulk worktree creation run main holds, whichever project view runs it
 * (#17085), so UI outside the creation dialog, in any project, can show one
 * and cancel or retry it through {@link bulkWorktreeRunsClient}. Nothing
 * subscribes until something calls `init`, so a view that never shows a run
 * pays nothing. Not persisted.
 */
interface BulkWorktreeRunState {
  runs: BulkWorktreeRunSnapshot[];
  /** Idempotent: subscribes to changes, then reads the current set. */
  init: () => void;
}

let initialized = false;
let unsubscribeChanged: (() => void) | null = null;
// A push that lands while the first read is out is newer than that read.
let pushedSinceInit = false;

export const useBulkWorktreeRunStore = create<BulkWorktreeRunState>((set) => ({
  runs: [],
  init: () => {
    if (initialized) return;
    if (typeof window.electron?.bulkWorktreeRuns?.onChanged !== "function") return;
    initialized = true;
    pushedSinceInit = false;
    unsubscribeChanged = bulkWorktreeRunsClient.onChanged(({ runs }) => {
      pushedSinceInit = true;
      set({ runs });
    });
    void bulkWorktreeRunsClient
      .list()
      .then((runs) => {
        if (initialized && !pushedSinceInit) set({ runs });
      })
      .catch(() => {});
  },
}));

/** Test-only: reset the module-level init guard and state between cases. */
export function _resetBulkWorktreeRunStoreForTest(): void {
  unsubscribeChanged?.();
  unsubscribeChanged = null;
  initialized = false;
  pushedSinceInit = false;
  useBulkWorktreeRunStore.setState({ runs: [] });
}
