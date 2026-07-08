import {
  IdleHeapCompactor,
  resolveExposedGc,
  IDLE_HEAP_COMPACT_CHECK_INTERVAL_MS,
} from "./pty/analysis/idleHeapCompactor.js";

/**
 * Idle heap compaction for the MAIN isolate. Boot, project switches, config
 * parses, and IPC broadcast bursts churn transient garbage through main's V8
 * heap, and nothing drives the idle memory reducer afterwards — the committed
 * slack lingers exactly like it did in the pty-host before its compactor.
 *
 * Activity signal: heap growth. User-input idle (powerMonitor) is wrong here —
 * overnight agent fleets keep main busy while the user is away, and Playwright
 * -driven e2e input never registers. A heapUsed delta above the threshold
 * between polls means main is doing real work; when the heap stops moving, one
 * compacting GC runs and the latch holds until growth resumes. A GC's own
 * shrink is a negative delta, so compaction never re-triggers itself.
 */
const HEAP_GROWTH_ACTIVITY_BYTES = 2 * 1024 * 1024;

export function startMainIdleHeapCompaction(): () => void {
  const compactor = new IdleHeapCompactor(resolveExposedGc());
  let lastHeapUsed = process.memoryUsage().heapUsed;
  const timer = setInterval(() => {
    const heapUsed = process.memoryUsage().heapUsed;
    if (heapUsed - lastHeapUsed > HEAP_GROWTH_ACTIVITY_BYTES) {
      compactor.noteActivity();
    }
    lastHeapUsed = heapUsed;
    compactor.maybeCompact();
  }, IDLE_HEAP_COMPACT_CHECK_INTERVAL_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}
