import { resolveMcpDriveTarget } from "./driveTarget.js";

/**
 * Where a call one of another machine's assistants relayed here (#13493)
 * stands on changing a project, for the Shell whose link session it came in
 * on. A null link session is this host's own assistant running with no view
 * (#13511): no view is its own, so only a vacant project is one it may change.
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
 * a view that takes the lease in between stops it. Each read is for a change:
 * a vacant answer tells the lease the host is about to make it.
 *
 * A `local` call is one of this machine's own assistants reaching another of
 * its projects (#14024): every view of this machine's is its own, so it
 * changes a project anyone here drives, or every project while Host-mode
 * routing is off, and never one another machine drives.
 */
export type RelayWriteStanding =
  | { kind: "own-view" }
  | { kind: "vacant" }
  | { kind: "elsewhere"; holderName: string | null }
  | { kind: "unavailable" };

export function relayWriteStanding(
  projectId: string,
  linkSessionId: string | null,
  local = false
): RelayWriteStanding {
  const target = resolveMcpDriveTarget(projectId, {
    linkSessionId: local ? null : linkSessionId,
  });
  if (target === null) {
    return local ? { kind: "own-view" } : { kind: "elsewhere", holderName: null };
  }
  if (target.state === "vacant") return { kind: "vacant" };
  if (target.state === "unavailable") return { kind: "unavailable" };
  if (local) {
    return target.endpoint.kind === "local-view"
      ? { kind: "own-view" }
      : { kind: "elsewhere", holderName: target.holderName ?? null };
  }
  if (linkSessionId !== null && target.endpoint.linkSessionId === linkSessionId) {
    return { kind: "own-view" };
  }
  return { kind: "elsewhere", holderName: target.holderName ?? null };
}
