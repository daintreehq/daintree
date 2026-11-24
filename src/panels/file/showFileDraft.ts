import { isFileBrowserPanel, type FileBrowserPanelData } from "@shared/types/panel";
import { createVisibilityFilter, isRowPathVisible } from "@/panels/file-browser/fileBrowserTree";
import { actionService } from "@/services/ActionService";
import { useFileBrowserDraftReviewStore } from "@/store/fileBrowserDraftReviewStore";
import { usePanelStore } from "@/store/panelStore";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";

const HIDE_DOTFILES_ONLY = createVisibilityFilter({ hideDotfiles: true, alwaysHiddenPatterns: [] });

/**
 * A file browser keeps its mode in the viewer, so Edit is a request the viewer
 * takes up (#17197) — and only a viewer that is on screen with the draft's file
 * in it can. So the viewer column opens, a tree scope that leaves the file out
 * goes back to the base, and a dotfile the toggle hides is shown: each of
 * those keeps the selection out of the viewer, and the draft's recovery with
 * it. One write, so no half-revealed state renders or persists.
 */
function showFileBrowserDraft(panel: FileBrowserPanelData): void {
  const path = panel.browserSelectedPath;
  if (!path) return;
  useFileBrowserDraftReviewStore.getState().requestReview(panel.id, path);
  const root = panel.browserRootPath ?? "";
  const outsideRoot = !isRowPathVisible(path, root, () => true);
  const hiddenByDotfiles =
    panel.browserHideDotfiles === true &&
    !isRowPathVisible(path, outsideRoot ? "" : root, HIDE_DOTFILES_ONLY);
  usePanelStore.getState().setFileBrowserView(panel.id, {
    browserViewerCollapsed: false,
    ...(outsideRoot && { browserRootPath: "" }),
    ...(hiddenByDotfiles && { browserHideDotfiles: false }),
  });
}

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
  // Before the tab comes forward, so the viewer it mounts opens in Edit.
  if (isFileBrowserPanel(panel)) showFileBrowserDraft(panel);
  else state.setFileViewMode(panelId, "edit");
  // A group renders its stored tab over the focused one.
  const group = state.getPanelGroup(panelId);
  if (group) state.setActiveTab(group.id, panelId);
  const result = await actionService.dispatch("panel.focus", { panelId }, { source: "user" });
  if (result.ok) usePanelStore.getState().pingTerminal(panelId);
}
