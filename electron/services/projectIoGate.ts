import path from "path";
import { logInfo, logWarn } from "../utils/logger.js";

/**
 * Bounds how much of Main's libuv threadpool reads of project-owned files can
 * hold (#16361).
 *
 * Main's async `fs` calls share one 4-thread pool, and a read the kernel never
 * finishes (an online-only cloud placeholder waiting on its download, a dead
 * network mount, a FIFO) keeps its worker no matter how the caller gives up:
 * `withTimeout` and `AbortSignal` only stop the waiting. A handful of such
 * reads used to pin every worker, and with them the `app://` handler, the CLI
 * availability check and every later project switch.
 *
 * Each request is a single filesystem call that is issued only once admitted.
 * At most {@link ProjectIoLimits.maxInFlightPerRoot} runs per project root and
 * {@link ProjectIoLimits.maxInFlight} across all roots, so the rest of the pool
 * always stays free for Main's own I/O. A request that outlives its deadline
 * keeps its slot until the kernel actually returns, and its root is marked
 * stalled: later reads for that root fail at once instead of queueing behind
 * it, so a stuck project shows up as failed reads for that project alone.
 */

export type ProjectIoErrorCode =
  /** The deadline passed before a slot came free; nothing was issued. */
  | "PROJECT_IO_TIMEOUT"
  /** A request under this root has outlived its deadline and still holds its worker. */
  | "PROJECT_IO_STALLED"
  /** Every project slot is held by a stalled request, or the queue is full. */
  | "PROJECT_IO_BUSY";

export class ProjectIoError extends Error {
  readonly code: ProjectIoErrorCode;
  readonly root: string;

  constructor(code: ProjectIoErrorCode, root: string, message: string) {
    super(message);
    this.name = "ProjectIoError";
    this.code = code;
    this.root = root;
  }
}

export function isProjectIoError(error: unknown): error is ProjectIoError {
  return error instanceof ProjectIoError;
}

export interface ProjectIoOptions {
  /** How long the caller will wait, queueing included. Defaults to the gate's. */
  timeoutMs?: number;
  /** Absolute deadline on the `performance.now()` clock; the earlier bound wins. */
  deadline?: number;
}

export interface ProjectIoLimits {
  maxInFlight: number;
  maxInFlightPerRoot: number;
  maxQueued: number;
  maxQueuedPerRoot: number;
  defaultTimeoutMs: number;
}

const DEFAULT_LIMITS: ProjectIoLimits = {
  // Two of the default four workers; the other two stay with Main.
  maxInFlight: 2,
  maxInFlightPerRoot: 1,
  // A safety net only: queued requests expire with their deadline anyway.
  maxQueued: 1024,
  maxQueuedPerRoot: 256,
  defaultTimeoutMs: 2_000,
};

interface Lane {
  active: number;
  stalled: number;
  queued: number;
}

interface Waiter {
  key: string;
  /** On the gate's clock; a queued request is never started at or past it. */
  expiresAt: number;
  start: () => void;
  fail: (error: ProjectIoError) => void;
  expire: () => void;
}

export class ProjectIoGate {
  private readonly limits: ProjectIoLimits;
  private readonly now: () => number;
  private readonly lanes = new Map<string, Lane>();
  private queue: Waiter[] = [];
  private inFlight = 0;
  private stalled = 0;

  constructor(options: { limits?: Partial<ProjectIoLimits>; now?: () => number } = {}) {
    this.limits = { ...DEFAULT_LIMITS, ...options.limits };
    this.now = options.now ?? (() => performance.now());
  }

  isStalled(root: string): boolean {
    return (this.lanes.get(laneKey(root))?.stalled ?? 0) > 0;
  }

  /**
   * Run `request` once a slot under `root` is free. It must issue exactly one
   * filesystem call: a slot stands for one libuv worker, so a request that fans
   * out would hold more of the pool than the gate accounts for.
   */
  run<T>(root: string, request: () => Promise<T>, options?: ProjectIoOptions): Promise<T> {
    const key = laneKey(root);
    const lane = this.lanes.get(key);

    if (lane && lane.stalled > 0) {
      return Promise.reject(
        new ProjectIoError("PROJECT_IO_STALLED", key, `Reads under ${key} are stalled`)
      );
    }
    if (this.stalled >= this.limits.maxInFlight) {
      return Promise.reject(
        new ProjectIoError("PROJECT_IO_BUSY", key, "Every project read slot is stalled")
      );
    }
    if (
      this.queue.length >= this.limits.maxQueued ||
      (lane?.queued ?? 0) >= this.limits.maxQueuedPerRoot
    ) {
      return Promise.reject(
        new ProjectIoError("PROJECT_IO_BUSY", key, "Project read queue is full")
      );
    }

    const budgetMs = this.budgetFor(options);
    if (budgetMs <= 0) {
      return Promise.reject(
        new ProjectIoError("PROJECT_IO_TIMEOUT", key, `Deadline passed before reading under ${key}`)
      );
    }

    const activeLane = lane ?? this.createLane(key);
    const enqueuedAt = this.now();

    return new Promise<T>((resolve, reject) => {
      let started = false;
      let callerDone = false;
      let stalledHere = false;

      const finishCaller = (): boolean => {
        if (callerDone) return false;
        callerDone = true;
        clearTimeout(timer);
        return true;
      };

      const waiter: Waiter = {
        key,
        expiresAt: enqueuedAt + budgetMs,
        start: () => {
          started = true;
          activeLane.queued--;
          activeLane.active++;
          this.inFlight++;
          let pending: Promise<T>;
          try {
            pending = request();
          } catch (error) {
            pending = Promise.reject(error);
          }
          pending.then(
            (value) => {
              this.release(key, activeLane, stalledHere);
              if (finishCaller()) resolve(value);
            },
            (error: unknown) => {
              this.release(key, activeLane, stalledHere);
              if (finishCaller()) reject(error);
            }
          );
        },
        fail: (error) => {
          activeLane.queued--;
          if (finishCaller()) reject(error);
        },
        expire: () => {
          waiter.fail(
            new ProjectIoError(
              "PROJECT_IO_TIMEOUT",
              key,
              `Timed out after ${budgetMs}ms waiting to read under ${key}`
            )
          );
        },
      };

      const timer = setTimeout(() => {
        if (!started) {
          this.queue = this.queue.filter((queued) => queued !== waiter);
          waiter.expire();
          this.dropIfIdle(key, activeLane);
          return;
        }
        stalledHere = true;
        this.markStalled(key, activeLane, this.now() - enqueuedAt);
        if (finishCaller()) {
          reject(
            new ProjectIoError(
              "PROJECT_IO_STALLED",
              key,
              `A read under ${key} did not finish within ${budgetMs}ms`
            )
          );
        }
      }, budgetMs);
      timer.unref?.();

      activeLane.queued++;
      this.queue.push(waiter);
      this.pump();
    });
  }

