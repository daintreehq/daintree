const GIB = 1024 ** 3;

/**
 * Default size of the dormant workspace-host warm pool.
 *
 * Deliberately independent of `computeDefaultCachedViews`, which this used to
 * borrow (#11926). The two size unrelated things: a cached project view is a
 * Chromium renderer costing hundreds of MB, whereas a dormant workspace host is
 * a paused utility process whose whole value is skipping a fork plus a full git
 * rescan on switch-back. Sharing one helper meant tuning the renderer cache
 * silently re-tuned host respawn churn, and the regression surfaced as
 * workspace-host spawn storms rather than as a memory change.
 *
 * The rungs match `computeDefaultCachedViews` today so the split changed no
 * behavior. That agreement is a starting point, not a contract — the two are
 * expected to diverge once the per-view and per-host costs are actually
 * measured. Do not re-derive either from the other.
 *
 * Note the counts are not even measured the same way: the cached-view cap
 * includes the active view, while this counts dormant hosts only.
 */
export function computeDefaultWarmWorkspaceHosts(totalMemBytes: number): number {
  if (!Number.isFinite(totalMemBytes) || totalMemBytes <= 0) return 2;
  if (totalMemBytes >= 64 * GIB) return 5;
  if (totalMemBytes >= 32 * GIB) return 4;
  if (totalMemBytes >= 16 * GIB) return 3;
  return 2;
}
