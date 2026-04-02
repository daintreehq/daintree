import { terminalClient } from "@/clients";
import type { ManagedTerminal } from "./types";
import { INCREMENTAL_RESTORE_CONFIG } from "./types";
import { logWarn, logError } from "@/utils/logger";

export interface RestoreControllerDeps {
  getInstance: (id: string) => ManagedTerminal | undefined;
  writeData: (id: string, data: string | Uint8Array) => void;
}

export class TerminalRestoreController {
  private deps: RestoreControllerDeps;

  constructor(deps: RestoreControllerDeps) {
    this.deps = deps;
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

      managed.isSerializedRestoreInProgress = true;

      const scrollBackOffset = managed.isUserScrolledBack
        ? managed.terminal.buffer.active.baseY - managed.terminal.buffer.active.viewportY
        : 0;

      managed.terminal.reset();
      managed.terminal.write(serializedState, () => {
        const current = this.deps.getInstance(id);
        if (current !== managed) return;

        if (scrollBackOffset > 0) {
          const newBaseY = current.terminal.buffer.active.baseY;
          current.terminal.scrollToLine(Math.max(0, newBaseY - scrollBackOffset));
        }

        current.isSerializedRestoreInProgress = false;

        const deferred = current.deferredOutput;
        current.deferredOutput = [];
        for (const data of deferred) {
          this.deps.writeData(id, data);
        }
      });
      return true;
    } catch (error) {
      managed.isSerializedRestoreInProgress = false;
      logError(`Failed to restore terminal ${id}`, error);
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

          const chunkSize = Math.min(INCREMENTAL_RESTORE_CONFIG.chunkBytes, total - offset);
          const chunk = serializedState.substring(offset, offset + chunkSize);
          offset += chunkSize;

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

          const deferredData = managed.deferredOutput;
          managed.deferredOutput = [];

          for (const data of deferredData) {
            this.deps.writeData(id, data);
          }
        }
      }
    };

    const writePromise = managed.writeChain.then(task).catch((err) => {
      logError(`Write chain error for ${id}`, err);
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
      }
      return result;
    } catch (error) {
      managed.isSerializedRestoreInProgress = false;
      logError(`Failed to fetch state for terminal ${id}`, error);
      return false;
    }
  }

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
    if (typeof scheduler !== "undefined" && typeof scheduler.postTask === "function") {
      return scheduler.postTask(() => {}, { priority: "background" });
    }
    return new Promise((resolve) => setTimeout(resolve, INCREMENTAL_RESTORE_CONFIG.timeBudgetMs));
  }
}
