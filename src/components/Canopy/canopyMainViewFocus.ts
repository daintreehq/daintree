import { isRenderedGridPanel, resolvePanelGroupInfo } from "@/store/panelFocusFallback";
import { usePanelStore } from "@/store/panelStore";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { isAgentTerminal } from "@/utils/terminalType";

/**
 * The agent terminal the main view has focused, while it is on screen there:
 * in the grid, or in the dock's open popover. `focusedId` keeps naming a pane
 * after it is hidden (a background tab, behind a maximized pane, another
 * worktree), and a pane the user can't see isn't the one they were working in.
 */
export function mainViewFocusedAgentId(): string | null {
  const state = usePanelStore.getState();
  const id = state.focusedId;
  const panel = id === null ? undefined : state.panelsById[id];
  if (!panel || !isAgentTerminal(panel)) return null;
  const shown =
    panel.location === "dock"
      ? state.activeDockTerminalId === panel.id
      : isRenderedGridPanel(panel, {
          activeWorktreeId: useWorktreeSelectionStore.getState().activeWorktreeId,
          maximizedId: state.maximizedId,
          maximizeTarget: state.maximizeTarget,
          getPanelGroupInfo: (panelId) => resolvePanelGroupInfo(state, panelId),
        });
  return shown ? panel.id : null;
}
