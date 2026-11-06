import { useEffect, useSyncExternalStore } from "react";
import {
  LOCAL_HOST_ID,
  type HostConnectionState,
  type HostListEntry,
  type HostMetricsSummary,
} from "@shared/types/remoteHosts";
import type { RemoteHostsEvent } from "@shared/types/ipc/remoteHosts";
import type { HostMetricsEvent, HostMetricsSnapshot } from "@shared/types/ipc/hostMetrics";
import { deepEqualIgnoringUndefined } from "@shared/utils/layoutMerge";
import { isRemoteShellSupported } from "@/lib/remoteHosts";
import { isProjectViewObservable, subscribeProjectViewObservability } from "@/lib/viewCacheState";
import { useHostMetricsStore } from "@/store/hostMetricsStore";
import { logWarn } from "@/utils/logger";

export interface HostListSnapshot {
  /** The hosts this machine has added. Never includes this machine itself. */
  hosts: HostListEntry[];
  /** This machine's own summary, when something reports one. */
  localSummary: HostMetricsSummary | null;
}

const EMPTY: HostListSnapshot = { hosts: [], localSummary: null };

/** Everything known, figures included while something follows them. */
let snapshot: HostListSnapshot = EMPTY;
/**
 * The same list without figures: no summaries and no round trip. A link's
 * pings and a host's summaries arrive every few seconds in every view, so a
 * consumer that only names hosts or says whether they are up reads this one
 * and is never woken by them.
 */
let statusSnapshot: HostListSnapshot = EMPTY;
const listeners = new Set<() => void>();
let stop: (() => void) | null = null;
let generation = 0;

let figuresDemand = 0;
let stopWatchingView: (() => void) | null = null;
let stopFigures: (() => void) | null = null;
let figuresGeneration = 0;

function statusConnection(connection: HostConnectionState): HostConnectionState {
  if (connection.status !== "connected") return connection;
  const { rttSampledAt: _sampledAt, ...rest } = connection;
  return { ...rest, rttMs: null };
}

function statusEntry(entry: HostListEntry): HostListEntry {
  return {
    descriptor: entry.descriptor,
    connection: statusConnection(entry.connection),
    summary: null,
  };
}

/** Entries that read the same keep their objects, so only a real change reaches status consumers. */
function nextStatus(previous: HostListSnapshot, next: HostListSnapshot): HostListSnapshot {
  const before = statusSnapshot.hosts;
  let changed = next.hosts.length !== before.length;
  const hosts = next.hosts.map((entry, index) => {
    const kept = before[index];
    if (kept && previous.hosts[index] === entry) return kept;
    const projected = statusEntry(entry);
    // Every event is a fresh structured clone, so equal values never share objects.
    if (
      kept &&
      deepEqualIgnoringUndefined(kept.descriptor, projected.descriptor) &&
      deepEqualIgnoringUndefined(kept.connection, projected.connection)
    ) {
      return kept;
    }
    changed = true;
    return projected;
  });
  return changed ? { hosts, localSummary: null } : statusSnapshot;
}

function publish(next: HostListSnapshot): void {
  const previous = snapshot;
  snapshot = next;
  statusSnapshot = nextStatus(previous, next);
  for (const listener of [...listeners]) listener();
}

/** A summary is kept only while it is followed; one nobody updates would read as current. */
function withFollowedFigures(hosts: HostListEntry[]): HostListEntry[] {
  if (stopFigures) return hosts;
  return hosts.map((entry) => (entry.summary === null ? entry : { ...entry, summary: null }));
}

function remoteEntries(hosts: HostListEntry[]): HostListEntry[] {
  return withFollowedFigures(hosts.filter((h) => h.descriptor.id !== LOCAL_HOST_ID));
}

/**
 * Applies an event; false when it names a host this list doesn't have yet,
 * which means the list itself is behind.
 */
