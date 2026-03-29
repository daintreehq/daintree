/**
 * useTerminalStoreBootstrap - Bootstraps terminal store listeners.
 *
 * Wraps setupTerminalStoreListeners for cleaner hook usage.
 * Cross-store coordination (focus tracking, removal cleanup) is handled
 * by the renderer store orchestrator initialized in main.tsx.
 */

import { useEffect, useState } from "react";
import { setupTerminalStoreListeners } from "../../store/terminalStore";
import { useResourceMonitoringStore } from "../../store/resourceMonitoringStore";
import { isElectronAvailable } from "../useElectron";
import {
  useMemoryLeakDetection,
  DEFAULT_AUTO_RESTART_THRESHOLD_MB,
} from "../useMemoryLeakDetection";

export function useTerminalStoreBootstrap() {
  const [leakDetectionEnabled, setLeakDetectionEnabled] = useState(false);
  const [autoRestartThresholdMb, setAutoRestartThresholdMb] = useState(
    DEFAULT_AUTO_RESTART_THRESHOLD_MB
  );

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
      setLeakDetectionEnabled(leakEnabled);
      setAutoRestartThresholdMb(
        config.memoryLeakAutoRestartThresholdMb ?? DEFAULT_AUTO_RESTART_THRESHOLD_MB
      );
    });

    return () => {
      cleanupTerminalStore();
    };
  }, []);

  useMemoryLeakDetection(leakDetectionEnabled, autoRestartThresholdMb);
}
