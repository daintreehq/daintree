import { usePanelStore } from "@/store";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { isVisibleGridPanel } from "@/store/panelFocusFallback";

/**
 * How the user is reading the grid when they pick a row from the Waiting or
 * Unread pill: fullscreen on one pane, or the grid itself. `null` inside fleet
 * scope, which renders over maximize and parks every worktree's, so there is no
 * mode to carry.
 */
export type AgentRowViewingMode = "fullscreen" | "grid" | null;

/**
 * Read before the row's navigation runs: a worktree switch swaps in the
 * destination's own maximize, which would read as the user's mode.
 */
export function readAgentRowViewingMode(): AgentRowViewingMode {
  if (useWorktreeSelectionStore.getState().isFleetScopeActive) return null;
  const { maximizedId, maximizeTarget } = usePanelStore.getState();
  return maximizedId !== null && maximizeTarget !== null ? "fullscreen" : "grid";
}

/**
 * Keep the mode for the picked panel (#15335): fullscreen moves to it, and a
 * grid reader stays in the grid even when the destination worktree had a
 * maximize parked. Runs after the worktree switch and before `activateTerminal`,
 * so activation finds its panel already the maximized cell and leaves
 * fullscreen up. A dock pane opens in its popover over whatever the grid shows,
 * so it changes nothing.
 */
export function applyAgentRowViewingMode(mode: AgentRowViewingMode, panelId: string): void {
  if (mode === null) return;
  const panels = usePanelStore.getState();
  const panel = panels.panelsById[panelId];
  const activeWorktreeId = useWorktreeSelectionStore.getState().activeWorktreeId;
  if (!panel || !isVisibleGridPanel(panel, activeWorktreeId)) return;
  if (mode === "fullscreen") {
    panels.maximizePanel(panelId, panels.getPanelGroup);
  } else if (panels.maximizedId !== null && panels.maximizeTarget !== null) {
    panels.exitMaximize();
  }
}
