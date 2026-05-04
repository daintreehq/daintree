import { detectPrefixFromIssue, buildBranchName } from "@/components/Worktree/branchPrefixUtils";
import { generateBranchSlug } from "@/utils/textParsing";
import type { GitHubIssue, GitHubPR } from "@shared/types/github";
import type { PlannedWorktree } from "./bulkCreatePrequery";

export type { PlannedWorktree };

export const MAX_AUTO_RETRIES = 2;
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
export const VERIFICATION_SETTLE_MS = 800;

const TRANSIENT_ERROR_RE =
  /\.lock['"]?:.*(?:File exists|exists)|Another git process|Resource temporarily unavailable|cannot lock ref|could not lock config file|Rate limit exceeded|Spawn queue full|ETIMEDOUT|ECONNRESET|ECONNREFUSED/i;

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

export function nextBackoffDelay(prevDelay: number): number {
  const min = BACKOFF_BASE_MS;
  const max = prevDelay * 3;
  return Math.min(BACKOFF_CAP_MS, min + Math.random() * (max - min));
}

export function planIssueWorktrees(
  issues: GitHubIssue[],
  existingIssueNumbers: Set<number>
): PlannedWorktree[] {
  return issues.map((issue) => {
    if (issue.state !== "OPEN") {
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

export function planPRWorktrees(
  prs: GitHubPR[],
  existingPRNumbers: Set<number>
): PlannedWorktree[] {
  return prs.map((pr) => {
    if (pr.state !== "OPEN") {
      return {
        item: pr,
        mode: "pr",
        branchName: "",
        prefix: "",
        skipped: true,
        skipReason: pr.state === "MERGED" ? "Merged" : "Closed",
      };
    }
    if (!pr.headRefName) {
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
      branchName: pr.headRefName,
      prefix: "",
      skipped: false,
      headRefName: pr.headRefName,
    };
  });
}
