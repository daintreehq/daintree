import { useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import type { WorktreeSnapshot } from "@shared/types";
import { useWorktreeStore, useWorktreeStoreApi } from "@/hooks/useWorktreeStore";
import { getNormalizedWorktreeList } from "@/hooks/useWorktrees";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { useProjectStore } from "@/store";
import { useScratchStore } from "@/store/scratchStore";
import { useHomeDir } from "@/hooks/app/useHomeDir";
import { resolveWorkspaceCwd } from "@/utils/workspaceCwd";
import {
  RENDERER_ACTIVATION_ORIGIN,
  clearHostAppliedActivation,
  consumeHostAppliedActivation,
  hasHostAppliedActivation,
  markActivationRequested,
} from "@/store/worktreeActivationOrigin";

// Main first, else the head of the list as `useWorktrees` orders it. The sort
// only runs for a Map without a main worktree.
function pickFallbackWorktreeId(worktrees: Map<string, WorktreeSnapshot>): string | null {
  for (const worktree of worktrees.values()) {
    if (worktree.isMainWorktree) return worktree.id;
  }
  return getNormalizedWorktreeList(worktrees)[0]?.id ?? null;
}

/**
 * Runs in the app root, so it subscribes only to the primitive facts it acts on
 * — whether the active worktree is live, its path, the fallback pick — never
 * the whole worktree Map, which changes on every worktree's status tick.
 */
export function useActiveWorktreeSync() {
  const activeWorktreeId = useWorktreeSelectionStore((s) => s.activeWorktreeId);
  const restoreWorktreeId = useWorktreeSelectionStore((s) => s.restoreWorktreeId);
  const selectWorktree = useWorktreeSelectionStore((s) => s.selectWorktree);
  const setActiveWorktree = useWorktreeSelectionStore((s) => s.setActiveWorktree);
  const deletedWorktrees = useWorktreeSelectionStore((s) => s.deletedWorktrees);
  const currentProject = useProjectStore((s) => s.currentProject);
  const currentScratch = useScratchStore((s) => s.currentScratch);
  const { homeDir } = useHomeDir();
  const isInitialized = useWorktreeStore((s) => s.isInitialized);
  const activeWorktreeIsLive = useWorktreeStore(
    (s) => activeWorktreeId !== null && s.worktrees.has(activeWorktreeId)
  );
  const activeWorktreePath = useWorktreeStore((s) =>
    activeWorktreeId !== null ? s.worktrees.get(activeWorktreeId)?.path : undefined
  );
  const hasWorktrees = useWorktreeStore((s) => s.worktrees.size > 0);
  // Only needed once the selection is no longer valid (neither live nor a
  // deleted-worktree row); resolving it otherwise would re-render on
  // activity-order changes in a Map with no main worktree.
  const fallbackWorktreeId = useWorktreeStore((s) =>
    activeWorktreeId !== null &&
    (s.worktrees.has(activeWorktreeId) || deletedWorktrees.has(activeWorktreeId))
      ? null
      : pickFallbackWorktreeId(s.worktrees)
  );
  const worktreeStore = useWorktreeStoreApi();
  // The activation sync used to re-run on every worktree Map change, and two
  // things lean on that: a failed `set-active` is retried on the next change,
  // and an unconsumed host-applied mark expires on it. Keep both without
  // subscribing to the Map — a change re-runs the sync only while one of them
  // is pending.
  const retryActivationRef = useRef(false);
  const [activationRecheck, setActivationRecheck] = useState(0);
  useEffect(
    () =>
      worktreeStore.subscribe((state, prev) => {
        if (state.worktrees === prev.worktrees) return;
        if (!retryActivationRef.current && !hasHostAppliedActivation()) return;
        retryActivationRef.current = false;
        setActivationRecheck((n) => n + 1);
      }),
    [worktreeStore]
  );

  const lastSyncedActiveRef = useRef<{ projectId: string | null; worktreeId: string | null }>({
    projectId: null,
    worktreeId: null,
  });
  // Whether the pick was the durable restore target is captured at send time,
  // non-reactively: a change to the restore target alone must not re-run the
  // sync effect, and a ref written during render is a compiler bailout.
  const recordActivationRequest = useEffectEvent((worktreeId: string) => {
    markActivationRequested(worktreeId, restoreWorktreeId === worktreeId);
  });

  useEffect(() => {
    if (!isInitialized) return;

    // A deleted-worktree row (directory gone, terminals surviving) is a valid
    // active selection — the user clicked it to view its terminals. Only snap
    // back to main once the id is neither live nor a deleted row (e.g. its
    // last terminal closed and the row was pruned). Checked before the empty
    // branch: a deleted row outlives the last live worktree while it still owns
    // a terminal, so an empty list does not invalidate it.
    const activeSelectionIsValid =
      activeWorktreeId !== null && (activeWorktreeIsLive || deletedWorktrees.has(activeWorktreeId));
    if (activeSelectionIsValid) return;

    // Past `isInitialized`, an empty list is the workspace's real answer, not a
    // pending load — a non-git workspace creates no monitors. Clear the id a
    // previous project left behind rather than snapping to a main worktree that
    // does not exist, or every launch resolves against a phantom target
    // (#11654). Session-scoped: the persisted `activeWorktreeId` slot is
    // app-global, so writing null through it would wipe the saved selection of
    // the git-backed project that left this id behind — the same reasoning that
    // makes `stateHydration` skip the write rather than clear. Guarded on a
    // non-null id because `setActiveWorktree` re-runs terminal policy on every
    // call.
    if (!hasWorktrees || fallbackWorktreeId === null) {
      if (activeWorktreeId !== null) {
        setActiveWorktree(null, { persist: false });
      }
      return;
    }

    selectWorktree(fallbackWorktreeId);
  }, [
    activeWorktreeIsLive,
    hasWorktrees,
    fallbackWorktreeId,
    activeWorktreeId,
    isInitialized,
    selectWorktree,
    setActiveWorktree,
    deletedWorktrees,
  ]);

  useEffect(() => {
    const projectId = currentProject?.id ?? null;
    const selectedWorktreeId = activeWorktreeId ?? null;

    if (!projectId || !selectedWorktreeId) {
      lastSyncedActiveRef.current = { projectId, worktreeId: null };
      clearHostAppliedActivation();
      return;
    }

    // A selection the host pushed to us (auto-switch, another window) is
    // already the host's active id — answering with a `set-active` would only
    // start another round of activations for every attached view (#12370).
    if (consumeHostAppliedActivation(selectedWorktreeId)) {
      lastSyncedActiveRef.current = { projectId, worktreeId: selectedWorktreeId };
      return;
    }

    if (!activeWorktreeIsLive) {
      return;
    }

    if (
      lastSyncedActiveRef.current.projectId === projectId &&
      lastSyncedActiveRef.current.worktreeId === selectedWorktreeId
    ) {
      return;
    }

    lastSyncedActiveRef.current = { projectId, worktreeId: selectedWorktreeId };
    retryActivationRef.current = false;
    // The selection is already applied locally; the origin tag lets the
    // `worktree-activated` echo be skipped instead of re-selecting an id this
    // view may have moved past by the time it lands (#12370). Whether it was
    // the durable pick is captured now, so a later catch-up re-apply can keep
    // the source it was made with.
    recordActivationRequest(selectedWorktreeId);
    window.electron.worktreePort
      .request("set-active", {
        worktreeId: selectedWorktreeId,
        origin: RENDERER_ACTIVATION_ORIGIN,
      })
      .catch(() => {
        if (
          lastSyncedActiveRef.current.projectId === projectId &&
          lastSyncedActiveRef.current.worktreeId === selectedWorktreeId
        ) {
          lastSyncedActiveRef.current = { projectId, worktreeId: null };
          retryActivationRef.current = true;
        }
      });
  }, [activeWorktreeId, currentProject?.id, activeWorktreeIsLive, activationRecheck]);

  // Before the snapshot is authoritative the worktree is withheld from the
  // chain — a stale selection would spawn terminals in the wrong tree.
  const defaultTerminalCwd = useMemo(
    () =>
      resolveWorkspaceCwd({
        worktreePath: isInitialized ? activeWorktreePath : null,
        projectPath: currentProject?.path,
        scratchPath: currentScratch?.path,
        homeDir,
      }),
    [activeWorktreePath, currentProject, currentScratch, homeDir, isInitialized]
  );

  // Only a live worktree is an active one to report — a deleted-worktree row or
  // a stale id is not.
  return { activeWorktreeId: activeWorktreeIsLive ? activeWorktreeId : null, defaultTerminalCwd };
}
