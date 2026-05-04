import type { WorktreeMonitor } from "./WorktreeMonitor.js";
import type { ResourceConfig } from "./WorktreeLifecycleService.js";

/**
 * Apply a resolved `ResourceConfig` to a `WorktreeMonitor`'s metadata setters.
 *
 * The same 8-setter sequence (plus optional `connect` substitution and
 * `statusInterval` poll wiring) was duplicated verbatim across
 * `initResourceConfigAsync`, `runLifecycleSetup`, and `_executeResourceAction`.
 * This helper centralizes the application; the *resolution* logic above each
 * call site is intentionally left inline because each call site uses a
 * subtly different fallback chain.
 */
export function applyResourceConfigToMonitor(
  monitor: WorktreeMonitor,
  resourceConfig: ResourceConfig,
  sub: (cmd: string) => string
): void {
  monitor.setHasResourceConfig(true);
  monitor.setHasStatusCommand(!!resourceConfig.status);
  monitor.setHasPauseCommand(!!resourceConfig.pause?.length);
  monitor.setHasResumeCommand(!!resourceConfig.resume?.length);
  monitor.setHasTeardownCommand(!!resourceConfig.teardown?.length);
  monitor.setHasProvisionCommand(!!resourceConfig.provision?.length);
  monitor.setResourceProvider(resourceConfig.provider);
  monitor.setResourceConnectCommand(
    resourceConfig.connect ? sub(resourceConfig.connect) : undefined
  );
  if (resourceConfig.statusInterval) {
    monitor.setResourcePollInterval(resourceConfig.statusInterval * 1000);
  }
}
