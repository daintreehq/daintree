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

/**
 * How long each restart waits after the database was busy (#16840). A busy
 * that reaches the store already outlasted the connection's busy timeout, so
 * the first wait is short but not immediate. After the last, the store stays
 * stopped until the next start: a database that stays locked isn't restarted
 * forever.
 */
export const BUSY_RESTART_DELAYS_MS: readonly number[] = [5_000, 30_000, 2 * 60_000];

/** A store that finds the database busy again within this long of a restart is the same outage. */
export const BUSY_SAME_OUTAGE_MS = 15 * 60_000;

/** How one kind of store fault is retried. */
export interface StorageRecoveryPolicy {
  /** The wait before each restart of one outage; once they are spent the store stays stopped. */
  readonly delaysMs: readonly number[];
  /** A fault within this long of the last restart belongs to the same outage. */
  readonly sameOutageMs: number;
  /** Logged once an outage has spent every restart. */
  readonly exhausted: string;
}

export const DISK_FULL_RECOVERY: StorageRecoveryPolicy = {
  delaysMs: DISK_FULL_RESTART_DELAYS_MS,
  sameOutageMs: DISK_FULL_SAME_OUTAGE_MS,
  exhausted: "[Decisions] The local store ran out of room again after restarting; it stays stopped",
};

export const BUSY_RECOVERY: StorageRecoveryPolicy = {
  delaysMs: BUSY_RESTART_DELAYS_MS,
  sameOutageMs: BUSY_SAME_OUTAGE_MS,
  exhausted:
    "[Decisions] The database was busy again after restarting the local store; it stays stopped",
};

export interface StorageRecoveryDeps {
  policy: StorageRecoveryPolicy;
  /**
   * Reads free space now: true when there is room to write again, false
   * while space is critical, null when it couldn't be read. Without it every
   * wait ends in a restart.
   */
  checkDiskSpace?(): Promise<boolean | null>;
  /** Replaces the store if it is still stopped for this kind of fault; true when it did. */
  restart(): Promise<boolean>;
  now?: () => number;
}

/**
 * Restarts a store that stopped for a fault that can pass: the database ran
 * out of room (`SQLITE_FULL`, #16605) or stayed busy (#16840). Each kind has
 * its own instance, so its own budget. For room, the disk-space monitor may
 * never have seen that dip, so no critical exit follows it: free space is
 * read again after a wait, and with room the store is replaced. While space
 * reads critical the monitor's own exit replaces it instead.
 */
export class StorageRecovery {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private checking = false;
  /** The store it was replacing stopped too: looked at once this attempt ends. */
  private again = false;
  private restarts = 0;
  private lastRestartAt: number | null = null;
  /** Bumped by `reset`, so an attempt already running counts toward no later budget. */
  private generation = 0;
  private disposed = false;
  private readonly now: () => number;

  constructor(private readonly deps: StorageRecoveryDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** The store stopped for this kind of fault. */
  faulted(): void {
    if (this.disposed) return;
    if (this.checking) {
      this.again = true;
      return;
    }
    if (this.timer !== null) return;
    const { delaysMs, sameOutageMs, exhausted } = this.deps.policy;
    if (this.lastRestartAt === null || this.now() - this.lastRestartAt >= sameOutageMs) {
      this.restarts = 0;
    }
    const delay = delaysMs[this.restarts];
    if (delay === undefined) {
      logWarn(exhausted, { restarts: this.restarts });
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.attempt();
    }, delay);
    this.timer.unref?.();
  }

  /**
   * Forgets the outage: a wait already set is cancelled, and the next fault
   * starts at the shortest wait. For a lifetime that ended, so turning
   * Decisions off and on always gets a full budget.
   */
  reset(): void {
    this.generation += 1;
    this.again = false;
    this.restarts = 0;
    this.lastRestartAt = null;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  dispose(): void {
    this.disposed = true;
    this.reset();
  }

  private async attempt(): Promise<void> {
    this.checking = true;
    const generation = this.generation;
    try {
      const room = this.deps.checkDiskSpace
        ? await this.deps.checkDiskSpace().catch(() => null)
        : null;
      // Critical: the monitor's exit replaces the store once there is room.
      if (this.disposed || generation !== this.generation || room === false) return;
      // Room that couldn't be read is tried anyway; the restarts are counted either way.
      if ((await this.deps.restart().catch(() => false)) && generation === this.generation) {
        this.restarts += 1;
        this.lastRestartAt = this.now();
      }
    } finally {
      this.checking = false;
      if (this.again) {
        this.again = false;
        this.faulted();
      }
    }
  }
}
