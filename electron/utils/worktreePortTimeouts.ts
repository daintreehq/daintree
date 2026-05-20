import type { WorktreePortAction } from "../../shared/types/worktree-port.js";

/**
 * Default deadline for short, bounded worktree-port actions (status snapshots,
 * git list/log queries, env switches). 10 seconds is generous for fast paths
 * that should never block on user-perceptible work.
 */
export const DEFAULT_WORKTREE_PORT_TIMEOUT_MS = 10_000;

/**
 * Per-action deadlines for actions that legitimately run longer than the
 * default. The previous fixed 10s ceiling fired spurious "timed out" errors
 * on operations that were still completing successfully on the host (issue
 * #8551, gap 2). Keep these finite — an `Infinity` timeout would leave the
 * renderer stuck on a hung utility process that never crashes (so the port
 * `close` event never fires). The `close` event is the fast-failure signal;
 * these timeouts are the deadlock backstop.
 */
export const WORKTREE_PORT_TIMEOUTS_MS: Partial<Record<WorktreePortAction, number>> = {
  "create-worktree": 5 * 60_000, // git worktree add + branch creation
  "delete-worktree": 5 * 60_000, // git worktree remove + optional branch delete
  "resource-action": 10 * 60_000, // cloud provision/teardown can run for minutes
  "run-lifecycle-setup": 10 * 60_000, // arbitrary user-defined setup scripts
};

/**
 * Resolve the effective timeout for a worktree-port request.
 *
 * - An explicit `override` wins when it is a positive finite number. Invalid
 *   overrides (NaN, Infinity, ≤0) silently fall through to the table; the
 *   only caller is internal preload code, not user input, so a hard reject
 *   would just convert a misuse into a harder-to-debug Promise rejection.
 * - Otherwise the per-action table is consulted.
 * - Otherwise the default applies.
 */
export function resolveWorktreePortTimeout(action: WorktreePortAction, override?: number): number {
  if (override != null && Number.isFinite(override) && override > 0) {
    return override;
  }
  return WORKTREE_PORT_TIMEOUTS_MS[action] ?? DEFAULT_WORKTREE_PORT_TIMEOUT_MS;
}
