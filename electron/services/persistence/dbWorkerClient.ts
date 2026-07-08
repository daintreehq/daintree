import path from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { getDbPath, getSharedSqlite } from "./db.js";
import type {
  DbWorkerData,
  DbWorkerOp,
  DbWorkerRequest,
  DbWorkerResponse,
} from "./dbWorkerProtocol.js";
import type { WorkerResourceSnapshot } from "../../../shared/types/workerGovernance.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const REQUEST_TIMEOUT_MS = 30_000;
const SHUTDOWN_DRAIN_TIMEOUT_MS = 5_000;
// The Electron `!flush_tasks_` crash is triggered by repeated worker
// spawn/terminate cycles, so the worker is persistent (spawned once, never
// terminate()'d) and respawn-after-crash is capped hard.
const MAX_SPAWN_ATTEMPTS = 3;

/**
 * Resolves the compiled maintenance worker on disk. esbuild may emit this
 * module into a shared chunk under `dist-electron/electron/chunks/`, so
 * `__dirname` can point at that chunks dir — step up to the electron root, then
 * down to the worker's own bundle. Mirrors `resolveVadWorkerPath()` in
 * `OpenAITranscriptionProvider.ts`.
 */
function resolveDbWorkerPath(): string {
  const electronDir = path.basename(__dirname) === "chunks" ? path.dirname(__dirname) : __dirname;
  return path.join(electronDir, "services", "persistence", "dbMaintenanceWorker.js");
}

/** Narrow view of the main better-sqlite3 handle used for fence reads/bumps. */
export interface DbFenceHandle {
  pragma(source: string, options?: { simple?: boolean }): unknown;
}

export interface DbWorkerClientDeps {
  spawnWorker: () => Worker;
  isDbReady: () => boolean;
  isDisabled: () => boolean;
  getMainSqlite: () => DbFenceHandle | null;
  requestTimeoutMs: number;
  shutdownDrainTimeoutMs: number;
}

