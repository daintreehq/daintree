import type { HostPidOwner } from "../../../shared/types/processes.js";

/**
 * Which worktree's terminal is serving a port on this machine, as far as the
 * process tree shows. A browser panel records where it was opened, not where
 * the page's server runs, so this is what tells the picker the page belongs to
 * another checkout before it resolves anything against this one.
 *
 * `unknown` is the common answer and carries no claim: nothing listening, a
 * listener outside every terminal's tree (a daemon, a container, another
 * user), a census that hasn't seen it yet, a pty host that didn't answer, or
 * listeners on the one port that disagree.
 */
export type ListenerOwnerVerdict =
  { status: "unknown" } | { status: "terminal"; projectId: string; worktreeId: string };

export interface ListenerOwnerDeps {
  /** Every process listening on the port, or null when this machine can't say. */
  findListenerPids(port: number): Promise<number[] | null>;
  /** The terminal whose tree holds each pid; a pid nobody answered for is left out. */
  findPidOwners(pids: number[]): Promise<HostPidOwner[]>;
}

const UNKNOWN: ListenerOwnerVerdict = { status: "unknown" };

export async function findListenerOwner(
  port: number,
  deps: ListenerOwnerDeps
): Promise<ListenerOwnerVerdict> {
  const pids = await deps.findListenerPids(port).catch(() => null);
  if (pids === null || pids.length === 0) return UNKNOWN;
  const owners = await deps.findPidOwners(pids).catch(() => null);
  if (owners === null) return UNKNOWN;
  const byPid = new Map<number, HostPidOwner>();
  for (const owner of owners) {
    if (pids.includes(owner.pid)) byPid.set(owner.pid, owner);
  }
  // Every socket on the port has to be a terminal's, and all of one worktree:
  // `localhost` can reach either address family, so a listener nobody owns may
  // be the one serving the page.
  let verdict: ListenerOwnerVerdict | null = null;
  for (const pid of pids) {
    const owner = byPid.get(pid);
    if (!owner || owner.projectId === null || owner.worktreeId === null) return UNKNOWN;
    if (
      verdict !== null &&
      verdict.status === "terminal" &&
      (verdict.projectId !== owner.projectId || verdict.worktreeId !== owner.worktreeId)
    ) {
      return UNKNOWN;
    }
    verdict = { status: "terminal", projectId: owner.projectId, worktreeId: owner.worktreeId };
  }
  return verdict ?? UNKNOWN;
}
