/**
 * Boot-time database probe and recovery. MUST complete before getSharedDb()
 * opens the file.
 *
 * The clean-exit signal is the previous session's own sentinel, not the crash
 * count: the count only covers launches inside the crash-loop window, so a
 * session that died more than 30 minutes after launch reads as zero crashes
 * and would skip the full scan (#15631).
 */
export async function initializeDatabaseForBoot(guard: {
  wasPreviousExitClean: () => boolean;
}): Promise<void> {
  // Dynamic import keeps the service off main.ts's static import graph and its
  // sync probe off top-of-module evaluation; shutdown.ts and
  // globalServicesInit.ts still pull it in eagerly. The 200ms startMaintenance()
  // timer and suspend listener are the `database-maintenance` deferred task in
  // globalServicesInit. See #8817.
  const { initializeDatabaseMaintenance } =
    await import("../services/DatabaseMaintenanceService.js");
  initializeDatabaseMaintenance(guard.wasPreviousExitClean());
}
