import { usePanelStore } from "@/store/panelStore";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { getCurrentViewStoreOrNull } from "@/store/createWorktreeStore";

/**
 * Cross-worktree move that follows the terminal when the gesture rescues the
 * last survivor off a deleted-worktree row (#11273).
 *
 * A deleted-worktree row is derived state: it lives only while a panel still
 * points at the dead worktree, and `WorktreeStoreContext`'s panel-store
 * subscriber prunes it synchronously during the move below. Without a follow,
 * the row vanishes under the user's own selection and `useActiveWorktreeSync`
 * snaps to main, stranding the rescued session off-screen.
 *
 * The follow decision is a before/after membership diff rather than a
 * "was this the last terminal" prediction, so it cannot drift from the prune's
 * own rule and it covers grouped moves (which relocate the whole tab group)
 * for free. Every other row-death route — closed, trashed, dismissed,
 * auto-cleanup — never reaches here and keeps falling back to main.
 */
export function moveTerminalToWorktreeAndFollowRescue(
  terminalId: string,
  targetWorktreeId: string
): void {
  const panel = usePanelStore.getState().panelsById[terminalId];
  if (!panel || panel.worktreeId === targetWorktreeId) return;

  const sourceWorktreeId = panel.worktreeId;
  const before = useWorktreeSelectionStore.getState();
  const wasRescuingActiveDeletedRow =
    sourceWorktreeId != null &&
    before.activeWorktreeId === sourceWorktreeId &&
    before.deletedWorktrees.has(sourceWorktreeId);

  usePanelStore.getState().moveTerminalToWorktree(terminalId, targetWorktreeId);
  usePanelStore.getState().setFocused(null);

  if (!wasRescuingActiveDeletedRow) return;

  // Re-read: the prune replaced the selection state and its `deletedWorktrees`
  // map, so the pre-move snapshot is stale.
  const after = useWorktreeSelectionStore.getState();
  if (after.deletedWorktrees.has(sourceWorktreeId)) return;

  // The drag paths already reject a dead destination, but `terminal.moveToWorktree`
  // takes any string from the action layer. Following an unverified id would make
  // it the durable restore target, so confirm liveness rather than trusting the
  // caller — and skip the follow entirely if no view store can answer.
  if (!getCurrentViewStoreOrNull()?.getState().worktrees.has(targetWorktreeId)) return;

  // `"user"`, not `"focus"`: the rescue is a deliberate gesture, so the
  // destination should become the durable restore target and land in the MRU
  // (#9512). This also restores the destination's last-focused terminal, which
  // is what the fallback-to-main path already did — only the target changes.
  after.selectWorktree(targetWorktreeId);
  after.retargetParkedFleetSelection(targetWorktreeId);
}
