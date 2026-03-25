/**
 * useTerminalStoreBootstrap - Bootstraps terminal store listeners.
 *
 * Wraps setupTerminalStoreListeners for cleaner hook usage.
 * Cross-store coordination (focus tracking, removal cleanup) is handled
 * by the renderer store orchestrator initialized in main.tsx.
 */

import { useEffect } from "react";
import { setupTerminalStoreListeners } from "../../store/terminalStore";
import { useResourceMonitoringStore } from "../../store/resourceMonitoringStore";
import { isElectronAvailable } from "../useElectron";

export function useTerminalStoreBootstrap() {
  useEffect(() => {
    if (!isElectronAvailable()) return;
    const cleanupTerminalStore = setupTerminalStoreListeners();

    // Hydrate resource monitoring preference and activate backend if enabled
    window.electron.terminalConfig.get().then((config) => {
      const enabled = config.resourceMonitoringEnabled === true;
      useResourceMonitoringStore.getState().setEnabled(enabled);
      if (enabled) {
        window.electron.terminalConfig.setResourceMonitoring(true);
      }
    });

    return () => {
      cleanupTerminalStore();
    };
  }, []);
}
