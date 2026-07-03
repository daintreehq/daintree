import { terminalClient } from "@/clients";
import type { ManagedTerminal } from "./types";
import { INCREMENTAL_RESTORE_CONFIG } from "./types";
import { logWarn, logError } from "@/utils/logger";
import type { TerminalScrollbackRestoreError } from "@shared/types/panel";

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

  restoreFromSerialized(id: string, serializedState: string): boolean {
    const managed = this.deps.getInstance(id);
    if (!managed) {
      logWarn(`Cannot restore: terminal ${id} not found`);
      return false;
    }

    try {
      if (serializedState.length > INCREMENTAL_RESTORE_CONFIG.indicatorThresholdBytes) {
        void this.restoreFromSerializedIncremental(id, serializedState);
        return true;
      }

      const restoreGeneration = ++managed.restoreGeneration;
      managed.isSerializedRestoreInProgress = true;
      managed.lastScrollbackRestoreError = undefined;

      const scrollBackOffset = managed.isUserScrolledBack
        ? managed.terminal.buffer.active.baseY - managed.terminal.buffer.active.viewportY
        : 0;

      managed.terminal.reset();
      managed.terminal.write(serializedState, () => {
        const current = this.deps.getInstance(id);
        if (current !== managed || managed.restoreGeneration !== restoreGeneration) return;

        if (scrollBackOffset > 0) {
          const newBaseY = current.terminal.buffer.active.baseY;
          current.terminal.scrollToLine(Math.max(0, newBaseY - scrollBackOffset));
        }

        current.isSerializedRestoreInProgress = false;
        this.replayDeferred(id, current);
      });
      return true;
    } catch (error) {
      managed.isSerializedRestoreInProgress = false;
      managed.lastScrollbackRestoreError = classifyRestoreError(error);
      logError(`Failed to restore terminal ${id}`, error);
      // The restore died synchronously (reset/write threw) — release anything
      // already deferred so its ledger charges settle and live output resumes.
      this.replayDeferred(id, managed);
      return false;
    }
  }

  async restoreFromSerializedIncremental(id: string, serializedState: string): Promise<boolean> {
    const managed = this.deps.getInstance(id);
    if (!managed) {
      logWarn(`Cannot restore: terminal ${id} not found`);
      return false;
    }

    const restoreGeneration = ++managed.restoreGeneration;
    managed.isSerializedRestoreInProgress = true;
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
          if (scrollBackOffset > 0) {
            const newBaseY = managed.terminal.buffer.active.baseY;
            managed.terminal.scrollToLine(Math.max(0, newBaseY - scrollBackOffset));
          }

          managed.isSerializedRestoreInProgress = false;
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
        managed.isSerializedRestoreInProgress = false;
        this.replayDeferred(id, managed);
      }
      return false;
    });

    managed.writeChain = writePromise.then(() => {});

    return writePromise;
  }

  async restoreFetchedState(id: string, serializedState: string | null): Promise<boolean> {
    if (!serializedState) {
      logWarn(`No serialized state for terminal ${id}`);
      return false;
    }

    if (serializedState.length > INCREMENTAL_RESTORE_CONFIG.indicatorThresholdBytes) {
      return await this.restoreFromSerializedIncremental(id, serializedState);
    }

    return this.restoreFromSerialized(id, serializedState);
  }

  async fetchAndRestore(id: string): Promise<boolean> {
    const managed = this.deps.getInstance(id);
    if (!managed) {
      logWarn(`Cannot fetch-and-restore: terminal ${id} not found`);
      return false;
    }

    const restoreGeneration = managed.restoreGeneration;
    managed.isSerializedRestoreInProgress = true;
    managed.lastScrollbackRestoreError = undefined;

    try {
      const serializedState = await terminalClient.getSerializedState(id);

      // Check staleness after IPC round-trip
      const current = this.deps.getInstance(id);
      if (current !== managed || managed.restoreGeneration !== restoreGeneration) {
        managed.isSerializedRestoreInProgress = false;
        return false;
      }

      // restoreFetchedState will take over the isSerializedRestoreInProgress flag
      const result = await this.restoreFetchedState(id, serializedState);
      if (!result) {
        managed.isSerializedRestoreInProgress = false;
        // The restore never ran (null state) or failed — release anything
        // deferred while we awaited the snapshot. replayDeferred empties the
        // array, so a failure path that already replayed makes this a no-op.
        if (managed.restoreGeneration === restoreGeneration) {
          this.replayDeferred(id, managed);
        }
      }
      return result;
    } catch (error) {
      managed.isSerializedRestoreInProgress = false;
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
    managed.isSerializedRestoreInProgress = false;
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
