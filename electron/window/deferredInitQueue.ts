import { markPerformance } from "../utils/performance.js";
import { PERF_MARKS } from "../../shared/perf/marks.js";

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

export function registerDeferredTask(task: DeferredTask): void {
  if (drainState !== "idle") {
    console.warn(
      `[DeferredInit] Task "${task.name}" registered after drain started — running immediately`
    );
    try {
      const res = task.run();
      if (res instanceof Promise) {
        res.catch((err) => console.error(`[DeferredInit] Late task "${task.name}" failed:`, err));
      }
    } catch (err) {
      console.error(`[DeferredInit] Late task "${task.name}" threw:`, err);
    }
    return;
  }
  tasks.push(task);
}

export function finalizeDeferredRegistration(fallbackMs: number = DEFAULT_FALLBACK_MS): void {
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
 * Clear all queue state. Called when the last window closes (so a new window
 * opened later — e.g. macOS `activate` — gets a fresh queue) and from test
 * setup. Increments the generation counter so any in-flight drain callbacks
 * from the previous cycle bail out instead of mutating fresh state.
 */
export function resetDeferredQueue(): void {
  generation++;
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

function doDrain(): void {
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
  if (drainGen !== generation) return; // queue was reset — abandon this chain
  if (index >= tasks.length) {
    drainState = "drained";
    const elapsed = Date.now() - startedAt;
    markPerformance(PERF_MARKS.DEFERRED_SERVICES_COMPLETE, { durationMs: elapsed });
    console.log(`[DeferredInit] Drained ${tasks.length} deferred task(s) in ${elapsed}ms`);
    // Release task closures once drained so they don't retain references to
    // destroyed windows, services, etc. until the next reset.
    tasks = [];
    return;
  }

  const task = tasks[index];
  const scheduleNext = () => setImmediate(() => drainNext(index + 1, startedAt, drainGen));

  try {
    const result = task.run();
    if (result instanceof Promise) {
      result
        .catch((err) => {
          console.error(`[DeferredInit] Task "${task.name}" failed:`, err);
        })
        .finally(scheduleNext);
    } else {
      scheduleNext();
    }
  } catch (err) {
    console.error(`[DeferredInit] Task "${task.name}" threw:`, err);
    scheduleNext();
  }
}
