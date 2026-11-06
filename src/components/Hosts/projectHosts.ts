import { useEffect, useState } from "react";
import type { HostWorktreeEntry } from "@shared/types/ipc/hostMetrics";
import { LOCAL_HOST_ID, type HostId, type HostPlatform } from "@shared/types/remoteHosts";
import { isScratchWorkspaceId } from "@shared/utils/workspaceIds";
import { getViewHostId } from "@/hooks/useHostConnection";
import { isRemoteShellSupported } from "@/lib/remoteHosts";
import { logWarn } from "@/utils/logger";
import { hasRemoteHosts, useHostList } from "./hostList";
import {
  buildHostMenuRows,
  clientPlatform,
  describeHostMenuState,
  type HostMenuRow,
} from "./hostModel";
import { useProjectPresence } from "./hostProjects";
import { isLive } from "./Overview/overviewModel";

/**
 * Whether the host has this project: as it last said, "unknown" when it
 * couldn't be asked (or never has been while its link was up), "pending" while
 * the first answer is out.
 */
export type ProjectPresence = "has" | "none" | "unknown" | "pending";

export interface ProjectHost {
  hostId: HostId;
  hostName: string;
  platform: HostPlatform | null;
  isLocal: boolean;
  /** The host this window shows. */
  isCurrent: boolean;
  /** The host menu's row, for the link's details. */
  row: HostMenuRow;
  /** The link's own words while what the host says isn't current ("Not connected", "No reply"); null while it is. */
  away: string | null;
  presence: ProjectPresence;
  /** This project's ids there as last matched: more than one when it has several checkouts. */
  projectIds: readonly string[];
  /** Null until the host's first list lands, and while it is away. */
  entries: readonly HostWorktreeEntry[] | null;
  /** The host's list couldn't be read, and no earlier read of this match is there to keep showing. */
  readFailed: boolean;
}

/**
 * A host's last read, with the match it was read for: one read for another
 * match never stands in. `entries` is null when the read failed with nothing
 * of this match read before it.
 */
interface Read {
  ids: string;
  entries: readonly HostWorktreeEntry[] | null;
}

interface Remembered {
  projectId: string | null;
  hosts: ReadonlyMap<HostId, readonly string[]>;
}

/**
 * Whether what the host tells us is current: this machine, or a host whose
 * link is up and still answering. A silent link's last word is history.
 */
export function isTalking(row: HostMenuRow): boolean {
  if (!isLive(row)) return false;
  return !(row.connection?.status === "connected" && row.connection.quietSince !== undefined);
}

/**
 * Whether the project is there to open on the host: the window's own, a host
 * that matched it, or one that did before its link went quiet. A host that
 * says it has no copy, or was never matched, isn't.
 */
export function isProjectThere(host: ProjectHost): boolean {
  return host.presence === "has";
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
 * This project on every host, the window's own included, in the host menu's
 * fixed order: this machine first, then every other host by name. No host
 * joins or leaves the list for its link, its activity or whether it has the
 * project, so the list reads the same from every window and never moves under
 * a click.
 *
 * Another host's copy is matched by repository identity (a shared remote URL,
 * as `project.openOnHost` matches); the window's own host is this view's
 * project. Each matched host's worktrees are read when it matches and again
 * each time it says its list changed, the window's own host the same way as
 * the rest, so a host's counts don't depend on which window reads them. A
 * failed read keeps what was shown.
 */
export function useProjectHosts(projectId: string | null): ProjectHost[] {
  const hostList = useHostList();
  const [lists, setLists] = useState<ReadonlyMap<HostId, Read>>(() => new Map());
  const enabled =
    projectId !== null &&
    !isScratchWorkspaceId(projectId) &&
    isRemoteShellSupported() &&
    hasRemoteHosts(hostList);
  const currentHostId = getViewHostId() ?? LOCAL_HOST_ID;
  const rows = enabled
    ? buildHostMenuRows(hostList.hosts, {
        localPlatform: clientPlatform(),
        currentHostId,
        localSummary: hostList.localSummary,
      })
    : [];
  const current = rows.find((row) => row.isCurrent);
  // The lookup starts from the window's own host, so nothing is asked while
  // it is away; its return changes this list, which asks again. Asked only
  // while the answer can be current, and never the window's own host: its
  // copy is the project this view shows.
  const askable =
    current && !isTalking(current)
      ? []
      : rows.filter((row) => !row.isCurrent && isTalking(row)).map((row) => row.hostId);
  // Asked again only of a host that says its projects changed: its worktrees
  // and agents moving can't change whether it has this project.
  const presence = useProjectPresence(projectId ?? "", askable);

  const matches = new Map<HostId, readonly string[]>();
  for (const hostId of askable) {
    const found = presence.get(hostId)?.projects;
    if (found && found.length > 0) {
      // By path, so a host row always opens the same checkout.
      matches.set(
        hostId,
        [...found].sort((a, b) => a.path.localeCompare(b.path)).map((project) => project.projectId)
      );
    }
  }
  const key = matchKey(matches);
  // Only a connected answer of "none" forgets a host; one that couldn't be asked keeps its match.
  const absentKey = askable
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

  const readable = new Map(matches);
  if (current && projectId !== null && isTalking(current))
    readable.set(current.hostId, [projectId]);
  const readKey = matchKey(readable);

  useEffect(() => {
    const matched = parseMatchKey(readKey);
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
          // Nothing of this project listed means it isn't open there; whether
          // it is still there is the host's projects to say, not its worktrees.
          setLists((previous) =>
            new Map(previous).set(hostId, { ids: [...projectIds].join(","), entries: mine })
          );
        })
        .catch((error: unknown) => {
          logWarn("[Hosts] Couldn't list a host's worktrees", { hostId, error });
          if (!live || latest.get(hostId) !== seq) return;
          const ids = [...projectIds].join(",");
          // A failed read keeps what was shown; with nothing shown, it says so
          // rather than reading as a lookup still out.
          setLists((previous) => {
            const shown = previous.get(hostId);
            if (shown?.ids === ids && shown.entries) return previous;
            return new Map(previous).set(hostId, { ids, entries: null });
          });
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
  }, [readKey]);

  return rows.map((row) => {
    const talking = isTalking(row);
    let state: ProjectPresence;
    let projectIds: readonly string[];
    if (row.isCurrent) {
      state = "has";
      projectIds = projectId === null ? [] : [projectId];
    } else {
      const answer = talking ? presence.get(row.hostId) : undefined;
      const match = matches.get(row.hostId) ?? known.get(row.hostId);
      if (answer?.projects?.length === 0) {
        state = "none";
        projectIds = [];
      } else if (match) {
        state = "has";
        projectIds = match;
      } else {
        state = talking && answer === undefined ? "pending" : "unknown";
        projectIds = [];
      }
    }
    // A read for another match (another project, another checkout) never
    // stands in for this one: until this match's own read lands, nothing is.
    const read = lists.get(row.hostId);
    const ownRead = talking && state === "has" && read?.ids === projectIds.join(",") ? read : null;
    const entries = ownRead?.entries ?? null;
    return {
      hostId: row.hostId,
      hostName: row.name,
      platform: row.platform,
      isLocal: row.isLocal,
      isCurrent: row.isCurrent,
      row,
      away: talking ? null : (describeHostMenuState(row).state ?? "Not connected"),
      presence: state,
      projectIds,
      entries,
      readFailed: ownRead !== null && ownRead.entries === null,
    };
  });
}
