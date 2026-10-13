import { useEffect, useState, useSyncExternalStore } from "react";
import { LOCAL_HOST_ID, type HostId, type HostPlatform } from "@shared/types/remoteHosts";
import type { HostProjectPresence } from "@shared/types/ipc/hostSwitch";
import type { HostProjectSummary } from "@shared/types/ipc/remoteHosts";
import { getViewHostId } from "@/hooks/useHostConnection";
import { logWarn } from "@/utils/logger";
import { hasRemoteHosts, useHostList } from "./hostList";
import { buildHostMenuRows, type ClientPlatform } from "./hostModel";

/** A project as another host lists it. Its id means something only on that host. */
export type HostProjectRef = HostProjectSummary;

export type HostProjectsLoader = (hostId: HostId) => Promise<HostProjectRef[]>;

/** A list a host gave, and when it answered. */
export interface HostListing {
  projects: readonly HostProjectRef[];
  listedAt: number;
}

/**
 * What can be said about a host's projects right now. `lastGood` is the last
 * list it gave this session, kept so a host that drops or fails still shows
 * what it had; it is never presented as live.
 */
export type HostListingState =
  | { status: "loading"; lastGood: HostListing | null }
  | { status: "loaded"; list: HostListing }
  | { status: "failed"; lastGood: HostListing | null }
  | { status: "not-connected"; lastGood: HostListing | null };

/** The projects a listing state can show, fresh or not. */
export function listingProjects(state: HostListingState): readonly HostProjectRef[] {
  return state.status === "loaded" ? state.list.projects : (state.lastGood?.projects ?? []);
}

/** Set by `installHostProjectsLoader`; until it is, every host lists nothing. */
let loader: HostProjectsLoader | null = null;

export function setHostProjectsLoader(next: HostProjectsLoader | null): void {
  loader = next;
  entries = new Map();
  emit();
}

/** A finished listing is reused this long before a host is asked again. */
const CACHE_TTL_MS = 10_000;

interface HostRequest {
  generation: number;
  outcome: "pending" | "ok" | "failed";
  settledAt: number;
}

interface CatalogueEntry {
  lastGood: HostListing | null;
  request: HostRequest | null;
}

// Module-level, so every list in this view shares one request per host, and a
// host's last list outlives the palette that asked for it.
let entries: ReadonlyMap<HostId, CatalogueEntry> = new Map();
let nextGeneration = 1;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getEntries(): ReadonlyMap<HostId, CatalogueEntry> {
  return entries;
}

function setEntry(hostId: HostId, entry: CatalogueEntry | null): void {
  const next = new Map(entries);
  if (entry) next.set(hostId, entry);
  else next.delete(hostId);
  entries = next;
  emit();
}

/** Ask a host for its projects unless an answer is on its way or still fresh. */
function requestHostProjects(hostId: HostId, now: number = Date.now()): void {
  const entry = entries.get(hostId);
  const request = entry?.request;
  if (request?.outcome === "pending") return;
  if (request?.outcome === "ok" && now - request.settledAt < CACHE_TTL_MS) return;
  const load = loader ?? (async () => []);
  const generation = nextGeneration++;
  setEntry(hostId, {
    lastGood: entry?.lastGood ?? null,
    request: { generation, outcome: "pending", settledAt: 0 },
  });
  // Each host settles on its own: one slow host never holds back another's rows.
  load(hostId).then(
    (projects) => settle(hostId, generation, projects),
    (error: unknown) => {
      logWarn("[Hosts] Couldn't list another host's projects", { error });
      settle(hostId, generation, null);
    }
  );
}

function settle(hostId: HostId, generation: number, projects: HostProjectRef[] | null): void {
  const entry = entries.get(hostId);
  // Superseded by a retry, a drop or a new loader: a late answer changes nothing.
  if (!entry || entry.request?.generation !== generation) return;
  const settledAt = Date.now();
  setEntry(hostId, {
    lastGood: projects ? { projects, listedAt: settledAt } : entry.lastGood,
    request: { generation, outcome: projects ? "ok" : "failed", settledAt },
  });
}

/** Ask a host again now, whatever was cached. Its last list stays until the answer. */
export function retryHostProjects(hostId: HostId): void {
  const entry = entries.get(hostId);
  if (entry?.request) setEntry(hostId, { lastGood: entry.lastGood, request: null });
  requestHostProjects(hostId);
}

/**
 * A host whose link dropped: what it listed is kept as history, but nothing in
 * flight or cached counts as fresh once it is back.
 */
function invalidateRequest(hostId: HostId): void {
  const entry = entries.get(hostId);
  if (entry?.request) setEntry(hostId, { lastGood: entry.lastGood, request: null });
}

function listingStateOf(entry: CatalogueEntry | undefined, reachable: boolean): HostListingState {
  const lastGood = entry?.lastGood ?? null;
  if (!reachable) return { status: "not-connected", lastGood };
  switch (entry?.request?.outcome) {
    case "ok":
      return lastGood ? { status: "loaded", list: lastGood } : { status: "loading", lastGood };
    case "failed":
      return { status: "failed", lastGood };
    default:
      return { status: "loading", lastGood };
  }
}

