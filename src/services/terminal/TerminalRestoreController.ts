import { terminalClient } from "@/clients";
import type { ManagedTerminal } from "./types";
import { INCREMENTAL_RESTORE_CONFIG } from "./types";
import { logWarn, logError } from "@/utils/logger";
import type { TerminalScrollbackRestoreError } from "@shared/types/panel";
import type { SnapshotContinuation, TerminalGeometry } from "@shared/types/terminal";
import { isUsableTerminalGeometry } from "@shared/types/terminal";
import { PARSER_GROUND } from "@shared/utils/terminalPartialEscapeTail";
import type { StreamRange } from "./streamFence";

function classifyRestoreError(error: unknown): TerminalScrollbackRestoreError {
  const timestamp = Date.now();
  if (error instanceof Error) {
    if (error.message === "Write timeout") {
      return { type: "timeout", message: error.message, timestamp };
    }
    // xterm.js parser throws plain Error with messages starting with "Parser"
    // or containing "parse"; fall through to generic "error" otherwise. Keep
    // the message verbatim so the banner shows the underlying cause.
    if (/pars/i.test(error.message)) {
      return { type: "parse", message: error.message, timestamp };
    }
    return { type: "error", message: error.message, timestamp };
  }
  return { type: "error", message: String(error), timestamp };
}

// Read through a function so the checks after an await aren't narrowed by the
// entry guard: both fields change while the snapshot fetch is in flight.
function hasBeenFed(managed: ManagedTerminal): boolean {
  return managed.hasReceivedOutput === true || managed.deferredOutput.length > 0;
}

export type MissingOutputRecoveryOutcome =
  "recovered" | "no-host-output" | "live-output" | "stale" | "failed";

export interface RestoreControllerDeps {
  getInstance: (id: string) => ManagedTerminal | undefined;
  // chunkCount travels with each replayed deferred batch: the batch's pending
  // port-ack FIFO entries were deliberately NOT settled at defer time, so the
  // replay write must settle exactly them (see TerminalWriteController).
  writeData: (
    id: string,
    data: string | Uint8Array,
    chunkCount: number,
    range?: StreamRange
  ) => void;
}

// Slice a chunk without splitting a UTF-16 surrogate pair. xterm 6's parser
// already buffers partial ANSI/UTF-8 state across writes, so the only
// boundary we must protect is the JS string surrogate pair.
export function safeChunkSlice(serializedState: string, offset: number, chunkSize: number): string {
  const total = serializedState.length;
  let end = Math.min(offset + chunkSize, total);
  if (end < total) {
    const lastCode = serializedState.charCodeAt(end - 1);
    if (lastCode >= 0xd800 && lastCode <= 0xdbff) {
      end -= 1;
    }
  }
  if (end <= offset) {
    end = Math.min(offset + 1, total);
  }
  return serializedState.substring(offset, end);
}

export class TerminalRestoreController {
  private deps: RestoreControllerDeps;

  constructor(deps: RestoreControllerDeps) {
    this.deps = deps;
  }

  /**
   * Open the restore window, remembering the grid this pane must end up on.
   *
   * Only the OUTERMOST restore seeds the target: once a replay has parked xterm
   * at a snapshot's capture width, `terminal.cols` describes the payload being
   * written, not the pane, so a nested or superseding restore that sampled it
   * would normalize to the wrong grid. Resizes that land mid-window overwrite
   * this instead of touching xterm (see
   * `TerminalResizeController.resizeTerminal`), so it always holds the newest
   * intended geometry (#11552).
   */
  private beginRestoreWindow(managed: ManagedTerminal): number {
    if (!managed.isSerializedRestoreInProgress) {
      managed.pendingRestoreGeometry = this.intendedGeometry(managed);
    }
    managed.isSerializedRestoreInProgress = true;
    return ++managed.restoreWindowToken;
  }

