import { useEffect, useMemo, useState } from "react";
import { useFleetSnapshotStore } from "@/store/fleetSnapshotStore";
import { useProjectStore } from "@/store/projectStore";
import { useScratchStore } from "@/store/scratchStore";
import { getViewWorkspaceId } from "@/store/viewWorkspaceId";
import { safeFireAndForget } from "@/utils/safeFireAndForget";
import { buildPilotGroups, type PilotWorkspaceMeta } from "@/components/Pilot/pilotRows";
import { buildCanopyInbox } from "./canopyModel";
import { ALL_HOSTS_LABEL } from "./CanopyHostPicker";
import {
  ownCanopyApi,
  ownCanopyTerminalApi,
  remoteCanopyApi,
  remoteCanopyTerminalApi,
  useRemoteCanopies,
  useRemoteCanopy,
} from "./canopyHostSource";
import {
  allHostsKey,
  createAllHostsRoute,
  mergeHostReadings,
  type HostReading,
} from "./canopyAllHosts";
import { ALL_HOSTS_ID, canopyOwnHostId, useCanopyStore, type CanopyScope } from "@/store/canopyStore";
import { retryHostProjects, useHostProjectLists } from "@/components/Hosts/hostProjects";
import type { HostMenuRow } from "@/components/Hosts/hostModel";
import type { HostId } from "@shared/types/remoteHosts";

/** No other host's projects to list: one array, so the lookup's key stays put. */
const NO_HOSTS: readonly HostId[] = [];

/** Ages are minute-grained, as in Pilot. */
const AGE_TICK_MS = 30_000;

/**
 * The inbox's runs for the host the panel shows: the window's own, another
 * host read through its own Canopy, or every host merged. Owns the route that
 * reads them, the scope main is told, and the minute tick their ages run on.
 */
