import { notify } from "@/lib/notify";
import { isProjectViewCached, subscribeProjectViewLifecycle } from "@/lib/viewCacheState";
import type { WorktreeViewState } from "@/store/createWorktreeStore";
import { isDroppedViewRestorePending, onDroppedViewRestored } from "@/store/projectStore";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { logWarn } from "@/utils/logger";

/** As long as the view's worktree port is given to come up the first time. */
const LANDING_TIMEOUT_MS = 45_000;

type WorktreeListState = Pick<
  WorktreeViewState,
  "isInitialized" | "isLoading" | "isReconnecting" | "error"
> & { worktrees: ReadonlyMap<string, unknown> };

/** What a landing reads of the view's worktree store. */
export interface WorktreeListSource {
  getState(): WorktreeListState;
  subscribe(listener: () => void): () => void;
}

/**
 * The list says which worktrees exist. An empty one only says the host hasn't
 * reported yet (#11235), so it can't show the worktree is gone.
 */
function knowsWorktrees(state: WorktreeListState): boolean {
  return (
    state.isInitialized &&
    !state.isLoading &&
    !state.isReconnecting &&
    state.error === null &&
    state.worktrees.size > 0
  );
}

/**
 * Resolves once this view knows its worktrees: true then, false when the view
 * goes to the cache or the wait runs past `timeoutMs` first.
 */
export function whenWorktreesKnown(
  store: WorktreeListSource,
  timeoutMs = LANDING_TIMEOUT_MS
): Promise<boolean> {
  if (knowsWorktrees(store.getState())) return Promise.resolve(true);
  return new Promise((resolve) => {
    const cleanups: Array<() => void> = [];
    const finish = (known: boolean) => {
      for (const cleanup of cleanups.splice(0)) cleanup();
      resolve(known);
    };
    cleanups.push(
      store.subscribe(() => {
        if (knowsWorktrees(store.getState())) finish(true);
      })
    );
    cleanups.push(
      subscribeProjectViewLifecycle((phase) => {
        if (phase === "cached") finish(false);
      })
    );
    const timer = setTimeout(() => finish(false), timeoutMs);
    cleanups.push(() => clearTimeout(timer));
  });
}

/**
 * Select `worktreeId` once this view knows its worktrees, or, when it isn't
 * among them, leave the project as it opened and say so. A view that goes to
 * the cache, or a wait past the timeout, ends it with nothing more done; so
 * does the returned cancel.
 */
export function landOnWorktree(worktreeId: string, store: WorktreeListSource): () => void {
  let done = false;
  let landed = false;
  const cleanups: Array<() => void> = [];
  const finish = () => {
    if (done) return;
    done = true;
    for (const cleanup of cleanups) cleanup();
  };
  if (isProjectViewCached()) return finish;

  const tryLand = () => {
    if (done) return;
    const state = store.getState();
    if (!knowsWorktrees(state)) return;
    if (!state.worktrees.has(worktreeId)) {
      finish();
      notify({
        type: "warning",
        title: "Worktree is gone",
        message:
          "The worktree you were opening isn't in this project anymore. You're on the one it last had.",
        context: { eventKind: "uiFeedback" },
        replaceKey: "focus-on-activate:worktree-gone",
      });
      return;
    }
    useWorktreeSelectionStore.getState().selectWorktree(worktreeId);
    landed = true;
    // Putting a dropped view's layout back restores its saved selection too,
    // so land again once it has. A host switch straight to the view starts
    // no restore, so landing never waits on one.
    if (!isDroppedViewRestorePending()) finish();
  };

  cleanups.push(
    store.subscribe(() => {
      if (!landed) tryLand();
    })
  );
  cleanups.push(
    onDroppedViewRestored(() => {
      // The restore moved the selection: the next list it can trust lands again.
      landed = false;
      tryLand();
    })
  );
  cleanups.push(
    subscribeProjectViewLifecycle((phase) => {
      if (phase === "cached") finish();
    })
  );
  const timer = setTimeout(() => {
    if (done) return;
    if (!landed) {
      logWarn("Gave up landing on a worktree: the project's worktrees never loaded", {
        worktreeId,
      });
    }
    finish();
  }, LANDING_TIMEOUT_MS);
  cleanups.push(() => clearTimeout(timer));

  tryLand();
  return finish;
}
