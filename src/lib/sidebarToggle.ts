import { terminalInstanceService } from "@/services/terminal/TerminalInstanceService";
import { usePanelStore } from "@/store/panelStore";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { SIDEBAR_TOGGLE_LOCK_MS } from "./terminalLayout";

/**
 * Freeze PTY resize propagation for grid panels on the active worktree
 * across the sidebar's width transition. Without this gating, the per-frame
 * flex reflow as the sidebar animates causes xterm's ResizeObserver to
 * deliver mid-animation dimensions to the PTY host, producing visible
 * jitter on the panel grid's right edge.
 *
 * Intended to be called from the `daintree:toggle-focus-mode` listener
 * right before the focus state flips — putting it on the listener side
 * keeps dispatchers (App.tsx, worktreeStore dialog-open paths) free of
 * the `panelStore` import cycle.
 */
export function suppressSidebarResizes(): void {
  const activeWorktreeId = useWorktreeSelectionStore.getState().activeWorktreeId;
  const panelState = usePanelStore.getState();
  const gridIds: string[] = [];
  for (const id of panelState.panelIds) {
    const panel = panelState.panelsById[id];
    if (panel && panel.location === "grid" && panel.worktreeId === activeWorktreeId) {
      gridIds.push(panel.id);
    }
  }
  terminalInstanceService.suppressResizesDuringLayoutTransition(gridIds, SIDEBAR_TOGGLE_LOCK_MS);
}
