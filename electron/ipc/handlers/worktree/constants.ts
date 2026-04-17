export const WORKTREE_RATE_LIMIT_KEY = "worktreeCreate";
// Strict-interval leaky bucket: one worktree creation released every 1s.
// Prior sliding-window approach (2 per 2s) released both slots simultaneously
// when the window rolled, producing a feast/famine burst pattern. See #5098.
// Interval reduced from 6s to 1s in #5161 — 1 per second is safe for git lock
// contention on any repo size and brings 30-worktree batches down from ~180s
// to ~30s without regressing the burst-pattern fix.
export const WORKTREE_RATE_LIMIT_INTERVAL_MS = 1_000;
