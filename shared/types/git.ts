/** Git file status */
export type GitStatus =
  "modified" | "added" | "deleted" | "untracked" | "ignored" | "renamed" | "copied" | "conflicted";

/**
 * One file of the change set a diff surface was opened from. Lives in shared
 * types (rather than beside the sidebar that renders it) because it is carried
 * on `DiffPanelData`, and `shared/` cannot reach into `src/`.
 */
export interface DiffChangeSetEntry {
  /** Repo-relative path */
  path: string;
  status: GitStatus;
  insertions?: number | null;
  deletions?: number | null;
  /**
   * Caller-owned key for the viewed-marker store (scoped per worktree).
   * Callers keep their existing conventions: `staged:{path}` /
   * `unstaged:{path}` (Review Hub), `{status}:{path}` (change list),
   * `base:{path}` (base-branch review).
   */
  viewedKey: string;
}

/** Details about a single file change in a worktree */
export interface FileChangeDetail {
  /** Relative path to the file from worktree root */
  path: string;
  /** Git status of the file */
  status: GitStatus;
  /** Number of lines inserted (null if not applicable) */
  insertions: number | null;
  /** Number of lines deleted (null if not applicable) */
  deletions: number | null;
  /** File modification time in milliseconds (for recency scoring) */
  mtimeMs?: number;
  /** Alias for mtimeMs (compatibility with some APIs) */
  mtime?: number;
}

/** Aggregated git changes for a worktree */
export interface WorktreeChanges {
  /** Unique identifier for the worktree */
  worktreeId: string;
  /** Absolute path to worktree root */
  rootPath: string;
  /** List of individual file changes */
  changes: FileChangeDetail[];
  /** Total count of changed files */
  changedFileCount: number;
  /** Total lines inserted across all files */
  totalInsertions?: number;
  /** Total lines deleted across all files */
  totalDeletions?: number;
  /** Alias for totalInsertions (compatibility) */
  insertions?: number;
  /** Alias for totalDeletions (compatibility) */
  deletions?: number;
  /** Most recent file modification time */
  latestFileMtime?: number;
  /** Timestamp when changes were last calculated */
  lastUpdated?: number;
  /**
   * HEAD object id. Already resolved for the last-commit log cache key, so it
   * costs nothing extra — it is the drift baseline the "move panel only"
   * backstop compares against (#11840). Empty on an unborn HEAD, hence omitted.
   */
  headOid?: string;
  /** Last commit message (cached to avoid extra git log calls) */
  lastCommitMessage?: string;
  /** Last commit time (ms since epoch, committer date) */
  lastCommitTimestampMs?: number;
  /** Last commit author. Only set when git log reports a non-empty author name. */
  lastCommitAuthor?: { name: string; email: string };
  /** Commits ahead of upstream from `git status --porcelain -b` (undefined when no upstream). */
  ahead?: number;
  /** Commits behind upstream from `git status --porcelain -b` (undefined when no upstream). */
  behind?: number;
  /** Upstream branch name (e.g. "origin/main"); `null` when no upstream is configured. */
  tracking?: string | null;
}

export interface StagingFileEntry {
  path: string;
  status: GitStatus;
  insertions: number | null;
  deletions: number | null;
}

/**
 * In-progress repository operation state. `CLEAN` means no operation markers
 * and no unmerged entries; `DIRTY` means unmerged entries exist without an
 * operation marker (unusual). `MERGING`/`REBASING`/`CHERRY_PICKING`/`REVERTING`
 * correspond to the matching `.git/` state files.
 */
export type RepoState = "CLEAN" | "DIRTY" | "MERGING" | "REBASING" | "CHERRY_PICKING" | "REVERTING";

/** XY code from `git status --porcelain=v2` unmerged (`u`) entries. */
export type ConflictXYCode = "UU" | "AA" | "DD" | "AU" | "UA" | "DU" | "UD";

export interface ConflictedFileEntry {
  path: string;
  /** The two-letter unmerged code (e.g. `UU`). Unknown codes are passed through as-is. */
  xy: string;
  /** Human-readable label derived from the XY code (e.g. "both modified"). */
  label: string;
}

/**
 * Normalized rebase-todo action. Aliases (`p`/`pick`, `s`/`squash`, etc.) collapse
 * onto the long form. Structural lines (`exec`, `break`, `label`, `reset`, `merge`,
 * `update-ref`) fold into `other` so the renderer can de-emphasize them uniformly.
 */
