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
import { useMemoryLeakDetection } from "../useMemoryLeakDetection";
import {
  useMemoryLeakConfigStore,
  DEFAULT_AUTO_RESTART_THRESHOLD_MB,
} from "../../store/memoryLeakConfigStore";

export function useTerminalStoreBootstrap() {
  const leakDetectionEnabled = useMemoryLeakConfigStore((s) => s.enabled);
  const autoRestartThresholdMb = useMemoryLeakConfigStore((s) => s.autoRestartThresholdMb);

  useEffect(() => {
    if (!isElectronAvailable()) return;
    const cleanupTerminalStore = setupTerminalStoreListeners();

    // Hydrate resource monitoring preference and activate backend if enabled
    window.electron.terminalConfig.get().then((config) => {
      const resourceEnabled = config.resourceMonitoringEnabled === true;
      useResourceMonitoringStore.getState().setEnabled(resourceEnabled);
      if (resourceEnabled) {
        window.electron.terminalConfig.setResourceMonitoring(true);
      }

      // Memory leak detection defaults to on when resource monitoring is on
      const leakEnabled = config.memoryLeakDetectionEnabled ?? resourceEnabled;
      useMemoryLeakConfigStore.getState().setEnabled(leakEnabled);
      useMemoryLeakConfigStore
        .getState()
        .setAutoRestartThresholdMb(
          config.memoryLeakAutoRestartThresholdMb ?? DEFAULT_AUTO_RESTART_THRESHOLD_MB
        );
    });

    return () => {
      cleanupTerminalStore();
    };
  }, []);

  useMemoryLeakDetection(leakDetectionEnabled, autoRestartThresholdMb);
}
