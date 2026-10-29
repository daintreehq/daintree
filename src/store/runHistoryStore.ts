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
  /** The last snapshot read failed; `records` is whatever was already known, not proof of an empty log. */
  loadFailed: boolean;
  /** Idempotent: pulls the current snapshot and subscribes to live updates. Re-pulls when the last read failed. */
  init: () => void;
  /** Read the snapshot again after a failed read. */
  retry: () => void;
  /** Clear the durable log. Resolves false when the clear failed, so the caller can say so. */
  clear: () => Promise<boolean>;
}

let initialized = false;
let unsubscribe: (() => void) | null = null;
// Bumped by every `run-history:update` push. The pull `getRecords()` resolves
// asynchronously and can land AFTER a fresher push (or another window's
// concurrent append) — when a push arrived while a pull was in flight, the stale
// snapshot must not overwrite it.
let pushVersion = 0;
let pulling = false;
// Bumped by the test reset so a pull started before it can't settle into the next case.
let generation = 0;

export const useRunHistoryStore = create<RunHistoryState>((set, get) => {
  const pull = () => {
    if (pulling) return;
    pulling = true;
    const versionAtStart = pushVersion;
    const generationAtStart = generation;
    set({ loadFailed: false, loading: get().records.length === 0 });
    window.electron.runHistory
      .getRecords()
      .then((records) => {
        if (generation !== generationAtStart) return;
        pulling = false;
        set(
          pushVersion !== versionAtStart
            ? { loading: false }
            : { records, loading: false, loadFailed: false }
        );
      })
      .catch((err) => {
        if (generation !== generationAtStart) return;
        pulling = false;
        logError("Failed to load run history", err);
        // A push that landed meanwhile already supplied what this read failed to.
        set(
          pushVersion !== versionAtStart ? { loading: false } : { loading: false, loadFailed: true }
        );
      });
  };

  return {
    records: [],
    loading: true,
    loadFailed: false,
    retry: pull,
    init: () => {
      if (initialized) {
        if (get().loadFailed) pull();
        return;
      }
      initialized = true;

      // Live updates: the main process pushes the full newest-first snapshot on
      // every append/clear, and replays it to freshly-loaded views. This is the
      // authoritative data path.
      unsubscribe = window.electron.events.on("run-history:update", (records) => {
        pushVersion++;
        set({ records, loading: false, loadFailed: false });
      });

      // Pull-on-mount so we have data even before the first push arrives.
      pull();
    },
    clear: async () => {
      try {
        // No optimistic `set({ records: [] })`: the clear IPC handler calls
        // `broadcastRunHistory()` synchronously before it resolves, so the empty
        // snapshot arrives via the push path. An optimistic clear here could
        // instead clobber a concurrent append broadcast from another window.
        await window.electron.runHistory.clear();
        return true;
      } catch (err) {
        logError("Failed to clear run history", err);
        return false;
      }
    },
  };
});

/** Test-only: reset the module-level init guard between cases. */
export function _resetRunHistoryStoreForTest(): void {
  unsubscribe?.();
  unsubscribe = null;
  initialized = false;
  pushVersion = 0;
  pulling = false;
  generation++;
  useRunHistoryStore.setState({ records: [], loading: true, loadFailed: false });
}
