import { useSyncExternalStore } from "react";
import type { CloudHostStatus, CloudHostsSnapshot } from "@shared/types/cloudHosts";
import type { HostId } from "@shared/types/remoteHosts";
import { isRemoteShellSupported } from "@/lib/remoteHosts";
import { cloudHostsClient } from "@/clients/cloudHostsClient";
import { logWarn } from "@/utils/logger";

export interface CloudHostsState {
  snapshot: CloudHostsSnapshot;
  loaded: boolean;
  loadError: string | null;
}

const EMPTY: CloudHostsState = {
  snapshot: { providers: [], accounts: [], hosts: [] },
  loaded: false,
  loadError: null,
};

let state: CloudHostsState = EMPTY;
const listeners = new Set<() => void>();
let stop: (() => void) | null = null;
let generation = 0;

function publish(next: CloudHostsState): void {
  state = next;
  for (const listener of [...listeners]) listener();
}

/**
 * Follows the cloud picture while anything shows it: one read, then every
 * `cloud-changed` event. Reading never wakes a machine.
 */
function start(): () => void {
  if (!isRemoteShellSupported()) return () => {};
  const remote = window.electron?.remoteHosts;
  if (!remote || !window.electron?.cloudHosts) return () => {};
  const current = ++generation;
  let eventSeen = false;
  const dispose = remote.onEvent((event) => {
    if (event.type !== "cloud-changed") return;
    eventSeen = true;
    publish({ snapshot: event.snapshot, loaded: true, loadError: null });
  });
  void refresh(current, () => eventSeen);
  return dispose;
}

async function refresh(
  current = generation,
  superseded: () => boolean = () => false
): Promise<void> {
  try {
    const snapshot = await cloudHostsClient.getSnapshot();
    if (current !== generation || superseded()) return;
    publish({ snapshot, loaded: true, loadError: null });
  } catch (error) {
    if (current !== generation) return;
    logWarn("[CloudHosts] Couldn't read cloud accounts", { error });
    publish({ ...state, loaded: true, loadError: "Couldn't read cloud accounts" });
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) stop = start();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      stop?.();
      stop = null;
      generation += 1;
    }
  };
}

function getSnapshot(): CloudHostsState {
  return state;
}

export function useCloudHosts(): CloudHostsState & { refresh: () => Promise<void> } {
  const current = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return { ...current, refresh: () => refresh() };
}

/** The cloud status of one host, or null when it isn't a cloud host. */
export function cloudStatusFor(
  snapshot: CloudHostsSnapshot,
  hostId: HostId | null | undefined
): CloudHostStatus | null {
  if (!hostId) return null;
  return snapshot.hosts.find((host) => host.hostId === hostId) ?? null;
}

export function _resetCloudHostsStateForTesting(): void {
  stop?.();
  stop = null;
  listeners.clear();
  generation += 1;
  state = EMPTY;
}