  private budgetFor(options: ProjectIoOptions | undefined): number {
    let budget = options?.timeoutMs ?? this.limits.defaultTimeoutMs;
    if (options?.deadline !== undefined) {
      budget = Math.min(budget, options.deadline - this.now());
    }
    return Math.floor(budget);
  }

  private createLane(key: string): Lane {
    const lane: Lane = { active: 0, stalled: 0, queued: 0 };
    this.lanes.set(key, lane);
    return lane;
  }

  private pump(): void {
    if (this.inFlight >= this.limits.maxInFlight || this.queue.length === 0) return;
    const remaining: Waiter[] = [];
    // A slot can free up after a queued request's deadline but before its
    // timer has run; issuing it then would spend a worker on a read nobody
    // is waiting for.
    const expired: Waiter[] = [];
    const now = this.now();
    for (const waiter of this.queue) {
      if (now >= waiter.expiresAt) {
        expired.push(waiter);
        continue;
      }
      const lane = this.lanes.get(waiter.key);
      if (
        this.inFlight < this.limits.maxInFlight &&
        lane &&
        lane.stalled === 0 &&
        lane.active < this.limits.maxInFlightPerRoot
      ) {
        waiter.start();
      } else {
        remaining.push(waiter);
      }
    }
    this.queue = remaining;
    for (const waiter of expired) {
      waiter.expire();
      const lane = this.lanes.get(waiter.key);
      if (lane) this.dropIfIdle(waiter.key, lane);
    }
  }

  private markStalled(key: string, lane: Lane, elapsedMs: number): void {
    lane.stalled++;
    this.stalled++;
    if (lane.stalled === 1) {
      logWarn(
        "[ProjectIo] A read under a project has not returned; skipping its reads until it does",
        {
          root: key,
          elapsedMs: Math.round(elapsedMs),
        }
      );
    }
    this.failQueued(
      (waiter) => waiter.key === key,
      () => new ProjectIoError("PROJECT_IO_STALLED", key, `Reads under ${key} are stalled`)
    );
    if (this.stalled >= this.limits.maxInFlight) {
      this.failQueued(
        () => true,
        (waiter) =>
          new ProjectIoError("PROJECT_IO_BUSY", waiter.key, "Every project read slot is stalled")
      );
    }
  }

  private failQueued(
    matches: (waiter: Waiter) => boolean,
    errorFor: (waiter: Waiter) => ProjectIoError
  ): void {
    const failed = this.queue.filter(matches);
    if (failed.length === 0) return;
    this.queue = this.queue.filter((waiter) => !matches(waiter));
    for (const waiter of failed) {
      waiter.fail(errorFor(waiter));
      const lane = this.lanes.get(waiter.key);
      if (lane) this.dropIfIdle(waiter.key, lane);
    }
  }

  private release(key: string, lane: Lane, wasStalled: boolean): void {
    lane.active--;
    this.inFlight--;
    if (wasStalled) {
      lane.stalled--;
      this.stalled--;
      if (lane.stalled === 0) {
        logInfo("[ProjectIo] A stalled project read returned; reads resume", { root: key });
      }
    }
    this.pump();
    this.dropIfIdle(key, lane);
  }

  private dropIfIdle(key: string, lane: Lane): void {
    if (lane.active === 0 && lane.queued === 0 && this.lanes.get(key) === lane) {
      this.lanes.delete(key);
    }
  }
}

function laneKey(root: string): string {
  return path.resolve(root);
}

export let projectIo = new ProjectIoGate();

/**
 * Tests that leave a mocked request unsettled on purpose would otherwise
 * stall that root for every later test in the file.
 */
export function __resetProjectIoForTests(): void {
  projectIo = new ProjectIoGate();
}
