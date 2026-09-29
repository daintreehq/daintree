const ISSUE_PATTERNS = [/issue-(\d+)/i, /issues?\/(\d+)/i, /#(\d+)/, /gh-(\d+)/i, /jira-(\d+)/i];

// A pure memo keyed by every branch name the workspace host has seen, so it is
// capped: the oldest entry goes first and is simply recomputed if seen again.
const ISSUE_CACHE_MAX_ENTRIES = 1000;
const issueCache = new Map<string, number | null>();

function cacheIssue(key: string, value: number | null): number | null {
  if (issueCache.size >= ISSUE_CACHE_MAX_ENTRIES) {
    const oldest = issueCache.keys().next().value;
    if (oldest !== undefined) issueCache.delete(oldest);
  }
  issueCache.set(key, value);
  return value;
}

const SKIP_BRANCHES = ["main", "master", "develop", "staging", "production", "release", "hotfix"];

/** Test-only: the memo's current entry count. */
export function getIssueCacheSizeForTest(): number {
  return issueCache.size;
}

export function extractIssueNumberSync(branchName: string, folderName?: string): number | null {
  if (!branchName || typeof branchName !== "string") {
    return null;
  }

  const trimmedBranch = branchName.trim();
  if (!trimmedBranch) {
    return null;
  }

  const cacheKey = folderName ? `${trimmedBranch}|${folderName}` : trimmedBranch;

  if (issueCache.has(cacheKey)) {
    return issueCache.get(cacheKey)!;
  }

  const lowerBranch = trimmedBranch.toLowerCase();
  if (SKIP_BRANCHES.some((skip) => lowerBranch === skip || lowerBranch.startsWith(`${skip}/`))) {
    return cacheIssue(cacheKey, null);
  }

  for (const pattern of ISSUE_PATTERNS) {
    const match = trimmedBranch.match(pattern);
    if (match?.[1]) {
      const num = parseInt(match[1], 10);
      if (!isNaN(num) && num > 0) {
        return cacheIssue(cacheKey, num);
      }
    }
  }

  if (folderName) {
    const trimmedFolder = folderName.trim();
    for (const pattern of ISSUE_PATTERNS) {
      const match = trimmedFolder.match(pattern);
      if (match?.[1]) {
        const num = parseInt(match[1], 10);
        if (!isNaN(num) && num > 0) {
          return cacheIssue(cacheKey, num);
        }
      }
    }
  }

  return cacheIssue(cacheKey, null);
}

export async function extractIssueNumber(
  branchName: string,
  folderName?: string
): Promise<number | null> {
  return extractIssueNumberSync(branchName, folderName);
}

const BRANCH_SLUG_PATTERN = /^(?:[a-zA-Z]+-)?\d+-(.+)$/;

/**
 * Derive a sentence-cased title from Daintree's `issue-<n>-<slug>` branch
 * naming convention so the worktree sidebar has an offline fallback when the
 * canonical GitHub issue title hasn't been fetched yet. Lossy by design — the
 * slug truncates and lower-cases the original title, so we don't try to
 * reconstruct casing beyond capitalizing the first character.
 */
export function deriveIssueTitleFromBranch(branchName: string): string | undefined {
  if (!branchName || typeof branchName !== "string") {
    return undefined;
  }
  const trimmed = branchName.trim();
  if (!trimmed) return undefined;

  const lastSegment = trimmed.includes("/") ? trimmed.slice(trimmed.lastIndexOf("/") + 1) : trimmed;
  const match = lastSegment.match(BRANCH_SLUG_PATTERN);
  if (!match?.[1]) return undefined;

  const slug = match[1].replace(/[_-]+/g, " ").trim();
  if (!slug) return undefined;

  return slug.charAt(0).toUpperCase() + slug.slice(1);
}
