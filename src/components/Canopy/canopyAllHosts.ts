import { canopyHostClient } from "@/clients/canopyHostClient";
import {
  ownCanopyApi,
  ownCanopyTerminalApi,
  remoteCanopyApi,
  remoteCanopyTerminalApi,
  type CanopyApi,
  type CanopyTerminalApi,
} from "./canopyHostSource";
import type {
  CanopyReadMark,
  CanopyScreenSearchTarget,
  CanopySnapshot,
  CanopyTerminalData,
  CanopyTerminalView,
} from "@shared/types/ipc/canopy";
import type { FleetSnapshot } from "@shared/types/ipc/fleet";
import type { HostId } from "@shared/types/remoteHosts";

/**
 * The All hosts panel shows one list built from every host's own snapshot, so
 * a run is named by its host and its id there: ids are only unique on the host
 * that made them. The length prefix keeps the key readable back whatever the
 * host id holds.
 */
export function allHostsKey(hostId: HostId, id: string): string {
  return `${hostId.length}.${hostId}.${id}`;
}

export function parseAllHostsKey(key: string): { hostId: HostId; id: string } | null {
  const dot = key.indexOf(".");
  const length = Number(key.slice(0, dot));
  if (dot < 1 || !Number.isInteger(length)) return null;
  const hostEnd = dot + 1 + length;
  if (key[hostEnd] !== "." || key.length < hostEnd + 1) return null;
  return { hostId: key.slice(dot + 1, hostEnd), id: key.slice(hostEnd + 1) };
}

/** What one host says right now, kept apart from every other host's. */
export interface HostReading {
  hostId: HostId;
  canopy: CanopySnapshot | null;
  fleet: FleetSnapshot | null;
  error: unknown;
}

function keyed<T extends { runId: string }>(hostId: HostId, item: T): T {
  return { ...item, runId: allHostsKey(hostId, item.runId) };
}

/**
 * The hosts' readings as the one snapshot pair the inbox is built from. Only
 * derived: every host's own snapshot stays as it arrived, and a host that is
 * off, still connecting or unreachable adds only what it has said.
 */
export function mergeHostReadings(readings: readonly HostReading[]): {
  canopy: CanopySnapshot | null;
  fleet: FleetSnapshot | null;
} {
  const loadedFleets = readings.filter((reading) => reading.fleet !== null);
  const loadedCanopies = readings.filter((reading) => reading.canopy !== null);
  const fleet: FleetSnapshot | null =
    loadedFleets.length === 0
      ? null
      : {
          runs: loadedFleets.flatMap(({ hostId, fleet: snapshot }) =>
            snapshot!.runs.map((run) => ({
              ...run,
              runId: allHostsKey(hostId, run.runId),
              workspaceId: allHostsKey(hostId, run.workspaceId),
            }))
          ),
          changedAt: Math.max(...loadedFleets.map(({ fleet: snapshot }) => snapshot!.changedAt)),
          degraded: loadedFleets.some(({ fleet: snapshot }) => snapshot!.degraded),
          lastSuccessfulAt: loadedFleets.some(({ fleet: snapshot }) => !snapshot!.lastSuccessfulAt)
            ? null
            : Math.min(...loadedFleets.map(({ fleet: snapshot }) => snapshot!.lastSuccessfulAt!)),
        };
  if (loadedCanopies.length === 0) return { canopy: null, fleet };

  // Only a host that is on has screens read; it is the one the open waits for.
  const reading = loadedCanopies.filter(({ canopy }) => canopy!.activated);
  const failedRuns: string[] = [];
  for (const { hostId, canopy, fleet: hostFleet } of loadedCanopies) {
    for (const runId of canopy!.failedRuns) failedRuns.push(allHostsKey(hostId, runId));
    // A provider failure on a host marks the runs it would have read.
    if (canopy!.lastError !== null) {
      for (const run of hostFleet?.runs ?? []) failedRuns.push(allHostsKey(hostId, run.runId));
    }
  }
  const refreshed = loadedCanopies.flatMap(({ canopy }) =>
    canopy!.refreshedAt === null ? [] : [canopy!.refreshedAt]
  );
  const canopy: CanopySnapshot = {
    mode: "on",
    activated: true,
    tier: loadedCanopies[0]!.canopy!.tier,
    dispositions: loadedCanopies.flatMap(({ hostId, canopy: c }) =>
      c!.dispositions.map((item) => keyed(hostId, item))
    ),
    seen: loadedCanopies.flatMap(({ hostId, canopy: c }) =>
      c!.seen.map((item) => keyed(hostId, item))
    ),
    reads: loadedCanopies.flatMap(({ hostId, canopy: c }) =>
      c!.reads.map((item) => keyed(hostId, item))
    ),
    scope: null,
    active: reading.every(({ canopy: c }) => c!.active),
    busy: reading.some(({ canopy: c }) => c!.busy),
    // Hosts' clocks and scans are their own: any host scanning anew moves the sum.
    refreshedAt: refreshed.length === 0 ? null : refreshed.reduce((sum, at) => sum + at, 0),
    cards: loadedCanopies.flatMap(({ hostId, canopy: c }) =>
      c!.activated ? c!.cards.map((card) => keyed(hostId, card)) : []
    ),
    glances: loadedCanopies.flatMap(({ hostId, canopy: c }) =>
      c!.activated ? c!.glances.map((item) => keyed(hostId, item)) : []
    ),
    lastError: null,
    failedRuns,
    wordsDue: loadedCanopies.flatMap(({ hostId, canopy: c }) =>
      (c!.wordsDue ?? []).map((runId) => allHostsKey(hostId, runId))
    ),
  };
  return { canopy, fleet };
}

