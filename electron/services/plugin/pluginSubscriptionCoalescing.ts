import { PLUGIN_SUBSCRIPTION_DEFAULT_DEBOUNCE_MS } from "../../../shared/config/pluginBudgets.js";
import type {
  PluginWorktreeSnapshot,
  PluginWorktreesChange,
} from "../../../shared/types/plugin.js";

/**
 * Floor for a plugin-supplied subscription `debounceMs`: a positive value
 * below it is clamped up so a near-zero window can't pay timer overhead
 * without coalescing anything.
 */
export const MIN_PLUGIN_SUBSCRIPTION_DEBOUNCE_MS = 50;

/**
 * Ceiling for a subscription `debounceMs`. Node clamps a timer delay past
 * 2^31-1 ms to 1 ms, so an unbounded value would turn "rarely" into
 * "immediately".
 */
export const MAX_PLUGIN_SUBSCRIPTION_DEBOUNCE_MS = 60_000;

/**
 * Bound on how long a coalesced burst may defer its callback, as a multiple of
 * the window. Multi-agent churn can stream events with no quiet gap for as
 * long as agents work, and a pure trailing debounce would withhold the latest
 * state for that whole time.
 */
export const PLUGIN_SUBSCRIPTION_MAX_WAIT_FACTOR = 4;

/**
 * The effective window for a subscription's `debounceMs`. Omitted — or not a
 * number at all, which is how an absent option can arrive across the worker
 * port — is the default; zero or negative is the explicit raw opt-out.
 */
export function resolveSubscriptionDebounceMs(
  value: unknown,
  defaultMs: number = PLUGIN_SUBSCRIPTION_DEFAULT_DEBOUNCE_MS
): number {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return defaultMs;
  }
  if (value <= 0) return 0;
  return Math.min(
    Math.max(value, MIN_PLUGIN_SUBSCRIPTION_DEBOUNCE_MS),
    MAX_PLUGIN_SUBSCRIPTION_DEBOUNCE_MS
  );
}

export interface SubscriptionCoalescer {
  /** Record an event; the flush runs at the trailing edge of the burst. */
  push(): void;
  /** Drop any pending flush. */
  dispose(): void;
}

/**
 * Trailing-edge coalescer with a max-wait deadline. With a window of 0 every
 * push flushes synchronously, which is the raw opt-out.
 */
export function createSubscriptionCoalescer(
  debounceMs: number,
  flush: () => void
): SubscriptionCoalescer {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let burstDeadline = 0;
  let disposed = false;
  return {
    push: () => {
      if (disposed) return;
      if (debounceMs <= 0) {
        flush();
        return;
      }
      // Monotonic: a wall-clock rollback must not push the deadline out.
      const now = performance.now();
      if (timer) {
        clearTimeout(timer);
      } else {
        burstDeadline = now + debounceMs * PLUGIN_SUBSCRIPTION_MAX_WAIT_FACTOR;
      }
      timer = setTimeout(
        () => {
          timer = null;
          if (!disposed) flush();
        },
        Math.max(0, Math.min(debounceMs, burstDeadline - now))
      );
    },
    dispose: () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}

/**
 * A string that differs whenever any plugin-visible field of the snapshot
 * does. Built from the projected snapshot (already an allowlist), so it costs
 * no more than the structured clone that delivers it.
 */
export function worktreeSnapshotFingerprint(snapshot: PluginWorktreeSnapshot): string {
  const status = snapshot.status;
  return JSON.stringify([
    snapshot.worktreeId,
    snapshot.path,
    snapshot.name,
    snapshot.isCurrent,
    snapshot.branch ?? null,
    snapshot.isMainWorktree ?? null,
    snapshot.aheadCount ?? null,
    snapshot.behindCount ?? null,
    snapshot.mood ?? null,
    snapshot.lastActivityTimestamp ?? null,
    snapshot.createdAt ?? null,
    snapshot.linked,
    status === null
      ? null
      : [
          status.changedFileCount,
          status.counts,
          status.files.map((file) => `${file.state}\u0000${file.path}`),
        ],
  ]);
}

/**
 * Tracks what a subscription last delivered so each delivery can say what
 * changed since. Starts empty, so the first delivery reports everything as
 * added.
 */
export class WorktreeChangeTracker {
  private previous = new Map<string, string>();

  next(snapshots: readonly PluginWorktreeSnapshot[]): PluginWorktreesChange {
    const current = new Map<string, string>();
    const added: string[] = [];
    const changed: string[] = [];
    for (const snapshot of snapshots) {
      // A duplicate id in one list is the host's bug, not a change; the first
      // occurrence decides.
      if (current.has(snapshot.id)) continue;
      const fingerprint = worktreeSnapshotFingerprint(snapshot);
      current.set(snapshot.id, fingerprint);
      const before = this.previous.get(snapshot.id);
      if (before === undefined) added.push(snapshot.id);
      else if (before !== fingerprint) changed.push(snapshot.id);
    }
    const removed: string[] = [];
    for (const id of this.previous.keys()) {
      if (!current.has(id)) removed.push(id);
    }
    this.previous = current;
    return Object.freeze({
      added: Object.freeze(added),
      removed: Object.freeze(removed),
      changed: Object.freeze(changed),
    });
  }
}
