import * as pty from "node-pty";
import type { IDisposable } from "node-pty";
import os from "os";
import { getDefaultShell, getDefaultShellArgs } from "./pty/terminalShell.js";
import {
  filterEnvironment,
  filterSensitiveOnly,
  ensureUtf8Locale,
} from "./pty/EnvironmentFilter.js";
import { POOL_ENV_EMPTY_HASH } from "./pty/ptyPoolEnvHash.js";
import { isHostPerformanceCaptureEnabled, markHostPerformance } from "../utils/hostPerformance.js";
import { PERF_MARKS } from "../../shared/perf/marks.js";

export interface PtyPoolConfig {
  poolSize?: number;
  defaultCwd?: string;
  /**
   * Hard cap on total pool entries across all (cwd, envHash) keys. LRU
   * eviction kicks in when warming would exceed this. Each node-pty process
   * is roughly 50-80 MB; the default cap (8) bounds overhead at ~640 MB
   * across the 2-4 active pool keys we expect at steady state.
   */
  maxEntries?: number;
}

interface PooledPty {
  process: pty.IPty;
  cwd: string;
  envHash: string;
  poolKey: string;
  env: Record<string, string>;
  createdAt: number;
  dataDisposable: IDisposable;
  dataHandoff?: BufferedPtyDataHandoff;
  /**
   * Set false in the onExit handler so acquireByKey can reject entries whose
   * process has exited even though the JS object still references a defined
   * pid. The previous `pid !== undefined` liveness probe was always truthy
   * because pid stays set for the lifetime of the IPty wrapper.
   */
  alive: boolean;
  /**
   * Bounded buffer of shell-init output (banner, MOTD, first prompt) emitted
   * before this entry was acquired. Replayed on acquire so the consumer's
   * xterm sees the prompt the user expects. Without this, fast Macs that
   * pre-warm the pool before the first openTerminal call would hand out a
   * shell that has already finished printing — the renderer xterm attaches
   * after the prompt and stays blank. See PR for #7625.
   */
  prelude: string;
}

interface PoolFailureState {
  count: number;
  blockedUntil: number;
}

const DEFAULT_POOL_SIZE = 2;
const DEFAULT_MAX_ENTRIES = 8;
/**
 * Cap on bytes of pre-acquire shell output buffered per pool entry. Sized to
 * comfortably hold zsh/bash MOTD + prompt (typically <1 KB) while bounding
 * memory if a noisy `.zshrc` keeps writing. Anything past the cap is silently
 * dropped, which matches the prior (unbuffered) behaviour for that overflow.
 */
const PRELUDE_BYTE_CAP = 64 * 1024;

/**
 * Window in which an exit is treated as a crash rather than a normal exit.
 * Combined with `MAX_KEY_FAILURES` and `KEY_BACKOFF_MS`, this gates the
 * onExit→refill cascade for a misconfigured (cwd, envHash) key whose shell
 * exits immediately on spawn (rc syntax error, missing binary, etc.).
 */
const FAST_EXIT_THRESHOLD_MS = 2_000;
const MAX_KEY_FAILURES = 3;
const KEY_BACKOFF_MS = 30_000;

/**
 * Windows ConPTY has shown native heap-corruption crashes (0xC0000374) when
 * pooled shells are prewarmed, handed off, and destroyed under release-runner
 * churn. Keep the pool off on Windows while preserving direct PTY spawns.
 */
export function shouldEnablePtyPool(platform: NodeJS.Platform = process.platform): boolean {
  return platform !== "win32";
}

/**
 * Closes a pooled PTY's master/slave file descriptors. node-pty's `kill()`
 * only signals the child process; on Unix the `/dev/ptmx` master FD stays
 * open until `destroy()` is called (or the IPty wrapper is GC'd, but the
 * native binding retains a reference until then). Without this, every
 * pool-exit path leaks an FD — and #7892 showed the crash-loop multiplied
 * the leak by ~60 FDs/iter until the system-wide `ptmx_max` (≈511 on macOS)
 * was hit.
 *
 * `destroy()` exists on UnixTerminal and WindowsTerminal but is not on the
 * exported `IPty` TypeScript interface; access it structurally and fall back
 * to `kill()` when missing (e.g. test mocks). Both calls are wrapped in
 * try/catch because either may throw on an already-dead handle.
 */
