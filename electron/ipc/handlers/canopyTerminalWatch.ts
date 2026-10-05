import type { WebContents } from "electron";
import type { CanopyTerminalData, CanopyTerminalView } from "../../../shared/types/ipc/canopy.js";
import type { TerminalResizeResult } from "../../../shared/types/pty-host.js";
import type { PtyClient } from "../../services/PtyClient.js";
import { CHANNELS } from "../channels.js";

interface GridSize {
  cols: number;
  rows: number;
}

interface Watch {
  watchId: number;
  runId: string;
  /** The incarnation the stream was opened for; input is only ever for it. */
  spawnedAt: number;
  /**
   * The size the terminal's own pane last gave the PTY: what it goes back to
   * when the panel lets go. Null until the snapshot says what it was.
   */
  ownerSize: GridSize | null;
  /** The size the panel has the PTY at, while it holds it; null when it doesn't. */
  heldSize: GridSize | null;
  /**
   * Holds sent and not yet echoed, oldest first. An echo is the panel's own
   * when it answers one of these — a delayed echo of an earlier hold included —
   * so only a size nobody here asked for is taken as the pane's.
   */
  pendingHolds: GridSize[];
  /** What the PTY last reported holding; a hold is resent until it matches. */
  appliedSize: GridSize | null;
  /** The PTY incarnation the echoes are from; a different one is a respawn. */
  launchGeneration: number | null;
  /** Stop listening; `restore` hands the PTY back to its pane's size first. */
  stop: (restore: boolean) => void;
}

/** At most one terminal per view: the one its canopy panel has selected. */
const watches = new Map<number, Watch>();
/**
 * Which view holds each terminal's size. One at a time: a second window
 * showing the same terminal follows the first's size instead of fighting it,
 * and would otherwise record the first's hold as the size to hand back.
 */
const holders = new Map<string, number>();
const MAX_PENDING_HOLDS = 8;

const sameSize = (a: GridSize | null, b: GridSize | null): boolean =>
  a !== null && b !== null && a.cols === b.cols && a.rows === b.rows;
/**
 * Per view, the newest watch request. A request checks it after each await, so
 * one cancelled or overtaken while it was being validated never starts.
 */
const requests = new Map<number, number>();
let nextWatchId = 0;
let nextRequest = 0;

/** Claim the view's next watch; any request still in flight for it loses. */
export function beginWatchRequest(webContentsId: number): number {
  const ticket = ++nextRequest;
  requests.set(webContentsId, ticket);
  return ticket;
}

export function isCurrentWatchRequest(webContentsId: number, ticket: number): boolean {
  return requests.get(webContentsId) === ticket;
}

/**
 * Stream one terminal's output to one view, starting from a snapshot.
 *
 * The bytes ride the host's Main-process mirror, which reaches any project's
 * terminal, rather than the view's own port, which only carries its project.
 * Chunks flow from the moment the watch starts and carry their stream offsets,
 * so the view drops whatever the snapshot already covers instead of Main
 * guessing at the boundary.
 *
 * While the panel shows a terminal it holds the PTY at the panel's own size
 * (`resizeWatchedTerminal`), so the agent draws for the space it is read in.
 * The size the terminal's own pane gave it is remembered — and kept current if
 * that pane resizes meanwhile — and handed back when the watch ends: another
 * run selected, the panel closed, the view gone. An exit or a host crash ends
 * the stream with nothing to hand back, and nothing typed into the view can
 * reach a successor under the same id.
 */
