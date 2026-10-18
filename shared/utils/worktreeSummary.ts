import type { Worktree } from "../types/worktree.js";
import type { WorktreeSnapshot } from "../types/workspace-host.js";

/**
 * What the workspace host says when `git worktree remove` succeeded and the
 * branch was deliberately kept because Git judged it not fully merged — a
 * finished delete, not a failed one. Matched as a substring, so a wrapped or
 * prefixed variant still classifies.
 */
export const WORKTREE_BRANCH_KEPT_MARKER = "was kept because Git reports it isn't fully merged";

/**
 * The wire spelling of a worktree's post-create initialization state.
 *
 * An absent `setupStatus` is reported as `unknown`, never as `ready`: the host
 * holds it in memory, so a worktree created before this host process started —
 * or by another one — genuinely has no record, and saying "ready" there would
 * be an interpretation rather than an observation.
 */
export function readWorktreeSetupState(worktree: Pick<Worktree, "setupStatus">): string {
  return worktree.setupStatus?.state ?? "unknown";
}

/**
 * One `worktree.list` row, from whichever side holds the worktree: a view's
 * store, or the workspace host when no view is open (#13495).
 */
export function toWorktreeSummary(worktree: Worktree, activeWorktreeId: string | null | undefined) {
  return {
    id: worktree.id,
    path: worktree.path,
    // `Worktree.branch` is undefined on a detached HEAD, and the summary shape
    // declares `string | null` like every sibling field here.
    branch: worktree.branch ?? null,
    isActive: worktree.id === activeWorktreeId,
    isMain: worktree.isMainWorktree ?? false,
    issueNumber: worktree.issueNumber ?? null,
    issueTitle: worktree.issueTitle ?? null,
    prNumber: worktree.linked?.pr?.ref.number ?? null,
    prTitle: worktree.linked?.pr?.title ?? null,
    prUrl: worktree.linked?.pr?.url ?? null,
    status: worktree.mood ?? null,
    lastCommit: worktree.summary ?? null,
    setupState: readWorktreeSetupState(worktree),
  };
}

/**
 * The longest a wait may block. The renderer dispatch path times out at 30s, so
 * a longer wait would be killed mid-flight and reported as a transport failure
 * rather than as "still running" — which is the one answer this capability
 * exists to give honestly. Setup scripts routinely outlast this; the contract is
 * therefore "call again", not "wait longer".
 */
export const MAX_WAIT_UNTIL_READY_TIMEOUT_MS = 25_000;

/**
 * How often the wait re-reads the host. Setup stages are seconds apart, and
 * each read is a host round trip rather than a local lookup, so this is
 * deliberately slower than a store poll would need to be.
 */
const WAIT_UNTIL_READY_POLL_INTERVAL_MS = 500;

/** States a wait stops on — every state that is not still in progress. */
const SETTLED_SETUP_STATES = new Set(["ready", "failed", "timed-out", "needs-approval", "unknown"]);

/**
 * Wait, within the caller's budget, for one worktree's setup to settle, and
 * report where it got. Shared by the renderer action and the host's viewless
 * one (#13495); each supplies how it reads the host's setup status.
 *
 * `readStatus` resolves `null` when the host has no such worktree, and
 * `undefined` when it has one with nothing recorded.
 */
export async function waitForWorktreeSetup(
  worktreeId: string,
  timeoutMs: number | undefined,
  readStatus: (worktreeId: string) => Promise<WorktreeSnapshot["setupStatus"] | undefined | null>,
  clock: { now: () => number; sleep: (ms: number) => Promise<void> } = {
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  }
) {
  const budgetMs = Math.min(
    timeoutMs ?? MAX_WAIT_UNTIL_READY_TIMEOUT_MS,
    MAX_WAIT_UNTIL_READY_TIMEOUT_MS
  );
  const deadline = clock.now() + budgetMs;

  for (;;) {
    const status = await readStatus(worktreeId);
    if (status === null) {
      // Static, per the repo-wide rule: an error message must never carry
      // the rejected input back out. The id is the caller's own argument,
      // so naming it adds nothing it does not already have.
      throw new Error("Unknown worktree — the workspace host has no worktree with that id.");
    }
    const state = status?.state ?? "unknown";
    const settled = SETTLED_SETUP_STATES.has(state);
    const remaining = deadline - clock.now();
    if (settled || remaining <= 0) {
      return {
        worktreeId,
        setupState: state,
        stage: status?.stage ?? null,
        error: status?.error ?? null,
        // Only a genuinely unsettled state counts as a timeout. Running
        // out of budget on the same tick a worktree became ready is a
        // completed wait, not an expired one.
        timedOut: !settled,
      };
    }
    await clock.sleep(Math.min(WAIT_UNTIL_READY_POLL_INTERVAL_MS, remaining));
  }
}