export function destroyPty(p: pty.IPty): void {
  // Windows ConPTY double-free guard (#9551). node-pty's WindowsTerminal routes
  // BOTH destroy() and kill() into a deferred native `_ptyNative.kill(this._pty)`
  // (destroy() simply defers a kill()). So the cross-platform "destroy() then
  // kill()" sequence below issues *two* native kills on the same pty handle,
  // double-freeing the pseudoconsole and crashing the pty-host Utility process
  // with STATUS_HEAP_CORRUPTION (exit 0xC0000374) — observed in the Windows
  // smoke build during rapid terminal teardown. Worse, once the child has
  // exited, node-pty's `_$onProcessExit` has already freed the handle, so any
  // kill at all is a use-after-free.
  //
  // Windows has no master /dev/ptmx fd to release (#9539 is Unix-only: there
  // destroy() closes the leaked master socket), so on a real Windows pty a
  // single kill() on a still-live handle — and nothing at all once it has
  // exited — is both sufficient and the safe maximum. Test mocks expose no
  // `_agent`, so they fall through to the Unix path and behavior is unchanged.
  const agent = (p as unknown as { _agent?: { exitCode?: number } })._agent;
  if (process.platform === "win32" && agent !== undefined) {
    if (typeof agent.exitCode === "number") {
      return; // already exited — native agent has freed the pseudoconsole
    }
    try {
      p.kill();
    } catch {
      // Already dead — ignore.
    }
    return;
  }

  const withDestroy = p as pty.IPty & { destroy?: () => void };
  try {
    withDestroy.destroy?.();
  } catch {
    // Already destroyed or socket closed — destroy() is idempotent in node-pty,
    // but mocks/future versions may throw.
  }
  try {
    p.kill();
  } catch {
    // Already dead — ESRCH on Unix, similar on Windows.
  }
}

export interface AcquiredPty {
  process: pty.IPty;
  /** Bytes the pooled shell emitted before acquire. May be empty. */
  prelude: string;
  /** Takes ownership of bytes emitted after acquire and before live attach. */
  dataHandoff: PooledPtyDataHandoff;
}

export interface PooledPtyDataHandoff {
  takeOver(handler: (data: string) => void): IDisposable;
  dispose(): void;
}

export class BufferedPtyDataHandoff implements PooledPtyDataHandoff {
  private handler: ((data: string) => void) | null = null;
  private buffered: string[] = [];
  private isDisposed = false;

  constructor(private dataDisposable: IDisposable | null = null) {}

  setDataDisposable(dataDisposable: IDisposable): void {
    if (this.isDisposed) {
      dataDisposable.dispose();
      return;
    }
    this.dataDisposable?.dispose();
    this.dataDisposable = dataDisposable;
  }

  handle(data: string): void {
    if (this.isDisposed) return;
    if (this.handler) {
      this.handler(data);
      return;
    }
    this.buffered.push(data);
  }

  takeOver(handler: (data: string) => void): IDisposable {
    if (this.isDisposed) {
      return { dispose: () => {} };
    }
    if (this.handler) {
      throw new Error("Pooled PTY data handoff already taken over");
    }

    this.handler = handler;
    const buffered = this.buffered;
    this.buffered = [];
    for (const chunk of buffered) {
      if (this.isDisposed) break;
      handler(chunk);
    }

    return {
      dispose: () => this.dispose(),
    };
  }

  dispose(): void {
    if (this.isDisposed) return;
    this.isDisposed = true;
    this.buffered = [];
    this.handler = null;
    this.dataDisposable?.dispose();
    this.dataDisposable = null;
  }
}

function makePoolKey(cwd: string, envHash: string): string {
  return `${cwd}\0${envHash}`;
}

