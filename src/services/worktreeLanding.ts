import { notify } from "@/lib/notify";
import { subscribeProjectViewLifecycle } from "@/lib/viewCacheState";
import type { WorktreeViewState, WorktreeViewStoreApi } from "@/store/createWorktreeStore";
import { isDroppedViewRestorePending, onDroppedViewRestored } from "@/store/projectStore";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { logWarn } from "@/utils/logger";

/** As long as the view's worktree port is given to come up the first time. */
const LANDING_TIMEOUT_MS = 45_000;

/**
 * The list says which worktrees exist. An empty one only says the host hasn't
 * reported yet (#11235), so it can't show the worktree is gone.
 */
function knowsWorktrees(state: WorktreeViewState): boolean {
  return (
    state.isInitialized &&
    !state.isLoading &&
    !state.isReconnecting &&
    state.error === null &&
    state.worktrees.size > 0
  );
}

/**
 * Select `worktreeId` once this view knows its worktrees, or, when it isn't
 * among them, leave the project as it opened and say so. A view that goes to
 * the cache, or a wait past the timeout, ends it with nothing done; so does
 * the returned cancel.
 */
export function landOnWorktree(worktreeId: string, store: WorktreeViewStoreApi): () => void {
  let done = false;
  const cleanups: Array<() => void> = [];
  const finish = () => {
    if (done) return;
    done = true;
    for (const cleanup of cleanups) cleanup();
  };

  const tryLand = () => {
    if (done) return;
    // Putting a dropped view's layout back restores its saved selection too,
    // which would land on top of this one.
    if (isDroppedViewRestorePending()) return;
    const state = store.getState();
    if (!knowsWorktrees(state)) return;
    finish();
    if (state.worktrees.has(worktreeId)) {
      useWorktreeSelectionStore.getState().selectWorktree(worktreeId);
      return;
    }
    notify({
      type: "warning",
      title: "Worktree is gone",
      message:
        "The worktree you were opening isn't in this project anymore. You're on the one it last had.",
      context: { eventKind: "uiFeedback" },
      replaceKey: "focus-on-activate:worktree-gone",
    });
  };

  cleanups.push(store.subscribe(tryLand));
  cleanups.push(onDroppedViewRestored(tryLand));
  cleanups.push(
    subscribeProjectViewLifecycle((phase) => {
      if (phase === "cached") finish();
    })
  );
  const timer = setTimeout(() => {
    if (done) return;
    logWarn("Gave up landing on a worktree: the project's worktrees never loaded", {
      worktreeId,
    });
    finish();
  }, LANDING_TIMEOUT_MS);
  cleanups.push(() => clearTimeout(timer));

  tryLand();
  return finish;
}
