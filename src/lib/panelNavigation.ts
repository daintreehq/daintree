import { actionService } from "@/services/ActionService";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";

/**
 * Take the keyboard to `panelId`, in `worktreeId` (the panel's own, or null
 * when it has none), switching worktrees first when it lives in another one.
 * `panel.focus` alone can't do that: focus-follow never fires for a panel that
 * is already the focused one. Resolves true once the panel has focus, false
 * when a step refused.
 */
export async function focusPanelInItsWorktree(
  panelId: string,
  worktreeId: string | null | undefined
): Promise<boolean> {
  const selection = useWorktreeSelectionStore.getState();
  if (worktreeId && worktreeId !== selection.activeWorktreeId) {
    // Recorded first so the switch restores this panel rather than whichever
    // one the worktree last had focused.
    selection.trackTerminalFocus(worktreeId, panelId);
    if (selection.deletedWorktrees.has(worktreeId)) {
      // A surviving panel of a deleted worktree. Session-only, as the deleted
      // card does it: a user-sourced selection would persist an id that no
      // longer exists as the restore target.
      selection.selectWorktree(worktreeId, { source: "focus" });
    } else {
      const selected = await actionService.dispatch("worktree.select", { worktreeId });
      if (!selected.ok) return false;
    }
  }
  const focused = await actionService.dispatch("panel.focus", { panelId });
  return focused.ok;
}