export class PtyPool {
  private pool: Map<string, PooledPty> = new Map();
  private readonly poolSize: number;
  private readonly maxEntries: number;
  private readonly defaultShell: string;
  private defaultCwd: string;
  private isDisposed = false;
  private refillInProgress = false;
  /**
   * Set of pool keys currently being warmed via warmForKey. Prevents stampede
   * when concurrent acquire-misses for the same (cwd, envHash) all attempt to
   * warm a fresh slot.
   */
  private readonly warmsInFlight: Set<string> = new Set();
  /**
   * Per-key fast-exit accounting. Incremented whenever a pool entry's onExit
   * fires within FAST_EXIT_THRESHOLD_MS of spawn; trips the circuit breaker
   * at MAX_KEY_FAILURES and holds it for KEY_BACKOFF_MS. Without this the
   * onExit→refillPool cascade for a doomed (cwd, envHash) is unbounded and
   * leaks an FD per cycle (#7892).
   */
  private readonly keyFailures: Map<string, PoolFailureState> = new Map();
  /**
   * Generation counter incremented on each drainAndRefill() call.
   * Captured in createPoolEntry closures so async spawns from a prior
   * drain cycle can be rejected instead of registering at the new cwd.
   */
  private drainEpoch = 0;

  constructor(config: PtyPoolConfig = {}) {
    this.poolSize = this.resolvePoolSize(config.poolSize);
    this.maxEntries = this.resolveMaxEntries(config.maxEntries);
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

    // drainAndRefill() ends with warmPool(), which would otherwise let a
    // post-trip project switch re-enter the crash loop on the same blocked
    // (cwd, env-empty) key. Gate warmPool with the same breaker as refillPool.
    if (this.isKeyBlocked(makePoolKey(this.defaultCwd, POOL_ENV_EMPTY_HASH))) {
      return;
    }

    const promises: Promise<void>[] = [];
    const existing = this.countEntriesForKey(this.defaultCwd, POOL_ENV_EMPTY_HASH);
    const needed = this.poolSize - existing;

    for (let i = 0; i < needed; i++) {
      promises.push(this.createPoolEntry(this.defaultCwd, undefined, POOL_ENV_EMPTY_HASH));
    }

    await Promise.all(promises);

    if (process.env.DAINTREE_VERBOSE) {
      console.log(
        `[PtyPool] Warmed ${needed} terminals in ${this.defaultCwd} (pool size: ${this.pool.size})`
      );
    }
  }