  /**
   * The grid this pane must end up on, or `undefined` when nothing here knows.
   *
   * `terminal.cols/rows` is evidence of the pane's real grid only once xterm has
   * been opened against a measured host. A pane that has never been opened is
   * still on whatever it was CONSTRUCTED at — xterm's 80×24 default for anything
   * the persisted size didn't reach — and seeding that made `endRestoreWindow`
   * snap a correctly-aligned replay back onto it, leaving a still-live pane
   * parsing a ~200-column agent into 80 columns until the user finally selected
   * its worktree (#11718).
   *
   * So a parked pane seeds from its attach target: the persisted grid, which is
   * where the surviving PTY already is. With no valid target we return nothing
   * rather than guess, which makes `endRestoreWindow` skip its corrective resize
   * and leave the pane on the capture grid `alignToCaptureGeometry` just put it
   * on — the grid the mirror and PTY were last agreed on, and the best evidence
   * left. Deliberately expressed as an absent target rather than as the capture
   * geometry: `fetchAndRestore` opens its window BEFORE the snapshot exists, so
   * a seed computed here could never have seen it, and the nested restore cannot
   * reseed an open window.
   *
   * Only the SEED changes. A resize landing mid-window still overwrites this via
   * `resizeTerminal`, so a parked resize continues to win, exactly as before.
   */
  private intendedGeometry(managed: ManagedTerminal): TerminalGeometry | undefined {
    if (!managed.isOpened) {
      const target = { cols: managed.targetCols, rows: managed.targetRows };
      return isUsableTerminalGeometry(target) ? target : undefined;
    }
    // An opened pane's live grid is normally the best evidence there is — but not
    // when it is collapsed. A pane already at 2x1 would otherwise seed the
    // restore with that, let `alignToCaptureGeometry` widen it to a healthy
    // capture grid, and then be resized straight back to 2x1 the moment the
    // replay closed (#12442). Absent instead, so the pane keeps the capture grid
    // and the next real fit measures it.
    const live = { cols: managed.terminal.cols, rows: managed.terminal.rows };
    return isUsableTerminalGeometry(live) ? live : undefined;
  }

  /**
   * Size xterm to the grid a snapshot was captured on, so SerializeAddon's
   * wrap encoding decodes the way it was written.
   *
   * A no-op — replay verbatim, exactly as before this fix — when the snapshot
   * carries no geometry (an older pty host across an upgrade, or a preserved
   * snapshot captured pre-#11552), when the geometry is a grid no container
   * produced, or when it already matches. That second case now covers the
   * snapshots written during a collapse: parking xterm on a 2x1 capture grid is
   * how the renderer adopted it, and `collectTerminalSizes` then persisted it as
   * the pane's real size (#12442). Losing the session would be a worse
   * compatibility policy than reproducing today's behaviour for payloads that
   * predate the contract.
   *
   * The floor stops at the collapse, deliberately. A capture grid is not an
   * estimate: it is the width the payload was ENCODED at, and the wrap markers
   * only decode against it. Refusing a small but real capture would replay
   * those bytes at the wrong width and bake the #11552 damage in.
   */
  private alignToCaptureGeometry(
    managed: ManagedTerminal,
    captureGeometry: TerminalGeometry | undefined
  ): void {
    if (!isUsableTerminalGeometry(captureGeometry)) return;
    if (
      captureGeometry.cols === managed.terminal.cols &&
      captureGeometry.rows === managed.terminal.rows
    ) {
      return;
    }
    managed.terminal.resize(captureGeometry.cols, captureGeometry.rows);
  }

