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
 *
 * `commandsApproved` says whether the file this block came from may run. The
 * `connect` command is withheld when it may not: it is launched in a terminal,
 * written into the `daintree-remote` wrapper, and handed to agents as context,
 * so a published connect command must be one the user has approved. The
 * capability flags are published either way — they describe what is
 * configured, and every execution path checks approval for itself.
 */
export function applyResourceConfigToMonitor(
  monitor: WorktreeMonitor,
  resourceConfig: ResourceConfig,
  sub: (cmd: string) => string,
  commandsApproved: boolean
): void {
  monitor.setHasResourceConfig(true);
  monitor.setHasStatusCommand(!!resourceConfig.status);
  monitor.setHasPauseCommand(!!resourceConfig.pause?.length);
  monitor.setHasResumeCommand(!!resourceConfig.resume?.length);
  monitor.setHasTeardownCommand(!!resourceConfig.teardown?.length);
  monitor.setHasProvisionCommand(!!resourceConfig.provision?.length);
  monitor.setResourceProvider(resourceConfig.provider);
  monitor.setResourceConnectCommand(
    commandsApproved && resourceConfig.connect ? sub(resourceConfig.connect) : undefined
  );
  if (resourceConfig.statusInterval) {
    monitor.setResourcePollInterval(resourceConfig.statusInterval * 1000);
  }
}