function useCatalogue(): ReadonlyMap<HostId, CatalogueEntry> {
  return useSyncExternalStore(subscribe, getEntries, getEntries);
}

export interface OtherHost {
  hostId: HostId;
  name: string;
  platform: HostPlatform | null;
  /** The link is up (always true for this machine), so the host can be switched to. */
  reachable: boolean;
}

export interface OtherHostTarget extends OtherHost {
  listing: HostListingState;
}

/**
 * Every host other than the one this window is on, in host-menu order. Asks
 * nothing of any host. Empty for anyone with no remote host.
 */
export function useOtherHosts(localPlatform: ClientPlatform): OtherHost[] {
  const hostList = useHostList();
  const currentHostId = getViewHostId() ?? LOCAL_HOST_ID;
  if (!hasRemoteHosts(hostList)) return [];
  return buildHostMenuRows(hostList.hosts, {
    localPlatform,
    currentHostId,
    localSummary: hostList.localSummary,
  })
    .filter((row) => !row.isCurrent)
    .map((row) => ({
      hostId: row.hostId,
      name: row.name,
      platform: row.platform,
      reachable: row.isLocal || row.connection?.status === "connected",
    }));
}

/**
 * Every other host with what can be said about its projects. Connected hosts
 * are listed as they answer; a host that isn't connected is never dialled
 * here, and shows its last list from this session, if it gave one.
 */
export function useOtherHostTargets(localPlatform: ClientPlatform): OtherHostTarget[] {
  const hosts = useOtherHosts(localPlatform);
  const hostList = useHostList();
  const catalogue = useCatalogue();
  const reachableKey = hosts
    .filter((host) => host.reachable)
    .map((host) => host.hostId)
    .join("\n");
  const unreachableKey = hosts
    .filter((host) => !host.reachable)
    .map((host) => host.hostId)
    .join("\n");
  const knownKey = [LOCAL_HOST_ID, ...hostList.hosts.map((entry) => entry.descriptor.id)].join(
    "\n"
  );

  useEffect(() => {
    // A removed host's history goes with it; the id could come back as
    // another machine.
    const known = new Set(knownKey.split("\n"));
    for (const id of [...getEntries().keys()]) if (!known.has(id)) setEntry(id, null);
  }, [knownKey]);

  useEffect(() => {
    if (unreachableKey !== "") for (const id of unreachableKey.split("\n")) invalidateRequest(id);
  }, [unreachableKey]);

  useEffect(() => {
    const now = Date.now();
    if (reachableKey !== "") for (const id of reachableKey.split("\n")) requestHostProjects(id, now);
  }, [reachableKey]);

  return hosts.map((host) => ({
    ...host,
    listing: listingStateOf(catalogue.get(host.hostId), host.reachable),
  }));
}

/**
 * The projects each host lists, for the hosts named (the overview's cards).
 * A host missing from the map hasn't answered yet, and null means its list
 * couldn't be read; nothing is asked of a host whose id isn't passed.
 */
export function useHostProjectLists(
  hostIds: readonly HostId[]
): ReadonlyMap<HostId, readonly HostProjectRef[] | null> {
  const key = hostIds.join("\n");
  const catalogue = useCatalogue();
  useEffect(() => {
    const now = Date.now();
    if (key !== "") for (const id of key.split("\n")) requestHostProjects(id, now);
  }, [key]);
  const lists = new Map<HostId, readonly HostProjectRef[] | null>();
  for (const hostId of hostIds) {
    const entry = catalogue.get(hostId);
    if (entry?.request?.outcome === "ok" && entry.lastGood) {
      lists.set(hostId, entry.lastGood.projects);
    } else if (entry?.request?.outcome === "failed") {
      lists.set(hostId, null);
    }
  }
  return lists;
}

/**
 * What each other host has of `projectId`, by repository identity (a remote
 * URL shared with it), asked of the Shell when the menu opens. Absent from
 * the map while it is being asked; `projects: null` when the host couldn't
 * be asked. A project that merely shares the name is never counted.
 */
export function useProjectPresence(
  projectId: string,
  hostIds: readonly HostId[]
): ReadonlyMap<HostId, HostProjectPresence> {
  const key = hostIds.join("\n");
  const [presence, setPresence] = useState<ReadonlyMap<HostId, HostProjectPresence>>(
    () => new Map()
  );
  useEffect(() => {
    const ids = key === "" ? [] : key.split("\n");
    const locate = window.electron?.hostSwitch?.locate;
    if (ids.length === 0 || typeof locate !== "function") return;
    let cancelled = false;
    locate({ fromHostId: getViewHostId() ?? LOCAL_HOST_ID, projectId, toHostIds: ids })
      .then((answers) => {
        if (!cancelled) setPresence(new Map(answers.map((answer) => [answer.hostId, answer])));
      })
      .catch((error: unknown) => {
        logWarn("[Hosts] Couldn't ask other hosts for this project", { error });
        if (!cancelled) {
          setPresence(new Map(ids.map((hostId) => [hostId, { hostId, projects: null }])));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, key]);
  return presence;
}

export function _resetHostProjectsForTesting(): void {
  loader = null;
  entries = new Map();
  listeners.clear();
}
