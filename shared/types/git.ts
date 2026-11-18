import type { SubmoduleInitPolicy } from "./submodule.js";

/** Git file status */
export type GitStatus =
  "modified" | "added" | "deleted" | "untracked" | "ignored" | "renamed" | "copied" | "conflicted";

/**
 * One file of the change set a diff surface was opened from. Lives in shared
 * types (rather than beside the sidebar that renders it) because it is carried
 * on `DiffPanelData`, and `shared/` cannot reach into `src/`.
 */
/**
 * Which side of the index a diff is taken from: `staged` is HEAD against the
 * index, `unstaged` is the index against the working tree. A request that names
 * neither gets HEAD against the working tree.
 */
export type GitDiffSide = "staged" | "unstaged";

export interface DiffChangeSetEntry {
  /** Repo-relative path */
  path: string;
  status: GitStatus;
  insertions?: number | null;
  deletions?: number | null;
  /**
   * Caller-owned key for the viewed-marker store (scoped per worktree):
   * `working-tree:{path}` for every working-tree surface (one mark per file,
   * shared by the Review Hub's staged and unstaged rows and the change list),
   * `base:{path}` (base-branch review), `since-review:{path}` (Review Hub's
   * Since review view). Not unique within a set: a partially staged file's two
   * entries share it and differ by `side`.
   */
  viewedKey: string;
  /**
   * Set by callers that list a partially staged file twice, so each row's diff
   * is fetched from its own side of the index. Absent means HEAD against the
   * working tree.
   */
  side?: GitDiffSide;
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
  /**
   * Total count of changed files, including untracked files left out of
   * {@link changes}: `changes.length + (omittedUntrackedCount ?? 0)`.
   */
  changedFileCount: number;
  /**
   * Untracked files git status reported that are not in {@link changes}.
   * Per-file enrichment (stat, line count) is capped, the count is not, so the
   * untracked total is the listed untracked rows plus this. Absent means zero;
   * line totals and `latestFileMtime` cover the listed rows only.
   */
  omittedUntrackedCount?: number;
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
  /** Last commit body (everything after the subject), trailers included. Capped. */
  lastCommitBody?: string;
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
 * correspond to the matching `.git/` state files. `APPLYING_MAILBOX` is a
 * halted `git am`, which shares `.git/rebase-apply` with the apply-backend
 * rebase and is told apart by the `applying` file git writes inside it.
 */
export type RepoState =
  "CLEAN" | "DIRTY" | "MERGING" | "REBASING" | "CHERRY_PICKING" | "REVERTING" | "APPLYING_MAILBOX";

/**
 * The halted operation a user chose to abort or continue, captured from the
 * status they were shown (#17559). Main re-reads the worktree immediately
 * before running git and refuses unless the same operation is still there.
 */
export interface RepoOperationPin {
  operation: Exclude<RepoState, "CLEAN" | "DIRTY">;
  /** `StagingStatus.repoOperationId` as shown, `null` when it could not be read. */
  operationId: string | null;
}

/**
 * Why a worktree's git status read ended without an answer. `timed-out`: git
 * ran past its time limit and was stopped. `previous-still-running`: a git
 * already stopped in that worktree had not exited, so no new one was started.
 */
export type GitStatusUnansweredReason = "timed-out" | "previous-still-running";

/** A git status read that did not answer, as observed. Cleared by the next read that does. */
export interface GitStatusUnanswered {
  reason: GitStatusUnansweredReason;
  /** Epoch ms of the first unanswered read since status last answered. */
  since: number;
}

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
 * How a whole-file conflict resolution takes a side. A side that no longer has
 * the file (a modify/delete conflict) is taken by deleting it; `both` is the
 * one deletion offered when neither side has it. Main refuses a choice the
 * index no longer agrees with, so what was confirmed is what runs.
 */
export type ConflictSideChoice =
  | { resolution: "checkout"; side: "ours" | "theirs" }
  | { resolution: "delete"; side: "ours" | "theirs" | "both" };

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
/**
 * The most commits `git:list-remote-commits` will return for one request.
 *
 * The contract, not a client preference: the handler clamps to it, and the
 * force-push confirm asks for it so its D2 preview is never narrower than what
 * the main process would serve. Both sides read this rather than restating a
 * number, so the ceiling can only move in one place.
 */
export const GIT_REMOTE_COMMIT_PREVIEW_MAX = 100;

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
  /**
   * Commits the destination tip has that the branch does not, measured against
   * the same tip the range was. Above zero means git will refuse this push as
   * non-fast-forward. `0` for `creates` (there is no tip) and for `unverified`,
   * where no tip could be read — so `0` there is "unmeasured", not "level".
   */
  behind: number;
  /**
   * The commit the named branch pointed at when every range above was measured.
   * The rows, `total` and `behind` all describe this commit, so an approval of
   * the preview is an approval of publishing exactly this commit (#15646).
   */
  headOid: string;
  /**
   * What is staged on top of `headOid`, read only when the caller asks for it
   * with `includeStaged` (Commit & push's confirm, #17563). A host that
   * predates the option never returns it, so its absence means "not read",
   * never "nothing staged".
   */
  staged?: GitStagedSnapshot;
}

