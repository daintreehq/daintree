import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { canopyHostClient } from "@/clients/canopyHostClient";
import { remoteHostsClient } from "@/clients/remoteHostsClient";
import type { BulkTransport } from "@shared/utils/canopyBulkEnable";
import { safeFireAndForget } from "@/utils/safeFireAndForget";
import { clientErrorCode } from "@/utils/clientAppError";
import type { CanopyHostChannel } from "@shared/types/ipc/canopyHost";
import type { CanopySnapshot } from "@shared/types/ipc/canopy";
import type { FleetSnapshot } from "@shared/types/ipc/fleet";
import type { IpcInvokeMap } from "@shared/types/ipc/maps";
import { LOCAL_HOST_ID, type HostId } from "@shared/types/remoteHosts";

type ElectronCanopy = Window["electron"]["canopy"];

/**
 * What the inbox asks of a host's Canopy: the reads and the inbox's own
 * actions, renaming and trashing included, never typing into a run or
 * answering it. The window's own host is
 * `window.electron.canopy` itself; any other goes through `remoteCanopyApi`.
 */
export type CanopyApi = Pick<
  ElectronCanopy,
  | "setScope"
  | "setShown"
  | "setRead"
  | "archive"
  | "unarchive"
  | "markAllRead"
  | "restoreReads"
  | "refresh"
  | "reread"
  | "runBranch"
  | "searchScreens"
  | "setMode"
  | "retryModel"
  | "rename"
  | "trash"
  | "untrash"
  | "restoreTrashed"
  | "removeTrashed"
  | "emptyTrash"
>;

/** The window's own host, looked up at each call as the panel always has. */
export const ownCanopyApi: CanopyApi = {
  setScope: (...args) => window.electron.canopy.setScope(...args),
  setShown: (...args) => window.electron.canopy.setShown(...args),
  setRead: (...args) => window.electron.canopy.setRead(...args),
  archive: (...args) => window.electron.canopy.archive(...args),
  unarchive: (...args) => window.electron.canopy.unarchive(...args),
  markAllRead: (...args) => window.electron.canopy.markAllRead(...args),
  restoreReads: (...args) => window.electron.canopy.restoreReads(...args),
  refresh: (...args) => window.electron.canopy.refresh(...args),
  reread: (...args) => window.electron.canopy.reread(...args),
  runBranch: (...args) => window.electron.canopy.runBranch(...args),
  searchScreens: (...args) => window.electron.canopy.searchScreens(...args),
  setMode: (...args) => window.electron.canopy.setMode(...args),
  retryModel: (...args) => window.electron.canopy.retryModel(...args),
  rename: (...args) => window.electron.canopy.rename(...args),
  trash: (...args) => window.electron.canopy.trash(...args),
  untrash: (...args) => window.electron.canopy.untrash(...args),
  restoreTrashed: (...args) => window.electron.canopy.restoreTrashed(...args),
  removeTrashed: (...args) => window.electron.canopy.removeTrashed(...args),
  emptyTrash: (...args) => window.electron.canopy.emptyTrash(...args),
};

/** The same calls, made on another host's Canopy and on nothing else. */
export function remoteCanopyApi(hostId: HostId): CanopyApi {
  const on =
    <C extends CanopyHostChannel>(channel: C) =>
    (...args: IpcInvokeMap[C]["args"]) =>
      canopyHostClient.invoke(hostId, channel, ...args);
  return {
    setScope: on("canopy:set-scope"),
    setShown: on("canopy:set-shown"),
    setRead: on("canopy:set-read"),
    archive: on("canopy:archive"),
    unarchive: on("canopy:unarchive"),
    markAllRead: on("canopy:mark-all-read"),
    restoreReads: on("canopy:restore-reads"),
    refresh: on("canopy:refresh"),
    reread: on("canopy:reread"),
    runBranch: on("canopy:run-branch"),
    searchScreens: on("canopy:search-screens"),
    setMode: on("canopy:set-mode"),
    retryModel: on("canopy:retry-model"),
    rename: on("canopy:rename"),
    trash: on("canopy:trash"),
    untrash: on("canopy:untrash"),
    restoreTrashed: on("canopy:restore-trashed"),
    removeTrashed: on("canopy:remove-trashed"),
    emptyTrash: on("canopy:empty-trash"),
  };
}

