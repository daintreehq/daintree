import { useEffect, useState } from "react";
import type { HostWorktreeEntry } from "@shared/types/ipc/hostMetrics";
import { LOCAL_HOST_ID, type HostId } from "@shared/types/remoteHosts";
import { isScratchWorkspaceId } from "@shared/utils/workspaceIds";
import { getViewHostId } from "@/hooks/useHostConnection";
import { isRemoteShellSupported } from "@/lib/remoteHosts";
import { logWarn } from "@/utils/logger";
import { hasRemoteHosts, useHostList } from "./hostList";
import { buildHostMenuRows, clientPlatform } from "./hostModel";
import { useProjectPresence } from "./hostProjects";
import { isLive } from "./Overview/overviewModel";

export interface OtherHostWorktrees {
  hostId: HostId;
  hostName: string;
  entries: readonly HostWorktreeEntry[];
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
 * This project's worktrees on every other connected host, matched by
 * repository identity (a shared remote URL, as `project.openOnHost` matches),
 * with the band each host observed. Read when a host matches and again each
 * time that host says its list changed; a failed read keeps what was shown.
 * Empty until some other host has this project.
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
  const rows = enabled
    ? buildHostMenuRows(hostList.hosts, {
        localPlatform: clientPlatform(),
        currentHostId: getViewHostId() ?? LOCAL_HOST_ID,
        localSummary: hostList.localSummary,
      }).filter((row) => !row.isCurrent && isLive(row))
    : [];
  const presence = useProjectPresence(
    projectId ?? "",
    rows.map((row) => row.hostId)
  );

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
  for (const row of rows) {
    if (!matches.has(row.hostId)) continue;
    const entries = lists.get(row.hostId);
    if (entries && entries.length > 0) {
      out.push({ hostId: row.hostId, hostName: row.name, entries });
    }
  }
  return out;
}