  /**
   * Close the restore window: put the pane on the grid it belongs on and reopen
   * the write gate. Every exit from a restore — success, throw, supersede,
   * null snapshot — must run this exactly once, while it still owns the window.
   *
   * The target is `pendingRestoreGeometry`: seeded from the live grid when the
   * window opened, overwritten by any resize that arrived while it was open.
   * Applying it covers BOTH jobs with one resize — reflowing back from a
   * capture-width replay, and landing a resize that `resizeTerminal` parked
   * rather than applied. Gating this on "did we align?" would silently drop
   * that parked resize on every geometry-less replay, leaving xterm on the old
   * grid while the PTY had already been told the new one. It is a no-op when
   * the grid already matches, which is the common case.
   *
   * An ABSENT target is meaningful, not a bug: a never-opened pane with no
   * attach target has no grid worth returning to, so the capture grid the replay
   * just landed on stands (#11718).
   *
   * `reflowCursorLine` is off by default in xterm, which leaves the wrapped
   * group containing the cursor untouched by a resize — reflowing to a narrower
   * grid would truncate that row's tail instead of wrapping it, and to a wider
   * one would leave it split. Turn it on for this one corrective resize and put
   * the configured value straight back; it is a live-typing ergonomic, not
   * something to change globally.
   */
  private endRestoreWindow(managed: ManagedTerminal, token: number): void {
    // A later window opened over this one — it owns the gate and the pending
    // geometry now, and closing them here would reopen its deferral mid-replay.
    if (managed.restoreWindowToken !== token) return;
    const target = managed.pendingRestoreGeometry;
    managed.pendingRestoreGeometry = undefined;
    managed.isSerializedRestoreInProgress = false;
    if (!target) return;
    // Below the bookkeeping above on purpose: the write gate and the restore
    // flag must be released on every exit, so a refused grid can never leave
    // the pane frozen mid-restore. `resizeTerminal` gates what it parks here,
    // but this is a direct xterm resize and the seed reaches it without passing
    // through that (#12442).
    if (!isUsableTerminalGeometry(target)) return;
    if (target.cols === managed.terminal.cols && target.rows === managed.terminal.rows) {
      return;
    }

    const previous = managed.terminal.options.reflowCursorLine;
    managed.terminal.options.reflowCursorLine = true;
    try {
      managed.terminal.resize(target.cols, target.rows);
    } catch (error) {
      logError(`Failed to restore terminal geometry after replay`, error);
    } finally {
      managed.terminal.options.reflowCursorLine = previous;
    }
  }

  /**
   * Replay everything deferred while a restore was in progress. Deferred
   * entries carry live ledger charges (port-ack FIFO, IPC ledger, ingest
   * inFlightBytes) that only the replay write settles, so EVERY terminal
   * restore attempt must end in exactly one of: this replay (success OR
   * failure — a failed restore with a live tail beats a frozen pane), a
   * newer restore generation taking ownership of the entries, or full
   * terminal teardown (destroyTerminal discards the FIFO and ingest queue).
   * A path that drops deferredOutput outside those three strands the ingest
   * ledger: inFlightBytes stays charged, the queue stops draining at its
   * watermark, and the watchdog reads the hold as healthy (#9910 class).
   */
  private replayDeferred(id: string, managed: ManagedTerminal): void {
    if (managed.deferredOutput.length === 0) return;
    const deferred = managed.deferredOutput;
    managed.deferredOutput = [];
    for (const entry of deferred) {
      if (entry.range) this.deps.writeData(id, entry.data, entry.chunkCount, entry.range);
      else this.deps.writeData(id, entry.data, entry.chunkCount);
    }
  }

  /**
   * What follows the snapshot in a restore payload: the escape sequence the
   * source parser was left inside, but only when the snapshot is fenced
   * against the live stream. Without the fence the chunk after the snapshot
   * may be one it already contains, and that chunk would complete the tail
   * into a command no one sent (#12791).
   */
  private restoreTail(continuation: SnapshotContinuation | undefined): string {
    return continuation?.streamOffset !== undefined ? (continuation.pendingEscapeTail ?? "") : "";
  }

  /**
   * Arm the fence right before the deferred replay: from here on, output the
   * snapshot already holds is acked without being painted a second time.
   */
  private commitStreamFence(
    managed: ManagedTerminal,
    continuation: SnapshotContinuation | undefined
  ): void {
    if (continuation?.streamOffset === undefined) return;
    managed.streamFence = Math.max(managed.streamFence ?? 0, continuation.streamOffset);
  }

