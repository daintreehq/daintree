export const WORKTREE_RATE_LIMIT_KEY = "worktreeCreate";
// Token bucket: up to WORKTREE_RATE_LIMIT_BURST creates pass with no wait
// after an idle stretch, then sustained callers drain at one per second.
// History: #5098 replaced a feast/famine sliding window with a strict
// 1s-interval leaky bucket; #5161 cut the interval 6s → 1s. Both were about
// keeping concurrent `git worktree add` runs off the same repo — that
// property is now enforced structurally by the workspace-host's per-repo
// create queue (WorkspaceService.enqueueCreateWorktree), which runs creates
// strictly one-at-a-time back to back. With git safety no longer depending
// on wall-clock spacing, the burst allowance exists purely as runaway-
// automation backpressure: 30 covers the bulk-create batches #5161 sized
// for (a 30-worktree batch used to take ~30s of pure pacing; it now runs at
// real git speed), while sustained abuse still settles to 1/s with the
// 50-deep queue-full rejection unchanged.
export const WORKTREE_RATE_LIMIT_INTERVAL_MS = 1_000;
export const WORKTREE_RATE_LIMIT_BURST = 30;
