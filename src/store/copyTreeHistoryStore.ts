import { create } from "zustand";
import { logError } from "@/utils/logger";
import type { CopyTreeHistoryRecord } from "@shared/types";

/**
 * Renderer mirror of the current project's copy-tree run history (#11732). The
 * source of truth is the Main-process per-project file; this store is NOT
 * persisted — it pulls a snapshot on first mount and stays current via the
 * `copy-tree-history:update` push.
 *
 * Project scoping is enforced entirely in Main: unlike the process-global
 * run-history ring, this snapshot is *sent* only to the views bound to its
 * project rather than broadcast and filtered here, so a view can never be
 * handed another project's history to discard. The `projectId` on the payload
 * is what makes the event self-describing (event inspector, #11733's dropdown),
 * not a filter this store depends on for correctness.
 */
interface CopyTreeHistoryState {
  records: CopyTreeHistoryRecord[];
  loading: boolean;
  /** Idempotent: pulls the current snapshot and subscribes to live updates. */
  init: () => void;
}

let initialized = false;
let unsubscribe: (() => void) | null = null;
// True once a push has populated the store. The pull-on-mount resolves
// asynchronously and can land AFTER a fresher push — when that happens the
// stale snapshot must not overwrite it.
let receivedPush = false;

export const useCopyTreeHistoryStore = create<CopyTreeHistoryState>((set) => ({
  records: [],
  loading: true,
  init: () => {
    if (initialized) return;
    initialized = true;

    unsubscribe = window.electron.events.on("copy-tree-history:update", ({ records }) => {
      receivedPush = true;
      set({ records, loading: false });
    });

    window.electron.copyTreeHistory
      .getRecords()
      .then((records) => set(receivedPush ? { loading: false } : { records, loading: false }))
      .catch((err) => {
        logError("Failed to load copy-tree history", err);
        set({ loading: false });
      });
  },
}));

/** Test-only: reset the module-level init guard between cases. */
export function _resetCopyTreeHistoryStoreForTest(): void {
  unsubscribe?.();
  unsubscribe = null;
  initialized = false;
  receivedPush = false;
  useCopyTreeHistoryStore.setState({ records: [], loading: true });
}