/** How long a bulk run waits on a saved host it had to dial. */
const BULK_CONNECT_MS = 20_000;

/**
 * What a bulk enable asks of one host: its snapshot and its guarded mode
 * change, and the release of the viewer the call opened there. `own` is the
 * window's own host, read through `window.electron.canopy`; `keepOpen` is a
 * host the panel is reading, whose viewer is the panel's to release.
 */
export function canopyBulkTransport(
  hostId: HostId,
  { own, keepOpen }: { own: boolean; keepOpen: () => boolean }
): BulkTransport {
  if (own) {
    return {
      getSnapshot: () => window.electron.canopy.getSnapshot(),
      setMode: (mode, expectRevision, expectHostEpoch) =>
        window.electron.canopy.setMode(mode, expectRevision, expectHostEpoch),
      release: () => {},
    };
  }
  let opened = false;
  return {
    getSnapshot: () => {
      opened = true;
      return canopyHostClient.invoke(hostId, "canopy:get-snapshot");
    },
    setMode: (mode, expectRevision, expectHostEpoch) => {
      opened = true;
      return canopyHostClient.invoke(
        hostId,
        "canopy:set-mode",
        mode,
        expectRevision,
        expectHostEpoch
      );
    },
    ...(hostId === LOCAL_HOST_ID
      ? {}
      : {
          connect: async () =>
            (await remoteHostsClient.connectAndSettle(hostId, { timeoutMs: BULK_CONNECT_MS }))
              .status === "connected",
        }),
    release: () => {
      if (opened && !keepOpen()) void canopyHostClient.release(hostId).catch(() => {});
    },
  };
}

/**
 * What the live pane, its composer and the one-key answers ask of the host the
 * run is on. `holdsSize` is the window's own host alone, whose pane in this
 * view is frozen from here. Another host sizes its terminal only when its
 * watch answer says it will (`CanopyTerminalView.holdsSize`), and freezes its
 * own panes itself.
 */
export interface CanopyTerminalApi {
  holdsSize: boolean;
  /**
   * For an API that routes by run: the local terminal's own id when this run is
   * on the window's own host and so sized from here, otherwise null.
   */
  ownSizedId?: (runId: string) => string | null;
  watchTerminal: ElectronCanopy["watchTerminal"];
  unwatchTerminal: ElectronCanopy["unwatchTerminal"];
  terminalInput: ElectronCanopy["terminalInput"];
  terminalResize: ElectronCanopy["terminalResize"];
  terminalSubmit: ElectronCanopy["terminalSubmit"];
  terminalSendKey: ElectronCanopy["terminalSendKey"];
  answer: ElectronCanopy["answer"];
  onTerminalData: ElectronCanopy["onTerminalData"];
  /** The link to the host came back: what the pane showed was dropped there, so it opens again. */
  onResync: (callback: () => void) => () => void;
}

const NO_RESYNC = () => () => {};

export const ownCanopyTerminalApi: CanopyTerminalApi = {
  holdsSize: true,
  watchTerminal: (...args) => window.electron.canopy.watchTerminal(...args),
  unwatchTerminal: (...args) => window.electron.canopy.unwatchTerminal(...args),
  terminalInput: (...args) => window.electron.canopy.terminalInput(...args),
  terminalResize: (...args) => window.electron.canopy.terminalResize(...args),
  terminalSubmit: (...args) => window.electron.canopy.terminalSubmit(...args),
  terminalSendKey: (...args) => window.electron.canopy.terminalSendKey(...args),
  answer: (...args) => window.electron.canopy.answer(...args),
  onTerminalData: (callback) => window.electron.canopy.onTerminalData(callback),
  onResync: NO_RESYNC,
};

/** The same, on another host's Canopy. */
export function remoteCanopyTerminalApi(hostId: HostId): CanopyTerminalApi {
  const on =
    <C extends CanopyHostChannel>(channel: C) =>
    (...args: IpcInvokeMap[C]["args"]) =>
      canopyHostClient.invoke(hostId, channel, ...args);
  return {
    holdsSize: false,
    watchTerminal: on("canopy:watch-terminal"),
    unwatchTerminal: on("canopy:unwatch-terminal"),
    terminalInput: on("canopy:terminal-input"),
    terminalResize: on("canopy:terminal-resize"),
    terminalSubmit: on("canopy:terminal-submit"),
    terminalSendKey: on("canopy:terminal-send-key"),
    answer: on("canopy:answer"),
    onTerminalData: (callback) =>
      canopyHostClient.onEvent((event) => {
        if (event.hostId === hostId && event.kind === "terminal-data") callback(event.chunk);
      }),
    onResync: (callback) =>
      canopyHostClient.onEvent((event) => {
        if (event.hostId === hostId && event.kind === "resync") callback();
      }),
  };
}

