import type { GitOperationReason, RecoveryAction } from "../types/ipc/errors.js";

/**
 * Pure classifier for simple-git errors.
 *
 * Works only from the thrown value's `.message` string — simple-git 3.x concats
 * stdout+stderr into `.message` as UTF-8 and does not expose separate fields.
 * Renderer-safe: no Node.js built-ins, no Electron deps.
 *
 * Normalization order is fixed:
 *   1. CRLF → LF  (Git for Windows stderr contains `\r\n`)
 *   2. Strip `^remote: ` per-line  (server output is prefixed — failing to
 *      strip it causes hook rejections to be misclassified as non-fast-forward
 *      push failures; precedent: VS Code #229011)
 *
 * Regex ordering is specific-before-generic. Hook rejections MUST be tested
 * before `push-rejected-outdated` because both can appear on `[remote rejected]`
 * lines. Reordering the PATTERNS array is a regression risk.
 */
export function extractGitErrorMessage(error: unknown): string {
  if (error === null || error === undefined) return "";
  if (typeof error === "string") return error;
  if (typeof error !== "object") return String(error);
  const maybeMessage = (error as { message?: unknown }).message;
  if (typeof maybeMessage === "string") return maybeMessage;
  return String(error);
}

export function normalizeGitErrorMessage(message: string): string {
  return message.replace(/\r\n/g, "\n").replace(/^remote: /gm, "");
}

