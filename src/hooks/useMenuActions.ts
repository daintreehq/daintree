import { useEffect } from "react";
import { useTerminalStore } from "@/store/terminalStore";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { isElectronAvailable } from "./useElectron";

export interface UseMenuActionsOptions {
  onOpenSettings: () => void;
  onToggleSidebar: () => void;
  onOpenAgentPalette: () => void;
  defaultCwd: string;
  activeWorktreeId?: string;
}

export function useMenuActions({
  onOpenSettings,
  onToggleSidebar,
  onOpenAgentPalette,
  defaultCwd,
  activeWorktreeId,
}: UseMenuActionsOptions): void {
  const addTerminal = useTerminalStore((state) => state.addTerminal);
  const openCreateWorktreeDialog = useWorktreeSelectionStore((state) => state.openCreateDialog);

  useEffect(() => {
    if (!isElectronAvailable()) return;

    const unsubscribe = window.electron.app.onMenuAction((action) => {
      switch (action) {
        case "new-terminal":
          addTerminal({
            type: "terminal",
            cwd: defaultCwd,
            location: "grid",
            worktreeId: activeWorktreeId,
          }).catch((error) => {
            console.error("Failed to create terminal from menu:", error);
          });
          break;

        case "new-worktree":
          openCreateWorktreeDialog();
          break;

        case "open-settings":
          onOpenSettings();
          break;

        case "toggle-sidebar":
          onToggleSidebar();
          break;

        case "open-agent-palette":
          onOpenAgentPalette();
          break;

        case "split-terminal":
          break;

        default:
          console.warn("[Menu] Unhandled action:", action);
      }
    });

    return () => unsubscribe();
  }, [
    addTerminal,
    openCreateWorktreeDialog,
    onOpenSettings,
    onToggleSidebar,
    onOpenAgentPalette,
    defaultCwd,
    activeWorktreeId,
  ]);
}
