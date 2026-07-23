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
 *
 * Values must exceed the host-side worst case so the renderer is never the
 * limiting factor. As of writing:
 *   - delete-worktree: host runs resource-teardown (300s, hardcoded in
 *     WorktreeLifecycleService.runTeardown) then regular teardown (120s),
 *     sequentially → 7 min worst case. Renderer gets 10 min headroom.
 *   - resource-action: per-action defaults are 300s
 *     (ResourceActionExecutor.DEFAULT_TIMEOUT_MS); user configs in
 *     `.daintree/config.json` may extend this without an enforced ceiling.
 *     15 min covers all realistic cloud provision/teardown workflows.
 *   - run-lifecycle-setup: arbitrary user-defined setup scripts.
 *   - create-worktree: git worktree add + branch creation on slow
 *     filesystems / large repos.
 *   - refresh: the host AWAITS a full refresh and watchdogs it at 45s
 *     (HOST_REFRESH_TIMEOUT_MS in WorkspaceService). The default 10s ceiling
 *     would fire BEFORE the host's own bounded pass returns on a degraded repo,
 *     turning the Refresh button into a spurious timeout. 60s sits just above
 *     the host ceiling so the host stays the limiting factor.
 *
 * Note: `reconcile-topology` is intentionally absent — its handler only
 * SCHEDULES a reconcile and replies immediately, so the default 10s is ample;
 * a longer ceiling would be dead config (the reply never waits on the reconcile).
 */
export const WORKTREE_PORT_TIMEOUTS_MS: Partial<Record<WorktreePortAction, number>> = {
  "create-worktree": 5 * 60_000,
  "delete-worktree": 10 * 60_000,
  "resource-action": 15 * 60_000,
  "run-lifecycle-setup": 15 * 60_000,
  refresh: 60_000,
  // Awaits a single-worktree `monitor.refresh()`, watchdogged host-side at 45s
  // (HOST_REFRESH_TIMEOUT_MS). Match `refresh`'s 60s so the host stays the
  // limiting factor and the delete-confirm read isn't cut short on a slow repo.
  "get-worktree-changes": 60_000,
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