// ORDER MATTERS — specific before generic. Do not reorder without updating tests.
const PATTERNS: ReadonlyArray<readonly [GitOperationReason, RegExp]> = [
  ["not-a-repository", /fatal: not a git repository/i],
  ["dubious-ownership", /fatal: detected dubious ownership in repository at/i],
  [
    // MUST run before `auth-failed`: GitHub's LFS batch API returns HTTP 403
    // when a repo exceeds its LFS quota, so the quota-specific batch response
    // co-occurs with the same "URL returned error: 403" fragment that
    // `auth-failed` matches. The quota signal is the more actionable root
    // cause, so it has to win the tie. Do not reorder without updating the
    // "prefers lfs-quota-exceeded over auth-failed" test.
    //
    // LFS storage/bandwidth quota signals across major providers:
    //   - GitHub (current): "batch response: This repository exceeded its LFS budget"
    //   - GitHub (classic): "batch response: This repository is over its data quota"
    //   - GitLab:           "reached ... free storage limit ... Git LFS"
    //   - Azure DevOps:     VS403658 or HTTP 413 on LFS pushes
    //
    // The GitLab arm requires an "LFS"/"git-lfs" token nearby so that a plain
    // namespace-level storage limit message does not misclassify as LFS.
    "lfs-quota-exceeded",
    /batch response:.*(?:exceeded.*LFS budget|over.*data quota|LFS budget)|reached.*free storage limit.*(?:Git LFS|git[- ]lfs|LFS)|(?:Git LFS|git[- ]lfs|LFS).*reached.*free storage limit|HTTP 413.*LFS|VS403658:/i,
  ],
  [
    "auth-failed",
    // HTTPS 401/403/407 (auth/perm/proxy-auth) as well as the direct SSH/HTTPS messages.
    /Authentication failed|Permission denied \(publickey\)|could not read Username for|unable to access.*: The requested URL returned error: 40[137]/i,
  ],
  [
    // Run BEFORE repository-not-found: when both signals appear (network failure plus
    // the generic "Could not read from remote repository" follow-up), the network
    // classification is the more actionable root cause.
    "network-unavailable",
    /Could not resolve host:|Failed to connect to.*port.*: Connection refused|unable to access.*: The requested URL returned error: 5\d\d/i,
  ],
  [
    "repository-not-found",
    /Repository not found|fatal: repository '.*' not found|Could not read from remote repository/i,
  ],
  [
    "hook-rejected",
    /\[remote rejected\].*\((?:pre-receive hook declined|pre-receive hook|update hook|post-receive hook)/i,
  ],
  [
    "push-rejected-policy",
    // GH006: protected branch, GH013: ruleset violation (modern GitHub), generic 'protected
    // branch' / 'file size' / pack-size / ruleset-violation wording.
    /GH006: Protected branch|GH013: Repository rule violations|error:.*protected branch|error:.*file size|pack exceeds maximum allowed size|push declined due to repository rule violations/i,
  ],
  ["push-rejected-outdated", /! \[rejected\].*\(non-fast-forward\)/i],
  [
    "conflict-unresolved",
    /CONFLICT \(|Merge conflict in |error: (?:merge is not possible because you have unmerged files|pull is not possible because you have unmerged files)/i,
  ],
  [
    "worktree-dirty",
    /Your local changes to the following files would be overwritten by (?:merge|checkout|pull)|error: (?:cannot|Cannot) (?:pull with rebase|pull )/i,
  ],
  [
    "pathspec-invalid",
    // `couldn't find remote ref ...` is also a missing-ref error (e.g. `git fetch pull/99999/head`).
    /fatal: (?:bad revision|needed a single revision|pathspec '.*' did not match|ambiguous argument)|couldn't find remote ref/i,
  ],
  ["lfs-missing", /external filter 'git-lfs filter-process' failed|smudge filter lfs failed/i],
  [
    "config-missing",
    // Covers the older 'has no upstream branch' and the newer 'no upstream configured for branch'.
    /fatal: unable to read config file|fatal: bad config|fatal: The current branch .* has no upstream branch|fatal: no upstream configured for branch/i,
  ],
  [
    "system-io-error",
    /ENOENT|EACCES|EPERM|EBUSY|Disk full|No space left on device|could not create work tree dir/i,
  ],
];

export function classifyGitError(error: unknown): GitOperationReason {
  const raw = extractGitErrorMessage(error);
  if (!raw) return "unknown";
  const normalized = normalizeGitErrorMessage(raw);
  for (const [reason, pattern] of PATTERNS) {
    if (pattern.test(normalized)) return reason;
  }
  return "unknown";
}

const RECOVERY_HINTS: Record<GitOperationReason, string | undefined> = {
  "auth-failed": "Check your Git credentials or SSH key configuration.",
  "network-unavailable": "Check your internet connection and try again.",
  "repository-not-found":
    "The remote repository is unreachable — check the URL or your access permissions.",
  "not-a-repository": "Run 'git init' or open a folder containing a git repo.",
  "dubious-ownership":
    "Git refuses to operate on this repo because its owner doesn't match the current user.",
  "config-missing": "The current branch is missing upstream or config — set an upstream to push.",
  "worktree-dirty":
    "You have local changes that would be overwritten — commit or stash them first.",
  "conflict-unresolved": "Resolve the merge conflicts and commit before continuing.",
  "push-rejected-outdated":
    "The remote has commits you don't have locally — pull or rebase before pushing.",
  "push-rejected-policy":
    "The remote rejected this push (protected branch, hook, or size limit). Contact the repo admin.",
  "pathspec-invalid": "The specified ref or path does not exist.",
  "lfs-missing": "Git LFS objects are missing — install git-lfs and run 'git lfs pull'.",
  "lfs-quota-exceeded":
    "This repository has exceeded its Git LFS storage or bandwidth quota. Contact the repo owner or upgrade the plan.",
  "hook-rejected": "A server-side hook rejected the push. See the server output for details.",
  "system-io-error": "A filesystem or permissions problem prevented the git operation.",
  unknown: undefined,
};

export function getGitRecoveryHint(reason: GitOperationReason): string | undefined {
  return RECOVERY_HINTS[reason];
}

const RECOVERY_ACTIONS: Partial<Record<GitOperationReason, RecoveryAction>> = {
  "auth-failed": { label: "Sign in with GitHub", actionId: "github.auth" },
  "push-rejected-outdated": { label: "Pull latest", actionId: "git.pull" },
  "conflict-unresolved": { label: "Resolve conflicts", actionId: "git.resolveConflicts" },
  "dubious-ownership": { label: "Trust this repo", actionId: "git.trustRepository" },
};

export function getGitRecoveryAction(reason: GitOperationReason): RecoveryAction | undefined {
  return RECOVERY_ACTIONS[reason];
}
