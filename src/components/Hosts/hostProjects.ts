import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { LOCAL_HOST_ID, type HostId, type HostPlatform } from "@shared/types/remoteHosts";
import type { HostProjectPresence, HostSwitchLocatePayload } from "@shared/types/ipc/hostSwitch";
import type { HostProjectSummary } from "@shared/types/ipc/remoteHosts";
import { getViewHostId } from "@/hooks/useHostConnection";
import { logWarn } from "@/utils/logger";
import { hasRemoteHosts, useHostList } from "./hostList";
import { _resetHostWorktreesForTesting, pruneHostWorktrees } from "./hostWorktrees";
import {
  buildHostMenuRows,
  describeHostMenuState,
  hostLinkTone,
  type ClientPlatform,
  type HostLinkTone,
} from "./hostModel";

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
  /** `afterFailure`: asked again after a failed listing, so its Retry keeps its place. */
  | { status: "loading"; lastGood: HostListing | null; afterFailure?: boolean }
  | { status: "loaded"; list: HostListing }
  | { status: "failed"; lastGood: HostListing | null }
  | { status: "not-connected"; lastGood: HostListing | null };

/** The projects a listing state can show, fresh or not. */
export function listingProjects(state: HostListingState): readonly HostProjectRef[] {
  return state.status === "loaded" ? state.list.projects : (state.lastGood?.projects ?? []);
}

/** Set by `installHostProjectsLoader`; until it is, every host lists nothing. */
let loader: HostProjectsLoader | null = null;

// Bumped with each loader, so a list mounted before it arrived asks again.
let loaderRevision = 0;

export function setHostProjectsLoader(next: HostProjectsLoader | null): void {
  loader = next;
  loaderRevision += 1;
  entries = new Map();
  emit();
}

function getLoaderRevision(): number {
  return loaderRevision;
}

function useLoaderRevision(): number {
  return useSyncExternalStore(subscribe, getLoaderRevision, getLoaderRevision);
}

function getHasLoader(): boolean {
  return loader !== null;
}

/**
 * Whether anything can list another host's projects yet. Until a loader is
 * installed every listing comes back empty, which says nothing about the host.
 */
export function useHostProjectsListable(): boolean {
  return useSyncExternalStore(subscribe, getHasLoader, getHasLoader);
}

/** A finished listing is reused this long before a host is asked again. */
const CACHE_TTL_MS = 10_000;

