import { installDecisionsHostWith, type DecisionsSessionSource } from "./host.js";

/**
 * Lets the Decisions owner among this host's Shells enroll it as a device
 * (#16021). Decisions' own modules load on the first CALL, never before.
 */
export function installDecisionsHost(server: DecisionsSessionSource): () => Promise<void> {
  return installDecisionsHostWith(server, async () => {
    const { HostEnrollments } = await import("../../services/decisions/hostEnrollmentHost.js");
    return new HostEnrollments();
  });
}
