import type { HostConnection, HostId } from "../../../shared/types/remoteHosts.js";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";
import { isAppError } from "../../utils/errorTypes.js";
import type { HostSetupService } from "./HostSetupService.js";
import { TransportError } from "./transport.js";

export interface HostStartsDeps {
  setup: Pick<HostSetupService, "ensureHostRunning">;
  /** The host started or stopped being started. */
  onChange(hostId: HostId): void;
}

/**
 * A host reachable over ssh whose Daintree isn't serving (a reboot, a power
 * cut) is started rather than reported unreachable; its own reason for not
 * starting is what the user sees. It reads as starting only once a start is
 * under way there, never while it is only being checked on.
 */
export class HostStarts {
  /** Starts in flight, by host. */
  private readonly starting = new Map<HostId, number>();

  constructor(private readonly deps: HostStartsDeps) {}

  isStarting(hostId: HostId): boolean {
    return (this.starting.get(hostId) ?? 0) > 0;
  }

  /** Resolves whether the link should be tried again; rejects with why Daintree couldn't start. */
  async ensureRunning(
    hostId: HostId,
    connection: HostConnection,
    signal: AbortSignal
  ): Promise<boolean> {
    let started = false;
    try {
      const outcome = await this.deps.setup.ensureHostRunning(connection, signal, () => {
        started = true;
        this.starting.set(hostId, (this.starting.get(hostId) ?? 0) + 1);
        this.deps.onChange(hostId);
      });
      return outcome !== "not-startable";
    } catch (error) {
      const reason = isAppError(error)
        ? (error.userMessage ?? error.message)
        : formatErrorMessage(error, "Daintree couldn't be started on the host");
      throw new TransportError(reason, reason);
    } finally {
      if (started) {
        const left = (this.starting.get(hostId) ?? 1) - 1;
        if (left > 0) this.starting.set(hostId, left);
        else this.starting.delete(hostId);
        this.deps.onChange(hostId);
      }
    }
  }
}
