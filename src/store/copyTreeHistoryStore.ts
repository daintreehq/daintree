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
  /**
   * The snapshot pull failed and no push has landed since. Kept apart from an
   * empty history so the menu does not tell someone with twenty stored runs to
   * go and make their first one.
   */
  error: boolean;
  /** Idempotent: pulls the current snapshot and subscribes to live updates. */
  init: () => void;
  /** Pull the snapshot again after a failure. The subscription is untouched. */
  retry: () => void;
}

let initialized = false;
let unsubscribe: (() => void) | null = null;
// True once a push has populated the store. The pull-on-mount resolves
// asynchronously and can land AFTER a fresher push — when that happens the
// stale snapshot must not overwrite it.
let receivedPush = false;
// Bumped by every pull and by reset. Only the newest pull may settle the
// store, so an older request finishing late — a slow first pull behind a
// retry, or a pull from before a reset — cannot overwrite what a newer one
// already said.
let pullGeneration = 0;

export const useCopyTreeHistoryStore = create<CopyTreeHistoryState>((set, get) => {
  const pull = () => {
    const generation = ++pullGeneration;
    window.electron.copyTreeHistory
      .getRecords()
      .then((records) => {
        if (generation !== pullGeneration) return;
        set(
          receivedPush
            ? { loading: false, error: false }
            : { records, loading: false, error: false }
        );
      })
      .catch((err) => {
        if (generation !== pullGeneration) return;
        logError("Failed to load copy-tree history", err);
        // A push that landed first already holds the truth; the failed pull
        // has nothing to add to it.
        set(receivedPush ? { loading: false } : { loading: false, error: true });
      });
  };

  return {
    records: [],
    loading: true,
    error: false,
    init: () => {
      if (initialized) return;
      initialized = true;

      unsubscribe = window.electron.events.on("copy-tree-history:update", ({ records }) => {
        receivedPush = true;
        set({ records, loading: false, error: false });
      });

      pull();
    },
    retry: () => {
      // One pull at a time: a second Retry while the first is out would only
      // race it.
      if (!initialized || get().loading) return;
      set({ loading: true, error: false });
      pull();
    },
  };
});

/** Test-only: reset the module-level init guard between cases. */
export function _resetCopyTreeHistoryStoreForTest(): void {
  unsubscribe?.();
  unsubscribe = null;
  initialized = false;
  receivedPush = false;
  pullGeneration++;
  useCopyTreeHistoryStore.setState({ records: [], loading: true, error: false });
}