export type RebaseAction =
  "pick" | "reword" | "edit" | "squash" | "fixup" | "drop" | "exec" | "other";

/** Per-entry progress within an in-flight rebase. */
export type RebaseEntryState = "done" | "current" | "pending";

export interface RebaseEntry {
  /** Normalized action keyword. */
  action: RebaseAction;
  /** Abbreviated SHA from the todo line, or `null` for actions without a commit (`exec`, `other`). */
  sha: string | null;
  /** Commit subject or, for `exec`, the command string. May be empty. */
  subject: string;
  /** Progress state derived from the done/todo file split. */
  state: RebaseEntryState;
}

export interface RebaseSequence {
  /** Ordered: done entries first, then the current one, then pending. */
  entries: RebaseEntry[];
  /** Only `merge` carries full entry data; `apply` falls back to step counters. */
  backend: "merge" | "apply";
}

/**
 * Where a branch actually pushes, as git resolved it (#11746).
 *
 * Renderer-safe half of the main-process resolution: the confirm surfaces need
 * to name the destination they are about to write to, but have no business
 * knowing the remote-tracking ref behind it.
 */
export interface GitPushDestination {
  /** Remote name, e.g. `origin` or `fork`. May itself contain slashes. */
  remote: string;
  /** Branch name on the remote side, which need not match the local name. */
  branch: string;
}

/** One commit that a force-push would discard from the remote. */
export interface GitRemoteCommit {
  hash: string;
  date: string;
  message: string;
  author: string;
}

/**
 * Discard preview for the force-push confirm: the commits, the destination they
 * live on, and the full count over the same range the rows came from.
 */
export interface GitRemoteCommitPreview {
  destination: GitPushDestination;
  commits: GitRemoteCommit[];
  /** Total commits in the range, which may exceed the returned `commits`. */
  total: number;
}

/**
 * What a push would actually publish, over the range git itself resolved.
 *
 * Distinct from a branch's recent history, which is what a plain `git log HEAD`
 * returns: the two diverge for every branch that is not entirely unpushed, and a
 * D2 confirm that shows the second while claiming the first is showing commits
 * the push will not write (#11979).
 */
export interface GitPushCommitPreview {
  destination: GitPushDestination;
  /**
   * How the range was established, which decides what the rows may be called.
   *
   * - `tracked` — the delta against the destination tip is exact, either from a
   *   local remote-tracking ref or from a tip the remote named that this
   *   repository already has.
   * - `creates` — the remote confirmed the destination branch does not exist, so
   *   the push creates it and the rows are the branch's own history.
   * - `unverified` — neither could be established (no tracking ref, and the
   *   remote could not be reached or named a tip this repository does not hold).
   *   The rows are a local approximation that can BOTH overstate and understate,
   *   so callers must present them as unverified — and an empty one means
   *   "nothing found locally", never "the destination is up to date".
   */
  rangeBasis: "tracked" | "creates" | "unverified";
  commits: GitRemoteCommit[];
  /** Total commits in the range, which may exceed the returned `commits`. */
  total: number;
}

/**
 * The commits a `git pull --rebase` would replay, and what it would replay them onto.
 *
 * Separate from {@link GitPushCommitPreview} rather than a shared shape with a
 * wider `rangeBasis`: a rebase has no "creates the branch" case and needs no
 * network read, so folding the two together would leave a pull-rebase preview
 * holding fields that were never measured for it.
 */
export interface GitRebaseCommitPreview {
  /** The upstream the rebase would replay onto, as git resolved it. */
  upstream: GitPushDestination;
  /**
   * How the replay set was established.
   *
   * - `tracked` — the delta against the upstream's remote-tracking ref is exact.
   * - `unfetched` — the upstream is configured but has never been fetched into
   *   this worktree, so there is no local ref to subtract from and the set
   *   cannot be measured. `commits` is empty and `total` is 0, and NEITHER
   *   means "nothing would be replayed".
   */
  rangeBasis: "tracked" | "unfetched";
  commits: GitRemoteCommit[];
  /** Commits in the whole replay set, which may exceed the returned `commits`. */
  total: number;
  /**
   * Commits the upstream has that the branch does not — what the rebase would
   * bring in.
   *
   * Carried because an empty replay set alone cannot tell "level with the
   * upstream" from "purely behind it". Both replay nothing; only the second one
   * moves the branch, so calling either "already matches" is wrong half the time.
   * `0` when the range could not be measured.
   */
  behind: number;
}

