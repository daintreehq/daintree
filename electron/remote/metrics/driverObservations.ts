import type {
  DriveLeaseObservation,
  HostDriverObservation,
} from "../../../shared/types/remoteHosts.js";
import { DriverObservationSchema, MAX_PROJECT_NAME_CHARS } from "../link/schemas.js";

/**
 * A host's leases with their project names, newest control first. One a
 * Shell's schema would refuse (an id from a reservation file longer than the
 * link carries) is left out: in a summary it would cost the whole frame, and
 * in a link-activity answer the whole page.
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
