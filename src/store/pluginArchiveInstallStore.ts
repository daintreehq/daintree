import { create } from "zustand";
import type { PluginArchiveInstallIntent } from "@shared/types/plugin";

/**
 * One double-clicked `.dntr` archive awaiting the user's install decision
 * (#11280). Held in a FIFO queue so several archives opened at once each get
 * their own confirmation instead of stacking overlapping dialogs; only
 * `current` drives the visible modal.
 *
 * Every display field comes straight off the main-pushed intent, which carries
 * the manifest read without extracting the archive. `enqueuedAt` is the only
 * renderer-local field.
 */
export interface PendingPluginArchiveInstall extends PluginArchiveInstallIntent {
  enqueuedAt: number;
}

interface PluginArchiveInstallState {
  queue: PendingPluginArchiveInstall[];
  current: PendingPluginArchiveInstall | null;
}

interface PluginArchiveInstallActions {
  enqueue: (intent: PluginArchiveInstallIntent) => void;
  resolveCurrent: () => void;
  drop: (intentId: string) => void;
  reset: () => void;
}

function advance(
  set: (partial: Partial<PluginArchiveInstallState>) => void,
  queue: PendingPluginArchiveInstall[]
) {
  if (queue.length === 0) {
    set({ current: null, queue: [] });
    return;
  }
  const [next, ...rest] = queue;
  set({ current: next, queue: rest });
}

export const usePluginArchiveInstallStore = create<
  PluginArchiveInstallState & PluginArchiveInstallActions
>((set, get) => ({
  queue: [],
  current: null,

  enqueue: (intent) => {
    const { current, queue } = get();
    // Same archive already awaiting a decision — a duplicate OS event or a
    // replayed buffer entry, not a second request. Dedupe on path rather than
    // intentId: main mints a fresh id per delivery attempt.
    if (current?.archivePath === intent.archivePath) return;
    if (queue.some((item) => item.archivePath === intent.archivePath)) return;

    const item: PendingPluginArchiveInstall = { ...intent, enqueuedAt: Date.now() };
    if (current === null) {
      set({ current: item });
    } else {
      set({ queue: [...queue, item] });
    }
  },

  resolveCurrent: () => {
    const { current, queue } = get();
    if (current === null) return;
    advance(set, queue);
  },

  drop: (intentId) => {
    const { current, queue } = get();
    if (current?.intentId === intentId) {
      advance(set, queue);
      return;
    }
    const filtered = queue.filter((item) => item.intentId !== intentId);
    if (filtered.length !== queue.length) {
      set({ queue: filtered });
    }
  },

  reset: () => set({ queue: [], current: null }),
}));

/** Test-only escape hatch — clears the singleton queue. */
export function __resetPluginArchiveInstallStoreForTesting(): void {
  usePluginArchiveInstallStore.getState().reset();
}