export interface StagingStatus {
  staged: StagingFileEntry[];
  unstaged: StagingFileEntry[];
  /** @deprecated Use `conflictedFiles` for richer per-file details. Kept for backward compat. */
  conflicted: string[];
  /** Per-file conflict entries parsed from `git status --porcelain=v2` u-lines. */
  conflictedFiles: ConflictedFileEntry[];
  isDetachedHead: boolean;
  currentBranch: string | null;
  hasRemote: boolean;
  /**
   * Resolved push destination for `currentBranch`, or `null` when git has no
   * unambiguous answer (#11746). Distinct from `hasRemote`: a repo can have
   * remotes while this branch still has no destination anyone can name, and
   * confirm surfaces must block the write and say so rather than assume
   * `origin`.
   */
  pushDestination: GitPushDestination | null;
  /**
   * Resolved upstream for `currentBranch` — where a pull-and-rebase would
   * integrate FROM. Distinct from `pushDestination`: a triangular branch tracks
   * `origin/release/topic` while pushing to `fork/topic`, so a pull surface that
   * named the push destination would describe the wrong repository.
   */
  pullSource: GitPushDestination | null;
  /** Current in-progress repository operation, or `CLEAN`/`DIRTY`. */
  repoState: RepoState;
  /** When `repoState === "REBASING"`, the current step number (1-based). Null otherwise. */
  rebaseStep: number | null;
  /** When `repoState === "REBASING"`, the total step count. Null otherwise. */
  rebaseTotalSteps: number | null;
  /**
   * When `repoState === "REBASING"` and the merge backend is in use, the full sequence
   * parsed from `.git/rebase-merge/done` + `git-rebase-todo`. Null for the apply backend,
   * non-rebase states, and read failures — consumers must degrade gracefully.
   */
  rebaseSequence: RebaseSequence | null;
}

/** Branch information from git */
export interface BranchInfo {
  name: string;
  current: boolean;
  commit: string;
  remote?: string;
  /**
   * ISO-8601 committer date of the branch tip, from a best-effort
   * `for-each-ref` pass alongside `git branch -a`. Absent when that pass
   * failed or the ref carried no date — consumers must treat it as optional
   * enrichment, never as a required field.
   */
  committerDate?: string;
}

/** Options for creating a new worktree */
export interface CreateWorktreeOptions {
  baseBranch: string;
  newBranch: string;
  path: string;
  fromRemote?: boolean;
  useExistingBranch?: boolean;
  /** Opt-in flag to run resource.provision after setup */
  provisionResource?: boolean;
  /** Worktree environment mode ("local" or an environment key from resourceEnvironments) */
  worktreeMode?: string;
  /**
   * Source PR number when the worktree is created from the GitHub PR dropdown.
   * Captured eagerly so the worktree's linked PR is seeded at creation time
   * rather than waiting for PullRequestService branch-name polling (#8888).
   */
  sourcePrNumber?: number;
  /** Source PR title (for immediate headline display). */
  sourcePrTitle?: string;
  /** Source PR URL. */
  sourcePrUrl?: string;
  /** Source PR state, normalized to the workspace-host lowercase form. */
  sourcePrState?: "open" | "closed" | "merged";
  /**
   * Closing issue number for the source PR, extracted from `closingIssuesReferences`
   * or a body-parse of `Closes/Fixes/Resolves #N`. Undefined when the PR closes no issue.
   */
  sourcePrLinkedIssueNumber?: number;
}

/** Git commit author */
export interface GitCommitAuthor {
  name: string;
  email: string;
}

/** Git commit representation */
export interface GitCommit {
  hash: string;
  shortHash: string;
  message: string;
  body?: string;
  author: GitCommitAuthor;
  date: string;
}

/** Git commit list options */
export interface GitCommitListOptions {
  cwd: string;
  search?: string;
  branch?: string;
  skip?: number;
  limit?: number;
}

/** Git commit list response */
export interface GitCommitListResponse {
  items: GitCommit[];
  hasMore: boolean;
  total: number;
}