export interface RemoteCanopyState {
  canopy: CanopySnapshot | null;
  fleet: FleetSnapshot | null;
  /**
   * Why the host can't be read right now: its Canopy or its agents couldn't
   * be read. Each clears only once the read that failed lands again.
   */
  error: unknown;
  /**
   * Bumped each time the panel's state on the host has to be said again — the
   * link came back, or the user tried again — so scope and shown rows are re-sent.
   */
  epoch: number;
}

/**
 * The reads' failure, a refused read last: the refusal only says the link is
 * coming up, and must not stand in front of the other read's own failure.
 */
function readError(state: HeldState): unknown {
  const { canopyError, fleetError } = state;
  if (canopyError !== null && clientErrorCode(canopyError) === "HOST_DISCONNECTED") {
    return fleetError ?? canopyError;
  }
  return canopyError ?? fleetError;
}

interface HeldState {
  canopy: CanopySnapshot | null;
  fleet: FleetSnapshot | null;
  canopyError: unknown;
  fleetError: unknown;
  epoch: number;
}

const EMPTY: HeldState = {
  canopy: null,
  fleet: null,
  canopyError: null,
  fleetError: null,
  epoch: 0,
};

interface HostController {
  dispose: () => void;
  reread: () => void;
}

/**
 * One host's Canopy and agents, read through the panel's viewer on it: its
 * panel opened there, its pushes followed, and on a link that comes back, read
 * and said again. Every host has its own sequence fence, rounds and epoch, so
 * one host's answers never land on another's list.
 */
function connectHost(
  hostId: HostId,
  update: (change: (state: HeldState) => HeldState) => void
): HostController {
  let live = true;
  // The newest snapshot applied; a host that came back may count from the start again.
  let lastSequence: number | undefined;
  // Fleet snapshots carry no sequence: a push since a pull began is newer than
  // its answer. Either read's failure, too, is older than a snapshot landed since it began.
  let fleetPushes = 0;
  let canopyLands = 0;
  // Only the latest round of reads speaks: one from before a resync is old news, failures included.
  let round = 0;
  const change = (apply: (state: HeldState) => HeldState) => {
    if (live) update(apply);
  };
  const applyCanopy = (snapshot: CanopySnapshot) => {
    // A pull answered after a newer push is older news.
    const sequence = snapshot.sequence;
    if (lastSequence !== undefined && sequence !== undefined && sequence < lastSequence) return;
    if (sequence !== undefined) lastSequence = sequence;
    canopyLands += 1;
    change((state) => ({ ...state, canopy: snapshot, canopyError: null }));
  };
  const applyFleet = (snapshot: FleetSnapshot | null) =>
    change((state) => ({ ...state, fleet: snapshot, fleetError: null }));
  const read = () => {
    const mine = ++round;
    const pushesBefore = fleetPushes;
    const landsBefore = canopyLands;
    canopyHostClient.invoke(hostId, "canopy:set-active", true).then(
      (snapshot) => {
        if (mine === round) applyCanopy(snapshot);
      },
      (error: unknown) => {
        if (mine === round && canopyLands === landsBefore) {
          change((state) => ({ ...state, canopyError: error }));
        }
      }
    );
    canopyHostClient.invoke(hostId, "fleet:get-snapshot").then(
      (snapshot) => {
        if (mine === round && fleetPushes === pushesBefore) applyFleet(snapshot);
      },
      (error: unknown) => {
        if (mine === round && fleetPushes === pushesBefore) {
          change((state) => ({ ...state, fleetError: error }));
        }
      }
    );
  };
  const sayAgain = () => {
    change((state) => ({ ...state, epoch: state.epoch + 1 }));
    read();
  };
  // Listening before the first read, so nothing pushed in between is missed.
  const off = canopyHostClient.onEvent((event) => {
    if (!live || event.hostId !== hostId) return;
    switch (event.kind) {
      case "canopy-snapshot":
        applyCanopy(event.snapshot);
        return;
      case "fleet-snapshot":
        fleetPushes += 1;
        applyFleet(event.snapshot);
        return;
      case "resync":
        lastSequence = undefined;
        sayAgain();
        return;
      case "terminal-data":
        return;
    }
  });
  read();
  return {
    reread: sayAgain,
    dispose: () => {
      live = false;
      off();
      safeFireAndForget(canopyHostClient.release(hostId));
    },
  };
}

