/**
 * usePanelStoreBootstrap - Bootstraps terminal store listeners.
 *
 * Wraps setupTerminalStoreListeners for cleaner hook usage.
 * Cross-store coordination (focus tracking, removal cleanup) is handled
 * by the renderer store orchestrator initialized in main.tsx.
 */

import { useEffect, useRef } from "react";
import type { TerminalConfig } from "@shared/types/ipc/config";
import { setupTerminalStoreListeners } from "../../store/panelStore";
import { setupProjectStatsListeners } from "../../store/projectStatsStore";
import { setupFleetSnapshotListeners } from "../../store/fleetSnapshotStore";
import { setupSystemWakeListeners } from "../../store/systemWakeStore";
import { useCachedProjectViewsStore } from "../../store/cachedProjectViewsStore";
import { useResourceMonitoringStore } from "../../store/resourceMonitoringStore";
import { isElectronAvailable } from "../useElectron";
import { useMemoryLeakDetection } from "../useMemoryLeakDetection";
import {
  useMemoryLeakConfigStore,
  DEFAULT_AUTO_RESTART_THRESHOLD_MB,
} from "../../store/memoryLeakConfigStore";

/**
 * @param terminalConfig optional config from the boot payload. When provided,
 *   resource-monitoring / memory-leak / cached-views hydration runs without
 *   issuing a redundant `terminal-config:get` IPC round-trip on cold start.
 */
export function usePanelStoreBootstrap(terminalConfig?: TerminalConfig | null) {
  const leakDetectionEnabled = useMemoryLeakConfigStore((s) => s.enabled);
  const autoRestartThresholdMb = useMemoryLeakConfigStore((s) => s.autoRestartThresholdMb);
  const hasHydratedConfig = useRef(false);

  useEffect(() => {
    if (!isElectronAvailable()) return;
    const cleanupTerminalStore = setupTerminalStoreListeners();
    const cleanupProjectStats = setupProjectStatsListeners();
    const cleanupFleetSnapshot = setupFleetSnapshotListeners();
    const cleanupSystemWake = setupSystemWakeListeners();

    return () => {
      cleanupTerminalStore();
      cleanupProjectStats();
      cleanupFleetSnapshot();
      cleanupSystemWake();
    };
  }, []);

  useEffect(() => {
    if (!isElectronAvailable() || hasHydratedConfig.current) return;

    const applyConfig = (config: TerminalConfig) => {
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
      useCachedProjectViewsStore.getState().setCachedProjectViews(config.cachedProjectViews ?? 1);
    };

    if (terminalConfig) {
      hasHydratedConfig.current = true;
      applyConfig(terminalConfig);
      return;
    }

    // Fallback when the boot payload didn't include terminalConfig (boot IPC
    // failed). The previous fan-out path always fetched terminal-config
    // independently, so resource monitoring/leak detection defaults must not
    // silently regress on that error path.
    let cancelled = false;
    window.electron.terminalConfig
      .get()
      .then((config) => {
        if (cancelled || hasHydratedConfig.current) return;
        hasHydratedConfig.current = true;
        applyConfig(config);
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [terminalConfig]);

  useMemoryLeakDetection(leakDetectionEnabled, autoRestartThresholdMb);
}
