import type { HostConnection, HostId } from "../../../shared/types/remoteHosts.js";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";
import { isAppError } from "../../utils/errorTypes.js";
import type { HostSetupService, HostStartRefusal } from "./HostSetupService.js";
import { TransportError, type LinkTransport } from "./transport.js";

export interface HostStartsDeps {
  setup: Pick<HostSetupService, "ensureHostRunning">;
  /** The host started or stopped being started. */
  onChange(hostId: HostId): void;
}

/** What one check-and-start for a host came to, as it happened. */
export type HostStartEvent =
  /** ssh reached the host and found no Daintree serving: it is being checked. */
  | { kind: "checking" }
  /** The start is going to the host now. */
  | { kind: "start-requested" }
  /** Daintree was already listening, or started and then listened. */
  | { kind: "running"; started: boolean }
  | { kind: "refused"; refusal: HostStartRefusal }
  /** The start failed there, in the host's or ssh's own words. */
  | { kind: "failed"; reason: string };

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
  /** Hosts someone asked to have back (#16170), for as long as that attempt lasts. */
  private readonly explicit = new Map<HostId, number>();
  private readonly observers = new Map<HostId, Set<(event: HostStartEvent) => void>>();

  constructor(private readonly deps: HostStartsDeps) {}

  /** A start is under way on the host. */
  isStarting(hostId: HostId): boolean {
    return (this.starting.get(hostId) ?? 0) > 0;
  }

  /** The host is being checked on to start it, or started. */
  isAttempting(hostId: HostId): boolean {
    return (this.attempts.get(hostId) ?? 0) > 0;
  }

  /** Someone asked for the host back and that attempt is still going. */
  isExplicit(hostId: HostId): boolean {
    return (this.explicit.get(hostId) ?? 0) > 0;
  }

  /**
   * Until the returned release, a dial of the host may start Daintree there
   * even while it said it was shutting down, or was quit there on purpose;
   * never where its Host mode is off.
   */
  allowExplicit(hostId: HostId): () => void {
    count(this.explicit, hostId, 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      count(this.explicit, hostId, -1);
    };
  }

  /** Hears the host's checks and starts as they happen; returns the unsubscribe. */
  observe(hostId: HostId, listener: (event: HostStartEvent) => void): () => void {
    let listeners = this.observers.get(hostId);
    if (!listeners) {
      listeners = new Set();
      this.observers.set(hostId, listeners);
    }
    listeners.add(listener);
    return () => {
      const now = this.observers.get(hostId);
      if (!now) return;
      now.delete(listener);
      if (now.size === 0) this.observers.delete(hostId);
    };
  }

  /**
   * The host's transport, letting a dial start Daintree there while someone
   * asked for it back, whatever the link would otherwise allow.
   */
  transport(hostId: HostId, inner: LinkTransport): LinkTransport {
    return {
      open: (signal, options) =>
        inner.open(
          signal,
          this.isExplicit(hostId) && options?.mayStart === false
            ? { ...options, mayStart: true }
            : options
        ),
    };
  }

  /** Resolves whether the link should be tried again; rejects with why Daintree couldn't start. */
  async ensureRunning(
    hostId: HostId,
    connection: HostConnection,
    signal: AbortSignal
  ): Promise<boolean> {
    let started = false;
    // An abandoned dial's check says nothing about the one that replaced it.
    const emit = (event: HostStartEvent) => {
      if (!signal.aborted) this.emit(hostId, event);
    };
    count(this.attempts, hostId, 1);
    emit({ kind: "checking" });
    try {
      const outcome = await this.deps.setup.ensureHostRunning(
        connection,
        signal,
        () => {
          started = true;
          count(this.starting, hostId, 1);
          this.deps.onChange(hostId);
          emit({ kind: "start-requested" });
        },
        {
          explicit: this.isExplicit(hostId),
          onRefused: (refusal) => emit({ kind: "refused", refusal }),
        }
      );
      if (outcome !== "not-startable") emit({ kind: "running", started: outcome === "started" });
      return outcome !== "not-startable";
    } catch (error) {
      const reason = isAppError(error)
        ? (error.userMessage ?? error.message)
        : formatErrorMessage(error, "Daintree couldn't be started on the host");
      emit({ kind: "failed", reason });
      throw new TransportError(reason, reason);
    } finally {
      count(this.attempts, hostId, -1);
      if (started) {
        count(this.starting, hostId, -1);
        this.deps.onChange(hostId);
      }
    }
  }

  private emit(hostId: HostId, event: HostStartEvent): void {
    for (const listener of [...(this.observers.get(hostId) ?? [])]) {
      try {
        listener(event);
      } catch (error) {
        console.error("[HostStarts] A start observer failed:", error);
      }
    }
  }
}

function count(counts: Map<HostId, number>, hostId: HostId, by: 1 | -1): void {
  const next = (counts.get(hostId) ?? 0) + by;
  if (next > 0) counts.set(hostId, next);
  else counts.delete(hostId);
}
