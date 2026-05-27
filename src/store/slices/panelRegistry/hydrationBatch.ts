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
 * Open a batch for a recipe/worktree spawn burst, but only if none is already
 * active. Recipe runs are user-triggered and can overlap (two worktree cards,
 * a double-click, or a run landing mid-hydration), so — unlike `beginBatch` —
 * this never supersedes an in-flight batch. Returning `null` tells the caller
 * to skip its own flush; any panels it adds during the window are still
 * collected into the active batch and swept up by that batch's flush, where the
 * dedup-on-flush guard appends each id exactly once. This keeps the single
 * `panelIds` commit while staying safe under concurrent spawns. See issue #9165.
 */
export function beginSpawnBatch(): HydrationBatchToken | null {
  if (activeHydrationBatch !== null) return null;
  return beginBatch();
}

/**
 * Close the active batch if `token` matches and return its pending panel ids.
 * Returns `null` when the token was already consumed or superseded — callers
 * should treat that as a no-op flush.
 */
export function consumeBatch(token: HydrationBatchToken | null): string[] | null {
  if (activeHydrationBatch === null || activeHydrationBatch.token !== token) return null;
  const pendingIds = activeHydrationBatch.pendingIds;
  activeHydrationBatch = null;
  return pendingIds;
}

/**
 * Force-clear any in-flight batch. Called from `panelStore.reset()` so a batch
 * that was opened but never flushed (a store reset, project switch, or a test
 * that threw mid-batch) can't leave `isHydrationBatchActive()` stuck `true` and
 * make the next `beginSpawnBatch()` decline to open.
 */
export function resetBatchState(): void {
  activeHydrationBatch = null;
}
