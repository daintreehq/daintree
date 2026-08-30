import { use, useSyncExternalStore } from "react";
import { useStore } from "zustand";
import { WorktreeStoreContext } from "@/contexts/WorktreeStoreContext";
import type { WorktreeViewState, WorktreeViewActions } from "@/store/createWorktreeStore";

export function useWorktreeStore<T>(
  selector: (state: WorktreeViewState & WorktreeViewActions) => T
): T {
  const store = use(WorktreeStoreContext);
  if (!store) {
    throw new Error("useWorktreeStore must be used within WorktreeStoreProvider");
  }
  return useStore(store, selector);
}

/** A subscription to nothing, for the renders where there is no store to watch. */
const NEVER_CHANGES = () => () => {};

/**
 * The same read, for a component that legitimately renders outside the provider.
 *
 * {@link useWorktreeStore} throws where no view store is mounted, which is the
 * right answer for the sidebar and the panes — they are the project view, and a
 * missing store there is a wiring bug. It is the wrong answer for an overlay
 * that only ENRICHES itself with the current project's worktrees and has to
 * render without them: throwing would take the whole surface down over a detail
 * it can do without.
 *
 * The selector must return a primitive or a stable reference. `useSyncExternalStore`
 * re-renders until two consecutive snapshots compare equal, so a selector minting
 * a fresh object or array each call loops forever.
 */
export function useWorktreeStoreOptional<T>(
  selector: (state: WorktreeViewState & WorktreeViewActions) => T,
  fallback: T
): T {
  const store = use(WorktreeStoreContext);
  return useSyncExternalStore(
    store?.subscribe ?? NEVER_CHANGES,
    () => (store ? selector(store.getState()) : fallback),
    () => (store ? selector(store.getState()) : fallback)
  );
}
