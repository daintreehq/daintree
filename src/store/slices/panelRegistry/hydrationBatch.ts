import type { HydrationBatchToken } from "./types";

/**
 * Singleton batch state shared by hydration (#5196) and spawn (#9165). During a
 * batch, `addPanel` commits the per-panel `panelsById` entry immediately (so
 * IPC event listeners can look panels up by id) but defers the `panelIds`
 * append. Flush applies a single `panelIds` update per batch — the
 * high-fanout subscription that the worktree dashboard, dock, and grid read.
 * Net: a phase of N panels triggers 1 `panelIds` render instead of N.
 *
 * `kind` distinguishes the two use cases because their staleness contracts
 * differ. A stale hydration is discarded on the next hydration — its panels
 * came from a project that the user is leaving (#5196). A stale spawn is
 * inherited by the next hydration — its panels are real user-initiated
 * additions that we must not orphan in `panelsById`.
 */
type BatchKind = "hydration" | "spawn";

let activeBatch: {
  kind: BatchKind;
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
  return activeBatch !== null;
}

/** Record a new panel id for append to `panelIds` at flush time. Dedup-safe. */
export function collectPanelIdForBatch(id: string): void {
  if (activeBatch === null) return;
  if (activeBatch.seenIds.has(id)) return;
  activeBatch.seenIds.add(id);
  activeBatch.pendingIds.push(id);
}

/**
 * Open a new hydration batch and return its opaque token. A leftover hydration
 * batch is discarded — cancelled hydrations carry stale-project panels we
 * never want to surface. A leftover SPAWN batch is the caller's responsibility
 * to inherit via {@link consumeActiveSpawnBatch} before calling this; otherwise
 * its collected panels would be silently dropped.
 */
export function beginBatch(): HydrationBatchToken {
  const token: HydrationBatchToken = Symbol("hydration-batch");
  activeBatch = { kind: "hydration", token, pendingIds: [], seenIds: new Set() };
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
  if (activeBatch !== null) return null;
  const token: HydrationBatchToken = Symbol("spawn-batch");
  activeBatch = { kind: "spawn", token, pendingIds: [], seenIds: new Set() };
  return token;
}

/**
 * Close the active batch if `token` matches and return its pending panel ids.
 * Returns `null` when the token was already consumed or superseded — callers
 * should treat that as a no-op flush.
 */
export function consumeBatch(token: HydrationBatchToken | null): string[] | null {
  if (activeBatch === null || activeBatch.token !== token) return null;
  const pendingIds = activeBatch.pendingIds;
  activeBatch = null;
  return pendingIds;
}

/**
 * If the active batch is a spawn batch, drain its pendingIds and reset.
 * Used by `beginHydrationBatch` to inherit collected ids from a recipe run
 * that's still in flight when hydration takes over (e.g. project switch
 * mid-spawn): without this, the new hydration token would invalidate the
 * spawn token, the spawn caller's `flushSpawnBatch` would no-op on the
 * mismatch, and the spawn's panels would be orphaned in `panelsById`.
 * Returns `null` when the active batch is hydration (intentionally discarded)
 * or absent.
 */
export function consumeActiveSpawnBatch(): string[] | null {
  if (activeBatch === null || activeBatch.kind !== "spawn") return null;
  const pendingIds = activeBatch.pendingIds;
  activeBatch = null;
  return pendingIds;
}

/**
 * Force-clear any in-flight batch. Called from `panelStore.reset()` and
 * `clearTerminalStoreForSwitch()` so a batch that was opened but never flushed
 * (a store reset, project switch, or a test that threw mid-batch) can't leave
 * `isHydrationBatchActive()` stuck `true` and make the next `beginSpawnBatch()`
 * decline to open.
 */
export function resetBatchState(): void {
  activeBatch = null;
}
