import { useEffect } from "react";
import { isElectronAvailable } from "./useElectron";
import { actionService } from "@/services/ActionService";
import type { ActionId } from "@shared/types/actions";

export interface UseMenuActionsOptions {
  onOpenSettings: () => void;
  onOpenSettingsTab?: (tab: string) => void;
  onToggleSidebar: () => void;
  onOpenAgentPalette: () => void;
  onLaunchAgent: (
    agentId: "claude" | "gemini" | "codex" | "opencode" | "terminal" | "browser"
  ) => void;
  defaultCwd: string;
  activeWorktreeId?: string;
}

export function useMenuActions(options: UseMenuActionsOptions): void {
  const { onOpenSettingsTab } = options;

  useEffect(() => {
    if (!isElectronAvailable()) return;
    if (typeof window.electron?.app?.onMenuAction !== "function") return;

    const unsubscribe = window.electron.app.onMenuAction(async (action) => {
      try {
        if (typeof action !== "string") {
          console.warn("[Menu] Invalid action payload:", action);
          return;
        }

        const LAUNCH_AGENT_PREFIX = "launch-agent:";
        const OPEN_SETTINGS_PREFIX = "open-settings:";

        if (action.startsWith(LAUNCH_AGENT_PREFIX)) {
          const agentId = action.slice(LAUNCH_AGENT_PREFIX.length);

          if (!agentId) {
            console.warn("[Menu] Empty agent ID in action:", action);
            return;
          }

          const result = await actionService.dispatch(
            "agent.launch",
            { agentId },
            { source: "menu" }
          );
          if (!result.ok) {
            console.error(`[Menu] Failed to launch agent "${agentId}":`, result.error);
          }
          return;
        }

        if (action.startsWith(OPEN_SETTINGS_PREFIX)) {
          const tab = action.slice(OPEN_SETTINGS_PREFIX.length).trim();
          if (!tab) {
            const result = await actionService.dispatch("app.settings", undefined, {
              source: "menu",
            });
            if (!result.ok) {
              console.error("[Menu] Failed to open settings:", result.error);
            }
            return;
          }
          if (onOpenSettingsTab) {
            const result = await actionService.dispatch(
              "app.settings.openTab",
              { tab },
              { source: "menu" }
            );
            if (!result.ok) {
              console.error(`[Menu] Failed to open settings tab "${tab}":`, result.error);
            }
          }
          return;
        }

        const menuToActionMap: Record<string, ActionId> = {
          "new-terminal": "terminal.new",
          "new-worktree": "worktree.createDialog.open",
          "open-settings": "app.settings",
          "toggle-sidebar": "nav.toggleSidebar",
          "open-agent-palette": "terminal.palette",
          "open-panel-palette": "panel.palette",
          "open-assistant": "assistant.open",
        };

        const actionId = menuToActionMap[action];
        if (actionId) {
          const result = await actionService.dispatch(actionId, undefined, { source: "menu" });
          if (!result.ok) {
            console.error(`[Menu] Action "${actionId}" failed:`, result.error);
          }
        } else {
          console.warn("[Menu] Unhandled action:", action);
        }
      } catch (error) {
        console.error("[Menu] Failed to process action:", action, error);
      }
    });

    return () => unsubscribe();
  }, [onOpenSettingsTab]);
}
