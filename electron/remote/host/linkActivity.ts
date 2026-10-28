import type {
  HostAttachedShell,
  HostLinkActivity,
  HostLinkEvent,
} from "../../../shared/types/ipc/hostMetrics.js";
import type { DriveLeaseObservation } from "../../../shared/types/remoteHosts.js";
import type { LinkClientInfo } from "../link/messages.js";
import { nameLeases } from "../metrics/driverObservations.js";
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