  private async createPoolEntry(
    cwd: string,
    callerEnv: Record<string, string> | undefined,
    envHash: string
  ): Promise<void> {
    if (this.isDisposed) return;

    // Capture the current drain epoch. If it changes before we finish
    // registering this entry, a drainAndRefill() happened and this spawn
    // is stale — kill it instead of registering at the wrong cwd.
    const epoch = this.drainEpoch;
    const poolKey = makePoolKey(cwd, envHash);

    // Evict an idle entry if we're at the global cap. We evict from a
    // *different* key when possible so the warm we're about to perform
    // actually grows this key's slot count.
    this.evictIfAtCapacity(poolKey);

    try {
      const id = `pool-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
      const env = this.buildSpawnEnv(callerEnv);

      const ptyProcess = pty.spawn(this.defaultShell, getDefaultShellArgs(this.defaultShell), {
        name: "xterm-256color",
        cols: 80,
        rows: 24,
        cwd,
        env,
      });

      const entry: PooledPty = {
        process: ptyProcess,
        cwd,
        envHash,
        poolKey,
        env,
        createdAt: Date.now(),
        dataDisposable: { dispose: () => {} },
        alive: true,
        prelude: "",
      };

      // Hold a reference so the data listener can append into the same entry
      // without a Map lookup on every chunk. Set it before registering onData:
      // fast macOS shells can emit prompt bytes synchronously during listener
      // registration.
      const entryRef: { current: PooledPty | null } = { current: null };
      entryRef.current = entry;
      const dataDisposable = ptyProcess.onData((data) => {
        const entry = entryRef.current;
        if (!entry) return;
        if (entry.dataHandoff) {
          entry.dataHandoff.handle(data);
          return;
        }
        if (entry.prelude.length >= PRELUDE_BYTE_CAP) return;
        const remaining = PRELUDE_BYTE_CAP - entry.prelude.length;
        entry.prelude += data.length <= remaining ? data : data.slice(0, remaining);
      });
      entry.dataDisposable = dataDisposable;

      ptyProcess.onExit(({ exitCode }) => {
        if (process.env.DAINTREE_VERBOSE) {
          console.log(`[PtyPool] Pooled PTY ${id} exited with code ${exitCode}`);
        }
        const entry = this.pool.get(id);
        if (!entry) {
          // Entry was already removed (drain, evict, or acquire path). Those
          // paths handle their own followup and FD cleanup; refilling or
          // counting failures here would race them.
          return;
        }
        entry.alive = false;
        entry.dataDisposable.dispose();
        // Remove from the pool BEFORE destroying. Real node-pty delivers
        // onExit via libuv (always async), so synchronous re-entry can't
        // happen — but the invariant "removed from map → never re-observed"
        // matches dispose()/evictIfAtCapacity()/drainAndRefill() and makes
        // the code easier to reason about.
        this.pool.delete(id);
        destroyPty(entry.process);
        this.recordFastExit(entry.poolKey, entry.createdAt);
        // Skip refill if this entry belonged to a prior drain cycle — a
        // newer drainAndRefill() already initiated its own refill.
        if (!this.isDisposed && this.drainEpoch === epoch) {
          this.refillPool();
        }
      });

      if (this.isDisposed || this.drainEpoch !== epoch) {
        dataDisposable.dispose();
        destroyPty(ptyProcess);
        return;
      }

      this.pool.set(id, entry);

      if (process.env.DAINTREE_VERBOSE) {
        console.log(
          `[PtyPool] Created pooled PTY ${id} for key ${poolKey}, pool size: ${this.pool.size}`
        );
      }
    } catch (error) {
      console.error("[PtyPool] Failed to create pool entry:", error);
    }
  }

  /**
   * Backward-compatible zero-arg acquire — used only by tests and legacy
   * callers. Internally targets the env-empty key at the pool's default cwd.
   */
  acquire(): AcquiredPty | null {
    return this.acquireByKey(this.defaultCwd, POOL_ENV_EMPTY_HASH);
  }

  /**
   * Acquire a pre-warmed PTY for a specific (cwd, envHash) key. Returns null
   * if no matching entry exists. Triggers a background refill of the same key
   * so the next acquire is also instant.
   *
   * The returned `prelude` is whatever the pooled shell printed before
   * acquire (banner, MOTD, first prompt). Callers MUST replay this through
   * the renderer's data path or the user will see a blank pane until they
   * type something — see #7625 for the failure mode this prevents.
   */
  acquireByKey(cwd: string, envHash: string, terminalId?: string): AcquiredPty | null {
    if (this.isDisposed) {
      console.warn("[PtyPool] Cannot acquire - pool disposed");
      return null;
    }

    const wantedKey = makePoolKey(cwd, envHash);
    let matched: { id: string; entry: PooledPty } | null = null;
    for (const [id, entry] of this.pool) {
      if (entry.poolKey === wantedKey) {
        matched = { id, entry };
        break;
      }
    }

    if (!matched) {
      if (process.env.DAINTREE_VERBOSE) {
        console.log(`[PtyPool] Miss on key ${wantedKey}; pool size: ${this.pool.size}`);
      }
      if (isHostPerformanceCaptureEnabled()) {
        markHostPerformance(PERF_MARKS.POOL_MISS, { cwd, envHash, terminalId });
      }
      return null;
    }

    const { id, entry } = matched;
    this.pool.delete(id);

    // Liveness check. `alive` is set false by the onExit handler — it tracks
    // actual process exit, unlike the prior `pid !== undefined` probe which
    // was always truthy because pid persists on the IPty JS wrapper after the
    // child has exited. The pid undefined branch is kept as a defensive check
    // for a corrupted spawn handle that never received a pid; both paths fall
    // through to discard + background warm.
    let dead = !entry.alive;
    if (!dead) {
      try {
        if (entry.process.pid === undefined) {
          dead = true;
        }
      } catch (error) {
        console.warn(`[PtyPool] Pooled PTY ${id} health check failed:`, error);
        dead = true;
      }
    }

    if (dead) {
      console.warn(`[PtyPool] Pooled PTY ${id} already dead, discarding`);
      entry.alive = false;
      entry.dataDisposable.dispose();
      destroyPty(entry.process);
      this.warmForKey(cwd, entry.env, envHash);
      if (isHostPerformanceCaptureEnabled()) {
        markHostPerformance(PERF_MARKS.POOL_MISS, { cwd, envHash, terminalId });
      }
      return null;
    }

    const dataHandoff = new BufferedPtyDataHandoff(entry.dataDisposable);
    entry.dataHandoff = dataHandoff;
    const prelude = entry.prelude;

    if (process.env.DAINTREE_VERBOSE) {
      console.log(
        `[PtyPool] Acquired PTY ${id} for key ${wantedKey} (prelude=${prelude.length}B), ${this.pool.size} remaining`
      );
    }

    if (isHostPerformanceCaptureEnabled()) {
      markHostPerformance(PERF_MARKS.POOL_HIT, {
        cwd,
        envHash,
        terminalId,
        preludeBytes: prelude.length,
      });
    }

    // Refill the same key so the next acquire is also instant. Fire-and-
    // forget — the spawn races shell init with the user typing, and either
    // way is fine.
    this.warmForKey(cwd, entry.env, envHash);

    return { process: entry.process, prelude, dataHandoff };
  }

  /**
   * Fire-and-forget warm of a single (cwd, envHash) slot. Idempotent under
   * concurrent calls for the same key — the `warmsInFlight` guard prevents
   * stampede when many acquires miss simultaneously.
   *
   * `callerEnv` is the raw `options.env` from the spawn request (pre-filter,
   * pre-DAINTREE-metadata). `buildSpawnEnv` filters and finalises it.
   */
  warmForKey(cwd: string, callerEnv: Record<string, string> | undefined, envHash: string): void {
    if (this.isDisposed) return;

    const key = makePoolKey(cwd, envHash);
    if (this.isKeyBlocked(key)) return;
    if (this.warmsInFlight.has(key)) return;
    if (this.countEntriesForKey(cwd, envHash) >= this.poolSize) return;

    this.warmsInFlight.add(key);
    this.createPoolEntry(cwd, callerEnv, envHash)
      .catch((err) => {
        console.error(`[PtyPool] Failed to warm key ${key}:`, err);
      })
      .finally(() => {
        this.warmsInFlight.delete(key);
      });
  }

  refillPool(): void {
    if (this.isDisposed || this.refillInProgress) {
      return;
    }

    // Circuit-break before claiming `refillInProgress` so a blocked key
    // doesn't lock the flag for the cooldown window. The (defaultCwd,
    // POOL_ENV_EMPTY_HASH) key is the only one refillPool ever warms; the
    // arbitrary-key path is `warmForKey`, which has its own breaker check.
    if (this.isKeyBlocked(makePoolKey(this.defaultCwd, POOL_ENV_EMPTY_HASH))) {
      return;
    }

    const existing = this.countEntriesForKey(this.defaultCwd, POOL_ENV_EMPTY_HASH);
    const needed = this.poolSize - existing;
    if (needed <= 0) {
      return;
    }

    this.refillInProgress = true;

    const promises: Promise<void>[] = [];
    for (let i = 0; i < needed; i++) {
      promises.push(this.createPoolEntry(this.defaultCwd, undefined, POOL_ENV_EMPTY_HASH));
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

    if (
      nextCwd === this.defaultCwd &&
      this.countEntriesForKey(nextCwd, POOL_ENV_EMPTY_HASH) >= this.poolSize
    ) {
      // Already at the requested cwd and the env-empty key is fully warmed —
      // nothing to do. (Other env-keyed entries from prior agent launches may
      // exist and stay; they'll be evicted naturally by LRU as needed.)
      return;
    }

    // Bump epoch BEFORE killing so onExit handlers (and any in-flight
    // createPoolEntry promises) see the mismatch and skip refilling.
    this.drainEpoch++;
    this.defaultCwd = nextCwd;

    const snapshot = Array.from(this.pool.values());
    this.pool.clear();

    for (const entry of snapshot) {
      entry.alive = false;
      try {
        entry.dataDisposable.dispose();
      } catch {
        // ignore
      }
      destroyPty(entry.process);
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

  getMaxEntries(): number {
    return this.maxEntries;
  }

  /** Number of entries currently held for a specific (cwd, envHash) key. */
  countEntriesForKey(cwd: string, envHash: string): number {
    const key = makePoolKey(cwd, envHash);
    let count = 0;
    for (const entry of this.pool.values()) {
      if (entry.poolKey === key) count++;
    }
    return count;
  }

  dispose(): void {
    if (this.isDisposed) return;

    this.isDisposed = true;

    // Snapshot + clear BEFORE destroying so the destroyPty→kill→onExit chain
    // sees an empty pool and skips re-processing the same entry (which would
    // double-call destroy and dataDisposable.dispose for every entry).
    const entries = Array.from(this.pool.entries());
    this.pool.clear();

    for (const [id, entry] of entries) {
      entry.alive = false;
      try {
        entry.dataDisposable.dispose();
      } catch (error) {
        console.warn(`[PtyPool] Error disposing pooled PTY ${id} data listener:`, error);
      }
      destroyPty(entry.process);
      if (process.env.DAINTREE_VERBOSE) {
        console.log(`[PtyPool] Killed pooled PTY ${id}`);
      }
    }

    this.keyFailures.clear();
    console.log("[PtyPool] Disposed");
  }

  /**
   * If the pool is at the global cap, evict the oldest entry whose key does
   * NOT match `incomingKey` (so the warm we're about to do actually grows
   * that key's count). If only same-key entries exist, fall back to evicting
   * the oldest of those — the slot count for that key stays equal post-warm.
   */
  private evictIfAtCapacity(incomingKey: string): void {
    if (this.pool.size < this.maxEntries) return;

    let victim: { id: string; entry: PooledPty } | null = null;
    let fallbackVictim: { id: string; entry: PooledPty } | null = null;
    for (const [id, entry] of this.pool) {
      if (entry.poolKey !== incomingKey) {
        if (!victim || entry.createdAt < victim.entry.createdAt) {
          victim = { id, entry };
        }
      } else if (!fallbackVictim || entry.createdAt < fallbackVictim.entry.createdAt) {
        fallbackVictim = { id, entry };
      }
    }

    const chosen = victim ?? fallbackVictim;
    if (!chosen) return;

    this.pool.delete(chosen.id);
    chosen.entry.alive = false;
    try {
      chosen.entry.dataDisposable.dispose();
    } catch {
      // ignore
    }
    destroyPty(chosen.entry.process);

    if (process.env.DAINTREE_VERBOSE) {
      console.log(
        `[PtyPool] Evicted ${chosen.id} (key ${chosen.entry.poolKey}) to make room for ${incomingKey}`
      );
    }
  }

  /**
   * Circuit-breaker check for the automatic refill paths. Returns true while
   * `blockedUntil` is in the future. On expiry the entry is deleted so the
   * count resets lazily — eager reset on a single non-fast exit would let a
   * borderline-fast shell oscillate the breaker open/closed (lesson from
   * the powerMonitor circuit breaker, #518).
   *
   * `acquireByKey` does NOT consult this — explicit user-triggered acquires
   * must still get a fresh fall-through spawn. The breaker only gates the
   * background `refillPool` / `warmForKey` paths that would otherwise burn
   * FDs in a spawn-exit loop.
   */
  private isKeyBlocked(poolKey: string): boolean {
    const state = this.keyFailures.get(poolKey);
    if (!state) return false;
    if (state.blockedUntil > Date.now()) return true;
    if (state.blockedUntil > 0) {
      // Cooldown expired — reset so the next fast-exit starts a fresh count.
      this.keyFailures.delete(poolKey);
    }
    return false;
  }

  /**
   * Record a pool entry exit. Counts toward the circuit breaker only if the
   * entry lived <FAST_EXIT_THRESHOLD_MS — a normal long-lived idle exit
   * (system going to sleep, user killing the shell after acquire, etc.)
   * shouldn't accumulate failures.
   */
  private recordFastExit(poolKey: string, createdAt: number): void {
    const lifetime = Date.now() - createdAt;
    if (lifetime >= FAST_EXIT_THRESHOLD_MS) return;

    const state = this.keyFailures.get(poolKey) ?? { count: 0, blockedUntil: 0 };
    state.count += 1;
    if (state.count >= MAX_KEY_FAILURES) {
      state.blockedUntil = Date.now() + KEY_BACKOFF_MS;
      console.warn(
        `[PtyPool] Circuit breaker tripped for key ${poolKey} after ${state.count} fast exits — ` +
          `pausing refill for ${KEY_BACKOFF_MS}ms`
      );
    }
    this.keyFailures.set(poolKey, state);
  }

  /**
   * Build the env that's actually written into the spawned shell.
   *
   * Two different filter strengths are applied:
   *
   *   - **Inherited `process.env`** runs through the full `filterEnvironment`,
   *     which strips both sensitive vars AND `DAINTREE_*` keys. The latter is
   *     anti-spoofing: only `injectDaintreeMetadata` (fresh-spawn path) is
   *     allowed to set DAINTREE_*; anything inherited from the OS env is
   *     dropped.
   *
   *   - **Caller `options.env`** runs through `filterSensitiveOnly`, which
   *     strips only credentials. Pool entries outlive a single acquire, so a
   *     shell warmed with one caller's secrets could be handed to a future
   *     caller whose hash matches — filtering at warm time guarantees no
   *     secret persists in an idle pool process. But `DAINTREE_*` keys are
   *     **kept** here: the caller is intentionally setting them (e.g. e2e
   *     presets pass DAINTREE_E2E_AGENT_COLOR through so the agent CLI can
   *     read it). Stripping them caused #7625-class regressions where the
   *     pool key collapsed to env-empty and warm shells were served without
   *     the caller's metadata.
   *
   * DAINTREE_* metadata for live panes (PANE_ID, CWD, PROJECT_ID, WORKTREE_ID)
   * is NOT injected here — pool entries don't have a paneId until acquire
   * time, and that metadata is meaningful only for the assigned terminal.
   */
  private buildSpawnEnv(callerEnv: Record<string, string> | undefined): Record<string, string> {
    const filtered = filterEnvironment(process.env as Record<string, string | undefined>);

    if (callerEnv) {
      Object.assign(filtered, filterSensitiveOnly(callerEnv));
    }

    // TUI reliability: ensure rich terminal capabilities for Claude/Gemini CLIs.
    // Mirrors `buildTerminalEnv` so agent CLIs get the same color-rendering
    // hints whether they spawn fresh or come out of the pool.
    filtered.TERM = "xterm-256color";
    filtered.FORCE_COLOR = filtered.FORCE_COLOR ?? "3";
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

  private resolveMaxEntries(maxEntries: number | undefined): number {
    if (
      typeof maxEntries === "number" &&
      Number.isInteger(maxEntries) &&
      Number.isFinite(maxEntries) &&
      maxEntries > 0
    ) {
      return Math.max(maxEntries, this.poolSize);
    }
    return Math.max(DEFAULT_MAX_ENTRIES, this.poolSize);
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