/**
 * Another host's Canopy and agents, read while the panel shows that host.
 * Released the moment the panel stops showing it. A host that isn't connected
 * is dialled by the first read, which fails; the link coming up sends
 * `resync`, and the reads go again.
 */
export function useRemoteCanopy(
  hostId: HostId | null,
  active: boolean
): RemoteCanopyState & { retry: () => void } {
  const [held, setHeld] = useState<{ hostId: HostId; state: HeldState } | null>(null);
  // Reads again on the panel's open viewer: a new one would drop what the host was told.
  const rereadRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!active || hostId === null) return;
    const controller = connectHost(hostId, (change) =>
      setHeld((current) => {
        // Another host's answers never land on this one's list.
        const state = current?.hostId === hostId ? current.state : EMPTY;
        const next = change(state);
        return next === state && current?.hostId === hostId ? current : { hostId, state: next };
      })
    );
    rereadRef.current = controller.reread;
    return () => {
      if (rereadRef.current === controller.reread) rereadRef.current = null;
      controller.dispose();
    };
  }, [hostId, active]);

  const state = hostId !== null && held?.hostId === hostId ? held.state : EMPTY;
  return {
    canopy: state.canopy,
    fleet: state.fleet,
    error: readError(state),
    epoch: state.epoch,
    retry: () => rereadRef.current?.(),
  };
}

/**
 * Several hosts read at once, each through its own viewer and held apart from
 * the rest. A host added to the list is opened and one removed is released
 * without touching the others; every viewer is released when the panel stops
 * being active.
 */
export function useRemoteCanopies(
  hostIds: readonly HostId[],
  active: boolean
): { states: ReadonlyMap<HostId, RemoteCanopyState>; retry: (hostId: HostId) => void } {
  const [held, setHeld] = useState<ReadonlyMap<HostId, HeldState>>(() => new Map());
  const controllers = useRef(new Map<HostId, HostController>());
  const wanted = active ? [...new Set(hostIds)].sort().join("\u0000") : "";

  // A host leaving is released before anything connects to it again — the
  // single-host reader opening the same host in this commit included — since
  // both speak through the one viewer the host has for this panel.
  useLayoutEffect(() => {
    const open = controllers.current;
    const ids = wanted === "" ? [] : wanted.split("\u0000");
    for (const [hostId, controller] of open) {
      if (ids.includes(hostId)) continue;
      open.delete(hostId);
      controller.dispose();
      setHeld((current) => {
        if (!current.has(hostId)) return current;
        const next = new Map(current);
        next.delete(hostId);
        return next;
      });
    }
  }, [wanted]);

  // And a host joining waits for the single-host reader to have let go of it.
  useEffect(() => {
    const open = controllers.current;
    const ids = wanted === "" ? [] : wanted.split("\u0000");
    for (const hostId of ids) {
      if (open.has(hostId)) continue;
      open.set(
        hostId,
        connectHost(hostId, (change) =>
          setHeld((current) => {
            const state = current.get(hostId) ?? EMPTY;
            const next = change(state);
            if (next === state && current.has(hostId)) return current;
            return new Map(current).set(hostId, next);
          })
        )
      );
    }
  }, [wanted]);

  useEffect(
    () => () => {
      for (const controller of controllers.current.values()) controller.dispose();
      controllers.current.clear();
    },
    []
  );

  const states = useMemo(() => {
    const next = new Map<HostId, RemoteCanopyState>();
    for (const [hostId, state] of held) {
      next.set(hostId, {
        canopy: state.canopy,
        fleet: state.fleet,
        error: readError(state),
        epoch: state.epoch,
      });
    }
    return next;
  }, [held]);
  return { states, retry: (hostId) => controllers.current.get(hostId)?.reread() };
}
