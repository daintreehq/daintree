import type { HostId } from "@shared/types/remoteHosts";
import type { ProcessInventorySnapshot } from "@shared/types/processes";
import { processesClient } from "@/clients/processesClient";

/** One reading of a host's processes; `truncated` when the host let rows go to bound the answer. */
export type ProcessesReading =
  | { supported: true; snapshot: ProcessInventorySnapshot; truncated: boolean }
  /** A host from before it could report its processes. */
  | { supported: false };

/** Where the Processes view reads from. Keep the object stable: a new one restarts the view's polling. */
export interface ProcessesSource {
  read: () => Promise<ProcessesReading>;
}

/** The host this window is attached to, which is also where its kills land. */
export const ATTACHED_HOST_SOURCE: ProcessesSource = {
  read: async () => ({
    supported: true,
    snapshot: await processesClient.getSnapshot(),
    truncated: false,
  }),
};

/** A named host, read over the Shell's link to it whether or not this window is attached. */
export function createHostProcessesSource(hostId: HostId): ProcessesSource {
  return {
    read: async () => {
      const result = await processesClient.getHostInventory(hostId);
      return result.supported
        ? { supported: true, snapshot: result.inventory, truncated: result.inventory.truncated }
        : { supported: false };
    },
  };
}
