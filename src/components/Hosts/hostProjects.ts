import { useEffect, useState } from "react";
import { LOCAL_HOST_ID, type HostId, type HostPlatform } from "@shared/types/remoteHosts";
import type { HostProjectPresence } from "@shared/types/ipc/hostSwitch";
import { getViewHostId } from "@/hooks/useHostConnection";
import { logWarn } from "@/utils/logger";
import { hasRemoteHosts, useHostList } from "./hostList";
import { buildHostMenuRows, type ClientPlatform } from "./hostModel";

/** A project as another host lists it. Its id means something only on that host. */
export interface HostProjectRef {
  id: string;
  name: string;
  path: string;
  emoji?: string;
}

export type HostProjectsLoader = (hostId: HostId) => Promise<HostProjectRef[]>;

/**
 * Reads another host's project list. Unset until a host-scoped listing call
 * exists: a window only reaches its own host's projects today, so until one is
 * installed the other hosts simply list nothing.
 */
let loader: HostProjectsLoader | null = null;

export function setHostProjectsLoader(next: HostProjectsLoader | null): void {
  loader = next;
  cache.clear();
}

const CACHE_TTL_MS = 10_000;
const cache = new Map<HostId, { at: number; projects: Promise<HostProjectRef[]> }>();

function loadHostProjects(hostId: HostId, now: number): Promise<HostProjectRef[]> {
  const cached = cache.get(hostId);
  if (cached && now - cached.at < CACHE_TTL_MS) return cached.projects;
  const load = loader;
  const projects = load
    ? load(hostId).catch((error: unknown) => {
        cache.delete(hostId);
        logWarn("[Hosts] Couldn't list another host's projects", { error });
        return [];
      })
    : Promise.resolve([]);
  cache.set(hostId, { at: now, projects });
  return projects;
}

export interface OtherHostTarget {
  hostId: HostId;
  name: string;
  platform: HostPlatform | null;
  /** The link is up (always true for this machine), so the host can be switched to. */
  reachable: boolean;
  /** Null until listed, or when nothing can list it. */
  projects: HostProjectRef[] | null;
}

/**
 * Every host other than the one this window is on, in host-menu order, with
 * their project lists once read. Empty for anyone with no remote host.
 */
export function useOtherHostTargets(localPlatform: ClientPlatform): OtherHostTarget[] {
  const hostList = useHostList();
  const currentHostId = getViewHostId() ?? LOCAL_HOST_ID;
  const [projectsByHost, setProjectsByHost] = useState<ReadonlyMap<HostId, HostProjectRef[]>>(
    () => new Map()
  );

  const rows = hasRemoteHosts(hostList)
    ? buildHostMenuRows(hostList.hosts, {
        localPlatform,
        currentHostId,
        localSummary: hostList.localSummary,
      }).filter((row) => !row.isCurrent)
    : [];
  const reachableIds = rows
    .filter((row) => row.isLocal || row.connection?.status === "connected")
    .map((row) => row.hostId);
  const reachableKey = reachableIds.join("\n");

  useEffect(() => {
    const ids = reachableKey === "" ? [] : reachableKey.split("\n");
    // A host that dropped may come back with different projects; nothing
    // listed before the drop is shown or reused after it.
    for (const id of [...cache.keys()]) if (!ids.includes(id)) cache.delete(id);
    setProjectsByHost((prev) => {
      const kept = [...prev].filter(([id]) => ids.includes(id));
      return kept.length === prev.size ? prev : new Map(kept);
    });
    if (ids.length === 0) return;
    let cancelled = false;
    const now = Date.now();
    void Promise.all(ids.map((id) => loadHostProjects(id, now))).then((lists) => {
      if (cancelled) return;
      setProjectsByHost(new Map(ids.map((id, index) => [id, lists[index] ?? []])));
    });
    return () => {
      cancelled = true;
    };
  }, [reachableKey]);

  return rows.map((row) => {
    const reachable = row.isLocal || row.connection?.status === "connected";
    return {
      hostId: row.hostId,
      name: row.name,
      platform: row.platform,
      reachable,
      projects: reachable ? (projectsByHost.get(row.hostId) ?? null) : null,
    };
  });
}

/**
 * The projects each host lists, for the hosts named (the overview's cards).
 * A host missing from the map hasn't answered yet; nothing is asked of a
 * host whose id isn't passed.
 */
export function useHostProjectLists(
  hostIds: readonly HostId[]
): ReadonlyMap<HostId, HostProjectRef[]> {
  const key = hostIds.join("\n");
  const [lists, setLists] = useState<ReadonlyMap<HostId, HostProjectRef[]>>(() => new Map());
  useEffect(() => {
    const ids = key === "" ? [] : key.split("\n");
    if (ids.length === 0) {
      setLists((prev) => (prev.size === 0 ? prev : new Map()));
      return;
    }
    let cancelled = false;
    const now = Date.now();
    void Promise.all(ids.map((id) => loadHostProjects(id, now))).then((loaded) => {
      if (!cancelled) setLists(new Map(ids.map((id, index) => [id, loaded[index] ?? []])));
    });
    return () => {
      cancelled = true;
    };
  }, [key]);
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
  cache.clear();
}
