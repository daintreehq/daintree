import { useEffect, useState } from "react";
import type { HostWorktreeEntry } from "@shared/types/ipc/hostMetrics";
import { LOCAL_HOST_ID, type HostId, type HostPlatform } from "@shared/types/remoteHosts";
import { isScratchWorkspaceId } from "@shared/utils/workspaceIds";
import { getViewHostId } from "@/hooks/useHostConnection";
import { isRemoteShellSupported } from "@/lib/remoteHosts";
import { logWarn } from "@/utils/logger";
import { hasRemoteHosts, useHostList } from "./hostList";
import { buildHostMenuRows, clientPlatform, describeHostMenuState } from "./hostModel";
import { useProjectPresence } from "./hostProjects";
import { isLive } from "./Overview/overviewModel";

/** The least time between asking the other hosts again whether they have this project. */
export const PRESENCE_RECHECK_MS = 3_000;

export interface OtherHostWorktrees {
  hostId: HostId;
  hostName: string;
  platform: HostPlatform | null;
  /** This project's ids on that host: more than one when it has several checkouts. */
  projectIds: readonly string[];
  /** Null until the host's first list lands, and while it isn't connected. */
  entries: readonly HostWorktreeEntry[] | null;
  /** The link's own words while the host isn't connected ("Not connected"); null while it is. */
  away: string | null;
}

interface Remembered {
  projectId: string | null;
  hosts: ReadonlyMap<HostId, readonly string[]>;
}

/** "hostId\tprojectId,projectId" per matched host, so an effect re-runs only when a match moves. */
function matchKey(matches: ReadonlyMap<HostId, readonly string[]>): string {
  return [...matches].map(([hostId, ids]) => `${hostId}\t${ids.join(",")}`).join("\n");
}

function parseMatchKey(key: string): Map<HostId, ReadonlySet<string>> {
  const out = new Map<HostId, ReadonlySet<string>>();
  if (key === "") return out;
  for (const line of key.split("\n")) {
    const [hostId, ids] = line.split("\t");
    if (hostId && ids) out.set(hostId, new Set(ids.split(",")));
  }
  return out;
}

/**
 * Every other host that has this project, in the host menu's order, with its
 * worktrees and the agents each host observed in them. Matched by repository
 * identity (a shared remote URL, as `project.openOnHost` matches); read when a
 * host matches and again each time that host says its list changed; a failed
 * read keeps what was shown. A host that drops its link keeps its place, in
 * the link's own words, until a connected answer says it no longer has the
 * project. Empty until some other host has this project.
 */
