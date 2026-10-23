import { actionService } from "@/services/ActionService";
import { usePanelStore } from "@/store/panelStore";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";

/**
 * Take the user to a plugin panel from its attention row (#13821): its worktree,
 * its tab, then `panel.focus`, the way the dock's agent rows reveal a terminal.
 * Re-checked at the click, since the panel can close or move between the list
 * rendering and the press. Resolves whether the panel took focus.
 */
export async function openPluginAttentionPanel(panelId: string): Promise<boolean> {
  const state = usePanelStore.getState();
  const panel = state.panelsById[panelId];
  if (!panel) return false;
  if (panel.location !== undefined && panel.location !== "grid" && panel.location !== "dock") {
    return false;
  }
  const worktreeId = panel.worktreeId?.trim();
  const selection = useWorktreeSelectionStore.getState();
  if (worktreeId && worktreeId !== selection.activeWorktreeId) {
    selection.trackTerminalFocus(worktreeId, panelId);
    selection.selectWorktree(worktreeId);
  }
  const group = state.getPanelGroup(panelId);
  if (group) state.setActiveTab(group.id, panelId);
  const result = await actionService.dispatch("panel.focus", { panelId }, { source: "user" });
  if (!result.ok) return false;
  usePanelStore.getState().pingTerminal(panelId);
  return true;
}