  restoreFromSerialized(
    id: string,
    serializedState: string,
    captureGeometry?: TerminalGeometry,
    continuation?: SnapshotContinuation
  ): boolean {
    const managed = this.deps.getInstance(id);
    if (!managed) {
      logWarn(`Cannot restore: terminal ${id} not found`);
      return false;
    }

    // -1 until a window is actually opened: token 0 is a legitimate value on a
    // terminal that has never restored, and the catch below must not close a
    // window this call never took.
    let restoreWindow = -1;
    try {
      if (serializedState.length > INCREMENTAL_RESTORE_CONFIG.indicatorThresholdBytes) {
        void this.restoreFromSerializedIncremental(
          id,
          serializedState,
          captureGeometry,
          continuation
        );
        return true;
      }

      const restoreGeneration = ++managed.restoreGeneration;
      restoreWindow = this.beginRestoreWindow(managed);
      managed.lastScrollbackRestoreError = undefined;

      const scrollBackOffset = managed.isUserScrolledBack
        ? managed.terminal.buffer.active.baseY - managed.terminal.buffer.active.viewportY
        : 0;

      // Reset first, then align: reset is cheap and leaves cols/rows alone, so
      // resizing afterwards reflows an empty buffer instead of the content the
      // replay is about to discard. xterm parses asynchronously, so the grid
      // must be correct before `write` — not after it returns.
      // CAN leads the payload because reset() leaves xterm's parser wherever
      // the last live chunk stopped (xterm.js #5019): mid-sequence, it would
      // eat the head of the snapshot.
      managed.terminal.reset();
      this.alignToCaptureGeometry(managed, captureGeometry);
      const payload = PARSER_GROUND + serializedState + this.restoreTail(continuation);
      managed.parserTail?.feed(payload);
      managed.terminal.write(payload, () => {
        // Hop out of the write callback before touching geometry. The callback
        // runs inside xterm's parser drain, and resizing there re-applies the
        // chunk being drained against the new grid — a 4-cell write comes back
        // as 8 — and can leave a queued write's callback stranded, which in this
        // pipeline means permanently deferred output. A microtask lands after
        // the drain completes and before anything else can write.
        queueMicrotask(() => {
          const current = this.deps.getInstance(id);
          if (current !== managed || managed.restoreGeneration !== restoreGeneration) return;

          // Closed only now: the deferred chunks below were produced for the
          // live grid, so they must not be written while the pane is still
          // parked at the capture width.
          this.endRestoreWindow(current, restoreWindow);

          if (scrollBackOffset > 0) {
            const newBaseY = current.terminal.buffer.active.baseY;
            current.terminal.scrollToLine(Math.max(0, newBaseY - scrollBackOffset));
          }

          this.commitStreamFence(current, continuation);
          this.replayDeferred(id, current);
        });
      });
      managed.hasReceivedOutput = true;
      return true;
    } catch (error) {
      // The restore died synchronously (reset/resize/write threw). Put the pane
      // back on its live grid before releasing output — replaying live chunks
      // into a terminal parked at the capture width would corrupt them too.
      this.endRestoreWindow(managed, restoreWindow);
      managed.lastScrollbackRestoreError = classifyRestoreError(error);
      logError(`Failed to restore terminal ${id}`, error);
      // Release anything already deferred so its ledger charges settle and live
      // output resumes.
      this.replayDeferred(id, managed);
      return false;
    }
  }

