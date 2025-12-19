/**
 * useTerminalStoreBootstrap - Bootstraps terminal store listeners.
 *
 * Wraps setupTerminalStoreListeners for cleaner hook usage.
 */

import { useEffect } from "react";
import { setupTerminalStoreListeners } from "../../store/terminalStore";
import { setupWorktreeFocusTracking } from "../../store/worktreeStore";
import { isElectronAvailable } from "../useElectron";

export function useTerminalStoreBootstrap() {
  useEffect(() => {
    if (!isElectronAvailable()) return;
    const cleanupTerminalStore = setupTerminalStoreListeners();
    const cleanupFocusTracking = setupWorktreeFocusTracking();
    return () => {
      cleanupTerminalStore();
      cleanupFocusTracking();
    };
  }, []);
}
