import { terminalClient } from "@/clients";
import type { ManagedTerminal } from "./types";
import { INCREMENTAL_RESTORE_CONFIG } from "./types";
import { logWarn, logError } from "@/utils/logger";
import type { TerminalScrollbackRestoreError } from "@shared/types/panel";
import type { TerminalGeometry } from "@shared/types/terminal";
import { isValidTerminalGeometry } from "@shared/types/terminal";

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

export interface RestoreControllerDeps {
  getInstance: (id: string) => ManagedTerminal | undefined;
  // chunkCount travels with each replayed deferred batch: the batch's pending
  // port-ack FIFO entries were deliberately NOT settled at defer time, so the
  // replay write must settle exactly them (see TerminalWriteController).
  writeData: (id: string, data: string | Uint8Array, chunkCount: number) => void;
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
      return isValidTerminalGeometry(target) ? target : undefined;
    }
    return { cols: managed.terminal.cols, rows: managed.terminal.rows };
  }

  /**
   * Size xterm to the grid a snapshot was captured on, so SerializeAddon's
   * wrap encoding decodes the way it was written.
   *
   * A no-op — replay verbatim, exactly as before this fix — when the snapshot
   * carries no geometry (an older pty host across an upgrade, or a preserved
   * snapshot captured pre-#11552), when the geometry is not a grid a terminal
   * could plausibly have had, or when it already matches. Losing the session
   * would be a worse compatibility policy than reproducing today's behaviour
   * for payloads that predate the contract.
   */
  private alignToCaptureGeometry(
    managed: ManagedTerminal,
    captureGeometry: TerminalGeometry | undefined
  ): void {
    if (!isValidTerminalGeometry(captureGeometry)) return;
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
      this.deps.writeData(id, entry.data, entry.chunkCount);
    }
  }

  restoreFromSerialized(
    id: string,
    serializedState: string,
    captureGeometry?: TerminalGeometry
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
        void this.restoreFromSerializedIncremental(id, serializedState, captureGeometry);
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
      managed.terminal.reset();
      this.alignToCaptureGeometry(managed, captureGeometry);
      managed.terminal.write(serializedState, () => {
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

          this.replayDeferred(id, current);
        });
      });
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
    captureGeometry?: TerminalGeometry
  ): Promise<boolean> {
    const managed = this.deps.getInstance(id);
    if (!managed) {
      logWarn(`Cannot restore: terminal ${id} not found`);
      return false;
    }

    const restoreGeneration = ++managed.restoreGeneration;
    const restoreWindow = this.beginRestoreWindow(managed);
    managed.lastScrollbackRestoreError = undefined;

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

        let offset = 0;
        const total = serializedState.length;

        while (offset < total) {
          if (
            this.deps.getInstance(id) !== managed ||
            managed.restoreGeneration !== restoreGeneration
          ) {
            return false;
          }

          const chunk = safeChunkSlice(
            serializedState,
            offset,
            INCREMENTAL_RESTORE_CONFIG.chunkBytes
          );
          offset += chunk.length;

          let timeoutHandle!: ReturnType<typeof setTimeout>;
          try {
            await Promise.race([
              new Promise<void>((resolve, reject) => {
                try {
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
    captureGeometry?: TerminalGeometry
  ): Promise<boolean> {
    if (!serializedState) {
      logWarn(`No serialized state for terminal ${id}`);
      return false;
    }

    if (serializedState.length > INCREMENTAL_RESTORE_CONFIG.indicatorThresholdBytes) {
      return await this.restoreFromSerializedIncremental(id, serializedState, captureGeometry);
    }

    return this.restoreFromSerialized(id, serializedState, captureGeometry);
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
        snapshot ?? undefined
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
