import { terminalClient } from "@/clients";
import type { ManagedTerminal } from "./types";
import { INCREMENTAL_RESTORE_CONFIG } from "./types";

const WAKE_RATE_LIMIT_MS = 1000;
const WAKE_RETRY_DELAY_MS = 100;
const WAKE_MAX_RETRIES = 10;

export interface WakeManagerDeps {
  getInstance: (id: string) => ManagedTerminal | undefined;
  hasInstance: (id: string) => boolean;
  restoreFromSerialized: (id: string, state: string) => boolean;
  restoreFromSerializedIncremental: (id: string, state: string) => Promise<boolean>;
}

export class TerminalWakeManager {
  private lastWakeTime = new Map<string, number>();
  private pendingWakes = new Map<string, { retries: number; timeoutId: NodeJS.Timeout }>();
  private inFlightWakes = new Map<string, Promise<boolean>>();
  private deps: WakeManagerDeps;

  constructor(deps: WakeManagerDeps) {
    this.deps = deps;
  }

  async wakeAndRestore(id: string): Promise<boolean> {
    const inFlight = this.inFlightWakes.get(id);
    if (inFlight) {
      return inFlight;
    }

    const wakePromise = (async () => {
      try {
        const managed = this.deps.getInstance(id);
        if (!managed) return false;

        const { state } = await terminalClient.wake(id);
        if (!state) return false;

        if (state.length > INCREMENTAL_RESTORE_CONFIG.indicatorThresholdBytes) {
          await this.deps.restoreFromSerializedIncremental(id, state);
        } else {
          this.deps.restoreFromSerialized(id, state);
        }

        if (this.deps.getInstance(id) === managed) {
          managed.terminal.refresh(0, managed.terminal.rows - 1);
        }
        return true;
      } catch (error) {
        console.warn(`[TerminalWakeManager] Failed to wake terminal ${id}:`, error);
        return false;
      }
    })();

    this.inFlightWakes.set(id, wakePromise);
    void wakePromise.finally(() => {
      if (this.inFlightWakes.get(id) === wakePromise) {
        this.inFlightWakes.delete(id);
      }
    });
    return wakePromise;
  }

  private triggerWake(id: string): void {
    const startedAt = Date.now();
    void this.wakeAndRestore(id).then((success) => {
      if (success) {
        this.lastWakeTime.set(id, startedAt);
      } else {
        this.lastWakeTime.delete(id);
      }
    });
  }

  wake(id: string): void {
    // Clear any pending retry for this terminal
    const pending = this.pendingWakes.get(id);
    if (pending) {
      clearTimeout(pending.timeoutId);
      this.pendingWakes.delete(id);
    }

    if (!this.deps.hasInstance(id)) {
      // Instance doesn't exist yet - schedule a retry
      this.scheduleWakeRetry(id, 0);
      return;
    }

    const now = Date.now();
    const lastWake = this.lastWakeTime.get(id) ?? 0;

    if (now - lastWake < WAKE_RATE_LIMIT_MS) {
      return;
    }

    this.triggerWake(id);
  }

  private scheduleWakeRetry(id: string, retryCount: number): void {
    if (retryCount >= WAKE_MAX_RETRIES) {
      console.warn(`[TerminalWakeManager] Giving up on wake for ${id} after ${retryCount} retries`);
      return;
    }

    const timeoutId = setTimeout(() => {
      this.pendingWakes.delete(id);

      if (this.deps.hasInstance(id)) {
        // Instance now exists, proceed with wake
        const now = Date.now();
        const lastWake = this.lastWakeTime.get(id) ?? 0;

        if (now - lastWake >= WAKE_RATE_LIMIT_MS) {
          this.triggerWake(id);
        }
      } else {
        // Still no instance, schedule another retry
        this.scheduleWakeRetry(id, retryCount + 1);
      }
    }, WAKE_RETRY_DELAY_MS);

    this.pendingWakes.set(id, { retries: retryCount, timeoutId });
  }

  clearWakeState(id: string): void {
    this.lastWakeTime.delete(id);
    this.inFlightWakes.delete(id);

    const pending = this.pendingWakes.get(id);
    if (pending) {
      clearTimeout(pending.timeoutId);
      this.pendingWakes.delete(id);
    }
  }

  dispose(): void {
    this.lastWakeTime.clear();
    this.inFlightWakes.clear();

    // Clear all pending wake retries
    for (const [, pending] of this.pendingWakes) {
      clearTimeout(pending.timeoutId);
    }
    this.pendingWakes.clear();
  }
}
