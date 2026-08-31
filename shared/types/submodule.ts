/**
 * Submodule types — depth 1 only.
 *
 * Everything here models the parent repository's *direct* gitlinks. Nested
 * submodules (a submodule that itself has submodules) are deliberately not
 * represented: recursion multiplies clone cost and credential prompts against
 * arbitrary third-party URLs, and git stops at the first failure leaving a
 * half-initialized tree. If recursion is ever wanted it is an opt-in that adds
 * a new field, not a reinterpretation of these.
 *
 * The roster authority is the parent index, NOT `.gitmodules`. A tree entry
 * with mode `160000` is a real nested repository boundary holding real work
 * whether or not anyone remembered to configure it; a `.gitmodules` stanza with
 * no matching gitlink is stale config. The two disagree routinely and each
 * disagreement is a state a safety gate has to survive.
 */

/**
 * Derived resting state of one submodule, at depth 1.
 *
 * Deliberately does NOT include "detached HEAD". `git submodule update` checks
 * out a bare commit OID, so detached is the healthy resting state of a
 * correctly-configured submodule — modelling it as a state would paint a
 * warning on every well-behaved submodule in the repository.
 */
export type SubmoduleState =
  /** Recorded in the index but never checked out — nothing on disk to lose. */
  | "uninitialized"
  /** Checked out, and its HEAD matches the OID the parent records. */
  | "at-recorded-commit"
  /** Checked out at a different commit than the parent records (v2 `SC..`). */
  | "moved"
  /** Merge conflict on the gitlink — the index carries stages 1/2/3. */
  | "conflicted";

/** Per-project policy for populating submodules in a newly created worktree. */
export type SubmoduleInitPolicy =
  /**
   * Default. Initialize only the modules already initialized in the source
   * checkout. Matches what the user already has open, so a repo whose optional
   * 4GB vendor tree was deliberately left out does not silently acquire it.
   */
  | "inherit"
  /** Initialize every module the target branch's index records. */
  | "all"
  /** Leave every module uninitialized. */
  | "none";

/**
 * One direct submodule of a parent worktree.
 *
 * `recordedOid` always exists (it IS the index entry). `headOid` is what is
 * actually checked out and is absent when uninitialized — note that porcelain
 * v2 cannot supply it: a `1` record carries the recorded gitlink OID twice and
 * the submodule's real HEAD appears nowhere in status output.
 */
export interface SubmoduleEntry {
  /** Repo-relative path, taken from the index gitlink. */
  path: string;
  /**
   * `submodule.<name>` from `.gitmodules`. Absent for a gitlink with no
   * stanza — malformed, but still a real repository holding real work.
   */
  name?: string;
  state: SubmoduleState;
  /** The OID the parent's index records for this path. */
  recordedOid: string;
  /** The OID actually checked out. Absent when uninitialized. */
  headOid?: string;
  /** Attached branch name. Absent when detached, which is the normal case. */
  branch?: string;
  /** `submodule.<name>.branch`, when the repository configures an intent. */
  configuredBranch?: string;
  /** `submodule.<name>.url`, for diagnostics and re-clone. */
  url?: string;
  /** v2 sub-state `S.M.` — modified tracked content in the working tree. */
  hasModifiedContent: boolean;
  /** v2 sub-state `S..U` — untracked files in the working tree. */
  hasUntrackedContent: boolean;
}

/** One commit inside a submodule that the parent repository does not hold. */
export interface SubmoduleAtRiskCommit {
  oid: string;
  /** First line of the commit message. */
  subject: string;
}

/**
 * What deleting a worktree would destroy inside its submodules.
 *
 * This is the delete gate's model and it is deliberately NOT part of
 * `WorktreeChanges`. Two reasons, both load-bearing:
 *
 *  1. `worktreeDeletePreview.summarizeWorktreeChanges` classifies the parent's
 *     change list purely on `status`, so injecting nested paths there silently
 *     moves the D2/D3 tier.
 *  2. `WorktreeChanges` rides the hot snapshot path through `SnapshotBuilder`,
 *     a one-level cache clone in `electron/utils/git.ts`, a state hash, and a
 *     renderer equality function with a `lastUpdated`+`headOid` fast path.
 *     A nested object added there would be shared by reference across cache
 *     hits and dropped by the fast path.
 *
 * A linked worktree gets its OWN module directory under
 * `.git/worktrees/<id>/modules/<path>` with a SEPARATE object store — no
 * `alternates` file. `git worktree remove --force` deletes that tree wholesale,
 * so commits made inside a worktree's submodule exist nowhere else and are
 * unrecoverable once the worktree is gone. That is the entire reason this type
 * exists.
 */
export interface SubmoduleDeleteRisk {
  /** Every direct submodule found by the deletion roster union. */
  entries: SubmoduleEntry[];
  /**
   * Actual nested file paths that would be discarded, each prefixed with its
   * submodule path (`vendor/lib/src/main.c`). The D2 rule requires the preview
   * to show real content — a count is insufficient, and one row reading
   * `M vendor/lib` for two hundred dirty files is worse than a count because
   * it reads as precise.
   */
  dirtyFiles: string[];
  /** Untracked nested file paths that would be discarded, same prefixing. */
  untrackedFiles: string[];
  /**
   * Commits reachable only from a worktree-owned module repository — not in the
   * parent's object store and not on any remote. Losing these is the
   * unrecoverable case.
   */
  atRiskCommits: SubmoduleAtRiskCommit[];
  /**
   * True when `git worktree remove` will refuse without `--force`.
   *
   * The refusal is gated purely on the existence of
   * `<worktree gitdir>/modules` — not on dirtiness, and not on the index
   * gitlink. `git submodule deinit` does NOT clear it (and must never be run:
   * deinit inside a linked worktree strips `[submodule]` stanzas from the
   * SHARED `.git/config`, unregistering the module for every other worktree).
   */
  requiresMechanicalForce: boolean;
  /**
   * True when the inventory could not be completed — a git invocation failed,
   * timed out, or a module directory was unreadable. Callers MUST fail closed
   * on this: an unknown risk is treated as a risk, never as "nothing found".
   */
  incomplete: boolean;
}
