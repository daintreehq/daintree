import { useEffect } from "react";
import { isElectronAvailable } from "./useElectron";
import { startUndoCloseMenuPublisher } from "@/services/terminal/undoCloseMenu";

/** Keeps Edit > Undo naming the close the next Cmd+Z in this view would reopen (#17108). */
export function useUndoCloseMenuLabel(): void {
  useEffect(() => {
    if (!isElectronAvailable()) return;
    const menu = window.electron?.menu;
    if (typeof menu?.setUndoClose !== "function") return;
    return startUndoCloseMenuPublisher((state) => {
      // A label update lost while the view goes away is nothing to report:
      // main drops the view's label with it.
      menu.setUndoClose(state).catch(() => undefined);
    });
  }, []);
}
