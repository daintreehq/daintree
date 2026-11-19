import type { IdlePausePreparation, IdlePauseRunOutcome } from "../../../shared/types/idlePause.js";
import {
  sameHostAccount,
  sshConnection,
  type HostDescriptor,
  type HostId,
  type HostMetricsSummary,
} from "../../../shared/types/remoteHosts.js";
import { createLogger } from "../../utils/logger.js";
import type { LinkSession } from "../link/session.js";
import { withHostIdleClaim } from "./claimHostIdle.js";

const logger = createLogger("main:idleResourcePause");

/**
 * A refused check is asked again this often while the host stays idle: off,
 * the default, costs a read a minute rather than one on every summary, and
 * turning it on takes effect within a minute.
 */
const RECHECK_MS = 60_000;

export interface IdleResourcePauseOptions {
  registry: {
    get(hostId: HostId): HostDescriptor | null;
    list(): HostDescriptor[];
    onChange(listener: () => void): () => void;
  };
  metrics: {
    onSummary(listener: (hostId: HostId) => void): () => void;
    latest(hostId: HostId): HostMetricsSummary | null;
    cameOn(summary: HostMetricsSummary, session: LinkSession | null): boolean | null;
  };
  sessionFor(hostId: HostId): LinkSession | null;
  /** Checks the pause on the worktree's workspace host, before any claim is asked for. */
  prepare(worktreeId: string): Promise<IdlePausePreparation>;
  now?: () => number;
  /** A pause that ran and failed or timed out, told as a manual one's failure is. */
  onFailed(host: HostDescriptor, error: string): void;
}

/** A host added for a worktree's resource box: one the person already had carries no owner. */
function ownedBox(descriptor: HostDescriptor | null): descriptor is HostDescriptor & {
  ownerWorktreeId: string;
} {
  return (
    descriptor !== null &&
    typeof descriptor.ownerWorktreeId === "string" &&
    descriptor.connection.kind === "ssh"
  );
}

/**
 * Pauses a resource environment's box once the Remote Host made for it has
 * gone idle (#17925). On a summary from an owned host saying, by the host's
 * own clock, that its idle time ended, it checks the pause on the worktree's
 * workspace host (on for that environment on this device, the person's own
 * commands as confirmed, nothing else running, the same box), then asks the
 * host to claim that idle time and sends the pause in the grant's turn.
 *
 * Each idle time is asked about once, whatever comes of it: a refusal, a
 * lost answer, or a pause that fails is not tried again until new work on
 * the host starts a new one. A check that refuses asks nothing, so a summary
 * a minute later can look again once whatever stood in the way has gone.
 */
export function watchIdleResourcePause(options: IdleResourcePauseOptions): () => void {
  let disposed = false;
  const inFlight = new Set<HostId>();
  /** The idle time each host was last asked to claim, by when it last saw work. */
  const asked = new Map<HostId, number>();
  /** The last refused check per host: the idle time it was for, and when. */
  const refusedCheck = new Map<HostId, { idleTime: number; at: number }>();
  const now = options.now ?? Date.now;

  /** When the host last saw work, while a summary on `session` says its idle time has ended. */
  const endedIdleTime = (hostId: HostId, session: LinkSession): number | null => {
    const summary = options.metrics.latest(hostId);
    if (!summary || options.metrics.cameOn(summary, session) !== true) return null;
    const idle = summary.idle;
    if (!idle || idle.busy || idle.idleEndsAt === null) return null;
    // Both times are the host's: this machine's clock says nothing of it.
    if (idle.idleEndsAt > summary.sampledAt) return null;
    return idle.lastWorkAt;
  };

  const attempt = async (
    host: HostDescriptor & { ownerWorktreeId: string },
    session: LinkSession,
    idleTime: number
  ): Promise<void> => {
    const hostId = host.id;
    const worktreeId = host.ownerWorktreeId;
    const prepared = await options.prepare(worktreeId);
    if (disposed) return;
    if (!prepared.ok) {
      refusedCheck.set(hostId, { idleTime, at: now() });
      logger.debug("Idle pause not taken", { hostId, reason: prepared.reason });
      return;
    }
    // The box the environment reports now must be the machine this host reaches.
    if (!sameHostAccount(host.connection, sshConnection(prepared.guard.sshTarget))) {
      refusedCheck.set(hostId, { idleTime, at: now() });
      logger.debug("Idle pause not taken: the environment reports another machine", { hostId });
      return;
    }
    const current = options.registry.get(hostId);
    const stillOwned = () =>
      !disposed &&
      current !== null &&
      options.registry.get(hostId) === current &&
      current.ownerWorktreeId === worktreeId &&
      sameHostAccount(current.connection, host.connection);
    if (!stillOwned() || options.sessionFor(hostId) !== session) return;
    if (endedIdleTime(hostId, session) !== idleTime || asked.get(hostId) === idleTime) return;
    asked.set(hostId, idleTime);

    let outcome;
    try {
      outcome = await withHostIdleClaim(
        hostId,
        session,
        options.sessionFor,
        (): Promise<IdlePauseRunOutcome> =>
          stillOwned()
            ? prepared.run()
            : Promise.resolve({ ran: false, reason: "The host changed during the claim" })
      );
    } catch (error) {
      // The host may have granted it with the answer lost: that idle time is spent.
      logger.warn("Idle pause claim or pause went unanswered", { hostId, error });
      return;
    }
    if (outcome.kind !== "claimed") {
      logger.debug("Idle pause not claimed", { hostId, outcome: outcome.kind });
      return;
    }
    const result = outcome.result;
    if (!result.ran) {
      logger.debug("Idle pause refused after the claim", { hostId, reason: result.reason });
      return;
    }
    if (!result.success && !disposed) {
      options.onFailed(host, result.error ?? "The pause commands failed");
    }
  };

  const consider = (hostId: HostId): void => {
    if (disposed || inFlight.has(hostId)) return;
    const host = options.registry.get(hostId);
    if (!ownedBox(host)) return;
    const session = options.sessionFor(hostId);
    if (!session?.isOpen) return;
    const idleTime = endedIdleTime(hostId, session);
    if (idleTime === null || asked.get(hostId) === idleTime) return;
    const refused = refusedCheck.get(hostId);
    if (refused?.idleTime === idleTime && now() - refused.at < RECHECK_MS) return;
    inFlight.add(hostId);
    void attempt(host, session, idleTime)
      .catch((error: unknown) => {
        logger.warn("Idle pause failed to run", { hostId, error });
      })
      .finally(() => {
        inFlight.delete(hostId);
      });
  };

  const stopSummaries = options.metrics.onSummary(consider);
  const stopRegistry = options.registry.onChange(() => {
    const owned = new Set(
      options.registry
        .list()
        .filter(ownedBox)
        .map((host) => host.id)
    );
    for (const hostId of asked.keys()) if (!owned.has(hostId)) asked.delete(hostId);
    for (const hostId of refusedCheck.keys()) if (!owned.has(hostId)) refusedCheck.delete(hostId);
  });
  return () => {
    disposed = true;
    stopSummaries();
    stopRegistry();
    asked.clear();
    refusedCheck.clear();
  };
}