/**
 * The staged changes a Commit & push confirm lists, and the identity a commit
 * made under that confirm must match (#17563).
 *
 * Read in one pass against one tip, so the paths on screen and the identity
 * the commit is held to can never describe two different states of the index.
 */
export interface GitStagedSnapshot {
  /**
   * Opaque. Covers the tip and every staged entry's path, mode and blob, so a
   * change to a staged file's contents alone changes it.
   */
  identity: string;
  /** The staged paths, in git's order. */
  paths: string[];
}

/**
 * What a Commit & push confirm showed about the commit itself: made on this
 * branch, on top of this commit, from exactly these staged changes (#17563).
 * Handed to the commit so it refuses rather than committing anything else when
 * the index moved while the confirm was open.
 */
export interface GitCommitReview {
  branch: string;
  headOid: string;
  stagedIdentity: string;
}

/**
 * What a push confirm put in front of the approver: this branch, at this
 * commit, going to this destination. Handed to the push so it refuses rather
 * than publishing anything else when the worktree moved while the confirm was
 * open (#15646).
 */
export interface GitPushReview {
  branch: string;
  headOid: string;
  destination: GitPushDestination;
}

/** The commit `git.commit` just made. */
export interface GitCommitResult {
  /** The hash as git printed it, which may be abbreviated. */
  hash: string;
  summary: string;
  /**
   * The commit's full OID, read back from that printed hash rather than from
   * `HEAD`, which another commit may already have moved. `null` when it could
   * not be read: the commit still landed, but nothing can be pinned to it.
   */
  oid: string | null;
  /**
   * Its parents, first parent first: the branch tip it was made on top of, then
   * anything a merge commit brought in. Empty for a root commit, or when `oid`
   * is `null`.
   */
  parentOids: string[];
  /**
   * For a commit made under a {@link GitCommitReview}: the identity of what it
   * actually contains over its parent, in {@link GitStagedSnapshot.identity}'s
   * form, read back from the commit itself. `null` when that couldn't be read.
   * Absent when no review was passed, or from a host that predates #17563.
   */
  stagedIdentity?: string | null;
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
  /**
   * The upstream's commits the branch does not have — the rows behind `behind`,
   * newest first, capped at the request limit. What the pull brings in, as of
   * the last fetch. Empty when the range could not be measured.
   */
  incoming: GitRemoteCommit[];
  /**
   * The commit the named branch pointed at once the ranges above were measured,
   * read last so a commit landing mid-read shows up as a refusal on submit
   * rather than an unnoticed substitution. `null` when it could not be read,
   * which leaves the preview with nothing to approve.
   */
  headOid: string | null;
}

/**
 * What a pull-and-rebase confirm put in front of the approver: this branch, at
 * this commit. Handed to the pull so it refuses rather than rebasing whatever
 * the worktree holds by then, when an agent switched branches or committed
 * while the confirm was open (#17188).
 */
export interface GitPullRebaseReview {
  branch: string;
  headOid: string;
}

/**
 * Which direction a base-branch integration runs (#12092).
 *
 * A rebase REPLAYS the branch's own commits on top of the base; a merge brings
 * the BASE's commits into the branch. The two describe opposite ranges, so the
 * kind travels with the preview rather than being inferred from it — an empty
 * commit list means something different for each.
 */
export type GitBaseIntegrationKind = "rebase-onto-base" | "merge-base";

