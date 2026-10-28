/**
 * usePanelStoreBootstrap - Bootstraps terminal store listeners.
 *
 * Wraps setupTerminalStoreListeners for cleaner hook usage.
 * Cross-store coordination (focus tracking, removal cleanup) is handled
 * by the renderer store orchestrator initialized in main.tsx.
 */

import { useEffect } from "react";
import { setupTerminalStoreListeners } from "../../store/panelStore";
import { setupProjectStatsListeners } from "../../store/projectStatsStore";
import { setupFleetSnapshotListeners } from "../../store/fleetSnapshotStore";
import { setupTerminalAdoptionListeners } from "../../store/terminalAdoptionStore";
import { setupRateLimitObservationListeners } from "../../store/rateLimitObservationStore";
import { setupSystemWakeListeners } from "../../store/systemWakeStore";
import { isElectronAvailable } from "../useElectron";
import { useMemoryLeakDetection } from "../useMemoryLeakDetection";
import { useMemoryLeakConfigStore } from "../../store/memoryLeakConfigStore";

/**
 * The memory-leak setting it reads is kept current by `initTerminalConfigSync`
 * (#14699).
 */
export function usePanelStoreBootstrap() {
  const leakDetectionEnabled = useMemoryLeakConfigStore((s) => s.enabled);

  useEffect(() => {
    if (!isElectronAvailable()) return;
    const cleanupTerminalStore = setupTerminalStoreListeners();
    const cleanupProjectStats = setupProjectStatsListeners();
    const cleanupFleetSnapshot = setupFleetSnapshotListeners();
    const cleanupTerminalAdoptions = setupTerminalAdoptionListeners();
    const cleanupRateLimitObservations = setupRateLimitObservationListeners();
    const cleanupSystemWake = setupSystemWakeListeners();

    return () => {
      cleanupTerminalStore();
      cleanupProjectStats();
      cleanupFleetSnapshot();
      cleanupTerminalAdoptions();
      cleanupRateLimitObservations();
      cleanupSystemWake();
    };
  }, []);

  useMemoryLeakDetection(leakDetectionEnabled);
}
