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
  /** Checks and starts in flight, by host: a check can end in a start. */
  private readonly attempts = new Map<HostId, number>();
  /** Starts in flight, by host. */
  private readonly starting = new Map<HostId, number>();

  constructor(private readonly deps: HostStartsDeps) {}

  /** A start is under way on the host. */
  isStarting(hostId: HostId): boolean {
    return (this.starting.get(hostId) ?? 0) > 0;
  }

  /** The host is being checked on to start it, or started. */
  isAttempting(hostId: HostId): boolean {
    return (this.attempts.get(hostId) ?? 0) > 0;
  }

  /** Resolves whether the link should be tried again; rejects with why Daintree couldn't start. */
  async ensureRunning(
    hostId: HostId,
    connection: HostConnection,
    signal: AbortSignal
  ): Promise<boolean> {
    let started = false;
    count(this.attempts, hostId, 1);
    try {
      const outcome = await this.deps.setup.ensureHostRunning(connection, signal, () => {
        started = true;
        count(this.starting, hostId, 1);
        this.deps.onChange(hostId);
      });
      return outcome !== "not-startable";
    } catch (error) {
      const reason = isAppError(error)
        ? (error.userMessage ?? error.message)
        : formatErrorMessage(error, "Daintree couldn't be started on the host");
      throw new TransportError(reason, reason);
    } finally {
      count(this.attempts, hostId, -1);
      if (started) {
        count(this.starting, hostId, -1);
        this.deps.onChange(hostId);
      }
    }
  }
}

function count(counts: Map<HostId, number>, hostId: HostId, by: 1 | -1): void {
  const next = (counts.get(hostId) ?? 0) + by;
  if (next > 0) counts.set(hostId, next);
  else counts.delete(hostId);
}
