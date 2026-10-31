import { markPerformance } from "../utils/performance.js";
import { PERF_MARKS } from "../../shared/perf/marks.js";
import { notifyError } from "../ipc/errorHandlers.js";
import { trackEvent } from "../services/TelemetryService.js";
import { formatErrorMessage } from "../../shared/utils/errorMessage.js";

export type DeferredTask = {
  name: string;
  run: () => void | Promise<void>;
};

type DrainState = "idle" | "draining" | "drained";

const DEFAULT_FALLBACK_MS = 10_000;

let tasks: DeferredTask[] = [];
let drainState: DrainState = "idle";
let registrationComplete = false;
let firstInteractiveReceived = false;
let fallbackTimer: ReturnType<typeof setTimeout> | null = null;
const drainedSenderIds = new Set<number>();
// Incremented on every `resetDeferredQueue()`. Drain callbacks capture the
// generation at drain start; stale callbacks from a prior cycle that wake up
// via `setImmediate` after a reset bail out instead of mutating the fresh
// cycle's state. Without this, a stale `drainNext` could fire against an
// empty `tasks[]` and mark the fresh queue as "drained" before any work runs.
let generation = 0;
// Set once by `haltDeferredQueue()` when shutdown begins (`before-quit`).
// Process-lifetime: never cleared by `resetDeferredQueue()`, because on quit
// the last-window-close reset fires before `before-quit` and must not be able
// to undo the halt. Once halted, no deferred task may start — the services
// they would initialize are being torn down.
let halted = false;
// Set when the last window closes before the drain has finished. The tasks
// still waiting include global ones, which `ensureGlobalServicesInitialized()`
// registers once per process, so the close leaves them to drain and the reset
// a later window needs waits until they have. Cleared when a window finalizes
// its registration first: its tasks have already run, registered after the
// drain started, and a reset would strand its first-interactive.
let resetWhenDrained = false;

export function registerDeferredTask(task: DeferredTask): void {
  if (halted) {
    console.warn(`[DeferredInit] Task "${task.name}" dropped — queue halted for shutdown`);
    return;
  }
  if (drainState !== "idle") {
    console.warn(
      `[DeferredInit] Task "${task.name}" registered after drain started — running immediately`
    );
    try {
      const res = task.run();
      if (res instanceof Promise) {
        res.catch((err) => reportDeferredTaskFailure(task.name, err));
      }
    } catch (err) {
      reportDeferredTaskFailure(task.name, err);
    }
    return;
  }
  tasks.push(task);
}

export function finalizeDeferredRegistration(fallbackMs: number = DEFAULT_FALLBACK_MS): void {
  if (halted) return;
  resetWhenDrained = false;
  if (registrationComplete) return;
  registrationComplete = true;

  const armedGen = generation;
  fallbackTimer = setTimeout(() => {
    if (armedGen !== generation) return;
    if (drainState === "idle") {
      console.warn(
        `[DeferredInit] First-interactive fallback fired after ${fallbackMs}ms — draining queue`
      );
      doDrain();
    }
  }, fallbackMs);
  // Timer should not keep the process alive on its own
  fallbackTimer.unref?.();

  if (firstInteractiveReceived) {
    doDrain();
  }
}

export function signalFirstInteractive(webContentsId: number | null): void {
  if (halted) return;
  if (webContentsId !== null) {
    if (drainedSenderIds.has(webContentsId)) return;
    drainedSenderIds.add(webContentsId);
  }

  if (drainState !== "idle") return;

  if (!registrationComplete) {
    firstInteractiveReceived = true;
    return;
  }

  doDrain();
}

export function getDeferredQueueState(): {
  drainState: DrainState;
  registrationComplete: boolean;
  firstInteractiveReceived: boolean;
  taskCount: number;
} {
  return {
    drainState,
    registrationComplete,
    firstInteractiveReceived,
    taskCount: tasks.length,
  };
}

/**
 * Clear all queue state, abandoning any task that hasn't started. Increments
 * the generation counter so any in-flight drain callbacks from the previous
 * cycle bail out instead of mutating fresh state. The last-window close goes
 * through {@link resetDeferredQueueForNextWindow}, which only resets once
 * nothing is left to drain.
 */
export function resetDeferredQueue(): void {
  generation++;
  resetWhenDrained = false;
  tasks = [];
  drainState = "idle";
  registrationComplete = false;
  firstInteractiveReceived = false;
  if (fallbackTimer) {
    clearTimeout(fallbackTimer);
    fallbackTimer = null;
  }
  drainedSenderIds.clear();
}

