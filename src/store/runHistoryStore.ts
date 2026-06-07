import { create } from "zustand";
import { logError } from "@/utils/logger";
import type { RunHistoryRecord } from "@shared/types";

/**
 * Renderer mirror of the durable run-history ring buffer (#9949). The source of
 * truth is the Main-process `RunHistoryLog` (persisted in electron-store); this
 * store is NOT persisted — it pulls a fresh snapshot on first mount and stays
 * current via the `run-history:update` event bus push (also replayed to
 * cold-started / LRU-restored views via `onViewReady`). Keeping it
 * non-persisted avoids a second, drift-prone source of truth across windows.
 */
interface RunHistoryState {
  records: RunHistoryRecord[];
  loading: boolean;
  /** Idempotent: pulls the current snapshot and subscribes to live updates. */
  init: () => void;
  /** Clear the durable log (and optimistically the local mirror). */
  clear: () => Promise<void>;
}

let initialized = false;
let unsubscribe: (() => void) | null = null;

export const useRunHistoryStore = create<RunHistoryState>((set) => ({
  records: [],
  loading: true,
  init: () => {
    if (initialized) return;
    initialized = true;

    // Live updates: the main process pushes the full newest-first snapshot on
    // every append/clear, and replays it to freshly-loaded views.
    unsubscribe = window.electron.events.on("run-history:update", (records) => {
      set({ records, loading: false });
    });

    // Pull-on-mount so we have data even before the first push arrives.
    window.electron.runHistory
      .getRecords()
      .then((records) => set({ records, loading: false }))
      .catch((err) => {
        logError("Failed to load run history", err);
        set({ loading: false });
      });
  },
  clear: async () => {
    try {
      await window.electron.runHistory.clear();
      set({ records: [] });
    } catch (err) {
      logError("Failed to clear run history", err);
    }
  },
}));

/** Test-only: reset the module-level init guard between cases. */
export function _resetRunHistoryStoreForTest(): void {
  unsubscribe?.();
  unsubscribe = null;
  initialized = false;
  useRunHistoryStore.setState({ records: [], loading: true });
}