export async function watchTerminal(
  ptyClient: PtyClient,
  sender: WebContents,
  runId: string,
  spawnedAt: number,
  ticket: number
): Promise<CanopyTerminalView> {
  stopWatch(sender.id);
  const watchId = ++nextWatchId;
  const send = (payload: CanopyTerminalData) => {
    if (sender.isDestroyed()) {
      stopWatch(sender.id);
      return;
    }
    try {
      sender.send(CHANNELS.CANOPY_TERMINAL_DATA, payload);
    } catch {
      // The view went away mid-send; its lifecycle listeners stop the watch.
    }
  };

  let forwardedTo = -1;
  const forward = (id: string, data: string | Uint8Array, ...rest: unknown[]) => {
    if (id !== runId) return;
    // `data` passes routing before the offset; `data-mirror` passes the offset alone.
    const streamEnd = rest.find((value): value is number => typeof value === "number");
    // A port-recovery resend can repeat a chunk the mirror already carried.
    if (streamEnd !== undefined) {
      if (streamEnd <= forwardedTo) return;
      forwardedTo = streamEnd;
    }
    send({
      kind: "data",
      watchId,
      runId,
      data,
      ...(streamEnd === undefined ? {} : { streamEnd }),
    });
  };
  const onResize = (id: string, result: TerminalResizeResult) => {
    if (id !== runId) return;
    if (result.launchGeneration !== null) {
      if (watch.launchGeneration === null) {
        watch.launchGeneration = result.launchGeneration;
      } else if (watch.launchGeneration !== result.launchGeneration) {
        // Respawned under the same id: a different terminal, with nothing of
        // this one's to hand back.
        end();
        return;
      }
    }
    if (result.appliedCols === null || result.appliedRows === null) return;
    const applied = { cols: result.appliedCols, rows: result.appliedRows };
    watch.appliedSize = applied;
    const requested = { cols: result.requestedCols, rows: result.requestedRows };
    const ours = watch.pendingHolds.findIndex((hold) => sameSize(hold, requested));
    if (ours >= 0) {
      watch.pendingHolds.splice(0, ours + 1);
    } else if (result.outcome === "applied" || result.outcome === "unchanged") {
      // A size the panel didn't ask for came from the terminal's own pane: the
      // size it gets back. Not a failed one — that reports the panel's grid.
      watch.ownerSize = applied;
    }
    send({ kind: "resize", watchId, runId, cols: applied.cols, rows: applied.rows });
  };
  let releaseMirror: (() => void) | undefined;
  const watch: Watch = {
    watchId,
    runId,
    spawnedAt,
    ownerSize: null,
    heldSize: null,
    pendingHolds: [],
    appliedSize: null,
    launchGeneration: null,
    stop: (restore) => {
      const held = holders.get(runId) === sender.id;
      if (held) holders.delete(runId);
      if (restore && held && watch.heldSize !== null && watch.ownerSize !== null) {
        const current = watch.appliedSize ?? watch.heldSize;
        if (!sameSize(current, watch.ownerSize)) {
          ptyClient.resize(runId, watch.ownerSize.cols, watch.ownerSize.rows);
        }
      }
      ptyClient.off("data", forward);
      ptyClient.off("data-mirror", forward);
      ptyClient.off("resize-result", onResize);
      ptyClient.off("exit", onExit);
      ptyClient.off("host-crash", end);
      releaseMirror?.();
    },
  };
  function end() {
    if (watches.get(sender.id) !== watch) return;
    send({ kind: "ended", watchId, runId });
    // The terminal is gone: there is no PTY to hand a size back to.
    stopWatch(sender.id, false);
  }
  function onExit(id: string) {
    if (id === runId) end();
  }

  // Registered before anything is wired, so a throw part-way still unwinds.
  watches.set(sender.id, watch);
  try {
    ptyClient.on("data", forward);
    ptyClient.on("data-mirror", forward);
    ptyClient.on("resize-result", onResize);
    ptyClient.on("exit", onExit);
    ptyClient.on("host-crash", end);
    releaseMirror = ptyClient.acquireIpcDataMirror(runId);
  } catch (error) {
    stopWatch(sender.id);
    throw error;
  }

  let snapshot: Awaited<ReturnType<PtyClient["getSerializedStateAsync"]>>;
  try {
    // A full read, not a tail: only a full live read carries the stream offset
    // the view fences the live chunks against.
    snapshot = await ptyClient.getSerializedStateAsync(runId);
  } catch (error) {
    if (watches.get(sender.id) === watch) stopWatch(sender.id);
    throw error;
  }
  if (watches.get(sender.id) !== watch || !isCurrentWatchRequest(sender.id, ticket)) {
    // Overtaken or cancelled while the snapshot was read; the view has moved on.
    if (watches.get(sender.id) === watch) stopWatch(sender.id);
    return { watchId: null, snapshot: null };
  }
  if (snapshot && watch.ownerSize === null) {
    watch.ownerSize = { cols: snapshot.cols, rows: snapshot.rows };
  }
  return {
    watchId,
    snapshot: snapshot
      ? {
          data: snapshot.data,
          cols: snapshot.cols,
          rows: snapshot.rows,
          ...(snapshot.continuation ? { continuation: snapshot.continuation } : {}),
        }
      : null,
  };
}

