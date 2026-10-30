import { actionService } from "@/services/ActionService";
import { usePanelStore } from "@/store/panelStore";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";

/**
 * The way back to a draft whose close-prompt Save didn't land (#15017): the
 * panel's worktree, its tab, Edit mode — where the editor shows the conflict,
 * the missing file or the write error with its recovery — then `panel.focus`.
 * The walk `openPluginAttentionPanel` takes, plus the mode. Re-checked at the
 * click, since the panel can close or move while the toast is up.
 */
export async function showFileDraft(panelId: string): Promise<void> {
  const state = usePanelStore.getState();
  const panel = state.panelsById[panelId];
  if (!panel) return;
  if (panel.location !== undefined && panel.location !== "grid" && panel.location !== "dock") {
    return;
  }
  const worktreeId = panel.worktreeId?.trim();
  const selection = useWorktreeSelectionStore.getState();
  if (worktreeId && worktreeId !== selection.activeWorktreeId) {
    selection.trackTerminalFocus(worktreeId, panelId);
    selection.selectWorktree(worktreeId);
  }
  // Only a file panel stores its mode; a file browser keeps Edit in the pane,
  // so it is brought forward as it stands.
  state.setFileViewMode(panelId, "edit");
  // A group renders its stored tab over the focused one.
  const group = state.getPanelGroup(panelId);
  if (group) state.setActiveTab(group.id, panelId);
  const result = await actionService.dispatch("panel.focus", { panelId }, { source: "user" });
  if (result.ok) usePanelStore.getState().pingTerminal(panelId);
}
