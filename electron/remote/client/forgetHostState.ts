import type { HostId } from "../../../shared/types/remoteHosts.js";
import { createLogger } from "../../utils/logger.js";

const logger = createLogger("main:forgetHostState");

/** One kind of state this device keeps under a host's id. */
export interface HostStateCleanup {
  /** What it clears, for the log when it fails. */
  name: string;
  run(hostId: HostId): unknown;
}

/**
 * A host was removed from this device: clear everything kept under its id, in
 * order. Each step runs whatever an earlier one did, since one that fails must
 * not leave the others' state behind; failures are logged, never thrown, as the
 * host is already gone from the list.
 */
export async function forgetHostState(
  hostId: HostId,
  cleanups: readonly HostStateCleanup[]
): Promise<void> {
  for (const cleanup of cleanups) {
    try {
      await cleanup.run(hostId);
    } catch (error) {
      logger.warn("Couldn't clear a removed host's state", {
        hostId,
        cleanup: cleanup.name,
        error,
      });
    }
  }
}
