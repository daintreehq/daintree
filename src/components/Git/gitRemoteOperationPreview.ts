/**
 * Canonical fresh preview for the push / pull-rebase confirm surfaces (#11538).
 *
 * `git.push` (D2) and `git.pullRebase` (D1) each confirm on two different
 * surfaces depending on dispatch source: the local deferred-Promise dialogs for
 * palette/keybinding/user dispatch, and the MCP confirm modal for agent
 * dispatch. Both must preview the SAME actual content — the target branch and
 * the local commits — or the safeguard silently weakens depending on who asked.
 * This module owns the one fresh fetch and the plain-line formatter the MCP
 * surface renders, so the two can't drift apart.
 */

import type { GitPushDestination } from "@shared/types/git";
import { MCP_PREVIEW_CAUTION_PREFIX } from "@/lib/mcpPreviewLines";

/** Max commits fetched and shown before the tail is collapsed. */
export const PREVIEW_COMMIT_LIMIT = 12;

/** Which remote ref the previewed operation acts on — they diverge triangularly. */
export type GitRemoteOperationKind = "push" | "pull-rebase";

const SHORT_HASH_LEN = 7;

export interface GitPreviewCommit {
  hash: string;
  message: string;
  author: string;
}

/**
 * Push-only facts about the range `commits` was drawn from.
 *
 * Kept in its own object rather than flattened onto the preview so a
 * pull-rebase preview cannot accidentally read a count that was never measured
 * for it: `null` means "no range was measured", which is a different statement
 * from "the range is empty".
 */
export interface GitPushRangeFacts {
  /** Commits in the whole range, which may exceed the rows in `commits`. */
  total: number;
  /**
   * How the rows were established — see `GitPushCommitPreview.rangeBasis`.
   * `creates` and `tracked` are both settled answers; `unverified` is not, and
   * an empty `unverified` range is NOT evidence the destination is up to date.
   */
  rangeBasis: "tracked" | "creates" | "unverified";
}

/**
 * Pull-rebase-only facts about the range `commits` was drawn from.
 *
 * Kept apart from {@link GitPushRangeFacts} for the same reason that one is kept
 * off a rebase preview: `null` means "no range was measured", which is a
 * different statement from "the range is empty".
 */
export interface GitRebaseRangeFacts {
  /** Commits in the whole replay set, which may exceed the rows in `commits`. */
  total: number;
  /**
   * How the rows were established — see `GitRebaseCommitPreview.rangeBasis`.
   * `tracked` is a settled answer; `unfetched` is not, and an empty `unfetched`
   * range is NOT evidence that nothing would be replayed.
   */
  rangeBasis: "tracked" | "unfetched";
}

export interface GitRemoteOperationPreview {
  /** `null` for a detached HEAD — `getStagingStatus` reports no current branch. */
  branch: string | null;
  /**
   * The commits the operation would act on.
   *
   * Never the branch's recent history: for `"push"` the actual publish range
   * (`<destination>..<branch>`), for `"pull-rebase"` the actual replay set
   * (`<upstream>..<branch>`). See {@link buildGitRemoteOperationPreview}.
   */
  commits: GitPreviewCommit[];
  /**
   * Where the operation would actually write, as git resolved it, or `null`
   * when it has no unambiguous answer (#11746). `null` blocks confirm: an
   * approver can't sanction a destination nobody can name, and the main-process
   * handler would refuse the write anyway.
   */
  destination: GitPushDestination | null;
  /** Where a pull-and-rebase would integrate FROM — the upstream, not the push target. */
  pullSource: GitPushDestination | null;
  /**
   * Set only for `"push"`, and only once the destination resolved and the range
   * was measured. `null` everywhere else.
   */
  pushRange: GitPushRangeFacts | null;
  /**
   * Set only for `"pull-rebase"`, and only once the upstream resolved and the
   * range was measured. `null` everywhere else.
   */
  rebaseRange: GitRebaseRangeFacts | null;
}