  async restoreFromSerializedIncremental(
    id: string,
    serializedState: string,
    captureGeometry?: TerminalGeometry,
    continuation?: SnapshotContinuation
  ): Promise<boolean> {
    const managed = this.deps.getInstance(id);
    if (!managed) {
      logWarn(`Cannot restore: terminal ${id} not found`);
      return false;
    }

    const restoreGeneration = ++managed.restoreGeneration;
    const restoreWindow = this.beginRestoreWindow(managed);
    managed.lastScrollbackRestoreError = undefined;

    let replayed = false;
    const task = async (): Promise<boolean> => {
      const scrollBackOffset = managed.isUserScrolledBack
        ? managed.terminal.buffer.active.baseY - managed.terminal.buffer.active.viewportY
        : 0;
      try {
        if (
          this.deps.getInstance(id) !== managed ||
          managed.restoreGeneration !== restoreGeneration
        ) {
          return false;
        }

        managed.terminal.reset();
        this.alignToCaptureGeometry(managed, captureGeometry);

        // CAN rides the first chunk and the tail the last, so chunking and
        // yielding stay a function of the snapshot alone.
        const tail = this.restoreTail(continuation);
        let offset = 0;
        const total = serializedState.length;

        while (offset < total) {
          if (
            this.deps.getInstance(id) !== managed ||
            managed.restoreGeneration !== restoreGeneration
          ) {
            return false;
          }

          const slice = safeChunkSlice(
            serializedState,
            offset,
            INCREMENTAL_RESTORE_CONFIG.chunkBytes
          );
          const chunk =
            (offset === 0 ? PARSER_GROUND : "") +
            slice +
            (offset + slice.length >= total ? tail : "");
          offset += slice.length;

          let timeoutHandle!: ReturnType<typeof setTimeout>;
          try {
            await Promise.race([
              new Promise<void>((resolve, reject) => {
                try {
                  managed.parserTail?.feed(chunk);
                  managed.terminal.write(chunk, () => resolve());
                } catch (err) {
                  reject(err);
                }
              }),
              new Promise<void>((_, reject) => {
                timeoutHandle = setTimeout(() => reject(new Error("Write timeout")), 5000);
              }),
            ]);
          } finally {
            clearTimeout(timeoutHandle);
          }

          if (offset < total) {
            await this.yieldToUI();
          }
        }

        managed.hasReceivedOutput = true;
        replayed = true;
        return true;
      } catch (error) {
        // Real failure during chunked replay (write timeout, xterm parse
        // error). Stash the classified error on `managed` so the scheduler
        // can surface it to the panel store; the stale-generation early
        // returns above bypass this catch and remain silent. See #8535.
        managed.lastScrollbackRestoreError = classifyRestoreError(error);
        logError(`Incremental restore failed for ${id}`, error);
        return false;
      } finally {
        if (
          this.deps.getInstance(id) === managed &&
          managed.restoreGeneration === restoreGeneration
        ) {
          // Every chunk write was awaited to its parse callback, so the buffer
          // is fully laid out at the capture grid by now and this reflow sees
          // the whole payload. A superseded generation never reaches here — its
          // successor is mid-replay at its own capture width and owns the grid.
          this.endRestoreWindow(managed, restoreWindow);

          if (scrollBackOffset > 0) {
            const newBaseY = managed.terminal.buffer.active.baseY;
            managed.terminal.scrollToLine(Math.max(0, newBaseY - scrollBackOffset));
          }

          // A partial replay holds only part of the snapshot, so nothing it
          // could fence off is safe to drop.
          if (replayed) this.commitStreamFence(managed, continuation);
          this.replayDeferred(id, managed);
        }
      }
    };

    const writePromise = managed.writeChain.then(task).catch((err) => {
      // Fires when writeChain itself was already poisoned (a prior link
      // rejected). `task` never ran, so its own catch never set the error
      // channel — surface it here so the scheduler still sees a real
      // failure instead of silently marking the restore "done".
      managed.lastScrollbackRestoreError = classifyRestoreError(err);
      logError(`Write chain error for ${id}`, err);
      // task's finally never ran either: clear the defer gate and release the
      // held output ourselves (only while this generation still owns it), or
      // every subsequent chunk defers forever behind a restore that will
      // never complete.
      if (
        this.deps.getInstance(id) === managed &&
        managed.restoreGeneration === restoreGeneration
      ) {
        this.endRestoreWindow(managed, restoreWindow);
        this.replayDeferred(id, managed);
      }
      return false;
    });

    managed.writeChain = writePromise.then(() => {});

    return writePromise;
  }