/**
 * Called when the last window closes, so a window opened later — e.g. macOS
 * `activate`, or OOM recovery's replacement — gets a fresh cycle whose tasks
 * wait for its own first-interactive. Global tasks are registered once per
 * process, so a reset before the drain finishes would drop the ones it has
 * left for the rest of the session (#15562). Until then the queue keeps them:
 * a drain in flight carries on, and a queue still waiting on first-interactive
 * drains on the fallback the closed window armed. The reset follows once the
 * drain finishes, unless a new window has registered in the meantime.
 */
export function resetDeferredQueueForNextWindow(): void {
  if (halted) return;
  // A window always finalizes before it can close, so this only arms a
  // fallback if one was somehow never armed. It can drain an empty queue on
  // the spot, which the state check below then sees as drained.
  if (drainState === "idle") finalizeDeferredRegistration();
  if (drainState === "drained") {
    resetDeferredQueue();
    return;
  }
  resetWhenDrained = true;
}

/**
 * Surface a deferred-init task failure beyond the console. These failures are
 * otherwise invisible — a background service is silently absent for the rest of
 * the session — so route them through the shared error infrastructure
 * (persisted `ErrorRecord` + renderer broadcast) and telemetry. Both
 * `notifyError` and `trackEvent` are safe to call here (no throw, no-op before
 * their respective services initialize), and neither alters the queue's
 * failure-isolation guarantee: the caller still advances to the next task.
 */
function reportDeferredTaskFailure(taskName: string, err: unknown): void {
  // Reporting is best-effort and must never throw: the synchronous drain catch
  // calls this immediately before `scheduleNext()`, so a throw here would strand
  // the queue in "draining" forever. Guard the whole body — a non-Error thrown
  // value (`String(err)`) or a store-write failure inside `notifyError` must not
  // break failure isolation.
  try {
    const message = formatErrorMessage(err, "unknown error");
    console.error(`[DeferredInit] Task "${taskName}" failed:`, err);
    notifyError(new Error(`Deferred task "${taskName}" failed: ${message}`, { cause: err }), {
      source: "deferred-init",
    });
    trackEvent("deferred_init_task_failed", { taskName });
  } catch (reportErr) {
    console.error(`[DeferredInit] Failed to report failure for task "${taskName}":`, reportErr);
  }
}

/**
 * Permanently stop the queue for shutdown. Called synchronously at the start
 * of `before-quit`, before the first await, so pending `setImmediate` drain
 * callbacks observe the halt instead of re-initializing services the cleanup
 * chain is tearing down. Idempotent; never undone by `resetDeferredQueue()`.
 */
export function haltDeferredQueue(): void {
  halted = true;
  resetWhenDrained = false;
  if (fallbackTimer) {
    clearTimeout(fallbackTimer);
    fallbackTimer = null;
  }
}

/** Test-only: full reset including the process-lifetime `halted` latch. */
export function __resetDeferredQueueForTests(): void {
  resetDeferredQueue();
  halted = false;
}

function doDrain(): void {
  if (halted) return;
  if (drainState !== "idle") return;
  drainState = "draining";

  if (fallbackTimer) {
    clearTimeout(fallbackTimer);
    fallbackTimer = null;
  }

  markPerformance(PERF_MARKS.DEFERRED_SERVICES_START, { taskCount: tasks.length });
  const startedAt = Date.now();
  const drainGen = generation;
  drainNext(0, startedAt, drainGen);
}

function drainNext(index: number, startedAt: number, drainGen: number): void {
  if (drainGen !== generation || halted) return; // queue was reset or halted — abandon this chain
  if (index >= tasks.length) {
    drainState = "drained";
    const elapsed = Date.now() - startedAt;
    markPerformance(PERF_MARKS.DEFERRED_SERVICES_COMPLETE, { durationMs: elapsed });
    console.log(`[DeferredInit] Drained ${tasks.length} deferred task(s) in ${elapsed}ms`);
    // Release task closures once drained so they don't retain references to
    // destroyed windows, services, etc. until the next reset.
    tasks = [];
    if (resetWhenDrained) resetDeferredQueue();
    return;
  }

  const task = tasks[index];
  const scheduleNext = () => setImmediate(() => drainNext(index + 1, startedAt, drainGen));

  try {
    const result = task.run();
    if (result instanceof Promise) {
      result
        .catch((err) => {
          reportDeferredTaskFailure(task.name, err);
        })
        .finally(scheduleNext);
    } else {
      scheduleNext();
    }
  } catch (err) {
    reportDeferredTaskFailure(task.name, err);
    scheduleNext();
  }
}