interface HostRequest {
  generation: number;
  outcome: "pending" | "ok" | "failed";
  settledAt: number;
  /** This request follows a failed one. */
  afterFailure?: boolean;
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
function requestHostProjects(
  hostId: HostId,
  now: number = Date.now(),
  afterFailure: boolean = entries.get(hostId)?.request?.outcome === "failed"
): void {
  const entry = entries.get(hostId);
  const request = entry?.request;
  if (request?.outcome === "pending") return;
  if (request?.outcome === "ok" && now - request.settledAt < CACHE_TTL_MS) return;
  const load = loader ?? (async () => []);
  const generation = nextGeneration++;
  setEntry(hostId, {
    lastGood: entry?.lastGood ?? null,
    request: { generation, outcome: "pending", settledAt: 0, afterFailure },
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
  const afterFailure =
    entry?.request?.outcome === "failed" || entry?.request?.afterFailure === true;
  if (entry?.request) setEntry(hostId, { lastGood: entry.lastGood, request: null });
  requestHostProjects(hostId, Date.now(), afterFailure);
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
      return { status: "loading", lastGood, afterFailure: entry?.request?.afterFailure === true };
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
  /**
   * The link as the host menu draws it: its mark, and its words ("Connected",
   * "Connecting…", "Unreachable", …). No words for this machine, which is
   * always there.
   */
  link: { tone: HostLinkTone; state: string | null };
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
      link: {
        tone: hostLinkTone(row),
        state: row.isLocal ? null : describeHostMenuState(row).state,
      },
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
  const revision = useLoaderRevision();
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
    pruneHostWorktrees(known);
  }, [knownKey]);

  useEffect(() => {
    if (unreachableKey !== "") for (const id of unreachableKey.split("\n")) invalidateRequest(id);
  }, [unreachableKey]);

  useEffect(() => {
    const now = Date.now();
    if (reachableKey !== "")
      for (const id of reachableKey.split("\n")) requestHostProjects(id, now);
  }, [reachableKey, revision]);

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
  const revision = useLoaderRevision();
  useEffect(() => {
    const now = Date.now();
    if (key !== "") for (const id of key.split("\n")) requestHostProjects(id, now);
  }, [key, revision]);
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

const NO_PRESENCE: ReadonlyMap<HostId, HostProjectPresence> = new Map();

type Locate = (payload: HostSwitchLocatePayload) => Promise<HostProjectPresence[]>;

/** Each answer that landed, by host; undefined where the host gave none. */
type Landed = ReadonlyMap<HostId, HostProjectPresence | undefined>;

/**
 * One project's lookups against other hosts, each host on its own: a host is
 * asked when it becomes a target and when it says its projects changed, and
 * never because another host was. A host already being asked is asked once
 * more after its answer, never twice at once, and only its newest answer lands.
 */
class PresenceLookups {
  private readonly targets = new Set<HostId>();
  /** The request each host's answer is awaited from. */
  private readonly inFlight = new Map<HostId, number>();
  /** Hosts told to ask again while a request to them was out. */
  private readonly again = new Set<HostId>();
  private nextRequest = 1;
  private disposed = false;

  constructor(
    private readonly projectId: string,
    private readonly locate: Locate,
    private readonly land: (landed: Landed) => void
  ) {}

  /** Ask the hosts that weren't targets before, and stop following the ones that left. */
  setTargets(hostIds: readonly HostId[]): void {
    const next = new Set(hostIds);
    for (const hostId of [...this.targets]) {
      if (next.has(hostId)) continue;
      this.targets.delete(hostId);
      this.inFlight.delete(hostId);
      this.again.delete(hostId);
    }
    const added = hostIds.filter((hostId) => !this.targets.has(hostId));
    for (const hostId of added) this.targets.add(hostId);
    this.ask(added);
  }

  /** Ask these targets again: now, or once the answer already on its way lands. */
  ask(hostIds: readonly HostId[]): void {
    if (this.disposed) return;
    const now: HostId[] = [];
    for (const hostId of hostIds) {
      if (!this.targets.has(hostId)) continue;
      if (this.inFlight.has(hostId)) this.again.add(hostId);
      else now.push(hostId);
    }
    if (now.length === 0) return;
    const request = this.nextRequest++;
    for (const hostId of now) this.inFlight.set(hostId, request);
    this.locate({
      fromHostId: getViewHostId() ?? LOCAL_HOST_ID,
      projectId: this.projectId,
      toHostIds: now,
    }).then(
      (answers) => {
        const byHost = new Map(answers.map((answer) => [answer.hostId, answer]));
        this.settle(request, now, (hostId) => byHost.get(hostId));
      },
      (error: unknown) => {
        logWarn("[Hosts] Couldn't ask other hosts for this project", { error });
        this.settle(request, now, (hostId) => ({ hostId, projects: null }));
      }
    );
  }

  dispose(): void {
    this.disposed = true;
  }

  private settle(
    request: number,
    hostIds: readonly HostId[],
    answerOf: (hostId: HostId) => HostProjectPresence | undefined
  ): void {
    if (this.disposed) return;
    const landed = new Map<HostId, HostProjectPresence | undefined>();
    const again: HostId[] = [];
    for (const hostId of hostIds) {
      // Superseded: the host left the targets (and may be back on a newer request).
      if (this.inFlight.get(hostId) !== request) continue;
      this.inFlight.delete(hostId);
      landed.set(hostId, answerOf(hostId));
      if (this.again.delete(hostId)) again.push(hostId);
    }
    if (landed.size > 0) this.land(landed);
    this.ask(again);
  }
}

/**
 * What each other host has of `projectId`, by repository identity (a remote
 * URL shared with it), asked of the Shell. Absent from the map while it is
 * being asked; `projects: null` when the host couldn't be asked. A project
 * that merely shares the name is never counted. Each host is asked when it
 * joins `hostIds` and again when it says its projects changed, and only that
 * host: agent activity never asks, and a host that joins never re-asks the rest.
 */
export function useProjectPresence(
  projectId: string,
  hostIds: readonly HostId[]
): ReadonlyMap<HostId, HostProjectPresence> {
  const key = hostIds.join("\n");
  // Answers carry the project they were asked about: one asked about the
  // previous project never stands in for this one while its own is out.
  const [answered, setAnswered] = useState<{
    projectId: string;
    presence: ReadonlyMap<HostId, HostProjectPresence>;
  }>(() => ({ projectId, presence: new Map() }));
  const lookupsRef = useRef<PresenceLookups | null>(null);

  useEffect(() => {
    const locate = window.electron?.hostSwitch?.locate;
    if (typeof locate !== "function") return;
    const lookups = new PresenceLookups(projectId, locate, (landed) =>
      setAnswered((previous) => {
        const presence = new Map(previous.projectId === projectId ? previous.presence : []);
        for (const [hostId, answer] of landed) {
          if (answer) presence.set(hostId, answer);
          else presence.delete(hostId);
        }
        return { projectId, presence };
      })
    );
    lookupsRef.current = lookups;
    const off = window.electron?.hostMetrics?.onEvent?.((event) => {
      if (event.type === "projects") lookups.ask([event.hostId]);
    });
    return () => {
      lookups.dispose();
      off?.();
      if (lookupsRef.current === lookups) lookupsRef.current = null;
    };
  }, [projectId]);

  useEffect(() => {
    lookupsRef.current?.setTargets(key === "" ? [] : key.split("\n"));
  }, [projectId, key]);

  return answered.projectId === projectId ? answered.presence : NO_PRESENCE;
}

export function _resetHostProjectsForTesting(): void {
  loader = null;
  entries = new Map();
  listeners.clear();
  _resetHostWorktreesForTesting();
}
