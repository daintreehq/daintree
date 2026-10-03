import type { WebContents } from "electron";
import type { TriageTerminalData, TriageTerminalView } from "../../../shared/types/ipc/triage.js";
import type { TerminalResizeResult } from "../../../shared/types/pty-host.js";
import type { PtyClient } from "../../services/PtyClient.js";
import { CHANNELS } from "../channels.js";

interface Watch {
  watchId: number;
  runId: string;
  /** The incarnation the stream was opened for; input is only ever for it. */
  spawnedAt: number;
  stop: () => void;
}

/** At most one terminal per view: the one its triage panel has selected. */
const watches = new Map<number, Watch>();
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
 * guessing at the boundary. The viewer never resizes the PTY, so it cannot
 * reflow the terminal for the pane that owns it; it follows the PTY's size
 * instead. The stream ends with its terminal: an exit or a host crash closes
 * it, so nothing typed into the view can reach a successor under the same id.
 */
export async function watchTerminal(
  ptyClient: PtyClient,
  sender: WebContents,
  runId: string,
  spawnedAt: number,
  ticket: number
): Promise<TriageTerminalView> {
  stopWatch(sender.id);
  const watchId = ++nextWatchId;
  const send = (payload: TriageTerminalData) => {
    if (sender.isDestroyed()) {
      stopWatch(sender.id);
      return;
    }
    try {
      sender.send(CHANNELS.TRIAGE_TERMINAL_DATA, payload);
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
    if (id !== runId || result.appliedCols === null || result.appliedRows === null) return;
    send({ kind: "resize", watchId, runId, cols: result.appliedCols, rows: result.appliedRows });
  };
  let releaseMirror: (() => void) | undefined;
  const watch: Watch = {
    watchId,
    runId,
    spawnedAt,
    stop: () => {
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
    stopWatch(sender.id);
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

function stopWatch(webContentsId: number): void {
  const watch = watches.get(webContentsId);
  if (!watch) return;
  watches.delete(webContentsId);
  watch.stop();
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
