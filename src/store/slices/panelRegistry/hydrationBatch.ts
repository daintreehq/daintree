import type { HydrationBatchToken } from "./types";

/**
 * Hydration batch state. Each restore phase runs inside begin/flush, and during
 * that window `addPanel` commits the per-panel `panelsById` entry immediately
 * (so IPC event listeners that look panels up by id always find them) but defers
 * the `panelIds` append. Flush applies a single `panelIds` update per phase —
 * which is the high-fanout subscription that the worktree dashboard, dock, and
 * grid subscribe to. Net: a phase of N panels triggers 1 `panelIds` render
 * instead of N, while never leaving spawned panels invisible to event handlers.
 *
 * Singleton: hydration is guarded by `isCurrent()` so at most one batch is active
 * at a time. `HydrationBatchToken` protects against stale flushes from cancelled
 * hydrations colliding with a fresh batch started by the superseding hydration.
 */
let activeHydrationBatch: {
  token: HydrationBatchToken;
  /** Ids pending append to `panelIds`; deduplicated via `seenIds`. */
  pendingIds: string[];
  seenIds: Set<string>;
} | null = null;

/**
 * Exposed so higher-level `addPanel` wrappers (e.g. the focus-setting wrapper in
 * `panelStore.ts`) can skip their own `set()` calls while a batch is active —
 * otherwise they'd trigger one render per panel and defeat the batching.
 */
export function isHydrationBatchActive(): boolean {
  return activeHydrationBatch !== null;
}

/** Record a new panel id for append to `panelIds` at flush time. Dedup-safe. */
export function collectPanelIdForBatch(id: string): void {
  if (activeHydrationBatch === null) return;
  if (activeHydrationBatch.seenIds.has(id)) return;
  activeHydrationBatch.seenIds.add(id);
  activeHydrationBatch.pendingIds.push(id);
}

/**
 * Open a new hydration batch and return its opaque token. A leftover batch from
 * a cancelled hydration is discarded — we prioritize the fresh hydration and
 * never flush stale panels into the store.
 */
export function beginBatch(): HydrationBatchToken {
  const token: HydrationBatchToken = Symbol("hydration-batch");
  activeHydrationBatch = { token, pendingIds: [], seenIds: new Set() };
  return token;
}

/**
 * Close the active batch if `token` matches and return its pending panel ids.
 * Returns `null` when the token was already consumed or superseded — callers
 * should treat that as a no-op flush.
 */
export function consumeBatch(token: HydrationBatchToken): string[] | null {
  if (activeHydrationBatch === null || activeHydrationBatch.token !== token) return null;
  const pendingIds = activeHydrationBatch.pendingIds;
  activeHydrationBatch = null;
  return pendingIds;
}
