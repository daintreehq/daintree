import { detectPrefixFromIssue, buildBranchName } from "@/components/Worktree/branchPrefixUtils";
import { generateBranchSlug } from "@/utils/textParsing";
import type { Issue, PR } from "@shared/types/forge";
import { MAX_TERMINALS_PER_RECIPE_ADMISSION_BATCH } from "@shared/utils/recipeSanitizer";
import type { PlannedWorktree } from "./bulkCreatePrequery";

export type { PlannedWorktree };

// Transient failures (secondary rate limits, lock contention, transient network
// blips) keep retrying until this per-item wall-clock ceiling elapses, rather
// than giving up after a fixed attempt count (see #10128). A GitHub secondary
// rate limit typically clears within 1-5 minutes; if it hasn't cleared in 5,
// the account/IP is in a longer penalty (24-72h) that no in-process retry can
// outlast anyway. The ceiling is per-item-total — it bounds the combined
// worktree-creation and assignment dwell time so one item can't stall its queue
// slot indefinitely. Permanent errors still fail immediately.
export const MAX_TRANSIENT_RETRY_MS = 5 * 60 * 1000;
// Cap in-flight creation requests at a small parallel fan-out. The backend
// leaky-bucket rate limiter remains the primary throttle — pacing at the
// producer side would only create a conflicting secondary rate limiter and
// re-introduce the feast/famine burst pattern (see #5098). Raised from 2 to
// 3 now that `--no-track` (see #5163, PR #5165) avoids `install_branch_config`
// and its `.git/config.lock` write, eliminating the contention that
// previously justified the tighter cap (see #3807).
export const QUEUE_CONCURRENCY = 3;
export const BACKOFF_BASE_MS = 3000;
export const BACKOFF_CAP_MS = 30000;
// Assignment hits POST /assignees, which downstream fans out to notifications and
// is a common trigger for GitHub's secondary rate limit. GitHub's guidance is to
// wait at least 60s when no Retry-After header is supplied, so the assignment
// retry loop uses its own cap instead of the shared 30s value.
export const ASSIGNMENT_BACKOFF_CAP_MS = 60000;
export const VERIFICATION_SPAWN_WAIT_MS = 700;
export const VERIFICATION_EXIT_SETTLE_MS = 100;

export interface BulkRecipeSpawnBatch {
  id: string;
  size: number;
}

export function planBulkRecipeSpawnBatches(
  itemNumbers: number[],
  ptyTerminalsPerItem: number,
  createBatchId: () => string
): Map<number, BulkRecipeSpawnBatch> {
  const batches = new Map<number, BulkRecipeSpawnBatch>();
  if (ptyTerminalsPerItem <= 0 || ptyTerminalsPerItem > MAX_TERMINALS_PER_RECIPE_ADMISSION_BATCH) {
    return batches;
  }

  const itemsPerBatch = Math.max(
    1,
    Math.floor(MAX_TERMINALS_PER_RECIPE_ADMISSION_BATCH / ptyTerminalsPerItem)
  );
  for (let offset = 0; offset < itemNumbers.length; offset += itemsPerBatch) {
    const itemBatch = itemNumbers.slice(offset, offset + itemsPerBatch);
    const size = itemBatch.length * ptyTerminalsPerItem;
    if (size < 2) continue;
    const batch = { id: createBatchId(), size };
    for (const itemNumber of itemBatch) batches.set(itemNumber, batch);
  }
  return batches;
}

// IPC strips structured error fields (lesson #3769), so renderer-side classification
// matches the strings emitted by `parseGitHubError` in the main process — not status codes.
const TRANSIENT_ERROR_RE =
  /\.lock['"]?:.*(?:File exists|exists)|Another git process|Resource temporarily unavailable|cannot lock ref|could not lock config file|Rate limit exceeded|Spawn queue full|ETIMEDOUT|ECONNRESET|ECONNREFUSED|GitHub is temporarily unavailable|Cannot reach GitHub|GitHub rate limit exceeded|GitHub secondary rate limit triggered|exceeded a secondary rate limit/i;

export function isTransientError(message: string, code?: string): boolean {
  if (code === "VALIDATION_ERROR" || code === "NOT_FOUND") return false;
  return TRANSIENT_ERROR_RE.test(message);
}

export function normalizeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return String(error);
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Interruptible sleep for backoff waits. Polls `isCancelled` at most once per
// second so a cancel/reset (dialog closed, new run started) resolves within ~1s
// instead of blocking for the full 30-60s backoff. Resolves — never rejects —
// on cancel, matching the `runIdRef.current !== currentRunId` guard pattern the
// callers re-check after the await returns (see #10128).
export async function cancellableDelay(ms: number, isCancelled: () => boolean): Promise<void> {
  const end = performance.now() + ms;
  let remaining = end - performance.now();
  while (remaining > 0) {
    if (isCancelled()) return;
    await delay(Math.min(1000, remaining));
    remaining = end - performance.now();
  }
}

export function nextBackoffDelay(prevDelay: number, cap: number = BACKOFF_CAP_MS): number {
  const min = BACKOFF_BASE_MS;
  const max = prevDelay * 3;
  return Math.min(cap, min + Math.random() * (max - min));
}

export function planIssueWorktrees(
  issues: Issue[],
  existingIssueNumbers: Set<number>
): PlannedWorktree[] {
  return issues.map((issue) => {
    if (issue.state !== "open") {
      return {
        item: issue,
        mode: "issue",
        branchName: "",
        prefix: "",
        skipped: true,
        skipReason: "Closed",
      };
    }
    if (existingIssueNumbers.has(issue.number)) {
      return {
        item: issue,
        mode: "issue",
        branchName: "",
        prefix: "",
        skipped: true,
        skipReason: "Has worktree",
      };
    }

    const prefix = detectPrefixFromIssue(issue) ?? "feature";
    const slug = generateBranchSlug(issue.title);
    const issuePrefix = `issue-${issue.number}-`;
    const branchName = buildBranchName(prefix, `${issuePrefix}${slug || "worktree"}`);

    return { item: issue, mode: "issue", branchName, prefix, skipped: false };
  });
}

export function planPRWorktrees(prs: PR[], existingPRNumbers: Set<number>): PlannedWorktree[] {
  return prs.map((pr) => {
    if (pr.state !== "open") {
      return {
        item: pr,
        mode: "pr",
        branchName: "",
        prefix: "",
        skipped: true,
        skipReason: pr.state === "merged" ? "Merged" : "Closed",
      };
    }
    if (!pr.headRef) {
      return {
        item: pr,
        mode: "pr",
        branchName: "",
        prefix: "",
        skipped: true,
        skipReason: "No branch info",
      };
    }
    if (existingPRNumbers.has(pr.number)) {
      return {
        item: pr,
        mode: "pr",
        branchName: "",
        prefix: "",
        skipped: true,
        skipReason: "Has worktree",
      };
    }

    return {
      item: pr,
      mode: "pr",
      branchName: pr.headRef,
      prefix: "",
      skipped: false,
      headRefName: pr.headRef,
    };
  });
}
