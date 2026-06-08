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
// True once an `run-history:update` push has populated the store. The pull-on-
// mount `getRecords()` resolves asynchronously and can land AFTER a fresher
// push during init (or during another window's concurrent append) — when a
// push has already arrived, the stale snapshot must not overwrite it.
let receivedPush = false;

export const useRunHistoryStore = create<RunHistoryState>((set) => ({
  records: [],
  loading: true,
  init: () => {
    if (initialized) return;
    initialized = true;

    // Live updates: the main process pushes the full newest-first snapshot on
    // every append/clear, and replays it to freshly-loaded views. This is the
    // authoritative data path.
    unsubscribe = window.electron.events.on("run-history:update", (records) => {
      receivedPush = true;
      set({ records, loading: false });
    });

    // Pull-on-mount so we have data even before the first push arrives. Skip
    // applying the snapshot if a push already won the race — only clear loading.
    window.electron.runHistory
      .getRecords()
      .then((records) => set(receivedPush ? { loading: false } : { records, loading: false }))
      .catch((err) => {
        logError("Failed to load run history", err);
        set({ loading: false });
      });
  },
  clear: async () => {
    try {
      // No optimistic `set({ records: [] })`: the clear IPC handler calls
      // `broadcastRunHistory()` synchronously before it resolves, so the empty
      // snapshot arrives via the push path. An optimistic clear here could
      // instead clobber a concurrent append broadcast from another window.
      await window.electron.runHistory.clear();
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
  receivedPush = false;
  useRunHistoryStore.setState({ records: [], loading: true });
}