/**
 * Fetch what `operation` would actually act on in `cwd`, fresh at call time.
 *
 * Deliberately un-cached: the preview must describe the repository state at the
 * moment the human is asked to approve, not a snapshot taken earlier (#8725).
 * Rejects if a read rejects — callers decide how to surface that (the local
 * dialogs show a retryable error and keep confirm disabled; the MCP surface
 * shows a "couldn't verify" note).
 *
 * `operation` decides which remote ref the range is measured against, and the
 * two are genuinely different refs in a triangular workflow:
 *
 * - **push** reads the real publish range through `git.listPushCommits`, which
 *   ranges from the resolved destination's remote-tracking ref up to the named
 *   branch (#11979).
 * - **pull-rebase** reads the real replay set through `git.listRebaseCommits`,
 *   which ranges from the UPSTREAM's remote-tracking ref up to the named branch
 *   (#11980). It used to read recent local history through `git.listCommits`,
 *   which listed commits the upstream already had under a heading promising they
 *   were about to be rewritten — and, because that IPC swallows git failures
 *   into an empty list, rendered a broken repository as "no local commits" with
 *   the rebase still approvable.
 *
 * Both fail CLOSED: any git failure rejects, so "the read broke" can never
 * arrive looking like "there is nothing to do".
 *
 * The branch is read first and then named explicitly in the range read, rather
 * than letting main resolve `HEAD` a second time: the two diverge the moment
 * anything checks out another branch between the two calls, and a range measured
 * against the wrong local branch can report "nothing to publish" for a push that
 * publishes plenty.
 */
export async function buildGitRemoteOperationPreview(
  cwd: string,
  operation: GitRemoteOperationKind
): Promise<GitRemoteOperationPreview> {
  const status = await window.electron.git.getStagingStatus(cwd);
  const base = {
    branch: status.currentBranch,
    destination: status.pushDestination,
    pullSource: status.pullSource,
  };

  if (operation === "push") {
    // No branch or no nameable destination means there is no range to measure.
    // Both states already block confirm on their own terms, and the dialog says
    // which one it is rather than showing an empty list that reads as "safe".
    if (!status.currentBranch || !status.pushDestination) {
      return { ...base, commits: [], pushRange: null, rebaseRange: null };
    }
    const preview = await window.electron.git.listPushCommits(
      cwd,
      status.currentBranch,
      PREVIEW_COMMIT_LIMIT
    );
    return {
      ...base,
      // Main resolves the destination independently for the range read. Prefer
      // its answer: it is the one the rows were actually measured against.
      destination: preview.destination,
      commits: preview.commits.map((c) => ({
        hash: c.hash,
        message: c.message,
        author: c.author,
      })),
      pushRange: {
        total: preview.total,
        rangeBasis: preview.rangeBasis,
      },
      rebaseRange: null,
    };
  }

  // Same shape as the push branch: no branch or no nameable upstream means there
  // is no range to measure, and each blocks confirm on its own terms.
  if (!status.currentBranch || !status.pullSource) {
    return { ...base, commits: [], pushRange: null, rebaseRange: null };
  }
  const preview = await window.electron.git.listRebaseCommits(
    cwd,
    status.currentBranch,
    PREVIEW_COMMIT_LIMIT
  );
  return {
    ...base,
    // Main resolves the upstream independently for the range read, so prefer its
    // answer over the status read's for the same reason push does.
    pullSource: preview.upstream,
    commits: preview.commits.map((c) => ({
      hash: c.hash,
      message: c.message,
      author: c.author,
    })),
    pushRange: null,
    rebaseRange: {
      total: preview.total,
      rangeBasis: preview.rangeBasis,
    },
  };
}

/**
 * Render a preview as plain lines for the MCP confirm surface, so an approver
 * sees the real branch and commits rather than raw `{cwd, setUpstream}` args
 * (the D2 "preview of actual content" rule).
 *
 * `null` means the fresh fetch could not be verified: surface that explicitly
 * rather than an empty list, which would imply "nothing to push". An empty
 * `commits` array IS a valid loaded state and never gets a warning — what it is
 * allowed to say about the remote is decided by {@link emptyLines}.
 */
