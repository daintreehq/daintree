import * as pty from "node-pty";
import type { IDisposable } from "node-pty";
import os from "os";
import { getDefaultShell, getDefaultShellArgs } from "./pty/terminalShell.js";
import { filterEnvironment, ensureUtf8Locale } from "./pty/EnvironmentFilter.js";

export interface PtyPoolConfig {
  poolSize?: number;
  defaultCwd?: string;
}

interface PooledPty {
  process: pty.IPty;
  cwd: string;
  createdAt: number;
  dataDisposable: IDisposable;
}

const DEFAULT_POOL_SIZE = 2;

export class PtyPool {
  private pool: Map<string, PooledPty> = new Map();
  private readonly poolSize: number;
  private readonly defaultShell: string;
  private defaultCwd: string;
  private isDisposed = false;
  private refillInProgress = false;
  /**
   * Generation counter incremented on each drainAndRefill() call.
   * Captured in createPoolEntry closures so async spawns from a prior
   * drain cycle can be rejected instead of registering at the new cwd.
   */
  private drainEpoch = 0;

  constructor(config: PtyPoolConfig = {}) {
    this.poolSize = this.resolvePoolSize(config.poolSize);
    this.defaultCwd = this.resolveCwd(config.defaultCwd, os.homedir());
    this.defaultShell = getDefaultShell();
  }

  async warmPool(cwd?: string): Promise<void> {
    if (this.isDisposed) {
      console.warn("[PtyPool] Cannot warm pool - already disposed");
      return;
    }

    if (cwd !== undefined) {
      const nextCwd = cwd.trim();
      if (!nextCwd) {
        console.warn("[PtyPool] Ignoring empty cwd override");
      } else {
        this.defaultCwd = nextCwd;
      }
    }

    const promises: Promise<void>[] = [];
    const needed = this.poolSize - this.pool.size;

    for (let i = 0; i < needed; i++) {
      promises.push(this.createPoolEntry(this.defaultCwd));
    }

    await Promise.all(promises);

    if (process.env.DAINTREE_VERBOSE) {
      console.log(
        `[PtyPool] Warmed ${needed} terminals in ${this.defaultCwd} (pool size: ${this.pool.size})`
      );
    }
  }

