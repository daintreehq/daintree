import { useEffect } from "react";
import { isElectronAvailable } from "./useElectron";
import { actionService } from "@/services/ActionService";
import type { ActionId } from "@shared/types/actions";
import type { SettingsNavTarget } from "@/components/Settings";
import { logError } from "@/utils/logger";

export interface UseMenuActionsOptions {
  onOpenSettings: () => void;
  onOpenSettingsTab?: (target: SettingsNavTarget) => void;
  onToggleSidebar: () => void;
  onLaunchAgent: (agentId: string) => void;
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
            logError(`[Menu] Failed to launch agent "${agentId}"`, undefined, {
              error: result.error,
            });
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
              logError("[Menu] Failed to open settings", undefined, { error: result.error });
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
              logError(`[Menu] Failed to open settings tab "${tab}"`, undefined, {
                error: result.error,
              });
            }
          }
          return;
        }

        if (action === "show-getting-started") {
          window.dispatchEvent(new CustomEvent("daintree:show-getting-started"));
          return;
        }

        const menuToActionMap: Record<string, ActionId> = {
          "clone-repo": "project.cloneRepo",
          "close-project": "project.closeActive",
          "duplicate-panel": "terminal.duplicate",
          "new-terminal": "terminal.new",
          "new-window": "app.newWindow",
          "new-worktree": "worktree.createDialog.open",
          "open-settings": "app.settings",
          "toggle-sidebar": "nav.toggleSidebar",
          "open-quick-switcher": "nav.quickSwitcher",
          "open-action-palette": "action.palette.open",
          "launch-help-agent": "help.launchAgent",
          "reload-config": "app.reloadConfig",
        };

        const actionId = menuToActionMap[action];
        if (actionId) {
          const result = await actionService.dispatch(actionId, undefined, { source: "menu" });
          if (!result.ok) {
            logError(`[Menu] Action "${actionId}" failed`, undefined, { error: result.error });
          }
        } else {
          console.warn("[Menu] Unhandled action:", action);
        }
      } catch (error) {
        logError("[Menu] Failed to process action", error, { action });
      }
    });

    return () => unsubscribe();
  }, [onOpenSettingsTab]);
}
