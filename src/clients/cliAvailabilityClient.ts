import type { CliAvailability, AgentCliDetails } from "@shared/types";
import type { AgentCliCopy } from "@shared/types/ipc/system";

/**
 * @example
 * ```typescript
 * import { cliAvailabilityClient } from "@/clients";
 *
 * // Get cached CLI availability (fast, uses cache)
 * const availability = await cliAvailabilityClient.get();
 * if (availability.claude) {
 *   // Claude CLI is available
 * }
 *
 * // Force refresh (re-checks all CLIs)
 * const updated = await cliAvailabilityClient.refresh();
 * ```
 */
export const cliAvailabilityClient = {
  get: (): Promise<CliAvailability> => {
    return window.electron.system.getCliAvailability();
  },

  /**
   * Use sparingly - typically only on user action or settings change.
   */
  refresh: (): Promise<CliAvailability> => {
    return window.electron.system.refreshCliAvailability();
  },

  /**
   * Fetch the detailed per-agent detection info (resolved path, probe source,
   * block reason, WSL distro). Populated alongside the availability map by
   * `checkAvailability()`/`refresh()` — this call returns the cached details
   * and only triggers a probe if nothing has been cached yet.
   */
  getDetails: (): Promise<AgentCliDetails> => {
    return window.electron.system.getAgentCliDetails();
  },

  /**
   * Every copy of one agent's CLI with the version each reports, the launching
   * copy first. Runs each copy on the machine the agent runs on, so call it only
   * while someone is looking at the answer.
   */
  getCopies: (agentId: string): Promise<AgentCliCopy[]> => {
    return window.electron.agentCliCopies.list(agentId);
  },
} as const;