/** The hosts whose Canopy is known to be off: they add no screen readings. */
export function hostsWithCanopyOff(readings: readonly HostReading[]): HostId[] {
  return readings
    .filter((reading) => reading.canopy !== null && !reading.canopy.activated)
    .map((reading) => reading.hostId);
}

/** Screen searches running at once across hosts: each host's terminals are read on its own machine. */
export const SEARCH_CONCURRENCY = 3;

async function mapLimited<T, R>(
  items: readonly T[],
  limit: number,
  run: (item: T) => Promise<R>
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      try {
        results[index] = { status: "fulfilled", value: await run(items[index]!) };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function groupByHost<T>(items: readonly T[], keyOf: (item: T) => string) {
  const groups = new Map<HostId, Array<{ item: T; id: string }>>();
  for (const item of items) {
    const parsed = parseAllHostsKey(keyOf(item));
    if (!parsed) continue;
    const group = groups.get(parsed.hostId);
    if (group) group.push({ item, id: parsed.id });
    else groups.set(parsed.hostId, [{ item, id: parsed.id }]);
  }
  return groups;
}

export interface AllHostsRoute {
  api: CanopyApi;
  terminalApi: CanopyTerminalApi;
}

/**
 * The calls the inbox makes, sent to the host each run is on and to no other:
 * a key says whose run it is, and a write goes with the incarnation the panel
 * showed. The scope turns nothing on — `setMode` is refused — and sizes no
 * terminal.
 */
export function createAllHostsRoute(ownHostId: HostId, hostIds: readonly HostId[]): AllHostsRoute {
  const apiFor = (hostId: HostId): CanopyApi =>
    hostId === ownHostId ? ownCanopyApi : remoteCanopyApi(hostId);
  const terminalFor = (hostId: HostId): CanopyTerminalApi =>
    hostId === ownHostId ? ownCanopyTerminalApi : remoteCanopyTerminalApi(hostId);
  const known = new Set(hostIds);
  const unknownRun = () => Promise.reject(new Error("That run isn't on a host shown here."));

  const onRun = <K extends "setRead" | "archive" | "unarchive" | "reread" | "runBranch" | "rename">(
    method: K
  ): CanopyApi[K] =>
    ((key: string, ...rest: unknown[]) => {
      const parsed = parseAllHostsKey(key);
      if (!parsed || !known.has(parsed.hostId)) return unknownRun();
      const call = apiFor(parsed.hostId)[method] as (...args: unknown[]) => Promise<unknown>;
      return call(parsed.id, ...rest);
    }) as CanopyApi[K];

  let receipt = 0;
  const trashed = new Map<number, { hostId: HostId; receipt: number }>();

  const api: CanopyApi = {
    // Every host reads all of its projects here.
    setScope: async () => {
      await Promise.allSettled(hostIds.map((hostId) => apiFor(hostId).setScope(null)));
    },
    setShown: async (runIds) => {
      const groups = groupByHost(runIds, (key) => key);
      await Promise.allSettled(
        hostIds.map((hostId) =>
          apiFor(hostId).setShown((groups.get(hostId) ?? []).map(({ id }) => id))
        )
      );
    },
    setRead: onRun("setRead"),
    archive: onRun("archive"),
    unarchive: onRun("unarchive"),
    reread: onRun("reread"),
    runBranch: onRun("runBranch"),
    rename: onRun("rename"),
    markAllRead: async (targets) => {
      const groups = groupByHost(targets, (target) => target.runId);
      const settled = await mapLimited([...groups], SEARCH_CONCURRENCY, ([hostId, group]) =>
        apiFor(hostId)
          .markAllRead(group.map(({ item, id }) => ({ ...item, runId: id })))
          .then((marks) => marks.map((mark): CanopyReadMark => keyed(hostId, mark)))
      );
      return settled.flatMap((result) => (result.status === "fulfilled" ? result.value : []));
    },
    restoreReads: async (restores) => {
      const groups = groupByHost(restores, (restore) => restore.mark.runId);
      await Promise.allSettled(
        [...groups].map(([hostId, group]) =>
          apiFor(hostId).restoreReads(
            group.map(({ item, id }) => ({ ...item, mark: { ...item.mark, runId: id } }))
          )
        )
      );
    },
    refresh: async () => {
      await Promise.allSettled(hostIds.map((hostId) => apiFor(hostId).refresh()));
    },
    searchScreens: async (targets: CanopyScreenSearchTarget[]) => {
      const groups = groupByHost(targets, (target) => target.runId);
      const settled = await mapLimited([...groups], SEARCH_CONCURRENCY, ([hostId, group]) =>
        apiFor(hostId)
          .searchScreens(group.map(({ item, id }) => ({ ...item, runId: id })))
          .then((ids) => ids.map((id) => allHostsKey(hostId, id)))
      );
      // A host that can't search still matches what the panel holds of it.
      return settled.flatMap((result) => (result.status === "fulfilled" ? result.value : []));
    },
    setMode: () => Promise.reject(new Error("Canopy is turned on one host at a time.")),
    trash: async (key, target) => {
      const parsed = parseAllHostsKey(key);
      if (!parsed || !known.has(parsed.hostId)) return unknownRun();
      const hostReceipt = await apiFor(parsed.hostId).trash(parsed.id, target);
      if (hostReceipt === null) return null;
      const mine = ++receipt;
      trashed.set(mine, { hostId: parsed.hostId, receipt: hostReceipt });
      return mine;
    },
    untrash: async (mine) => {
      const entry = trashed.get(mine);
      if (!entry) return unknownRun();
      trashed.delete(mine);
      await apiFor(entry.hostId).untrash(entry.receipt);
    },
  };

  // One stream at a time: the selected row's. Its id is made here, since two
  // hosts number their watches alike.
  let watchSeq = 0;
  const watches = new Map<number, { hostId: HostId; raw: number; key: string }>();
  const dropWatches = (except?: HostId) => {
    for (const [mine, watch] of watches) {
      if (watch.hostId === except) continue;
      watches.delete(mine);
      void terminalFor(watch.hostId)
        .unwatchTerminal()
        .catch(() => {});
    }
  };
  const watchOf = (mine: number) => watches.get(mine);

  const terminalApi: CanopyTerminalApi = {
    holdsSize: false,
    watchTerminal: async (key, target): Promise<CanopyTerminalView> => {
      const parsed = parseAllHostsKey(key);
      if (!parsed || !known.has(parsed.hostId)) return unknownRun();
      dropWatches(parsed.hostId);
      // The host replaces its own watch, and may number the next like the last.
      for (const [id, watch] of watches) if (watch.hostId === parsed.hostId) watches.delete(id);
      const view = await terminalFor(parsed.hostId).watchTerminal(parsed.id, target);
      if (view.watchId === null) return view;
      const mine = ++watchSeq;
      watches.set(mine, { hostId: parsed.hostId, raw: view.watchId, key });
      return { ...view, watchId: mine };
    },
    unwatchTerminal: async () => {
      const hosts = new Set([...watches.values()].map((watch) => watch.hostId));
      watches.clear();
      await Promise.allSettled([...hosts].map((hostId) => terminalFor(hostId).unwatchTerminal()));
    },
    terminalInput: (mine, data) => {
      const watch = watchOf(mine);
      return watch ? terminalFor(watch.hostId).terminalInput(watch.raw, data) : Promise.resolve();
    },
    terminalResize: () => Promise.resolve(),
    terminalSubmit: (mine, text, imagePaths) => {
      const watch = watchOf(mine);
      return watch
        ? terminalFor(watch.hostId).terminalSubmit(watch.raw, text, imagePaths)
        : Promise.resolve();
    },
    terminalSendKey: (mine, key) => {
      const watch = watchOf(mine);
      return watch ? terminalFor(watch.hostId).terminalSendKey(watch.raw, key) : Promise.resolve();
    },
    answer: (key, target, label) => {
      const parsed = parseAllHostsKey(key);
      if (!parsed || !known.has(parsed.hostId)) return unknownRun();
      return terminalFor(parsed.hostId).answer(parsed.id, target, label);
    },
    onTerminalData: (callback) => {
      const forward = (hostId: HostId) => (chunk: CanopyTerminalData) => {
        for (const [mine, watch] of watches) {
          if (watch.hostId === hostId && watch.raw === chunk.watchId) {
            callback({ ...chunk, watchId: mine, runId: watch.key });
            return;
          }
        }
      };
      const offs = hostIds.map((hostId) => terminalFor(hostId).onTerminalData(forward(hostId)));
      return () => offs.forEach((off) => off());
    },
    onResync: (callback) => {
      const offs = hostIds
        .filter((hostId) => hostId !== ownHostId)
        .map((hostId) =>
          canopyHostClient.onEvent((event) => {
            if (event.hostId !== hostId || event.kind !== "resync") return;
            if ([...watches.values()].some((watch) => watch.hostId === hostId)) callback();
          })
        );
      return () => offs.forEach((off) => off());
    },
  };
  return { api, terminalApi };
}
