import { useEffect } from "react";
import { keybindingService } from "../../services/KeybindingService";
import { Kbd } from "../../components/ui/Kbd";
import { isElectronAvailable } from "../useElectron";
import { notify } from "../../lib/notify";

export function useFirstRunToasts(isStateLoaded: boolean) {
  useEffect(() => {
    if (!isElectronAvailable() || !isStateLoaded) {
      return;
    }
    if (!window.electron?.onboarding) return;

    window.electron.onboarding
      .get()
      .then((state) => {
        if (!state.completed || state.firstRunToastSeen) return;

        void window.electron.onboarding.markToastSeen();

        const shortcuts = [
          { id: "nav.quickSwitcher", label: "switch terminals" },
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

        notify({
          type: "info",
          priority: "low",
          title: "Quick Shortcuts",
          message: <div className="flex flex-wrap gap-x-1">{shortcutElements}</div>,
          inboxMessage: "Keyboard shortcuts are available — use the action palette to explore",
          duration: 9000,
        });
      })
      .catch(console.error);
  }, [isStateLoaded]);
}