export function useOtherHostsWorktrees(projectId: string | null): OtherHostWorktrees[] {
  const hostList = useHostList();
  const [lists, setLists] = useState<ReadonlyMap<HostId, readonly HostWorktreeEntry[]>>(
    () => new Map()
  );
  const enabled =
    projectId !== null &&
    !isScratchWorkspaceId(projectId) &&
    isRemoteShellSupported() &&
    hasRemoteHosts(hostList);
  const others = enabled
    ? buildHostMenuRows(hostList.hosts, {
        localPlatform: clientPlatform(),
        currentHostId: getViewHostId() ?? LOCAL_HOST_ID,
        localSummary: hostList.localSummary,
      }).filter((row) => !row.isCurrent)
    : [];
  const rows = others.filter(isLive);
  const hostIds = rows.map((row) => row.hostId);
  // Bumped when a host with no match says its list changed: it may have this project now.
  const [presenceRevision, setPresenceRevision] = useState(0);
  const presence = useProjectPresence(projectId ?? "", hostIds, presenceRevision);

  const matches = new Map<HostId, readonly string[]>();
  for (const row of rows) {
    const found = presence.get(row.hostId)?.projects;
    if (found && found.length > 0) {
      matches.set(
        row.hostId,
        found.map((project) => project.projectId)
      );
    }
  }
  const key = matchKey(matches);
  const unmatchedKey = hostIds.filter((hostId) => !matches.has(hostId)).join("\n");
  // Only a connected answer of "none" forgets a host; one that couldn't be asked keeps its place.
  const absentKey = hostIds
    .filter((hostId) => presence.get(hostId)?.projects?.length === 0)
    .join("\n");

  const [remembered, setRemembered] = useState<Remembered>(() => ({
    projectId,
    hosts: new Map(),
  }));
  useEffect(() => {
    const matched = parseMatchKey(key);
    const absent = absentKey === "" ? [] : absentKey.split("\n");
    setRemembered((previous) => {
      const same = previous.projectId === projectId;
      const hosts = new Map(same ? previous.hosts : []);
      for (const [hostId, ids] of matched) hosts.set(hostId, [...ids]);
      for (const hostId of absent) hosts.delete(hostId);
      if (same && matchKey(hosts) === matchKey(previous.hosts)) return previous;
      return { projectId, hosts };
    });
  }, [projectId, key, absentKey]);
  const known =
    remembered.projectId === projectId ? remembered.hosts : new Map<HostId, readonly string[]>();

  useEffect(() => {
    if (unmatchedKey === "") return;
    const api = window.electron?.hostMetrics;
    if (!api) return;
    const unmatched = new Set(unmatchedKey.split("\n"));
    // Once at the first change, then at most once a window: a busy host must
    // not restart the lookup faster than it can answer.
    let timer: ReturnType<typeof setTimeout> | null = null;
    let heldBack = false;
    const settle = (): void => {
      timer = null;
      if (!heldBack) return;
      heldBack = false;
      setPresenceRevision((revision) => revision + 1);
      timer = setTimeout(settle, PRESENCE_RECHECK_MS);
    };
    const off = api.onEvent((event) => {
      if (event.type !== "worktrees" || !unmatched.has(event.hostId)) return;
      if (timer !== null) {
        heldBack = true;
        return;
      }
      setPresenceRevision((revision) => revision + 1);
      timer = setTimeout(settle, PRESENCE_RECHECK_MS);
    });
    return () => {
      off();
      if (timer !== null) clearTimeout(timer);
    };
  }, [unmatchedKey]);

  useEffect(() => {
    const matched = parseMatchKey(key);
    if (matched.size === 0) return;
    const api = window.electron?.hostMetrics;
    if (!api) return;
    let live = true;
    // Only the newest read for a host may land: a slow one never overwrites a later answer.
    const latest = new Map<HostId, number>();
    const read = (hostId: HostId): void => {
      const projectIds = matched.get(hostId);
      if (!projectIds) return;
      const seq = (latest.get(hostId) ?? 0) + 1;
      latest.set(hostId, seq);
      api
        .listWorktrees({ hostId })
        .then((entries) => {
          if (!live || latest.get(hostId) !== seq) return;
          const mine = entries.filter((entry) => projectIds.has(entry.projectId));
          setLists((previous) => new Map(previous).set(hostId, mine));
        })
        .catch((error: unknown) => {
          logWarn("[Hosts] Couldn't list another host's worktrees", { hostId, error });
        });
    };
    const off = api.onEvent((event) => {
      if (event.type === "worktrees") read(event.hostId);
    });
    for (const hostId of matched.keys()) read(hostId);
    return () => {
      live = false;
      off();
    };
  }, [key]);

  const out: OtherHostWorktrees[] = [];
  for (const row of others) {
    const live = isLive(row);
    // A connected host waiting on its answer keeps the place it had.
    const projectIds =
      matches.get(row.hostId) ??
      (live && presence.get(row.hostId)?.projects?.length === 0
        ? undefined
        : known.get(row.hostId));
    if (!projectIds) continue;
    // A read from before the host matched another project never shows under this one.
    const read = lists.get(row.hostId);
    const entries =
      live && read ? read.filter((entry) => projectIds.includes(entry.projectId)) : null;
    out.push({
      hostId: row.hostId,
      hostName: row.name,
      platform: row.platform,
      projectIds,
      entries,
      away: live ? null : (describeHostMenuState(row).state ?? "Not connected"),
    });
  }
  return out;
}
