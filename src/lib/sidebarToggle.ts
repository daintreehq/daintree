import { terminalInstanceService } from "@/services/terminal/TerminalInstanceService";
import { useHelpPanelStore } from "@/store/helpPanelStore";
import { usePanelStore } from "@/store/panelStore";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { SIDEBAR_TOGGLE_LOCK_MS } from "./terminalLayout";

/**
 * Freeze PTY resize propagation across a sidebar's width transition. Without
 * this gating, the per-frame flex reflow as a sidebar animates causes xterm's
 * ResizeObserver to deliver mid-animation dimensions to the PTY host,
 * producing visible jitter on the panel grid's right edge — and, for the
 * dock-located Assistant terminal, a stuck-narrow xterm when the panel
 * collapses to 0 and back.
 *
 * Suppression covers grid panels on the active worktree (worktree-sidebar
 * transitions) and the Assistant's dock terminal (assistant-panel
 * transitions). Both transitions can be triggered from the same focus-mode
 * gesture, so we lock everything for the same duration.
 */
export function suppressSidebarResizes(): void {
  const activeWorktreeId = useWorktreeSelectionStore.getState().activeWorktreeId;
  const panelState = usePanelStore.getState();
  const ids: string[] = [];
  for (const id of panelState.panelIds) {
    const panel = panelState.panelsById[id];
    if (panel && panel.location === "grid" && panel.worktreeId === activeWorktreeId) {
      ids.push(panel.id);
    }
  }
  const assistantTerminalId = useHelpPanelStore.getState().terminalId;
  if (assistantTerminalId && panelState.panelsById[assistantTerminalId]) {
    ids.push(assistantTerminalId);
  }
  terminalInstanceService.suppressResizesDuringLayoutTransition(ids, SIDEBAR_TOGGLE_LOCK_MS);
}
