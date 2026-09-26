import type { HostId } from "@shared/types/remoteHosts";

/** Pick one of a host's projects to switch this window to. */
export interface HostProjectPickerRequest {
  id: number;
  hostId: HostId;
}

let current: HostProjectPickerRequest | null = null;
let nextId = 1;
let hosts = 0;
const listeners = new Set<() => void>();

function publish(next: HostProjectPickerRequest | null): void {
  current = next;
  for (const listener of [...listeners]) listener();
}

/**
 * Show a host's project list in this view, for a switch the host had no
 * project to return to. False when nothing is mounted to show it.
 */
export function requestHostProjectPicker(hostId: HostId): boolean {
  if (hosts === 0) return false;
  publish({ id: nextId++, hostId });
  return true;
}

export function currentHostProjectPickerRequest(): HostProjectPickerRequest | null {
  return current;
}

export function dismissHostProjectPicker(id: number): void {
  if (current?.id === id) publish(null);
}

export function subscribeHostProjectPicker(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The picker's host announces itself so requests made with none mounted are refused. */
export function registerHostProjectPickerHost(): () => void {
  hosts++;
  return () => {
    hosts = Math.max(0, hosts - 1);
    if (hosts === 0) publish(null);
  };
}

export function _resetHostProjectPickerForTesting(): void {
  current = null;
  nextId = 1;
  hosts = 0;
  listeners.clear();
}