function stopWatch(webContentsId: number, restore = true): void {
  const watch = watches.get(webContentsId);
  if (!watch) return;
  watches.delete(webContentsId);
  watch.stop(restore);
}

/** Bounds a panel may size a PTY to; anything outside is a measuring error. */
const MIN_COLS = 20;
const MIN_ROWS = 5;
const MAX_COLS = 500;
const MAX_ROWS = 200;

/**
 * Hold the watched terminal's PTY at the panel's size. Only for the stream the
 * view has open, and only once its snapshot has said what size to hand back.
 */
export function resizeWatchedTerminal(
  ptyClient: PtyClient,
  webContentsId: number,
  watchId: number,
  cols: number,
  rows: number
): void {
  if (
    !Number.isInteger(cols) ||
    !Number.isInteger(rows) ||
    cols < MIN_COLS ||
    rows < MIN_ROWS ||
    cols > MAX_COLS ||
    rows > MAX_ROWS
  ) {
    throw new Error("Invalid terminal size");
  }
  const watch = watches.get(webContentsId);
  if (!watch || watch.watchId !== watchId) throw new Error("Terminal stream is not open");
  if (watch.ownerSize === null) return;
  const holder = holders.get(watch.runId);
  if (holder !== undefined && holder !== webContentsId) return;
  const size = { cols, rows };
  // Already the hold, and either on its way or what the PTY reports: nothing
  // to send. A hold the pane has since overridden, or that failed, goes again.
  if (
    sameSize(watch.heldSize, size) &&
    (sameSize(watch.appliedSize, size) || watch.pendingHolds.some((hold) => sameSize(hold, size)))
  ) {
    return;
  }
  watch.heldSize = size;
  watch.pendingHolds.push(size);
  if (watch.pendingHolds.length > MAX_PENDING_HOLDS) watch.pendingHolds.shift();
  holders.set(watch.runId, webContentsId);
  ptyClient.resize(watch.runId, cols, rows);
}

/** End the view's stream and any watch request it still has in flight. */
export function stopTerminalWatch(webContentsId: number): void {
  requests.delete(webContentsId);
  stopWatch(webContentsId);
}

export function stopAllTerminalWatches(): void {
  requests.clear();
  for (const id of [...watches.keys()]) stopWatch(id);
}

/**
 * The run a view may type to through its stream: only while that stream is the
 * one it names and its terminal has not ended.
 */
export function watchedTerminal(
  webContentsId: number,
  watchId: number
): { runId: string; spawnedAt: number } | null {
  const watch = watches.get(webContentsId);
  return watch && watch.watchId === watchId
    ? { runId: watch.runId, spawnedAt: watch.spawnedAt }
    : null;
}

/** Test seam: what each view is watching. */
export function activeTerminalWatches(): ReadonlyMap<number, { runId: string; watchId: number }> {
  return new Map([...watches].map(([id, w]) => [id, { runId: w.runId, watchId: w.watchId }]));
}