export function formatGitRemoteOperationPreviewLines(
  preview: GitRemoteOperationPreview | null,
  emptyNote: string,
  operation: GitRemoteOperationKind
): string[] {
  if (preview === null) {
    return [
      `${MCP_PREVIEW_CAUTION_PREFIX}Could not verify the branch and local commits — proceed with caution.`,
    ];
  }
  const branchLine = `Branch: ${preview.branch ?? "(detached HEAD)"}`;
  // Named before the commits: which repository this writes to is the fact an
  // approver most needs and could least infer from the args (#11746). A
  // pull-rebase names its UPSTREAM — the ref the handler will actually rebase
  // onto — not the push target it never touches.
  const isPullRebase = operation === "pull-rebase";
  const remoteRef = isPullRebase ? preview.pullSource : preview.destination;
  const destinationLine = remoteRef
    ? `${isPullRebase ? "Rebases onto" : "Destination"}: ${formatGitPushDestination(remoteRef)}${
        preview.pushRange?.rangeBasis === "creates"
          ? " (this push creates the branch)"
          : preview.pushRange?.rangeBasis === "unverified"
            ? " (could not reach the remote — the commits below are unverified)"
            : ""
      }`
    : isPullRebase
      ? `${MCP_PREVIEW_CAUTION_PREFIX}This branch has no upstream to rebase onto — this operation will be refused.`
      : `${MCP_PREVIEW_CAUTION_PREFIX}No push destination is configured for this branch — this operation will be refused.`;
  if (preview.commits.length === 0) {
    return [destinationLine, branchLine, ...emptyLines(preview, emptyNote, operation)];
  }
  // The tail is only stated when a total was actually measured over the same
  // range the rows came from. Deriving it from anything else would let the
  // approver read a count that describes a different set of commits.
  const measuredTotal = preview.pushRange?.total ?? preview.rebaseRange?.total ?? null;
  const hidden = measuredTotal === null ? 0 : Math.max(0, measuredTotal - preview.commits.length);
  return [
    destinationLine,
    branchLine,
    ...preview.commits.map(
      (c) => `  ${c.hash.slice(0, SHORT_HASH_LEN)} ${c.message} — ${c.author}`
    ),
    ...(hidden > 0 ? [`  …and ${hidden} more`] : []),
  ];
}

/**
 * What an empty commit list is allowed to claim.
 *
 * A push caller's `emptyNote` is the categorical "the destination already has
 * everything" claim, and that is only true when the range settled against a
 * destination git could name:
 *
 * - With no destination, the line above already says the push will be refused,
 *   so an in-sync note would contradict it — nothing was compared at all.
 * - With an `unverified` range, empty means "nothing found locally", never "the
 *   destination is up to date" (see {@link GitPushRangeFacts.rangeBasis}). The
 *   human dialog guards this with its `git-push-empty-unverified` state; the
 *   MCP surface says the same thing here so the two approvers read one story.
 *
 * A pull-rebase is subject to the same rule for the same reason. Its range is
 * measured against the upstream's remote-tracking ref, so an `unfetched` upstream
 * means "never fetched here, nothing to subtract from" — which is not the same
 * statement as "nothing would be replayed" and must not borrow its note.
 */
function emptyLines(
  preview: GitRemoteOperationPreview,
  emptyNote: string,
  operation: GitRemoteOperationKind
): string[] {
  if (operation !== "push") {
    if (preview.pullSource === null) return [];
    if (preview.rebaseRange?.rangeBasis === "unfetched") {
      return [
        `${MCP_PREVIEW_CAUTION_PREFIX}${formatGitPushDestination(preview.pullSource)} has never been fetched into this worktree, so what would be replayed could not be measured.`,
      ];
    }
    return [emptyNote];
  }
  if (preview.destination === null) return [];
  if (preview.pushRange?.rangeBasis === "unverified") {
    return [
      `Nothing found to publish, but ${preview.destination.remote} couldn't be reached to check ${formatGitPushDestination(preview.destination)} — so this isn't confirmed.`,
    ];
  }
  return [emptyNote];
}

/** Human-facing `remote/branch`. */
export function formatGitPushDestination(destination: GitPushDestination): string {
  return `${destination.remote}/${destination.branch}`;
}
