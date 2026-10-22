import type {
  HostAttachedShell,
  HostLinkActivity,
  HostLinkEvent,
} from "../../../shared/types/ipc/hostMetrics.js";
import type {
  DriveLeaseObservation,
  HostDriverObservation,
} from "../../../shared/types/remoteHosts.js";
import type { LinkClientInfo } from "../link/messages.js";
import { DriverObservationSchema, MAX_PROJECT_NAME_CHARS } from "../link/schemas.js";
import { MAX_ACTIVITY_DRIVERS, MAX_ACTIVITY_SHELLS } from "../metrics/linkMethods.js";

export interface LinkActivitySources {
  now: number;
  listeningSince: number | null;
  version: string;
  commit: string;
  history: { events: HostLinkEvent[]; truncated: boolean };
  leases: DriveLeaseObservation[];
  projectName(projectId: string): string | null;
  sessions: ReadonlyArray<{ sessionId: string; client: LinkClientInfo; connectedAt: number }>;
}

/**
 * Newest control first. One a Shell's schema would refuse (an id from a
 * reservation file longer than the link carries) is left out: in a summary
 * it would cost the whole frame, and in an answer the whole page.
 */
export function nameLeases(
  leases: readonly DriveLeaseObservation[],
  projectName: (projectId: string) => string | null
): HostDriverObservation[] {
  return leases
    .map((lease) => {
      const name = projectName(lease.projectId);
      return {
        ...lease,
        projectName: name === null ? null : name.slice(0, MAX_PROJECT_NAME_CHARS),
      };
    })
    .filter((observation) => DriverObservationSchema.safeParse(observation).success)
    .sort((a, b) => b.holder.acquiredAt - a.holder.acquiredAt);
}

/** What a host answers about its links, cut to what its schema accepts. */
export function composeLinkActivity(sources: LinkActivitySources): HostLinkActivity {
  const drivers = nameLeases(sources.leases, sources.projectName).slice(0, MAX_ACTIVITY_DRIVERS);
  const attached: HostAttachedShell[] = sources.sessions
    .slice(0, MAX_ACTIVITY_SHELLS)
    .map(({ sessionId, client, connectedAt }) => ({
      sessionId,
      clientId: client.clientId,
      clientName: client.clientName,
      platform: client.platform,
      connectedAt,
      drivingProjectIds: drivers
        .filter((driver) => driver.holder.clientId === client.clientId)
        .map((driver) => driver.projectId),
    }));
  return {
    observedAt: sources.now,
    listeningSince: sources.listeningSince,
    version: sources.version,
    commit: sources.commit,
    events: sources.history.events,
    eventsTruncated: sources.history.truncated,
    drivers,
    attached,
  };
}
