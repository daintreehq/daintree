import { useEffect, useRef, useState } from "react";
import { canopyHostClient } from "@/clients/canopyHostClient";
import { safeFireAndForget } from "@/utils/safeFireAndForget";
import type { CanopyHostChannel } from "@shared/types/ipc/canopyHost";
import type { CanopySnapshot } from "@shared/types/ipc/canopy";
import type { FleetSnapshot } from "@shared/types/ipc/fleet";
import type { IpcInvokeMap } from "@shared/types/ipc/maps";
import type { HostId } from "@shared/types/remoteHosts";

type ElectronCanopy = Window["electron"]["canopy"];

/**
 * What the inbox asks of a host's Canopy: the reads and the inbox's own
 * actions, never typing into a run or answering it. The window's own host is
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
  | "setMode"
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
  setMode: (...args) => window.electron.canopy.setMode(...args),
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
    setMode: on("canopy:set-mode"),
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

/**
 * Another host's Canopy and agents, read while the panel shows that host: its
 * panel opened there, its pushes followed, and on a link that comes back,
 * read and said again. Released the moment the panel stops showing it. A
 * host that isn't connected is dialled by the first read, which fails; the
 * link coming up sends `resync`, and the reads go again.
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
    let live = true;
    const update = (change: (state: HeldState) => HeldState) =>
      setHeld((current) => {
        if (!live) return current;
        // Another host's answers never land on this one's list.
        const state = current?.hostId === hostId ? current.state : EMPTY;
        const next = change(state);
        return next === state && current?.hostId === hostId ? current : { hostId, state: next };
      });
    // The newest snapshot applied; a host that came back may count from the start again.
    let lastSequence: number | undefined;
    // Fleet snapshots carry no sequence: a push since a pull began is newer than its answer.
    let fleetPushes = 0;
    // Only the latest round of reads speaks: one from before a resync is old news, failures included.
    let round = 0;
    const applyCanopy = (snapshot: CanopySnapshot) => {
      // A pull answered after a newer push is older news.
      const sequence = snapshot.sequence;
      if (lastSequence !== undefined && sequence !== undefined && sequence < lastSequence) return;
      if (sequence !== undefined) lastSequence = sequence;
      update((state) => ({ ...state, canopy: snapshot, canopyError: null }));
    };
    const applyFleet = (snapshot: FleetSnapshot | null) =>
      update((state) => ({ ...state, fleet: snapshot, fleetError: null }));
    const read = () => {
      const mine = ++round;
      const pushesBefore = fleetPushes;
      canopyHostClient.invoke(hostId, "canopy:set-active", true).then(
        (snapshot) => {
          if (mine === round) applyCanopy(snapshot);
        },
        (error: unknown) => {
          if (mine === round) update((state) => ({ ...state, canopyError: error }));
        }
      );
      canopyHostClient.invoke(hostId, "fleet:get-snapshot").then(
        (snapshot) => {
          if (mine === round && fleetPushes === pushesBefore) applyFleet(snapshot);
        },
        (error: unknown) => {
          if (mine === round) update((state) => ({ ...state, fleetError: error }));
        }
      );
    };
    const sayAgain = () => {
      update((state) => ({ ...state, epoch: state.epoch + 1 }));
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
    rereadRef.current = sayAgain;
    read();
    return () => {
      live = false;
      if (rereadRef.current === sayAgain) rereadRef.current = null;
      off();
      safeFireAndForget(canopyHostClient.release(hostId));
    };
  }, [hostId, active]);

  const state = hostId !== null && held?.hostId === hostId ? held.state : EMPTY;
  return {
    canopy: state.canopy,
    fleet: state.fleet,
    error: state.canopyError ?? state.fleetError,
    epoch: state.epoch,
    retry: () => rereadRef.current?.(),
  };
}
