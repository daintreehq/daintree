import { canopyHostClient } from "@/clients/canopyHostClient";
import {
  ownCanopyApi,
  ownCanopyTerminalApi,
  remoteCanopyApi,
  remoteCanopyTerminalApi,
  type CanopyApi,
  type CanopyTerminalApi,
} from "./canopyHostSource";
import {
  readsWithHostedService,
  type CanopyReadMark,
  type CanopyScreenSearchTarget,
  type CanopySnapshot,
  type CanopyTerminalData,
  type CanopyTerminalView,
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
  // A host still on the hosted service counts as off here: none of its readings
  // are shown, in its cards or in the refinements its fleet rows carry.
  const outdatedHosts = new Set(
    readings
      .filter((reading) => reading.canopy !== null && readsWithHostedService(reading.canopy))
      .map((reading) => reading.hostId)
  );
  const loadedCanopies = readings
    .filter((reading) => reading.canopy !== null)
    .map((reading) =>
      readsWithHostedService(reading.canopy!)
        ? { ...reading, canopy: { ...reading.canopy!, activated: false } }
        : reading
    );
  const fleet: FleetSnapshot | null =
    loadedFleets.length === 0
      ? null
      : {
          runs: loadedFleets.flatMap(({ hostId, fleet: snapshot }) =>
            snapshot!.runs.map(({ canopy: refinement, ...rest }) => ({
              ...rest,
              ...(refinement !== undefined && !outdatedHosts.has(hostId)
                ? { canopy: refinement }
                : {}),
              runId: allHostsKey(hostId, rest.runId),
              workspaceId: allHostsKey(hostId, rest.workspaceId),
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
  for (const { hostId, canopy } of loadedCanopies) {
    if (outdatedHosts.has(hostId)) continue;
    for (const runId of canopy!.failedRuns) failedRuns.push(allHostsKey(hostId, runId));
  }
  const refreshed = loadedCanopies.flatMap(({ canopy }) =>
    canopy!.refreshedAt === null ? [] : [canopy!.refreshedAt]
  );
  const canopy: CanopySnapshot = {
    mode: "on",
    activated: true,
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
  alive: () => boolean,
  run: (item: T) => Promise<R>
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      // Work still queued when the panel closed must not open a host's viewer again.
      if (!alive()) {
        results[index] = { status: "rejected", reason: new Error("The panel closed.") };
        continue;
      }
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

/**
 * What the hosts that answered said. When none did, the failure is the
 * answer: a write every host refused is not a write that was made.
 */
function answered<R>(settled: readonly PromiseSettledResult<R>[]): R[] {
  const values = settled.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
  const refused = settled.find((result) => result.status === "rejected");
  if (refused && values.length === 0) throw refused.reason;
  return values;
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
  /** The panel closed: searches and bulk calls still queued do not start. */
  close: () => void;
  open: () => void;
}

/**
 * The calls the inbox makes, sent to the host each run is on and to no other:
 * a key says whose run it is, and a write goes with the incarnation the panel
 * showed. The scope turns nothing on — `setMode` is refused — and sizes only
 * this machine's terminals.
 */
export function createAllHostsRoute(ownHostId: HostId, hostIds: readonly HostId[]): AllHostsRoute {
  const apiFor = (hostId: HostId): CanopyApi =>
    hostId === ownHostId ? ownCanopyApi : remoteCanopyApi(hostId);
  const terminalFor = (hostId: HostId): CanopyTerminalApi =>
    hostId === ownHostId ? ownCanopyTerminalApi : remoteCanopyTerminalApi(hostId);
  const known = new Set(hostIds);
  const unknownRun = () => Promise.reject(new Error("That run isn't on a host shown here."));

  const routed = <R>(
    key: string,
    call: (host: CanopyApi, id: string, hostId: HostId) => Promise<R>
  ): Promise<R> => {
    const parsed = parseAllHostsKey(key);
    if (!parsed || !known.has(parsed.hostId)) return unknownRun();
    return call(apiFor(parsed.hostId), parsed.id, parsed.hostId);
  };
  // A mark comes back named as the host knows it: the inbox holds it by key.
  const marked = (hostId: HostId, mark: CanopyReadMark | null) =>
    mark ? keyed(hostId, mark) : null;

  let closed = false;
  let session = 0;
  const aliveNow = () => {
    const mine = session;
    return () => !closed && mine === session;
  };

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
    setRead: (key, ...rest) =>
      routed(key, (host, id, hostId) => host.setRead(id, ...rest).then((m) => marked(hostId, m))),
    archive: (key, ...rest) =>
      routed(key, (host, id, hostId) => host.archive(id, ...rest).then((m) => marked(hostId, m))),
    unarchive: (key, ...rest) => routed(key, (host, id) => host.unarchive(id, ...rest)),
    reread: (key, ...rest) => routed(key, (host, id) => host.reread(id, ...rest)),
    runBranch: (key, ...rest) => routed(key, (host, id) => host.runBranch(id, ...rest)),
    rename: (key, ...rest) => routed(key, (host, id) => host.rename(id, ...rest)),
    markAllRead: async (targets) => {
      const groups = groupByHost(targets, (target) => target.runId);
      const settled = await mapLimited(
        [...groups],
        SEARCH_CONCURRENCY,
        aliveNow(),
        ([hostId, group]) =>
          apiFor(hostId)
            .markAllRead(group.map(({ item, id }) => ({ ...item, runId: id })))
            .then((marks) => marks.map((mark): CanopyReadMark => keyed(hostId, mark)))
      );
      return answered(settled).flat();
    },
    restoreReads: async (restores) => {
      const groups = groupByHost(restores, (restore) => restore.mark.runId);
      answered(
        await Promise.allSettled(
          [...groups].map(([hostId, group]) =>
            apiFor(hostId).restoreReads(
              group.map(({ item, id }) => ({ ...item, mark: { ...item.mark, runId: id } }))
            )
          )
        )
      );
    },
    refresh: async () => {
      answered(await Promise.allSettled(hostIds.map((hostId) => apiFor(hostId).refresh())));
    },
    // Each host's own download, tried again wherever it failed; the rest ignore it.
    retryModel: async () => {
      const settled = await Promise.allSettled(
        hostIds.map((hostId) => apiFor(hostId).retryModel())
      );
      const first = settled.find(
        (r): r is PromiseFulfilledResult<CanopySnapshot> => r.status === "fulfilled"
      );
      if (!first) throw new Error("No host answered");
      return first.value;
    },
    searchScreens: async (targets: CanopyScreenSearchTarget[]) => {
      const groups = groupByHost(targets, (target) => target.runId);
      const settled = await mapLimited(
        [...groups],
        SEARCH_CONCURRENCY,
        aliveNow(),
        ([hostId, group]) =>
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
  // Each opening or release is a generation: an answer from an older one is
  // not the stream the panel wants any more.
  let generation = 0;
  let wantedHost: HostId | null = null;
  const opening = new Map<HostId, number>();
  // Output a host sent between taking the watch and its answer reaching us.
  const early: Array<{ hostId: HostId; chunk: CanopyTerminalData }> = [];
  const EARLY_LIMIT = 4096;
  // Hosts whose early output outgrew the buffer: the stream has a gap only a new snapshot closes.
  const overflowed = new Set<HostId>();
  const resyncListeners = new Set<() => void>();
  const forgetEarly = (hostId?: HostId) => {
    for (let i = early.length - 1; i >= 0; i -= 1) {
      if (hostId === undefined || early[i]!.hostId === hostId) early.splice(i, 1);
    }
  };
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

  const listeners = new Set<(chunk: CanopyTerminalData) => void>();
  const emit = (mine: number, key: string, chunk: CanopyTerminalData) => {
    for (const listener of listeners) listener({ ...chunk, watchId: mine, runId: key });
  };
  const forward = (hostId: HostId) => (chunk: CanopyTerminalData) => {
    for (const [mine, watch] of watches) {
      if (watch.hostId === hostId && watch.raw === chunk.watchId) {
        emit(mine, watch.key, chunk);
        return;
      }
    }
    if (!opening.has(hostId)) return;
    early.push({ hostId, chunk });
    if (early.length > EARLY_LIMIT) {
      early.shift();
      overflowed.add(hostId);
    }
  };
  let stopForwarding: (() => void) | null = null;

  const terminalApi: CanopyTerminalApi = {
    holdsSize: false,
    ownSizedId: (key) => {
      const parsed = parseAllHostsKey(key);
      return parsed && parsed.hostId === ownHostId && known.has(ownHostId) ? parsed.id : null;
    },
    watchTerminal: async (key, target): Promise<CanopyTerminalView> => {
      const parsed = parseAllHostsKey(key);
      if (!parsed || !known.has(parsed.hostId)) return unknownRun();
      const mineGeneration = ++generation;
      wantedHost = parsed.hostId;
      dropWatches(parsed.hostId);
      // The host replaces its own watch, and may number the next like the last.
      for (const [id, watch] of watches) if (watch.hostId === parsed.hostId) watches.delete(id);
      forgetEarly(parsed.hostId);
      overflowed.delete(parsed.hostId);
      opening.set(parsed.hostId, (opening.get(parsed.hostId) ?? 0) + 1);
      let view: CanopyTerminalView;
      try {
        view = await terminalFor(parsed.hostId).watchTerminal(parsed.id, target);
      } finally {
        const left = (opening.get(parsed.hostId) ?? 1) - 1;
        if (left > 0) opening.set(parsed.hostId, left);
        else opening.delete(parsed.hostId);
      }
      if (mineGeneration !== generation) {
        // Overtaken while the host answered: nothing may keep streaming for it.
        if (!opening.has(parsed.hostId)) forgetEarly(parsed.hostId);
        // A release already sent for this stream stands; only another host's choice leaves it open.
        if (wantedHost !== null && wantedHost !== parsed.hostId) {
          void terminalFor(parsed.hostId)
            .unwatchTerminal()
            .catch(() => {});
        }
        return { watchId: null, snapshot: null };
      }
      if (view.watchId === null) return view;
      const mine = ++watchSeq;
      watches.set(mine, { hostId: parsed.hostId, raw: view.watchId, key });
      const rawId = view.watchId;
      for (let i = 0; i < early.length;) {
        const held = early[i]!;
        if (held.hostId === parsed.hostId && held.chunk.watchId === rawId) {
          early.splice(i, 1);
          emit(mine, key, held.chunk);
        } else {
          i += 1;
        }
      }
      if (overflowed.delete(parsed.hostId)) {
        // Output was lost before the answer: open again for a snapshot that has it.
        queueMicrotask(() => resyncListeners.forEach((listener) => listener()));
      }
      return { ...view, watchId: mine };
    },
    unwatchTerminal: async (mine?: number) => {
      // One pane's own stream: anything opened or opening since stays.
      if (mine !== undefined) {
        const watch = watches.get(mine);
        if (!watch) return;
        watches.delete(mine);
        await terminalFor(watch.hostId)
          .unwatchTerminal(watch.raw)
          .catch(() => {});
        return;
      }
      generation += 1;
      wantedHost = null;
      const hosts = new Set([...watches.values()].map((watch) => watch.hostId));
      for (const hostId of opening.keys()) hosts.add(hostId);
      watches.clear();
      forgetEarly();
      await Promise.allSettled([...hosts].map((hostId) => terminalFor(hostId).unwatchTerminal()));
    },
    terminalInput: (mine, data) => {
      const watch = watchOf(mine);
      return watch ? terminalFor(watch.hostId).terminalInput(watch.raw, data) : Promise.resolve();
    },
    terminalResize: (mine, cols, rows) => {
      const watch = watchOf(mine);
      // Another host's terminal keeps the size its own window gave it.
      return watch && watch.hostId === ownHostId
        ? ownCanopyTerminalApi.terminalResize(watch.raw, cols, rows)
        : Promise.resolve();
    },
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
      listeners.add(callback);
      if (stopForwarding === null) {
        const offs = hostIds.map((hostId) => terminalFor(hostId).onTerminalData(forward(hostId)));
        stopForwarding = () => offs.forEach((off) => off());
      }
      return () => {
        listeners.delete(callback);
        if (listeners.size === 0) {
          stopForwarding?.();
          stopForwarding = null;
        }
      };
    },
    onResync: (callback) => {
      resyncListeners.add(callback);
      const offs = hostIds
        .filter((hostId) => hostId !== ownHostId)
        .map((hostId) =>
          canopyHostClient.onEvent((event) => {
            if (event.hostId !== hostId || event.kind !== "resync") return;
            const streaming = [...watches.values()].some((watch) => watch.hostId === hostId);
            if (streaming || opening.has(hostId)) callback();
          })
        );
      return () => {
        resyncListeners.delete(callback);
        offs.forEach((off) => off());
      };
    },
  };
  return {
    api,
    terminalApi,
    close: () => {
      closed = true;
      session += 1;
    },
    open: () => {
      closed = false;
    },
  };
}
