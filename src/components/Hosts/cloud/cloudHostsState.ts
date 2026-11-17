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
// Every read and every push takes the next number. A snapshot counts only when
// no later one has been shown, and an answer or failure sets `loadError` only
// when no later outcome has, so a slow read can't undo a push or a newer read.
let sequence = 0;
let snapshotMark = 0;
let outcomeMark = 0;

function publish(next: CloudHostsState): void {
  state = next;
  for (const listener of [...listeners]) listener();
}

/** Whether this view can follow the cloud picture at all: not where Remote Hosts isn't supported. */
function followable(): boolean {
  return (
    isRemoteShellSupported() &&
    Boolean(window.electron?.remoteHosts) &&
    Boolean(window.electron?.cloudHosts)
  );
}

/**
 * Follows the cloud picture while anything shows it: one read, then every
 * `cloud-changed` event. Reading never wakes a machine.
 */
function start(): () => void {
  const remote = window.electron?.remoteHosts;
  if (!remote || !followable()) return () => {};
  const current = ++generation;
  const dispose = remote.onEvent((event) => {
    if (event.type !== "cloud-changed" || current !== generation) return;
    snapshotMark = outcomeMark = ++sequence;
    publish({ snapshot: event.snapshot, loaded: true, loadError: null });
  });
  void refresh();
  return dispose;
}

async function refresh(): Promise<void> {
  const current = generation;
  const ticket = ++sequence;
  try {
    const snapshot = await cloudHostsClient.getSnapshot();
    if (current !== generation || ticket <= snapshotMark) return;
    snapshotMark = ticket;
    // A newer read's failure still stands; this answer only refreshes the picture.
    const latest = ticket > outcomeMark;
    if (latest) outcomeMark = ticket;
    publish({ snapshot, loaded: true, loadError: latest ? null : state.loadError });
  } catch (error) {
    if (current !== generation || ticket <= outcomeMark) return;
    outcomeMark = ticket;
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

const NO_SUBSCRIPTION = () => () => {};
const getEmpty = () => EMPTY;

/**
 * The cloud picture while `active`, and nothing followed otherwise, so a
 * surface that stays mounted while closed starts no read and no listener.
 * `pending` while the first read is still on its way where there is one to
 * wait for; never where cloud hosts can't be followed at all.
 */
export function useCloudHostsWhile(
  active: boolean
): CloudHostsState & { pending: boolean; refresh: () => Promise<void> } {
  const current = useSyncExternalStore(
    active ? subscribe : NO_SUBSCRIPTION,
    active ? getSnapshot : getEmpty,
    active ? getSnapshot : getEmpty
  );
  return {
    ...current,
    pending: active && !current.loaded && followable(),
    refresh: () => refresh(),
  };
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
