import nodeV8 from "node:v8";
import vm from "node:vm";

/**
 * Idle heap compaction for the pty-host process (main isolate + analysis
 * worker isolates). Terminal output churns transient strings and parse
 * buffers through V8 on every chunk; when the burst ends, Node isolates keep
 * the committed-but-free heap pages for many minutes because nothing drives
 * V8's idle memory reducer in a utility process (the kitchen-sink memory
 * benchmark measured the slack decaying from ~420 MB to ~356 MB only after
 * ~10 minutes of idle). One explicit compacting GC per idle transition
 * returns those pages to the OS in seconds instead. It runs only after
 * IDLE_HEAP_COMPACT_AFTER_MS with zero terminal activity and re-arms only
 * when activity resumes, so a busy shard never pays for it.
 */
export const IDLE_HEAP_COMPACT_AFTER_MS = 10_000;
export const IDLE_HEAP_COMPACT_CHECK_INTERVAL_MS = 5_000;

/**
 * Resolve a callable `gc()` for this isolate. Prefers an already-exposed
 * global (renderers get one from the js-flags switch); otherwise uses the
 * same late-flag trick as `electron/setup/environment.ts` — flip
 * `--expose_gc` on and grab `gc` from a fresh context, which binds it to this
 * isolate. Returns null when V8 refuses, and callers degrade to no-op.
 */
export function resolveExposedGc(): (() => void) | null {
  const existing = (globalThis as Record<string, unknown>).gc;
  if (typeof existing === "function") return existing as () => void;
  try {
    nodeV8.setFlagsFromString("--expose_gc");
    return vm.runInNewContext("gc") as () => void;
  } catch {
    return null;
  }
}

export class IdleHeapCompactor {
  private lastActivityAt = Date.now();
  private compactedSinceActivity = false;

  constructor(
    private readonly gc: (() => void) | null,
    private readonly idleAfterMs: number = IDLE_HEAP_COMPACT_AFTER_MS
  ) {}

  /** Push-style activity signal (workers: every dispatched message). */
  noteActivity(now: number = Date.now()): void {
    this.lastActivityAt = now;
    this.compactedSinceActivity = false;
  }

  /**
   * Poll-style activity signal (pty-host main: newest terminal input/output
   * timestamp). Only moves the clock forward, so repeated polls of the same
   * stale timestamp don't re-arm compaction.
   */
  observeActivityAt(activityAt: number): void {
    if (activityAt > this.lastActivityAt) {
      this.lastActivityAt = activityAt;
      this.compactedSinceActivity = false;
    }
  }

  /** Run one compacting GC if idle long enough; true when a GC actually ran. */
  maybeCompact(now: number = Date.now()): boolean {
    if (!this.gc || this.compactedSinceActivity) return false;
    if (now - this.lastActivityAt < this.idleAfterMs) return false;
    try {
      this.gc();
    } catch {
      return false;
    }
    this.compactedSinceActivity = true;
    return true;
  }
}