  async restoreFetchedState(
    id: string,
    serializedState: string | null,
    captureGeometry?: TerminalGeometry,
    continuation?: SnapshotContinuation
  ): Promise<boolean> {
    // An empty screen still has to land when the source is mid-sequence: the
    // tail is the only record of bytes the pane never saw.
    if (serializedState === null || (serializedState === "" && !this.restoreTail(continuation))) {
      logWarn(`No serialized state for terminal ${id}`);
      return false;
    }

    if (serializedState.length > INCREMENTAL_RESTORE_CONFIG.indicatorThresholdBytes) {
      return await this.restoreFromSerializedIncremental(
        id,
        serializedState,
        captureGeometry,
        continuation
      );
    }

    return this.restoreFromSerialized(id, serializedState, captureGeometry, continuation);
  }

  async fetchAndRestore(id: string): Promise<boolean> {
    const managed = this.deps.getInstance(id);
    if (!managed) {
      logWarn(`Cannot fetch-and-restore: terminal ${id} not found`);
      return false;
    }

    // Deliberately does NOT bump restoreGeneration: that would cancel any
    // in-flight replay, and a fetch that then came back null would have killed
    // a good restore and released output over a half-written buffer. The window
    // token below is what makes ownership unique.
    const restoreGeneration = managed.restoreGeneration;
    const restoreWindow = this.beginRestoreWindow(managed);
    managed.lastScrollbackRestoreError = undefined;

    // The window this call opened is only ours to close while no newer restore
    // has claimed the terminal. Closing it unconditionally (as this used to)
    // re-opens a successor's deferral mid-replay: its live output stops being
    // held and lands on top of the snapshot it is still writing — and with the
    // capture-width alignment, at the wrong grid.
    const releaseIfStillOwned = (): void => {
      if (this.deps.getInstance(id) !== managed) return;
      this.endRestoreWindow(managed, restoreWindow);
    };

    try {
      const snapshot = await terminalClient.getSerializedState(id);

      // Check staleness after IPC round-trip
      const current = this.deps.getInstance(id);
      if (current !== managed || managed.restoreGeneration !== restoreGeneration) {
        releaseIfStillOwned();
        return false;
      }

      // restoreFetchedState will take over the isSerializedRestoreInProgress flag
      const result = await this.restoreFetchedState(
        id,
        snapshot?.data ?? null,
        snapshot ?? undefined,
        snapshot?.continuation
      );
      if (!result) {
        // The restore never ran (null state) or failed. When it ran it bumped
        // the generation and owns the gate — releaseIfStillOwned then correctly
        // declines. Release anything deferred while we awaited the snapshot;
        // replayDeferred empties the array, so a failure path that already
        // replayed makes this a no-op.
        releaseIfStillOwned();
        if (managed.restoreGeneration === restoreGeneration) {
          this.replayDeferred(id, managed);
        }
      }
      return result;
    } catch (error) {
      releaseIfStillOwned();
      managed.lastScrollbackRestoreError = classifyRestoreError(error);
      logError(`Failed to fetch state for terminal ${id}`, error);
      // Output deferred during the failed snapshot fetch must not stay
      // stranded — settle its ledger charges by replaying it live.
      if (
        this.deps.getInstance(id) === managed &&
        managed.restoreGeneration === restoreGeneration
      ) {
        this.replayDeferred(id, managed);
      }
      return false;
    }
  }