/**
 * Why a rebase-onto-base or merge-base would be refused as the worktree stands
 * (#17189).
 *
 * Read by the preview from the same predicates the write refuses on, so the
 * confirm can say so before approval rather than closing into a failure. The
 * write still re-checks: the worktree can change after the preview.
 *
 * - `operation-in-progress`: a merge, rebase, cherry-pick, revert or `git am` is
 *   halted.
 * - `base-checked-out`: the worktree is on the base branch itself, so
 *   integrating it would rewrite it.
 * - `conflicts`: unmerged paths stand with no operation halted (what a failed
 *   stash pop leaves).
 * - `uncommitted-changes`: staged, unstaged or untracked files, each counted
 *   once.
 */
export type GitBaseIntegrationBlocker =
  | {
      reason: "operation-in-progress";
      operation: Exclude<RepoState, "CLEAN" | "DIRTY">;
      rebaseStep: number | null;
      rebaseTotalSteps: number | null;
    }
  | { reason: "base-checked-out" }
  | { reason: "conflicts"; count: number }
  | { reason: "uncommitted-changes"; count: number };

/**
 * What a rebase-onto-base or merge-base would actually act on.
 *
 * Separate from {@link GitRebaseCommitPreview}, which is measured against the
 * branch's OWN upstream and can therefore always name a `GitPushDestination`.
 * A base target may be a purely local branch in a repo with no remote at all,
 * which that shape cannot describe truthfully — so this one carries the short
 * ref as a string and names the remote only when there is one.
 *
 * A halted operation or a checked-out base branch stops the read before it
 * measures anything, so the target, the range and the counts are `null` there:
 * unmeasured, which must never read as "nothing to integrate". A dirty or
 * conflicted tree is still measured, because what the operation WOULD do is
 * worth seeing while deciding whether to commit first.
 */
export interface GitBaseIntegrationCommitPreview {
  kind: GitBaseIntegrationKind;
  /**
   * The branch the operation would act on, as git resolved it. `null` only
   * when a halted operation stopped the read: a paused rebase detaches HEAD,
   * and its branch is not the one a fresh read would name.
   */
  branch: string | null;
  /** The base branch the worktree measures itself against. */
  baseBranch: string;
  /** What the write would refuse on right now, or `null` when nothing would. */
  blocker: GitBaseIntegrationBlocker | null;
  /**
   * Short ref the operation targets — `upstream/develop`, or a bare `develop`.
   * `null` when a blocker stopped the read before the target was resolved.
   */
  compareRef: string | null;
  /** Remote `compareRef` lives on, or `null` on the local-branch fallback. */
  remote: string | null;
  /**
   * The two commits this preview describes: the branch tip and the base tip.
   *
   * Carried so the confirm can hand them back to the write, which refuses if
   * either has moved. Daintree runs many agents in parallel across worktrees,
   * so a commit landing while the dialog is open is ordinary rather than a
   * race to shrug at — without these the user could approve one replay set and
   * get another. Captured before the range is measured, and every row and
   * count describes them (#17583). Both are present whenever the range was
   * measured, and both are `null` when a blocker stopped the read first; a tip
   * that does not resolve fails the preview instead.
   */
  headOid: string | null;
  baseOid: string | null;
  /**
   * For `rebase-onto-base`, the commits that would be REPLAYED (the branch's
   * own, measured `--cherry-pick --right-only` so commits the base already
   * holds as equivalent patches are excluded). For `merge-base`, the commits
   * that would be BROUGHT IN from the base.
   */
  commits: GitRemoteCommit[];
  /**
   * Commits in the whole set, which may exceed the returned `commits`. `null`
   * when unmeasured.
   */
  total: number | null;
  /**
   * Commits the base has that the branch does not. `null` when unmeasured.
   *
   * Carried for the same reason {@link GitRebaseCommitPreview.behind} is: an
   * empty replay set alone cannot tell "level with the base" from "purely
   * behind it". Both replay nothing; only the second one moves the branch.
   */
  behind: number | null;
}

