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
// Every read and every push takes the next number; an answer counts only when
// nothing numbered after it has been shown, so a slow read can't undo a push.
let sequence = 0;
let shown = 0;

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
  const dispose = remote.onEvent((event) => {
    if (event.type !== "cloud-changed" || current !== generation) return;
    shown = ++sequence;
    publish({ snapshot: event.snapshot, loaded: true, loadError: null });
  });
  void refresh();
  return dispose;
}

async function refresh(): Promise<void> {
  const current = generation;
  const ticket = ++sequence;
  const superseded = () => current !== generation || ticket <= shown;
  try {
    const snapshot = await cloudHostsClient.getSnapshot();
    if (superseded()) return;
    shown = ticket;
    publish({ snapshot, loaded: true, loadError: null });
  } catch (error) {
    if (superseded()) return;
    shown = ticket;
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
      generation += 1;
      stop?.();
      stop = null;
    }
  };
}

function getSnapshot(): CloudHostsState {
  return state;
}

export function useCloudHosts(): CloudHostsState & { refresh: () => Promise<void> } {
  const current = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return { ...current, refresh };
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
  generation += 1;
  stop?.();
  stop = null;
  listeners.clear();
  state = EMPTY;
}
