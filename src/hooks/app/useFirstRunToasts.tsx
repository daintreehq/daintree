/**
 * useFirstRunToasts - Handles first-run toast notifications.
 *
 * Shows helpful keyboard shortcuts on first run.
 */

import { useEffect } from "react";
import { shouldShowFirstRunToast, markFirstRunToastSeen } from "../../lib/firstRunToast";
import { keybindingService } from "../../services/KeybindingService";
import { Kbd } from "../../components/ui/Kbd";
import { isElectronAvailable } from "../useElectron";
import { useNotificationStore } from "../../store";

export function useFirstRunToasts(isStateLoaded: boolean) {
  const addNotification = useNotificationStore((state) => state.addNotification);

  useEffect(() => {
    if (!isElectronAvailable() || !isStateLoaded) {
      return;
    }

    if (shouldShowFirstRunToast()) {
      markFirstRunToastSeen();

      const shortcuts = [
        { id: "terminal.palette", label: "switch terminals" },
        { id: "terminal.new", label: "new terminal" },
        { id: "worktree.openPalette", label: "worktrees" },
      ];

      const shortcutElements = shortcuts.map(({ id, label }, index) => {
        const combo = keybindingService.getDisplayCombo(id);
        return (
          <span key={id}>
            <Kbd>{combo}</Kbd> ({label}){index < shortcuts.length - 1 ? ", " : ""}
          </span>
        );
      });

      addNotification({
        type: "info",
        title: "Quick Shortcuts",
        message: <div className="flex flex-wrap gap-x-1">{shortcutElements}</div>,
        duration: 9000,
      });
    }
  }, [isStateLoaded, addNotification]);
}
