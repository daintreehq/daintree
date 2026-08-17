import { useEffect } from "react";
import { usePanelStore } from "@/store/panelStore";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { getCurrentViewStoreOrNull } from "@/store/createWorktreeStore";
import { useWorktreesOptional } from "@/hooks/useWorktreesOptional";
import { isPtyPanel } from "@shared/types/panel";
import { deriveWorktreeDivergence } from "@/utils/worktreeAlignment";
import { notify } from "@/lib/notify";

/**
 * Drift announcements already made, as `panelId:headOid`. Module-scoped so a
 * remount can't repeat an announcement for a commit already reported.
 */
const announced = new Set<string>();

/** Test seam — the set outlives the component by design. */
export function __resetAnnouncedDrift(): void {
  announced.clear();
}

/**
 * Watches every panel that opted into divergence for commits landing in the
 * worktree its process actually runs in (#11840).
 *
 * Mounted at the app shell rather than in the pane header on purpose: a worktree
 * switch unmounts the pane, and that is precisely when this matters — the whole
 * point of the backstop is to catch commits the user cannot see being made. It
 * renders nothing; the header pill is the visual projection of the same derived
 * state.
 *
 * Scoped strictly to panels carrying recorded consent, so it never becomes a
 * general-purpose git watcher.
 */
export function WorktreeDivergenceWatcher(): null {
  const panelsById = usePanelStore((s) => s.panelsById);
  const worktrees = useWorktreesOptional();

  useEffect(() => {
    const known = [...worktrees.values()].map((w) => ({
      id: w.id,
      path: w.path,
      name: w.name,
      headOid: w.worktreeChanges?.headOid,
    }));

    for (const panel of Object.values(panelsById)) {
      if (!panel || !isPtyPanel(panel) || !panel.worktreeMoveOptOut) continue;

      const divergence = deriveWorktreeDivergence(
        {
          cwd: panel.cwd,
          worktreeId: panel.worktreeId,
          worktreeMoveOptOut: panel.worktreeMoveOptOut,
        },
        known
      );
      if (divergence.kind !== "diverged" || !divergence.headDrifted) continue;

      const currentHead = known.find(
        (w) => w.id === panel.worktreeMoveOptOut?.launchWorktreeId
      )?.headOid;
      if (!currentHead) continue;

      // Keyed on the commit, so each new one is reported once rather than on
      // every poll.
      const key = `${panel.id}:${currentHead}`;
      if (announced.has(key)) continue;
      announced.add(key);

      notify({
        type: "warning",
        title: "Commits landed in the old worktree",
        message: `${panel.title} is filed elsewhere but its commits are still landing in ${divergence.launchLabel}.`,
        // The pane is off-screen whenever this fires — that is the case it
        // exists for — so the signal has to come from outside it.
        placement: "grid-bar",
        supersedeKey: `worktree-divergence-drift:${panel.id}`,
        context: {
          eventKind: "git",
          ...(panel.worktreeMoveOptOut.launchWorktreeId && {
            worktreeId: panel.worktreeMoveOptOut.launchWorktreeId,
          }),
        },
        action: {
          label: "Show session",
          // Selecting the worktree first is the whole point: this fires while
          // another worktree is active, so activating the panel alone would
          // move focus to a pane that stays off-screen.
          onClick: () => {
            const filedUnder = panel.worktreeId;
            if (filedUnder && getCurrentViewStoreOrNull()?.getState().worktrees.has(filedUnder)) {
              useWorktreeSelectionStore.getState().selectWorktree(filedUnder);
            }
            usePanelStore.getState().activateTerminal(panel.id);
          },
        },
      });
    }
  }, [panelsById, worktrees]);

  return null;
}
