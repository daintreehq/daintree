import { useEffect } from "react";
import { useTerminalStore } from "@/store/terminalStore";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { isElectronAvailable } from "./useElectron";

export interface UseMenuActionsOptions {
  onOpenSettings: () => void;
  onOpenSettingsTab?: (tab: string) => void;
  onToggleSidebar: () => void;
  onOpenAgentPalette: () => void;
  onLaunchAgent: (agentId: "claude" | "gemini" | "codex" | "terminal") => void;
  defaultCwd: string;
  activeWorktreeId?: string;
}

export function useMenuActions({
  onOpenSettings,
  onOpenSettingsTab,
  onToggleSidebar,
  onOpenAgentPalette,
  onLaunchAgent,
  defaultCwd,
  activeWorktreeId,
}: UseMenuActionsOptions): void {
  const addTerminal = useTerminalStore((state) => state.addTerminal);
  const openCreateWorktreeDialog = useWorktreeSelectionStore((state) => state.openCreateDialog);

  useEffect(() => {
    if (!isElectronAvailable()) return;

    const unsubscribe = window.electron.app.onMenuAction((action) => {
      const LAUNCH_AGENT_PREFIX = "launch-agent:";
      const OPEN_SETTINGS_PREFIX = "open-settings:";

      if (action.startsWith(LAUNCH_AGENT_PREFIX)) {
        const agentId = action.slice(LAUNCH_AGENT_PREFIX.length);

        if (!agentId) {
          console.warn("[Menu] Empty agent ID in action:", action);
          return;
        }

        onLaunchAgent(agentId as "claude" | "gemini" | "codex" | "terminal");
        return;
      }

      if (action.startsWith(OPEN_SETTINGS_PREFIX)) {
        const tab = action.slice(OPEN_SETTINGS_PREFIX.length).trim();
        if (!tab) {
          onOpenSettings();
          return;
        }
        onOpenSettingsTab?.(tab);
        return;
      }

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

        default:
          console.warn("[Menu] Unhandled action:", action);
      }
    });

    return () => unsubscribe();
  }, [
    addTerminal,
    openCreateWorktreeDialog,
    onOpenSettings,
    onOpenSettingsTab,
    onToggleSidebar,
    onOpenAgentPalette,
    onLaunchAgent,
    defaultCwd,
    activeWorktreeId,
  ]);
}
