import type { HostId } from "@shared/types/remoteHosts";

/** Get this window's project onto another host: what the dialog is opened with. */
export interface HostSwitchRequest {
  id: number;
  toHostId: HostId;
  projectId: string;
  /** The working tree the branch is checked out in; null for the project folder. */
  worktreePath: string | null;
}

let current: HostSwitchRequest | null = null;
let nextId = 1;
let hosts = 0;
const listeners = new Set<() => void>();

function publish(next: HostSwitchRequest | null): void {
  current = next;
  for (const listener of [...listeners]) listener();
}

/**
 * Open the switch dialog in this view. False when no dialog host is mounted
 * to show it, so the caller can say so instead of doing nothing.
 */
export function requestHostSwitch(request: Omit<HostSwitchRequest, "id">): boolean {
  if (hosts === 0) return false;
  publish({ ...request, id: nextId++ });
  return true;
}

export function currentHostSwitchRequest(): HostSwitchRequest | null {
  return current;
}

export function dismissHostSwitchRequest(id: number): void {
  if (current?.id === id) publish(null);
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
}
