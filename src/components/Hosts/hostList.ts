import { useSyncExternalStore } from "react";
import {
  LOCAL_HOST_ID,
  type HostListEntry,
  type HostMetricsSummary,
} from "@shared/types/remoteHosts";
import type { RemoteHostsEvent } from "@shared/types/ipc/remoteHosts";
import type { HostMetricsEvent } from "@shared/types/ipc/hostMetrics";
import { isRemoteHostsSupported } from "@/lib/remoteHosts";
import { logWarn } from "@/utils/logger";

export interface HostListSnapshot {
  /** The hosts this machine has added. Never includes this machine itself. */
  hosts: HostListEntry[];
  /** This machine's own summary, when something reports one. */
  localSummary: HostMetricsSummary | null;
}

const EMPTY: HostListSnapshot = { hosts: [], localSummary: null };

let snapshot: HostListSnapshot = EMPTY;
const listeners = new Set<() => void>();
let stop: (() => void) | null = null;
let generation = 0;

function publish(next: HostListSnapshot): void {
  snapshot = next;
  for (const listener of [...listeners]) listener();
}

/**
 * Applies an event; false when it names a host this list doesn't have yet,
 * which means the list itself is behind.
 */
function applyRemoteHostsEvent(event: RemoteHostsEvent): boolean {
  switch (event.type) {
    case "hosts-changed":
      publish({ ...snapshot, hosts: event.hosts.filter((h) => h.descriptor.id !== LOCAL_HOST_ID) });
      return true;
    case "connection-changed": {
      if (!snapshot.hosts.some((h) => h.descriptor.id === event.hostId)) return false;
      const up = event.connection.status === "connected";
      publish({
        ...snapshot,
        hosts: snapshot.hosts.map((h) =>
          h.descriptor.id === event.hostId
            ? // A summary from before a drop says nothing about the host now.
              { ...h, connection: event.connection, summary: up ? h.summary : null }
            : h
        ),
      });
      return true;
    }
    default:
      return true;
  }
}

function applyMetricsEvent(event: HostMetricsEvent): void {
  if (event.type !== "summary") return;
  const summary = event.summary;
  if (summary.hostId === LOCAL_HOST_ID) {
    publish({ ...snapshot, localSummary: summary });
    return;
  }
  if (!snapshot.hosts.some((h) => h.descriptor.id === summary.hostId)) return;
  publish({
    ...snapshot,
    hosts: snapshot.hosts.map((h) => (h.descriptor.id === summary.hostId ? { ...h, summary } : h)),
  });
}

/**
 * Follow the host list while anything shows it. Makes no calls at all where
 * Remote Hosts doesn't exist, so nothing changes for a Windows build.
 */
function start(): () => void {
  if (!isRemoteHostsSupported()) return () => {};
  const api = window.electron?.remoteHosts;
  if (!api) return () => {};
  const current = ++generation;
  const disposers: Array<() => void> = [];
  // Bumped by every full list, from either source. An answer to a request
  // made before the latest full list is older than it and is dropped.
  let listVersion = 0;
  const refresh = () => {
    const requestedAt = ++listVersion;
    api
      .list()
      .then((hosts) => {
        if (current !== generation || requestedAt !== listVersion) return;
        publish({ ...snapshot, hosts: hosts.filter((h) => h.descriptor.id !== LOCAL_HOST_ID) });
      })
      .catch((error: unknown) => {
        logWarn("[Hosts] Couldn't read the host list", { error });
      });
  };
  disposers.push(
    api.onEvent((event) => {
      if (event.type === "hosts-changed") listVersion += 1;
      if (!applyRemoteHostsEvent(event)) refresh();
    })
  );
  const metrics = window.electron?.hostMetrics;
  if (metrics) disposers.push(metrics.onEvent(applyMetricsEvent));
  refresh();
  return () => {
    for (const dispose of disposers.splice(0)) dispose();
  };
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

function getSnapshot(): HostListSnapshot {
  return snapshot;
}

export function useHostList(): HostListSnapshot {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function getHostListSnapshot(): HostListSnapshot {
  return snapshot;
}

/** True once at least one host other than this machine has been added. */
export function hasRemoteHosts(state: HostListSnapshot): boolean {
  return state.hosts.length > 0;
}

export function _resetHostListForTesting(): void {
  stop?.();
  stop = null;
  listeners.clear();
  generation += 1;
  snapshot = EMPTY;
}
