import { resolveMcpDriveTarget } from "./driveTarget.js";

/**
 * Where a call one of another machine's assistants relayed here (#13493)
 * stands on changing a project, for the Shell whose link session it came in
 * on.
 *
 * - `own-view`: that Shell's own view drives the project, so the change goes
 *   through that view.
 * - `vacant`: nobody drives it, so the host runs the change itself as that
 *   Shell, without taking the lease.
 * - `elsewhere`: someone else's view holds the lease, or Host-mode routing is
 *   off, so nothing on this machine acts for another one.
 * - `unavailable`: a holder exists but can't be reached right now. Retriable,
 *   and never acted around.
 *
 * Read as a call is admitted and again right before each change it makes, so
 * a view that takes the lease in between stops it.
 */
export type RelayWriteStanding =
  | { kind: "own-view" }
  | { kind: "vacant" }
  | { kind: "elsewhere"; holderName: string | null }
  | { kind: "unavailable" };

export function relayWriteStanding(projectId: string, linkSessionId: string): RelayWriteStanding {
  const target = resolveMcpDriveTarget(projectId);
  if (target === null) return { kind: "elsewhere", holderName: null };
  if (target.state === "vacant") return { kind: "vacant" };
  if (target.state === "unavailable") return { kind: "unavailable" };
  if (target.endpoint.linkSessionId === linkSessionId) return { kind: "own-view" };
  return { kind: "elsewhere", holderName: target.holderName ?? null };
}