const defaultDeps: DbWorkerClientDeps = {
  spawnWorker: () =>
    new Worker(resolveDbWorkerPath(), {
      workerData: { dbPath: getDbPath() } satisfies DbWorkerData,
    }),
  // The worker opens a second connection to the same file — main's
  // openDb/migrate must have completed first. Spawn-on-first-use is post-boot
  // in practice; this makes it a hard invariant.
  isDbReady: () => getSharedSqlite() !== null,
  isDisabled: () => process.env.DAINTREE_DISABLE_DB_WORKER === "1",
  getMainSqlite: () => getSharedSqlite(),
  requestTimeoutMs: REQUEST_TIMEOUT_MS,
  shutdownDrainTimeoutMs: SHUTDOWN_DRAIN_TIMEOUT_MS,
};

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class DbWorkerClient {
  private readonly deps: DbWorkerClientDeps;
  private worker: Worker | null = null;
  private readonly pending = new Map<number, PendingRequest>();
  private nextRequestId = 1;
  private spawnAttempts = 0;
  private degraded = false;
  private shuttingDown = false;
  private fenceEpoch: number | null = null;
  private lastRequestAt: number | null = null;

  constructor(deps: Partial<DbWorkerClientDeps> = {}) {
    this.deps = { ...defaultDeps, ...deps };
  }

  /**
   * Run `op` on the worker thread; on any failure (kill switch, DB not open
   * yet, spawn failure, worker crash, timeout) run `fallback` synchronously on
   * the main thread instead — the pre-worker behavior.
   */
  async run<T>(op: DbWorkerOp, fallback: () => T): Promise<T> {
    if (!this.canUseWorker()) {
      return fallback();
    }
    try {
      return (await this.request(op)) as T;
    } catch (error) {
      console.warn(`[DbWorker] "${op.op}" failed — running on main thread:`, error);
      return fallback();
    }
  }

  /**
   * Advance the DB-level write fence when a synchronous main-thread ring write
   * is about to run while a worker exists. Any ring write already queued on the
   * worker was stamped with the previous epoch and will no-op, so an older
   * snapshot can never land after the newer synchronous one. Collateral: queued
   * snapshots for OTHER rings are dropped too — harmless, since every write is
   * a full snapshot and the owner's next flush rewrites it.
   */
  fence(): void {
    if (this.worker === null && this.pending.size === 0) return;
    this.advanceFence();
  }

  /**
   * Drain queued work and stop the worker via a `close` message (never
   * `terminate()` — Electron's repeated spawn/terminate worker crash). The
   * worker services messages FIFO, so the close response confirms every
   * previously queued write was applied — but the wait is capped, and a worker
   * that outlives the cap could still commit queued writes later in the
   * shutdown window. The fence advance below makes any such late ring write a
   * no-op. After this resolves, every subsequent `run()` executes its fallback
   * synchronously on main — exactly what the shutdown-time `flushNow()` drains
   * need.
   */
  async shutdown(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    if (this.worker) {
      try {
        await Promise.race([
          this.request({ op: "close" }),
          new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, this.deps.shutdownDrainTimeoutMs);
            timer.unref?.();
          }),
        ]);
      } catch {
        // Worker already gone — nothing left to drain.
      }
      this.fence();
    }
  }

  private canUseWorker(): boolean {
    if (this.degraded || this.shuttingDown) return false;
    if (this.deps.isDisabled()) return false;
    if (this.worker === null && !this.deps.isDbReady()) return false;
    return true;
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    if (this.spawnAttempts >= MAX_SPAWN_ATTEMPTS) {
      this.degraded = true;
      throw new Error("db worker spawn attempts exhausted");
    }
    this.spawnAttempts++;
    const worker = this.deps.spawnWorker();
    // The maintenance worker must never keep the app alive.
    worker.unref();
    worker.on("message", (response: DbWorkerResponse) => this.settle(response));
    worker.on("error", (error) => this.handleWorkerDown(worker, `error: ${error.message}`));
    worker.on("exit", (code) => this.handleWorkerDown(worker, `exited with code ${code}`));
    this.worker = worker;
    return worker;
  }

  /**
   * Governance snapshot — strictly observational. The DB worker is never
   * trim/dispose/restart-eligible: its FIFO queue carries write ordering, the
   * user_version fence assumes the worker dies only via crash or the shutdown
   * `close` drain, and a governance-initiated teardown would add a third
   * lifecycle path for zero memory win (the worker holds one SQLite
   * connection, not data).
   */
  getGovernanceSnapshot(): WorkerResourceSnapshot {
    return {
      kind: "db-worker",
      id: "db-maintenance-worker",
      pid: null,
      threadId: this.worker?.threadId ?? null,
      alive: this.worker !== null,
      activeSessionCount: 0,
      queueDepth: this.pending.size,
      lastActivityAt: this.lastRequestAt,
      memory: null,
      eligibility: { trim: false, dispose: false, restart: false },
      state: this.degraded
        ? "degraded"
        : this.shuttingDown
          ? "shutting-down"
          : this.worker
            ? "running"
            : "not-spawned",
      detail: { spawnAttempts: this.spawnAttempts, fenceEpoch: this.fenceEpoch },
    };
  }

  private request(op: DbWorkerOp): Promise<unknown> {
    const worker = this.ensureWorker();
    const id = this.nextRequestId++;
    this.lastRequestAt = Date.now();
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        // A wedged worker could apply a stale queued write AFTER a main-thread
        // fallback ran. Degrade permanently, then fail every pending request in
        // FIFO order — failAllPending advances the fence first, so anything
        // still queued on the worker no-ops, and the fallbacks replay in
        // submission order ahead of any later synchronous write.
        this.degraded = true;
        this.failAllPending(new Error(`db worker request timed out: ${op.op}`));
      }, this.deps.requestTimeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      try {
        worker.postMessage({ ...op, id, fence: this.currentFence() } satisfies DbWorkerRequest);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private settle(response: DbWorkerResponse): void {
    const entry = this.pending.get(response.id);
    if (!entry) return;
    this.pending.delete(response.id);
    clearTimeout(entry.timer);
    if (response.ok) {
      entry.resolve(response.result);
    } else {
      entry.reject(new Error(response.error));
    }
  }

  private handleWorkerDown(worker: Worker, reason: string): void {
    if (this.worker !== worker) return;
    this.worker = null;
    if (this.spawnAttempts >= MAX_SPAWN_ATTEMPTS) {
      this.degraded = true;
    }
    this.failAllPending(new Error(`db worker unavailable: ${reason}`));
  }

  private failAllPending(error: Error): void {
    if (this.pending.size === 0) return;
    this.advanceFence();
    const entries = [...this.pending.values()];
    this.pending.clear();
    for (const entry of entries) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
  }

  /**
   * Bump `PRAGMA user_version` on the MAIN connection. Worker requests are
   * stamped with the epoch current at post time and the worker re-reads
   * user_version inside its immediate write transaction, so SQLite's writer
   * serialization guarantees that once the bump commits, every still-queued
   * ring write no-ops.
   */
  private advanceFence(): void {
    const db = this.deps.getMainSqlite();
    if (!db) return;
    try {
      const next = this.currentFence() + 1;
      db.pragma(`user_version = ${next}`);
      this.fenceEpoch = next;
    } catch (error) {
      console.warn("[DbWorker] Failed to advance write fence:", error);
    }
  }

  private currentFence(): number {
    if (this.fenceEpoch === null) {
      const db = this.deps.getMainSqlite();
      const value = db ? Number(db.pragma("user_version", { simple: true })) : 0;
      this.fenceEpoch = Number.isFinite(value) ? value : 0;
    }
    return this.fenceEpoch;
  }
}

let instance: DbWorkerClient | null = null;

export function getDbWorkerClient(): DbWorkerClient {
  if (!instance) {
    instance = new DbWorkerClient();
  }
  return instance;
}

export function runDbWork<T>(op: DbWorkerOp, fallback: () => T): Promise<T> {
  return getDbWorkerClient().run(op, fallback);
}

/**
 * Fence any queued worker ring writes before a synchronous main-thread write.
 * No-ops when the client (and thus the worker) was never created.
 */
export function fenceDbWorkerWrites(): void {
  instance?.fence();
}

export async function shutdownDbWorker(): Promise<void> {
  if (instance) {
    await instance.shutdown();
  }
}

/**
 * Governance snapshot for the singleton, or null when no client was ever
 * created (reporting must not instantiate the worker machinery).
 */
export function getDbWorkerGovernanceSnapshot(): WorkerResourceSnapshot | null {
  return instance ? instance.getGovernanceSnapshot() : null;
}