export function useCanopyInboxData({
  isOpen,
  hostId,
  hostRow,
  hostRows,
}: {
  isOpen: boolean;
  /** The other host the panel shows, or null for the window's own. */
  hostId: HostId | null;
  /** That host as the host menu draws it, while it is in the host list. */
  hostRow: HostMenuRow | null;
  /** The hosts read together when `hostId` is All hosts. */
  hostRows: readonly HostMenuRow[] | null;
}) {
  // Another host is read through its own Canopy and shown as it read it: its
  // runs can be read, archived and marked here, and nothing else is done to
  // them until it can reach them. The window's own stores never hold its data.
  const otherHost = hostId !== null;
  const everyHost = hostId === ALL_HOSTS_ID;
  const ownHostId = canopyOwnHostId();
  const hostName = everyHost ? ALL_HOSTS_LABEL : (hostRow?.name ?? hostId ?? "");
  const remote = useRemoteCanopy(everyHost ? null : hostId, isOpen);
  // Every host listed, the window's own among them, each read on its own.
  const participantKey = everyHost ? (hostRows ?? []).map((row) => row.hostId).join("\u0000") : "";
  const participants = useMemo(
    () => (participantKey === "" ? NO_HOSTS : participantKey.split("\u0000")),
    [participantKey]
  );
  const remoteIds = useMemo(
    () => participants.filter((id) => id !== ownHostId),
    [participants, ownHostId]
  );
  const remotes = useRemoteCanopies(remoteIds, isOpen && everyHost);
  const route = useMemo(
    () => (everyHost ? createAllHostsRoute(ownHostId, participants) : null),
    [everyHost, ownHostId, participants]
  );
  useEffect(() => {
    if (!route || !isOpen) return;
    route.open();
    return () => route.close();
  }, [route, isOpen]);
  const api = useMemo(
    () => route?.api ?? (hostId === null || everyHost ? ownCanopyApi : remoteCanopyApi(hostId)),
    [route, hostId, everyHost]
  );
  const terminalApi = useMemo(
    () =>
      route?.terminalApi ??
      (hostId === null || everyHost ? ownCanopyTerminalApi : remoteCanopyTerminalApi(hostId)),
    [route, hostId, everyHost]
  );
  const ownCanopy = useCanopyStore((s) => s.snapshot);
  const ownFleet = useFleetSnapshotStore((s) => s.snapshot);
  const readings = useMemo<HostReading[]>(
    () =>
      everyHost
        ? participants.map((id) =>
            id === ownHostId
              ? { hostId: id, canopy: ownCanopy, fleet: ownFleet, error: null }
              : {
                  hostId: id,
                  canopy: remotes.states.get(id)?.canopy ?? null,
                  fleet: remotes.states.get(id)?.fleet ?? null,
                  error: remotes.states.get(id)?.error ?? null,
                }
          )
        : [],
    [everyHost, participants, ownHostId, ownCanopy, ownFleet, remotes.states]
  );
  const merged = useMemo(
    () => (everyHost ? mergeHostReadings(readings) : null),
    [everyHost, readings]
  );
  const canopy = merged ? merged.canopy : otherHost ? remote.canopy : ownCanopy;
  const fleet = merged ? merged.fleet : otherHost ? remote.fleet : ownFleet;
  const projects = useProjectStore((s) => s.projects);
  const scratches = useScratchStore((s) => s.scratches);
  const hostProjects = useHostProjectLists(
    everyHost ? remoteIds : hostId === null ? NO_HOSTS : [hostId]
  );
  const storedScope = useCanopyStore((s) => s.scope);
  const setScope = useCanopyStore((s) => s.setScope);
  // "This project" is the window's own project: another host shows all of its own.
  const scope: CanopyScope = otherHost ? "all" : storedScope;
  // The link came back: its project names may have changed while it was away.
  const hostEpochs = everyHost
    ? remoteIds.map((id) => `${id}:${remotes.states.get(id)?.epoch ?? 0}`).join(" ")
    : "";
  const recoveries = everyHost
    ? [...remotes.states.values()].reduce((sum, state) => sum + state.epoch, 0)
    : remote.epoch;
  useEffect(() => {
    if (hostId === null || recoveries === 0) return;
    if (!everyHost) {
      retryHostProjects(hostId);
      return;
    }
    // Said again for exactly the hosts whose link came back.
    for (const entry of hostEpochs.split(" ")) {
      const cut = entry.lastIndexOf(":");
      if (cut > 0 && Number(entry.slice(cut + 1)) > 0) retryHostProjects(entry.slice(0, cut));
    }
  }, [hostId, everyHost, recoveries, hostEpochs]);

  // Main reads only the screens in scope, so the agents a project view hides
  // cost nothing. Said again whenever another host's link comes back.
  useEffect(() => {
    if (!isOpen) return;
    safeFireAndForget(api.setScope(scope === "project" ? getViewWorkspaceId() : null));
  }, [isOpen, scope, api, recoveries]);

  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!isOpen) return;
    const handle = setInterval(() => setNowMs(Date.now()), AGE_TICK_MS);
    return () => clearInterval(handle);
  }, [isOpen]);

  const workspaces = useMemo(() => {
    const map = new Map<string, PilotWorkspaceMeta>();
    if (everyHost) {
      // A project is named with its host, and keyed by it: ids mean something only there.
      const nameOf = (id: HostId) =>
        (hostRows ?? []).find((row) => row.hostId === id)?.name ?? "This Mac";
      const withHost = (name: string, id: HostId) => `${name} · ${nameOf(id)}`;
      for (const project of projects) {
        map.set(allHostsKey(ownHostId, project.id), {
          kind: "project",
          name: withHost(project.name, ownHostId),
          lastOpened: project.lastOpened,
          ...(project.emoji ? { emoji: project.emoji } : {}),
          ...(project.color ? { color: project.color } : {}),
        });
      }
      for (const scratch of scratches) {
        map.set(allHostsKey(ownHostId, scratch.id), {
          kind: "scratch",
          name: withHost(scratch.name, ownHostId),
          lastOpened: scratch.lastOpened,
        });
      }
      for (const id of remoteIds) {
        for (const project of hostProjects.get(id) ?? []) {
          map.set(allHostsKey(id, project.id), {
            kind: "project",
            name: withHost(project.name, id),
            ...(project.emoji ? { emoji: project.emoji } : {}),
          });
        }
      }
      return map;
    }
    // Another host's workspace ids mean something only there: named from its own list.
    if (hostId !== null) {
      for (const project of hostProjects.get(hostId) ?? []) {
        map.set(project.id, {
          kind: "project",
          name: project.name,
          ...(project.emoji ? { emoji: project.emoji } : {}),
        });
      }
      return map;
    }
    for (const project of projects) {
      map.set(project.id, {
        kind: "project",
        name: project.name,
        lastOpened: project.lastOpened,
        ...(project.emoji ? { emoji: project.emoji } : {}),
        ...(project.color ? { color: project.color } : {}),
      });
    }
    for (const scratch of scratches) {
      map.set(scratch.id, {
        kind: "scratch",
        name: scratch.name,
        lastOpened: scratch.lastOpened,
      });
    }
    return map;
  }, [hostId, everyHost, hostRows, ownHostId, remoteIds, hostProjects, projects, scratches]);

  const baseItems = useMemo(() => {
    if (!fleet) return [];
    // No project on another host is the one this window shows.
    const here = otherHost ? null : getViewWorkspaceId();
    const runs =
      scope === "project" ? fleet.runs.filter((run) => run.workspaceId === here) : fleet.runs;
    const groups = buildPilotGroups(runs, {
      workspaces,
      currentWorkspaceId: here,
      nowMs,
    });
    const cards = new Map((canopy?.cards ?? []).map((card) => [card.runId, card]));
    return buildCanopyInbox(
      groups,
      cards,
      {
        failed: (canopy?.lastError ?? null) !== null,
        failedRuns: new Set(canopy?.failedRuns ?? []),
      },
      new Map((canopy?.dispositions ?? []).map((entry) => [entry.runId, entry])),
      new Map((canopy?.seen ?? []).map((entry) => [entry.runId, entry])),
      nowMs,
      new Map((canopy?.glances ?? []).map((entry) => [entry.runId, entry])),
      new Map((canopy?.reads ?? []).map((entry) => [entry.runId, entry]))
    );
  }, [fleet, workspaces, nowMs, canopy, scope, otherHost]);

  return {
    otherHost,
    everyHost,
    ownHostId,
    hostName,
    remote,
    remotes,
    participants,
    api,
    terminalApi,
    readings,
    canopy,
    fleet,
    projects,
    storedScope,
    setScope,
    scope,
    recoveries,
    nowMs,
    baseItems,
  };
}