  /**
   * Repaint a pane that has never received output from whatever the host
   * mirror holds (#12754). The snapshot fetch doubles as the observation: an
   * empty mirror means the host has produced nothing either, which is ordinary
   * silence and leaves the pane untouched.
   *
   * The restore window opens BEFORE the fetch so any live chunk that lands
   * meanwhile is held, not painted. If one does arrive — or the pane was fed by
   * any other path — output is flowing and the pane is not lost, so the attempt
   * is abandoned without a reset and the held chunks are released in order.
   * Resetting there would print the snapshot and then the held chunks it
   * already contains.
   */
  async recoverMissingOutput(id: string): Promise<MissingOutputRecoveryOutcome> {
    const managed = this.deps.getInstance(id);
    if (!managed) return "stale";
    if (managed.hasReceivedOutput) return "live-output";

    const restoreGeneration = managed.restoreGeneration;
    const restoreWindow = this.beginRestoreWindow(managed);
    managed.lastScrollbackRestoreError = undefined;

    const release = (): void => {
      if (this.deps.getInstance(id) !== managed) return;
      this.endRestoreWindow(managed, restoreWindow);
      if (managed.restoreGeneration === restoreGeneration) {
        this.replayDeferred(id, managed);
      }
    };

    try {
      const snapshot = await terminalClient.getSerializedState(id);

      if (
        this.deps.getInstance(id) !== managed ||
        managed.restoreGeneration !== restoreGeneration
      ) {
        release();
        return "stale";
      }
      if (hasBeenFed(managed)) {
        release();
        return "live-output";
      }
      if (!snapshot || (snapshot.data === "" && !this.restoreTail(snapshot.continuation))) {
        release();
        return "no-host-output";
      }

      const restored = await this.restoreFetchedState(
        id,
        snapshot.data,
        snapshot,
        snapshot.continuation
      );
      if (restored) return "recovered";
      release();
      // The replay took its own generation, so a `false` with no classified
      // error is a newer restore superseding it, not a replay that broke.
      if (this.deps.getInstance(id) !== managed || !managed.lastScrollbackRestoreError) {
        return "stale";
      }
      return "failed";
    } catch (error) {
      // Output that arrived while the fetch was failing proves the pane is
      // being fed; a failed fetch says nothing about lost output then.
      const fed = hasBeenFed(managed);
      const superseded =
        this.deps.getInstance(id) !== managed || managed.restoreGeneration !== restoreGeneration;
      if (!fed && !superseded) managed.lastScrollbackRestoreError = classifyRestoreError(error);
      logError(`Failed to fetch state to recover terminal ${id}`, error);
      release();
      if (fed) return "live-output";
      return superseded ? "stale" : "failed";
    }
  }

  /**
   * Valid ONLY inside full terminal teardown (TerminalInstanceService's
   * destroy path): dropping deferredOutput here discards entries whose ledger
   * charges are settled by the teardown that follows — discardPortAcks drains
   * the pending port-ack FIFO and resetForTerminal drops the ingest queue.
   * Calling this outside that path would strand those ledgers (see
   * replayDeferred).
   */
  destroy(id: string): void {
    const managed = this.deps.getInstance(id);
    if (!managed) return;

    managed.restoreGeneration++;
    managed.restoreWindowToken++;
    managed.isSerializedRestoreInProgress = false;
    managed.pendingRestoreGeometry = undefined;
    managed.deferredOutput = [];
  }

  dispose(): void {
    // No global state to clean up — all state lives on ManagedTerminal
  }

  private yieldToUI(): Promise<void> {
    if (typeof scheduler !== "undefined" && scheduler !== null) {
      // Prefer scheduler.yield() — its continuation runs ahead of newly-queued
      // same-priority tasks, giving a tighter inter-chunk budget than postTask,
      // which would queue behind any background work already in flight.
      if (typeof scheduler.yield === "function") {
        return scheduler.yield();
      }
      if (typeof scheduler.postTask === "function") {
        return scheduler.postTask(() => {}, { priority: "background" });
      }
    }
    return new Promise((resolve) => setTimeout(resolve, INCREMENTAL_RESTORE_CONFIG.timeBudgetMs));
  }
}