  private async createPoolEntry(cwd: string): Promise<void> {
    if (this.isDisposed) return;

    // Capture the current drain epoch. If it changes before we finish
    // registering this entry, a drainAndRefill() happened and this spawn
    // is stale — kill it instead of registering at the wrong cwd.
    const epoch = this.drainEpoch;

    try {
      const id = `pool-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

      const ptyProcess = pty.spawn(this.defaultShell, getDefaultShellArgs(this.defaultShell), {
        name: "xterm-256color",
        cols: 80,
        rows: 24,
        cwd,
        env: this.getFilteredEnv(),
      });

      const dataDisposable = ptyProcess.onData(() => {});

      ptyProcess.onExit(({ exitCode }) => {
        if (process.env.DAINTREE_VERBOSE) {
          console.log(`[PtyPool] Pooled PTY ${id} exited with code ${exitCode}`);
        }
        const entry = this.pool.get(id);
        if (entry) {
          entry.dataDisposable.dispose();
          this.pool.delete(id);
        }
        // Skip refill if this entry belonged to a prior drain cycle — a
        // newer drainAndRefill() already initiated its own refill.
        if (!this.isDisposed && this.drainEpoch === epoch) {
          this.refillPool();
        }
      });

      if (this.isDisposed || this.drainEpoch !== epoch) {
        dataDisposable.dispose();
        try {
          ptyProcess.kill();
        } catch {
          // already dead
        }
        return;
      }

      this.pool.set(id, {
        process: ptyProcess,
        cwd,
        createdAt: Date.now(),
        dataDisposable,
      });

      if (process.env.DAINTREE_VERBOSE) {
        console.log(`[PtyPool] Created pooled PTY ${id}, pool size: ${this.pool.size}`);
      }
    } catch (error) {
      console.error("[PtyPool] Failed to create pool entry:", error);
    }
  }

  acquire(): pty.IPty | null {
    if (this.isDisposed) {
      console.warn("[PtyPool] Cannot acquire - pool disposed");
      return null;
    }

    if (this.pool.size === 0) {
      if (process.env.DAINTREE_VERBOSE) {
        console.log("[PtyPool] Pool empty, returning null");
      }
      return null;
    }

    const [id, entry] = this.pool.entries().next().value as [string, PooledPty];
    this.pool.delete(id);

    try {
      const pid = entry.process.pid;
      if (pid === undefined) {
        console.warn(`[PtyPool] Pooled PTY ${id} has no PID (already dead), discarding`);
        entry.dataDisposable.dispose();
        this.refillPool();
        return null;
      }
    } catch (error) {
      console.warn(`[PtyPool] Pooled PTY ${id} health check failed:`, error);
      entry.dataDisposable.dispose();
      this.refillPool();
      return null;
    }

    entry.dataDisposable.dispose();

    if (process.env.DAINTREE_VERBOSE) {
      console.log(`[PtyPool] Acquired PTY ${id}, ${this.pool.size} remaining`);
    }

    this.refillPool();

    return entry.process;
  }

  refillPool(): void {
    if (this.isDisposed || this.refillInProgress) {
      return;
    }

    const needed = this.poolSize - this.pool.size;
    if (needed <= 0) {
      return;
    }

    this.refillInProgress = true;

    const promises: Promise<void>[] = [];
    for (let i = 0; i < needed; i++) {
      promises.push(this.createPoolEntry(this.defaultCwd));
    }

    Promise.all(promises)
      .then(() => {
        if (process.env.DAINTREE_VERBOSE) {
          console.log(`[PtyPool] Refilled ${needed} entries, pool size: ${this.pool.size}`);
        }
      })
      .catch((err) => {
        console.error("[PtyPool] Failed to refill:", err);
      })
      .finally(() => {
        this.refillInProgress = false;
      });
  }

  /** Returns the cwd currently used to spawn new pool entries. */
  getDefaultCwd(): string {
    return this.defaultCwd;
  }

  /**
   * Drain existing pooled entries and refill at a new cwd.
   *
   * Callers use this when the active project changes so pooled shells
   * are pre-positioned at the project root (via node-pty's spawn cwd,
   * which kernel-level chdirs before exec) rather than relying on a
   * fragile shell-level `cd` write after acquire.
   *
   * Race protection: an epoch counter is captured into every in-flight
   * createPoolEntry() closure. Bumping the epoch here causes any pending
   * spawns from the previous cycle to reject instead of registering at
   * the stale cwd. It also suppresses the onExit→refill cascade of the
   * entries we're killing.
   */
  async drainAndRefill(cwd: string): Promise<void> {
    if (this.isDisposed) {
      console.warn("[PtyPool] Cannot drainAndRefill - pool disposed");
      return;
    }

    const nextCwd = this.resolveCwd(cwd, "");
    if (!nextCwd) {
      console.warn("[PtyPool] Ignoring blank cwd in drainAndRefill");
      return;
    }

    if (nextCwd === this.defaultCwd && this.pool.size === this.poolSize) {
      // Already at the requested cwd and fully warmed — nothing to do.
      return;
    }

    // Bump epoch BEFORE killing so onExit handlers (and any in-flight
    // createPoolEntry promises) see the mismatch and skip refilling.
    this.drainEpoch++;
    this.defaultCwd = nextCwd;

    const snapshot = Array.from(this.pool.values());
    this.pool.clear();

    for (const entry of snapshot) {
      try {
        entry.dataDisposable.dispose();
      } catch {
        // ignore
      }
      try {
        entry.process.kill();
      } catch (error) {
        if (process.env.DAINTREE_VERBOSE) {
          console.warn("[PtyPool] Error killing pooled PTY during drain:", error);
        }
      }
    }

    if (process.env.DAINTREE_VERBOSE) {
      console.log(
        `[PtyPool] Drained ${snapshot.length} entries; refilling at ${nextCwd} (epoch ${this.drainEpoch})`
      );
    }

    await this.warmPool();
  }

  getPoolSize(): number {
    return this.pool.size;
  }

  getMaxPoolSize(): number {
    return this.poolSize;
  }

  dispose(): void {
    if (this.isDisposed) return;

    this.isDisposed = true;

    for (const [id, entry] of this.pool) {
      try {
        entry.dataDisposable.dispose();
        entry.process.kill();
        if (process.env.DAINTREE_VERBOSE) {
          console.log(`[PtyPool] Killed pooled PTY ${id}`);
        }
      } catch (error) {
        console.warn(`[PtyPool] Error killing pooled PTY ${id}:`, error);
      }
    }

    this.pool.clear();
    console.log("[PtyPool] Disposed");
  }

  private getFilteredEnv(): Record<string, string> {
    const filtered = filterEnvironment(process.env as Record<string, string | undefined>);

    // TUI reliability: ensure rich terminal capabilities for Claude/Gemini CLIs
    filtered.TERM = "xterm-256color";
    filtered.COLORTERM = "truecolor";

    // Avoid tools treating the environment as CI/non-interactive
    delete filtered.CI;

    return ensureUtf8Locale(filtered);
  }

  private resolvePoolSize(poolSize: number | undefined): number {
    if (
      typeof poolSize === "number" &&
      Number.isInteger(poolSize) &&
      Number.isFinite(poolSize) &&
      poolSize > 0
    ) {
      return poolSize;
    }
    return DEFAULT_POOL_SIZE;
  }

  private resolveCwd(cwd: string | undefined, fallback: string): string {
    if (typeof cwd !== "string") {
      return fallback;
    }
    const trimmed = cwd.trim();
    return trimmed || fallback;
  }
}

let ptyPoolInstance: PtyPool | null = null;

export function getPtyPool(config?: PtyPoolConfig): PtyPool {
  if (!ptyPoolInstance) {
    ptyPoolInstance = new PtyPool(config);
  }
  return ptyPoolInstance;
}

export function disposePtyPool(): void {
  if (ptyPoolInstance) {
    ptyPoolInstance.dispose();
    ptyPoolInstance = null;
  }
}
