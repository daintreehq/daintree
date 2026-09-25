import { useEffect, useState } from "react";
import { LOCAL_HOST_ID, type HostId, type HostPlatform } from "@shared/types/remoteHosts";
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
 * The project on `target` that goes by the same name, if it lists one. A name
 * match is only what the host reports, so the menu says what it saw: a project
 * of that name is there.
 */
export function findSameNamedProject(
  target: OtherHostTarget,
  projectName: string
): HostProjectRef | null {
  const wanted = projectName.trim().toLocaleLowerCase();
  return target.projects?.find((p) => p.name.trim().toLocaleLowerCase() === wanted) ?? null;
}

export function _resetHostProjectsForTesting(): void {
  loader = null;
  cache.clear();
}