function applyRemoteHostsEvent(event: RemoteHostsEvent): boolean {
  switch (event.type) {
    case "hosts-changed":
      publish({ ...snapshot, hosts: remoteEntries(event.hosts) });
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

function applySummary(summary: HostMetricsSummary): void {
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

function isFresher(
  held: HostMetricsSummary | null,
  seeded: HostMetricsSummary | undefined
): seeded is HostMetricsSummary {
  return seeded !== undefined && (held === null || seeded.sampledAt > held.sampledAt);
}

/** Each host's latest from a seed, unless a pushed summary already beat it there. */
function applySeed(snapshots: HostMetricsSnapshot[]): void {
  const latest = new Map<string, HostMetricsSummary>();
  for (const entry of snapshots) {
    const newest = entry.history[0];
    if (newest) latest.set(entry.hostId, newest);
  }
  const local = latest.get(LOCAL_HOST_ID);
  const hosts = snapshot.hosts.map((h) => {
    const seeded = latest.get(h.descriptor.id);
    // Only a connected host's: the rings outlive a drop.
    if (h.connection.status !== "connected" || !isFresher(h.summary, seeded)) return h;
    return { ...h, summary: seeded };
  });
  const changed = hosts.some((h, index) => h !== snapshot.hosts[index]);
  const localSummary = isFresher(snapshot.localSummary, local) ? local : snapshot.localSummary;
  if (!changed && localSummary === snapshot.localSummary) return;
  publish({ hosts: changed ? hosts : snapshot.hosts, localSummary });
}

function applyMetricsEvent(event: HostMetricsEvent): void {
  if (event.type !== "summary") return;
  useHostMetricsStore.getState().apply(event.summary);
  applySummary(event.summary);
}

/**
 * Follow host summaries into the list and the sparklines' history. Seeds once
 * remote hosts are actually in use, so a machine with none reads nothing.
 */
function followFigures(): () => void {
  const api = window.electron?.hostMetrics;
  if (!isRemoteShellSupported() || !api) return () => {};
  const current = ++figuresGeneration;
  const live = () => current === figuresGeneration;
  const off = api.onEvent(applyMetricsEvent);
  const seed = () =>
    api
      .getSnapshots()
      .then((snapshots) => {
        if (!live()) return;
        useHostMetricsStore.getState().seed(snapshots);
        applySeed(snapshots);
      })
      .catch((error: unknown) => logWarn("[Hosts] Couldn't read host summaries", { error }));
  const inUse = window.electron?.remoteHosts?.isInUse;
  if (typeof inUse === "function") {
    void inUse()
      .then((used) => (used && live() ? seed() : undefined))
      .catch(() => {});
  } else {
    void seed();
  }
  return () => {
    figuresGeneration += 1;
    off();
  };
}

function setFollowingFigures(on: boolean): void {
  if (on === (stopFigures !== null)) return;
  if (on) {
    stopFigures = followFigures();
    return;
  }
  stopFigures?.();
  stopFigures = null;
  // What was held stops being current the moment nothing updates it; the next
  // follower seeds afresh.
  useHostMetricsStore.getState().reset();
  if (snapshot.localSummary !== null || snapshot.hosts.some((h) => h.summary !== null)) {
    publish({ hosts: withFollowedFigures(snapshot.hosts), localSummary: null });
  }
}

/** Hold figures followed while this view can be seen. Release is idempotent. */
function acquireFigures(): () => void {
  figuresDemand += 1;
  if (figuresDemand === 1) {
    stopWatchingView = subscribeProjectViewObservability(setFollowingFigures);
    setFollowingFigures(isProjectViewObservable());
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    figuresDemand -= 1;
    if (figuresDemand === 0) {
      stopWatchingView?.();
      stopWatchingView = null;
      setFollowingFigures(false);
    }
  };
}

/**
 * Follow the host list while anything shows it. Makes no calls at all where
 * Remote Hosts doesn't exist, so nothing changes for a Windows build.
 */
function start(): () => void {
  if (!isRemoteShellSupported()) return () => {};
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
        publish({ ...snapshot, hosts: remoteEntries(hosts) });
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

function getStatusSnapshot(): HostListSnapshot {
  return statusSnapshot;
}

/**
 * The hosts and how their links stand, without figures: every `summary` and
 * `localSummary` is null and a connected link's `rttMs` is null. A link's ping
 * or a host's summary never re-renders its caller.
 */
export function useHostList(): HostListSnapshot {
  return useSyncExternalStore(subscribe, getStatusSnapshot, getStatusSnapshot);
}

/**
 * The host list with its figures (summaries, round trips), followed while
 * `enabled` and this view can be seen. Disabled, it is {@link useHostList}.
 */
export function useHostFigures(enabled = true): HostListSnapshot {
  const read = enabled ? getSnapshot : getStatusSnapshot;
  const state = useSyncExternalStore(subscribe, read, read);
  useEffect(() => (enabled ? acquireFigures() : undefined), [enabled]);
  return state;
}

/** The latest list, figures included while something follows them. */
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
  stopWatchingView?.();
  stopWatchingView = null;
  stopFigures?.();
  stopFigures = null;
  figuresDemand = 0;
  snapshot = EMPTY;
  statusSnapshot = EMPTY;
}
