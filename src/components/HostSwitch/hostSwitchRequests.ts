import type { HostId } from "@shared/types/remoteHosts";
import type { PlacedWorktree } from "@shared/types/ipc/projectMatch";

/** Get this window's project onto another host: what the dialog is opened with. */
export interface HostSwitchRequest {
  id: number;
  toHostId: HostId;
  projectId: string;
  /** The working tree the branch is checked out in; null for the project folder. */
  worktreePath: string | null;
  /** Land in a new window instead of this one. */
  newWindow?: boolean;
  /**
   * A worktree the new-worktree dialog asked for on this host: once the
   * project is there, create it instead of handing over the current branch.
   */
  worktree?: PlacedWorktree | null;
}

/** How a request ended: the project opened on the host, or the dialog went away without it. */
export type HostSwitchSettlement = "completed" | "dismissed";

let current: HostSwitchRequest | null = null;
let nextId = 1;
let hosts = 0;
const listeners = new Set<() => void>();
const settleListeners = new Map<number, Set<(settlement: HostSwitchSettlement) => void>>();

function settle(id: number, settlement: HostSwitchSettlement): void {
  const waiting = settleListeners.get(id);
  settleListeners.delete(id);
  for (const listener of [...(waiting ?? [])]) listener(settlement);
}

function publish(next: HostSwitchRequest | null): void {
  const previous = current;
  current = next;
  // A request replaced before it finished was dismissed.
  if (previous && previous.id !== next?.id) settle(previous.id, "dismissed");
  for (const listener of [...listeners]) listener();
}

/**
 * Open the switch dialog in this view. Null when no dialog host is mounted
 * to show it, so the caller can say so instead of doing nothing; otherwise
 * the request's id, to follow with {@link onHostSwitchSettled}.
 */
export function requestHostSwitch(request: Omit<HostSwitchRequest, "id">): number | null {
  if (hosts === 0) return null;
  const id = nextId++;
  publish({ ...request, id });
  return id;
}

export function currentHostSwitchRequest(): HostSwitchRequest | null {
  return current;
}

/** The dialog finished its work: the project is open on the host. */
export function completeHostSwitchRequest(id: number): void {
  if (current?.id !== id) return;
  settle(id, "completed");
  publish(null);
}

export function dismissHostSwitchRequest(id: number): void {
  if (current?.id === id) publish(null);
}

/** Called once when request `id` completes or is dismissed; returns the unsubscribe. */
export function onHostSwitchSettled(
  id: number,
  listener: (settlement: HostSwitchSettlement) => void
): () => void {
  if (current?.id !== id) {
    listener("dismissed");
    return () => {};
  }
  let set = settleListeners.get(id);
  if (!set) {
    set = new Set();
    settleListeners.set(id, set);
  }
  set.add(listener);
  return () => settleListeners.get(id)?.delete(listener);
}

export function subscribeHostSwitchRequests(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The dialog host announces itself so requests made with none mounted are refused. */
export function registerHostSwitchDialogHost(): () => void {
  hosts++;
  return () => {
    hosts = Math.max(0, hosts - 1);
    if (hosts === 0) publish(null);
  };
}

export function _resetHostSwitchRequestsForTesting(): void {
  current = null;
  nextId = 1;
  hosts = 0;
  listeners.clear();
  settleListeners.clear();
}
