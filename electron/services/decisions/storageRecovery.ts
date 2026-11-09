import { logWarn } from "../../utils/logger.js";
import type { DecisionsStoreUnavailableReason } from "./daintreeLocalStore.js";

/** A store fault that room on the disk ends: a fresh store may write again once there is some. */
export function isDiskSpaceFault(reason: DecisionsStoreUnavailableReason | null): boolean {
  return reason === "disk-pressure" || reason === "disk-full";
}

/**
 * How long each restart waits after the store ran out of room, the first
 * restart of an outage the shortest. After the last, the store stays stopped
 * until the next start: room that free space can't explain (a quota, a size
 * limit) would otherwise restart it forever.
 */
export const DISK_FULL_RESTART_DELAYS_MS: readonly number[] = [30_000, 2 * 60_000, 10 * 60_000];

/** A store that runs out of room again within this long of a restart is the same outage. */
export const DISK_FULL_SAME_OUTAGE_MS = 15 * 60_000;

export interface StorageRecoveryDeps {
  /**
   * Reads free space now: true when there is room to write again, false
   * while space is critical, null when it couldn't be read.
   */
  checkDiskSpace(): Promise<boolean | null>;
  /** Replaces the store if it is still stopped for disk space; true when it did. */
  restart(): Promise<boolean>;
  now?: () => number;
}

/**
 * Restarts a store that stopped because the database ran out of room
 * (`SQLITE_FULL`, #16605). The disk-space monitor may never have seen that
 * dip, so no critical exit follows it: free space is read again after a
 * wait, and with room the store is replaced. While space reads critical the
 * monitor's own exit replaces it instead.
 */
export class StorageRecovery {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private checking = false;
  /** The store it was replacing ran out of room too: looked at once this attempt ends. */
  private again = false;
  private restarts = 0;
  private lastRestartAt: number | null = null;
  private disposed = false;
  private readonly now: () => number;

  constructor(private readonly deps: StorageRecoveryDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** The store stopped because the database ran out of room. */
  diskFull(): void {
    if (this.disposed) return;
    if (this.checking) {
      this.again = true;
      return;
    }
    if (this.timer !== null) return;
    if (
      this.lastRestartAt === null ||
      this.now() - this.lastRestartAt >= DISK_FULL_SAME_OUTAGE_MS
    ) {
      this.restarts = 0;
    }
    const delay = DISK_FULL_RESTART_DELAYS_MS[this.restarts];
    if (delay === undefined) {
      logWarn(
        "[Decisions] The local store ran out of room again after restarting; it stays stopped",
        {
          restarts: this.restarts,
        }
      );
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.attempt();
    }, delay);
    this.timer.unref?.();
  }

  dispose(): void {
    this.disposed = true;
    this.again = false;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private async attempt(): Promise<void> {
    this.checking = true;
    try {
      const room = await this.deps.checkDiskSpace().catch(() => null);
      // Critical: the monitor's exit replaces the store once there is room.
      if (this.disposed || room === false) return;
      // Room that couldn't be read is tried anyway; the restarts are counted either way.
      if (await this.deps.restart().catch(() => false)) {
        this.restarts += 1;
        this.lastRestartAt = this.now();
      }
    } finally {
      this.checking = false;
      if (this.again) {
        this.again = false;
        this.diskFull();
      }
    }
  }
}