export interface StagingStatus {
  staged: StagingFileEntry[];
  unstaged: StagingFileEntry[];
  /** @deprecated Use `conflictedFiles` for richer per-file details. Kept for backward compat. */
  conflicted: string[];
  /** Per-file conflict entries parsed from `git status --porcelain=v2` u-lines. */
  conflictedFiles: ConflictedFileEntry[];
  /**
   * Distinct worktree-relative paths whose conflict the index remembers
   * resolving (`git ls-files --resolve-undo`). `staged` also holds the paths
   * git merged cleanly, which never conflicted and never appear here, so this
   * is what tells a resolution from the rest of the staged list.
   *
   * A merge strategy other than `ort` (`resolve`, or `recursive` before git
   * made it an alias of `ort`) may also record the text merges it does by
   * itself, which then read as resolutions here.
   *
   * Read only while an operation is stopped with something staged. Absent when
   * it was not read or the read failed, which says nothing about any path; `[]`
   * is a successful read that found none. Matched against `staged` by exact
   * path, and a path here that is no longer staged is not a staged resolution.
   */
  resolveUndoPaths?: string[];
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
  /**
   * Git reports `currentBranch` as having no commit yet (#17588). Present only
   * on git's own word: a HEAD that merely failed to read leaves it absent. Such
   * a branch has no push destination git can name until its first commit, so
   * `pushDestination` is `null` here for want of a commit, not of configuration.
   */
  isUnbornBranch?: true;
  /** Current in-progress repository operation, or `CLEAN`/`DIRTY`. */
  repoState: RepoState;
  /**
   * Opaque identity of the operation `repoState` names, stable for its whole
   * life (every rebase step, every failed `--continue`) and different for any
   * operation that replaces it, including a restart of the same kind on the
   * same commits (#17559). Abort and Continue hand it back as a
   * {@link RepoOperationPin} so they act on the operation the user saw.
   *
   * `null` when nothing is in progress, and when this read could not identify
   * the operation (an unreadable sentinel, or an operation that changed while
   * the status was being read). A null pin is refused, so null never
   * authorises anything.
   */
  repoOperationId: string | null;
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
  /**
   * How to populate submodules in the new worktree. Defaults to `inherit`.
   *
   * `git worktree add` never populates submodules — not even with
   * `submodule.recurse=true`, which has no effect on that path — so without
   * this a worktree of a submodule repository is born unbuildable and the
   * agent launched into it debugs a phantom missing dependency.
   *
   * A setting rather than a prompt: recipes, fleet creation and MCP-driven
   * creation have nobody to ask.
   */
  submoduleInit?: SubmoduleInitPolicy;
  /**
   * What to do when `newBranch` is already a local branch. Defaults to
   * `suffix`, the long-standing behaviour.
   *
   * `suffix` — recover the way the host always has: reuse the branch when it is
   * not checked out anywhere, otherwise create `name-2`, `name-3`, ... The
   * branch actually used is reported back, so the caller is never left
   * guessing.
   *
   * `error` — fail the create instead of quietly producing a different branch
   * than the one asked for. This is the mode a caller wants when the branch
   * name is load-bearing (an agent creating a worktree for a specific
   * pre-existing branch, a campaign keyed on exact names).
   *
   * Honoured in the host and nowhere else: collision detection rides the `git
   * worktree add` failure, which is atomic. A renderer-side pre-flight cannot
   * implement either policy, because checking a name reserves nothing.
   *
   * Ignored when `useExistingBranch` is set — reuse is not a collision.
   *
   * With `fetchBase`, `suffix` never reuses an existing branch: it sits at
   * whatever commit it was left at, which is exactly the stale start the
   * caller asked to avoid. A collision always suffixes instead.
   */
  collisionPolicy?: WorktreeBranchCollisionPolicy;
  /**
   * Fetch the base from its remote as part of the create and start the new
   * branch at the commit that fetch brought back (#15733). A remote base
   * (`fromRemote`) is fetched as named; a local base is fetched from its
   * upstream, and the local branch itself is left where it is. A failed fetch
   * fails the create with git's reason, and nothing falls back to the
   * last-fetched ref.
   *
   * The branch is created from that commit, not from the ref, so it has no
   * upstream even when it shares the remote branch's name. The commit comes
   * back as `startCommit`. Refused beside `useExistingBranch`.
   */
  fetchBase?: boolean;
}

/**
 * How {@link CreateWorktreeOptions.collisionPolicy} resolves a branch-name
 * collision. See that field for the semantics.
 */
export type WorktreeBranchCollisionPolicy = "suffix" | "error";

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
  /** Omitted counts as true. `false` skips the revision count and reports `total: 0`. */
  includeTotal?: boolean;
}

/** Git commit list response */
export interface GitCommitListResponse {
  items: GitCommit[];
  hasMore: boolean;
  total: number;
}
